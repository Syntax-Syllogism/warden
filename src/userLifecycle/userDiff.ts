import { SfError, type Connection, Messages } from '@salesforce/core';
import {
  buildFieldMap,
  type CanonicalizedUser,
  type PersonaDefinition,
  type UserFieldMeta,
  validateAndCanonicalizeUsers,
  validateExternalIdFieldForFlag,
  validatePersonaModes,
} from '../userProvisioning/planner.js';
import {
  buildTarget,
  getExistingUsers,
  resolveReferences,
  type ExistingUser,
} from '../userProvisioning/provisionUserUseCase.js';
import {
  computeAssignmentDeltaFromState,
  extractCurrentIds,
  type AssignmentCategoryDelta,
  type AssignmentDelta,
  type ResolvedRefs,
} from '../userProvisioning/assignmentPlan.js';
import { batch, soqlIn } from '../userShared/sfUtils.js';
import { loadAssignmentState } from './assignmentState.js';
import { parseUserFlag, resolveTargetField, resolveTargets } from './targeting.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('@syntax-syllogism/warden', 'warden.diff');

type JsonRecord = Record<string, unknown>;
type ExistingUserWithFields = ExistingUser & { ProfileId?: string | null; UserRoleId?: string | null };
type DiffField = {
  current?: string | null;
  intended?: string | null;
  matches: boolean;
};

export type UserAssignmentDiff = {
  key: string;
  id?: string;
  personas?: string[];
  matchedBy?: string | null;
  status: 'compared' | 'would-create' | 'failed';
  profile: DiffField;
  role: DiffField;
  assignments: AssignmentDelta;
  errors: string[];
};

export type UserDiffRow = {
  userKey: string;
  userId: string;
  category: string;
  kind: 'add' | 'remove' | 'inBoth' | 'onlyInOrg' | 'profile' | 'role' | 'error';
  value: string;
  mode?: string;
};

export type UserDiffResult = {
  summary: { total: number; compared: number; wouldCreate: number; failed: number; changed: number };
  users: UserAssignmentDiff[];
  rows: UserDiffRow[];
  warnings: string[];
  labels?: Record<string, string>;
};

type PersonaDiffRequest = {
  connection: Connection;
  usersDoc: JsonRecord;
  personasDoc: JsonRecord;
  externalId?: string;
};

type UserDiffRequest = {
  connection: Connection;
  user: string;
  against: string;
};

const QUERY_BATCH_SIZE = 100;

const emptyCategory = (mode?: 'additive' | 'sync'): AssignmentCategoryDelta => ({
  adds: [],
  removes: [],
  inBoth: [],
  onlyInOrg: [],
  ...(mode ? { mode } : {}),
});

const emptyAssignments = (): AssignmentDelta => ({
  permissionSets: emptyCategory(),
  permissionSetGroups: emptyCategory(),
  publicGroups: emptyCategory(),
  queues: emptyCategory(),
});

const summarize = (users: UserAssignmentDiff[]): UserDiffResult['summary'] => ({
  total: users.length,
  compared: users.filter((user) => user.status === 'compared').length,
  wouldCreate: users.filter((user) => user.status === 'would-create').length,
  failed: users.filter((user) => user.status === 'failed').length,
  changed: users.filter(hasChanges).length,
});

const hasCategoryChanges = (category: AssignmentCategoryDelta): boolean =>
  category.adds.length > 0 || category.removes.length > 0;

const hasChanges = (user: UserAssignmentDiff): boolean =>
  user.status !== 'failed' &&
  (!user.profile.matches ||
    !user.role.matches ||
    hasCategoryChanges(user.assignments.permissionSets) ||
    hasCategoryChanges(user.assignments.permissionSetGroups) ||
    hasCategoryChanges(user.assignments.publicGroups) ||
    hasCategoryChanges(user.assignments.queues));

