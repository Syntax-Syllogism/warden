import { Connection, Messages, SfError } from '@salesforce/core';
import {
  asArray,
  esc,
  formatSaveError,
  pushErrors,
  runBatches,
  soqlIn,
  type SaveResult,
} from '../userShared/sfUtils.js';
import { matchKey, resolveExistingUsers, type ExistingUser } from '../userMatching/index.js';
export type { ExistingUser } from '../userMatching/index.js';
import { loadAssignmentState } from '../userLifecycle/assignmentState.js';
import type { LabelBundle, LabelMap } from '../userLifecycle/types.js';
import type { CsvRowInfo } from '../userShared/csv.js';
import { describeUserFields } from '../userShared/userFields.js';
import {
  buildDefaultAlias,
  buildDefaultUsername,
  CanonicalizedUser,
  deriveMyDomain,
  isSalesforceId,
  missingRequiredFieldsForInsert,
  PersonaDefinition,
  UserFieldMeta,
  validateAndCanonicalizeUsers,
  validateExternalIdFieldForFlag,
  validatePersonaModes,
} from './planner.js';
import {
  computeAssignmentDeltaFromState,
  hasAssignmentIntent,
  toDmlPlan,
  type AssignmentDmlPlan,
  type ResolvedRefs,
} from './assignmentPlan.js';
import {
  loadValidatedDefinitions,
  type DefinitionMessages,
  type ProvisionDefinitionDocuments,
} from './definitionReader.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('@syntax-syllogism/warden', 'warden.provision');

const provisionDefinitionMessages: DefinitionMessages = {
  invalidPersonaDefinition: () => messages.getMessage('errorInvalidPersonaDefinition'),
  personasWithoutDefinition: (userKey) => messages.getMessage('errorPersonasWithoutDefinition', [userKey]),
  invalidJson: (path, error) => messages.getMessage('errorInvalidJson', [path, error]),
};

type JsonRecord = Record<string, unknown>;

type UserPlan = {
  planId: string;
  order: number;
  key: string;
  personas: string[];
  effectivePersona: PersonaDefinition;
  matchedBy: string | null;
  target: JsonRecord;
  existing?: ExistingUser;
  actions: string[];
  errors: string[];
  source?: CsvRowInfo;
};

type UserSaveOutcome = {
  plan: UserPlan;
  success: boolean;
  id?: string;
  errors: string[];
};
type OrderedUserResult = UserResult & { order: number; planId: string; source?: CsvRowInfo };

type UserResult = {
  key: string;
  id?: string;
  userName?: string;
  username?: string;
  personas: string[];
  matchedBy: string | null;
  status: 'created' | 'updated' | 'failed' | 'planned';
  actions: string[];
  errors: string[];
};

const addSourceContext = (source: CsvRowInfo | undefined, errors: string[]): string[] =>
  source ? errors.map((error) => `${source.path}:${source.line} — ${error}`) : errors;

export type ProvisionResult = {
  summary: { total: number; created: number; updated: number; failed: number; warnings: number };
  users: UserResult[];
  licenses?: UserLicenseUsage[];
  permissionSetLicenses?: PermissionSetLicenseSummary;
};

export type UserLicenseUsage = {
  licenseName: string;
  required: number;
  available: number | null;
  unlimited: boolean;
  shortfall: number;
  note?: string;
};

export type PermissionSetLicenseSummary = {
  evaluated: false;
  note: 'not evaluated';
};

const DRY_RUN_CREATE_ID = 'dry-run-create';
const USER_PROCESS_CONCURRENCY = 10;

type ProfileLicenseRecord = {
  Id: string;
  UserLicenseId?: string;
  UserLicense?: { Name?: string; MasterLabel?: string };
};

type UserLicenseRecord = {
  Id: string;
  Name?: string;
  MasterLabel?: string;
  TotalLicenses?: number;
  UsedLicenses?: number;
  Status?: string;
};

const identityFromTarget = (target: JsonRecord, existing?: ExistingUser): { userName?: string; username?: string } => ({
  userName:
    existing?.Name ??
    (typeof target.Name === 'string'
      ? target.Name
      : [target.FirstName, target.LastName]
          .filter((value): value is string => typeof value === 'string' && value.length > 0)
          .join(' ') || undefined),
  username: existing?.Username ?? (typeof target.Username === 'string' ? target.Username : undefined),
});

