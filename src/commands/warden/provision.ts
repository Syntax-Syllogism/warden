import { Messages, SfError } from '@salesforce/core';
import { Flags } from '@salesforce/sf-plugins-core';
import { confirmWithTimeout } from '../../userShared/prompt.js';
import { renderProvisionCsv } from '../../userShared/output.js';
import { detectInputFormat, type InputFormat } from '../../userShared/csv.js';
import { outputFlags } from '../../userShared/outputFlags.js';
import {
  apiVersionFlag,
  assertInteractiveAllowed,
  csvListDelimiterFlag,
  dryRunFlag,
  flagWasSupplied,
  inputFormatFlag,
  interactiveFlag,
  requireFlagValue,
  requireTargetOrg,
  resolveFlagsInteractively,
  resolveOrgInteractively,
  targetOrgFlag,
  type InteractiveParse,
  type InteractivePrompt,
} from '../../userShared/targetFlags.js';
import {
  effectiveInputFormat,
  promptBoolean,
  promptExistingFile,
  promptInputFormatForPath,
  promptOptionalApiVersion,
  promptOptionalExistingFile,
  promptOptionalText,
  promptOrgAlias,
  promptOutputFormat,
  promptText,
} from '../../userShared/prompting.js';
import { ProvisionUserUseCase, type ProvisionResult } from '../../userProvisioning/provisionUserUseCase.js';
import { readProvisionDefinitions } from '../../userProvisioning/definitionReader.js';
import { WardenCommand } from '../../wardenCommand.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('@syntax-syllogism/warden', 'warden.provision');

/**
 * Report the match field alongside the value actually looked up under it.
 *
 * `user.key` is a display identity (FederationIdentifier, then Username, then Email,
 * then a synthesized `<personas>:<index>` fallback), so it is only ever the match value
 * by coincidence and must not be printed as one. `matchedBy` likewise only says a match
 * field was configured, so `matched` is what distinguishes a resolved user from a
 * net-new one.
 */
const renderMatchProvenance = (user: ProvisionResult['users'][number]): string => {
  if (!user.matchedBy) return 'unmatched';
  const label = user.matched ? 'matched' : 'unmatched';
  return user.matchValue === null ? `${label} ${user.matchedBy}` : `${label} ${user.matchedBy} = ${user.matchValue}`;
};

const renderProvisionHuman = (output: ProvisionResult): string => {
  const lines: string[] = [];
  for (const user of output.users) {
    lines.push(`${user.key}${user.id ? ` · ${user.id}` : ''} · ${user.status}`);
    lines.push(`  ${renderMatchProvenance(user)} · personas: ${user.personas.join(', ') || '(none)'}`);
    for (const action of user.actions) lines.push(`  action: ${action}`);
    for (const related of user.relatedRecords ?? []) {
      const recordId = related.recordId ? ` · ${related.recordId}` : '';
      lines.push(`  related: ${related.phase} ${related.sobject} ${related.action}${recordId}`);
      if (related.error) lines.push(`  related error: ${related.error}`);
    }
    for (const error of user.errors) lines.push(`  error: ${error}`);
  }
  lines.push('');
  lines.push(
    messages.getMessage('info.summary', [
      output.summary.total,
      output.summary.created,
      output.summary.updated,
      output.summary.failed,
    ])
  );
  if (output.licenses) {
    lines.push('');
    lines.push(messages.getMessage('info.licenses.header'));
    for (const license of output.licenses) {
      const available = license.unlimited ? 'unlimited' : String(license.available);
      const note = license.note ? ` (${license.note})` : '';
      lines.push(
        messages.getMessage('info.licenses.row', [
          license.licenseName,
          license.required,
          available,
          license.shortfall,
          note,
        ])
      );
    }
    lines.push(messages.getMessage('info.permissionSetLicenses.notEvaluated'));
  }
  return lines.join('\n');
};

