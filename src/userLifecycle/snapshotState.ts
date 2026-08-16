import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Connection } from '@salesforce/core';
import { detectInputFormat, readCsvRows, restoreCsvFormula, serializeCsv } from '../userShared/csv.js';
import { soqlIn } from '../userShared/sfUtils.js';
import type { ResolvedTargetUser } from './types.js';
import type { AssignmentState, GroupMemberRow, PermissionSetAssignmentRow } from './assignmentState.js';

export type UserSnapshotEntry = {
  match: string;
  matchValue: string;
  userId: string;
  name?: string;
  username?: string;
  email?: string;
  profile?: string;
  role?: string;
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
        name: target.name,
        username: target.username,
        email: target.email,
        profile: target.profile,
        role: target.role,
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

export const snapshotCsvColumns = [
  'snapshotVersion',
  'capturedAt',
  'org',
  'match',
  'matchValue',
  'userId',
  'userName',
  'username',
  'email',
  'profile',
  'role',
  'isActive',
  'isFrozen',
  'category',
  'name',
] as const;

const snapshotAssignmentCategories = [
  ['permissionSets', 'permissionSet'],
  ['permissionSetGroups', 'permissionSetGroup'],
  ['publicGroups', 'publicGroup'],
  ['queues', 'queue'],
  ['permissionSetLicenses', 'permissionSetLicense'],
] as const;

type SnapshotAssignmentField = (typeof snapshotAssignmentCategories)[number][0];
const emptySnapshotCategory = 'emptySnapshot';

export const serializeSnapshotCsv = (snapshot: UserSnapshotFile): string => {
  if (snapshot.users.length === 0) {
    return serializeCsv(
      [
        {
          snapshotVersion: snapshot.snapshotVersion,
          capturedAt: encodeSnapshotCsvValue(snapshot.capturedAt),
          org: encodeSnapshotCsvValue(snapshot.org ?? ''),
          match: '',
          matchValue: '',
          userId: '',
          userName: '',
          username: '',
          email: '',
          profile: '',
          role: '',
          isActive: '',
          isFrozen: '',
          category: emptySnapshotCategory,
          name: '',
        },
      ],
      [...snapshotCsvColumns]
    );
  }

  const rows = snapshot.users.flatMap((user) => {
    const assignments = snapshotAssignmentCategories.flatMap(([field, category]) =>
      unique(user[field]).map((name) => ({ category, name }))
    );
    const categories = assignments.length > 0 ? assignments : [{ category: 'none', name: '' }];
    return categories.map(({ category, name }) => ({
      snapshotVersion: snapshot.snapshotVersion,
      capturedAt: encodeSnapshotCsvValue(snapshot.capturedAt),
      org: encodeSnapshotCsvValue(snapshot.org ?? ''),
      match: encodeSnapshotCsvValue(user.match),
      matchValue: encodeSnapshotCsvValue(user.matchValue),
      userId: encodeSnapshotCsvValue(user.userId),
      userName: encodeSnapshotCsvValue(user.name ?? ''),
      username: encodeSnapshotCsvValue(user.username ?? ''),
      email: encodeSnapshotCsvValue(user.email ?? ''),
      profile: encodeSnapshotCsvValue(user.profile ?? ''),
      role: encodeSnapshotCsvValue(user.role ?? ''),
      isActive: user.IsActive,
      isFrozen: user.IsFrozen,
      category: encodeSnapshotCsvValue(category),
      name: encodeSnapshotCsvValue(name),
    }));
  });
  return serializeCsv(rows, [...snapshotCsvColumns]);
};

// A doubled leading apostrophe marks a literal apostrophe; a single one remains
// the shared writer's formula-protection prefix.
const encodeSnapshotCsvValue = (value: string): string => (value.startsWith("'") ? `'${value}` : value);

const snapshotCsvValue = (row: string[], indexes: Map<string, number>, column: string): string => {
  const value = row[indexes.get(column) ?? -1] ?? '';
  return value.startsWith("''") ? value.slice(1) : restoreCsvFormula(value);
};

const parseSnapshotBoolean = (value: string, rowLine: number, field: string): boolean => {
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw new Error(`Snapshot CSV row ${rowLine} must contain ${field} as true or false.`);
};

const optionalSnapshotValue = (value: string): string | undefined => (value.length > 0 ? value : undefined);

// CSV validation combines file metadata, user identity, lifecycle state, and assignment rows by design.
// eslint-disable-next-line complexity
export const deserializeSnapshotCsv = (source: string, path = '<snapshot>'): UserSnapshotFile => {
  const rows = readCsvRows(source, path, ',');
  if (rows.length === 0) throw new Error(`Snapshot CSV ${path} must contain a header and at least one user row.`);
  const header = rows[0];
  if (header.cells.length !== snapshotCsvColumns.length) {
    throw new Error(
      `Snapshot CSV ${path}:${header.line} must contain ${snapshotCsvColumns.length} columns in the snapshot format.`
    );
  }
  const indexes = new Map<string, number>();
  header.cells.forEach((cell, index) => {
    const column = cell.trim();
    if (!snapshotCsvColumns.includes(column as (typeof snapshotCsvColumns)[number])) {
      throw new Error(`Snapshot CSV ${path}:${header.line} has unknown column "${cell}".`);
    }
    if (indexes.has(column)) throw new Error(`Snapshot CSV ${path}:${header.line} repeats column "${cell}".`);
    indexes.set(column, index);
  });
  const missingColumns = snapshotCsvColumns.filter((column) => !indexes.has(column));
  if (missingColumns.length > 0) {
    throw new Error(`Snapshot CSV ${path}:${header.line} is missing column "${missingColumns[0]}".`);
  }
  if (rows.length === 1) {
    throw new Error(`Snapshot CSV ${path} must contain an empty-snapshot row with metadata.`);
  }

  let metadata: { snapshotVersion: 1; capturedAt: string; org?: string; rowLine: number } | undefined;
  type CsvUserState = { entry: UserSnapshotEntry; hasNone: boolean; hasAssignment: boolean; rowLine: number };
  const users = new Map<string, CsvUserState>();
  const metadataFields = ['snapshotVersion', 'capturedAt', 'org'] as const;
  const identityFields = ['userName', 'username', 'email', 'profile', 'role'] as const;

  for (const row of rows.slice(1)) {
    if (row.cells.length !== snapshotCsvColumns.length) {
      throw new Error(
        `Snapshot CSV ${path}:${row.line} must contain ${snapshotCsvColumns.length} cells but found ${row.cells.length}.`
      );
    }
    const version = snapshotCsvValue(row.cells, indexes, 'snapshotVersion');
    const capturedAt = snapshotCsvValue(row.cells, indexes, 'capturedAt');
    const org = optionalSnapshotValue(snapshotCsvValue(row.cells, indexes, 'org'));
    const currentMetadata = { snapshotVersion: Number(version), capturedAt, org };
    if (currentMetadata.snapshotVersion !== 1 || !Number.isInteger(currentMetadata.snapshotVersion)) {
      throw new Error(`Snapshot CSV ${path}:${row.line} must contain snapshotVersion 1.`);
    }
    if (capturedAt.length === 0) throw new Error(`Snapshot CSV ${path}:${row.line} must include capturedAt.`);
    if (!metadata) {
      metadata = { snapshotVersion: 1, capturedAt, org, rowLine: row.line };
    } else {
      for (const field of metadataFields) {
        if (metadata[field] !== currentMetadata[field]) {
          throw new Error(
            `Snapshot CSV ${path}:${row.line} conflicts with metadata from row ${metadata.rowLine} for ${field}.`
          );
        }
      }
    }

    const category = snapshotCsvValue(row.cells, indexes, 'category');
    const name = snapshotCsvValue(row.cells, indexes, 'name');
    if (category === emptySnapshotCategory) {
      if (rows.length !== 2) {
        throw new Error(`Snapshot CSV ${path}:${row.line} empty-snapshot row must be the only data row.`);
      }
      const emptyColumns = [
        'match',
        'matchValue',
        'userId',
        'userName',
        'username',
        'email',
        'profile',
        'role',
        'isActive',
        'isFrozen',
        'name',
      ] as const;
      for (const column of emptyColumns) {
        if (snapshotCsvValue(row.cells, indexes, column).length > 0) {
          throw new Error(`Snapshot CSV ${path}:${row.line} empty-snapshot row must leave ${column} empty.`);
        }
      }
      continue;
    }

    const match = snapshotCsvValue(row.cells, indexes, 'match');
    const matchValue = snapshotCsvValue(row.cells, indexes, 'matchValue');
    const userId = snapshotCsvValue(row.cells, indexes, 'userId');
    const isActive = parseSnapshotBoolean(snapshotCsvValue(row.cells, indexes, 'isActive'), row.line, 'isActive');
    const isFrozen = parseSnapshotBoolean(snapshotCsvValue(row.cells, indexes, 'isFrozen'), row.line, 'isFrozen');
    if (!match || !matchValue || !userId) {
      throw new Error(`Snapshot CSV ${path}:${row.line} must include match, matchValue, and userId.`);
    }
    const assignmentField = snapshotAssignmentCategories.find(([, value]) => value === category)?.[0] as
      | SnapshotAssignmentField
      | undefined;
    if (category !== 'none' && !assignmentField) {
      throw new Error(`Snapshot CSV ${path}:${row.line} has unknown category "${category}".`);
    }
    if (category === 'none' && name.length > 0) {
      throw new Error(`Snapshot CSV ${path}:${row.line} must leave name empty for category none.`);
    }
    if (assignmentField && name.length === 0) {
      throw new Error(`Snapshot CSV ${path}:${row.line} must include name for category ${category}.`);
    }

    const key = JSON.stringify([match, matchValue, userId]);
    let state = users.get(key);
    if (!state) {
      state = {
        entry: {
          match,
          matchValue,
          userId,
          name: optionalSnapshotValue(snapshotCsvValue(row.cells, indexes, 'userName')),
          username: optionalSnapshotValue(snapshotCsvValue(row.cells, indexes, 'username')),
          email: optionalSnapshotValue(snapshotCsvValue(row.cells, indexes, 'email')),
          profile: optionalSnapshotValue(snapshotCsvValue(row.cells, indexes, 'profile')),
          role: optionalSnapshotValue(snapshotCsvValue(row.cells, indexes, 'role')),
          IsActive: isActive,
          IsFrozen: isFrozen,
          permissionSets: [],
          permissionSetGroups: [],
          publicGroups: [],
          queues: [],
          permissionSetLicenses: [],
        },
        hasNone: false,
        hasAssignment: false,
        rowLine: row.line,
      };
      for (const field of ['name', 'username', 'email', 'profile', 'role'] as const) {
        if (state.entry[field] === undefined) delete state.entry[field];
      }
      users.set(key, state);
    }
    if (state.entry.IsActive !== isActive || state.entry.IsFrozen !== isFrozen) {
      throw new Error(`Snapshot CSV ${path}:${row.line} conflicts with lifecycle state from row ${state.rowLine}.`);
    }
    for (const field of identityFields) {
      const value = optionalSnapshotValue(snapshotCsvValue(row.cells, indexes, field));
      const entryField = field === 'userName' ? 'name' : field;
      const existing = state.entry[entryField];
      if (value && existing && value !== existing) {
        throw new Error(`Snapshot CSV ${path}:${row.line} conflicts with ${field} from row ${state.rowLine}.`);
      }
      if (value && !existing) state.entry[entryField] = value;
    }
    if (category === 'none') {
      if (state.hasAssignment) throw new Error(`Snapshot CSV ${path}:${row.line} mixes none with assignments.`);
      state.hasNone = true;
    } else if (assignmentField) {
      if (state.hasNone) throw new Error(`Snapshot CSV ${path}:${row.line} mixes assignments with none.`);
      state.hasAssignment = true;
      state.entry[assignmentField] = unique([...state.entry[assignmentField], name]);
    }
  }

  const snapshot = {
    snapshotVersion: 1 as const,
    capturedAt: metadata?.capturedAt ?? '',
    ...(metadata?.org ? { org: metadata.org } : {}),
    users: [...users.values()].map(({ entry }) => entry),
  };
  return assertSnapshotFile(snapshot);
};

export const writeSnapshotFile = async (path: string, snapshot: UserSnapshotFile): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  const contents =
    detectInputFormat(path) === 'csv'
      ? `${serializeSnapshotCsv(snapshot)}\n`
      : `${JSON.stringify(snapshot, null, 2)}\n`;
  await writeFile(path, contents, 'utf8');
};

export const readSnapshotFile = async (path: string): Promise<UserSnapshotFile> => {
  const source = await readFile(path, 'utf8');
  return detectInputFormat(path) === 'csv'
    ? deserializeSnapshotCsv(source, path)
    : assertSnapshotFile(JSON.parse(source) as unknown);
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
    for (const field of ['name', 'username', 'email', 'profile', 'role']) {
      if (row[field] !== undefined && typeof row[field] !== 'string') {
        throw new Error(`Snapshot user ${index + 1} field ${field} must be a string when present.`);
      }
    }
    if (typeof row.IsActive !== 'boolean') throw new Error(`Snapshot user ${index + 1} must include IsActive.`);
    if (typeof row.IsFrozen !== 'boolean') throw new Error(`Snapshot user ${index + 1} must include IsFrozen.`);
  }
  return value as UserSnapshotFile;
};
