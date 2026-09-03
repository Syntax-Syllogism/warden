import type { Connection } from '@salesforce/core';
import { resolveAssignees, resultFor, type PermissionSetParent } from '../assignees.js';
import {
  mutingPermissionSetMetadataNamesById,
  partialMetadataWarning,
  profileMetadataNamesById,
  readMetadataInBatches,
  recordTypeVisibilities,
  type MetadataType,
  type RecordTypeVisibility,
} from '../metadata.js';
import { queryAll, queryAllInChunks, soqlIn } from '../soql.js';
import { recordTypeCsvColumns } from '../output.js';
import { validateRecordTypeTarget } from '../targetValidation.js';
import type { AccessTargetResolver, RecordTypeAccess, UserAccessResult, ValidatedAccessTarget } from '../types.js';
import { UserAccessError } from '../types.js';

type ActiveUserProfileRow = { ProfileId?: string };
type ProfileRow = { Id: string; Name: string };
type PermissionSetRow = PermissionSetParent & { Id: string; Name?: string };
type PermissionSetAssignmentRow = {
  PermissionSetId?: string;
  PermissionSet?: Pick<PermissionSetParent, 'Type' | 'IsOwnedByProfile'>;
  PermissionSetGroupId?: string;
};
type PermissionSetGroupComponentRow = {
  PermissionSetGroupId: string;
  PermissionSetId: string;
  PermissionSet?: Pick<PermissionSetParent, 'Name' | 'DeveloperName' | 'Type'>;
};

type CandidateSources = {
  permissionSetById: Map<string, PermissionSetParent>;
  metadataNameByPermissionSetId: Map<string, { type: 'Profile' | 'PermissionSet'; fullName: string }>;
  mutingMetadataNameByPsgId: Map<string, string>;
};

const metadataFailure = (type: MetadataType, name: string, cause: unknown): UserAccessError =>
  new UserAccessError('errorRecordTypeMetadataReadFailed', [type, name], cause);

const findVisibility = (
  metadata: { fullName: string } & Record<string, unknown>,
  type: MetadataType,
  targetName: string
): RecordTypeVisibility | undefined => {
  const matches = recordTypeVisibilities(metadata, type).filter((entry) => entry.recordType === targetName);
  if (matches.length > 1) {
    throw metadataFailure(type, metadata.fullName, new Error(`Duplicate visibility for ${targetName}.`));
  }
  return matches[0];
};

