import { Messages, SfError, type Connection } from '@salesforce/core';
import { Flags } from '@salesforce/sf-plugins-core';
import { describeUserFields } from '../../userShared/userFields.js';
import { loadAssignmentState, type AssignmentState } from '../../userLifecycle/assignmentState.js';
import { runAssignmentCreates, runRecordUpdate } from '../../userLifecycle/dmlRunner.js';
import { makeNotice, renderLifecycleResult, summarizeLifecycle } from '../../userLifecycle/output.js';
import { readSnapshotFile, type UserSnapshotEntry } from '../../userLifecycle/snapshotState.js';
import { resolveTargetField, resolveTargets } from '../../userLifecycle/targeting.js';
import type {
  LabelBundle,
  IdentityReview,
  LifecycleResult,
  LifecycleUserResult,
  ResolvedTargetUser,
  TargetRequest,
} from '../../userLifecycle/types.js';
import { soqlIn } from '../../userShared/sfUtils.js';
import { confirmWithTimeout } from '../../userShared/prompt.js';
import { apiVersionFlag, dryRunFlag, noPromptFlag, targetOrgFlag } from '../../userShared/targetFlags.js';
import { renderRestoreCsv } from '../../userShared/output.js';
import { outputFlags } from '../../userShared/outputFlags.js';
import { WardenCommand } from '../../wardenCommand.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('@syntax-syllogism/warden', 'warden.restore');

type AssignmentPlan = {
  userId: string;
  result: LifecycleUserResult;
  userUpdate?: { Id: string; IsActive: true };
  loginUpdates: Array<{ Id: string; IsFrozen: false }>;
  permissionSetAdds: string[];
  permissionSetGroupAdds: string[];
  publicGroupAdds: string[];
  queueAdds: string[];
  licenseAdds: string[];
  permissionSetItems: LabelBundle[];
  permissionSetGroupItems: LabelBundle[];
  publicGroupItems: LabelBundle[];
  queueItems: LabelBundle[];
  licenseItems: LabelBundle[];
};

type RefResolution = {
  resolved: Map<string, string>;
  missing: Set<string>;
};

type RestoreRefs = {
  permissionSets: RefResolution;
  permissionSetGroups: RefResolution;
  publicGroups: RefResolution;
  queues: RefResolution;
  licenses: RefResolution;
};

const resolveRefs = async (
  conn: Connection,
  table: string,
  refs: string[],
  nameField: string,
  whereClause: string | undefined
): Promise<RefResolution> => {
  const uniqueRefs = [...new Set(refs)];
  const resolved = new Map<string, string>();
  if (uniqueRefs.length === 0) return { resolved, missing: new Set<string>() };
  const where = [`${nameField} IN (${soqlIn(uniqueRefs)})`, whereClause].filter(Boolean).join(' AND ');
  const rows = (
    await conn.query<{ Id: string } & Record<string, string>>(`SELECT Id, ${nameField} FROM ${table} WHERE ${where}`)
  ).records;
  for (const row of rows) resolved.set(row[nameField], row.Id);
  return { resolved, missing: new Set(uniqueRefs.filter((ref) => !resolved.has(ref))) };
};

const collectRefs = (snapshotUsers: UserSnapshotEntry[]): Record<keyof RestoreRefs, string[]> => ({
  permissionSets: snapshotUsers.flatMap((user) => user.permissionSets),
  permissionSetGroups: snapshotUsers.flatMap((user) => user.permissionSetGroups),
  publicGroups: snapshotUsers.flatMap((user) => user.publicGroups),
  queues: snapshotUsers.flatMap((user) => user.queues),
  licenses: snapshotUsers.flatMap((user) => user.permissionSetLicenses),
});

const resolveRestoreRefs = async (conn: Connection, snapshotUsers: UserSnapshotEntry[]): Promise<RestoreRefs> => {
  const refs = collectRefs(snapshotUsers);
  const [permissionSets, permissionSetGroups, publicGroups, queues, licenses] = await Promise.all([
    resolveRefs(conn, 'PermissionSet', refs.permissionSets, 'Name', undefined),
    resolveRefs(conn, 'PermissionSetGroup', refs.permissionSetGroups, 'DeveloperName', undefined),
    resolveRefs(conn, 'Group', refs.publicGroups, 'DeveloperName', "Type = 'Regular'"),
    resolveRefs(conn, 'Group', refs.queues, 'DeveloperName', "Type = 'Queue'"),
    resolveRefs(conn, 'PermissionSetLicense', refs.licenses, 'DeveloperName', undefined),
  ]);
  return { permissionSets, permissionSetGroups, publicGroups, queues, licenses };
};

const warnMissingRefs = (
  result: LifecycleUserResult,
  table: string,
  refs: string[],
  resolution: RefResolution
): void => {
  for (const ref of refs) {
    if (resolution.missing.has(ref)) result.warnings.push(messages.getMessage('warningReferenceMissing', [table, ref]));
  }
};