export default class UserProvision extends WardenCommand<ProvisionResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public static readonly flags = {
    'target-org': targetOrgFlag,
    'users-def': Flags.file({ exists: true, summary: messages.getMessage('flags.users-def.summary') }),
    'personas-def': Flags.file({
      exists: true,
      summary: messages.getMessage('flags.personas-def.summary'),
    }),
    'related-def': Flags.file({
      exists: true,
      summary: messages.getMessage('flags.related-def.summary'),
    }),
    'external-id': Flags.string({
      aliases: ['match-field'],
      summary: messages.getMessage('flags.external-id.summary'),
    }),
    'input-format': inputFormatFlag,
    'csv-list-delimiter': csvListDelimiterFlag,
    'fuzzy-username': Flags.boolean({ default: false, summary: messages.getMessage('flags.fuzzy-username.summary') }),
    'no-prompt': Flags.boolean({ default: false, summary: messages.getMessage('flags.no-prompt.summary') }),
    'dry-run': dryRunFlag,
    'fail-on-insufficient-license': Flags.boolean({
      default: false,
      summary: messages.getMessage('flags.fail-on-insufficient-license.summary'),
    }),
    ...outputFlags,
    'api-version': apiVersionFlag,
    interactive: interactiveFlag,
  };

  // eslint-disable-next-line complexity
  public async run(): Promise<ProvisionResult> {
    const parsed = await this.parse(UserProvision);
    let { flags } = parsed;
    assertInteractiveAllowed(flags.interactive, !this.jsonEnabled());
    let context = this.resolveOutputContext(flags);
    if (flags.interactive) {
      const parsedInteractive = parsed as InteractiveParse<typeof flags>;
      // The interactive summary confirmation replaces the downstream operation gate.
      flags['no-prompt'] = true;
      const prompts: InteractivePrompt[] = [];
      if (!flagWasSupplied(parsedInteractive, flags, ['users-def'])) {
        prompts.push({ key: 'users-def', prompt: () => promptExistingFile('Users definition file') });
      }
      if (!flagWasSupplied(parsedInteractive, flags, ['personas-def'])) {
        prompts.push({ key: 'personas-def', prompt: () => promptOptionalExistingFile('Personas definition file') });
      }
      if (!flagWasSupplied(parsedInteractive, flags, ['external-id'])) {
        prompts.push({ key: 'external-id', prompt: () => promptOptionalText('External ID field') });
      }
      prompts.push({
        key: 'input-format',
        prompt: (resolvedFlags) => promptInputFormatForPath(resolvedFlags['users-def']),
      });
      prompts.push({
        key: 'related-def',
        when: (resolvedFlags) => effectiveInputFormat(resolvedFlags) !== 'csv',
        prompt: () => promptOptionalExistingFile('Related record definition file'),
      });
      prompts.push({
        key: 'csv-list-delimiter',
        when: (resolvedFlags) => effectiveInputFormat(resolvedFlags) === 'csv',
        prompt: () => promptText('CSV list delimiter', ';'),
      });
      if (!flagWasSupplied(parsedInteractive, flags, ['fuzzy-username'])) {
        prompts.push({
          key: 'fuzzy-username',
          prompt: () => promptBoolean('Allow fuzzy usernames?', flags['fuzzy-username']),
        });
      }
      if (!flagWasSupplied(parsedInteractive, flags, ['dry-run'])) {
        prompts.push({ key: 'dry-run', prompt: () => promptBoolean('Dry run?', flags['dry-run']) });
      }
      if (!flagWasSupplied(parsedInteractive, flags, ['fail-on-insufficient-license'])) {
        prompts.push({
          key: 'fail-on-insufficient-license',
          prompt: () => promptBoolean('Fail when licenses are insufficient?', flags['fail-on-insufficient-license']),
        });
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
        validate: (resolvedFlags) => {
          if (resolvedFlags['related-def'] && effectiveInputFormat(resolvedFlags) === 'csv') {
            throw new SfError(messages.getMessage('errorRelatedRequiresJson'));
          }
        },
      });
      flags = resolved.flags;
      if (!resolved.confirmed) {
        return { summary: { total: 0, created: 0, updated: 0, failed: 0, warnings: 0 }, users: [] };
      }
      context = this.resolveOutputContext(flags);
    }
    const targetOrg = requireTargetOrg(flags['target-org']);
    const usersPath = requireFlagValue(flags['users-def'], '--users-def');
    const inputFormat = detectInputFormat(usersPath, flags['input-format'] as InputFormat | undefined);
    // Refuse before the connection is used, so a misconfigured invocation costs zero API calls.
    if (flags['related-def'] && inputFormat === 'csv') {
      throw new SfError(messages.getMessage('errorRelatedRequiresJson'));
    }
    const conn = targetOrg.getConnection(flags['api-version'] ?? undefined);
    const definitions =
      inputFormat === 'json'
        ? await readProvisionDefinitions(
            usersPath,
            flags['personas-def'],
            { relatedPath: flags['related-def'] },
            (path, error) => messages.getMessage('errorInvalidJson', [path, error])
          )
        : undefined;
    const useCase = new ProvisionUserUseCase();

    const output = await useCase.execute({
      connection: conn,
      usersDoc: definitions?.usersDoc,
      personasDoc: definitions?.personasDoc,
      personasSupplied: definitions?.personasSupplied,
      relatedDoc: definitions?.relatedDoc,
      usersPath: inputFormat === 'csv' ? usersPath : undefined,
      personasPath: inputFormat === 'csv' ? flags['personas-def'] : undefined,
      inputFormat: inputFormat === 'csv' ? inputFormat : undefined,
      csvListDelimiter: flags['csv-list-delimiter'],
      externalId: flags['external-id'],
      fuzzyUsername: flags['fuzzy-username'],
      dryRun: flags['dry-run'],
      acknowledgeWarnings: context.interactive
        ? (warnings): Promise<void> =>
            this.acknowledgeWarnings(warnings, flags['no-prompt'] || Boolean(flags.interactive))
        : undefined,
    });

    const csv = renderProvisionCsv(output);
    if (!context.jsonOutput) {
      this.warnUserFailures(output);
      this.warnLicenseShortfalls(output);
    }
    await this.emitResult(context, {
      result: output,
      csv,
      human: renderProvisionHuman(output),
    });
    if (output.summary.failed > 0) process.exitCode = 1;
    if (flags['fail-on-insufficient-license'] && output.licenses?.some((license) => license.shortfall > 0)) {
      const shortfalls = output.licenses
        .filter((license) => license.shortfall > 0)
        .map((license) => `${license.licenseName} (${license.shortfall})`)
        .join(', ');
      throw Object.assign(new SfError(messages.getMessage('errorInsufficientLicense', [shortfalls])), {
        result: output,
      });
    }
    return output;
  }

  private async acknowledgeWarnings(warnings: string[], noPrompt: boolean): Promise<void> {
    for (const warning of warnings) this.warn(warning);
    if (noPrompt) return;
    const { confirmed } = await confirmWithTimeout(
      (message) => this.confirm({ message }),
      messages.getMessage('promptWarningsContinue')
    );
    if (!confirmed) {
      this.warn(messages.getMessage('warningPromptTimeout'));
      throw new SfError(messages.getMessage('errorPromptDeclined'));
    }
  }

  private warnUserFailures(output: ProvisionResult): void {
    for (const user of output.users) {
      if (user.errors.length > 0)
        this.warn(messages.getMessage('warningUserFailed', [user.key, user.errors.join('; ')]));
    }
  }

  private warnLicenseShortfalls(output: ProvisionResult): void {
    for (const license of output.licenses ?? []) {
      if (license.shortfall > 0)
        this.warn(messages.getMessage('warningInsufficientLicense', [license.licenseName, license.shortfall]));
    }
  }
}
