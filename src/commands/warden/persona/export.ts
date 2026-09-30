import { writeFile } from 'node:fs/promises';
import { Messages } from '@salesforce/core';
import { Flags } from '@salesforce/sf-plugins-core';
import { apiVersionFlag, requireTargetOrg, targetOrgFlag } from '../../../userShared/targetFlags.js';
import { readOrgPersonas } from '../../../userShared/personas.js';
import { WardenCommand } from '../../../wardenCommand.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('@syntax-syllogism/warden', 'warden.persona.export');

export type PersonaExportResult = { personas: number; output: string };

export default class PersonaExport extends WardenCommand<PersonaExportResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');

  public static readonly flags = {
    'target-org': targetOrgFlag,
    output: Flags.string({ required: true, summary: messages.getMessage('flags.output.summary') }),
    'api-version': apiVersionFlag,
  };

  public async run(): Promise<PersonaExportResult> {
    const { flags } = await this.parse(PersonaExport);
    const targetOrg = requireTargetOrg(flags['target-org']);
    const output = flags.output;
    const read = await readOrgPersonas(targetOrg.getConnection(flags['api-version']));
    await writeFile(output, `${JSON.stringify(read.document, null, 2)}\n`, 'utf8');
    const result = { personas: read.count, output };
    if (!this.jsonEnabled()) this.log(`Exported ${read.count} personas to ${output}`);
    return result;
  }
}
