import { Messages, SfError, type Connection } from '@salesforce/core';
import { Flags, SfCommand } from '@salesforce/sf-plugins-core';
import { buildFieldMap, type UserFieldMeta } from '../../userProvisioning/planner.js';
import { renderLifecycleResult } from '../../userLifecycle/output.js';
import {
  extractDefTargets,
  parseUserFlag,
  resolveTargetField,
  resolveTargets,
} from '../../userLifecycle/targeting.js';
import type {
  LifecycleNotice,
  LifecycleResult,
  LifecycleUserResult,
  TargetError,
  TargetRequest,
} from '../../userLifecycle/types.js';
import {
  loadAssignmentState,
  type GroupMemberRow,
  type PermissionSetAssignmentRow,
  type PermissionSetLicenseAssignRow,
  type UserLoginRow,
} from '../../userLifecycle/assignmentState.js';
import { buildSnapshotFile, writeSnapshotFile } from '../../userLifecycle/snapshotState.js';
import { asArray, pushErrors, readJsonOrThrow } from '../../userShared/sfUtils.js';
import { confirmWithTimeout } from '../../userShared/prompt.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('@syntax-syllogism/warden', 'warden.strip');

type StripFlags = Record<string, unknown>;

type StripStep =
  | {
      kind: 'update';
      sobject: 'UserLogin';
      row: { Id: string; IsFrozen: boolean };
      actionKey: 'frozen';
    }
  | {
      kind: 'delete';
      sobject: 'PermissionSetAssignment' | 'GroupMember' | 'PermissionSetLicenseAssign';
      ids: string[];
      actionKey:
        | 'removedPermissionSet'
        | 'removedPermissionSetGroup'
        | 'removedPublicGroupMember'
        | 'removedQueueMember'
        | 'removedPermissionSetLicense';
    }
  | {
      kind: 'update';
      sobject: 'User';
      row: { Id: string; IsActive: boolean };
      actionKey: 'deactivated';
    };

type StripTargetState = {
  target: { key: string; Id: string; IsActive: boolean };
  result: LifecycleUserResult;
  steps: StripStep[];
  hasDml: boolean;
};

const makeNotice = (key: string, count?: number): LifecycleNotice => (count === undefined ? { key } : { key, count });

const summarize = (users: LifecycleUserResult[]): LifecycleResult['summary'] => ({
  total: users.length,
  changed: users.filter((user) => user.status === 'changed' || user.status === 'planned').length,
  unchanged: users.filter((user) => user.status === 'unchanged').length,
  failed: users.filter((user) => user.status === 'failed').length,
});

const failedResult = (error: TargetError): LifecycleUserResult => ({
  key: error.key,
  status: 'failed',
  actions: [],
  skipped: [],
  warnings: [],
  errors: [error.message],
});

const targetResult = (target: { key: string; Id: string; IsActive: boolean }): LifecycleUserResult => ({
  key: target.key,
  id: target.Id,
  status: 'unchanged',
  actions: [],
  skipped: [],
  warnings: [],
  errors: [],
});

const isFlagSet = (flags: StripFlags, key: string): boolean => flags[key] === true;

const getOrgProvenance = (flags: StripFlags): string | undefined => {
  const targetOrg = flags['target-org'] as { getUsername?: () => string } | undefined;
  return targetOrg?.getUsername?.();
};

const addAction = (result: LifecycleUserResult, key: string, count?: number, dryRun = false): void => {
  result.status = dryRun ? 'planned' : 'changed';
  result.actions.push(makeNotice(key, count));
};

const addSkipped = (result: LifecycleUserResult, key: string, count?: number): void => {
  if (count && count > 0) result.skipped.push(makeNotice(key, count));
};

const countSuccesses = (results: Array<{ success: boolean }>): number =>
  results.filter((result) => result.success).length;

const buildRequests = async (
  flags: StripFlags,
  fieldMap: Map<string, UserFieldMeta>
): Promise<{ requests: TargetRequest[]; errors: TargetError[] }> => {
  if (typeof flags.user === 'string' && flags.user.length > 0) {
    const { field, value } = parseUserFlag(flags.user);
    const matchField = resolveTargetField(field, fieldMap);
    if (!matchField) throw new SfError(messages.getMessage('errorInvalidUserMatchField', [field]));
    return { requests: [{ key: `${matchField}:${value}`, field: matchField, value, order: 0 }], errors: [] };
  }

  const usersDoc = (await readJsonOrThrow(String(flags['users-def']), (path, error) =>
    messages.getMessage('errorInvalidJson', [path, error])
  )) as { users?: unknown };
  return extractDefTargets(
    usersDoc,
    typeof flags['external-id'] === 'string' ? flags['external-id'] : undefined,
    fieldMap
  );
};

