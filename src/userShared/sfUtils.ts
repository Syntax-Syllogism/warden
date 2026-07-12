import { readFile } from 'node:fs/promises';
import { SfError } from '@salesforce/core';

export type SaveError = { message: string; statusCode?: string; fields?: string[] };
export type SaveResult = { success: boolean; id?: string; errors: SaveError[] };

export const asArray = <T>(value: T | T[]): T[] => (Array.isArray(value) ? value : [value]);

export const readJson = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, 'utf8')) as unknown;

export const readJsonOrThrow = async (
  path: string,
  message: (path: string, error: string) => string
): Promise<unknown> => {
  try {
    return await readJson(path);
  } catch (error) {
    throw new SfError(message(path, error instanceof Error ? error.message : String(error)));
  }
};

export const formatSaveError = (error: SaveError): string => {
  const fieldSuffix = error.fields && error.fields.length > 0 ? ` (fields: ${error.fields.join(', ')})` : '';
  return error.statusCode ? `${error.statusCode}: ${error.message}${fieldSuffix}` : error.message;
};

export const pushErrors = (errors: string[], saveResults: SaveResult | SaveResult[] | undefined): void => {
  if (!saveResults) return;
  for (const result of asArray(saveResults)) {
    if (!result.success) errors.push(...result.errors.map((err) => formatSaveError(err)));
  }
};

export const esc = (value: string): string => value.replaceAll('\\', '\\\\').replaceAll("'", "\\'");
export const soqlIn = (values: string[]): string => values.map((value) => `'${esc(value)}'`).join(',');

export const batch = <T>(items: T[], size: number): T[][] =>
  items.reduce<T[][]>((groups, item, index) => {
    if (index % size === 0) groups.push([]);
    groups[groups.length - 1].push(item);
    return groups;
  }, []);

export const runBatches = async <T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> => {
  const itemBatches = batch(items, size);
  return itemBatches.reduce<Promise<R[]>>(async (accPromise, itemBatch) => {
    const acc = await accPromise;
    const next = await Promise.all(itemBatch.map(fn));
    return acc.concat(next);
  }, Promise.resolve([]));
};
