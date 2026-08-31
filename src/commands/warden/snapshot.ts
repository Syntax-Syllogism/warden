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
import {
  apiVersionFlag,
  assertInteractiveAllowed,
  csvListDelimiterFlag,
  externalIdFlag,
  flagWasSupplied,
  interactiveFlag,
  inputFormatFlag,
  requireTargetOrg,
  requireExactlyOne,
  resolveFlagsInteractively,
  resolveOrgInteractively,
  targetOrgFlag,
  userFlag,
  usersDefFlag,
  type InteractiveParse,
  type InteractivePrompt,
} from '../../userShared/targetFlags.js';
import {
  effectiveInputFormat,
  promptExistingFile,
  promptInputFormatForPath,
  promptOptionalApiVersion,
  promptOptionalText,
  promptOrgAlias,
  promptOutputFormat,
  promptText,
  promptUserSelection,
} from '../../userShared/prompting.js';
import { WardenCommand } from '../../wardenCommand.js';

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
    'target-org': targetOrgFlag,
    user: userFlag,
    'users-def': usersDefFlag,
    'external-id': externalIdFlag,
    'input-format': inputFormatFlag,
    'csv-list-delimiter': csvListDelimiterFlag,
    ...outputFlags,
    out: Flags.file({ summary: messages.getMessage('flags.out.summary') }),
    'api-version': apiVersionFlag,
    interactive: interactiveFlag,
  };

  public async run(): Promise<LifecycleResult> {
    const parsed = await this.parse(UserSnapshot);
    let { flags } = parsed;
    assertInteractiveAllowed(flags.interactive, !this.jsonEnabled());
    let context = this.resolveOutputContext(flags);
    if (flags.interactive) {
      const parsedInteractive = parsed as InteractiveParse<typeof flags>;
      const prompts: InteractivePrompt[] = [];
      const hasUser = flagWasSupplied(parsedInteractive, flags, ['user']);
      const hasUsersDef = flagWasSupplied(parsedInteractive, flags, ['users-def']);
      if (hasUser && hasUsersDef) requireExactlyOne(flags, ['user', 'users-def']);
      let selection: 'user' | 'users-def' | undefined;
      if (!hasUser && !hasUsersDef) {
        selection = await promptUserSelection();
        prompts.push(
          selection === 'user'
            ? { key: 'user', prompt: () => promptText('User match (field:value)') }
            : { key: 'users-def', prompt: () => promptExistingFile('Users definition file') }
        );
      }
      if (hasUsersDef || selection === 'users-def') {
        prompts.push({ key: 'external-id', prompt: () => promptOptionalText('External ID field') });
        prompts.push({
          key: 'input-format',
          prompt: (resolvedFlags) => promptInputFormatForPath(resolvedFlags['users-def']),
        });
        prompts.push({
          key: 'csv-list-delimiter',
          when: (resolvedFlags) => effectiveInputFormat(resolvedFlags) === 'csv',
          prompt: () => promptText('CSV list delimiter', ';'),
        });
      }
      if (!flagWasSupplied(parsedInteractive, flags, ['out'])) {
        prompts.push({ key: 'out', prompt: () => promptText('Snapshot output path', defaultOut()) });
      }
      if (!flags['target-org']) flags['target-org'] = await resolveOrgInteractively(undefined, promptOrgAlias);
      prompts.push(
        { key: 'output', prompt: promptOutputFormat },
        { key: 'output-file', prompt: () => promptOptionalText('Output file path') },
        { key: 'api-version', prompt: () => promptOptionalApiVersion(flags['api-version']) }
      );
      const resolved = await resolveFlagsInteractively(parsedInteractive, prompts, {
        log: (message) => this.log(message),
        confirm: () => this.confirm({ message: 'Proceed with these values?' }),
      });
      flags = resolved.flags;
      if (!resolved.confirmed) return { summary: { total: 0, changed: 0, unchanged: 0, failed: 0 }, users: [] };
      context = this.resolveOutputContext(flags);
    }
    const targetOrg = requireTargetOrg(flags['target-org']);
    requireExactlyOne(flags, ['user', 'users-def']);
    const conn = targetOrg.getConnection(flags['api-version'] ?? undefined);
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
