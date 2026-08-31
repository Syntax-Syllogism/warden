import { Messages, SfError, type Connection } from '@salesforce/core';
import { Flags } from '@salesforce/sf-plugins-core';
import { detectInputFormat } from '../../userShared/csv.js';
import { readProvisionDefinitions } from '../../userProvisioning/definitionReader.js';
import { executePersonaDiff, executeUserToUserDiff, type UserDiffResult } from '../../userLifecycle/userDiff.js';
import { renderUserDiffCsv, renderUserDiffHuman } from '../../userLifecycle/diffOutput.js';
import {
  renderUserConformanceCsv,
  renderUserConformanceHuman,
  verifyUserDiff,
  type UserConformanceVerdict,
} from '../../userLifecycle/conformance.js';
import { outputFlags } from '../../userShared/outputFlags.js';
import {
  apiVersionFlag,
  assertInteractiveAllowed,
  csvListDelimiterFlag,
  externalIdFlag,
  flagWasSupplied,
  interactiveFlag,
  inputFormatFlag,
  requireExactlyOne,
  requireFlagDependencies,
  requireTargetOrg,
  resolveFlagsInteractively,
  resolveOrgInteractively,
  targetOrgFlag,
  usersDefFlag,
  type InteractiveParse,
  type InteractivePrompt,
} from '../../userShared/targetFlags.js';
import {
  effectiveInputFormat,
  promptBoolean,
  promptDiffMode,
  promptExistingFile,
  promptInputFormatForPath,
  promptOptionalApiVersion,
  promptOptionalExistingFile,
  promptOptionalText,
  promptOrgAlias,
  promptOutputFormat,
  promptText,
} from '../../userShared/prompting.js';
import { WardenCommand } from '../../wardenCommand.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('@syntax-syllogism/warden', 'warden.diff');

type UserDiffFlags = {
  'target-org': { getConnection(apiVersion?: string): Connection };
  user?: string;
  against?: string;
  'users-def'?: string;
  'personas-def'?: string;
  'external-id'?: string;
  'input-format'?: 'json' | 'csv';
  'csv-list-delimiter'?: string;
  output: 'human' | 'csv' | 'json';
  'output-file'?: string;
  verbose: boolean;
  'fail-on-drift': boolean;
  verify: boolean;
  'api-version'?: string;
  interactive?: boolean;
};

export type UserDiffCommandResult = UserDiffResult | UserConformanceVerdict[];

