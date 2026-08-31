import { SfError, type Connection, Messages } from '@salesforce/core';
import {
  type CanonicalizedUser,
  type PersonaDefinition,
  type UserFieldMeta,
  validateAndCanonicalizeUsers,
  validateExternalIdFieldForFlag,
  validatePersonaModes,
} from '../userProvisioning/planner.js';
import { getExistingUsers, type ExistingUser } from '../userProvisioning/provisionUserUseCase.js';
import { buildTarget } from '../userProvisioning/userPlan.js';
import { resolveReferences } from '../userProvisioning/referenceResolution.js';
import {
  computeAssignmentDeltaFromState,
  extractCurrentIds,
  type AssignmentCategoryDelta,
  type AssignmentDelta,
  type ResolvedRefs,
} from '../userProvisioning/assignmentPlan.js';
import { batch, soqlIn } from '../userShared/sfUtils.js';
import type { InputFormat } from '../userShared/csv.js';
import { describeUserFields } from '../userShared/userFields.js';
import {
  loadValidatedDefinitions,
  type DefinitionMessages,
  type ProvisionDefinitionDocuments,
} from '../userProvisioning/definitionReader.js';
import { matchKey } from '../userMatching/index.js';
import {
  groupMemberLabel,
  loadAssignmentState,
  permissionSetAssignmentLabel,
  type GroupMemberRow,
  type PermissionSetAssignmentRow,
} from './assignmentState.js';
import { parseUserFlag, resolveTargetField, resolveTargets } from './targeting.js';
import type { LabelBundle, LabelMap } from './types.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('@syntax-syllogism/warden', 'warden.diff');

