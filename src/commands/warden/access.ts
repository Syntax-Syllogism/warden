import { Messages, SfError } from '@salesforce/core';
import { Flags } from '@salesforce/sf-plugins-core';
import { describeUserFields } from '../../userShared/userFields.js';
import { parseUserFlag, resolveTargetField, resolveTargets } from '../../userLifecycle/targeting.js';
import type { ResolvedTargetUser } from '../../userLifecycle/types.js';
import { serializeCsv } from '../../userShared/csv.js';
import { outputFlags } from '../../userShared/outputFlags.js';
import {
  flattenAccessRow,
  renderEnabledTable,
  renderFieldTable,
  renderObjectTable,
  renderTabTable,
} from '../../userAccess/output.js';
import { getResolver } from '../../userAccess/resolvers/index.js';
import { resolveReverseAccess, reverseCsvColumns } from '../../userAccess/reverse.js';
import type {
  AccessTargetType,
  UserAccessResult,
  UserAccessRow,
  ValidatedAccessTarget,
} from '../../userAccess/types.js';
import { UserAccessError } from '../../userAccess/types.js';
import { WardenCommand } from '../../wardenCommand.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('@syntax-syllogism/warden', 'warden.access');

const stableOrder = (rows: UserAccessRow[]): UserAccessRow[] =>
  [...rows].sort(
    (a, b) =>
      a.userName.localeCompare(b.userName) ||
      a.userId.localeCompare(b.userId) ||
      a.targetName.localeCompare(b.targetName) ||
      a.assignmentType.localeCompare(b.assignmentType) ||
      a.sourceName.localeCompare(b.sourceName) ||
      (a.viaPermissionSetName ?? '').localeCompare(b.viaPermissionSetName ?? '') ||
      JSON.stringify(a.access).localeCompare(JSON.stringify(b.access)) ||
      a.sourceId.localeCompare(b.sourceId) ||
      (a.viaPermissionSetId ?? '').localeCompare(b.viaPermissionSetId ?? '')
  );

const targetLabels: Record<AccessTargetType, string> = {
  field: 'Field',
  object: 'Object',
  'apex-class': 'Apex Class',
  'vf-page': 'Visualforce Page',
  'custom-permission': 'Custom Permission',
  tab: 'Tab',
};

const renderHuman = (result: UserAccessResult, userLabel?: string): string => {
  const sortedRows = stableOrder(result.rows);
  const lines = userLabel
    ? [
        `Access for ${userLabel}: ${result.targetName}`,
        `Accessible grants: ${sortedRows.length}`,
        `Profiles: ${result.stats.profileGrants} | Permission Sets: ${result.stats.permissionSetGrants} | Permission Set Groups: ${result.stats.permissionSetGroupGrants}`,
      ]
    : [
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
    if (result.targetType === 'field') {
      const showFieldTarget = Boolean(userLabel && !result.fieldApiName);
      lines.push(renderFieldTable(sortedRows, showFieldTarget));
    } else if (result.targetType === 'object') lines.push(renderObjectTable(sortedRows));
    else if (result.targetType === 'tab') lines.push(renderTabTable(sortedRows));
    else lines.push(renderEnabledTable(sortedRows));
  } else if (result.warnings.length === 0) {
    lines.push('');
    lines.push(messages.getMessage(userLabel ? 'info.noUserResults' : 'info.noResults'));
  }
  return lines.join('\n');
};

