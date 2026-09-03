import type { Connection } from '@salesforce/core';
import {
  mutingPermissionSetMetadataNamesById,
  partialMetadataWarning,
  profileMetadataNamesById,
  readMetadataInBatches,
  recordTypeVisibilities,
  type MetadataType,
  type RecordTypeVisibility,
} from './metadata.js';
import { combinePsgMuting, loadPsgMuting, type PsgMutingState } from './muting.js';
import { fieldCsvColumns, enabledCsvColumns, objectCsvColumns, recordTypeCsvColumns, tabCsvColumns } from './output.js';
import { queryAll, queryAllInChunks, soqlIn } from './soql.js';
import { resultFor, type PermissionSetParent } from './assignees.js';
import type {
  AccessTargetType,
  FieldAccess,
  ObjectAccess,
  UserAccessResult,
  UserAccessRow,
  ValidatedAccessTarget,
} from './types.js';
import { UserAccessError } from './types.js';

export type ReverseAccessUser = { Id: string; name: string; username: string };

type PermissionSetAssignmentRow = {
  PermissionSetId?: string;
  PermissionSet?: PermissionSetParent;
  PermissionSetGroupId?: string;
  PermissionSetGroup?: { DeveloperName?: string; MasterLabel?: string };
};

type PermissionSetGroupComponentRow = {
  PermissionSetGroupId: string;
  PermissionSetId: string;
  PermissionSet?: PermissionSetParent & { Type?: string };
};

type GrantSource = {
  assignmentType: 'Profile' | 'PermissionSet' | 'PermissionSetGroup';
  sourceId: string;
  sourceName: string;
  sourceApiName?: string;
  sourceLabel?: string;
  viaPermissionSetId?: string;
  viaPermissionSetName?: string;
  psgId?: string;
};

type GrantContext = {
  permissionSetIds: string[];
  psgIds: string[];
  sourcesByPermissionSetId: Map<string, GrantSource[]>;
  metadataNameByPermissionSetId: Map<string, { type: 'Profile' | 'PermissionSet'; fullName: string }>;
  mutingMetadataNameByPsgId: Map<string, string>;
};

type FieldPermissionRow = {
  ParentId: string;
  SobjectType?: string;
  Field?: string;
  PermissionsRead?: boolean;
  PermissionsEdit?: boolean;
};
type FieldMutingMask = Map<string, Pick<FieldAccess, 'read' | 'edit'>>;

type ObjectPermissionRow = {
  ParentId: string;
  SobjectType?: string;
  PermissionsRead?: boolean;
  PermissionsCreate?: boolean;
  PermissionsEdit?: boolean;
  PermissionsDelete?: boolean;
  PermissionsViewAllRecords?: boolean;
  PermissionsModifyAllRecords?: boolean;
};

type SetupEntityAccessRow = { ParentId: string };
type TabPermissionRow = { ParentId: string; Name?: string; Visibility?: string };
type MetadataRecord = { fullName: string } & Record<string, unknown>;

const truthy = (value: boolean | undefined): boolean => value === true;
const anyFieldAccess = (access: FieldAccess): boolean => access.read || access.edit;
const anyObjectAccess = (access: ObjectAccess): boolean =>
  access.read || access.create || access.edit || access.delete || access.viewAll || access.modifyAll;

const toFieldAccess = (row: FieldPermissionRow): FieldAccess => ({
  kind: 'field',
  read: truthy(row.PermissionsRead),
  edit: truthy(row.PermissionsEdit),
});

const toObjectAccess = (row: ObjectPermissionRow): ObjectAccess => ({
  kind: 'object',
  read: truthy(row.PermissionsRead),
  create: truthy(row.PermissionsCreate),
  edit: truthy(row.PermissionsEdit),
  delete: truthy(row.PermissionsDelete),
  viewAll: truthy(row.PermissionsViewAllRecords),
  modifyAll: truthy(row.PermissionsModifyAllRecords),
});

const addSource = (map: Map<string, GrantSource[]>, permissionSetId: string, source: GrantSource): void => {
  const sources = map.get(permissionSetId) ?? [];
  const key = [source.assignmentType, source.sourceId, source.viaPermissionSetId ?? ''].join('|');
  if (
    !sources.some((entry) => [entry.assignmentType, entry.sourceId, entry.viaPermissionSetId ?? ''].join('|') === key)
  ) {
    sources.push(source);
  }
  map.set(permissionSetId, sources);
};

