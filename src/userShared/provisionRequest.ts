import {
  DefinitionError,
  describeUserFields,
  detectInputFormat,
  parseUsersDefinition,
  provision,
  provisionOptionsSchema,
} from '@syntax-syllogism/warden-core';
import type { Connection } from '@salesforce/core';
import {
  readProvisionDefinitions,
  type ProvisionPlan,
  type ProvisionResult,
  type UseCaseContext,
} from '@syntax-syllogism/warden-core';
import { PERSONA_OBJECT, personaPackageDetected, readOrgPersonas } from './personas.js';
import { applyProvisionWithLegacyOutput } from './useCaseOptions.js';

type ProvisionDefinitions = Awaited<ReturnType<typeof readProvisionDefinitions>>;
type PersonaSource = 'file' | 'org';

export type ProvisionRequestInput = {
  usersDef: string;
  personasDef?: string;
  personaSource?: PersonaSource;
  relatedDef?: string;
  externalId?: string;
  inputFormat?: 'json' | 'csv';
  csvListDelimiter?: string;
  fuzzyUsername?: boolean;
  cleanupOnFailure?: boolean;
};

export type PlannedProvisionRequest = {
  core: ProvisionPlan;
  definitions: ProvisionDefinitions;
  personasDoc: ProvisionDefinitions['personasDoc'];
  personaSourceLabel: string;
};

const assertPersonasDefined = (
  definitions: ProvisionDefinitions,
  personaSource: PersonaSource,
  personasWithoutDefinition: (identity: string) => string
): void => {
  if (personaSource !== 'file' || definitions.personasSupplied) return;
  const usersDoc = parseUsersDefinition(definitions.usersDoc);
  definitions.usersDoc = usersDoc;
  const index = usersDoc.users.findIndex((user) => Object.keys(user).some((key) => key.toLowerCase() === 'personas'));
  if (index < 0) return;
  const user = usersDoc.users[index] as Record<string, unknown>;
  const identity = ['FederationIdentifier', 'Username', 'Email']
    .map((field) => user[Object.keys(user).find((key) => key.toLowerCase() === field.toLowerCase()) ?? ''])
    .find((value) => typeof value === 'string' && value.length > 0);
  throw new DefinitionError('errorPersonasWithoutDefinition', personasWithoutDefinition(String(identity ?? index + 1)));
};

export const planProvisionRequest = async (
  conn: Connection,
  input: ProvisionRequestInput,
  options: {
    relatedDefinitionRequiresJson: () => Error;
    invalidDefinition: (path: string, detail: string) => string;
    invalidPersonaDefinition: (error: unknown, personasPath: string | undefined) => never;
    personasWithoutDefinition: (identity: string) => string;
    ctx?: UseCaseContext;
  }
): Promise<PlannedProvisionRequest> => {
  const inputFormat = detectInputFormat(input.usersDef, input.inputFormat);
  if (input.relatedDef && inputFormat === 'csv') throw options.relatedDefinitionRequiresJson();

  const personaSource: PersonaSource =
    input.personaSource ?? (input.personasDef ? 'file' : (await personaPackageDetected(conn)) ? 'org' : 'file');
  const orgPersonas = personaSource === 'org' ? await readOrgPersonas(conn) : undefined;
  let definitions: ProvisionDefinitions;
  try {
    definitions = await readProvisionDefinitions(
      input.usersDef,
      personaSource === 'file' ? input.personasDef : undefined,
      {
        relatedPath: input.relatedDef,
        ...(inputFormat === 'csv'
          ? { inputFormat, fieldMap: await describeUserFields(conn), csvListDelimiter: input.csvListDelimiter }
          : {}),
      },
      options.invalidDefinition
    );
  } catch (error) {
    return options.invalidPersonaDefinition(error, input.personasDef);
  }

  assertPersonasDefined(definitions, personaSource, options.personasWithoutDefinition);
  const usersDoc = definitions.usersDoc;

  const core = await provision.plan(
    conn,
    provisionOptionsSchema.parse({
      usersDoc,
      personasDoc: orgPersonas?.document ?? definitions.personasDoc,
      personasSupplied: personaSource === 'org' ? true : definitions.personasSupplied,
      relatedDoc: definitions.relatedDoc,
      csvListDelimiter: input.csvListDelimiter,
      externalId: input.externalId,
      fuzzyUsername: input.fuzzyUsername,
      cleanupOnFailure: input.cleanupOnFailure,
    }),
    options.ctx
  );
  const personaSourceLabel =
    personaSource === 'org'
      ? `org (${PERSONA_OBJECT}, ${orgPersonas?.count ?? 0} personas)`
      : `file${input.personasDef ? ` (${input.personasDef})` : ' (no --personas-def)'}${
          input.personaSource ? '' : ' [default]'
        }`;
  return { core, definitions, personasDoc: orgPersonas?.document ?? definitions.personasDoc, personaSourceLabel };
};

export const applyProvisionRequest = (
  conn: Connection,
  plan: ProvisionPlan,
  message: (key: string, args?: string[]) => string
): Promise<ProvisionResult> => applyProvisionWithLegacyOutput(conn, plan, message);
