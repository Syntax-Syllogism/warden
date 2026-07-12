import { Messages, SfError } from '@salesforce/core';
import { Flags, SfCommand } from '@salesforce/sf-plugins-core';
import { confirmWithTimeout } from '../../userShared/prompt.js';
import { readProvisionDefinitions } from '../../userProvisioning/definitionReader.js';
import { ProvisionUserUseCase, type ProvisionResult } from '../../userProvisioning/provisionUserUseCase.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('@syntax-syllogism/warden', 'warden.provision');

export default class UserProvision extends SfCommand<ProvisionResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public static readonly flags = {
    'target-org': Flags.requiredOrg({ summary: messages.getMessage('flags.target-org.summary') }),
    'users-def': Flags.file({ required: true, exists: true, summary: messages.getMessage('flags.users-def.summary') }),
    'personas-def': Flags.file({
      required: true,
      exists: true,
      summary: messages.getMessage('flags.personas-def.summary'),
    }),
    'external-id': Flags.string({ summary: messages.getMessage('flags.external-id.summary') }),
    'no-prompt': Flags.boolean({ default: false, summary: messages.getMessage('flags.no-prompt.summary') }),
    'dry-run': Flags.boolean({ default: false, summary: messages.getMessage('flags.dry-run.summary') }),
    'api-version': Flags.orgApiVersion({ summary: messages.getMessage('flags.api-version.summary') }),
  };

  public async run(): Promise<ProvisionResult> {
    const { flags } = await this.parse(UserProvision);
    const conn = flags['target-org'].getConnection(flags['api-version'] ?? undefined);
    const { usersDoc, personasDoc } = await readProvisionDefinitions(flags['users-def'], flags['personas-def']);
    const useCase = new ProvisionUserUseCase();

    const output = await useCase.execute({
      connection: conn,
      usersDoc,
      personasDoc,
      externalId: flags['external-id'],
      dryRun: flags['dry-run'],
      acknowledgeWarnings: this.shouldHandleWarnings()
        ? (warnings): Promise<void> => this.acknowledgeWarnings(warnings, flags['no-prompt'])
        : undefined,
    });

    this.writeHumanOutput(output);
    return output;
  }

  private shouldHandleWarnings(): boolean {
    return !this.jsonEnabled();
  }

  private async acknowledgeWarnings(warnings: string[], noPrompt: boolean): Promise<void> {
    for (const warning of warnings) this.warn(warning);
    if (noPrompt) return;
    const { confirmed } = await confirmWithTimeout(
      (message) => this.confirm({ message }),
      messages.getMessage('promptWarningsContinue')
    );
    if (!confirmed) {
      this.warn(messages.getMessage('warningPromptTimeout'));
      throw new SfError(messages.getMessage('errorPromptDeclined'));
    }
  }

  private writeHumanOutput(output: ProvisionResult): void {
    if (this.jsonEnabled()) return;
    for (const user of output.users) {
      if (user.errors.length > 0) {
        this.warn(messages.getMessage('warningUserFailed', [user.key, user.errors.join('; ')]));
      }
    }
    this.log(
      messages.getMessage('info.summary', [
        output.summary.total,
        output.summary.created,
        output.summary.updated,
        output.summary.failed,
      ])
    );
  }
}