const resolvedIds = (refs: string[], resolution: RefResolution): string[] =>
  refs.map((ref) => resolution.resolved.get(ref)).filter((id): id is string => Boolean(id));

const missing = (targets: string[], current: Array<string | undefined | null>): string[] => {
  const currentIds = new Set(current.filter((value): value is string => Boolean(value)));
  return targets.filter((id) => !currentIds.has(id));
};

const addCountAction = (
  result: LifecycleUserResult,
  key: string,
  count: number,
  dryRun: boolean,
  items: LabelBundle[]
): void => {
  if (count === 0) return;
  if (dryRun) {
    result.status = 'planned';
    result.actions.push(makeNotice(key, count, items));
  }
};

const addActivationActions = (
  result: LifecycleUserResult,
  userUpdate: AssignmentPlan['userUpdate'],
  loginUpdates: AssignmentPlan['loginUpdates'],
  dryRun: boolean
): void => {
  if (!dryRun) return;
  if (userUpdate) {
    result.status = 'planned';
    result.actions.push(makeNotice('wouldActivate'));
  }
  if (loginUpdates.length > 0) {
    result.status = 'planned';
    result.actions.push(makeNotice('wouldUnfreeze'));
  }
};

const addAssignmentActions = (
  result: LifecycleUserResult,
  plans: Pick<
    AssignmentPlan,
    | 'permissionSetAdds'
    | 'permissionSetGroupAdds'
    | 'publicGroupAdds'
    | 'queueAdds'
    | 'licenseAdds'
    | 'permissionSetItems'
    | 'permissionSetGroupItems'
    | 'publicGroupItems'
    | 'queueItems'
    | 'licenseItems'
  >,
  dryRun: boolean
): void => {
  addCountAction(
    result,
    dryRun ? 'wouldAssignPermissionSet' : 'assignedPermissionSet',
    plans.permissionSetAdds.length,
    dryRun,
    plans.permissionSetItems
  );
  addCountAction(
    result,
    dryRun ? 'wouldAssignPermissionSetGroup' : 'assignedPermissionSetGroup',
    plans.permissionSetGroupAdds.length,
    dryRun,
    plans.permissionSetGroupItems
  );
  addCountAction(
    result,
    dryRun ? 'wouldAddPublicGroupMember' : 'addedPublicGroupMember',
    plans.publicGroupAdds.length,
    dryRun,
    plans.publicGroupItems
  );
  addCountAction(
    result,
    dryRun ? 'wouldAddQueueMember' : 'addedQueueMember',
    plans.queueAdds.length,
    dryRun,
    plans.queueItems
  );
  addCountAction(
    result,
    dryRun ? 'wouldAssignPermissionSetLicense' : 'assignedPermissionSetLicense',
    plans.licenseAdds.length,
    dryRun,
    plans.licenseItems
  );
};

const identityReview = (snapshotUser: UserSnapshotEntry, target: ResolvedTargetUser): IdentityReview | undefined => {
  const snapshot = {
    name: snapshotUser.name,
    username: snapshotUser.username,
    email: snapshotUser.email,
    profile: snapshotUser.profile,
    role: snapshotUser.role,
  };
  if (!Object.values(snapshot).some((value) => value !== undefined)) return undefined;
  return {
    snapshot,
    org: {
      name: target.name,
      username: target.username,
      email: target.email,
      profile: target.profile,
      role: target.role,
      userId: target.Id,
    },
    match: { field: target.field, value: target.value },
  };
};

const identityMismatches = (review: IdentityReview): string[] => {
  const fields = ['name', 'username', 'email', 'profile', 'role'] as const;
  return fields.flatMap((field) => {
    const expected = review.snapshot[field];
    const actual = review.org[field];
    return expected !== undefined && expected !== actual
      ? [`Snapshot ${field} "${expected}" differs from org "${actual ?? '(missing)'}".`]
      : [];
  });
};

