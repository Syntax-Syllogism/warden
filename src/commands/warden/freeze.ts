import { Messages } from '@salesforce/core';
import { renderLifecycleResult } from '../../userLifecycle/output.js';
import { buildTargetRequests } from '../../userLifecycle/targeting.js';
import { executeFreezeToggle, FREEZE } from '../../userLifecycle/freezeState.js';
import type { LifecycleResult } from '../../userLifecycle/types.js';
import { renderLifecycleCsv } from '../../userShared/output.js';
import { describeUserFields } from '../../userShared/userFields.js';
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
  effectiveInputFormat,
  promptBoolean,
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
const messages = Messages.loadMessages('@syntax-syllogism/warden', 'warden.freeze');

export default class UserFreeze extends WardenCommand<LifecycleResult> {
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
    'no-prompt': noPromptFlag,
    'dry-run': dryRunFlag,
    'api-version': apiVersionFlag,
    interactive: interactiveFlag,
  };

  public async run(): Promise<LifecycleResult> {
    const parsed = await this.parse(UserFreeze);
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
    const fieldMap = await describeUserFields(conn);

    const { requests, errors: requestErrors } = await buildTargetRequests(flags, fieldMap, {
      invalidUserMatchField: (field) => messages.getMessage('errorInvalidUserMatchField', [field]),
      invalidJson: (path, error) => messages.getMessage('errorInvalidJson', [path, error]),
    });
    const output = await executeFreezeToggle({
      conn,
      fieldMap,
      requests,
      requestErrors,
      direction: FREEZE,
      dryRun: flags['dry-run'],
      noPrompt: flags.interactive ? true : flags['no-prompt'],
      interactive: context.interactive,
      message: messages.getMessage.bind(messages),
      confirm: (message) => this.confirm({ message }),
      warn: (message) => this.warn(message),
    });
    const csv = renderLifecycleCsv(output);
    await this.emitResult(context, {
      result: output,
      csv,
      human: renderLifecycleResult(output, messages.getMessage.bind(messages)),
    });
    if (output.summary.failed > 0) process.exitCode = 1;
    return output;
  }
}
