import { Messages } from '@salesforce/core';
import { renderLifecycleResult } from '../../userLifecycle/output.js';
import { buildTargetRequests } from '../../userLifecycle/targeting.js';
import { executeFreezeToggle, UNFREEZE } from '../../userLifecycle/freezeState.js';
import type { LifecycleResult } from '../../userLifecycle/types.js';
import { renderLifecycleCsv } from '../../userShared/output.js';
import { describeUserFields } from '../../userShared/userFields.js';
import { outputFlags } from '../../userShared/outputFlags.js';
import {
  apiVersionFlag,
  csvListDelimiterFlag,
  dryRunFlag,
  externalIdFlag,
  inputFormatFlag,
  noPromptFlag,
  targetOrgFlag,
  userFlag,
  usersDefFlag,
} from '../../userShared/targetFlags.js';
import { WardenCommand } from '../../wardenCommand.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('@syntax-syllogism/warden', 'warden.unfreeze');

export default class UserUnfreeze extends WardenCommand<LifecycleResult> {
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
    ...outputFlags,
    'no-prompt': noPromptFlag,
    'dry-run': dryRunFlag,
    'api-version': apiVersionFlag,
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
    const output = await executeFreezeToggle({
      conn,
      fieldMap,
      requests,
      requestErrors,
      direction: UNFREEZE,
      dryRun: flags['dry-run'],
      noPrompt: flags['no-prompt'],
      interactive: context.interactive,
      message: messages.getMessage.bind(messages),
      confirm: (message) => this.confirm({ message }),
      warn: (message) => this.warn(message),
    });
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
