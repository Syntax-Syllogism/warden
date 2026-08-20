import { Messages, SfError, type Connection } from '@salesforce/core';
import { Flags } from '@salesforce/sf-plugins-core';
import { detectInputFormat } from '../../userShared/csv.js';
import { readProvisionDefinitions } from '../../userProvisioning/definitionReader.js';
import {
  executePersonaDiff,
  executeUserToUserDiff,
  type UserDiffResult,
} from '../../userLifecycle/userDiff.js';
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
  csvListDelimiterFlag,
  externalIdFlag,
  inputFormatFlag,
  targetOrgFlag,
  usersDefFlag,
} from '../../userShared/targetFlags.js';
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
};

export type UserDiffCommandResult = UserDiffResult | UserConformanceVerdict[];

export default class UserDiff extends WardenCommand<UserDiffCommandResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public static readonly flags = {
    'target-org': targetOrgFlag,
    user: Flags.string({
      exactlyOne: ['user', 'users-def'],
      dependsOn: ['against'],
      summary: messages.getMessage('flags.user.summary'),
    }),
    against: Flags.string({
      dependsOn: ['user'],
      summary: messages.getMessage('flags.against.summary'),
    }),
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

  public async run(): Promise<UserDiffCommandResult> {
    const { flags } = (await this.parse(UserDiff)) as unknown as { flags: UserDiffFlags };
    if (flags.user && flags['external-id']) {
      throw new SfError(messages.getMessage('errorExternalIdUserMode'));
    }
    if (flags.user && flags['personas-def']) {
      throw new SfError(messages.getMessage('errorPersonasUserMode'));
    }
    if (flags.verify && (flags.user ?? flags.against)) {
      throw new SfError(messages.getMessage('errorVerifyUserMode'));
    }
    if (flags.verbose && ((flags.output === 'csv' || flags.output === 'json') || this.jsonEnabled())) {
      throw new SfError(messages.getMessage('errorVerboseNonHuman'));
    }
    const context = this.resolveOutputContext(flags);
    const conn = flags['target-org'].getConnection(flags['api-version'] ?? undefined);
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