const permissionSetSource = (id: string, parent: PermissionSetParent | undefined): GrantSource => {
  const isProfile = parent?.IsOwnedByProfile === true;
  return {
    assignmentType: isProfile ? 'Profile' : 'PermissionSet',
    sourceId: isProfile ? parent?.ProfileId ?? id : id,
    sourceName: isProfile ? parent?.Profile?.Name ?? parent?.Name ?? id : parent?.Name ?? id,
    sourceApiName: parent?.DeveloperName ?? parent?.Name ?? id,
    sourceLabel: parent?.Profile?.Name ?? parent?.Label ?? parent?.Name ?? id,
  };
};

// eslint-disable-next-line complexity
const collectGrantContext = async (
  conn: Connection,
  userId: string,
  profileMetadataNames: Map<string, string>,
  mutingMetadataNames: Map<string, string>
): Promise<GrantContext> => {
  const assignments = await queryAll<PermissionSetAssignmentRow>(
    conn,
    [
      'SELECT PermissionSetId, PermissionSet.Name, PermissionSet.Label, PermissionSet.IsOwnedByProfile, PermissionSet.ProfileId, PermissionSet.Profile.Name, PermissionSet.Type, PermissionSetGroupId, PermissionSetGroup.DeveloperName, PermissionSetGroup.MasterLabel',
      'FROM PermissionSetAssignment',
      `WHERE AssigneeId = '${userId}'`,
    ].join(' ')
  );
  const sourcesByPermissionSetId = new Map<string, GrantSource[]>();
  const metadataNameByPermissionSetId = new Map<string, { type: 'Profile' | 'PermissionSet'; fullName: string }>();
  const mutingMetadataNameByPsgId = new Map<string, string>();
  const psgIds = [
    ...new Set(
      assignments.flatMap((assignment) => (assignment.PermissionSetGroupId ? [assignment.PermissionSetGroupId] : []))
    ),
  ];
  const psgNames = new Map(
    assignments
      .filter((assignment) => assignment.PermissionSetGroupId)
      .map((assignment) => [
        assignment.PermissionSetGroupId as string,
        assignment.PermissionSetGroup?.MasterLabel ??
          assignment.PermissionSetGroup?.DeveloperName ??
          (assignment.PermissionSetGroupId as string),
      ])
  );
  const directPermissionSetIds: string[] = [];
  for (const assignment of assignments) {
    if (
      !assignment.PermissionSetId ||
      assignment.PermissionSet?.Type === 'Muting' ||
      assignment.PermissionSet?.Type === 'Group'
    )
      continue;
    directPermissionSetIds.push(assignment.PermissionSetId);
    addSource(
      sourcesByPermissionSetId,
      assignment.PermissionSetId,
      permissionSetSource(assignment.PermissionSetId, assignment.PermissionSet)
    );
    const fullName = assignment.PermissionSet?.Name ?? assignment.PermissionSet?.DeveloperName;
    if (
      fullName &&
      (assignment.PermissionSet?.Type === 'Regular' || assignment.PermissionSet?.IsOwnedByProfile === true)
    ) {
      const isProfile = assignment.PermissionSet?.IsOwnedByProfile === true;
      // Standard profiles read through a Metadata API fullName that differs from
      // their SOQL Name (for example "Contract Manager" is "ContractManager"),
      // so translate the profile's record Id through the metadata listing.
      const profileMetadataName = assignment.PermissionSet?.ProfileId
        ? profileMetadataNames.get(assignment.PermissionSet.ProfileId.substring(0, 15))
        : undefined;
      metadataNameByPermissionSetId.set(assignment.PermissionSetId, {
        type: isProfile ? 'Profile' : 'PermissionSet',
        fullName: isProfile ? profileMetadataName ?? assignment.PermissionSet?.Profile?.Name ?? fullName : fullName,
      });
    }
  }

  const components = await queryAllInChunks<PermissionSetGroupComponentRow>(conn, psgIds, (chunk) =>
    [
      'SELECT PermissionSetGroupId, PermissionSetId, PermissionSet.Name, PermissionSet.Label, PermissionSet.Type',
      'FROM PermissionSetGroupComponent',
      `WHERE PermissionSetGroupId IN (${soqlIn(chunk)})`,
    ].join(' ')
  );
  const componentPermissionSetIds: string[] = [];
  const componentPermissionSetsById = new Map<string, PermissionSetParent>();
  const unresolvedComponentIds = [
    ...new Set(
      components
        .filter(
          (component) => !component.PermissionSet?.Type && !mutingMetadataNames.has(component.PermissionSetId.substring(0, 15))
        )
        .map((component) => component.PermissionSetId)
    ),
  ];
  if (unresolvedComponentIds.length > 0) {
    const resolvedComponents = await queryAllInChunks<PermissionSetParent>(conn, unresolvedComponentIds, (chunk) =>
      [
        'SELECT Id, Name, Label, Type, IsOwnedByProfile, ProfileId, Profile.Name',
        'FROM PermissionSet',
        `WHERE Id IN (${soqlIn(chunk)})`,
      ].join(' ')
    );
    for (const permissionSet of resolvedComponents) componentPermissionSetsById.set(permissionSet.Id, permissionSet);
  }
  for (const component of components) {
    // Muting permission sets are a separate object with a null PermissionSet
    // relationship and Ids absent from PermissionSet SOQL; resolve them through
    // the metadata listing.
    const mutingName =
      mutingMetadataNames.get(component.PermissionSetId.substring(0, 15)) ??
      (component.PermissionSet?.Type === 'Muting' ? component.PermissionSet?.Name ?? undefined : undefined);
    if (mutingName) {
      mutingMetadataNameByPsgId.set(component.PermissionSetGroupId, mutingName);
      continue;
    }
    const permissionSet = component.PermissionSet ?? componentPermissionSetsById.get(component.PermissionSetId);
    if (permissionSet?.Type !== 'Regular' && permissionSet?.IsOwnedByProfile !== true) continue;
    componentPermissionSetIds.push(component.PermissionSetId);
    const psgName = psgNames.get(component.PermissionSetGroupId) ?? component.PermissionSetGroupId;
    addSource(sourcesByPermissionSetId, component.PermissionSetId, {
      assignmentType: 'PermissionSetGroup',
      sourceId: component.PermissionSetGroupId,
      sourceName: psgName,
      sourceApiName: psgName,
      sourceLabel: psgName,
      viaPermissionSetId: component.PermissionSetId,
      viaPermissionSetName: permissionSet?.Name ?? component.PermissionSetId,
      psgId: component.PermissionSetGroupId,
    });
    const fullName = permissionSet?.Name ?? permissionSet?.DeveloperName;
    if (fullName) metadataNameByPermissionSetId.set(component.PermissionSetId, { type: 'PermissionSet', fullName });
  }
  return {
    permissionSetIds: [...new Set([...directPermissionSetIds, ...componentPermissionSetIds])],
    psgIds,
    sourcesByPermissionSetId,
    metadataNameByPermissionSetId,
    mutingMetadataNameByPsgId,
  };
};

