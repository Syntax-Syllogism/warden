import { Messages, SfError, type Connection } from '@salesforce/core';
import { Flags, SfCommand } from '@salesforce/sf-plugins-core';
import { readProvisionDefinitions } from '../../userProvisioning/definitionReader.js';
import {
  executePersonaDiff,
  executeUserToUserDiff,
  renderUserDiffCsv,
  renderUserDiffHuman,
  type UserDiffResult,
} from '../../userLifecycle/userDiff.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('@syntax-syllogism/warden', 'warden.diff');

type UserDiffFlags = {
  'target-org': { getConnection(apiVersion?: string): Connection };
  user?: string;
  against?: string;
  'users-def'?: string;
  'personas-def'?: string;
  'external-id'?: string;
  output: 'human' | 'csv' | 'json';
  verbose: boolean;
  'api-version'?: string;
};

export default class UserDiff extends SfCommand<UserDiffResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public static readonly flags = {
    'target-org': Flags.requiredOrg({ summary: messages.getMessage('flags.target-org.summary') }),
    user: Flags.string({
      exactlyOne: ['user', 'users-def'],
      dependsOn: ['against'],
      summary: messages.getMessage('flags.user.summary'),
    }),
    against: Flags.string({
      dependsOn: ['user'],
      summary: messages.getMessage('flags.against.summary'),
    }),
    'users-def': Flags.file({
      exists: true,
      exactlyOne: ['user', 'users-def'],
      dependsOn: ['personas-def'],
      summary: messages.getMessage('flags.users-def.summary'),
    }),
    'personas-def': Flags.file({
      exists: true,
      dependsOn: ['users-def'],
      summary: messages.getMessage('flags.personas-def.summary'),
    }),
    'external-id': Flags.string({ summary: messages.getMessage('flags.external-id.summary') }),
    output: Flags.string({
      options: ['human', 'csv', 'json'] as const,
      default: 'human',
      summary: messages.getMessage('flags.output.summary'),
    }),
    verbose: Flags.boolean({
      default: false,
      summary: messages.getMessage('flags.verbose.summary'),
    }),
    'api-version': Flags.orgApiVersion({ summary: messages.getMessage('flags.api-version.summary') }),
  };

  private static async runPersonaMode(
    conn: Connection,
    flags: UserDiffFlags & { 'users-def': string; 'personas-def': string }
  ): Promise<UserDiffResult> {
    const { usersDoc, personasDoc } = await readProvisionDefinitions(flags['users-def'], flags['personas-def']);
    return executePersonaDiff({
      connection: conn,
      usersDoc,
      personasDoc,
      externalId: flags['external-id'],
    });
  }

  public async run(): Promise<UserDiffResult> {
    const { flags } = (await this.parse(UserDiff)) as unknown as { flags: UserDiffFlags };
    const jsonOutput = this.jsonEnabled();
    if (flags.user && flags['external-id']) {
      throw new SfError(messages.getMessage('errorExternalIdUserMode'));
    }
    if (flags.verbose && (flags.output !== 'human' || jsonOutput)) {
      throw new SfError(messages.getMessage('errorVerboseNonHuman'));
    }
    const conn = flags['target-org'].getConnection(flags['api-version'] ?? undefined);
    const result =
      typeof flags.user === 'string'
        ? await executeUserToUserDiff({
            connection: conn,
            user: flags.user,
            against: flags.against as string,
          })
        : await UserDiff.runPersonaMode(conn, flags as UserDiffFlags & { 'users-def': string; 'personas-def': string });

    if (jsonOutput) return result;
    if (flags.output === 'csv') this.log(renderUserDiffCsv(result));
    else if (flags.output === 'json') this.log(JSON.stringify(result, null, 2));
    else this.log(renderUserDiffHuman(result, { verbose: flags.verbose }));
    return result;
  }
}