const calculateUserLicenseUsage = async (conn: Connection, plans: UserPlan[]): Promise<UserLicenseUsage[]> => {
  const requiredByProfile = new Map<string, number>();
  for (const plan of plans) {
    if (plan.existing) continue;
    if (plan.errors.length > 0) continue;
    const profileId = typeof plan.target.ProfileId === 'string' ? plan.target.ProfileId : undefined;
    if (profileId) requiredByProfile.set(profileId, (requiredByProfile.get(profileId) ?? 0) + 1);
  }
  if (requiredByProfile.size === 0) return [];

  const profileRows = (
    await conn.query<ProfileLicenseRecord>(
      `SELECT Id, UserLicenseId, UserLicense.Name, UserLicense.MasterLabel FROM Profile WHERE Id IN (${soqlIn([
        ...requiredByProfile.keys(),
      ])})`
    )
  ).records;
  const requiredByLicense = new Map<string, { required: number; profileLicenseName?: string }>();
  for (const profile of profileRows) {
    if (!profile.UserLicenseId) continue;
    const required = requiredByProfile.get(profile.Id) ?? 0;
    const current = requiredByLicense.get(profile.UserLicenseId);
    requiredByLicense.set(profile.UserLicenseId, {
      required: (current?.required ?? 0) + required,
      profileLicenseName: current?.profileLicenseName ?? profile.UserLicense?.MasterLabel ?? profile.UserLicense?.Name,
    });
  }
  if (requiredByLicense.size === 0) return [];

  const licenseRows = (
    await conn.query<UserLicenseRecord>(
      `SELECT Id, Name, MasterLabel, TotalLicenses, UsedLicenses, Status FROM UserLicense WHERE Id IN (${soqlIn([
        ...requiredByLicense.keys(),
      ])})`
    )
  ).records;
  const licensesById = new Map(licenseRows.map((license) => [license.Id, license]));

  return [...requiredByLicense.entries()].map(([licenseId, requirement]) => {
    const license = licensesById.get(licenseId);
    const total = Number(license?.TotalLicenses ?? 0);
    const used = Number(license?.UsedLicenses ?? 0);
    const unlimited = total < 0;
    const active = license?.Status?.toLowerCase() === 'active';
    const available = unlimited ? null : active ? total - used : 0;
    const shortfall = unlimited ? 0 : Math.max(requirement.required - (available ?? 0), 0);
    return {
      licenseName: license?.MasterLabel ?? license?.Name ?? requirement.profileLicenseName ?? licenseId,
      required: requirement.required,
      available,
      unlimited,
      shortfall,
      ...(unlimited ? { note: 'unlimited' } : !active ? { note: `status ${license?.Status ?? 'unknown'}` } : {}),
    };
  });
};

const appendCrossReferenceCandidates = (errors: string[], target: JsonRecord): string[] => {
  const hasCrossRefError = errors.some((e) => e.includes('INVALID_CROSS_REFERENCE_KEY'));
  if (!hasCrossRefError) return errors;
  const candidateFields = Object.entries(target)
    .filter(([field]) => field.endsWith('Id') && field !== 'Id')
    .map(([field, value]) => `${field}=${String(value)}`);
  if (candidateFields.length === 0) return errors;
  return errors.concat(messages.getMessage('errorCrossReferenceCandidates', [candidateFields.join(', ')]));
};

const collectPersonaRefs = (personas: Record<string, PersonaDefinition>): Record<string, Set<string>> => {
  const refs = {
    profiles: new Set<string>(),
    roles: new Set<string>(),
    permissionSets: new Set<string>(),
    permissionSetGroups: new Set<string>(),
    publicGroups: new Set<string>(),
    queues: new Set<string>(),
  };
  for (const persona of Object.values(personas)) {
    if (persona.profile) refs.profiles.add(persona.profile);
    if (persona.role) refs.roles.add(persona.role);
    for (const value of persona.permissionSets ?? []) refs.permissionSets.add(value);
    for (const value of persona.permissionSetGroups ?? []) refs.permissionSetGroups.add(value);
    for (const value of persona.publicGroups ?? []) refs.publicGroups.add(value);
    for (const value of persona.queues ?? []) refs.queues.add(value);
  }
  return refs;
};

const addReferenceLabel = (
  labels: LabelMap,
  row: Record<string, string | undefined>,
  apiNameField: string,
  labelField: string | undefined,
  type: LabelBundle['type']
): void => {
  const apiName = row[apiNameField];
  const label = labelField ? row[labelField] : apiName;
  labels[row.Id as string] = {
    id: row.Id as string,
    ...(apiName ? { apiName } : {}),
    ...(label ? { label } : {}),
    type,
  };
};

