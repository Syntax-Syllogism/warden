import { Messages, SfError, type Connection } from '@salesforce/core';
import { Flags } from '@salesforce/sf-plugins-core';
import { type UserFieldMeta } from '../../userProvisioning/planner.js';
import {
  failedResult,
  makeNotice,
  renderLifecycleResult,
  resolvedTargetResult,
  summarizeLifecycle,
} from '../../userLifecycle/output.js';
import { buildTargetRequests, resolveTargets, type TargetSelectionFlags } from '../../userLifecycle/targeting.js';
import type {
  LabelBundle,
  LifecycleResult,
  LifecycleUserResult,
  ResolvedTargetUser,
  TargetError,
} from '../../userLifecycle/types.js';
import {
  loadAssignmentState,
  type GroupMemberRow,
  type PermissionSetAssignmentRow,
  type PermissionSetLicenseAssignRow,
  type UserLoginRow,
} from '../../userLifecycle/assignmentState.js';
import { buildSnapshotFile, writeSnapshotFile } from '../../userLifecycle/snapshotState.js';
import { asArray, pushErrors } from '../../userShared/sfUtils.js';
import { confirmWithTimeout } from '../../userShared/prompt.js';
import { renderStripCsv } from '../../userShared/output.js';
import { describeUserFields } from '../../userShared/userFields.js';
import { outputFlags } from '../../userShared/outputFlags.js';
import { WardenCommand } from './base.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('@syntax-syllogism/warden', 'warden.strip');

type StripFlags = TargetSelectionFlags<string> & Record<string, unknown>;

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
      items: LabelBundle[];
    }
  | {
      kind: 'update';
      sobject: 'User';
      row: { Id: string; IsActive: boolean };
      actionKey: 'deactivated';
    };

type StripTargetState = {
  target: ResolvedTargetUser;
  result: LifecycleUserResult;
  steps: StripStep[];
  hasDml: boolean;
};

const isFlagSet = (flags: StripFlags, key: string): boolean => flags[key] === true;

const getOrgProvenance = (flags: StripFlags): string | undefined => {
  const targetOrg = flags['target-org'] as { getUsername?: () => string } | undefined;
  return targetOrg?.getUsername?.();
};

const addAction = (
  result: LifecycleUserResult,
  key: string,
  count?: number,
  dryRun = false,
  items?: LabelBundle[]
): void => {
  result.status = dryRun ? 'planned' : 'changed';
  result.actions.push(makeNotice(key, count, items));
};

const addSkipped = (result: LifecycleUserResult, key: string, count?: number, items?: LabelBundle[]): void => {
  if (count && count > 0) result.skipped.push(makeNotice(key, count, items));
};

const permissionSetItem = (row: PermissionSetAssignmentRow): LabelBundle =>
  row.PermissionSetGroupId
    ? {
        id: row.PermissionSetGroupId,
        apiName: row.PermissionSetGroup?.DeveloperName,
        label: row.PermissionSetGroup?.MasterLabel,
        type: 'PermissionSetGroup',
      }
    : {
        id: row.PermissionSetId ?? '',
        apiName: row.PermissionSet?.Name,
        label: row.PermissionSet?.Label,
        type: 'PermissionSet',
      };

const groupItem = (row: GroupMemberRow): LabelBundle => ({
  id: row.GroupId,
  apiName: row.Group?.DeveloperName,
  label: row.Group?.Name,
  type: row.Group?.Type === 'Queue' ? 'Queue' : 'PublicGroup',
});

const licenseItem = (row: PermissionSetLicenseAssignRow): LabelBundle => ({
  id: row.PermissionSetLicenseId,
  apiName: row.PermissionSetLicense?.DeveloperName,
  label: row.PermissionSetLicense?.MasterLabel,
  type: 'PermissionSetLicense',
});

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
    addSkipped(result, skipKey, selectedRows.length, selectedRows.map(permissionSetItem));
    return [];
  }
  if (selectedRows.length === 0) return [];
  if (isFlagSet(flags, 'dry-run')) {
    addAction(result, dryRunKey, selectedRows.length, true, selectedRows.map(permissionSetItem));
    return [];
  }
  return [
    {
      kind: 'delete',
      sobject: 'PermissionSetAssignment',
      ids: selectedRows.map((row) => row.Id),
      actionKey,
      items: selectedRows.map(permissionSetItem),
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
    addSkipped(result, skipKey, selectedRows.length, selectedRows.map(groupItem));
    return [];
  }
  if (selectedRows.length === 0) return [];
  if (isFlagSet(flags, 'dry-run')) {
    addAction(result, dryRunKey, selectedRows.length, true, selectedRows.map(groupItem));
    return [];
  }
  return [
    {
      kind: 'delete',
      sobject: 'GroupMember',
      ids: selectedRows.map((row) => row.Id),
      actionKey,
      items: selectedRows.map(groupItem),
    },
  ];
};

