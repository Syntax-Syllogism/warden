import { Messages, SfError } from '@salesforce/core';
import { Flags } from '@salesforce/sf-plugins-core';
import {
  restore,
  readSnapshotFile,
  renderLifecycleResult,
  renderRestoreCsv,
  type LifecycleResult,
} from '@syntax-syllogism/warden-core';
import { confirmWithTimeout } from '../../userShared/prompting.js';
import {
  apiVersionFlag,
  assertInteractiveAllowed,
  dryRunFlag,
  flagWasSupplied,
  interactiveFlag,
  noPromptFlag,
  requireFlagValue,
  requireTargetOrg,
  resolveFlagsInteractively,
  resolveOrgInteractively,
  targetOrgFlag,
  type InteractiveParse,
  type InteractivePrompt,
} from '../../userShared/targetFlags.js';
import {
  promptBoolean,
  promptExistingFile,
  promptOptionalApiVersion,
  promptOptionalText,
  promptOrgAlias,
  promptOutputFormat,
} from '../../userShared/prompting.js';
import { outputFlags } from '../../userShared/outputFlags.js';
import { WardenCommand } from '../../wardenCommand.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('@syntax-syllogism/warden', 'warden.restore');

export default class UserRestore extends WardenCommand<LifecycleResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public static readonly flags = {
    'target-org': targetOrgFlag,
    snapshot: Flags.file({ exists: true, summary: messages.getMessage('flags.snapshot.summary') }),
    ...outputFlags,
    'no-prompt': noPromptFlag,
    'dry-run': dryRunFlag,
    'api-version': apiVersionFlag,
    interactive: interactiveFlag,
  };

  public async run(): Promise<LifecycleResult> {
    const parsed = await this.parse(UserRestore);
    let { flags } = parsed;
    assertInteractiveAllowed(flags.interactive, !this.jsonEnabled());
    let context = this.resolveOutputContext(flags);
    if (flags.interactive) {
      const parsedInteractive = parsed as InteractiveParse<typeof flags>;
      // The interactive summary confirmation replaces the downstream operation gate.
      flags['no-prompt'] = true;
      const prompts: InteractivePrompt[] = [];
      if (!flagWasSupplied(parsedInteractive, flags, ['snapshot'])) {
        prompts.push({ key: 'snapshot', prompt: () => promptExistingFile('Snapshot file') });
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
    const snapshotPath = requireFlagValue(flags.snapshot, '--snapshot');
    const conn = targetOrg.getConnection(flags['api-version'] ?? undefined);
    let snapshot;
    try {
      snapshot = await readSnapshotFile(String(snapshotPath));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new SfError(messages.getMessage('errorInvalidJson', [String(snapshotPath), detail]));
    }
    const plan = await restore.plan(conn, { snapshotDoc: { ...snapshot } });
    // Core uses provisioning text for missing references; keep the CLI machine contract.
    for (const user of plan.users) {
      const warnings = user.result.warnings.map((warning) => {
        const missing = /^(\w+) reference "(.*)" was not found\.$/.exec(warning);
        return missing ? messages.getMessage('warningReferenceMissing', [missing[1], missing[2]]) : warning;
      });
      user.result.warnings = warnings;
      user.preview.warnings = warnings;
    }

    if (
      !flags.interactive &&
      !flags['dry-run'] &&
      plan.preview.users.some((user) => user.status === 'planned') &&
      !flags['no-prompt'] &&
      context.interactive
    ) {
      const { confirmed, timedOut } = await confirmWithTimeout(
        (message) => this.confirm({ message }),
        messages.getMessage('promptContinue')
      );
      if (!confirmed) {
        if (timedOut) this.warn(messages.getMessage('warningPromptTimeout'));
        throw new SfError(messages.getMessage('errorPromptDeclined'));
      }
    }
    const output = flags['dry-run'] ? plan.preview : await restore.apply(conn, plan);
    const csv = renderRestoreCsv(output);
    await this.emitResult(context, {
      result: output,
      csv,
      human: renderLifecycleResult(output, messages.getMessage.bind(messages)),
    });
    if (output.summary.failed > 0) process.exitCode = 1;
    return output;
  }
}