const planFreezeState = (
  result: LifecycleUserResult,
  loginRow: UserLoginRow | undefined,
  flags: StripFlags
): StripStep[] => {
  if (isFlagSet(flags, 'no-freeze')) {
    result.skipped.push(makeNotice('skippedFreeze'));
    return [];
  }
  if (!loginRow) {
    result.warnings.push(messages.getMessage('warningMissingUserLogin'));
    return [];
  }
  if (loginRow.IsFrozen) {
    result.actions.push(makeNotice('alreadyFrozen'));
    return [];
  }
  if (isFlagSet(flags, 'dry-run')) {
    addAction(result, 'wouldFreeze', undefined, true);
    return [];
  }
  return [{ kind: 'update', sobject: 'UserLogin', row: { Id: loginRow.Id, IsFrozen: true }, actionKey: 'frozen' }];
};

const planPermissionSetState = (
  result: LifecycleUserResult,
  rows: PermissionSetAssignmentRow[],
  flags: StripFlags,
  skipFlag: 'keep-permsets' | 'keep-permset-groups',
  skipKey: 'skippedPermissionSets' | 'skippedPermissionSetGroups',
  dryRunKey: 'wouldRemovePermissionSet' | 'wouldRemovePermissionSetGroup',
  actionKey: 'removedPermissionSet' | 'removedPermissionSetGroup'
): StripStep[] => {
  const selectedRows = rows;
  if (isFlagSet(flags, skipFlag)) {
    addSkipped(result, skipKey, selectedRows.length);
    return [];
  }
  if (selectedRows.length === 0) return [];
  if (isFlagSet(flags, 'dry-run')) {
    addAction(result, dryRunKey, selectedRows.length, true);
    return [];
  }
  return [
    {
      kind: 'delete',
      sobject: 'PermissionSetAssignment',
      ids: selectedRows.map((row) => row.Id),
      actionKey,
    },
  ];
};

const planGroupState = (
  result: LifecycleUserResult,
  rows: GroupMemberRow[],
  flags: StripFlags,
  skipFlag: 'keep-public-groups' | 'keep-queues',
  skipKey: 'skippedPublicGroups' | 'skippedQueues',
  dryRunKey: 'wouldRemovePublicGroupMember' | 'wouldRemoveQueueMember',
  actionKey: 'removedPublicGroupMember' | 'removedQueueMember'
): StripStep[] => {
  const selectedRows = rows;
  if (isFlagSet(flags, skipFlag)) {
    addSkipped(result, skipKey, selectedRows.length);
    return [];
  }
  if (selectedRows.length === 0) return [];
  if (isFlagSet(flags, 'dry-run')) {
    addAction(result, dryRunKey, selectedRows.length, true);
    return [];
  }
  return [
    {
      kind: 'delete',
      sobject: 'GroupMember',
      ids: selectedRows.map((row) => row.Id),
      actionKey,
    },
  ];
};

const planLicenseState = (
  result: LifecycleUserResult,
  rows: PermissionSetLicenseAssignRow[],
  flags: StripFlags
): StripStep[] => {
  if (isFlagSet(flags, 'keep-licenses')) {
    addSkipped(result, 'skippedPermissionSetLicenses', rows.length);
    return [];
  }
  if (rows.length === 0) return [];
  if (isFlagSet(flags, 'dry-run')) {
    addAction(result, 'wouldRemovePermissionSetLicense', rows.length, true);
    return [];
  }
  return [
    {
      kind: 'delete',
      sobject: 'PermissionSetLicenseAssign',
      ids: rows.map((row) => row.Id),
      actionKey: 'removedPermissionSetLicense',
    },
  ];
};

const planDeactivateState = (
  result: LifecycleUserResult,
  target: { Id: string; IsActive: boolean },
  flags: StripFlags
): StripStep[] => {
  if (isFlagSet(flags, 'no-deactivate')) {
    result.skipped.push(makeNotice('skippedDeactivate'));
    return [];
  }
  if (!target.IsActive) {
    result.actions.push(makeNotice('alreadyInactive'));
    return [];
  }
  if (isFlagSet(flags, 'dry-run')) {
    addAction(result, 'wouldDeactivate', undefined, true);
    return [];
  }
  return [{ kind: 'update', sobject: 'User', row: { Id: target.Id, IsActive: false }, actionKey: 'deactivated' }];
};

