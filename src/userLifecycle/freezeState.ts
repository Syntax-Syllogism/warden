import { SfError, type Connection } from '@salesforce/core';
import type { UserFieldMeta } from '../userProvisioning/planner.js';
import { asArray, esc, pushErrors } from '../userShared/sfUtils.js';
import { confirmWithTimeout } from '../userShared/prompt.js';
import type { UserLoginRow } from './assignmentState.js';
import { failedResult, makeNotice, resolvedTargetResult, summarizeLifecycle } from './output.js';
import { resolveTargets } from './targeting.js';
import type { LifecycleResult, LifecycleUserResult, TargetError, TargetRequest } from './types.js';

export type FreezeDirection = {
  /** Value written to UserLogin.IsFrozen. */
  targetState: boolean;
  /** True when the user is already in targetState and no DML is needed. */
  isAlreadyInState: (row: UserLoginRow) => boolean;
  alreadyKey: string;
  wouldKey: string;
  actionKey: string;
};

export const FREEZE: FreezeDirection = {
  targetState: true,
  isAlreadyInState: (row) => row.IsFrozen,
  alreadyKey: 'alreadyFrozen',
  wouldKey: 'wouldFreeze',
  actionKey: 'frozen',
};

export const UNFREEZE: FreezeDirection = {
  targetState: false,
  isAlreadyInState: (row) => !row.IsFrozen,
  alreadyKey: 'alreadyUnfrozen',
  wouldKey: 'wouldUnfreeze',
  actionKey: 'unfrozen',
};

type PendingUpdate = {
  resultIndex: number;
  row: { Id: string; IsFrozen: boolean };
  actionKey: string;
};

export const executeFreezeToggle = async (options: {
  conn: Connection;
  fieldMap: Map<string, UserFieldMeta>;
  requests: TargetRequest[];
  requestErrors: TargetError[];
  direction: FreezeDirection;
  dryRun: boolean;
  noPrompt: boolean;
  interactive: boolean;
  message: (key: string, args?: string[]) => string;
  confirm: (message: string) => Promise<boolean>;
  warn: (message: string) => void;
}): Promise<LifecycleResult> => {
  const { conn, fieldMap, requests, requestErrors, direction, dryRun, noPrompt, interactive, message, confirm, warn } =
    options;
  const { targets, errors: resolutionErrors } = await resolveTargets(conn, requests, fieldMap);

  const results: LifecycleUserResult[] = [];
  for (const error of requestErrors.concat(resolutionErrors)) results.push(failedResult(error));

  const loginRows =
    targets.length > 0
      ? (
          await conn.query<UserLoginRow>(
            `SELECT Id, UserId, IsFrozen FROM UserLogin WHERE UserId IN (${targets
              .map((target) => `'${esc(target.Id)}'`)
              .join(',')})`
          )
        ).records
      : [];
  const loginRowsByUserId = new Map<string, UserLoginRow>();
  for (const row of loginRows) loginRowsByUserId.set(row.UserId, row);

  const pendingUpdates: PendingUpdate[] = [];
  for (const target of targets) {
    const resultIndex = results.length;
    const loginRow = loginRowsByUserId.get(target.Id);
    const result = resolvedTargetResult(target, loginRow);
    if (!loginRow) {
      result.warnings.push(message('warningMissingUserLogin'));
      results.push(result);
      continue;
    }
    if (direction.isAlreadyInState(loginRow)) {
      result.actions.push(makeNotice(direction.alreadyKey));
      results.push(result);
      continue;
    }
    if (dryRun) {
      result.status = 'planned';
      result.actions.push(makeNotice(direction.wouldKey));
      results.push(result);
      continue;
    }
    pendingUpdates.push({
      resultIndex,
      row: { Id: loginRow.Id, IsFrozen: direction.targetState },
      actionKey: direction.actionKey,
    });
    results.push(result);
  }

  if (!dryRun && pendingUpdates.length > 0 && !noPrompt && interactive) {
    const { confirmed, timedOut } = await confirmWithTimeout(confirm, message('promptContinue'));
    if (!confirmed) {
      if (timedOut) warn(message('warningPromptTimeout'));
      throw new SfError(message('errorPromptDeclined'));
    }
  }

  if (!dryRun && pendingUpdates.length > 0) {
    const updateResults = asArray(
      await conn.sobject('UserLogin').update(
        pendingUpdates.map((pending) => pending.row),
        { allOrNone: false }
      )
    );
    updateResults.forEach((saveResult, index) => {
      const pending = pendingUpdates[index];
      const result = results[pending.resultIndex];
      if (saveResult.success) {
        result.status = 'changed';
        result.actions.push(makeNotice(pending.actionKey));
      } else {
        result.status = 'failed';
        pushErrors(result.errors, saveResult);
      }
    });
  }

  return { summary: summarizeLifecycle(results), users: results };
};
