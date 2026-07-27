import type { Connection } from '@salesforce/core';
import { combinePsgMuting, loadPsgMuting, type PsgMutingState } from './muting.js';
import { fieldCsvColumns, enabledCsvColumns, objectCsvColumns, tabCsvColumns } from './output.js';
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

const collectGrantContext = async (conn: Connection, userId: string): Promise<GrantContext> => {
  const assignments = await queryAll<PermissionSetAssignmentRow>(
    conn,
    [
      'SELECT PermissionSetId, PermissionSet.Name, PermissionSet.DeveloperName, PermissionSet.Label, PermissionSet.IsOwnedByProfile, PermissionSet.ProfileId, PermissionSet.Profile.Name, PermissionSet.Type, PermissionSetGroupId, PermissionSetGroup.DeveloperName, PermissionSetGroup.MasterLabel',
      'FROM PermissionSetAssignment',
      `WHERE AssigneeId = '${userId}'`,
    ].join(' ')
  );
  const sourcesByPermissionSetId = new Map<string, GrantSource[]>();
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
  }

  const components = await queryAllInChunks<PermissionSetGroupComponentRow>(conn, psgIds, (chunk) =>
    [
      'SELECT PermissionSetGroupId, PermissionSetId, PermissionSet.Name, PermissionSet.DeveloperName, PermissionSet.Label, PermissionSet.Type',
      'FROM PermissionSetGroupComponent',
      `WHERE PermissionSetGroupId IN (${soqlIn(chunk)})`,
    ].join(' ')
  );
  const componentPermissionSetIds: string[] = [];
  for (const component of components) {
    if (component.PermissionSet?.Type === 'Muting') continue;
    componentPermissionSetIds.push(component.PermissionSetId);
    const psgName = psgNames.get(component.PermissionSetGroupId) ?? component.PermissionSetGroupId;
    addSource(sourcesByPermissionSetId, component.PermissionSetId, {
      assignmentType: 'PermissionSetGroup',
      sourceId: component.PermissionSetGroupId,
      sourceName: psgName,
      sourceApiName: psgName,
      sourceLabel: psgName,
      viaPermissionSetId: component.PermissionSetId,
      viaPermissionSetName: component.PermissionSet?.Name ?? component.PermissionSetId,
      psgId: component.PermissionSetGroupId,
    });
  }
  return {
    permissionSetIds: [...new Set([...directPermissionSetIds, ...componentPermissionSetIds])],
    psgIds,
    sourcesByPermissionSetId,
  };
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
  const context = await collectGrantContext(conn, user.Id);
  if (context.permissionSetIds.length === 0) {
    return resultFor(target.type, target.targetName, [], [], {
      sobjectType: target.sobjectType,
      fieldApiName: target.fieldApiName,
    });
  }

  const rows: UserAccessRow[] = [];
  if (target.type === 'field') {
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
  return resultFor(
    target.type,
    target.targetName,
    rows,
    target.type === 'tab'
      ? [
          'Profile-level tab visibility is not included because it is not exposed as a clean PermissionSetTabSetting data-API grant.',
        ]
      : [],
    {
      sobjectType: target.sobjectType,
      fieldApiName: target.fieldApiName,
    }
  );
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
  return enabledCsvColumns();
};