const buildTargetState = (
  target: { key: string; Id: string; IsActive: boolean },
  loginRows: UserLoginRow[],
  psaRows: PermissionSetAssignmentRow[],
  groupRows: GroupMemberRow[],
  pslRows: PermissionSetLicenseAssignRow[],
  flags: StripFlags
): StripTargetState => {
  const result = targetResult(target);
  const loginRow = loginRows[0];
  const permSetRows = psaRows.filter(
    (row) => row.PermissionSetGroupId == null && row.PermissionSet?.IsOwnedByProfile !== true
  );
  const profileOwnedRows = psaRows.filter(
    (row) => row.PermissionSetGroupId == null && row.PermissionSet?.IsOwnedByProfile === true
  );
  const permSetGroupRows = psaRows.filter((row) => row.PermissionSetGroupId != null);
  const publicGroupRows = groupRows.filter((row) => row.Group?.Type === 'Regular');
  const queueRows = groupRows.filter((row) => row.Group?.Type === 'Queue');
  const licenseRows = pslRows;

  if (profileOwnedRows.length > 0) {
    result.skipped.push(makeNotice('skippedProfileOwnedPermissionSets', profileOwnedRows.length));
  }

  const steps = [
    ...planFreezeState(result, loginRow, flags),
    ...planPermissionSetState(
      result,
      permSetRows,
      flags,
      'keep-permsets',
      'skippedPermissionSets',
      'wouldRemovePermissionSet',
      'removedPermissionSet'
    ),
    ...planPermissionSetState(
      result,
      permSetGroupRows,
      flags,
      'keep-permset-groups',
      'skippedPermissionSetGroups',
      'wouldRemovePermissionSetGroup',
      'removedPermissionSetGroup'
    ),
    ...planGroupState(
      result,
      publicGroupRows,
      flags,
      'keep-public-groups',
      'skippedPublicGroups',
      'wouldRemovePublicGroupMember',
      'removedPublicGroupMember'
    ),
    ...planGroupState(
      result,
      queueRows,
      flags,
      'keep-queues',
      'skippedQueues',
      'wouldRemoveQueueMember',
      'removedQueueMember'
    ),
    ...planLicenseState(result, licenseRows, flags),
    ...planDeactivateState(result, target, flags),
  ];

  return { target, result, steps, hasDml: steps.length > 0 };
};

const markSuccess = (result: LifecycleUserResult, actionKey: string, count?: number): void => {
  if (result.status !== 'failed') result.status = 'changed';
  result.actions.push(makeNotice(actionKey, count));
};

const runUpdate = async (
  conn: Connection,
  result: LifecycleUserResult,
  sobject: 'UserLogin' | 'User',
  row: { Id: string } & Record<string, unknown>,
  actionKey: string
): Promise<void> => {
  const saveResults = asArray(await conn.sobject(sobject).update([row], { allOrNone: false }));
  const saveResult = saveResults[0];
  if (saveResult?.success) {
    markSuccess(result, actionKey);
    return;
  }
  result.status = 'failed';
  pushErrors(result.errors, saveResult);
};

const runDelete = async (
  conn: Connection,
  result: LifecycleUserResult,
  sobject: 'PermissionSetAssignment' | 'GroupMember' | 'PermissionSetLicenseAssign',
  ids: string[],
  actionKey: string
): Promise<void> => {
  if (ids.length === 0) return;
  const saveResults = asArray(await conn.sobject(sobject).delete(ids, { allOrNone: false }));
  const successes = countSuccesses(saveResults);
  if (successes > 0) markSuccess(result, actionKey, successes);
  if (successes < ids.length) {
    result.status = 'failed';
    pushErrors(result.errors, saveResults);
  }
};

const runStripStep = async (conn: Connection, result: LifecycleUserResult, step: StripStep): Promise<void> => {
  if (step.kind === 'update') {
    await runUpdate(conn, result, step.sobject, step.row, step.actionKey);
    return;
  }
  await runDelete(conn, result, step.sobject, step.ids, step.actionKey);
};

const applyStripState = async (conn: Connection, state: StripTargetState): Promise<void> =>
  state.steps.reduce<Promise<void>>(
    (chain, step) => chain.then(() => runStripStep(conn, state.result, step)),
    Promise.resolve()
  );

const buildStripResult = (
  initialErrors: TargetError[],
  states: StripTargetState[]
): { results: LifecycleUserResult[]; states: StripTargetState[] } => {
  const results = [...initialErrors.map(failedResult), ...states.map((state) => state.result)];
  return { results, states };
};

