import { Messages } from '@salesforce/core';
import { Flags } from '@salesforce/sf-plugins-core';
import { loadAssignmentState } from '../../userLifecycle/assignmentState.js';
import {
  makeNotice,
  failedResult,
  renderLifecycleResult,
  resolvedTargetResult,
  summarizeLifecycle,
} from '../../userLifecycle/output.js';
import { buildSnapshotFile, writeSnapshotFile } from '../../userLifecycle/snapshotState.js';
import { buildTargetRequests, resolveTargets } from '../../userLifecycle/targeting.js';
import type { LifecycleResult, LifecycleUserResult } from '../../userLifecycle/types.js';
import { renderSnapshotCsv } from '../../userShared/output.js';
import { describeUserFields } from '../../userShared/userFields.js';
import { outputFlags } from '../../userShared/outputFlags.js';
import { WardenCommand } from './base.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('@syntax-syllogism/warden', 'warden.snapshot');

type SnapshotFlags = Record<string, unknown>;

const defaultOut = (): string => `user-snapshot-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;

const getOrgProvenance = (flags: SnapshotFlags): string | undefined => {
  const targetOrg = flags['target-org'] as { getUsername?: () => string } | undefined;
  return targetOrg?.getUsername?.();
};

export default class UserSnapshot extends WardenCommand<LifecycleResult> {
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
    ...outputFlags,
    out: Flags.file({ summary: messages.getMessage('flags.out.summary') }),
    'api-version': Flags.orgApiVersion({ summary: messages.getMessage('flags.api-version.summary') }),
  };

  public async run(): Promise<LifecycleResult> {
    const { flags } = await this.parse(UserSnapshot);
    const context = this.resolveOutputContext(flags);
    const conn = flags['target-org'].getConnection(flags['api-version'] ?? undefined);
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
    const out = typeof flags.out === 'string' && flags.out.length > 0 ? flags.out : defaultOut();
    await writeSnapshotFile(
      out,
      await buildSnapshotFile(conn, targets, state, getOrgProvenance(flags as SnapshotFlags))
    );

    const users: LifecycleUserResult[] = requestErrors.concat(resolutionErrors).map(failedResult);
    users.push(
      ...targets.map((target) => ({
        ...resolvedTargetResult(target, state.userLoginByUserId.get(target.Id)?.[0]),
        actions: [makeNotice('snapshotWritten')],
      }))
    );
    const output = { summary: summarizeLifecycle(users), users };
    const csv = renderSnapshotCsv(output);
    await this.emitResult(context, {
      result: output,
      csv,
      human: renderLifecycleResult(output, messages.getMessage.bind(messages)),
    });
    if (output.summary.failed > 0) process.exitCode = 1;
    return output;
  }
}
