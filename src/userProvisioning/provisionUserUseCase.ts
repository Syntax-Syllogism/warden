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
import { loadAssignmentState } from '../userLifecycle/assignmentState.js';
import {
  buildDefaultAlias,
  buildDefaultUsername,
  buildFieldMap,
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

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('@syntax-syllogism/warden', 'warden.provision');

type JsonRecord = Record<string, unknown>;
export type ExistingUser = { Id: string; IsActive?: boolean };

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
};

type UserSaveOutcome = {
  plan: UserPlan;
  success: boolean;
  id?: string;
  errors: string[];
};
type OrderedUserResult = UserResult & { order: number; planId: string };

type UserResult = {
  key: string;
  id?: string;
  personas: string[];
  matchedBy: string | null;
  status: 'created' | 'updated' | 'failed' | 'planned';
  actions: string[];
  errors: string[];
};

export type ProvisionResult = {
  summary: { total: number; created: number; updated: number; failed: number; warnings: number };
  users: UserResult[];
};

const DRY_RUN_CREATE_ID = 'dry-run-create';
const USER_PROCESS_CONCURRENCY = 10;

const appendCrossReferenceCandidates = (errors: string[], target: JsonRecord): string[] => {
  const hasCrossRefError = errors.some((e) => e.includes('INVALID_CROSS_REFERENCE_KEY'));
  if (!hasCrossRefError) return errors;
  const candidateFields = Object.entries(target)
    .filter(([field]) => field.endsWith('Id') && field !== 'Id')
    .map(([field, value]) => `${field}=${String(value)}`);
  if (candidateFields.length === 0) return errors;
  return errors.concat(messages.getMessage('errorCrossReferenceCandidates', [candidateFields.join(', ')]));
};

const matchKey = (field: string, value: string): string => `${field}:${value}`;

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

const resolveByIdOrName = async (
  conn: Connection,
  table: string,
  idOrNameRefs: Set<string>,
  nameField: string,
  whereClause: string | undefined,
  warnings: string[],
  idPrefixes?: string[]
): Promise<Map<string, string>> => {
  const resolved = new Map<string, string>();
  const ids = [...idOrNameRefs].filter((r) => isSalesforceId(r) && (!idPrefixes || idPrefixes.includes(r.slice(0, 3))));
  const names = [...idOrNameRefs].filter((r) => !isSalesforceId(r));
  if (ids.length > 0) {
    const where = [`Id IN (${soqlIn(ids)})`, whereClause].filter(Boolean).join(' AND ');
    const rows = (await conn.query<{ Id: string }>(`SELECT Id FROM ${table} WHERE ${where}`)).records;
    for (const row of rows) resolved.set(row.Id, row.Id);
  }
  if (names.length > 0) {
    const where = [`${nameField} IN (${soqlIn(names)})`, whereClause].filter(Boolean).join(' AND ');
    const rows = (
      await conn.query<{ Id: string } & Record<string, string>>(`SELECT Id, ${nameField} FROM ${table} WHERE ${where}`)
    ).records;
    for (const row of rows) resolved.set(row[nameField], row.Id);
  }
  for (const ref of idOrNameRefs)
    if (!resolved.has(ref)) warnings.push(messages.getMessage('warningReferenceMissing', [table, ref]));
  return resolved;
};

const resolveByRoleRef = async (
  conn: Connection,
  refs: Set<string>,
  warnings: string[]
): Promise<Map<string, string>> => {
  const resolved = new Map<string, string>();
  const ids = [...refs].filter((r) => isSalesforceId(r) && r.startsWith('00E'));
  const names = [...refs].filter((r) => !isSalesforceId(r));
  if (ids.length > 0) {
    const rows = (await conn.query<{ Id: string }>(`SELECT Id FROM UserRole WHERE Id IN (${soqlIn(ids)})`)).records;
    for (const row of rows) resolved.set(row.Id, row.Id);
  }
  if (names.length > 0) {
    const rows = (
      await conn.query<{ Id: string; DeveloperName: string; Name: string }>(
        `SELECT Id, DeveloperName, Name FROM UserRole WHERE DeveloperName IN (${soqlIn(names)}) OR Name IN (${soqlIn(
          names
        )})`
      )
    ).records;
    for (const row of rows) {
      if (names.includes(row.DeveloperName)) resolved.set(row.DeveloperName, row.Id);
      if (names.includes(row.Name)) resolved.set(row.Name, row.Id);
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
    resolveByIdOrName(conn, 'Profile', refs.profiles, 'Name', undefined, warnings, ['00e']),
    resolveByRoleRef(conn, refs.roles, warnings),
    resolveByIdOrName(conn, 'PermissionSet', refs.permissionSets, 'Name', undefined, warnings, ['0PS']),
    resolveByIdOrName(conn, 'PermissionSetGroup', refs.permissionSetGroups, 'DeveloperName', undefined, warnings, [
      '0PG',
    ]),
    resolveByIdOrName(conn, 'Group', refs.publicGroups, 'DeveloperName', "Type = 'Regular'", warnings, ['00G']),
    resolveByIdOrName(conn, 'Group', refs.queues, 'DeveloperName', "Type = 'Queue'", warnings, ['00G']),
  ]);
  return {
    profilesByRef,
    rolesByRef,
    permissionSetIdsByRef,
    permissionSetGroupIdsByRef,
    publicGroupIdsByRef,
    queueIdsByRef,
    warnings,
  };
};

