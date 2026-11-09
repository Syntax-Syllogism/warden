import { Messages } from '@salesforce/core';
import { Flags } from '@salesforce/sf-plugins-core';
import { apiVersionFlag, dryRunFlag, requireTargetOrg, targetOrgFlag } from '../../../userShared/targetFlags.js';
import { applyPersonaImportRequest, planPersonaImportRequest } from '../../../userShared/personaImportRequest.js';
import type { PersonaDiff, PersonaPromotionResult } from '../../../userShared/personas.js';
import { WardenCommand } from '../../../wardenCommand.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('@syntax-syllogism/warden', 'warden.persona.import');

export default class PersonaImport extends WardenCommand<PersonaPromotionResult | PersonaDiff> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');

  public static readonly flags = {
    'target-org': targetOrgFlag,
    input: Flags.file({ exists: true, required: true, summary: messages.getMessage('flags.input.summary') }),
    prune: Flags.boolean({ default: false, summary: messages.getMessage('flags.prune.summary') }),
    'dry-run': dryRunFlag,
    'api-version': apiVersionFlag,
  };

  public async run(): Promise<PersonaPromotionResult | PersonaDiff> {
    const { flags } = await this.parse(PersonaImport);
    const targetOrg = requireTargetOrg(flags['target-org']);
    const conn = targetOrg.getConnection(flags['api-version']);
    const plan = await planPersonaImportRequest(conn, { input: flags.input, prune: flags.prune });
    if (flags['dry-run']) return plan.diff;

    const result = await applyPersonaImportRequest(conn, plan);
    if (!this.jsonEnabled()) {
      const pruneMessage = flags.prune ? `, pruned ${result.prunedComponents ?? 0} components` : '';
      this.log(`Imported ${result.personas} personas and ${result.components} components${pruneMessage}`);
    }
    return result;
  }
}