const recordTypeMetadataFailure = (type: MetadataType, name: string, cause: unknown): UserAccessError =>
  new UserAccessError('errorRecordTypeMetadataReadFailed', [type, name], cause);

const recordTypeEntry = (
  metadata: MetadataRecord,
  type: MetadataType,
  targetName: string
): RecordTypeVisibility | undefined => {
  const entries = recordTypeVisibilities(metadata, type).filter((entry) => entry.recordType === targetName);
  if (entries.length > 1) {
    throw recordTypeMetadataFailure(type, metadata.fullName, new Error(`Duplicate visibility for ${targetName}.`));
  }
  return entries[0];
};

const fieldMuting = async (
  conn: Connection,
  target: ValidatedAccessTarget,
  psgIds: string[]
): Promise<PsgMutingState<FieldMutingMask>> =>
  loadPsgMuting(conn, psgIds, async (mutingSetIds) => {
    const rows = await queryAllInChunks<FieldPermissionRow>(conn, mutingSetIds, (chunk) =>
      [
        'SELECT ParentId, Field, PermissionsRead, PermissionsEdit',
        'FROM FieldPermissions',
        'WHERE Parent.IsOwnedByProfile = false',
        `AND ParentId IN (${soqlIn(chunk)})`,
        `AND SobjectType = '${target.sobjectType}'`,
        ...(target.fieldApiName ? [`AND Field = '${target.sobjectType}.${target.fieldApiName}'`] : []),
      ].join(' ')
    );
    const masksByPermissionSetId = new Map<string, FieldMutingMask>();
    for (const row of rows) {
      if (!row.Field) continue;
      const masks = masksByPermissionSetId.get(row.ParentId) ?? new Map<string, Pick<FieldAccess, 'read' | 'edit'>>();
      masks.set(row.Field, { read: truthy(row.PermissionsRead), edit: truthy(row.PermissionsEdit) });
      masksByPermissionSetId.set(row.ParentId, masks);
    }
    return masksByPermissionSetId;
  });

