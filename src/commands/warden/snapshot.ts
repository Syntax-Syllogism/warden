import { dirname } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { Messages, SfError } from '@salesforce/core';
import { Flags, SfCommand } from '@salesforce/sf-plugins-core';
import { buildFieldMap, type UserFieldMeta } from '../../userProvisioning/planner.js';
import { loadAssignmentState } from '../../userLifecycle/assignmentState.js';
import { renderLifecycleResult } from '../../userLifecycle/output.js';
import { buildSnapshotFile, writeSnapshotFile } from '../../userLifecycle/snapshotState.js';
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
import { readJsonOrThrow } from '../../userShared/sfUtils.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('@syntax-syllogism/warden', 'warden.snapshot');

type SnapshotFlags = Record<string, unknown>;

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

const defaultOut = (): string => `user-snapshot-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;

const getOrgProvenance = (flags: SnapshotFlags): string | undefined => {
  const targetOrg = flags['target-org'] as { getUsername?: () => string } | undefined;
  return targetOrg?.getUsername?.();
};

const buildRequests = async (
  flags: SnapshotFlags,
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

export default class UserSnapshot extends SfCommand<LifecycleResult> {
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
    out: Flags.file({ summary: messages.getMessage('flags.out.summary') }),
    'api-version': Flags.orgApiVersion({ summary: messages.getMessage('flags.api-version.summary') }),
  };

  public async run(): Promise<LifecycleResult> {
    const { flags } = await this.parse(UserSnapshot);
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
    const { requests, errors: requestErrors } = await buildRequests(flags as SnapshotFlags, fieldMap);
    const { targets, errors: resolutionErrors } = await resolveTargets(conn, requests);
    const state = await loadAssignmentState(
      conn,
      targets.map((target) => target.Id)
    );
    const out = typeof flags.out === 'string' && flags.out.length > 0 ? flags.out : defaultOut();
    await mkdir(dirname(out), { recursive: true });
    await writeSnapshotFile(
      out,
      await buildSnapshotFile(conn, targets, state, getOrgProvenance(flags as SnapshotFlags))
    );

    const users: LifecycleUserResult[] = requestErrors.concat(resolutionErrors).map(failedResult);
    users.push(
      ...targets.map((target) => ({
        key: target.key,
        id: target.Id,
        status: 'unchanged' as const,
        actions: [makeNotice('snapshotWritten')],
        skipped: [],
        warnings: [],
        errors: [],
      }))
    );
    const output = { summary: summarize(users), users };
    if (!this.jsonEnabled()) this.log(renderLifecycleResult(output, messages.getMessage.bind(messages)));
    return output;
  }
}
