import { Messages, SfError, type Connection } from '@salesforce/core';
import {
  detectInputFormat,
  diff,
  isWardenError,
  readProvisionDefinitions,
  type UserConformanceVerdict,
  type UserDiffResult,
} from '@syntax-syllogism/warden-core';
import { requireExactlyOne, requireFlagDependencies } from './targetFlags.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('@syntax-syllogism/warden', 'warden.diff');

export type DiffRequestInput = {
  user?: string;
  against?: string;
  usersDef?: string;
  personasDef?: string;
  externalId?: string;
  inputFormat?: 'json' | 'csv';
  csvListDelimiter?: string;
  verify?: boolean;
};

export type DiffRequestResult = UserDiffResult | UserConformanceVerdict[];

const rethrowLegacyUserValueError = (error: unknown): never => {
  if (isWardenError(error) && error.code === 'errorInvalidUserValue') throw new SfError(error.message);
  throw error;
};

const rethrowLegacyPersonaDefinitionError = (error: unknown, personasPath: string | undefined): never => {
  if (isWardenError(error) && error.code === 'schema-invalid' && personasPath) {
    const issues = (error.data as { issues?: Array<{ path?: unknown[] }> } | undefined)?.issues;
    if (issues?.some((issue) => issue.path?.length === 1 && issue.path[0] === 'personas')) {
      throw new SfError(messages.getMessage('errorInvalidPersonaDefinition'));
    }
  }
  throw error;
};

/** Executes validation and data loading shared by oclif and sfd diff reads. */
export const runDiffRequest = async (conn: Connection, input: DiffRequestInput): Promise<DiffRequestResult> => {
  const flags = {
    user: input.user,
    against: input.against,
    'users-def': input.usersDef,
    'personas-def': input.personasDef,
    'external-id': input.externalId,
    'input-format': input.inputFormat,
    'csv-list-delimiter': input.csvListDelimiter,
  };
  requireExactlyOne(flags, ['user', 'users-def']);
  if (input.user && input.externalId) throw new SfError(messages.getMessage('errorExternalIdUserMode'));
  if (input.user && input.personasDef) throw new SfError(messages.getMessage('errorPersonasUserMode'));
  if (input.verify && (input.user ?? input.against)) throw new SfError(messages.getMessage('errorVerifyUserMode'));
  requireFlagDependencies(flags, 'user', ['against']);
  requireFlagDependencies(flags, 'against', ['user']);

  if (typeof input.user === 'string') {
    return diff
      .run(conn, { mode: 'user', verify: false, user: input.user, against: input.against as string })
      .catch(rethrowLegacyUserValueError);
  }

  const inputFormat = detectInputFormat(input.usersDef as string, input.inputFormat);
  let definitions: Awaited<ReturnType<typeof readProvisionDefinitions>> | undefined;
  if (inputFormat === 'json') {
    try {
      definitions = await readProvisionDefinitions(input.usersDef as string, input.personasDef, {}, (path, error) =>
        messages.getMessage('errorInvalidJson', [path, error])
      );
    } catch (error) {
      rethrowLegacyPersonaDefinitionError(error, input.personasDef);
    }
  }
  return diff.run(conn, {
    mode: 'persona',
    verify: Boolean(input.verify),
    usersDoc: definitions?.usersDoc,
    personasDoc: definitions?.personasSupplied ? definitions.personasDoc : undefined,
    usersPath: inputFormat === 'csv' ? input.usersDef : undefined,
    personasPath: inputFormat === 'csv' ? input.personasDef : undefined,
    inputFormat: inputFormat === 'csv' ? inputFormat : undefined,
    csvListDelimiter: input.csvListDelimiter,
    externalId: input.externalId,
  });
};
