import type { Connection } from '@salesforce/core';

type QueryResult<T> = { records: T[]; done: boolean; nextRecordsUrl?: string };

export const esc = (value: string): string => value.replaceAll('\\', '\\\\').replaceAll("'", "\\'");
export const soqlIn = (values: string[]): string => values.map((v) => `'${esc(v)}'`).join(',');

export async function queryAll<T extends Record<string, unknown>>(conn: Connection, soql: string): Promise<T[]> {
  const rows: T[] = [];
  let result = (await conn.query<T>(soql)) as QueryResult<T>;
  rows.push(...result.records);
  while (!result.done && result.nextRecordsUrl) {
    // eslint-disable-next-line no-await-in-loop
    result = (await conn.queryMore<T>(result.nextRecordsUrl)) as QueryResult<T>;
    rows.push(...result.records);
  }
  return rows;
}

export const chunkValues = <T>(values: T[], chunkSize = 250): T[][] => {
  if (chunkSize <= 0) throw new Error('chunkSize must be greater than 0');
  const chunks: T[][] = [];
  for (let idx = 0; idx < values.length; idx += chunkSize) chunks.push(values.slice(idx, idx + chunkSize));
  return chunks;
};

export async function queryAllInChunks<T extends Record<string, unknown>>(
  conn: Connection,
  values: string[],
  buildSoql: (chunk: string[]) => string,
  chunkSize = 250
): Promise<T[]> {
  if (values.length === 0) return [];
  const rows: T[] = [];
  // eslint-disable-next-line no-await-in-loop
  for (const chunk of chunkValues(values, chunkSize)) rows.push(...(await queryAll<T>(conn, buildSoql(chunk))));
  return rows;
}
