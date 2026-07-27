import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
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

type NamedReference = { id: string | undefined | null; name: string | undefined | null };

const resolveMissingNames = async (
  conn: Connection,
  table: string,
  references: NamedReference[],
  nameField: string
): Promise<Map<string, string>> => {
  const names = new Map<string, string>();
  for (const reference of references) {
    if (reference.id && reference.name) names.set(reference.id, reference.name);
  }
  const missingIds = unique(
    references.filter((reference) => reference.id && !reference.name).map((reference) => reference.id)
  );
  if (missingIds.length === 0) return names;
  const rows = (
    await conn.query<{ Id: string } & Record<string, string | undefined>>(
      `SELECT Id, ${nameField} FROM ${table} WHERE Id IN (${soqlIn(missingIds)})`
    )
  ).records;
  for (const row of rows) {
    const name = row[nameField];
    if (name) names.set(row.Id, name);
  }
  return names;
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
  const psaRows = [...state.psaByUserId.values()].flat();
  const groupRows = [...state.groupByUserId.values()].flat();
  const pslRows = [...state.pslByUserId.values()].flat();
  const permissionSetNames = await resolveMissingNames(
    conn,
    'PermissionSet',
    psaRows
      .filter((row) => row.PermissionSetGroupId == null && row.PermissionSet?.IsOwnedByProfile !== true)
      .map((row) => ({ id: row.PermissionSetId, name: row.PermissionSet?.Name })),
    'Name'
  );
  const permissionSetGroupNames = await resolveMissingNames(
    conn,
    'PermissionSetGroup',
    psaRows
      .filter((row) => row.PermissionSetGroupId != null)
      .map((row) => ({ id: row.PermissionSetGroupId, name: row.PermissionSetGroup?.DeveloperName })),
    'DeveloperName'
  );
  const groupNames = await resolveMissingNames(
    conn,
    'Group',
    groupRows.map((row) => ({ id: row.GroupId, name: row.Group?.DeveloperName })),
    'DeveloperName'
  );
  const permissionSetLicenseNames = await resolveMissingNames(
    conn,
    'PermissionSetLicense',
    pslRows.map((row) => ({ id: row.PermissionSetLicenseId, name: row.PermissionSetLicense?.DeveloperName })),
    'DeveloperName'
  );

  return {
    snapshotVersion: 1,
    capturedAt: new Date().toISOString(),
    org,
    users: targets.map((target) => {
      const targetPsaRows = state.psaByUserId.get(target.Id) ?? [];
      const targetGroupRows = state.groupByUserId.get(target.Id) ?? [];
      const targetPslRows = state.pslByUserId.get(target.Id) ?? [];
      return {
        match: target.field,
        matchValue: target.value,
        userId: target.Id,
        IsActive: target.IsActive,
        IsFrozen: state.userLoginByUserId.get(target.Id)?.[0]?.IsFrozen ?? false,
        permissionSets: mapPsaNames(
          targetPsaRows.filter(
            (row) => row.PermissionSetGroupId == null && row.PermissionSet?.IsOwnedByProfile !== true
          ),
          permissionSetNames,
          (row) => row.PermissionSetId
        ),
        permissionSetGroups: mapPsaNames(
          targetPsaRows.filter((row) => row.PermissionSetGroupId != null),
          permissionSetGroupNames,
          (row) => row.PermissionSetGroupId
        ),
        publicGroups: mapGroupNames(
          targetGroupRows.filter((row) => row.Group?.Type === 'Regular'),
          groupNames
        ),
        queues: mapGroupNames(
          targetGroupRows.filter((row) => row.Group?.Type === 'Queue'),
          groupNames
        ),
        permissionSetLicenses: unique(
          targetPslRows.map((row) => permissionSetLicenseNames.get(row.PermissionSetLicenseId))
        ),
      };
    }),
  };
};

export const writeSnapshotFile = async (path: string, snapshot: UserSnapshotFile): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
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