const rowsForUser = (user: UserAssignmentDiff): UserDiffRow[] => {
  const rows: UserDiffRow[] = [];
  const pushCategory = (category: keyof AssignmentDelta, delta: AssignmentCategoryDelta): void => {
    for (const kind of ['adds', 'removes', 'inBoth', 'onlyInOrg'] as const) {
      const rowKind = kind === 'adds' ? 'add' : kind === 'removes' ? 'remove' : kind;
      for (const value of delta[kind]) {
        rows.push({
          userKey: user.key,
          userId: user.id ?? '',
          category,
          kind: rowKind,
          value,
          mode: delta.mode,
        });
      }
    }
  };
  pushCategory('permissionSets', user.assignments.permissionSets);
  pushCategory('permissionSetGroups', user.assignments.permissionSetGroups);
  pushCategory('publicGroups', user.assignments.publicGroups);
  pushCategory('queues', user.assignments.queues);
  if (!user.profile.matches) {
    rows.push({
      userKey: user.key,
      userId: user.id ?? '',
      category: 'profile',
      kind: 'profile',
      value: `${user.profile.current ?? ''} -> ${user.profile.intended ?? ''}`,
    });
  }
  if (!user.role.matches) {
    rows.push({
      userKey: user.key,
      userId: user.id ?? '',
      category: 'role',
      kind: 'role',
      value: `${user.role.current ?? ''} -> ${user.role.intended ?? ''}`,
    });
  }
  for (const error of user.errors) {
    rows.push({ userKey: user.key, userId: user.id ?? '', category: 'error', kind: 'error', value: error });
  }
  return rows;
};

const buildResult = (
  users: UserAssignmentDiff[],
  warnings: string[] = [],
  labels?: Record<string, string>
): UserDiffResult => ({
  summary: summarize(users),
  users,
  rows: users.flatMap(rowsForUser),
  warnings,
  labels,
});

const describeUserFields = async (conn: Connection): Promise<Map<string, UserFieldMeta>> => {
  const userDescribe = await conn.describe('User');
  return buildFieldMap(
    userDescribe.fields.map(
      (field): UserFieldMeta => ({
        name: field.name,
        createable: field.createable,
        updateable: field.updateable,
        externalId: field.externalId,
      })
    )
  );
};

const validationErrorsFor = (user: CanonicalizedUser): string[] =>
  (user.validationErrors ?? []).map((error) => messages.getMessage(error.messageKey, error.messageArgs));

const matchKey = (field: string, value: string): string => `${field}:${value}`;

const findExisting = (
  user: CanonicalizedUser,
  target: JsonRecord,
  defaultExternalIdField: string | undefined,
  existingByField: Map<string, Map<string, ExistingUser>>
): { matchedBy: string | null; existing?: ExistingUser } => {
  const matchedBy = user.matchField ?? defaultExternalIdField ?? null;
  const matchValue = matchedBy ? target[matchedBy] : undefined;
  const existing =
    matchedBy && typeof matchValue === 'string' ? existingByField.get(matchedBy)?.get(matchValue) : undefined;
  return { matchedBy, existing };
};

const makeProfileRole = (
  existing: ExistingUserWithFields | undefined,
  target: JsonRecord
): { profile: DiffField; role: DiffField } => {
  const intendedProfile = typeof target.ProfileId === 'string' ? target.ProfileId : null;
  const intendedRole = typeof target.UserRoleId === 'string' ? target.UserRoleId : null;
  return {
    profile: {
      current: existing?.ProfileId ?? null,
      intended: intendedProfile,
      matches: intendedProfile === null || (existing?.ProfileId ?? null) === intendedProfile,
    },
    role: {
      current: existing?.UserRoleId ?? null,
      intended: intendedRole,
      matches: intendedRole === null || (existing?.UserRoleId ?? null) === intendedRole,
    },
  };
};

const invertRefs = (refs: ResolvedRefs): Record<string, string> => {
  const labels: Record<string, string> = {};
  for (const map of [
    refs.profilesByRef,
    refs.rolesByRef,
    refs.permissionSetIdsByRef,
    refs.permissionSetGroupIdsByRef,
    refs.publicGroupIdsByRef,
    refs.queueIdsByRef,
  ]) {
    for (const [ref, id] of map.entries()) labels[id] = ref;
  }
  return labels;
};

