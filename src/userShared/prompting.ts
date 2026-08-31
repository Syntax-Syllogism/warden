import { stat } from 'node:fs/promises';
import { checkbox, confirm, input, select } from '@inquirer/prompts';
import { SfError } from '@salesforce/core';
import type { AccessTargetType } from '../userAccess/types.js';
import { detectInputFormat, inputFormatFromExtension, type InputFormat } from './csv.js';
import { apiVersionFlag } from './targetFlags.js';

export const promptRuntime = { checkbox, confirm, input, select };

export const promptText = (message: string, defaultValue?: string): Promise<string> =>
  promptRuntime.input({ message, default: defaultValue });

export const promptOrgAlias = (): Promise<string> => promptText('Target org alias or username');

export const promptOptionalText = async (message: string, defaultValue?: string): Promise<string | undefined> => {
  const value = await promptText(message, defaultValue);
  return value.trim() ? value : undefined;
};

// Reuses the flag's own parser so a prompted version gets the same format,
// retirement, and deprecation checks the command line gets. The parse context is
// stubbed because `Flags.orgApiVersion` validates the input alone and never reads
// it; a dependency that starts using the context would need a real one here.
export const promptOptionalApiVersion = async (defaultValue?: string): Promise<string | undefined> => {
  const value = await promptOptionalText('API version', defaultValue);
  return value === undefined ? undefined : apiVersionFlag.parse(value, {} as never, apiVersionFlag);
};

// Mirrors oclif's `Flags.file({ exists: true })` parser so a prompted path fails
// the same way, and before the summary, as one passed on the command line.
const assertFileExists = async (path: string): Promise<string> => {
  let fileStat;
  try {
    fileStat = await stat(path);
  } catch {
    throw new SfError(`No file found at ${path}`);
  }
  if (!fileStat.isFile()) throw new SfError(`${path} exists but is not a file`);
  return path;
};

export const promptExistingFile = async (message: string): Promise<string> =>
  assertFileExists(await promptText(message));

export const promptOptionalExistingFile = async (message: string): Promise<string | undefined> => {
  const value = await promptOptionalText(message);
  return value === undefined ? undefined : assertFileExists(value);
};

export const promptBoolean = (message: string, defaultValue: boolean): Promise<boolean> =>
  promptRuntime.confirm({ message, default: defaultValue });

export const promptOutputFormat = (): Promise<'human' | 'csv' | 'json'> =>
  promptRuntime.select({
    message: 'Output format',
    choices: [
      { name: 'Human', value: 'human' },
      { name: 'CSV', value: 'csv' },
      { name: 'JSON', value: 'json' },
    ],
  });

export const promptInputFormat = (): Promise<'json' | 'csv'> =>
  promptRuntime.select({
    message: 'Input format',
    choices: [
      { name: 'JSON', value: 'json' },
      { name: 'CSV', value: 'csv' },
    ],
  });

/** Ask only when the users-definition extension does not resolve the format. */
export const promptInputFormatForPath = (path: unknown): Promise<InputFormat> => {
  const detected = typeof path === 'string' && path.length > 0 ? inputFormatFromExtension(path) : undefined;
  return detected ? Promise.resolve(detected) : promptInputFormat();
};

export const effectiveInputFormat = (flags: Record<string, unknown>): InputFormat =>
  detectInputFormat(
    typeof flags['users-def'] === 'string' ? flags['users-def'] : '',
    flags['input-format'] === 'json' || flags['input-format'] === 'csv' ? flags['input-format'] : undefined
  );

const accessTypeChoices: ReadonlyArray<{ name: string; value: AccessTargetType }> = [
  { name: 'Field', value: 'field' },
  { name: 'Object', value: 'object' },
  { name: 'Apex Class', value: 'apex-class' },
  { name: 'Visualforce Page', value: 'vf-page' },
  { name: 'Custom Permission', value: 'custom-permission' },
  { name: 'Tab', value: 'tab' },
];

export const promptAccessType = (allowed?: readonly AccessTargetType[]): Promise<AccessTargetType> =>
  promptRuntime.select({
    message: 'Access target type',
    choices: accessTypeChoices.filter((choice) => !allowed || allowed.includes(choice.value)),
  });

export const promptAccessMode = (): Promise<'target' | 'user'> =>
  promptRuntime.select({
    message: 'Access audit mode',
    choices: [
      { name: 'Look up a target directly', value: 'target' },
      { name: 'What does this user have access to?', value: 'user' },
    ],
  });

export const promptAccessUserScope = (allowSobject = true): Promise<'target' | 'sobject'> =>
  promptRuntime.select({
    message: 'Reverse-audit scope',
    choices: allowSobject
      ? [
          { name: 'A target', value: 'target' },
          { name: 'An SObject', value: 'sobject' },
        ]
      : [{ name: 'A target', value: 'target' }],
  });

export const promptUserSelection = (): Promise<'user' | 'users-def'> =>
  promptRuntime.select({
    message: 'User selection',
    choices: [
      { name: 'One user (field:value)', value: 'user' },
      { name: 'Users definition file', value: 'users-def' },
    ],
  });

export const promptDiffMode = (): Promise<'users' | 'personas'> =>
  promptRuntime.select({
    message: 'Diff mode',
    choices: [
      { name: 'Compare two specific users', value: 'users' },
      { name: 'Compare users against persona definitions', value: 'personas' },
    ],
  });

export const promptStripSkips = (
  checked: readonly string[] = [],
  disabled: readonly string[] = []
): Promise<string[]> =>
  promptRuntime.checkbox({
    message: 'What should this strip skip?',
    choices: [
      { name: 'Freezing the login', value: 'no-freeze' },
      { name: 'Deactivating the user', value: 'no-deactivate' },
      { name: 'Removing permission sets', value: 'keep-permsets' },
      { name: 'Removing permission set groups', value: 'keep-permset-groups' },
      { name: 'Removing permission set licenses', value: 'keep-licenses' },
      { name: 'Removing public group membership', value: 'keep-public-groups' },
      { name: 'Removing queue membership', value: 'keep-queues' },
    ].map((choice) => ({
      ...choice,
      ...(checked.includes(choice.value) ? { checked: true } : {}),
      ...(disabled.includes(choice.value) ? { disabled: 'Provided on the command line' } : {}),
    })),
  });