// eslint-disable-next-line complexity
const discoverCandidateSources = async (conn: Connection): Promise<CandidateSources> => {
  const activeUsers = await queryAll<ActiveUserProfileRow>(conn, 'SELECT ProfileId FROM User WHERE IsActive = true');
  const profileIds = [...new Set(activeUsers.map((user) => user.ProfileId).filter((id): id is string => Boolean(id)))];
  const profileMetadataNames = await profileMetadataNamesById(conn);
  const mutingMetadataNames = await mutingPermissionSetMetadataNamesById(conn);
  const profiles = await queryAllInChunks<ProfileRow>(
    conn,
    profileIds,
    (chunk) => `SELECT Id, Name FROM Profile WHERE Id IN (${soqlIn(chunk)})`
  );
  const profilesById = new Map(profiles.map((profile) => [profile.Id, profile]));
  const profilePermissionSets = await queryAllInChunks<PermissionSetRow>(conn, profileIds, (chunk) =>
    [
      'SELECT Id, Name, Label, Type, IsOwnedByProfile, ProfileId, Profile.Name',
      'FROM PermissionSet',
      'WHERE IsOwnedByProfile = true',
      `AND ProfileId IN (${soqlIn(chunk)})`,
    ].join(' ')
  );

  const assignments = await queryAll<PermissionSetAssignmentRow>(
    conn,
    [
      'SELECT PermissionSetId, PermissionSet.Type, PermissionSet.IsOwnedByProfile, PermissionSetGroupId',
      'FROM PermissionSetAssignment',
      'WHERE Assignee.IsActive = true',
    ].join(' ')
  );
  const permissionSetIds = new Set<string>();
  const mutingMetadataNameByPsgId = new Map<string, string>();
  const psgIds = [
    ...new Set(
      assignments.flatMap((assignment) => (assignment.PermissionSetGroupId ? [assignment.PermissionSetGroupId] : []))
    ),
  ];
  for (const assignment of assignments) {
    if (
      assignment.PermissionSetId &&
      assignment.PermissionSet?.Type === 'Regular' &&
      assignment.PermissionSet?.IsOwnedByProfile !== true
    ) {
      permissionSetIds.add(assignment.PermissionSetId);
    }
  }
  const components = await queryAllInChunks<PermissionSetGroupComponentRow>(conn, psgIds, (chunk) =>
    [
      'SELECT PermissionSetGroupId, PermissionSetId, PermissionSet.Name, PermissionSet.Type',
      'FROM PermissionSetGroupComponent',
      `WHERE PermissionSetGroupId IN (${soqlIn(chunk)})`,
    ].join(' ')
  );
  for (const component of components) {
    // Muting permission sets are a separate object: their component rows carry a
    // null PermissionSet relationship and their Ids are not returned by a
    // PermissionSet SOQL query, so resolve them through the metadata listing and
    // never treat them as regular permission sets.
    const mutingName =
      mutingMetadataNames.get(component.PermissionSetId.substring(0, 15)) ??
      (component.PermissionSet?.Type === 'Muting' ? component.PermissionSet?.Name ?? undefined : undefined);
    if (mutingName) {
      mutingMetadataNameByPsgId.set(component.PermissionSetGroupId, mutingName);
      continue;
    }
    if (component.PermissionSet?.Type !== 'Group') permissionSetIds.add(component.PermissionSetId);
  }

  const permissionSetById = new Map<string, PermissionSetParent>();
  const metadataNameByPermissionSetId = new Map<string, { type: 'Profile' | 'PermissionSet'; fullName: string }>();
  const profilePermissionSetByProfileId = new Map<string, PermissionSetRow>();
  for (const permissionSet of profilePermissionSets) {
    if (permissionSet.ProfileId) profilePermissionSetByProfileId.set(permissionSet.ProfileId, permissionSet);
  }
  for (const profileId of profileIds) {
    const profile = profilesById.get(profileId);
    const profilePermissionSet = profilePermissionSetByProfileId.get(profileId);
    const metadataName = profileMetadataNames.get(profileId.substring(0, 15));
    // Profiles the Metadata API does not expose (Automated Process and other
    // system profiles) are not auditable for record-type visibility. Their
    // record Ids are absent from the metadata listing and from the SOQL Profile
    // query, so skip them rather than failing the whole audit.
    if (!profile || !profilePermissionSet || !metadataName) continue;
    permissionSetById.set(profilePermissionSet.Id, {
      ...profilePermissionSet,
      Id: profilePermissionSet.Id,
      IsOwnedByProfile: true,
      ProfileId: profileId,
      Profile: { Name: profile.Name },
    });
    metadataNameByPermissionSetId.set(profilePermissionSet.Id, { type: 'Profile', fullName: metadataName });
  }

  if (permissionSetIds.size > 0) {
    const regularPermissionSets = await queryAllInChunks<PermissionSetRow>(conn, [...permissionSetIds], (chunk) =>
      [
        'SELECT Id, Name, Label, Type, IsOwnedByProfile, ProfileId, Profile.Name',
        'FROM PermissionSet',
        `WHERE Id IN (${soqlIn(chunk)})`,
      ].join(' ')
    );
    const regularById = new Map(regularPermissionSets.map((permissionSet) => [permissionSet.Id, permissionSet]));
    const missingIds = [...permissionSetIds].filter((id) => !regularById.has(id));
    if (missingIds.length > 0) {
      throw metadataFailure(
        'PermissionSet',
        missingIds.join(', '),
        new Error('Permission Set source discovery was incomplete.')
      );
    }
    for (const permissionSet of regularPermissionSets) {
      if (permissionSet.Type === 'Group' || permissionSet.IsOwnedByProfile === true) continue;
      const fullName = permissionSet.Name ?? permissionSet.DeveloperName;
      if (!fullName)
        throw metadataFailure('PermissionSet', permissionSet.Id, new Error('Permission Set has no metadata name.'));
      permissionSetById.set(permissionSet.Id, permissionSet);
      metadataNameByPermissionSetId.set(permissionSet.Id, { type: 'PermissionSet', fullName });
    }
  }
  return { permissionSetById, metadataNameByPermissionSetId, mutingMetadataNameByPsgId };
};

