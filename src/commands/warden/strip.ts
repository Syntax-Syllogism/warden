import { Messages } from '@salesforce/core';
import { Flags } from '@salesforce/sf-plugins-core';
import { renderLifecycleResult } from '../../userLifecycle/output.js';
import { executeStrip, type StripFlags } from '../../userLifecycle/stripPlan.js';
import type { LifecycleResult } from '../../userLifecycle/types.js';
import { renderStripCsv } from '../../userShared/output.js';
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
import { describeUserFields } from '../../userShared/userFields.js';
import { WardenCommand } from '../../wardenCommand.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('@syntax-syllogism/warden', 'warden.strip');

export default class UserStrip extends WardenCommand<LifecycleResult> {
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
    'no-prompt': noPromptFlag,
    'dry-run': dryRunFlag,
    'no-freeze': Flags.boolean({ default: false, summary: messages.getMessage('flags.no-freeze.summary') }),
    'no-deactivate': Flags.boolean({ default: false, summary: messages.getMessage('flags.no-deactivate.summary') }),
    'keep-permsets': Flags.boolean({ default: false, summary: messages.getMessage('flags.keep-permsets.summary') }),
    'keep-permset-groups': Flags.boolean({
      default: false,
      summary: messages.getMessage('flags.keep-permset-groups.summary'),
    }),
    'keep-licenses': Flags.boolean({ default: false, summary: messages.getMessage('flags.keep-licenses.summary') }),
    'keep-public-groups': Flags.boolean({
      default: false,
      summary: messages.getMessage('flags.keep-public-groups.summary'),
    }),
    'keep-queues': Flags.boolean({ default: false, summary: messages.getMessage('flags.keep-queues.summary') }),
    snapshot: Flags.file({ summary: messages.getMessage('flags.snapshot.summary') }),
    ...outputFlags,
    'api-version': apiVersionFlag,
  };

  public async run(): Promise<LifecycleResult> {
    const { flags } = await this.parse(UserStrip);
    const context = this.resolveOutputContext(flags);
    const conn = flags['target-org'].getConnection(flags['api-version'] ?? undefined);
    const fieldMap = await describeUserFields(conn);
    const output = await executeStrip({
      conn,
      fieldMap,
      flags: flags as StripFlags,
      interactive: context.interactive,
      message: messages.getMessage.bind(messages),
      confirm: (message) => this.confirm({ message }),
      warn: (message) => this.warn(message),
    });
    await this.emitResult(context, {
      result: output,
      csv: renderStripCsv(output),
      human: renderLifecycleResult(output, messages.getMessage.bind(messages)),
    });
    if (output.summary.failed > 0) process.exitCode = 1;
    return output;
  }
}
