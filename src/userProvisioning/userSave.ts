import { Connection } from '@salesforce/core';
import { loadAssignmentState } from '../userLifecycle/assignmentState.js';
import { toDryRunResults, toUnappliedResults } from '../userRelatedRecords/apply.js';
import { asArray, esc, formatSaveError, pushErrors, type SaveResult } from '../userShared/sfUtils.js';
import {
  computeAssignmentDeltaFromState,
  hasAssignmentIntent,
  toDmlPlan,
  type AssignmentDmlPlan,
  type ResolvedRefs,
} from './assignmentPlan.js';
import type { PersonaDefinition } from './planner.js';
import { toUserResult, type OrderedUserResult, type UserPlan } from './userPlan.js';

const DRY_RUN_CREATE_ID = 'dry-run-create';

export type UserSaveOutcome = {
  plan: UserPlan;
  success: boolean;
  id?: string;
  errors: string[];
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

export const executeBulkUserSaves = async (conn: Connection, plans: UserPlan[]): Promise<UserSaveOutcome[]> => {
  const validPlans = plans.filter((plan) => plan.errors.length === 0);
  const createPlans = validPlans.filter((plan) => !plan.existing);
  const updatePlans = validPlans.filter((plan): plan is UserPlan & { existing: NonNullable<UserPlan['existing']> } =>
    Boolean(plan.existing)
  );
  const outcomes: UserSaveOutcome[] = [];

  if (createPlans.length > 0) {
    const createResults = asArray(
      await conn.sobject('User').create(
        createPlans.map((plan) => plan.target),
        { allOrNone: false }
      )
    );
    outcomes.push(
      ...createPlans.map((plan, idx) => ({
        plan,
        success: createResults[idx]?.success === true && Boolean(createResults[idx]?.id),
        id: createResults[idx]?.id,
        errors: (createResults[idx]?.errors ?? []).map((error) => formatSaveError(error)),
      }))
    );
  }

  if (updatePlans.length > 0) {
    const updateResults = asArray(
      await conn.sobject('User').update(
        updatePlans.map((plan) => ({ ...plan.target, Id: plan.existing.Id })),
        { allOrNone: false }
      )
    );
    outcomes.push(
      ...updatePlans.map((plan, idx) => ({
        plan,
        success: updateResults[idx]?.success === true && Boolean(updateResults[idx]?.id),
        id: updateResults[idx]?.id ?? plan.existing.Id,
        errors: (updateResults[idx]?.errors ?? []).map((error) => formatSaveError(error)),
      }))
    );
  }

  return outcomes;
};

/** Report a user's related plans as unattempted — the run never reached the related DML stage. */
export const markRelatedUnapplied = (plan: UserPlan): UserPlan => {
  if (plan.relatedPlans) plan.relatedResults = toUnappliedResults(plan.relatedPlans);
  return plan;
};

export const queryFrozenLoginIds = async (conn: Connection, userId: string): Promise<string[]> =>
  (
    await conn.query<{ Id: string }>(`SELECT Id FROM UserLogin WHERE UserId = '${esc(userId)}' AND IsFrozen = true`)
  ).records.map((row) => row.Id);

export const planDryRunResult = async (options: {
  conn: Connection;
  plan: UserPlan;
  refs: ResolvedRefs;
}): Promise<OrderedUserResult> => {
  const { conn, plan, refs } = options;
  if (plan.relatedPlans) plan.relatedResults = toDryRunResults(plan.relatedPlans);
  if (plan.errors.length > 0) return toUserResult(plan, 'failed', { includeExistingId: false });
  const dryRunId = plan.existing?.Id ?? DRY_RUN_CREATE_ID;
  if (plan.existing && (await queryFrozenLoginIds(conn, plan.existing.Id)).length > 0)
    plan.actions.push('wouldUnfreeze');
  await applyAssignments(conn, dryRunId, plan.effectivePersona, refs, true, plan.actions, plan.errors);
  return toUserResult(plan, 'planned');
};

export const applySavedPlan = async (options: {
  conn: Connection;
  outcome: UserSaveOutcome;
  refs: ResolvedRefs;
  message: (key: string, args?: string[]) => string;
}): Promise<OrderedUserResult> => {
  const { conn, outcome, refs, message } = options;
  const { plan, id } = outcome;
  if (!id) return toUserResult(plan, 'failed', { includeExistingId: false, errors: [message('errorMissingSaveId')] });
  const frozenIds = await queryFrozenLoginIds(conn, id);
  if (frozenIds.length > 0) {
    const unfreezeResult = await conn.sobject('UserLogin').update(
      frozenIds.map((loginId) => ({ Id: loginId, IsFrozen: false })),
      { allOrNone: false }
    );
    const unfreezeErrors: string[] = [];
    pushErrors(unfreezeErrors, unfreezeResult);
    if (unfreezeErrors.length > 0) plan.errors.push(...unfreezeErrors);
    else plan.actions.push('unfrozen');
  }
  await applyAssignments(conn, id, plan.effectivePersona, refs, false, plan.actions, plan.errors);
  const status = plan.errors.length > 0 ? 'failed' : plan.existing ? 'updated' : 'created';
  return toUserResult(plan, status, { id });
};
