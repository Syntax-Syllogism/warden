import { writeFile } from 'node:fs/promises';
import type { Connection } from '@salesforce/core';
import { soqlIn } from '../userShared/sfUtils.js';
import type { ResolvedTargetUser } from './types.js';
import type { AssignmentState, GroupMemberRow, PermissionSetAssignmentRow } from './assignmentState.js';

export type UserSnapshotEntry = {
  match: string;
  matchValue: string;
  userId: string;
  IsActive: boolean;
  IsFrozen: boolean;
  permissionSets: string[];
  permissionSetGroups: string[];
  publicGroups: string[];
  queues: string[];
  permissionSetLicenses: string[];
};

export type UserSnapshotFile = {
  snapshotVersion: 1;
  capturedAt: string;
  org?: string;
  users: UserSnapshotEntry[];
};

const unique = (values: Array<string | undefined | null>): string[] =>
  [...new Set(values.filter((value): value is string => Boolean(value)))].sort();

const queryNames = async (
  conn: Connection,
  table: string,
  ids: string[],
  nameField: string,
  whereClause?: string
): Promise<Map<string, string>> => {
  const map = new Map<string, string>();
  const uniqueIds = unique(ids);
  if (uniqueIds.length === 0) return map;
  const where = [`Id IN (${soqlIn(uniqueIds)})`, whereClause].filter(Boolean).join(' AND ');
  const rows = (
    await conn.query<{ Id: string } & Record<string, string>>(`SELECT Id, ${nameField} FROM ${table} WHERE ${where}`)
  ).records;
  for (const row of rows) map.set(row.Id, row[nameField]);
  return map;
};

const collectIds = (
  state: AssignmentState
): {
  permissionSetIds: string[];
  permissionSetGroupIds: string[];
  publicGroupIds: string[];
  queueIds: string[];
  permissionSetLicenseIds: string[];
} => {
  const psaRows = [...state.psaByUserId.values()].flat();
  const groupRows = [...state.groupByUserId.values()].flat();
  const pslRows = [...state.pslByUserId.values()].flat();
  return {
    permissionSetIds: unique(
      psaRows
        .filter((row) => row.PermissionSetGroupId == null && row.PermissionSet?.IsOwnedByProfile !== true)
        .map((row) => row.PermissionSetId)
    ),
    permissionSetGroupIds: unique(psaRows.map((row) => row.PermissionSetGroupId)),
    publicGroupIds: unique(groupRows.filter((row) => row.Group?.Type === 'Regular').map((row) => row.GroupId)),
    queueIds: unique(groupRows.filter((row) => row.Group?.Type === 'Queue').map((row) => row.GroupId)),
    permissionSetLicenseIds: unique(pslRows.map((row) => row.PermissionSetLicenseId)),
  };
};

const mapPsaNames = (
  rows: PermissionSetAssignmentRow[],
  idToName: Map<string, string>,
  getId: (row: PermissionSetAssignmentRow) => string | undefined | null
): string[] => unique(rows.map((row) => idToName.get(String(getId(row) ?? ''))));

const mapGroupNames = (rows: GroupMemberRow[], idToName: Map<string, string>): string[] =>
  unique(rows.map((row) => idToName.get(row.GroupId)));

export const buildSnapshotFile = async (
  conn: Connection,
  targets: ResolvedTargetUser[],
  state: AssignmentState,
  org?: string
): Promise<UserSnapshotFile> => {
  const ids = collectIds(state);
  const [permissionSetNames, permissionSetGroupNames, publicGroupNames, queueNames, permissionSetLicenseNames] =
    await Promise.all([
      queryNames(conn, 'PermissionSet', ids.permissionSetIds, 'Name'),
      queryNames(conn, 'PermissionSetGroup', ids.permissionSetGroupIds, 'DeveloperName'),
      queryNames(conn, 'Group', ids.publicGroupIds, 'DeveloperName', "Type = 'Regular'"),
      queryNames(conn, 'Group', ids.queueIds, 'DeveloperName', "Type = 'Queue'"),
      queryNames(conn, 'PermissionSetLicense', ids.permissionSetLicenseIds, 'DeveloperName'),
    ]);

  return {
    snapshotVersion: 1,
    capturedAt: new Date().toISOString(),
    org,
    users: targets.map((target) => {
      const psaRows = state.psaByUserId.get(target.Id) ?? [];
      const groupRows = state.groupByUserId.get(target.Id) ?? [];
      const pslRows = state.pslByUserId.get(target.Id) ?? [];
      return {
        match: target.field,
        matchValue: target.value,
        userId: target.Id,
        IsActive: target.IsActive,
        IsFrozen: state.userLoginByUserId.get(target.Id)?.[0]?.IsFrozen ?? false,
        permissionSets: mapPsaNames(
          psaRows.filter((row) => row.PermissionSetGroupId == null && row.PermissionSet?.IsOwnedByProfile !== true),
          permissionSetNames,
          (row) => row.PermissionSetId
        ),
        permissionSetGroups: mapPsaNames(
          psaRows.filter((row) => row.PermissionSetGroupId != null),
          permissionSetGroupNames,
          (row) => row.PermissionSetGroupId
        ),
        publicGroups: mapGroupNames(
          groupRows.filter((row) => row.Group?.Type === 'Regular'),
          publicGroupNames
        ),
        queues: mapGroupNames(
          groupRows.filter((row) => row.Group?.Type === 'Queue'),
          queueNames
        ),
        permissionSetLicenses: unique(pslRows.map((row) => permissionSetLicenseNames.get(row.PermissionSetLicenseId))),
      };
    }),
  };
};

export const writeSnapshotFile = async (path: string, snapshot: UserSnapshotFile): Promise<void> => {
  await writeFile(path, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
};

export const assertSnapshotFile = (value: unknown): UserSnapshotFile => {
  if (!value || typeof value !== 'object' || (value as { snapshotVersion?: unknown }).snapshotVersion !== 1) {
    throw new Error('Snapshot file must have snapshotVersion 1.');
  }
  const users = (value as { users?: unknown }).users;
  if (!Array.isArray(users)) throw new Error('Snapshot file must contain a users array.');
  for (const [index, user] of users.entries()) {
    if (!user || typeof user !== 'object') throw new Error(`Snapshot user ${index + 1} must be an object.`);
    const row = user as Record<string, unknown>;
    for (const field of ['match', 'matchValue', 'userId']) {
      const fieldValue = row[field];
      if (typeof fieldValue !== 'string' || fieldValue.length === 0) {
        throw new Error(`Snapshot user ${index + 1} must include ${field}.`);
      }
    }
    for (const field of ['permissionSets', 'permissionSetGroups', 'publicGroups', 'queues', 'permissionSetLicenses']) {
      const fieldValue = row[field];
      if (!Array.isArray(fieldValue) || fieldValue.some((entry) => typeof entry !== 'string')) {
        throw new Error(`Snapshot user ${index + 1} must include ${field} as a string array.`);
      }
    }
    if (typeof row.IsActive !== 'boolean') throw new Error(`Snapshot user ${index + 1} must include IsActive.`);
    if (typeof row.IsFrozen !== 'boolean') throw new Error(`Snapshot user ${index + 1} must include IsFrozen.`);
  }
  return value as UserSnapshotFile;
};