const objectMuting = async (
  conn: Connection,
  target: ValidatedAccessTarget,
  psgIds: string[]
): Promise<PsgMutingState<ObjectAccess>> =>
  loadPsgMuting(conn, psgIds, async (mutingSetIds) => {
    const rows = await queryAllInChunks<ObjectPermissionRow>(conn, mutingSetIds, (chunk) =>
      [
        'SELECT ParentId, PermissionsRead, PermissionsCreate, PermissionsEdit, PermissionsDelete, PermissionsViewAllRecords, PermissionsModifyAllRecords',
        'FROM ObjectPermissions',
        'WHERE Parent.IsOwnedByProfile = false',
        `AND ParentId IN (${soqlIn(chunk)})`,
        `AND SobjectType = '${target.sobjectType}'`,
      ].join(' ')
    );
    return new Map(rows.map((row) => [row.ParentId, toObjectAccess(row)]));
  });

const baseRow = (
  user: ReverseAccessUser,
  targetType: AccessTargetType,
  source: GrantSource
): Pick<
  UserAccessRow,
  | 'userId'
  | 'userName'
  | 'username'
  | 'targetType'
  | 'assignmentType'
  | 'sourceId'
  | 'sourceName'
  | 'sourceApiName'
  | 'sourceLabel'
  | 'viaPermissionSetId'
  | 'viaPermissionSetName'
> => ({
  userId: user.Id,
  userName: user.name,
  username: user.username,
  targetType,
  assignmentType: source.assignmentType,
  sourceId: source.sourceId,
  sourceName: source.sourceName,
  sourceApiName: source.sourceApiName,
  sourceLabel: source.sourceLabel,
  viaPermissionSetId: source.viaPermissionSetId,
  viaPermissionSetName: source.viaPermissionSetName,
});

