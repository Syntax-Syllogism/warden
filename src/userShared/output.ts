import { lifecycleToCsvRows, type LifecycleCsvRow } from '../userLifecycle/output.js';
import type { LifecycleResult } from '../userLifecycle/types.js';
import { serializeCsv } from './csv.js';

const lifecycleColumns = ['key', 'id', 'status', 'actions', 'skipped', 'warnings', 'errors'];

const joinValues = (values: unknown[]): string => values.map(String).join('; ');

export const renderSnapshotCsv = (result: LifecycleResult): string =>
  serializeCsv(
    result.users.map((user) => ({
      key: user.key,
      id: user.id ?? '',
      status: user.status,
      actions: joinValues(user.actions.map((action) => action.key)),
      skipped: joinValues(user.skipped.map((action) => action.key)),
      warnings: joinValues(user.warnings),
      errors: joinValues(user.errors),
    })),
    lifecycleColumns
  );

const lifecycleRows = (result: LifecycleResult): LifecycleCsvRow[] => lifecycleToCsvRows(result);

export const renderLifecycleCsv = (result: LifecycleResult): string =>
  serializeCsv(lifecycleRows(result), [
    'userKey',
    'userId',
    'userName',
    'username',
    'wasFrozen',
    'status',
    'action',
    'error',
  ]);

export const renderRestoreCsv = (result: LifecycleResult): string =>
  serializeCsv(lifecycleRows(result), [
    'userKey',
    'userId',
    'userName',
    'username',
    'status',
    'action',
    'category',
    'name',
    'error',
  ]);

export const renderStripCsv = (result: LifecycleResult): string =>
  serializeCsv(lifecycleRows(result), [
    'userKey',
    'userId',
    'userName',
    'username',
    'status',
    'action',
    'category',
    'itemId',
    'itemApiName',
    'error',
  ]);

export const renderProvisionCsv = (result: {
  users: Array<{
    key: string;
    id?: string;
    userName?: string;
    username?: string;
    personas: string[];
    matchedBy: string | null;
    status: string;
    actions: string[];
    errors: string[];
    relatedRecords?: Array<{ relationship: string; phase: string; sobject: string; action: string; error?: string }>;
  }>;
}): string =>
  serializeCsv(
    result.users.flatMap((user) => {
      const base = {
        userKey: user.key,
        userId: user.id ?? '',
        userName: user.userName ?? '',
        username: user.username ?? '',
        personas: joinValues(user.personas),
        matchedBy: user.matchedBy ?? '',
        status: user.status,
      };
      const actionRows = user.actions.map((action) => ({ ...base, action, detail: '', error: '' }));
      // Related records reuse the existing ten columns: `action=related` plus a composed detail.
      const relatedRows = (user.relatedRecords ?? []).map((related) => ({
        ...base,
        action: 'related',
        detail: `${related.relationship} ${related.phase} ${related.sobject} ${related.action}`,
        error: related.error ?? '',
      }));
      const errorRows = user.errors.map((error) => ({ ...base, action: '', detail: '', error }));
      const populatedRows = actionRows.concat(relatedRows);
      return populatedRows.concat(
        errorRows.length > 0
          ? errorRows
          : populatedRows.length > 0
          ? []
          : [{ ...base, action: '', detail: '', error: '' }]
      );
    }),
    ['userKey', 'userId', 'userName', 'username', 'personas', 'matchedBy', 'status', 'action', 'detail', 'error']
  );
