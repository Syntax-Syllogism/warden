import { Messages } from '@salesforce/core';
import { Flags } from '@salesforce/sf-plugins-core';
import { renderLifecycleResult } from '@syntax-syllogism/warden-core';
import {
  strip,
  stripOptionsSchema,
  buildSnapshotFile,
  loadAssignmentState,
  writeSnapshotFile,
  makeNotice,
} from '@syntax-syllogism/warden-core';
import type { LifecycleResult } from '@syntax-syllogism/warden-core';
import { renderStripCsv } from '@syntax-syllogism/warden-core';
import { toTargetOptions, validateUserTarget } from '../../userShared/useCaseOptions.js';
import { outputFlags } from '../../userShared/outputFlags.js';
import {
  apiVersionFlag,
  assertInteractiveAllowed,
  csvListDelimiterFlag,
  dryRunFlag,
  externalIdFlag,
  flagWasSupplied,
  interactiveFlag,
  inputFormatFlag,
  noPromptFlag,
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
  confirmLifecycleWrites,
  effectiveInputFormat,
  promptBoolean,
  promptExistingFile,
  promptInputFormatForPath,
  promptOptionalApiVersion,
  promptOptionalText,
  promptOrgAlias,
  promptOutputFormat,
  promptStripSkips,
  promptText,
  promptUserSelection,
} from '../../userShared/prompting.js';
import { WardenCommand } from '../../wardenCommand.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('@syntax-syllogism/warden', 'warden.strip');

export default class UserStrip extends WardenCommand<LifecycleResult> {
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
    'no-prompt': noPromptFlag,
    'dry-run': dryRunFlag,
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
    'api-version': apiVersionFlag,
    interactive: interactiveFlag,
  };

  // eslint-disable-next-line complexity
  public async run(): Promise<LifecycleResult> {
    const parsed = await this.parse(UserStrip);
    let { flags } = parsed;
    assertInteractiveAllowed(flags.interactive, !this.jsonEnabled());
    let context = this.resolveOutputContext(flags);
    if (flags.interactive) {
      const parsedInteractive = parsed as InteractiveParse<typeof flags>;
      const hasUser = flagWasSupplied(parsedInteractive, flags, ['user']);
      const hasUsersDef = flagWasSupplied(parsedInteractive, flags, ['users-def']);
      if (hasUser && hasUsersDef) requireExactlyOne(flags, ['user', 'users-def']);
      // The interactive summary confirmation replaces the downstream operation gate.
      flags['no-prompt'] = true;
      const prompts: InteractivePrompt[] = [];
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
      const skipKeys = [
        'no-freeze',
        'no-deactivate',
        'keep-permsets',
        'keep-permset-groups',
        'keep-licenses',
        'keep-public-groups',
        'keep-queues',
      ];
      const suppliedSkipKeys = skipKeys.filter((key) => flagWasSupplied(parsedInteractive, flags, [key]));
      prompts.push({
        key: 'strip-skips',
        prompt: () =>
          promptStripSkips(
            suppliedSkipKeys.filter((key) => (flags as Record<string, unknown>)[key] === true),
            suppliedSkipKeys
          ),
        assign: (currentFlags, value) =>
          Object.fromEntries(
            skipKeys.map((key) => [
              key,
              suppliedSkipKeys.includes(key) ? currentFlags[key] === true : (value as string[]).includes(key),
            ])
          ),
      });
      if (!flagWasSupplied(parsedInteractive, flags, ['snapshot'])) {
        prompts.push({ key: 'snapshot', prompt: () => promptOptionalText('Snapshot file path') });
      }
      if (!flagWasSupplied(parsedInteractive, flags, ['dry-run'])) {
        prompts.push({ key: 'dry-run', prompt: () => promptBoolean('Dry run?', flags['dry-run']) });
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
    await validateUserTarget(conn, flags.user, (field) => messages.getMessage('errorInvalidUserMatchField', [field]));
    const plan = await strip.plan(
      conn,
      stripOptionsSchema.parse({
        ...toTargetOptions(flags),
        noFreeze: flags['no-freeze'],
        noDeactivate: flags['no-deactivate'],
        keepPermsets: flags['keep-permsets'],
        keepPermsetGroups: flags['keep-permset-groups'],
        keepPublicGroups: flags['keep-public-groups'],
        keepQueues: flags['keep-queues'],
        keepLicenses: flags['keep-licenses'],
      })
    );
    await confirmLifecycleWrites({
      required:
        !flags['dry-run'] && plan.states.some((state) => state.hasDml) && !flags['no-prompt'] && context.interactive,
      message: messages.getMessage.bind(messages),
      confirm: (message) => this.confirm({ message }),
      warn: (message) => this.warn(message),
    });
    if (flags.snapshot) {
      const targets = plan.states.map((state) => state.target);
      const stateMaps = await loadAssignmentState(
        conn,
        targets.map((target) => target.Id)
      );
      const file = await buildSnapshotFile(conn, targets, stateMaps, targetOrg.getUsername());
      await writeSnapshotFile(flags.snapshot, file);
      const users = flags['dry-run']
        ? plan.preview.users.filter((user) => user.status !== 'failed')
        : plan.states.map((state) => state.result);
      for (const user of users) user.actions.push(makeNotice('snapshotWritten'));
    }
    const output = flags['dry-run'] ? plan.preview : await strip.apply(conn, plan);
    await this.emitResult(context, {
      result: output,
      csv: renderStripCsv(output),
      human: renderLifecycleResult(output, messages.getMessage.bind(messages)),
    });
    if (output.summary.failed > 0) process.exitCode = 1;
    return output;
  }
}