// eslint-disable-next-line complexity
const resolveReverse = async (
  conn: Connection,
  user: ReverseAccessUser,
  target: ValidatedAccessTarget
): Promise<UserAccessResult> => {
  const profileMetadataNames =
    target.type === 'record-type' ? await profileMetadataNamesById(conn) : new Map<string, string>();
  const mutingMetadataNames =
    target.type === 'record-type' ? await mutingPermissionSetMetadataNamesById(conn) : new Map<string, string>();
  const context = await collectGrantContext(conn, user.Id, profileMetadataNames, mutingMetadataNames);
  if (context.permissionSetIds.length === 0) {
    return resultFor(target.type, target.targetName, [], [], {
      sobjectType: target.sobjectType,
      fieldApiName: target.fieldApiName,
    });
  }

  const rows: UserAccessRow[] = [];
  const warnings: string[] = [];
  if (target.type === 'record-type') {
    const missingNames = context.permissionSetIds.filter((id) => !context.metadataNameByPermissionSetId.has(id));
    if (missingNames.length > 0) {
      throw recordTypeMetadataFailure(
        'PermissionSet',
        missingNames.join(', '),
        new Error('Permission Set metadata names were not discovered.')
      );
    }
    const profileNames = [
      ...new Set(
        [...context.metadataNameByPermissionSetId.values()]
          .filter((source) => source.type === 'Profile')
          .map((source) => source.fullName)
      ),
    ];
    const permissionSetNames = [
      ...new Set(
        [...context.metadataNameByPermissionSetId.values()]
          .filter((source) => source.type === 'PermissionSet')
          .map((source) => source.fullName)
      ),
    ];
    const { metadata: profiles, missing: missingProfileNames } = await readMetadataInBatches<MetadataRecord>(
      conn,
      'Profile',
      profileNames
    );
    const { metadata: permissionSets, missing: missingPermissionSetNames } = await readMetadataInBatches<MetadataRecord>(
      conn,
      'PermissionSet',
      permissionSetNames
    );
    const mutingNames = [...new Set(context.mutingMetadataNameByPsgId.values())];
    const { metadata: mutingPermissionSets, missing: missingMutingNames } = await readMetadataInBatches<MetadataRecord>(
      conn,
      'MutingPermissionSet',
      mutingNames
    );
    const missingMetadataNames = [...missingProfileNames, ...missingPermissionSetNames, ...missingMutingNames];
    if (missingMetadataNames.length > 0) warnings.push(partialMetadataWarning(missingMetadataNames));
    const mutedPsgIds = new Set<string>();
    for (const [psgId, fullName] of context.mutingMetadataNameByPsgId) {
      const metadata = mutingPermissionSets.get(fullName);
      // Metadata the running user cannot read is reported as a partial result
      // (warning above) rather than aborting the audit.
      if (!metadata) continue;
      const entry = recordTypeEntry(metadata, 'MutingPermissionSet', target.targetName);
      if (entry?.visible === true) mutedPsgIds.add(psgId);
    }
    for (const [permissionSetId, source] of context.metadataNameByPermissionSetId) {
      const metadata = (source.type === 'Profile' ? profiles : permissionSets).get(source.fullName);
      if (!metadata) continue;
      const entry = recordTypeEntry(metadata, source.type, target.targetName);
      if (!entry?.visible) continue;
      if (source.type === 'Profile' && typeof entry.default !== 'boolean') {
        throw recordTypeMetadataFailure(
          source.type,
          source.fullName,
          new Error('Profile record type visibility has no default value.')
        );
      }
      const access = {
        kind: 'record-type' as const,
        visible: true,
        default: source.type === 'Profile' ? entry.default === true : null,
      };
      for (const grantSource of context.sourcesByPermissionSetId.get(permissionSetId) ?? []) {
        if (grantSource.psgId && mutedPsgIds.has(grantSource.psgId)) continue;
        rows.push({ ...baseRow(user, 'record-type', grantSource), targetName: target.targetName, access });
      }
    }
  } else if (target.type === 'field') {
    if (!target.sobjectType) throw new UserAccessError('errorInvalidTarget', [target.targetName]);
    const muting = await fieldMuting(conn, target, context.psgIds);
    const grants = await queryAllInChunks<FieldPermissionRow>(conn, context.permissionSetIds, (chunk) =>
      [
        'SELECT ParentId, SobjectType, Field, PermissionsRead, PermissionsEdit',
        'FROM FieldPermissions',
        `WHERE ParentId IN (${soqlIn(chunk)})`,
        `AND SobjectType = '${target.sobjectType}'`,
        ...(target.fieldApiName ? [`AND Field = '${target.sobjectType}.${target.fieldApiName}'`] : []),
        "AND Parent.Type != 'Muting'",
      ].join(' ')
    );
    for (const grant of grants) {
      const rawAccess = toFieldAccess(grant);
      if (!anyFieldAccess(rawAccess)) continue;
      for (const source of context.sourcesByPermissionSetId.get(grant.ParentId) ?? []) {
        const mutedMask = source.psgId
          ? combinePsgMuting(
              source.psgId,
              muting,
              new Map<string, Pick<FieldAccess, 'read' | 'edit'>>(),
              (left, right) => {
                const combined = new Map(left);
                for (const [field, mask] of right) {
                  const previous = combined.get(field) ?? { read: false, edit: false };
                  combined.set(field, { read: previous.read || mask.read, edit: previous.edit || mask.edit });
                }
                return combined;
              }
            ).get(grant.Field ?? '') ?? { read: false, edit: false }
          : { read: false, edit: false };
        const access: FieldAccess = {
          kind: 'field',
          read: rawAccess.read && !mutedMask.read,
          edit: rawAccess.edit && !mutedMask.edit,
        };
        if (!anyFieldAccess(access)) continue;
        rows.push({
          ...baseRow(user, 'field', source),
          targetName: grant.Field ?? `${grant.SobjectType}.${target.fieldApiName ?? ''}`,
          access,
        });
      }
    }
  } else if (target.type === 'object') {
    if (!target.sobjectType) throw new UserAccessError('errorInvalidTarget', [target.targetName]);
    const muting = await objectMuting(conn, target, context.psgIds);
    const grants = await queryAllInChunks<ObjectPermissionRow>(conn, context.permissionSetIds, (chunk) =>
      [
        'SELECT ParentId, SobjectType, PermissionsRead, PermissionsCreate, PermissionsEdit, PermissionsDelete, PermissionsViewAllRecords, PermissionsModifyAllRecords',
        'FROM ObjectPermissions',
        `WHERE ParentId IN (${soqlIn(chunk)})`,
        `AND SobjectType = '${target.sobjectType}'`,
        "AND Parent.Type != 'Muting'",
      ].join(' ')
    );
    for (const grant of grants) {
      const rawAccess = toObjectAccess(grant);
      if (!anyObjectAccess(rawAccess)) continue;
      for (const source of context.sourcesByPermissionSetId.get(grant.ParentId) ?? []) {
        const muted = source.psgId
          ? combinePsgMuting(
              source.psgId,
              muting,
              {
                kind: 'object',
                read: false,
                create: false,
                edit: false,
                delete: false,
                viewAll: false,
                modifyAll: false,
              },
              (left, right) => ({
                kind: 'object',
                read: left.read || right.read,
                create: left.create || right.create,
                edit: left.edit || right.edit,
                delete: left.delete || right.delete,
                viewAll: left.viewAll || right.viewAll,
                modifyAll: left.modifyAll || right.modifyAll,
              })
            )
          : {
              kind: 'object',
              read: false,
              create: false,
              edit: false,
              delete: false,
              viewAll: false,
              modifyAll: false,
            };
        const access: ObjectAccess = {
          kind: 'object',
          read: rawAccess.read && !muted.read,
          create: rawAccess.create && !muted.create,
          edit: rawAccess.edit && !muted.edit,
          delete: rawAccess.delete && !muted.delete,
          viewAll: rawAccess.viewAll && !muted.viewAll,
          modifyAll: rawAccess.modifyAll && !muted.modifyAll,
        };
        if (!anyObjectAccess(access)) continue;
        rows.push({ ...baseRow(user, 'object', source), targetName: grant.SobjectType ?? target.sobjectType, access });
      }
    }
  } else if (target.type === 'apex-class' || target.type === 'vf-page' || target.type === 'custom-permission') {
    const setupEntityType =
      target.type === 'apex-class' ? 'ApexClass' : target.type === 'vf-page' ? 'ApexPage' : 'CustomPermission';
    const grants = await queryAllInChunks<SetupEntityAccessRow>(conn, context.permissionSetIds, (chunk) =>
      [
        'SELECT ParentId',
        'FROM SetupEntityAccess',
        `WHERE ParentId IN (${soqlIn(chunk)})`,
        `AND SetupEntityType = '${setupEntityType}'`,
        `AND SetupEntityId = '${target.setupEntityId}'`,
      ].join(' ')
    );
    for (const grant of grants) {
      for (const source of context.sourcesByPermissionSetId.get(grant.ParentId) ?? []) {
        rows.push({
          ...baseRow(user, target.type, source),
          targetName: target.targetName,
          access: { kind: 'enabled', enabled: true },
        });
      }
    }
  } else {
    const grants = await queryAllInChunks<TabPermissionRow>(conn, context.permissionSetIds, (chunk) =>
      [
        'SELECT ParentId, Name, Visibility',
        'FROM PermissionSetTabSetting',
        `WHERE ParentId IN (${soqlIn(chunk)})`,
        `AND Name = '${target.targetName}'`,
        "AND Visibility != 'Hidden'",
      ].join(' ')
    );
    for (const grant of grants) {
      for (const source of context.sourcesByPermissionSetId.get(grant.ParentId) ?? []) {
        rows.push({
          ...baseRow(user, 'tab', source),
          targetName: target.targetName,
          access: { kind: 'tab', visibility: grant.Visibility ?? '' },
        });
      }
    }
  }
  if (target.type === 'tab') {
    warnings.push(
      'Profile-level tab visibility is not included because it is not exposed as a clean PermissionSetTabSetting data-API grant.'
    );
  }
  return resultFor(target.type, target.targetName, rows, warnings, {
    sobjectType: target.sobjectType,
    fieldApiName: target.fieldApiName,
  });
};

export const resolveReverseAccess = async (
  conn: Connection,
  user: ReverseAccessUser,
  target: ValidatedAccessTarget
): Promise<UserAccessResult> => {
  try {
    return await resolveReverse(conn, user, target);
  } catch (error) {
    if (error instanceof UserAccessError) throw error;
    throw new UserAccessError('errorAccessQueryFailed', [target.type, target.targetName], error);
  }
};

export const reverseCsvColumns = (type: AccessTargetType): string[] => {
  if (type === 'field') return fieldCsvColumns();
  if (type === 'object') return objectCsvColumns();
  if (type === 'tab') return tabCsvColumns();
  if (type === 'record-type') return recordTypeCsvColumns();
  return enabledCsvColumns();
};