const resolveByIdOrName = async (
  conn: Connection,
  table: string,
  idOrNameRefs: Set<string>,
  nameField: string,
  whereClause: string | undefined,
  warnings: string[],
  idPrefixes: string[] | undefined,
  labelField: string | undefined,
  type: LabelBundle['type'],
  labels: LabelMap
): Promise<Map<string, string>> => {
  const resolved = new Map<string, string>();
  const fields = ['Id', nameField, labelField].filter((field): field is string => Boolean(field));
  const ids = [...idOrNameRefs].filter((r) => isSalesforceId(r) && (!idPrefixes || idPrefixes.includes(r.slice(0, 3))));
  const names = [...idOrNameRefs].filter((r) => !isSalesforceId(r));
  if (ids.length > 0) {
    const where = [`Id IN (${soqlIn(ids)})`, whereClause].filter(Boolean).join(' AND ');
    const rows = (
      await conn.query<Record<string, string | undefined>>(`SELECT ${fields.join(', ')} FROM ${table} WHERE ${where}`)
    ).records;
    for (const row of rows) {
      resolved.set(row.Id as string, row.Id as string);
      addReferenceLabel(labels, row, nameField, labelField, type);
    }
  }
  if (names.length > 0) {
    const where = [`${nameField} IN (${soqlIn(names)})`, whereClause].filter(Boolean).join(' AND ');
    const rows = (
      await conn.query<Record<string, string | undefined>>(`SELECT ${fields.join(', ')} FROM ${table} WHERE ${where}`)
    ).records;
    for (const row of rows) {
      resolved.set(row[nameField] as string, row.Id as string);
      addReferenceLabel(labels, row, nameField, labelField, type);
    }
  }
  for (const ref of idOrNameRefs)
    if (!resolved.has(ref)) warnings.push(messages.getMessage('warningReferenceMissing', [table, ref]));
  return resolved;
};

const resolveByRoleRef = async (
  conn: Connection,
  refs: Set<string>,
  warnings: string[],
  labels: LabelMap
): Promise<Map<string, string>> => {
  const resolved = new Map<string, string>();
  const ids = [...refs].filter((r) => isSalesforceId(r) && r.startsWith('00E'));
  const names = [...refs].filter((r) => !isSalesforceId(r));
  if (ids.length > 0) {
    const rows = (
      await conn.query<Record<string, string | undefined>>(
        `SELECT Id, DeveloperName, Name FROM UserRole WHERE Id IN (${soqlIn(ids)})`
      )
    ).records;
    for (const row of rows) {
      resolved.set(row.Id as string, row.Id as string);
      addReferenceLabel(labels, row, 'DeveloperName', 'Name', 'UserRole');
    }
  }
  if (names.length > 0) {
    const rows = (
      await conn.query<Record<string, string | undefined>>(
        `SELECT Id, DeveloperName, Name FROM UserRole WHERE DeveloperName IN (${soqlIn(names)}) OR Name IN (${soqlIn(
          names
        )})`
      )
    ).records;
    for (const row of rows) {
      if (row.DeveloperName && names.includes(row.DeveloperName)) resolved.set(row.DeveloperName, row.Id as string);
      if (row.Name && names.includes(row.Name)) resolved.set(row.Name, row.Id as string);
      addReferenceLabel(labels, row, 'DeveloperName', 'Name', 'UserRole');
    }
  }
  for (const ref of refs)
    if (!resolved.has(ref)) warnings.push(messages.getMessage('warningReferenceMissing', ['UserRole', ref]));
  return resolved;
};