const diffForMissingUser = (
  user: CanonicalizedUser,
  refs: ResolvedRefs,
  target: JsonRecord,
  matchedBy: string | null
): UserAssignmentDiff => ({
  key: user.inputKey,
  personas: user.personas,
  matchedBy,
  status: 'would-create',
  ...makeProfileRole(undefined, target),
  assignments: computeAssignmentDeltaFromState(user.effectivePersona, refs, [], []),
  errors: [],
});

export const executePersonaDiff = async (request: PersonaDiffRequest): Promise<UserDiffResult> => {
  const { connection: conn, usersDoc, personasDoc } = request;
  if (!personasDoc.personas || typeof personasDoc.personas !== 'object' || Array.isArray(personasDoc.personas)) {
    throw new SfError(messages.getMessage('errorInvalidPersonaDefinition'));
  }

  const fieldMap = await describeUserFields(conn);
  const personas = personasDoc.personas as Record<string, PersonaDefinition>;
  validatePersonaModes(personas);
  validateExternalIdFieldForFlag(request.externalId, fieldMap);
  const users = validateAndCanonicalizeUsers(usersDoc.users, personas, fieldMap);
  const defaultExternalIdField = request.externalId
    ? fieldMap.get(request.externalId.toLowerCase())?.name
    : undefined;
  const validUsers = users.filter((user) => !user.validationErrors || user.validationErrors.length === 0);
  const [refs, existingResolution] = await Promise.all([
    resolveReferences(conn, personas, validUsers),
    getExistingUsers(conn, validUsers, defaultExternalIdField),
  ]);
  const existingIds = [...existingResolution.existingByField.values()].flatMap((byValue) =>
    [...byValue.values()].map((user) => user.Id)
  );
  const uniqueExistingIds = [...new Set(existingIds)];
  const [existingProfileRoles, assignmentState] = await Promise.all([
    queryUserRoles(conn, uniqueExistingIds),
    loadAssignmentState(conn, uniqueExistingIds, { permissionSetAssignments: true, groupMemberships: true }),
  ]);

  const results = users.map((user): UserAssignmentDiff => {
    const validationErrors = validationErrorsFor(user);
    if (validationErrors.length > 0) {
      return {
        key: user.inputKey,
        personas: user.personas,
        matchedBy: user.matchField ?? null,
        status: 'failed',
        profile: { matches: true },
        role: { matches: true },
        assignments: emptyAssignments(),
        errors: validationErrors,
      };
    }

    const errors: string[] = [];
    const target = buildTarget(user, refs, errors);
    const { matchedBy, existing: existingMatch } = findExisting(
      user,
      target,
      defaultExternalIdField,
      existingResolution.existingByField
    );
    const profileRole = existingMatch ? existingProfileRoles.get(existingMatch.Id) : undefined;
    const existing = existingMatch ? { ...existingMatch, ...profileRole } : undefined;
    const matchValue = matchedBy ? target[matchedBy] : undefined;
    if (
      matchedBy &&
      typeof matchValue === 'string' &&
      existingResolution.duplicates.has(matchKey(matchedBy, matchValue))
    ) {
      errors.push(messages.getMessage('errorDuplicateExternalIdMatch', [matchedBy, matchValue]));
    }
    if (errors.length > 0) {
      return {
        key: user.inputKey,
        id: existing?.Id,
        personas: user.personas,
        matchedBy,
        status: 'failed',
        ...makeProfileRole(existing, target),
        assignments: emptyAssignments(),
        errors,
      };
    }
    if (!existing) {
      return diffForMissingUser(user, refs, target, matchedBy);
    }
    const assignments = computeAssignmentDeltaFromState(
      user.effectivePersona,
      refs,
      assignmentState.psaByUserId.get(existing.Id) ?? [],
      assignmentState.groupByUserId.get(existing.Id) ?? []
    );
    return {
      key: user.inputKey,
      id: existing.Id,
      personas: user.personas,
      matchedBy,
      status: 'compared',
      ...makeProfileRole(existing, target),
      assignments,
      errors: [],
    };
  });

  return buildResult(results, refs.warnings, invertRefs(refs));
};

