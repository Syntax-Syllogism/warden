import { Messages, SfError } from '@salesforce/core';
import { Flags } from '@salesforce/sf-plugins-core';
import {
  failedResult,
  makeNotice,
  renderLifecycleResult,
  resolvedTargetResult,
  summarizeLifecycle,
} from '../../userLifecycle/output.js';
import { buildTargetRequests, resolveTargets } from '../../userLifecycle/targeting.js';
import type { LifecycleResult, LifecycleUserResult } from '../../userLifecycle/types.js';
import { asArray, esc, pushErrors } from '../../userShared/sfUtils.js';
import { confirmWithTimeout } from '../../userShared/prompt.js';
import { renderLifecycleCsv } from '../../userShared/output.js';
import { describeUserFields } from '../../userShared/userFields.js';
import { outputFlags } from '../../userShared/outputFlags.js';
import { WardenCommand } from './base.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('@syntax-syllogism/warden', 'warden.unfreeze');

type UserLoginRow = {
  Id: string;
  UserId: string;
  IsFrozen: boolean;
};

type PendingUpdate = {
  resultIndex: number;
  row: { Id: string; IsFrozen: boolean };
  actionKey: 'frozen' | 'unfrozen';
};

export default class UserUnfreeze extends WardenCommand<LifecycleResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public static readonly flags = {
    'target-org': Flags.requiredOrg({ summary: messages.getMessage('flags.target-org.summary') }),
    user: Flags.string({ exactlyOne: ['user', 'users-def'], summary: messages.getMessage('flags.user.summary') }),
    'users-def': Flags.file({
      exists: true,
      exactlyOne: ['user', 'users-def'],
      summary: messages.getMessage('flags.users-def.summary'),
    }),
    'external-id': Flags.string({ summary: messages.getMessage('flags.external-id.summary') }),
    'input-format': Flags.string({
      options: ['json', 'csv'] as const,
      summary: messages.getMessage('flags.input-format.summary'),
    }),
    'csv-list-delimiter': Flags.string({ summary: messages.getMessage('flags.csv-list-delimiter.summary') }),
    ...outputFlags,
    'no-prompt': Flags.boolean({ default: false, summary: messages.getMessage('flags.no-prompt.summary') }),
    'dry-run': Flags.boolean({ default: false, summary: messages.getMessage('flags.dry-run.summary') }),
    'api-version': Flags.orgApiVersion({ summary: messages.getMessage('flags.api-version.summary') }),
  };

  public async run(): Promise<LifecycleResult> {
    const { flags } = await this.parse(UserUnfreeze);
    const context = this.resolveOutputContext(flags);
    const conn = flags['target-org'].getConnection(flags['api-version'] ?? undefined);
    const fieldMap = await describeUserFields(conn);

    const { requests, errors: requestErrors } = await buildTargetRequests(flags, fieldMap, {
      invalidUserMatchField: (field) => messages.getMessage('errorInvalidUserMatchField', [field]),
      invalidJson: (path, error) => messages.getMessage('errorInvalidJson', [path, error]),
    });
    const { targets, errors: resolutionErrors } = await resolveTargets(conn, requests, fieldMap);

    const results: LifecycleUserResult[] = [];
    for (const error of requestErrors.concat(resolutionErrors)) results.push(failedResult(error));

    const loginRows =
      targets.length > 0
        ? (
            await conn.query<UserLoginRow>(
              `SELECT Id, UserId, IsFrozen FROM UserLogin WHERE UserId IN (${targets
                .map((target) => `'${esc(target.Id)}'`)
                .join(',')})`
            )
          ).records
        : [];
    const loginRowsByUserId = new Map<string, UserLoginRow>();
    for (const row of loginRows) loginRowsByUserId.set(row.UserId, row);

    const pendingUpdates: PendingUpdate[] = [];
    for (const target of targets) {
      const resultIndex = results.length;
      const loginRow = loginRowsByUserId.get(target.Id);
      const result = resolvedTargetResult(target, loginRow);
      if (!loginRow) {
        result.warnings.push(messages.getMessage('warningMissingUserLogin'));
        results.push(result);
        continue;
      }
      if (!loginRow.IsFrozen) {
        result.actions.push(makeNotice('alreadyUnfrozen'));
        results.push(result);
        continue;
      }
      if (flags['dry-run']) {
        result.status = 'planned';
        result.actions.push(makeNotice('wouldUnfreeze'));
        results.push(result);
        continue;
      }
      pendingUpdates.push({ resultIndex, row: { Id: loginRow.Id, IsFrozen: false }, actionKey: 'unfrozen' });
      results.push(result);
    }

    if (!flags['dry-run'] && pendingUpdates.length > 0 && !flags['no-prompt'] && context.interactive) {
      const { confirmed, timedOut } = await confirmWithTimeout(
        (message) => this.confirm({ message }),
        messages.getMessage('promptContinue')
      );
      if (!confirmed) {
        if (timedOut) this.warn(messages.getMessage('warningPromptTimeout'));
        throw new SfError(messages.getMessage('errorPromptDeclined'));
      }
    }

    if (!flags['dry-run'] && pendingUpdates.length > 0) {
      const updateResults = asArray(
        await conn.sobject('UserLogin').update(
          pendingUpdates.map((pending) => pending.row),
          { allOrNone: false }
        )
      );
      updateResults.forEach((saveResult, index) => {
        const pending = pendingUpdates[index];
        const result = results[pending.resultIndex];
        if (saveResult.success) {
          result.status = 'changed';
          result.actions.push(makeNotice(pending.actionKey));
        } else {
          result.status = 'failed';
          pushErrors(result.errors, saveResult);
        }
      });
    }

    const output: LifecycleResult = { summary: summarizeLifecycle(results), users: results };
    const csv = renderLifecycleCsv(output);
    await this.emitResult(context, {
      result: output,
      csv,
      human: renderLifecycleResult(output, messages.getMessage.bind(messages)),
    });
    if (output.summary.failed > 0) process.exitCode = 1;
    return output;
  }
}
