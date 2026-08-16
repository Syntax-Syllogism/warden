import { Messages, SfError } from '@salesforce/core';
import { detectInputFormat, readCsvUsers, type InputFormat } from '../userShared/csv.js';
import { readJsonOrThrow } from '../userShared/sfUtils.js';
import type { UserFieldMeta } from '../userMatching/index.js';
import { findFirstUserWithPersonas } from './planner.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('@syntax-syllogism/warden', 'warden.provision');

export type ProvisionDefinitionDocuments = {
  usersDoc: Record<string, unknown>;
  personasDoc: Record<string, unknown>;
  personasSupplied: boolean;
};

export type DefinitionMessages = {
  invalidPersonaDefinition: () => string;
  personasWithoutDefinition: (userKey: string) => string;
  invalidJson: (path: string, error: string) => string;
};

export type DefinitionSource = {
  usersDoc?: Record<string, unknown>;
  personasDoc?: Record<string, unknown>;
  usersPath?: string;
  personasPath?: string;
  personasSupplied?: boolean;
  inputFormat?: InputFormat;
  csvListDelimiter?: string;
};

export type DefinitionReaderOptions = {
  inputFormat?: InputFormat;
  csvListDelimiter?: string;
  fieldMap?: Map<string, UserFieldMeta>;
};

type JsonErrorMessage = (filePath: string, error: string) => string;

const defaultJsonErrorMessage: JsonErrorMessage = (filePath, error) =>
  messages.getMessage('errorInvalidJson', [filePath, error]);

const readDefinitionJson = async (path: string, message: JsonErrorMessage): Promise<Record<string, unknown>> =>
  (await readJsonOrThrow(path, message)) as Record<string, unknown>;

export const assertValidDefinitions = (
  usersDoc: Record<string, unknown>,
  personasDoc: Record<string, unknown>,
  personasSupplied: boolean,
  message: DefinitionMessages
): void => {
  if (!personasDoc.personas || typeof personasDoc.personas !== 'object' || Array.isArray(personasDoc.personas)) {
    throw new SfError(message.invalidPersonaDefinition());
  }
  const firstUserWithPersonas = personasSupplied === false ? findFirstUserWithPersonas(usersDoc.users) : undefined;
  if (firstUserWithPersonas) {
    throw new SfError(message.personasWithoutDefinition(firstUserWithPersonas));
  }
};

export const readUsersDefinition = async (
  path: string,
  options: DefinitionReaderOptions = {},
  jsonErrorMessage: JsonErrorMessage = defaultJsonErrorMessage
): Promise<Record<string, unknown>> => {
  if (detectInputFormat(path, options.inputFormat) === 'json') return readDefinitionJson(path, jsonErrorMessage);
  if (!options.fieldMap) throw new Error('A User field map is required to read CSV user definitions.');
  return readCsvUsers(path, options.fieldMap, options.csvListDelimiter);
};

export const readProvisionDefinitions = async (
  usersPath: string,
  personasPath?: string,
  options: DefinitionReaderOptions = {},
  jsonErrorMessage: JsonErrorMessage = defaultJsonErrorMessage
): Promise<ProvisionDefinitionDocuments> => ({
  usersDoc: await readUsersDefinition(usersPath, options, jsonErrorMessage),
  personasDoc: personasPath ? await readDefinitionJson(personasPath, jsonErrorMessage) : { personas: {} },
  personasSupplied: Boolean(personasPath),
});

export const resolveDefinitions = async (
  source: DefinitionSource,
  fieldMap: Map<string, UserFieldMeta>,
  message: DefinitionMessages
): Promise<ProvisionDefinitionDocuments> => {
  if (source.usersDoc) {
    return {
      usersDoc: source.usersDoc,
      personasDoc: source.personasDoc ?? { personas: {} },
      personasSupplied: source.personasSupplied ?? (source.personasDoc ? true : Boolean(source.personasPath)),
    };
  }
  if (!source.usersPath) throw new SfError(message.invalidJson('users-def', 'missing path'));
  return readProvisionDefinitions(
    source.usersPath,
    source.personasPath,
    { inputFormat: source.inputFormat, csvListDelimiter: source.csvListDelimiter, fieldMap },
    message.invalidJson
  );
};

export const loadValidatedDefinitions = async (
  source: DefinitionSource,
  fieldMap: Map<string, UserFieldMeta>,
  message: DefinitionMessages
): Promise<ProvisionDefinitionDocuments> => {
  if (source.usersDoc) {
    assertValidDefinitions(
      source.usersDoc,
      source.personasDoc ?? { personas: {} },
      source.personasSupplied ?? Boolean(source.personasDoc),
      message
    );
  }
  const definitions = await resolveDefinitions(source, fieldMap, message);
  assertValidDefinitions(
    definitions.usersDoc,
    definitions.personasDoc,
    source.personasSupplied ?? definitions.personasSupplied,
    message
  );
  return definitions;
};