export default class UserDiff extends WardenCommand<UserDiffCommandResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public static readonly flags = {
    'target-org': targetOrgFlag,
    user: Flags.string({
      summary: messages.getMessage('flags.user.summary'),
    }),
    against: Flags.string({ summary: messages.getMessage('flags.against.summary') }),
    'users-def': usersDefFlag,
    'personas-def': Flags.file({
      exists: true,
      summary: messages.getMessage('flags.personas-def.summary'),
    }),
    'external-id': externalIdFlag,
    'input-format': inputFormatFlag,
    'csv-list-delimiter': csvListDelimiterFlag,
    ...outputFlags,
    verbose: Flags.boolean({
      default: false,
      summary: messages.getMessage('flags.verbose.summary'),
    }),
    'fail-on-drift': Flags.boolean({
      default: false,
      summary: messages.getMessage('flags.fail-on-drift.summary'),
    }),
    verify: Flags.boolean({
      default: false,
      summary: messages.getMessage('flags.verify.summary'),
    }),
    'api-version': apiVersionFlag,
    interactive: interactiveFlag,
  };

  private static async runPersonaMode(
    conn: Connection,
    flags: UserDiffFlags & { 'users-def': string; 'personas-def'?: string }
  ): Promise<UserDiffResult> {
    const inputFormat = detectInputFormat(flags['users-def'], flags['input-format']);
    const definitions =
      inputFormat === 'json'
        ? await readProvisionDefinitions(flags['users-def'], flags['personas-def'], {}, (path, error) =>
            messages.getMessage('errorInvalidJson', [path, error])
          )
        : undefined;
    return executePersonaDiff({
      connection: conn,
      usersDoc: definitions?.usersDoc,
      personasDoc: definitions?.personasDoc,
      personasSupplied: definitions?.personasSupplied,
      usersPath: inputFormat === 'csv' ? flags['users-def'] : undefined,
      personasPath: inputFormat === 'csv' ? flags['personas-def'] : undefined,
      inputFormat: inputFormat === 'csv' ? inputFormat : undefined,
      csvListDelimiter: flags['csv-list-delimiter'],
      externalId: flags['external-id'],
    });
  }

  // eslint-disable-next-line complexity
  public async run(): Promise<UserDiffCommandResult> {
    const parsed = (await this.parse(UserDiff)) as unknown as InteractiveParse<UserDiffFlags>;
    let { flags } = parsed;
    assertInteractiveAllowed(flags.interactive, !this.jsonEnabled());
    if (flags.interactive) {
      const prompts: InteractivePrompt[] = [];
      const hasUserModeFlag = flagWasSupplied(parsed, flags, ['user', 'against']);
      const hasPersonaModeFlag =
        flagWasSupplied(parsed, flags, [
          'users-def',
          'personas-def',
          'external-id',
          'input-format',
          'csv-list-delimiter',
        ]) || flags.verify;
      // A contradictory branch has to fail before anything is collected or summarized,
      // reusing the message the flag-only path would have produced for the same input.
      if (hasUserModeFlag && hasPersonaModeFlag) {
        if (flags.user !== undefined && flags['users-def'] !== undefined) {
          requireExactlyOne(flags, ['user', 'users-def']);
        }
        if (flags['external-id'] !== undefined) throw new SfError(messages.getMessage('errorExternalIdUserMode'));
        if (flags['personas-def'] !== undefined) throw new SfError(messages.getMessage('errorPersonasUserMode'));
        if (flags.verify) throw new SfError(messages.getMessage('errorVerifyUserMode'));
        throw new SfError(messages.getMessage('errorDiffModeFlagsMutuallyExclusive'));
      }
      const mode = hasUserModeFlag ? 'users' : hasPersonaModeFlag ? 'personas' : await promptDiffMode();
      if (mode === 'users') {
        if (!flagWasSupplied(parsed, flags, ['user']))
          prompts.push({ key: 'user', prompt: () => promptText('User match (field:value)') });
        if (!flagWasSupplied(parsed, flags, ['against'])) {
          prompts.push({ key: 'against', prompt: () => promptText('Reference user match (field:value)') });
        }
      } else {
        if (!flagWasSupplied(parsed, flags, ['users-def']))
          prompts.push({ key: 'users-def', prompt: () => promptExistingFile('Users definition file') });
        if (!flagWasSupplied(parsed, flags, ['personas-def'])) {
          prompts.push({ key: 'personas-def', prompt: () => promptOptionalExistingFile('Personas definition file') });
        }
        if (!flagWasSupplied(parsed, flags, ['external-id'])) {
          prompts.push({ key: 'external-id', prompt: () => promptOptionalText('External ID field') });
        }
        prompts.push({
          key: 'input-format',
          prompt: (resolvedFlags) => promptInputFormatForPath(resolvedFlags['users-def']),
        });
        prompts.push({
          key: 'csv-list-delimiter',
          when: (resolvedFlags) => effectiveInputFormat(resolvedFlags) === 'csv',
          prompt: () => promptText('CSV list delimiter', ';'),
        });
        if (!flagWasSupplied(parsed, flags, ['verify'])) {
          prompts.push({
            key: 'verify',
            prompt: () => promptBoolean('Verify conformance?', flags.verify),
            assign: (_flags, value) => {
              flags.verify = Boolean(value);
              return { verify: Boolean(value) };
            },
          });
        }
        if (!flags.verify && !flagWasSupplied(parsed, flags, ['fail-on-drift'])) {
          prompts.push({
            key: 'fail-on-drift',
            prompt: () =>
              flags.verify
                ? Promise.resolve(false)
                : promptBoolean('Fail when drift is found?', flags['fail-on-drift']),
          });
        }
      }
      if (
        flags.verbose &&
        flagWasSupplied(parsed, flags, ['verbose']) &&
        flagWasSupplied(parsed, flags, ['output']) &&
        flags.output !== 'human'
      ) {
        throw new SfError(messages.getMessage('errorVerboseNonHuman'));
      }
      if (!flags['target-org']) flags['target-org'] = await resolveOrgInteractively(undefined, promptOrgAlias);
      prompts.push({
        key: 'output',
        prompt: promptOutputFormat,
        assign: (_currentFlags, value) => {
          const output = value as UserDiffFlags['output'];
          flags.output = output;
          if (output !== 'human') {
            if (flags.verbose) throw new SfError(messages.getMessage('errorVerboseNonHuman'));
            return { output, verbose: false };
          }
          return { output };
        },
      });
      if (!flagWasSupplied(parsed, flags, ['verbose'])) {
        prompts.push({
          key: 'verbose',
          prompt: () =>
            flags.output === 'human'
              ? promptBoolean('Include unchanged assignments?', flags.verbose)
              : Promise.resolve(false),
        });
      }
      prompts.push(
        { key: 'output-file', prompt: () => promptOptionalText('Output file path') },
        { key: 'api-version', prompt: () => promptOptionalApiVersion(flags['api-version']) }
      );
      const resolved = await resolveFlagsInteractively(parsed, prompts, {
        log: (message) => this.log(message),
        confirm: () => this.confirm({ message: 'Proceed with these values?' }),
      });
      flags = resolved.flags;
      if (!resolved.confirmed) {
        return {
          summary: { total: 0, compared: 0, wouldCreate: 0, failed: 0, changed: 0 },
          users: [],
          rows: [],
          warnings: [],
        };
      }
    }
    const targetOrg = requireTargetOrg(flags['target-org']);
    requireExactlyOne(flags, ['user', 'users-def']);
    if (flags.user && flags['external-id']) {
      throw new SfError(messages.getMessage('errorExternalIdUserMode'));
    }
    if (flags.user && flags['personas-def']) {
      throw new SfError(messages.getMessage('errorPersonasUserMode'));
    }
    if (flags.verify && (flags.user ?? flags.against)) {
      throw new SfError(messages.getMessage('errorVerifyUserMode'));
    }
    requireFlagDependencies(flags, 'user', ['against']);
    requireFlagDependencies(flags, 'against', ['user']);
    if (flags.verbose && (flags.output === 'csv' || flags.output === 'json' || this.jsonEnabled())) {
      throw new SfError(messages.getMessage('errorVerboseNonHuman'));
    }
    const context = this.resolveOutputContext(flags);
    const conn = targetOrg.getConnection(flags['api-version'] ?? undefined);
    const diffResult =
      typeof flags.user === 'string'
        ? await executeUserToUserDiff({
            connection: conn,
            user: flags.user,
            against: flags.against as string,
          })
        : await UserDiff.runPersonaMode(
            conn,
            flags as UserDiffFlags & { 'users-def': string; 'personas-def'?: string }
          );

    if (flags.verify) {
      const lookup = messages.getMessage.bind(messages);
      const verdicts = verifyUserDiff(diffResult, lookup);
      await this.emitResult(context, {
        result: verdicts,
        csv: renderUserConformanceCsv(verdicts),
        human: renderUserConformanceHuman(verdicts, lookup),
      });
      if (verdicts.some((verdict) => !verdict.conformant)) process.exitCode = 1;
      return verdicts;
    }

    const csv = renderUserDiffCsv(diffResult);
    await this.emitResult(context, {
      result: diffResult,
      csv,
      human: renderUserDiffHuman(diffResult, messages.getMessage.bind(messages), { verbose: flags.verbose }),
    });
    if (diffResult.summary.failed > 0 || (flags['fail-on-drift'] && diffResult.summary.changed > 0)) {
      process.exitCode = 1;
    }
    return diffResult;
  }
}