const queryUserRoles = async (
  conn: Connection,
  ids: string[]
): Promise<Map<string, { ProfileId?: string | null; UserRoleId?: string | null }>> => {
  if (ids.length === 0) return new Map();
  const rowBatches = await Promise.all(batch([...new Set(ids)], QUERY_BATCH_SIZE).map(async (idBatch) =>
    (
      await conn.query<{ Id: string; ProfileId?: string | null; UserRoleId?: string | null }>(
        `SELECT Id, ProfileId, UserRoleId FROM User WHERE Id IN (${soqlIn(idBatch)})`
      )
    ).records
  ));
  return new Map(rowBatches.flat().map((row) => [row.Id, { ProfileId: row.ProfileId, UserRoleId: row.UserRoleId }]));
};

const partitionIds = (currentIds: string[], intendedIds: string[], mode?: AssignmentCategoryDelta['mode']): AssignmentCategoryDelta => {
  const current = new Set(currentIds);
  const intended = new Set(intendedIds);
  const onlyInOrg = [...current].filter((id) => !intended.has(id));
  return {
    adds: [...intended].filter((id) => !current.has(id)),
    removes: mode === 'additive' ? [] : onlyInOrg,
    inBoth: [...intended].filter((id) => current.has(id)),
    onlyInOrg,
    ...(mode ? { mode } : {}),
  };
};

const loadCurrentAssignmentIds = (
  state: Awaited<ReturnType<typeof loadAssignmentState>>,
  userId: string
): { permissionSets: string[]; permissionSetGroups: string[]; publicGroups: string[]; queues: string[] } =>
  extractCurrentIds(state.psaByUserId.get(userId) ?? [], state.groupByUserId.get(userId) ?? []);

const parseUserFlagAsSfError = (
  raw: string,
  messageKey: 'errorInvalidUserValue' | 'errorInvalidAgainstValue'
): { field: string; value: string } => {
  try {
    return parseUserFlag(raw);
  } catch {
    throw new SfError(messages.getMessage(messageKey, [raw]));
  }
};

export const executeUserToUserDiff = async (request: UserDiffRequest): Promise<UserDiffResult> => {
  const { connection: conn } = request;
  const fieldMap = await describeUserFields(conn);
  const parsedUser = parseUserFlagAsSfError(request.user, 'errorInvalidUserValue');
  const parsedAgainst = parseUserFlagAsSfError(request.against, 'errorInvalidAgainstValue');
  const userField = resolveTargetField(parsedUser.field, fieldMap);
  const againstField = resolveTargetField(parsedAgainst.field, fieldMap);
  if (!userField) throw new SfError(messages.getMessage('errorInvalidUserMatchField', [parsedUser.field]));
  if (!againstField) throw new SfError(messages.getMessage('errorInvalidAgainstMatchField', [parsedAgainst.field]));
  const { targets, errors } = await resolveTargets(conn, [
    { key: `${userField}:${parsedUser.value}`, field: userField, value: parsedUser.value, order: 0 },
    { key: `${againstField}:${parsedAgainst.value}`, field: againstField, value: parsedAgainst.value, order: 1 },
  ]);
  if (errors.length > 0) {
    return buildResult(
      errors.map((error) => ({
        key: error.key,
        id: undefined,
        matchedBy: error.field,
        status: 'failed',
        profile: { matches: true },
        role: { matches: true },
        assignments: emptyAssignments(),
        errors: [error.message],
      }))
    );
  }
  const target = targets[0];
  const against = targets[1];
  const state = await loadAssignmentState(conn, [target.Id, against.Id], {
    permissionSetAssignments: true,
    groupMemberships: true,
  });
  const profilesById = await queryUserRoles(conn, [target.Id, against.Id]);
  const targetAssignments = loadCurrentAssignmentIds(state, target.Id);
  const againstAssignments = loadCurrentAssignmentIds(state, against.Id);
  const userProfile = profilesById.get(target.Id);
  const againstProfile = profilesById.get(against.Id);
  const result: UserAssignmentDiff = {
    key: target.key,
    id: target.Id,
    matchedBy: target.field,
    status: 'compared',
    profile: {
      current: userProfile?.ProfileId ?? null,
      intended: againstProfile?.ProfileId ?? null,
      matches: (userProfile?.ProfileId ?? null) === (againstProfile?.ProfileId ?? null),
    },
    role: {
      current: userProfile?.UserRoleId ?? null,
      intended: againstProfile?.UserRoleId ?? null,
      matches: (userProfile?.UserRoleId ?? null) === (againstProfile?.UserRoleId ?? null),
    },
    assignments: {
      permissionSets: partitionIds(targetAssignments.permissionSets, againstAssignments.permissionSets),
      permissionSetGroups: partitionIds(targetAssignments.permissionSetGroups, againstAssignments.permissionSetGroups),
      publicGroups: partitionIds(targetAssignments.publicGroups, againstAssignments.publicGroups),
      queues: partitionIds(targetAssignments.queues, againstAssignments.queues),
    },
    errors: [],
  };
  return buildResult([result]);
};

