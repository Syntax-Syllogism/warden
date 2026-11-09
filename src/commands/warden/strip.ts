/* eslint-disable camelcase */
import { Messages, SfError } from '@salesforce/core';
import { Flags } from '@salesforce/sf-plugins-core';
import { renderLifecycleResult } from '@syntax-syllogism/warden-core';
import type { LifecycleResult } from '@syntax-syllogism/warden-core';
import { renderStripCsv } from '@syntax-syllogism/warden-core';
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
  promptPersonaSource,
  promptOrgAlias,
  promptOutputFormat,
  promptStripMode,
  promptStripSkips,
  promptText,
  promptUserSelection,
} from '../../userShared/prompting.js';
import { WardenCommand } from '../../wardenCommand.js';
import { applyStripRequest, planStripRequest, writeStripSnapshot } from '../../userShared/stripRequest.js';

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
    persona: Flags.string({ multiple: true, summary: messages.getMessage('flags.persona.summary') }),
    'all-personas': Flags.boolean({ default: false, summary: messages.getMessage('flags.all-personas.summary') }),
    'personas-def': Flags.file({ exists: true, summary: messages.getMessage('flags.personas-def.summary') }),
    'persona-source': Flags.string({
      options: ['file', 'org'] as const,
      summary: messages.getMessage('flags.persona-source.summary'),
    }),
    freeze: Flags.boolean({ default: false, summary: messages.getMessage('flags.freeze.summary') }),
    deactivate: Flags.boolean({ default: false, summary: messages.getMessage('flags.deactivate.summary') }),
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
      // The interactive summary confirmation replaces the downstream operation gate.
      flags['no-prompt'] = true;
      const hasPersona = flagWasSupplied(parsedInteractive, flags, ['persona']) && (flags.persona?.length ?? 0) > 0;
      const hasAllPersonas = flagWasSupplied(parsedInteractive, flags, ['all-personas']) && flags['all-personas'];
      const suppliedPersonaFileMode = (hasPersona || hasAllPersonas) && flags['persona-source'] !== 'org';
      if (hasUser && hasUsersDef && !suppliedPersonaFileMode) requireExactlyOne(flags, ['user', 'users-def']);
      if (!hasPersona && !hasAllPersonas) {
        const mode = await promptStripMode();
        if (mode === 'selected-personas') {
          const selected = (await promptText('Persona API names (comma-separated)'))
            .split(',')
            .map((persona) => persona.trim())
            .filter(Boolean);
          if (selected.length === 0) throw new SfError(messages.getMessage('errorPersonaSelectionRequired'));
          flags.persona = selected;
        } else if (mode === 'all-personas') {
          flags['all-personas'] = true;
        }
      }
      const personaMode = (flags.persona?.length ?? 0) > 0 || flags['all-personas'];
      if (personaMode && !flagWasSupplied(parsedInteractive, flags, ['persona-source'])) {
        flags['persona-source'] = await promptPersonaSource();
      }
      const personaSource = flags['persona-source'] ?? 'file';
      const prompts: InteractivePrompt[] = [];
      let selection: 'user' | 'users-def' | undefined;
      if (personaMode && personaSource === 'file' && !hasUsersDef) {
        selection = 'users-def';
        prompts.push({ key: 'users-def', prompt: () => promptExistingFile('Users definition file') });
      } else if (!hasUser && !hasUsersDef) {
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
      if (personaMode && personaSource === 'file' && !flagWasSupplied(parsedInteractive, flags, ['personas-def'])) {
        prompts.push({ key: 'personas-def', prompt: () => promptExistingFile('Persona definitions file') });
      }
      if (personaMode) {
        if (!flagWasSupplied(parsedInteractive, flags, ['freeze'])) {
          prompts.push({ key: 'freeze', prompt: () => promptBoolean('Freeze users?', flags.freeze) });
        }
        if (!flagWasSupplied(parsedInteractive, flags, ['deactivate'])) {
          prompts.push({ key: 'deactivate', prompt: () => promptBoolean('Deactivate users?', flags.deactivate) });
        }
      }
      const skipKeys = [
        ...(personaMode ? [] : ['no-freeze', 'no-deactivate']),
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
        confirm: async (resolvedFlags) => {
          if (personaMode) {
            this.log(
              `Persona mode: remove ${
                resolvedFlags['all-personas'] ? 'all active personas' : (resolvedFlags.persona ?? []).join(', ')
              }. ` +
                `Source: ${resolvedFlags['persona-source'] ?? 'file'}. Freeze: ${
                  resolvedFlags.freeze ? 'yes' : 'no'
                }. ` +
                `Deactivate: ${resolvedFlags.deactivate ? 'yes' : 'no'}.`
            );
          }
          return this.confirm({ message: 'Proceed with these values?' });
        },
      });
      flags = resolved.flags;
      if (!resolved.confirmed) return { summary: { total: 0, changed: 0, unchanged: 0, failed: 0 }, users: [] };
      context = this.resolveOutputContext(flags);
    }
    const targetOrg = requireTargetOrg(flags['target-org']);
    const personas = flags.persona ?? [];
    const personaMode = personas.length > 0 || flags['all-personas'];
    const conn = targetOrg.getConnection(flags['api-version'] ?? undefined);
    const planned = await planStripRequest(
      conn,
      {
        user: flags.user,
        usersDef: flags['users-def'],
        externalId: flags['external-id'],
        inputFormat: flags['input-format'] as 'json' | 'csv' | undefined,
        csvListDelimiter: flags['csv-list-delimiter'],
        noFreeze: flags['no-freeze'],
        noDeactivate: flags['no-deactivate'],
        keepPermsets: flags['keep-permsets'],
        keepPermsetGroups: flags['keep-permset-groups'],
        keepPublicGroups: flags['keep-public-groups'],
        keepQueues: flags['keep-queues'],
        keepLicenses: flags['keep-licenses'],
        personas,
        allPersonas: flags['all-personas'],
        personasDef: flags['personas-def'],
        personaSource: (flags['persona-source'] ?? 'file') as 'file' | 'org',
        freeze: flags.freeze,
        deactivate: flags.deactivate,
      },
      {
        invalidUserMatchField: (field) => messages.getMessage('errorInvalidUserMatchField', [field]),
        warn: (message) => this.warn(message),
      }
    );
    if (personaMode && !context.jsonOutput) {
      this.log(
        messages.getMessage('info.personaMode', [
          flags['all-personas'] ? 'all active personas' : personas.join(', '),
          String(planned.core.states.length),
          flags.freeze ? 'yes' : 'no',
          flags.deactivate ? 'yes' : 'no',
        ])
      );
    }
    await confirmLifecycleWrites({
      required:
        !flags['dry-run'] &&
        planned.core.states.some((state) => state.hasDml) &&
        !flags['no-prompt'] &&
        context.interactive,
      message: messages.getMessage.bind(messages),
      confirm: (message) => this.confirm({ message }),
      warn: (message) => this.warn(message),
    });
    if (flags.snapshot) {
      await writeStripSnapshot(
        conn,
        planned,
        flags.snapshot,
        targetOrg.getUsername(),
        flags['dry-run'] ? planned.core.preview.users : planned.core.states.map((state) => state.result)
      );
    }
    const output = flags['dry-run']
      ? planned.core.preview
      : await applyStripRequest(conn, planned, {
          invalidUserMatchField: (field) => messages.getMessage('errorInvalidUserMatchField', [field]),
          warn: (message) => this.warn(message),
        });
    await this.emitResult(context, {
      result: output,
      csv: renderStripCsv(output),
      human: renderLifecycleResult(output, messages.getMessage.bind(messages)),
    });
    if (output.summary.failed > 0) process.exitCode = 1;
    return output;
  }
}
