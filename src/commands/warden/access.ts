import { Messages, SfError } from '@salesforce/core';
import { Flags, SfCommand } from '@salesforce/sf-plugins-core';
import { renderEnabledTable, renderFieldTable, renderObjectTable, renderTabTable, serializeCsv } from '../../userAccess/output.js';
import { getResolver } from '../../userAccess/resolvers/index.js';
import type { AccessTargetType, UserAccessResult, UserAccessRow } from '../../userAccess/types.js';
import { UserAccessError } from '../../userAccess/types.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('@syntax-syllogism/warden', 'warden.access');

const sortedForHuman = (rows: UserAccessRow[]): UserAccessRow[] =>
  [...rows].sort(
    (a, b) =>
      a.userName.localeCompare(b.userName) ||
      a.userId.localeCompare(b.userId) ||
      a.assignmentType.localeCompare(b.assignmentType) ||
      a.sourceName.localeCompare(b.sourceName) ||
      (a.viaPermissionSetName ?? '').localeCompare(b.viaPermissionSetName ?? '')
  );

const targetLabels: Record<AccessTargetType, string> = {
  field: 'Field',
  object: 'Object',
  'apex-class': 'Apex Class',
  'vf-page': 'Visualforce Page',
  'custom-permission': 'Custom Permission',
  tab: 'Tab',
};

const renderHuman = (result: UserAccessResult): string => {
  const sortedRows = sortedForHuman(result.rows);
  const lines = [
    `${targetLabels[result.targetType]}: ${result.targetName}`,
    `Active users with access: ${result.stats.totalActiveUsersWithAccess}`,
    `Profiles: ${result.stats.profileGrants} | Permission Sets: ${result.stats.permissionSetGrants} | Permission Set Groups: ${result.stats.permissionSetGroupGrants}`,
  ];
  if (result.warnings.length > 0) {
    lines.push('');
    for (const warning of result.warnings) lines.push(`Warning: ${warning}`);
  }
  if (sortedRows.length > 0) {
    lines.push('');
    if (result.targetType === 'field') lines.push(renderFieldTable(sortedRows));
    else if (result.targetType === 'object') lines.push(renderObjectTable(sortedRows));
    else if (result.targetType === 'tab') lines.push(renderTabTable(sortedRows));
    else lines.push(renderEnabledTable(sortedRows));
  } else if (result.warnings.length === 0) {
    lines.push('');
    lines.push(messages.getMessage('info.noResults'));
  }
  return lines.join('\n');
};

export default class UserAccess extends SfCommand<UserAccessResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public static readonly flags = {
    'target-org': Flags.requiredOrg({ summary: messages.getMessage('flags.target-org.summary') }),
    type: Flags.string({
      required: true,
      options: ['field', 'object', 'apex-class', 'vf-page', 'custom-permission', 'tab'] as const,
      summary: messages.getMessage('flags.type.summary'),
    }),
    target: Flags.string({ required: true, summary: messages.getMessage('flags.target.summary') }),
    output: Flags.string({
      required: false,
      options: ['human', 'csv', 'json'] as const,
      default: 'human',
      summary: messages.getMessage('flags.output.summary'),
    }),
    'api-version': Flags.orgApiVersion({ summary: messages.getMessage('flags.api-version.summary') }),
  };

  public async run(): Promise<UserAccessResult> {
    const { flags } = await this.parse(UserAccess);
    const conn = flags['target-org'].getConnection(flags['api-version'] ?? undefined);
    try {
      const resolver = getResolver(flags.type);
      const validatedTarget = await resolver.validateTarget(conn, flags.target);
      const result = await resolver.resolve(conn, validatedTarget);

      if (this.jsonEnabled()) return result;

      if (flags.output === 'csv') this.log(serializeCsv(result.rows, resolver.csvColumns()));
      else if (flags.output === 'json') this.log(JSON.stringify(result, null, 2));
      else this.log(renderHuman(result));
      return result;
    } catch (error) {
      if (error instanceof UserAccessError) throw new SfError(messages.getMessage(error.code, error.args));
      if (error instanceof SfError) throw error;
      throw new SfError(messages.getMessage('errorAccessQueryFailed', [flags.type as AccessTargetType, flags.target]));
    }
  }
}
