import type { Connection } from '@salesforce/core';
import { asArray, pushErrors, type SaveResult } from '../userShared/sfUtils.js';
import { makeNotice } from './output.js';
import type { LabelBundle, LifecycleUserResult } from './types.js';

export type AssignmentSObject = 'PermissionSetAssignment' | 'GroupMember' | 'PermissionSetLicenseAssign';

/** Record a successful step without downgrading an already-failed result. */
export const markSuccess = (
  result: LifecycleUserResult,
  actionKey: string,
  count?: number,
  items?: LabelBundle[]
): void => {
  if (result.status !== 'failed') result.status = 'changed';
  result.actions.push(makeNotice(actionKey, count, items));
};

const recordAssignmentResults = (
  result: LifecycleUserResult,
  saveResults: SaveResult[],
  items: LabelBundle[],
  actionKey: string
): void => {
  const successfulItems = items.filter((_, index) => saveResults[index]?.success);
  if (successfulItems.length > 0) markSuccess(result, actionKey, successfulItems.length, successfulItems);

  // Keep strip's immediate failure behavior so later sequential steps observe the failure.
  if (successfulItems.length < items.length) {
    result.status = 'failed';
    pushErrors(result.errors, saveResults);
  }
};

export const runAssignmentCreates = async (options: {
  conn: Connection;
  result: LifecycleUserResult;
  sobject: AssignmentSObject;
  rows: Array<Record<string, string>>;
  actionKey: string;
  items: LabelBundle[];
}): Promise<void> => {
  const { conn, result, sobject, rows, actionKey, items } = options;
  if (rows.length === 0) return;
  const saveResults = asArray(await conn.sobject(sobject).create(rows, { allOrNone: false }));
  recordAssignmentResults(result, saveResults, items, actionKey);
};

export const runAssignmentDeletes = async (options: {
  conn: Connection;
  result: LifecycleUserResult;
  sobject: AssignmentSObject;
  ids: string[];
  actionKey: string;
  items: LabelBundle[];
}): Promise<void> => {
  const { conn, result, sobject, ids, actionKey, items } = options;
  if (ids.length === 0) return;
  const saveResults = asArray(await conn.sobject(sobject).delete(ids, { allOrNone: false }));
  recordAssignmentResults(result, saveResults, items, actionKey);
};

export const runRecordUpdate = async (options: {
  conn: Connection;
  result: LifecycleUserResult;
  sobject: 'User' | 'UserLogin';
  rows: Array<{ Id: string } & Record<string, unknown>>;
  actionKey: string;
}): Promise<void> => {
  const { conn, result, sobject, rows, actionKey } = options;
  if (rows.length === 0) return;
  const saveResults = asArray(await conn.sobject(sobject).update(rows, { allOrNone: false }));
  if (saveResults.some((saveResult) => saveResult.success)) markSuccess(result, actionKey);
  if (saveResults.some((saveResult) => !saveResult.success)) {
    result.status = 'failed';
    pushErrors(result.errors, saveResults);
  }
};