export const resolveReferences = async (
  conn: Connection,
  personas: Record<string, PersonaDefinition>,
  users: CanonicalizedUser[]
): Promise<ResolvedRefs> => {
  const warnings: string[] = [];
  const labels: LabelMap = {};
  const refs = collectPersonaRefs(personas);
  for (const user of users) {
    if (user.profileRef) refs.profiles.add(user.profileRef);
    if (user.roleRef) refs.roles.add(user.roleRef);
  }
  const [
    profilesByRef,
    rolesByRef,
    permissionSetIdsByRef,
    permissionSetGroupIdsByRef,
    publicGroupIdsByRef,
    queueIdsByRef,
  ] = await Promise.all([
    resolveByIdOrName(
      conn,
      'Profile',
      refs.profiles,
      'Name',
      undefined,
      warnings,
      ['00e'],
      undefined,
      'Profile',
      labels
    ),
    resolveByRoleRef(conn, refs.roles, warnings, labels),
    resolveByIdOrName(
      conn,
      'PermissionSet',
      refs.permissionSets,
      'Name',
      undefined,
      warnings,
      ['0PS'],
      'Label',
      'PermissionSet',
      labels
    ),
    resolveByIdOrName(
      conn,
      'PermissionSetGroup',
      refs.permissionSetGroups,
      'DeveloperName',
      undefined,
      warnings,
      ['0PG'],
      'MasterLabel',
      'PermissionSetGroup',
      labels
    ),
    resolveByIdOrName(
      conn,
      'Group',
      refs.publicGroups,
      'DeveloperName',
      "Type = 'Regular'",
      warnings,
      ['00G'],
      'Name',
      'PublicGroup',
      labels
    ),
    resolveByIdOrName(
      conn,
      'Group',
      refs.queues,
      'DeveloperName',
      "Type = 'Queue'",
      warnings,
      ['00G'],
      'Name',
      'Queue',
      labels
    ),
  ]);
  return {
    profilesByRef,
    rolesByRef,
    permissionSetIdsByRef,
    permissionSetGroupIdsByRef,
    publicGroupIdsByRef,
    queueIdsByRef,
    labels,
    warnings,
  };
};

export type ExistingUserMatchOptions = {
  defaultExternalIdField?: string;
  defaultFuzzyUsername?: boolean;
  fieldMap: Map<string, UserFieldMeta>;
};

export const getExistingUsers = async (
  conn: Connection,
  users: CanonicalizedUser[],
  options: ExistingUserMatchOptions
): Promise<{ existingByField: Map<string, Map<string, ExistingUser>>; duplicates: Set<string> }> => {
  const requests = users.flatMap((user) => {
    const field = user.matchField ?? options.defaultExternalIdField;
    const value = field ? user.fields[field] : undefined;
    return field && typeof value === 'string' && value.length > 0
      ? [{ field, value, fuzzy: field === 'Username' && (user.fuzzyUsername ?? options.defaultFuzzyUsername ?? false) }]
      : [];
  });
  const { existingByField, duplicates } = await resolveExistingUsers(conn, requests, options.fieldMap);
  return { existingByField, duplicates };
};

const ensureWritableFields = (
  target: JsonRecord,
  existing: ExistingUser | undefined,
  fieldMap: Map<string, UserFieldMeta>,
  errors: string[]
): void => {
  for (const field of Object.keys(target)) {
    if (field === 'Id') continue;
    const meta = fieldMap.get(field.toLowerCase());
    if (!meta) continue;
    if (existing ? !meta.updateable : !meta.createable) {
      errors.push(messages.getMessage('errorFieldNotWritable', [field, existing ? 'updateable' : 'createable']));
    }
  }
};

export const buildTarget = (user: CanonicalizedUser, refs: ResolvedRefs, errors: string[]): JsonRecord => {
  const persona = user.effectivePersona;
  const target: JsonRecord = { ...user.fields, IsActive: true };
  // Profile: user profileRef > user raw ProfileId (already in target) > persona profile
  if (user.profileRef) {
    const profileId = refs.profilesByRef.get(user.profileRef);
    if (!profileId) errors.push(messages.getMessage('errorReferenceRequiredMissing', ['Profile', user.profileRef]));
    else target.ProfileId = profileId;
  } else if (!target.ProfileId && persona.profile) {
    const profileId = refs.profilesByRef.get(persona.profile);
    if (!profileId) errors.push(messages.getMessage('errorReferenceRequiredMissing', ['Profile', persona.profile]));
    else target.ProfileId = profileId;
  }
  // Role: user roleRef > user raw UserRoleId (already in target) > persona role
  if (user.roleRef) {
    const roleId = refs.rolesByRef.get(user.roleRef);
    if (!roleId) errors.push(messages.getMessage('errorReferenceRequiredMissing', ['UserRole', user.roleRef]));
    else target.UserRoleId = roleId;
  } else if (!target.UserRoleId && persona.role) {
    const roleId = refs.rolesByRef.get(persona.role);
    if (!roleId) errors.push(messages.getMessage('errorReferenceRequiredMissing', ['UserRole', persona.role]));
    else target.UserRoleId = roleId;
  }
  return target;
};

