import { Messages, SfError } from '@salesforce/core';
import { Flags, SfCommand } from '@salesforce/sf-plugins-core';
import { buildFieldMap, type UserFieldMeta } from '../../userProvisioning/planner.js';
import { renderLifecycleResult } from '../../userLifecycle/output.js';
import {
  extractDefTargets,
  parseUserFlag,
  resolveTargetField,
  resolveTargets,
} from '../../userLifecycle/targeting.js';
import type {
  LifecycleNotice,
  LifecycleResult,
  LifecycleUserResult,
  TargetError,
  TargetRequest,
} from '../../userLifecycle/types.js';
import { asArray, esc, pushErrors, readJsonOrThrow } from '../../userShared/sfUtils.js';
import { confirmWithTimeout } from '../../userShared/prompt.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('@syntax-syllogism/warden', 'warden.freeze');

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

const makeNotice = (key: string, count?: number): LifecycleNotice => (count === undefined ? { key } : { key, count });

const summarize = (users: LifecycleUserResult[]): LifecycleResult['summary'] => ({
  total: users.length,
  changed: users.filter((user) => user.status === 'changed' || user.status === 'planned').length,
  unchanged: users.filter((user) => user.status === 'unchanged').length,
  failed: users.filter((user) => user.status === 'failed').length,
});

const targetFromError = (error: TargetError): LifecycleUserResult => ({
  key: error.key,
  status: 'failed',
  actions: [],
  skipped: [],
  warnings: [],
  errors: [error.message],
});

const targetFromRow = (row: { key: string; Id: string; IsActive: boolean }): LifecycleUserResult => ({
  key: row.key,
  id: row.Id,
  status: 'unchanged',
  actions: [],
  skipped: [],
  warnings: [],
  errors: [],
});

const buildRequests = async (
  flags: Record<string, unknown>,
  fieldMap: Map<string, UserFieldMeta>
): Promise<{ requests: TargetRequest[]; errors: TargetError[] }> => {
  if (typeof flags.user === 'string' && flags.user.length > 0) {
    const { field, value } = parseUserFlag(flags.user);
    const matchField = resolveTargetField(field, fieldMap);
    if (!matchField) throw new SfError(messages.getMessage('errorInvalidUserMatchField', [field]));
    return { requests: [{ key: `${matchField}:${value}`, field: matchField, value, order: 0 }], errors: [] };
  }

  const usersDoc = (await readJsonOrThrow(String(flags['users-def']), (path, error) =>
    messages.getMessage('errorInvalidJson', [path, error])
  )) as { users?: unknown };
  return extractDefTargets(
    usersDoc,
    typeof flags['external-id'] === 'string' ? flags['external-id'] : undefined,
    fieldMap
  );
};

export default class UserFreeze extends SfCommand<LifecycleResult> {
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
    'no-prompt': Flags.boolean({ default: false, summary: messages.getMessage('flags.no-prompt.summary') }),
    'dry-run': Flags.boolean({ default: false, summary: messages.getMessage('flags.dry-run.summary') }),
    'api-version': Flags.orgApiVersion({ summary: messages.getMessage('flags.api-version.summary') }),
  };

  public async run(): Promise<LifecycleResult> {
    const { flags } = await this.parse(UserFreeze);
    const conn = flags['target-org'].getConnection(flags['api-version'] ?? undefined);
    const userDescribe = await conn.describe('User');
    const fieldMap = buildFieldMap(
      userDescribe.fields.map(
        (field): UserFieldMeta => ({
          name: field.name,
          createable: field.createable,
          updateable: field.updateable,
          externalId: field.externalId,
        })
      )
    );

    const { requests, errors: requestErrors } = await buildRequests(flags as Record<string, unknown>, fieldMap);
    const { targets, errors: resolutionErrors } = await resolveTargets(conn, requests);

    const results: LifecycleUserResult[] = [];
    for (const error of requestErrors.concat(resolutionErrors)) results.push(targetFromError(error));

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
      const result = targetFromRow(target);
      const loginRow = loginRowsByUserId.get(target.Id);
      if (!loginRow) {
        result.warnings.push(messages.getMessage('warningMissingUserLogin'));
        results.push(result);
        continue;
      }
      if (loginRow.IsFrozen) {
        result.actions.push(makeNotice('alreadyFrozen'));
        results.push(result);
        continue;
      }
      if (flags['dry-run']) {
        result.status = 'planned';
        result.actions.push(makeNotice('wouldFreeze'));
        results.push(result);
        continue;
      }
      pendingUpdates.push({ resultIndex, row: { Id: loginRow.Id, IsFrozen: true }, actionKey: 'frozen' });
      results.push(result);
    }

    if (!flags['dry-run'] && pendingUpdates.length > 0 && !flags['no-prompt'] && !this.jsonEnabled()) {
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

    const output: LifecycleResult = { summary: summarize(results), users: results };
    if (!this.jsonEnabled()) this.log(renderLifecycleResult(output, messages.getMessage.bind(messages)));
    return output;
  }
}