const executeStrip = async (
  conn: Connection,
  fieldMap: Map<string, UserFieldMeta>,
  flags: StripFlags,
  isJsonEnabled: boolean,
  confirm: (message: string) => Promise<boolean>,
  warn: (message: string) => void
): Promise<LifecycleResult> => {
  const { requests, errors: requestErrors } = await buildRequests(flags, fieldMap);
  const { targets, errors: resolutionErrors } = await resolveTargets(conn, requests);
  const initialErrors = [...requestErrors, ...resolutionErrors];

  const stateMaps = await loadAssignmentState(
    conn,
    targets.map((target) => target.Id)
  );
  const states = targets.map((target) =>
    buildTargetState(
      target,
      stateMaps.userLoginByUserId.get(target.Id) ?? [],
      stateMaps.psaByUserId.get(target.Id) ?? [],
      stateMaps.groupByUserId.get(target.Id) ?? [],
      stateMaps.pslByUserId.get(target.Id) ?? [],
      flags
    )
  );
  const { results } = buildStripResult(initialErrors, states);

  const hasDml = states.some((state) => state.hasDml);
  if (!isFlagSet(flags, 'dry-run') && hasDml && !isFlagSet(flags, 'no-prompt') && !isJsonEnabled) {
    const { confirmed, timedOut } = await confirmWithTimeout(confirm, messages.getMessage('promptContinue'));
    if (!confirmed) {
      if (timedOut) warn(messages.getMessage('warningPromptTimeout'));
      throw new SfError(messages.getMessage('errorPromptDeclined'));
    }
  }

  if (typeof flags.snapshot === 'string' && flags.snapshot.length > 0) {
    const snapshot = await buildSnapshotFile(conn, targets, stateMaps, getOrgProvenance(flags));
    await writeSnapshotFile(flags.snapshot, snapshot);
    for (const state of states) state.result.actions.push(makeNotice('snapshotWritten'));
  }

  if (!isFlagSet(flags, 'dry-run')) {
    await states.reduce<Promise<void>>(
      (chain, state) => chain.then(() => applyStripState(conn, state)),
      Promise.resolve()
    );
  }

  return { summary: summarize(results), users: results };
};

export default class UserStrip extends SfCommand<LifecycleResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public static readonly flags = {
    'target-org': Flags.requiredOrg({ summary: messages.getMessage('flags.target-org.summary') }),
    user: Flags.string({ exactlyOne: ['user', 'users-def'], summary: messages.getMessage('flags.user.summary') }),
    'users-def': Flags.file({
      exists: true,
      exactlyOne: ['user', 'users-def'],
      summary: messages.getMessage('flags.users-def.summary'),
    }),
    'external-id': Flags.string({ summary: messages.getMessage('flags.external-id.summary') }),
    'no-prompt': Flags.boolean({ default: false, summary: messages.getMessage('flags.no-prompt.summary') }),
    'dry-run': Flags.boolean({ default: false, summary: messages.getMessage('flags.dry-run.summary') }),
    'no-freeze': Flags.boolean({ default: false, summary: messages.getMessage('flags.no-freeze.summary') }),
    'no-deactivate': Flags.boolean({ default: false, summary: messages.getMessage('flags.no-deactivate.summary') }),
    'keep-permsets': Flags.boolean({ default: false, summary: messages.getMessage('flags.keep-permsets.summary') }),
    'keep-permset-groups': Flags.boolean({
      default: false,
      summary: messages.getMessage('flags.keep-permset-groups.summary'),
    }),
    'keep-licenses': Flags.boolean({ default: false, summary: messages.getMessage('flags.keep-licenses.summary') }),
    'keep-public-groups': Flags.boolean({
      default: false,
      summary: messages.getMessage('flags.keep-public-groups.summary'),
    }),
    'keep-queues': Flags.boolean({ default: false, summary: messages.getMessage('flags.keep-queues.summary') }),
    snapshot: Flags.file({ summary: messages.getMessage('flags.snapshot.summary') }),
    'api-version': Flags.orgApiVersion({ summary: messages.getMessage('flags.api-version.summary') }),
  };

  public async run(): Promise<LifecycleResult> {
    const { flags } = await this.parse(UserStrip);
    const conn = flags['target-org'].getConnection(flags['api-version'] ?? undefined);
    const userDescribe = await conn.describe('User');
    const fieldMap = buildFieldMap(
      userDescribe.fields.map(
        (field): UserFieldMeta => ({
          name: field.name,
          createable: field.createable,
          updateable: field.updateable,
          externalId: field.externalId,
        })
      )
    );
    const output = await executeStrip(
      conn,
      fieldMap,
      flags as StripFlags,
      this.jsonEnabled(),
      (message) => this.confirm({ message }),
      (message) => this.warn(message)
    );
    if (!this.jsonEnabled()) this.log(renderLifecycleResult(output, messages.getMessage.bind(messages)));
    return output;
  }
}
