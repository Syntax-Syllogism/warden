import { Messages, SfError } from '@salesforce/core';
import { Flags } from '@salesforce/sf-plugins-core';
import { describeUserFields } from '../../userShared/userFields.js';
import { parseUserFlag, resolveTargetField, resolveTargets } from '../../userLifecycle/targeting.js';
import type { ResolvedTargetUser } from '../../userLifecycle/types.js';
import { serializeCsv } from '../../userShared/csv.js';
import { outputFlags } from '../../userShared/outputFlags.js';
import {
  apiVersionFlag,
  assertInteractiveAllowed,
  flagWasSupplied,
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
  promptAccessMode,
  promptAccessType,
  promptAccessUserScope,
  promptOptionalApiVersion,
  promptOptionalText,
  promptOrgAlias,
  promptOutputFormat,
  promptText,
} from '../../userShared/prompting.js';
import {
  flattenAccessRow,
  renderEnabledTable,
  renderFieldTable,
  renderObjectTable,
  renderRecordTypeTable,
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
  'record-type': 'Record Type',
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
    else if (result.targetType === 'record-type') lines.push(renderRecordTypeTable(sortedRows));
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
    'target-org': targetOrgFlag,
    type: Flags.string({
      options: ['field', 'object', 'apex-class', 'vf-page', 'custom-permission', 'tab', 'record-type'] as const,
      summary: messages.getMessage('flags.type.summary'),
    }),
    target: Flags.string({ summary: messages.getMessage('flags.target.summary') }),
    user: Flags.string({ summary: messages.getMessage('flags.user.summary') }),
    sobject: Flags.string({ summary: messages.getMessage('flags.sobject.summary') }),
    ...outputFlags,
    'api-version': apiVersionFlag,
    interactive: interactiveFlag,
  };

  // eslint-disable-next-line complexity
  public async run(): Promise<UserAccessResult> {
    const parsed = await this.parse(UserAccess);
    let { flags } = parsed;
    assertInteractiveAllowed(flags.interactive, !this.jsonEnabled());
    let context = this.resolveOutputContext(flags);
    if (flags.interactive) {
      const prompts: InteractivePrompt[] = [];
      const parsedInteractive = parsed as InteractiveParse<typeof flags>;
      const hasUserScope = flagWasSupplied(parsedInteractive, flags, ['user', 'sobject']);
      const hasTarget = flagWasSupplied(parsedInteractive, flags, ['target']);
      // A supplied --sobject only works for the field and object audits, so a
      // contradictory scope or type has to fail before anything is collected or
      // summarized, with the message the flag-only path raises for the same input.
      const hasSobject = flagWasSupplied(parsedInteractive, flags, ['sobject']);
      if (hasUserScope && hasTarget && hasSobject) {
        throw new SfError(messages.getMessage('errorUserModeScopesMutuallyExclusive'));
      }
      const hasType = flagWasSupplied(parsedInteractive, flags, ['type']);
      if (hasSobject && hasType && flags.type !== 'field' && flags.type !== 'object') {
        throw new SfError(messages.getMessage('errorSobjectUnsupported', [flags.type as string]));
      }
      const mode = hasUserScope ? 'user' : hasTarget ? 'target' : await promptAccessMode();
      // The type prompt must not offer a choice that would fail the same way.
      if (!hasType) flags.type = await promptAccessType(hasSobject ? ['field', 'object'] : undefined);
      if (mode === 'target') {
        if (!flagWasSupplied(parsedInteractive, flags, ['target'])) {
          prompts.push({ key: 'target', prompt: () => promptText('Access target') });
        }
      } else {
        if (!flagWasSupplied(parsedInteractive, flags, ['user'])) {
          prompts.push({ key: 'user', prompt: () => promptText('User match (field:value)') });
        }
        const scope = flagWasSupplied(parsedInteractive, flags, ['sobject'])
          ? 'sobject'
          : flagWasSupplied(parsedInteractive, flags, ['target'])
          ? 'target'
          : await promptAccessUserScope(flags.type === 'field' || flags.type === 'object');
        if (scope === 'target') {
          if (!flagWasSupplied(parsedInteractive, flags, ['target'])) {
            prompts.push({ key: 'target', prompt: () => promptText('Access target') });
          }
        } else if (!flagWasSupplied(parsedInteractive, flags, ['sobject'])) {
          prompts.push({ key: 'sobject', prompt: () => promptText('SObject API name') });
        }
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
      if (!resolved.confirmed) {
        return {
          targetType: (flags.type ?? 'field') as AccessTargetType,
          targetName: '',
          rows: [],
          stats: {
            totalActiveUsersWithAccess: 0,
            profileGrants: 0,
            permissionSetGrants: 0,
            permissionSetGroupGrants: 0,
          },
          warnings: [],
        };
      }
      context = this.resolveOutputContext(flags);
    }
    const targetOrg = requireTargetOrg(flags['target-org']);
    const type = requireFlagValue(flags.type, '--type') as AccessTargetType;
    const { format, outputFile } = context;
    const conn = targetOrg.getConnection(flags['api-version'] ?? undefined);
    try {
      const userMode = typeof flags.user === 'string' && flags.user.length > 0;
      const hasTarget = typeof flags.target === 'string' && flags.target.length > 0;
      const hasSobject = typeof flags.sobject === 'string' && flags.sobject.length > 0;
      if (hasTarget && hasSobject) throw new SfError(messages.getMessage('errorUserModeScopesMutuallyExclusive'));
      if (!userMode && hasSobject) throw new SfError(messages.getMessage('errorSobjectRequiresUser'));
      if (!userMode && !hasTarget) throw new SfError(messages.getMessage('errorTargetRequired'));
      if (userMode && !hasTarget && !hasSobject) throw new SfError(messages.getMessage('errorUserModeRequiresScope'));

      const resolver = getResolver(type);
      let validatedTarget: ValidatedAccessTarget;
      if (hasTarget) {
        validatedTarget = await resolver.validateTarget(conn, flags.target as string);
      } else {
        if (type !== 'field' && type !== 'object') {
          throw new SfError(messages.getMessage('errorSobjectUnsupported', [type]));
        }
        const objectTarget = await getResolver('object').validateTarget(conn, flags.sobject as string);
        validatedTarget = { ...objectTarget, type };
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
      if (error instanceof UserAccessError) {
        const message = messages.getMessage(error.code, error.args);
        const detail = error.cause instanceof Error ? error.cause.message : undefined;
        throw new SfError(detail ? `${message} Underlying error: ${detail}` : message, 'UserAccessError', [], 1, error.cause);
      }
      if (error instanceof SfError) throw error;
      throw new SfError(messages.getMessage('errorAccessQueryFailed', [type, flags.target ?? flags.sobject ?? '']));
    }
  }
}