const applyPlan = async (conn: Connection, plan: AssignmentPlan): Promise<void> => {
  const result = plan.result;
  if (plan.userUpdate) {
    await runRecordUpdate({ conn, result, sobject: 'User', rows: [plan.userUpdate], actionKey: 'activated' });
  }
  await runRecordUpdate({ conn, result, sobject: 'UserLogin', rows: plan.loginUpdates, actionKey: 'unfrozen' });
  await runAssignmentCreates({
    conn,
    result,
    sobject: 'PermissionSetAssignment',
    rows: plan.permissionSetAdds.map((id) => ({ AssigneeId: plan.userId, PermissionSetId: id })),
    actionKey: 'assignedPermissionSet',
    items: plan.permissionSetItems,
  });
  await runAssignmentCreates({
    conn,
    result,
    sobject: 'PermissionSetAssignment',
    rows: plan.permissionSetGroupAdds.map((id) => ({ AssigneeId: plan.userId, PermissionSetGroupId: id })),
    actionKey: 'assignedPermissionSetGroup',
    items: plan.permissionSetGroupItems,
  });
  await runAssignmentCreates({
    conn,
    result,
    sobject: 'GroupMember',
    rows: plan.publicGroupAdds.map((groupId) => ({ GroupId: groupId, UserOrGroupId: plan.userId })),
    actionKey: 'addedPublicGroupMember',
    items: plan.publicGroupItems,
  });
  await runAssignmentCreates({
    conn,
    result,
    sobject: 'GroupMember',
    rows: plan.queueAdds.map((groupId) => ({ GroupId: groupId, UserOrGroupId: plan.userId })),
    actionKey: 'addedQueueMember',
    items: plan.queueItems,
  });
  await runAssignmentCreates({
    conn,
    result,
    sobject: 'PermissionSetLicenseAssign',
    rows: plan.licenseAdds.map((id) => ({ AssigneeId: plan.userId, PermissionSetLicenseId: id })),
    actionKey: 'assignedPermissionSetLicense',
    items: plan.licenseItems,
  });
  if (result.errors.length > 0) result.status = 'failed';
};

const buildPlan = (
  state: AssignmentState,
  refs: RestoreRefs,
  snapshotUser: UserSnapshotEntry,
  target: ResolvedTargetUser,
  dryRun: boolean
): AssignmentPlan => {
  const result: LifecycleUserResult = {
    key: target.key,
    id: target.Id,
    name: target.name,
    username: target.username,
    isActive: target.IsActive,
    isFrozen: state.userLoginByUserId.get(target.Id)?.[0]?.IsFrozen,
    status: 'unchanged',
    actions: [],
    skipped: [],
    warnings: [],
    errors: [],
  };
  const review = identityReview(snapshotUser, target);
  if (review) {
    result.identityReview = review;
    result.warnings.push(...identityMismatches(review));
  }
  const psaRows = state.psaByUserId.get(target.Id) ?? [];
  const groupRows = state.groupByUserId.get(target.Id) ?? [];
  const pslRows = state.pslByUserId.get(target.Id) ?? [];
  warnMissingRefs(result, 'PermissionSet', snapshotUser.permissionSets, refs.permissionSets);
  warnMissingRefs(result, 'PermissionSetGroup', snapshotUser.permissionSetGroups, refs.permissionSetGroups);
  warnMissingRefs(result, 'Group', snapshotUser.publicGroups, refs.publicGroups);
  warnMissingRefs(result, 'Group', snapshotUser.queues, refs.queues);
  warnMissingRefs(result, 'PermissionSetLicense', snapshotUser.permissionSetLicenses, refs.licenses);

  const permissionSetAdds = missing(
    resolvedIds(snapshotUser.permissionSets, refs.permissionSets),
    psaRows.map((row) => row.PermissionSetId)
  );
  const permissionSetGroupAdds = missing(
    resolvedIds(snapshotUser.permissionSetGroups, refs.permissionSetGroups),
    psaRows.map((row) => row.PermissionSetGroupId)
  );
  const publicGroupAdds = missing(
    resolvedIds(snapshotUser.publicGroups, refs.publicGroups),
    groupRows.filter((row) => row.Group?.Type === 'Regular').map((row) => row.GroupId)
  );
  const queueAdds = missing(
    resolvedIds(snapshotUser.queues, refs.queues),
    groupRows.filter((row) => row.Group?.Type === 'Queue').map((row) => row.GroupId)
  );
  const licenseAdds = missing(
    resolvedIds(snapshotUser.permissionSetLicenses, refs.licenses),
    pslRows.map((row) => row.PermissionSetLicenseId)
  );
  const itemsFor = (names: string[], resolution: RefResolution, type: LabelBundle['type']): LabelBundle[] =>
    names.flatMap((name) => {
      const id = resolution.resolved.get(name);
      return id ? [{ id, apiName: name, type }] : [];
    });
  const permissionSetItems = itemsFor(snapshotUser.permissionSets, refs.permissionSets, 'PermissionSet').filter(
    (item) => permissionSetAdds.includes(item.id)
  );
  const permissionSetGroupItems = itemsFor(
    snapshotUser.permissionSetGroups,
    refs.permissionSetGroups,
    'PermissionSetGroup'
  ).filter((item) => permissionSetGroupAdds.includes(item.id));
  const publicGroupItems = itemsFor(snapshotUser.publicGroups, refs.publicGroups, 'PublicGroup').filter((item) =>
    publicGroupAdds.includes(item.id)
  );
  const queueItems = itemsFor(snapshotUser.queues, refs.queues, 'Queue').filter((item) => queueAdds.includes(item.id));
  const licenseItems = itemsFor(snapshotUser.permissionSetLicenses, refs.licenses, 'PermissionSetLicense').filter(
    (item) => licenseAdds.includes(item.id)
  );
  const loginUpdates = (state.userLoginByUserId.get(target.Id) ?? [])
    .filter((row) => row.IsFrozen)
    .map((row) => ({ Id: row.Id, IsFrozen: false as const }));
  const userUpdate = target.IsActive ? undefined : { Id: target.Id, IsActive: true as const };

  addActivationActions(result, userUpdate, loginUpdates, dryRun);
  addAssignmentActions(
    result,
    {
      permissionSetAdds,
      permissionSetGroupAdds,
      publicGroupAdds,
      queueAdds,
      licenseAdds,
      permissionSetItems,
      permissionSetGroupItems,
      publicGroupItems,
      queueItems,
      licenseItems,
    },
    dryRun
  );

  return {
    userId: target.Id,
    result,
    userUpdate,
    loginUpdates,
    permissionSetAdds,
    permissionSetGroupAdds,
    publicGroupAdds,
    queueAdds,
    licenseAdds,
    permissionSetItems,
    permissionSetGroupItems,
    publicGroupItems,
    queueItems,
    licenseItems,
  };
};