const csvEscape = (value: string): string => {
  if (!/[",\n\r]/.test(value)) return value;
  return `"${value.replaceAll('"', '""')}"`;
};

export const renderUserDiffCsv = (result: UserDiffResult): string => {
  const header = ['userKey', 'userId', 'category', 'kind', 'value', 'mode'];
  const rows = result.rows.map((row) =>
    [row.userKey, row.userId, row.category, row.kind, row.value, row.mode ?? ''].map(csvEscape).join(',')
  );
  return [header.join(','), ...rows].join('\n');
};

const displayValue = (result: UserDiffResult, value: string): string =>
  result.labels?.[value] ? `${result.labels[value]} (${value})` : value;

const renderFieldDiff = (
  result: UserDiffResult,
  label: 'profile' | 'role',
  field: DiffField
): string | undefined =>
  field.matches ? undefined : `  ${label}: ${displayValue(result, field.current ?? '')} -> ${displayValue(result, field.intended ?? '')}`;

const renderCategoryDiff = (
  result: UserDiffResult,
  label: keyof AssignmentDelta,
  delta: AssignmentCategoryDelta,
  verbose: boolean
): string[] => {
  if (delta.adds.length === 0 && delta.removes.length === 0 && delta.inBoth.length === 0 && delta.onlyInOrg.length === 0) {
    return [];
  }
  const lines = [`  ${label}${delta.mode ? ` (${delta.mode})` : ''}:`];
  for (const value of delta.adds) lines.push(`    + ${displayValue(result, value)}`);
  for (const value of delta.removes) lines.push(`    - ${displayValue(result, value)}`);
  if (verbose) {
    for (const value of delta.inBoth) lines.push(`    = ${displayValue(result, value)}`);
  }
  for (const extraValue of delta.onlyInOrg.filter((candidate) => !delta.removes.includes(candidate))) {
    lines.push(`    extra ${displayValue(result, extraValue)}`);
  }
  return lines;
};

export const renderUserDiffHuman = (result: UserDiffResult, options: { verbose?: boolean } = {}): string => {
  const lines = [
    messages.getMessage('info.summary', [
      String(result.summary.total),
      String(result.summary.changed),
      String(result.summary.failed),
    ]),
  ];
  for (const warning of result.warnings) lines.push(`warning: ${warning}`);
  for (const user of result.users) {
    lines.push('');
    lines.push(`${user.key}${user.id ? ` (${user.id})` : ''}: ${user.status}`);
    for (const error of user.errors) lines.push(`  error: ${error}`);
    const profileLine = renderFieldDiff(result, 'profile', user.profile);
    const roleLine = renderFieldDiff(result, 'role', user.role);
    if (profileLine) lines.push(profileLine);
    if (roleLine) lines.push(roleLine);
    for (const [label, delta] of Object.entries(user.assignments) as Array<[keyof AssignmentDelta, AssignmentCategoryDelta]>) {
      lines.push(...renderCategoryDiff(result, label, delta, options.verbose === true));
    }
  }
  return lines.join('\n');
};
