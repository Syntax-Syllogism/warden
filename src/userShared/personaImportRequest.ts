import type { Connection } from '@salesforce/core';
import { diffPersonaDocuments, importOrgPersonas, readOrgPersonas, readPersonaFile } from './personas.js';
import type { PersonaDiff, PersonaDocument, PersonaPromotionResult } from './personas.js';

export type PersonaImportRequestInput = {
  input: string;
  prune?: boolean;
};

export type PersonaImportPlan = {
  document: PersonaDocument;
  diff: PersonaDiff;
  prune: boolean;
};

export const planPersonaImportRequest = async (
  conn: Connection,
  input: PersonaImportRequestInput
): Promise<PersonaImportPlan> => {
  const [document, org] = await Promise.all([readPersonaFile(input.input), readOrgPersonas(conn)]);
  return { document, diff: diffPersonaDocuments(document, org.document), prune: input.prune === true };
};

export const applyPersonaImportRequest = (conn: Connection, plan: PersonaImportPlan): Promise<PersonaPromotionResult> =>
  importOrgPersonas(conn, plan.document, plan.prune);
