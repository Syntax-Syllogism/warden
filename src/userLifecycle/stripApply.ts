import type { Connection } from '@salesforce/core';
import { asArray, pushErrors } from '../userShared/sfUtils.js';
import { makeNotice } from './output.js';
import type { StripStep, StripTargetState } from './stripPlan.js';
import type { LabelBundle, LifecycleUserResult } from './types.js';

const markSuccess = (result: LifecycleUserResult, actionKey: string, count?: number, items?: LabelBundle[]): void => {
  if (result.status !== 'failed') result.status = 'changed';
  result.actions.push(makeNotice(actionKey, count, items));
};

export const runUpdate = async (options: {
  conn: Connection;
  result: LifecycleUserResult;
  sobject: 'UserLogin' | 'User';
  row: { Id: string } & Record<string, unknown>;
  actionKey: string;
}): Promise<void> => {
  const { conn, result, sobject, row, actionKey } = options;
  const saveResults = asArray(await conn.sobject(sobject).update([row], { allOrNone: false }));
  const saveResult = saveResults[0];
  if (saveResult?.success) {
    markSuccess(result, actionKey);
    return;
  }
  result.status = 'failed';
  pushErrors(result.errors, saveResult);
};

export const runDelete = async (options: {
  conn: Connection;
  result: LifecycleUserResult;
  sobject: 'PermissionSetAssignment' | 'GroupMember' | 'PermissionSetLicenseAssign';
  ids: string[];
  actionKey: string;
  items: LabelBundle[];
}): Promise<void> => {
  const { conn, result, sobject, ids, actionKey, items } = options;
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
    await runUpdate({ conn, result, sobject: step.sobject, row: step.row, actionKey: step.actionKey });
    return;
  }
  await runDelete({ conn, result, sobject: step.sobject, ids: step.ids, actionKey: step.actionKey, items: step.items });
};

export const applyStripState = async (conn: Connection, state: StripTargetState): Promise<void> =>
  state.steps.reduce<Promise<void>>(
    (chain, step) => chain.then(() => runStripStep(conn, state.result, step)),
    Promise.resolve()
  );