const planLicenseState = (
  result: LifecycleUserResult,
  rows: PermissionSetLicenseAssignRow[],
  flags: StripFlags
): StripStep[] => {
  if (isFlagSet(flags, 'keep-licenses')) {
    addSkipped(result, 'skippedPermissionSetLicenses', rows.length, rows.map(licenseItem));
    return [];
  }
  if (rows.length === 0) return [];
  if (isFlagSet(flags, 'dry-run')) {
    addAction(result, 'wouldRemovePermissionSetLicense', rows.length, true, rows.map(licenseItem));
    return [];
  }
  return [
    {
      kind: 'delete',
      sobject: 'PermissionSetLicenseAssign',
      ids: rows.map((row) => row.Id),
      actionKey: 'removedPermissionSetLicense',
      items: rows.map(licenseItem),
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
  target: ResolvedTargetUser,
  loginRows: UserLoginRow[],
  psaRows: PermissionSetAssignmentRow[],
  groupRows: GroupMemberRow[],
  pslRows: PermissionSetLicenseAssignRow[],
  flags: StripFlags
): StripTargetState => {
  const result = resolvedTargetResult(target, loginRows[0]);
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

const markSuccess = (result: LifecycleUserResult, actionKey: string, count?: number, items?: LabelBundle[]): void => {
  if (result.status !== 'failed') result.status = 'changed';
  result.actions.push(makeNotice(actionKey, count, items));
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
  actionKey: string,
  items: LabelBundle[]
): Promise<void> => {
  if (ids.length === 0) return;
  const saveResults = asArray(await conn.sobject(sobject).delete(ids, { allOrNone: false }));
  const successfulItems = items.filter((_, index) => saveResults[index]?.success);
  if (successfulItems.length > 0) markSuccess(result, actionKey, successfulItems.length, successfulItems);
  if (successfulItems.length < ids.length) {
    result.status = 'failed';
    pushErrors(result.errors, saveResults);
  }
};

const runStripStep = async (conn: Connection, result: LifecycleUserResult, step: StripStep): Promise<void> => {
  if (step.kind === 'update') {
    await runUpdate(conn, result, step.sobject, step.row, step.actionKey);
    return;
  }
  await runDelete(conn, result, step.sobject, step.ids, step.actionKey, step.items);
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
  const { requests, errors: requestErrors } = await buildTargetRequests(flags, fieldMap, {
    invalidUserMatchField: (field) => messages.getMessage('errorInvalidUserMatchField', [field]),
    invalidJson: (path, error) => messages.getMessage('errorInvalidJson', [path, error]),
  });
  const { targets, errors: resolutionErrors } = await resolveTargets(conn, requests, fieldMap);
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

  return { summary: summarizeLifecycle(results), users: results };
};

export default class UserStrip extends WardenCommand<LifecycleResult> {
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
    'input-format': Flags.string({
      options: ['json', 'csv'] as const,
      summary: messages.getMessage('flags.input-format.summary'),
    }),
    'csv-list-delimiter': Flags.string({ summary: messages.getMessage('flags.csv-list-delimiter.summary') }),
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
    ...outputFlags,
    'api-version': Flags.orgApiVersion({ summary: messages.getMessage('flags.api-version.summary') }),
  };

  public async run(): Promise<LifecycleResult> {
    const { flags } = await this.parse(UserStrip);
    const context = this.resolveOutputContext(flags);
    const conn = flags['target-org'].getConnection(flags['api-version'] ?? undefined);
    const fieldMap = await describeUserFields(conn);
    const output = await executeStrip(
      conn,
      fieldMap,
      flags as StripFlags,
      !context.interactive,
      (message) => this.confirm({ message }),
      (message) => this.warn(message)
    );
    const csv = renderStripCsv(output);
    await this.emitResult(context, {
      result: output,
      csv,
      human: renderLifecycleResult(output, messages.getMessage.bind(messages)),
    });
    if (output.summary.failed > 0) process.exitCode = 1;
    return output;
  }
}
