import { Messages } from '@salesforce/core';
import { detectInputFormat, readCsvUsers, type InputFormat } from '../userShared/csv.js';
import { readJsonOrThrow } from '../userShared/sfUtils.js';
import type { UserFieldMeta } from '../userMatching/index.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('@syntax-syllogism/warden', 'warden.provision');

export type ProvisionDefinitionDocuments = {
  usersDoc: Record<string, unknown>;
  personasDoc: Record<string, unknown>;
  personasSupplied: boolean;
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