export const getExistingUsers = async (
  conn: Connection,
  users: CanonicalizedUser[],
  defaultExternalIdField: string | undefined
): Promise<{ existingByField: Map<string, Map<string, ExistingUser>>; duplicates: Set<string> }> => {
  const existingByField = new Map<string, Map<string, ExistingUser>>();
  const duplicates = new Set<string>();
  const byField = new Map<string, CanonicalizedUser[]>();
  for (const user of users) {
    const field = user.matchField ?? defaultExternalIdField;
    if (!field) continue;
    const group = byField.get(field) ?? [];
    group.push(user);
    byField.set(field, group);
  }
  await Promise.all(
    [...byField.entries()].map(async ([field, group]) => {
      const values = [
        ...new Set(group.map((u) => u.fields[field]).filter((v): v is string => typeof v === 'string' && v.length > 0)),
      ];
      if (values.length === 0) return;
      const rows = (
        await conn.query<{ Id: string; IsActive: boolean } & Record<string, string>>(
          `SELECT Id, IsActive, ${field} FROM User WHERE ${field} IN (${soqlIn(values)})`
        )
      ).records;
      const fieldMap = existingByField.get(field) ?? new Map<string, ExistingUser>();
      for (const row of rows) {
        const key = row[field];
        if (fieldMap.has(key)) {
          duplicates.add(matchKey(field, key));
          continue;
        }
        fieldMap.set(key, { Id: row.Id, IsActive: row.IsActive });
      }
      existingByField.set(field, fieldMap);
    })
  );
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

const appendAssignmentActions = (
  actions: string[],
  dryRun: boolean,
  dmlPlan: AssignmentDmlPlan
): void => {
  const addActionIfAny = (values: unknown[], action: string): void => {
    if (values.length > 0) actions.push(action);
  };
  addActionIfAny(dmlPlan.permissionSets.adds, dryRun ? 'wouldAssignPermissionSet' : 'assignedPermissionSet');
  addActionIfAny(dmlPlan.permissionSets.removes, dryRun ? 'wouldRemovePermissionSet' : 'removedPermissionSet');
  addActionIfAny(
    dmlPlan.permissionSetGroups.adds,
    dryRun ? 'wouldAssignPermissionSetGroup' : 'assignedPermissionSetGroup'
  );
  addActionIfAny(
    dmlPlan.permissionSetGroups.removes,
    dryRun ? 'wouldRemovePermissionSetGroup' : 'removedPermissionSetGroup'
  );
  addActionIfAny(dmlPlan.publicGroups.adds, dryRun ? 'wouldAddPublicGroupMember' : 'addedPublicGroupMember');
  addActionIfAny(dmlPlan.publicGroups.removes, dryRun ? 'wouldRemovePublicGroupMember' : 'removedPublicGroupMember');
  addActionIfAny(dmlPlan.queues.adds, dryRun ? 'wouldAddQueueMember' : 'addedQueueMember');
  addActionIfAny(dmlPlan.queues.removes, dryRun ? 'wouldRemoveQueueMember' : 'removedQueueMember');
};

const performAssignmentDml = async (
  conn: Connection,
  userId: string,
  dmlPlan: AssignmentDmlPlan,
  errors: string[]
): Promise<void> => {
  const runDml = async (op: () => Promise<SaveResult | SaveResult[]>): Promise<void> => {
    pushErrors(errors, await op());
  };
  await runDml(() =>
    conn.sobject('PermissionSetAssignment').create(
      dmlPlan.permissionSets.adds.map((id) => ({ AssigneeId: userId, PermissionSetId: id })),
      { allOrNone: false }
    )
  );
  await runDml(() => conn.sobject('PermissionSetAssignment').delete(dmlPlan.permissionSets.removes, { allOrNone: false }));
  await runDml(() =>
    conn.sobject('PermissionSetAssignment').create(
      dmlPlan.permissionSetGroups.adds.map((id) => ({ AssigneeId: userId, PermissionSetGroupId: id })),
      { allOrNone: false }
    )
  );
  await runDml(() =>
    conn.sobject('PermissionSetAssignment').delete(dmlPlan.permissionSetGroups.removes, { allOrNone: false })
  );
  await runDml(() =>
    conn.sobject('GroupMember').create(
      dmlPlan.publicGroups.adds.map((groupId) => ({ GroupId: groupId, UserOrGroupId: userId })),
      { allOrNone: false }
    )
  );
  await runDml(() => conn.sobject('GroupMember').delete(dmlPlan.publicGroups.removes, { allOrNone: false }));
  await runDml(() =>
    conn.sobject('GroupMember').create(
      dmlPlan.queues.adds.map((groupId) => ({ GroupId: groupId, UserOrGroupId: userId })),
      { allOrNone: false }
    )
  );
  await runDml(() => conn.sobject('GroupMember').delete(dmlPlan.queues.removes, { allOrNone: false }));
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

  appendAssignmentActions(actions, dryRun, dmlPlan);
  if (dryRun) return;
  await performAssignmentDml(conn, userId, dmlPlan, errors);
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
  usersDoc: JsonRecord;
  personasDoc: JsonRecord;
  externalId?: string;
  dryRun: boolean;
  acknowledgeWarnings?: (warnings: string[]) => Promise<void>;
};

export class ProvisionUserUseCase {
  private readonly userProcessConcurrency = USER_PROCESS_CONCURRENCY;

  public async execute(request: ProvisionUserRequest): Promise<ProvisionResult> {
    const conn = request.connection;
    const { usersDoc, personasDoc } = request;
    if (!personasDoc.personas || typeof personasDoc.personas !== 'object' || Array.isArray(personasDoc.personas)) {
      throw new SfError(messages.getMessage('errorInvalidPersonaDefinition'));
    }

    const userDescribe = await conn.describe('User');
    const fieldMap = buildFieldMap(
      userDescribe.fields.map(
        (f): UserFieldMeta => ({
          name: f.name,
          createable: f.createable,
          updateable: f.updateable,
          externalId: f.externalId,
        })
      )
    );
    const personas = personasDoc.personas as Record<string, PersonaDefinition>;
    validatePersonaModes(personas);
    validateExternalIdFieldForFlag(request.externalId, fieldMap);
    const users = validateAndCanonicalizeUsers(usersDoc.users, personas, fieldMap);
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
        defaultExternalIdField
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
      };
    });

    const validationResults: OrderedUserResult[] = validationFailureUsers.map(({ user, order }) => ({
      planId: `${order}:${user.inputKey}:${user.personas.join('+')}:validation`,
      order,
      key: user.inputKey,
      personas: user.personas,
      matchedBy: user.matchField ?? null,
      status: 'failed',
      actions: [],
      errors: (user.validationErrors ?? []).map((error) => messages.getMessage(error.messageKey, error.messageArgs)),
    }));

    const processDryRunPlan = async (plan: UserPlan): Promise<OrderedUserResult> => {
      if (plan.errors.length > 0) {
        return {
          planId: plan.planId,
          order: plan.order,
          key: plan.key,
          personas: plan.personas,
          matchedBy: plan.matchedBy,
          status: 'failed',
          actions: plan.actions,
          errors: plan.errors,
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
          id: plan.existing?.Id,
          personas: plan.personas,
          matchedBy: plan.matchedBy,
          status: 'planned',
          actions: plan.actions,
          errors: plan.errors,
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
          personas: plan.personas,
          matchedBy: plan.matchedBy,
          status: 'failed',
          actions: plan.actions,
          errors: [messages.getMessage('errorMissingSaveId')],
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
        id,
        personas: plan.personas,
        matchedBy: plan.matchedBy,
        status,
        actions: plan.actions,
        errors: plan.errors,
      };
    };

    const invalidResults: OrderedUserResult[] = plans
      .filter((p) => p.errors.length > 0)
      .map((p) => ({
        planId: p.planId,
        order: p.order,
        key: p.key,
        personas: p.personas,
        matchedBy: p.matchedBy,
        status: 'failed',
        actions: p.actions,
        errors: p.errors,
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
                personas: o.plan.personas,
                matchedBy: o.plan.matchedBy,
                status: 'failed' as const,
                actions: o.plan.actions,
                errors,
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
        personas: result.personas,
        matchedBy: result.matchedBy ?? null,
        status: result.status,
        actions: result.actions,
        errors: result.errors,
      }));
    return { summary: summarize(results, refs.warnings.length), users: results };
  }
}
