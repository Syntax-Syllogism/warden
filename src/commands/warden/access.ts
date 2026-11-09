import { Messages, SfError } from '@salesforce/core';
import { Flags } from '@salesforce/sf-plugins-core';
import { renderAccessResult } from '@syntax-syllogism/warden-core';
import type { AccessTargetType, UserAccessResult } from '@syntax-syllogism/warden-core';
import { UserAccessError } from '@syntax-syllogism/warden-core';
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
import { outputFlags } from '../../userShared/outputFlags.js';
import { AccessRequestError, runAccessRequest } from '../../userShared/accessRequest.js';
import { WardenCommand } from '../../wardenCommand.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('@syntax-syllogism/warden', 'warden.access');

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
      const request = await runAccessRequest(conn, {
        type,
        target: flags.target,
        user: flags.user,
        sobject: flags.sobject,
      });
      const { result: orderedResult, csv, resolvedUser } = request;
      if (format === 'csv' && !outputFile) {
        this.warn(
          `Stats: active users with access ${orderedResult.stats.totalActiveUsersWithAccess}; profiles ${orderedResult.stats.profileGrants}; permission sets ${orderedResult.stats.permissionSetGrants}; permission set groups ${orderedResult.stats.permissionSetGroupGrants}`
        );
        for (const warning of orderedResult.warnings) this.warn(`Warning: ${warning}`);
      }
      await this.emitResult(context, {
        result: orderedResult,
        csv,
        human: renderAccessResult(orderedResult, resolvedUser?.name),
      });
      return orderedResult;
    } catch (error) {
      if (error instanceof AccessRequestError) throw new SfError(error.message);
      if (error instanceof UserAccessError) {
        const message = messages.getMessage(error.code, error.args);
        const detail = error.cause instanceof Error ? error.cause.message : undefined;
        throw new SfError(
          detail ? `${message} Underlying error: ${detail}` : message,
          'UserAccessError',
          [],
          1,
          error.cause
        );
      }
      if (error instanceof SfError) throw error;
      throw new SfError(messages.getMessage('errorAccessQueryFailed', [type, flags.target ?? flags.sobject ?? '']));
    }
  }
}