const appendAssignmentActions = (actions: string[], dmlPlan: AssignmentDmlPlan): void => {
  const addActionIfAny = (values: unknown[], action: string): void => {
    if (values.length > 0) actions.push(action);
  };
  addActionIfAny(dmlPlan.permissionSets.adds, 'wouldAssignPermissionSet');
  addActionIfAny(dmlPlan.permissionSets.removes, 'wouldRemovePermissionSet');
  addActionIfAny(dmlPlan.permissionSetGroups.adds, 'wouldAssignPermissionSetGroup');
  addActionIfAny(dmlPlan.permissionSetGroups.removes, 'wouldRemovePermissionSetGroup');
  addActionIfAny(dmlPlan.publicGroups.adds, 'wouldAddPublicGroupMember');
  addActionIfAny(dmlPlan.publicGroups.removes, 'wouldRemovePublicGroupMember');
  addActionIfAny(dmlPlan.queues.adds, 'wouldAddQueueMember');
  addActionIfAny(dmlPlan.queues.removes, 'wouldRemoveQueueMember');
};

const performAssignmentDml = async (
  conn: Connection,
  userId: string,
  dmlPlan: AssignmentDmlPlan,
  actions: string[],
  errors: string[]
): Promise<void> => {
  const runDml = async (
    values: string[],
    action: string,
    op: () => Promise<SaveResult | SaveResult[]>
  ): Promise<void> => {
    if (values.length === 0) return;
    const saveResults = asArray(await op());
    if (saveResults.some((saveResult) => saveResult.success)) actions.push(action);
    pushErrors(errors, saveResults);
  };
  await runDml(dmlPlan.permissionSets.adds, 'assignedPermissionSet', () =>
    conn.sobject('PermissionSetAssignment').create(
      dmlPlan.permissionSets.adds.map((id) => ({ AssigneeId: userId, PermissionSetId: id })),
      { allOrNone: false }
    )
  );
  await runDml(dmlPlan.permissionSets.removes, 'removedPermissionSet', () =>
    conn.sobject('PermissionSetAssignment').delete(dmlPlan.permissionSets.removes, { allOrNone: false })
  );
  await runDml(dmlPlan.permissionSetGroups.adds, 'assignedPermissionSetGroup', () =>
    conn.sobject('PermissionSetAssignment').create(
      dmlPlan.permissionSetGroups.adds.map((id) => ({ AssigneeId: userId, PermissionSetGroupId: id })),
      { allOrNone: false }
    )
  );
  await runDml(dmlPlan.permissionSetGroups.removes, 'removedPermissionSetGroup', () =>
    conn.sobject('PermissionSetAssignment').delete(dmlPlan.permissionSetGroups.removes, { allOrNone: false })
  );
  await runDml(dmlPlan.publicGroups.adds, 'addedPublicGroupMember', () =>
    conn.sobject('GroupMember').create(
      dmlPlan.publicGroups.adds.map((groupId) => ({ GroupId: groupId, UserOrGroupId: userId })),
      { allOrNone: false }
    )
  );
  await runDml(dmlPlan.publicGroups.removes, 'removedPublicGroupMember', () =>
    conn.sobject('GroupMember').delete(dmlPlan.publicGroups.removes, { allOrNone: false })
  );
  await runDml(dmlPlan.queues.adds, 'addedQueueMember', () =>
    conn.sobject('GroupMember').create(
      dmlPlan.queues.adds.map((groupId) => ({ GroupId: groupId, UserOrGroupId: userId })),
      { allOrNone: false }
    )
  );
  await runDml(dmlPlan.queues.removes, 'removedQueueMember', () =>
    conn.sobject('GroupMember').delete(dmlPlan.queues.removes, { allOrNone: false })
  );
};

const applyAssignments = async (
  conn: Connection,
  userId: string,
  persona: PersonaDefinition,
  refs: ResolvedRefs,
  dryRun: boolean,
  actions: string[],
  errors: string[]
): Promise<void> => {
  if (!hasAssignmentIntent(persona, refs)) return;

  const state =
    userId === DRY_RUN_CREATE_ID
      ? undefined
      : await loadAssignmentState(conn, [userId], { permissionSetAssignments: true, groupMemberships: true });
  const assignmentRows = state?.psaByUserId.get(userId) ?? [];
  const membershipRows = state?.groupByUserId.get(userId) ?? [];
  const delta = computeAssignmentDeltaFromState(persona, refs, assignmentRows, membershipRows);
  const dmlPlan = toDmlPlan(delta, assignmentRows, membershipRows);

  if (dryRun) {
    appendAssignmentActions(actions, dmlPlan);
    return;
  }
  await performAssignmentDml(conn, userId, dmlPlan, actions, errors);
};

