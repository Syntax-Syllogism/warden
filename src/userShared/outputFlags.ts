import { writeFile } from 'node:fs/promises';
import { Messages, SfError } from '@salesforce/core';
import { Flags } from '@salesforce/sf-plugins-core';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('@syntax-syllogism/warden', 'warden.shared');

export type OutputFormat = 'human' | 'csv' | 'json';

export const outputFlag = Flags.string({
  options: ['human', 'csv', 'json'] as const,
  default: 'human',
  summary: messages.getMessage('flags.output.summary'),
});

export const outputFileFlag = Flags.string({
  summary: messages.getMessage('flags.output-file.summary'),
});

export const outputFlags = {
  output: outputFlag,
  'output-file': outputFileFlag,
};

export const resolveOutputFormat = (value: unknown): OutputFormat =>
  value === 'csv' || value === 'json' ? value : 'human';

export const assertOutputCompatibility = (
  format: OutputFormat,
  outputFile: string | undefined,
  jsonEnabled: boolean
): void => {
  if (jsonEnabled && format !== 'human' && !outputFile) {
    throw new SfError(messages.getMessage('errorOutputJsonConflict'));
  }
};

export const writeOutputFile = async (path: string | undefined, payload: string | undefined): Promise<void> => {
  if (path && payload !== undefined) await writeFile(path, `${payload}\n`, 'utf8');
};

export const globalJsonPayload = (result: unknown): string =>
  JSON.stringify({ status: 0, result, warnings: [] }, null, 2);

export const emitOutput = async <T>(options: {
  result: T;
  format: OutputFormat;
  outputFile?: string;
  jsonOutput: boolean;
  csv: string;
  human: string;
  log: (message: string) => void;
}): Promise<void> => {
  const { result, format, outputFile, jsonOutput, csv, human, log } = options;
  const filePayload =
    format === 'csv'
      ? csv
      : format === 'json'
      ? JSON.stringify(result, null, 2)
      : jsonOutput
      ? globalJsonPayload(result)
      : undefined;
  await writeOutputFile(outputFile, filePayload);
  if (jsonOutput) return;
  if (outputFile && format !== 'human') log(human);
  else if (format === 'csv') log(csv);
  else if (format === 'json') log(JSON.stringify(result, null, 2));
  else log(human);
};
