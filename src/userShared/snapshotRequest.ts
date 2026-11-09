import { Messages, type Connection } from '@salesforce/core';
import {
  buildTargetRequests,
  describeUserFields,
  failedResult,
  loadAssignmentState,
  makeNotice,
  resolvedTargetResult,
  resolveTargets,
  snapshot,
  summarizeLifecycle,
  type LifecycleResult,
  type LifecycleUserResult,
  type writeSnapshotFile,
} from '@syntax-syllogism/warden-core';
import { requireExactlyOne } from './targetFlags.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('@syntax-syllogism/warden', 'warden.snapshot');

export type SnapshotRequestInput = {
  user?: string;
  usersDef?: string;
  externalId?: string;
  inputFormat?: 'json' | 'csv';
  csvListDelimiter?: string;
  out: string;
  org?: string;
};

export type SnapshotWrite = typeof writeSnapshotFile;

export const defaultSnapshotOut = (): string => `user-snapshot-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;

/** Executes shared snapshot resolution and writing, without command output concerns. */
export const runSnapshotRequest = async (
  conn: Connection,
  input: SnapshotRequestInput,
  write: SnapshotWrite
): Promise<LifecycleResult> => {
  const flags = {
    user: input.user,
    'users-def': input.usersDef,
    'external-id': input.externalId,
    'input-format': input.inputFormat,
    'csv-list-delimiter': input.csvListDelimiter,
  };
  requireExactlyOne(flags, ['user', 'users-def']);
  const fieldMap = await describeUserFields(conn);
  const { requests, errors: requestErrors } = await buildTargetRequests(flags, fieldMap, {
    invalidUserMatchField: (field) => messages.getMessage('errorInvalidUserMatchField', [field]),
    invalidJson: (path, error) => messages.getMessage('errorInvalidJson', [path, error]),
  });
  const { targets, errors: resolutionErrors } = await resolveTargets(conn, requests, fieldMap);
  const state = await loadAssignmentState(
    conn,
    targets.map((target) => target.Id)
  );
  await write(
    input.out,
    await snapshot.run(conn, {
      usersDoc: { users: targets.map((target) => ({ match: target.field, [target.field]: target.value })) },
      org: input.org,
    })
  );
  const users: LifecycleUserResult[] = requestErrors.concat(resolutionErrors).map(failedResult);
  users.push(
    ...targets.map((target) => ({
      ...resolvedTargetResult(target, state.userLoginByUserId.get(target.Id)?.[0]),
      actions: [makeNotice('snapshotWritten')],
    }))
  );
  return { summary: summarizeLifecycle(users), users };
};
