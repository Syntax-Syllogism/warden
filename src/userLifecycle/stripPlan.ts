import { SfError, type Connection } from '@salesforce/core';
import type { UserFieldMeta } from '../userProvisioning/planner.js';
import { confirmWithTimeout } from '../userShared/prompt.js';
import {
  groupMemberLabel,
  type GroupMemberRow,
  loadAssignmentState,
  permissionSetAssignmentLabel,
  type PermissionSetAssignmentRow,
  permissionSetLicenseLabel,
  type PermissionSetLicenseAssignRow,
  type UserLoginRow,
} from './assignmentState.js';
import { failedResult, makeNotice, resolvedTargetResult, summarizeLifecycle } from './output.js';
import { buildSnapshotFile, writeSnapshotFile } from './snapshotState.js';
import { applyStripState } from './stripApply.js';
import { buildTargetRequests, resolveTargets, type TargetSelectionFlags } from './targeting.js';
import type { LabelBundle, LifecycleResult, LifecycleUserResult, ResolvedTargetUser, TargetError } from './types.js';

export type StripFlags = TargetSelectionFlags<string> & Record<string, unknown>;

export type StripStep =
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

export type StripTargetState = {
  target: ResolvedTargetUser;
  result: LifecycleUserResult;
  steps: StripStep[];
  hasDml: boolean;
};

export type TargetAssignmentRows = {
  psa: PermissionSetAssignmentRow[];
  group: GroupMemberRow[];
  psl: PermissionSetLicenseAssignRow[];
};

type StripCategoryRow = { Id: string };
type DeleteStripStep = Extract<StripStep, { kind: 'delete' }>;

type StripCategory<Row extends StripCategoryRow> = {
  select: (state: TargetAssignmentRows) => Row[];
  sobject: DeleteStripStep['sobject'];
  skipFlag: string;
  skipKey: string;
  dryRunKey: string;
  actionKey: DeleteStripStep['actionKey'];
  toItem: (row: Row) => LabelBundle | undefined;
  rowId: (row: Row) => string;
};

type ErasedStripCategory = StripCategory<StripCategoryRow>;

// The definition is checked against its concrete row type before it is used by
// the uniform planner. `select` always supplies the matching row type.
const defineCategory = <Row extends StripCategoryRow>(category: StripCategory<Row>): ErasedStripCategory =>
  category as unknown as ErasedStripCategory;

const isFlagSet = (flags: StripFlags, key: string): boolean => flags[key] === true;

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

export const STRIP_CATEGORIES = [
  defineCategory({
    select: (state) =>
      state.psa.filter((row) => row.PermissionSetGroupId == null && row.PermissionSet?.IsOwnedByProfile !== true),
    sobject: 'PermissionSetAssignment',
    skipFlag: 'keep-permsets',
    skipKey: 'skippedPermissionSets',
    dryRunKey: 'wouldRemovePermissionSet',
    actionKey: 'removedPermissionSet',
    toItem: permissionSetAssignmentLabel,
    rowId: (row) => row.Id,
  }),
  defineCategory({
    select: (state) => state.psa.filter((row) => row.PermissionSetGroupId != null),
    sobject: 'PermissionSetAssignment',
    skipFlag: 'keep-permset-groups',
    skipKey: 'skippedPermissionSetGroups',
    dryRunKey: 'wouldRemovePermissionSetGroup',
    actionKey: 'removedPermissionSetGroup',
    toItem: permissionSetAssignmentLabel,
    rowId: (row) => row.Id,
  }),
  defineCategory({
    select: (state) => state.group.filter((row) => row.Group?.Type === 'Regular'),
    sobject: 'GroupMember',
    skipFlag: 'keep-public-groups',
    skipKey: 'skippedPublicGroups',
    dryRunKey: 'wouldRemovePublicGroupMember',
    actionKey: 'removedPublicGroupMember',
    toItem: groupMemberLabel,
    rowId: (row) => row.Id,
  }),
  defineCategory({
    select: (state) => state.group.filter((row) => row.Group?.Type === 'Queue'),
    sobject: 'GroupMember',
    skipFlag: 'keep-queues',
    skipKey: 'skippedQueues',
    dryRunKey: 'wouldRemoveQueueMember',
    actionKey: 'removedQueueMember',
    toItem: groupMemberLabel,
    rowId: (row) => row.Id,
  }),
  defineCategory({
    select: (state) => state.psl,
    sobject: 'PermissionSetLicenseAssign',
    skipFlag: 'keep-licenses',
    skipKey: 'skippedPermissionSetLicenses',
    dryRunKey: 'wouldRemovePermissionSetLicense',
    actionKey: 'removedPermissionSetLicense',
    toItem: permissionSetLicenseLabel,
    rowId: (row) => row.Id,
  }),
] as const;