export default class UserAccess extends WardenCommand<UserAccessResult> {
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
    target: Flags.string({ summary: messages.getMessage('flags.target.summary') }),
    user: Flags.string({ summary: messages.getMessage('flags.user.summary') }),
    sobject: Flags.string({ summary: messages.getMessage('flags.sobject.summary') }),
    ...outputFlags,
    'api-version': Flags.orgApiVersion({ summary: messages.getMessage('flags.api-version.summary') }),
  };

  // eslint-disable-next-line complexity
  public async run(): Promise<UserAccessResult> {
    const { flags } = await this.parse(UserAccess);
    const context = this.resolveOutputContext(flags);
    const { format, outputFile } = context;
    const conn = flags['target-org'].getConnection(flags['api-version'] ?? undefined);
    try {
      const userMode = typeof flags.user === 'string' && flags.user.length > 0;
      const hasTarget = typeof flags.target === 'string' && flags.target.length > 0;
      const hasSobject = typeof flags.sobject === 'string' && flags.sobject.length > 0;
      if (hasTarget && hasSobject) throw new SfError(messages.getMessage('errorUserModeScopesMutuallyExclusive'));
      if (!userMode && hasSobject) throw new SfError(messages.getMessage('errorSobjectRequiresUser'));
      if (!userMode && !hasTarget) throw new SfError(messages.getMessage('errorTargetRequired'));
      if (userMode && !hasTarget && !hasSobject) throw new SfError(messages.getMessage('errorUserModeRequiresScope'));

      const resolver = getResolver(flags.type);
      let validatedTarget: ValidatedAccessTarget;
      if (hasTarget) {
        validatedTarget = await resolver.validateTarget(conn, flags.target as string);
      } else {
        if (flags.type !== 'field' && flags.type !== 'object') {
          throw new SfError(messages.getMessage('errorSobjectUnsupported', [flags.type]));
        }
        const objectTarget = await getResolver('object').validateTarget(conn, flags.sobject as string);
        validatedTarget = { ...objectTarget, type: flags.type };
      }

      let user: ResolvedTargetUser | undefined;
      if (userMode) {
        let parsedUser: { field: string; value: string };
        try {
          parsedUser = parseUserFlag(flags.user as string);
        } catch {
          throw new SfError(messages.getMessage('errorInvalidUserValue', [flags.user as string]));
        }
        const fieldMap = await describeUserFields(conn);
        const matchField = resolveTargetField(parsedUser.field, fieldMap);
        if (!matchField) throw new SfError(messages.getMessage('errorInvalidUserMatchField', [parsedUser.field]));
        const resolution = await resolveTargets(
          conn,
          [{ key: `${matchField}:${parsedUser.value}`, field: matchField, value: parsedUser.value, order: 0 }],
          fieldMap
        );
        if (resolution.errors.length > 0) throw new SfError(resolution.errors[0].message);
        user = resolution.targets[0];
        if (!user) throw new SfError(messages.getMessage('errorUserResolutionFailed'));
      }

      const result = user
        ? await resolveReverseAccess(
            conn,
            { Id: user.Id, name: user.name ?? user.Id, username: user.username ?? '' },
            validatedTarget
          )
        : await resolver.resolve(conn, validatedTarget);
      const orderedResult = { ...result, rows: stableOrder(result.rows) };
      const columns = user ? reverseCsvColumns(result.targetType) : resolver.csvColumns();
      const csv = serializeCsv(
        orderedResult.rows.map((row) => flattenAccessRow(row, columns)),
        columns
      );
      if (format === 'csv' && !outputFile) {
        this.warn(
          `Stats: active users with access ${orderedResult.stats.totalActiveUsersWithAccess}; profiles ${orderedResult.stats.profileGrants}; permission sets ${orderedResult.stats.permissionSetGrants}; permission set groups ${orderedResult.stats.permissionSetGroupGrants}`
        );
        for (const warning of orderedResult.warnings) this.warn(`Warning: ${warning}`);
      }
      await this.emitResult(context, {
        result: orderedResult,
        csv,
        human: renderHuman(orderedResult, user?.name),
      });
      return orderedResult;
    } catch (error) {
      if (error instanceof UserAccessError) throw new SfError(messages.getMessage(error.code, error.args));
      if (error instanceof SfError) throw error;
      throw new SfError(
        messages.getMessage('errorAccessQueryFailed', [
          flags.type as AccessTargetType,
          flags.target ?? flags.sobject ?? '',
        ])
      );
    }
  }
}
