import type { Connection } from '@salesforce/core';
import type { ProvisionResult } from '@syntax-syllogism/warden-core';
import { readPersonaIds } from './personas.js';
import {
  bestEffortOrgWrite,
  buildLedgerRows,
  describeObjectFields,
  WARDEN_LEDGER_OBJECT,
  writeBatch,
  type CaptureState,
  type PersonaDocument,
} from './orgWrites.js';

/** Persist captured provisioning grants without allowing audit failures to affect provisioning. */
export const writeProvisionLedger = async (
  connection: Connection,
  options: {
    state: CaptureState;
    output: ProvisionResult;
    personasDoc?: PersonaDocument;
    runId?: string;
    warn: (message: string) => void;
  }
): Promise<void> => {
  const personaNames = [...new Set(options.output.users.flatMap((user) => user.personas))];
  const ledgerFields = await describeObjectFields(connection, WARDEN_LEDGER_OBJECT);
  let personaIdsByName: Map<string, string> | undefined;
  if (ledgerFields?.has('wdn_Persona__c') && personaNames.length > 0) {
    personaIdsByName = await readPersonaIds(connection, personaNames);
    const unresolved = personaNames.filter((name) => !personaIdsByName?.has(name));
    if (unresolved.length > 0)
      options.warn(`Warden org ledger provenance is unavailable for persona(s): ${unresolved.join(', ')}.`);
  }
  const ledgerRows = buildLedgerRows({
    grants: options.state.grants,
    result: options.output,
    personasDoc: options.personasDoc,
    labelsByTypeAndId: options.state.labelsByTypeAndId,
    referenceIdsByType: options.state.referenceIdsByType,
    personaIdsByName,
    runId: options.runId,
  });
  await bestEffortOrgWrite(
    () => writeBatch(connection, WARDEN_LEDGER_OBJECT, ledgerRows, options.warn, 'ledger'),
    options.warn,
    'ledger'
  );
};