const hasPendingDml = (plan: AssignmentPlan): boolean =>
  Boolean(plan.userUpdate) ||
  plan.loginUpdates.length > 0 ||
  plan.permissionSetAdds.length > 0 ||
  plan.permissionSetGroupAdds.length > 0 ||
  plan.publicGroupAdds.length > 0 ||
  plan.queueAdds.length > 0 ||
  plan.licenseAdds.length > 0;

export default class UserRestore extends WardenCommand<LifecycleResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public static readonly flags = {
    'target-org': targetOrgFlag,
    snapshot: Flags.file({ exists: true, required: true, summary: messages.getMessage('flags.snapshot.summary') }),
    ...outputFlags,
    'no-prompt': noPromptFlag,
    'dry-run': dryRunFlag,
    'api-version': apiVersionFlag,
  };

  public async run(): Promise<LifecycleResult> {
    const { flags } = await this.parse(UserRestore);
    const context = this.resolveOutputContext(flags);
    const conn = flags['target-org'].getConnection(flags['api-version'] ?? undefined);
    let snapshot;
    try {
      snapshot = await readSnapshotFile(String(flags.snapshot));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new SfError(messages.getMessage('errorInvalidJson', [String(flags.snapshot), detail]));
    }
    const fieldMap = await describeUserFields(conn);
    const requests: TargetRequest[] = [];
    const users: LifecycleUserResult[] = [];
    snapshot.users.forEach((user, order) => {
      const matchField = resolveTargetField(user.match, fieldMap);
      if (!matchField) {
        users.push({
          key: `${user.match}:${user.matchValue}`,
          status: 'failed',
          actions: [],
          skipped: [],
          warnings: [],
          errors: [messages.getMessage('errorInvalidUserMatchField', [user.match])],
        });
      } else {
        requests.push({ key: `${matchField}:${user.matchValue}`, field: matchField, value: user.matchValue, order });
      }
    });
    const { targets, errors } = await resolveTargets(conn, requests, fieldMap);
    users.push(
      ...errors.map((error) => ({
        key: error.key,
        status: 'failed' as const,
        actions: [],
        skipped: [],
        warnings: [],
        errors: [error.message],
      }))
    );
    const [state, refs] = await Promise.all([
      loadAssignmentState(
        conn,
        targets.map((target) => target.Id)
      ),
      resolveRestoreRefs(conn, snapshot.users),
    ]);
    const plans = targets.map((target) =>
      buildPlan(state, refs, snapshot.users[target.order], target, Boolean(flags['dry-run']))
    );
    users.push(...plans.map((plan) => plan.result));

    if (!flags['dry-run'] && plans.some(hasPendingDml) && !flags['no-prompt'] && context.interactive) {
      const { confirmed, timedOut } = await confirmWithTimeout(
        (message) => this.confirm({ message }),
        messages.getMessage('promptContinue')
      );
      if (!confirmed) {
        if (timedOut) this.warn(messages.getMessage('warningPromptTimeout'));
        throw new SfError(messages.getMessage('errorPromptDeclined'));
      }
    }
    if (!flags['dry-run']) {
      await plans.reduce<Promise<void>>((chain, plan) => chain.then(() => applyPlan(conn, plan)), Promise.resolve());
    }
    const output = { summary: summarizeLifecycle(users), users };
    const csv = renderRestoreCsv(output);
    await this.emitResult(context, {
      result: output,
      csv,
      human: renderLifecycleResult(output, messages.getMessage.bind(messages)),
    });
    if (output.summary.failed > 0) process.exitCode = 1;
    return output;
  }
}