const summarize = (results: UserResult[], globalWarningCount: number): ProvisionResult['summary'] => ({
  total: results.length,
  created: results.filter((r) => r.status === 'created').length,
  updated: results.filter((r) => r.status === 'updated').length,
  failed: results.filter((r) => r.status === 'failed').length,
  warnings: globalWarningCount,
});

const executeBulkUserSaves = async (conn: Connection, plans: UserPlan[]): Promise<UserSaveOutcome[]> => {
  const validPlans = plans.filter((p) => p.errors.length === 0);
  const createPlans = validPlans.filter((p) => !p.existing);
  const updatePlans = validPlans.filter((p): p is UserPlan & { existing: ExistingUser } => Boolean(p.existing));
  const outcomes: UserSaveOutcome[] = [];

  if (createPlans.length > 0) {
    const createResults = asArray(
      await conn.sobject('User').create(
        createPlans.map((p) => p.target),
        { allOrNone: false }
      )
    );
    outcomes.push(
      ...createPlans.map((plan, idx) => ({
        plan,
        success: createResults[idx]?.success === true && Boolean(createResults[idx]?.id),
        id: createResults[idx]?.id,
        errors: (createResults[idx]?.errors ?? []).map((e) => formatSaveError(e)),
      }))
    );
  }

  if (updatePlans.length > 0) {
    const updateResults = asArray(
      await conn.sobject('User').update(
        updatePlans.map((p) => ({ ...p.target, Id: p.existing.Id })),
        { allOrNone: false }
      )
    );
    outcomes.push(
      ...updatePlans.map((plan, idx) => ({
        plan,
        success: updateResults[idx]?.success === true && Boolean(updateResults[idx]?.id),
        id: updateResults[idx]?.id ?? plan.existing.Id,
        errors: (updateResults[idx]?.errors ?? []).map((e) => formatSaveError(e)),
      }))
    );
  }

  return outcomes;
};

const applyInsertDefaults = (target: JsonRecord, myDomain: string | undefined): void => {
  if (!target.Username && myDomain) {
    const u = buildDefaultUsername(target.Email, myDomain);
    if (u) target.Username = u;
  }
  if (!target.Alias) {
    const a = buildDefaultAlias(target.FirstName, target.LastName);
    if (a) target.Alias = a;
  }
};

export type ProvisionUserRequest = {
  connection: Connection;
  usersDoc?: JsonRecord;
  personasDoc?: JsonRecord;
  usersPath?: string;
  personasPath?: string;
  inputFormat?: 'json' | 'csv';
  csvListDelimiter?: string;
  externalId?: string;
  fuzzyUsername?: boolean;
  dryRun: boolean;
  personasSupplied?: boolean;
  acknowledgeWarnings?: (warnings: string[]) => Promise<void>;
};

export class ProvisionUserUseCase {
  private readonly userProcessConcurrency = USER_PROCESS_CONCURRENCY;