const planFreezeState = (
  result: LifecycleUserResult,
  loginRow: UserLoginRow | undefined,
  flags: StripFlags,
  message: (key: string) => string
): StripStep[] => {
  if (isFlagSet(flags, 'no-freeze')) {
    result.skipped.push(makeNotice('skippedFreeze'));
    return [];
  }
  if (!loginRow) {
    result.warnings.push(message('warningMissingUserLogin'));
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

const planCategory = <Row extends StripCategoryRow>(
  result: LifecycleUserResult,
  rows: Row[],
  category: StripCategory<Row>,
  flags: StripFlags
): StripStep[] => {
  const mappedRows = rows.flatMap((row) => {
    const item = category.toItem(row);
    return item ? [{ row, item }] : [];
  });

  if (isFlagSet(flags, category.skipFlag)) {
    addSkipped(
      result,
      category.skipKey,
      mappedRows.length,
      mappedRows.map(({ item }) => item)
    );
    return [];
  }
  if (mappedRows.length === 0) return [];
  if (isFlagSet(flags, 'dry-run')) {
    addAction(
      result,
      category.dryRunKey,
      mappedRows.length,
      true,
      mappedRows.map(({ item }) => item)
    );
    return [];
  }
  return [
    {
      kind: 'delete',
      sobject: category.sobject,
      ids: mappedRows.map(({ row }) => category.rowId(row)),
      actionKey: category.actionKey,
      items: mappedRows.map(({ item }) => item),
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

export const buildTargetState = (options: {
  target: ResolvedTargetUser;
  loginRows: UserLoginRow[];
  rows: TargetAssignmentRows;
  flags: StripFlags;
  message: (key: string) => string;
}): StripTargetState => {
  const { target, loginRows, rows, flags, message } = options;
  const result = resolvedTargetResult(target, loginRows[0]);
  const profileOwnedRows = rows.psa.filter(
    (row) => row.PermissionSetGroupId == null && row.PermissionSet?.IsOwnedByProfile === true
  );

  if (profileOwnedRows.length > 0) {
    result.skipped.push(makeNotice('skippedProfileOwnedPermissionSets', profileOwnedRows.length));
  }

  const steps = [
    ...planFreezeState(result, loginRows[0], flags, message),
    ...STRIP_CATEGORIES.flatMap((category) => planCategory(result, category.select(rows), category, flags)),
    ...planDeactivateState(result, target, flags),
  ];

  return { target, result, steps, hasDml: steps.length > 0 };
};

const buildStripResult = (
  initialErrors: TargetError[],
  states: StripTargetState[]
): { results: LifecycleUserResult[]; states: StripTargetState[] } => {
  const results = [...initialErrors.map(failedResult), ...states.map((state) => state.result)];
  return { results, states };
};

export const executeStrip = async (options: {
  conn: Connection;
  fieldMap: Map<string, UserFieldMeta>;
  flags: StripFlags;
  interactive: boolean;
  message: (key: string, args?: string[]) => string;
  confirm: (message: string) => Promise<boolean>;
  warn: (message: string) => void;
}): Promise<LifecycleResult> => {
  const { conn, fieldMap, flags, interactive, message, confirm, warn } = options;
  const { requests, errors: requestErrors } = await buildTargetRequests(flags, fieldMap, {
    invalidUserMatchField: (field) => message('errorInvalidUserMatchField', [field]),
    invalidJson: (path, error) => message('errorInvalidJson', [path, error]),
  });
  const { targets, errors: resolutionErrors } = await resolveTargets(conn, requests, fieldMap);
  const initialErrors = [...requestErrors, ...resolutionErrors];
  const stateMaps = await loadAssignmentState(
    conn,
    targets.map((target) => target.Id)
  );
  const states = targets.map((target) =>
    buildTargetState({
      target,
      loginRows: stateMaps.userLoginByUserId.get(target.Id) ?? [],
      rows: {
        psa: stateMaps.psaByUserId.get(target.Id) ?? [],
        group: stateMaps.groupByUserId.get(target.Id) ?? [],
        psl: stateMaps.pslByUserId.get(target.Id) ?? [],
      },
      flags,
      message,
    })
  );
  const { results } = buildStripResult(initialErrors, states);

  const hasDml = states.some((state) => state.hasDml);
  if (!isFlagSet(flags, 'dry-run') && hasDml && !isFlagSet(flags, 'no-prompt') && interactive) {
    const { confirmed, timedOut } = await confirmWithTimeout(confirm, message('promptContinue'));
    if (!confirmed) {
      if (timedOut) warn(message('warningPromptTimeout'));
      throw new SfError(message('errorPromptDeclined'));
    }
  }

  if (typeof flags.snapshot === 'string' && flags.snapshot.length > 0) {
    const targetOrg = flags['target-org'] as { getUsername?: () => string } | undefined;
    const snapshot = await buildSnapshotFile(conn, targets, stateMaps, targetOrg?.getUsername?.());
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
