import { Messages } from '@salesforce/core';
import { Flags } from '@salesforce/sf-plugins-core';
import { apiVersionFlag, requireTargetOrg, targetOrgFlag } from '../../../userShared/targetFlags.js';
import { importOrgPersonas, readPersonaFile, type PersonaPromotionResult } from '../../../userShared/personas.js';
import { WardenCommand } from '../../../wardenCommand.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('@syntax-syllogism/warden', 'warden.persona.import');

export default class PersonaImport extends WardenCommand<PersonaPromotionResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');

  public static readonly flags = {
    'target-org': targetOrgFlag,
    input: Flags.file({ exists: true, required: true, summary: messages.getMessage('flags.input.summary') }),
    prune: Flags.boolean({ default: false, summary: messages.getMessage('flags.prune.summary') }),
    'api-version': apiVersionFlag,
  };

  public async run(): Promise<PersonaPromotionResult> {
    const { flags } = await this.parse(PersonaImport);
    const targetOrg = requireTargetOrg(flags['target-org']);
    const document = await readPersonaFile(flags.input);
    const result = await importOrgPersonas(targetOrg.getConnection(flags['api-version']), document, flags.prune);
    if (!this.jsonEnabled()) {
      const pruneMessage = flags.prune ? `, pruned ${result.prunedComponents ?? 0} components` : '';
      this.log(`Imported ${result.personas} personas and ${result.components} components${pruneMessage}`);
    }
    return result;
  }
}