  public async execute(request: ProvisionUserRequest): Promise<ProvisionResult> {
    const conn = request.connection;
    let fieldMap: Map<string, UserFieldMeta>;
    let definitions: ProvisionDefinitionDocuments;
    if (request.usersDoc) {
      definitions = await loadValidatedDefinitions(request, new Map(), provisionDefinitionMessages);
      fieldMap = await describeUserFields(conn);
    } else {
      fieldMap = await describeUserFields(conn);
      definitions = await loadValidatedDefinitions(request, fieldMap, provisionDefinitionMessages);
    }
    const { usersDoc, personasDoc } = definitions;
    const personasSupplied = request.personasSupplied ?? definitions.personasSupplied;
    const personas = personasDoc.personas as Record<string, PersonaDefinition>;
    validatePersonaModes(personas);
    validateExternalIdFieldForFlag(request.externalId, fieldMap);
    const users = validateAndCanonicalizeUsers(usersDoc.users, personas, fieldMap, personasSupplied);
    const myDomain = deriveMyDomain(conn.instanceUrl);
    const defaultExternalIdField = request.externalId
      ? fieldMap.get(request.externalId.toLowerCase())?.name
      : undefined;
    const matchFieldFor = (user: CanonicalizedUser): string | undefined => user.matchField ?? defaultExternalIdField;
    const userEntries = users.map((user, order) => ({ user, order }));
    const validationFailureUsers = userEntries.filter(
      ({ user }) => user.validationErrors && user.validationErrors.length > 0
    );
    const validUsers = userEntries.filter(({ user }) => !user.validationErrors || user.validationErrors.length === 0);

    const [refs, existingResolution] = await Promise.all([
      resolveReferences(
        conn,
        personas,
        validUsers.map(({ user }) => user)
      ),
      getExistingUsers(
        conn,
        validUsers.map(({ user }) => user),
        {
          defaultExternalIdField,
          defaultFuzzyUsername: request.fuzzyUsername,
          fieldMap,
        }
      ),
    ]);
    if (refs.warnings.length > 0) await request.acknowledgeWarnings?.(refs.warnings);

    const plans: UserPlan[] = validUsers.map(({ user, order }) => {
      const effectivePersona = user.effectivePersona;
      const errors: string[] = [];
      const target = buildTarget(user, refs, errors);
      const matchedBy = matchFieldFor(user) ?? null;
      const matchValue = matchedBy ? target[matchedBy] : undefined;
      const existing =
        matchedBy && typeof matchValue === 'string'
          ? existingResolution.existingByField.get(matchedBy)?.get(matchValue)
          : undefined;
      if (
        matchedBy &&
        typeof matchValue === 'string' &&
        existingResolution.duplicates.has(matchKey(matchedBy, matchValue))
      ) {
        errors.push(messages.getMessage('errorDuplicateExternalIdMatch', [matchedBy, matchValue]));
      }
      if (!existing) {
        applyInsertDefaults(target, myDomain);
        const profileIntended = Boolean(user.profileRef) || Boolean(effectivePersona.profile);
        const missing = missingRequiredFieldsForInsert(target, profileIntended);
        if (missing.length > 0) errors.push(messages.getMessage('errorMissingRequiredFields', [missing.join(', ')]));
      }
      ensureWritableFields(target, existing, fieldMap, errors);
      const actions = [
        existing ? (request.dryRun ? 'wouldUpdate' : 'updated') : request.dryRun ? 'wouldCreate' : 'created',
      ];
      if (!existing || existing.IsActive !== true) actions.push(request.dryRun ? 'wouldActivate' : 'activated');
      return {
        planId: `${order}:${user.inputKey}:${user.personas.join('+')}`,
        order,
        key: user.inputKey,
        personas: user.personas,
        effectivePersona,
        matchedBy,
        target,
        existing,
        actions,
        errors,
        source: user.source,
      };
    });
    const licenseUsage = request.dryRun ? await calculateUserLicenseUsage(conn, plans) : undefined;

    const validationResults: OrderedUserResult[] = validationFailureUsers.map(({ user, order }) => ({
      planId: `${order}:${user.inputKey}:${user.personas.join('+')}:validation`,
      order,
      key: user.inputKey,
      ...identityFromTarget(user.fields),
      personas: user.personas,
      matchedBy: user.matchField ?? null,
      status: 'failed',
      actions: [],
      errors: (user.validationErrors ?? []).map((error) => messages.getMessage(error.messageKey, error.messageArgs)),
      source: user.source,
    }));

    const processDryRunPlan = async (plan: UserPlan): Promise<OrderedUserResult> => {
      if (plan.errors.length > 0) {
        return {
          planId: plan.planId,
          order: plan.order,
          key: plan.key,
          ...identityFromTarget(plan.target, plan.existing),
          personas: plan.personas,
          matchedBy: plan.matchedBy,
          status: 'failed',
          actions: plan.actions,
          errors: plan.errors,
          source: plan.source,
        };
      }
      if (request.dryRun) {
        const dryRunId = plan.existing?.Id ?? DRY_RUN_CREATE_ID;
        if (plan.existing) {
          const frozenRows = (
            await conn.query<{ Id: string }>(
              `SELECT Id FROM UserLogin WHERE UserId = '${esc(plan.existing.Id)}' AND IsFrozen = true`
            )
          ).records;
          if (frozenRows.length > 0) plan.actions.push('wouldUnfreeze');
        }
        await applyAssignments(conn, dryRunId, plan.effectivePersona, refs, true, plan.actions, plan.errors);
        return {
          planId: plan.planId,
          order: plan.order,
          key: plan.key,
          ...identityFromTarget(plan.target, plan.existing),
          id: plan.existing?.Id,
          personas: plan.personas,
          matchedBy: plan.matchedBy,
          status: 'planned',
          actions: plan.actions,
          errors: plan.errors,
          source: plan.source,
        };
      }
      throw new SfError('internal: processDryRunPlan called for non-dry-run');
    };
    const processPostSave = async (outcome: UserSaveOutcome): Promise<OrderedUserResult> => {
      const { plan, id } = outcome;
      if (!id) {
        return {
          planId: plan.planId,
          order: plan.order,
          key: plan.key,
          ...identityFromTarget(plan.target, plan.existing),
          personas: plan.personas,
          matchedBy: plan.matchedBy,
          status: 'failed',
          actions: plan.actions,
          errors: [messages.getMessage('errorMissingSaveId')],
          source: plan.source,
        };
      }
      const frozenRows = (
        await conn.query<{ Id: string }>(`SELECT Id FROM UserLogin WHERE UserId = '${esc(id)}' AND IsFrozen = true`)
      ).records;
      if (frozenRows.length > 0) {
        const unfreezeResult = await conn.sobject('UserLogin').update(
          frozenRows.map((r) => ({ Id: r.Id, IsFrozen: false })),
          { allOrNone: false }
        );
        const unfreezeErrors: string[] = [];
        pushErrors(unfreezeErrors, unfreezeResult);
        if (unfreezeErrors.length > 0) plan.errors.push(...unfreezeErrors);
        else plan.actions.push('unfrozen');
      }
      await applyAssignments(conn, id, plan.effectivePersona, refs, false, plan.actions, plan.errors);
      const status = plan.errors.length > 0 ? 'failed' : plan.existing ? 'updated' : 'created';
      return {
        planId: plan.planId,
        order: plan.order,
        key: plan.key,
        ...identityFromTarget(plan.target, plan.existing),
        id,
        personas: plan.personas,
        matchedBy: plan.matchedBy,
        status,
        actions: plan.actions,
        errors: plan.errors,
        source: plan.source,
      };
    };

    const invalidResults: OrderedUserResult[] = plans
      .filter((p) => p.errors.length > 0)
      .map((p) => ({
        planId: p.planId,
        order: p.order,
        key: p.key,
        ...identityFromTarget(p.target, p.existing),
        personas: p.personas,
        matchedBy: p.matchedBy,
        status: 'failed',
        actions: p.actions,
        errors: p.errors,
        source: p.source,
      }));

    const resultsWithOrder: OrderedUserResult[] = request.dryRun
      ? validationResults.concat(await runBatches(plans, this.userProcessConcurrency, processDryRunPlan))
      : await (async (): Promise<OrderedUserResult[]> => {
          const outcomes = await executeBulkUserSaves(conn, plans);
          const saveFailures = outcomes
            .filter((o) => !o.success)
            .map((o) => {
              const errors = appendCrossReferenceCandidates(o.errors, o.plan.target);
              return {
                planId: o.plan.planId,
                order: o.plan.order,
                key: o.plan.key,
                ...identityFromTarget(o.plan.target, o.plan.existing),
                personas: o.plan.personas,
                matchedBy: o.plan.matchedBy,
                status: 'failed' as const,
                actions: o.plan.actions,
                errors,
                source: o.plan.source,
              };
            });
          const postSaveResults = await runBatches(
            outcomes.filter((o) => o.success),
            this.userProcessConcurrency,
            processPostSave
          );
          return validationResults.concat(invalidResults, saveFailures, postSaveResults);
        })();
    const results = resultsWithOrder
      .sort((a, b) => a.order - b.order)
      .map((result) => ({
        key: result.key,
        id: result.id,
        userName: result.userName,
        username: result.username,
        personas: result.personas,
        matchedBy: result.matchedBy ?? null,
        status: result.status,
        actions: result.actions,
        errors: addSourceContext(result.source, result.errors),
      }));
    const licenseWarningCount = licenseUsage?.filter((license) => license.shortfall > 0).length ?? 0;
    const result: ProvisionResult = {
      summary: summarize(results, refs.warnings.length + licenseWarningCount),
      users: results,
    };
    if (request.dryRun) {
      result.licenses = licenseUsage;
      result.permissionSetLicenses = { evaluated: false, note: 'not evaluated' };
    }
    return result;
  }
}
