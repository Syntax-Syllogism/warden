import { Messages } from '@salesforce/core';
import { readJsonOrThrow } from '../userShared/sfUtils.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('@syntax-syllogism/warden', 'warden.provision');

export type ProvisionDefinitionDocuments = {
  usersDoc: Record<string, unknown>;
  personasDoc: Record<string, unknown>;
};

const readDefinitionJson = async (path: string): Promise<Record<string, unknown>> =>
  readJsonOrThrow(path, (filePath, error) => messages.getMessage('errorInvalidJson', [filePath, error])) as Promise<
    Record<string, unknown>
  >;

export const readProvisionDefinitions = async (
  usersPath: string,
  personasPath: string
): Promise<ProvisionDefinitionDocuments> => ({
  usersDoc: await readDefinitionJson(usersPath),
  personasDoc: await readDefinitionJson(personasPath),
});