const diffDefinitionMessages: DefinitionMessages = {
  invalidPersonaDefinition: () => messages.getMessage('errorInvalidPersonaDefinition'),
  personasWithoutDefinition: (userKey) => messages.getMessage('errorPersonasWithoutDefinition', [userKey]),
  invalidJson: (path, error) => messages.getMessage('errorInvalidJson', [path, error]),
};
type JsonRecord = Record<string, unknown>;
type ExistingUserWithFields = ExistingUser & { ProfileId?: string | null; UserRoleId?: string | null };
export type DiffField = { current?: string | null; intended?: string | null; matches: boolean };
export type UserAssignmentDiff = {
  key: string;
  id?: string;
  userName?: string;
  username?: string;
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
  userName?: string;
  username?: string;
  category: string;
  kind: 'add' | 'remove' | 'inBoth' | 'onlyInOrg' | 'profile' | 'role' | 'error';
  value: string;
  mode?: string;
  valueBefore?: string;
  valueAfter?: string;
};
export type UserDiffResult = {
  summary: { total: number; compared: number; wouldCreate: number; failed: number; changed: number };
  users: UserAssignmentDiff[];
  rows: UserDiffRow[];
  warnings: string[];
  labels?: LabelMap;
};
type PersonaDiffRequest = {
  connection: Connection;
  usersDoc?: JsonRecord;
  personasDoc?: JsonRecord;
  usersPath?: string;
  personasPath?: string;
  inputFormat?: InputFormat;
  csvListDelimiter?: string;
  externalId?: string;
  personasSupplied?: boolean;
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
  const identity = { userName: user.userName ?? '', username: user.username ?? '' };
  const pushCategory = (category: keyof AssignmentDelta, delta: AssignmentCategoryDelta): void => {
    for (const kind of ['adds', 'removes', 'inBoth', 'onlyInOrg'] as const) {
      const rowKind = kind === 'adds' ? 'add' : kind === 'removes' ? 'remove' : kind;
      for (const value of delta[kind]) {
        rows.push({
          userKey: user.key,
          userId: user.id ?? '',
          ...identity,
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
      ...identity,
      category: 'profile',
      kind: 'profile',
      value: `${user.profile.current ?? ''} -> ${user.profile.intended ?? ''}`,
      valueBefore: user.profile.current ?? '',
      valueAfter: user.profile.intended ?? '',
    });
  }
  if (!user.role.matches) {
    rows.push({
      userKey: user.key,
      userId: user.id ?? '',
      ...identity,
      category: 'role',
      kind: 'role',
      value: `${user.role.current ?? ''} -> ${user.role.intended ?? ''}`,
      valueBefore: user.role.current ?? '',
      valueAfter: user.role.intended ?? '',
    });
  }
  for (const error of user.errors) {
    rows.push({
      ...identity,
      userKey: user.key,
      userId: user.id ?? '',
      category: 'error',
      kind: 'error',
      value: error,
    });
  }
  return rows;
};
const buildResult = (users: UserAssignmentDiff[], warnings: string[] = [], labels?: LabelMap): UserDiffResult => ({
  summary: summarize(users),
  users,
  rows: users.flatMap(rowsForUser),
  warnings,
  labels,
});
const addSourceContext = (user: CanonicalizedUser, errors: string[]): string[] =>
  user.source ? errors.map((error) => `${user.source?.path}:${user.source?.line} — ${error}`) : errors;
const validationErrorsFor = (user: CanonicalizedUser): string[] =>
  addSourceContext(
    user,
    (user.validationErrors ?? []).map((error) => messages.getMessage(error.messageKey, error.messageArgs))
  );
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
const addLabel = (labels: LabelMap, bundle: LabelBundle): void => {
  const current = labels[bundle.id];
  const merged: LabelBundle = {
    ...current,
    ...bundle,
    id: bundle.id,
  };
  if (bundle.apiName ?? current?.apiName) merged.apiName = bundle.apiName ?? current?.apiName;
  if (bundle.label ?? current?.label) merged.label = bundle.label ?? current?.label;
  if (bundle.type ?? current?.type) merged.type = bundle.type ?? current?.type;
  labels[bundle.id] = merged;
};
const addAssignmentLabels = (
  labels: LabelMap,
  psaRows: PermissionSetAssignmentRow[],
  groupRows: GroupMemberRow[]
): void => {
  for (const row of psaRows) {
    const bundle = permissionSetAssignmentLabel(row);
    if (bundle) addLabel(labels, bundle);
  }
  for (const row of groupRows) addLabel(labels, groupMemberLabel(row));
};
type ProfileRoleState = {
  ProfileId?: string | null;
  UserRoleId?: string | null;
  profileName: string;
  roleName: string;
};
export const displayName = (id: string | null | undefined, relationship: { Name?: string } | null | undefined): string => relationship?.Name ?? id ?? '';
const addProfileRoleLabels = (labels: LabelMap, states: Map<string, ProfileRoleState>): void => {
  for (const state of states.values()) {
    if (state.ProfileId) addLabel(labels, { id: state.ProfileId, label: state.profileName, type: 'Profile' });
    if (state.UserRoleId) addLabel(labels, { id: state.UserRoleId, label: state.roleName, type: 'UserRole' });
  }
};
const buildLabelMap = (
  refs: ResolvedRefs | undefined,
  assignmentState: Awaited<ReturnType<typeof loadAssignmentState>>,
  profileRoles: Map<string, ProfileRoleState>
): LabelMap => {
  const labels: LabelMap = {};
  if (refs?.labels) Object.assign(labels, refs.labels);
  addAssignmentLabels(
    labels,
    [...assignmentState.psaByUserId.values()].flat(),
    [...assignmentState.groupByUserId.values()].flat()
  );
  addProfileRoleLabels(labels, profileRoles);
  return labels;
};
const diffForMissingUser = (
  user: CanonicalizedUser,
  refs: ResolvedRefs,
  target: JsonRecord,
  matchedBy: string | null
): UserAssignmentDiff => ({
  key: user.inputKey,
  userName: [user.fields.FirstName, user.fields.LastName]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join(' '),
  username: typeof user.fields.Username === 'string' ? user.fields.Username : undefined,
  personas: user.personas,
  matchedBy,
  status: 'would-create',
  ...makeProfileRole(undefined, target),
  assignments: computeAssignmentDeltaFromState(user.effectivePersona, refs, [], []),
  errors: [],
});
export const executePersonaDiff = async (request: PersonaDiffRequest): Promise<UserDiffResult> => {
  const { connection: conn } = request;
  let fieldMap: Map<string, UserFieldMeta>;
  let definitions: ProvisionDefinitionDocuments;
  if (request.usersDoc) {
    definitions = await loadValidatedDefinitions(request, new Map(), diffDefinitionMessages);
    fieldMap = await describeUserFields(conn);
  } else {
    fieldMap = await describeUserFields(conn);
    definitions = await loadValidatedDefinitions(request, fieldMap, diffDefinitionMessages);
  }
  const { usersDoc, personasDoc } = definitions;
  const personasSupplied = request.personasSupplied ?? definitions.personasSupplied;
  const personas = personasDoc.personas as Record<string, PersonaDefinition>;
  validatePersonaModes(personas);
  validateExternalIdFieldForFlag(request.externalId, fieldMap);
  const users = validateAndCanonicalizeUsers(usersDoc.users, personas, fieldMap, personasSupplied);
  const defaultExternalIdField = request.externalId ? fieldMap.get(request.externalId.toLowerCase())?.name : undefined;
  const validUsers = users.filter((user) => !user.validationErrors || user.validationErrors.length === 0);
  const [refs, existingResolution] = await Promise.all([
    resolveReferences(conn, personas, validUsers),
    getExistingUsers(conn, validUsers, { defaultExternalIdField, fieldMap }),
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
        userName: [user.fields.FirstName, user.fields.LastName]
          .filter((value): value is string => typeof value === 'string' && value.length > 0)
          .join(' '),
        username: typeof user.fields.Username === 'string' ? user.fields.Username : undefined,
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
        userName: existing?.Name,
        username: existing?.Username,
        personas: user.personas,
        matchedBy,
        status: 'failed',
        ...makeProfileRole(existing, target),
        assignments: emptyAssignments(),
        errors: addSourceContext(user, errors),
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
      userName: existing.Name,
      username: existing.Username,
      personas: user.personas,
      matchedBy,
      status: 'compared',
      ...makeProfileRole(existing, target),
      assignments,
      errors: [],
    };
  });
  return buildResult(results, refs.warnings, buildLabelMap(refs, assignmentState, existingProfileRoles));
};
const queryUserRoles = async (conn: Connection, ids: string[]): Promise<Map<string, ProfileRoleState>> => {
  if (ids.length === 0) return new Map();
  const rowBatches = await Promise.all(
    batch([...new Set(ids)], QUERY_BATCH_SIZE).map(
      async (idBatch) =>
        (
          await conn.query<{
            Id: string;
            ProfileId?: string | null;
            Profile?: { Name?: string } | null;
            UserRoleId?: string | null;
            UserRole?: { Name?: string } | null;
          }>(`SELECT Id, ProfileId, Profile.Name, UserRoleId, UserRole.Name FROM User WHERE Id IN (${soqlIn(idBatch)})`)
        ).records
    )
  );
  return new Map<string, ProfileRoleState>(
    rowBatches.flat().map(
      (row) =>
        [
          row.Id,
          {
            ProfileId: row.ProfileId,
            UserRoleId: row.UserRoleId,
            profileName: displayName(row.ProfileId, row.Profile),
            roleName: displayName(row.UserRoleId, row.UserRole),
          },
        ] as [string, ProfileRoleState]
    )
  );
};
const partitionIds = (
  currentIds: string[],
  intendedIds: string[],
  mode?: AssignmentCategoryDelta['mode']
): AssignmentCategoryDelta => {
  const current = new Set(currentIds);
  const intended = new Set(intendedIds);
  const extras = [...current].filter((id) => !intended.has(id));
  const sorted = (ids: string[]): string[] => ids.sort((a, b) => a.localeCompare(b));
  const removes = mode === 'additive' ? [] : sorted(extras);
  return {
    adds: sorted([...intended].filter((id) => !current.has(id))),
    removes,
    inBoth: sorted([...intended].filter((id) => current.has(id))),
    onlyInOrg: sorted(extras).filter((id) => !removes.includes(id)),
    ...(mode ? { mode } : {}),
  };
};
type CurrentAssignmentIds = ReturnType<typeof extractCurrentIds>;
const loadCurrentAssignmentIds = (state: Awaited<ReturnType<typeof loadAssignmentState>>, userId: string): CurrentAssignmentIds =>
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
  const { targets, errors } = await resolveTargets(
    conn,
    [
      { key: `${userField}:${parsedUser.value}`, field: userField, value: parsedUser.value, order: 0 },
      { key: `${againstField}:${parsedAgainst.value}`, field: againstField, value: parsedAgainst.value, order: 1 },
    ],
    fieldMap
  );
  if (errors.length > 0) {
    return buildResult(
      errors.map((error) => ({
        key: error.key,
        id: undefined,
        userName: '',
        username: '',
        matchedBy: error.field,
        status: 'failed',
        profile: { matches: true },
        role: { matches: true },
        assignments: emptyAssignments(),
        errors: [error.message],
      })),
      [],
      {}
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
    userName: target.name,
    username: target.username,
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
  return buildResult([result], [], buildLabelMap(undefined, state, profilesById));
};
