import { Messages } from '@salesforce/core';
import { Flags } from '@salesforce/sf-plugins-core';
import { apiVersionFlag, requireTargetOrg, targetOrgFlag } from '../../../userShared/targetFlags.js';
import {
  diffPersonaDocuments,
  readOrgPersonas,
  readPersonaFile,
  renderPersonaDiff,
  type PersonaDiff,
} from '../../../userShared/personas.js';
import { WardenCommand } from '../../../wardenCommand.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('@syntax-syllogism/warden', 'warden.persona.diff');

export default class PersonaDiffCommand extends WardenCommand<PersonaDiff> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');

  public static readonly flags = {
    'target-org': targetOrgFlag,
    input: Flags.file({ exists: true, required: true, summary: messages.getMessage('flags.input.summary') }),
    'api-version': apiVersionFlag,
  };

  public async run(): Promise<PersonaDiff> {
    const { flags } = await this.parse(PersonaDiffCommand);
    const targetOrg = requireTargetOrg(flags['target-org']);
    const [file, org] = await Promise.all([
      readPersonaFile(flags.input),
      readOrgPersonas(targetOrg.getConnection(flags['api-version'])),
    ]);
    const result = diffPersonaDocuments(file, org.document);
    if (!this.jsonEnabled()) this.log(renderPersonaDiff(result));
    return result;
  }
}