const grantFor = (entry: RecordTypeVisibility, type: 'Profile' | 'PermissionSet'): RecordTypeAccess => {
  if (type === 'Profile' && typeof entry.default !== 'boolean') {
    throw metadataFailure(type, entry.recordType, new Error('Profile record type visibility has no default value.'));
  }
  return {
    kind: 'record-type',
    visible: true,
    default: type === 'Profile' ? entry.default === true : null,
  };
};

export const recordTypeResolver: AccessTargetResolver = {
  type: 'record-type',
  validateTarget: validateRecordTypeTarget,
  async resolve(conn: Connection, target: ValidatedAccessTarget): Promise<UserAccessResult> {
    if (!target.sobjectType) {
      throw new UserAccessError('errorInvalidTarget', [target.targetName]);
    }
    try {
      const sources = await discoverCandidateSources(conn);
      const metadataNamesByType = new Map<'Profile' | 'PermissionSet', string[]>();
      for (const source of sources.metadataNameByPermissionSetId.values()) {
        const names = metadataNamesByType.get(source.type) ?? [];
        names.push(source.fullName);
        metadataNamesByType.set(source.type, names);
      }
      const { metadata: profileMetadata, missing: missingProfileNames } = await readMetadataInBatches<
        Record<string, unknown> & { fullName: string }
      >(conn, 'Profile', [...new Set(metadataNamesByType.get('Profile') ?? [])]);
      const { metadata: permissionSetMetadata, missing: missingPermissionSetNames } = await readMetadataInBatches<
        Record<string, unknown> & { fullName: string }
      >(conn, 'PermissionSet', [...new Set(metadataNamesByType.get('PermissionSet') ?? [])]);
      const mutingNames = [...new Set(sources.mutingMetadataNameByPsgId.values())];
      const { metadata: mutingMetadata, missing: missingMutingNames } = await readMetadataInBatches<
        Record<string, unknown> & { fullName: string }
      >(conn, 'MutingPermissionSet', mutingNames);
      const mutedPsgIds = new Set<string>();
      for (const [psgId, fullName] of sources.mutingMetadataNameByPsgId) {
        const metadata = mutingMetadata.get(fullName);
        // Muting metadata the running user cannot read is reported as a partial
        // result below rather than aborting; leaving the PSG unmuted may
        // over-report access, which the warning calls out.
        if (!metadata) continue;
        const entry = findVisibility(metadata, 'MutingPermissionSet', target.targetName);
        if (entry?.visible === true) mutedPsgIds.add(psgId);
      }
      const grantByPermissionSetId = new Map<string, RecordTypeAccess>();
      for (const [permissionSetId, source] of sources.metadataNameByPermissionSetId) {
        const metadata = (source.type === 'Profile' ? profileMetadata : permissionSetMetadata).get(source.fullName);
        // Sources the running user cannot read are omitted from the audit and
        // reported as a partial result below rather than aborting.
        if (!metadata) continue;
        const entry = findVisibility(metadata, source.type, target.targetName);
        if (entry?.visible === true) grantByPermissionSetId.set(permissionSetId, grantFor(entry, source.type));
      }
      const rows = await resolveAssignees(
        conn,
        'record-type',
        target.targetName,
        grantByPermissionSetId,
        sources.permissionSetById,
        (grant, context) => (context.psgId && mutedPsgIds.has(context.psgId) ? undefined : grant)
      );
      const warnings: string[] = [];
      const missingNames = [...missingProfileNames, ...missingPermissionSetNames, ...missingMutingNames];
      if (missingNames.length > 0) warnings.push(partialMetadataWarning(missingNames));
      return resultFor('record-type', target.targetName, rows, warnings, { sobjectType: target.sobjectType });
    } catch (error) {
      if (error instanceof UserAccessError) throw error;
      throw new UserAccessError('errorAccessQueryFailed', [target.type, target.targetName], error);
    }
  },
  csvColumns: recordTypeCsvColumns,
};
