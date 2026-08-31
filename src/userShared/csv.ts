import { readFile } from 'node:fs/promises';
import type { UserFieldMeta } from '../userMatching/index.js';

const FORMULA_PREFIX = /^[=+\-@\t\r]/;

export type InputFormat = 'json' | 'csv';

/** The format a path's extension settles on its own, or undefined when it does not settle one. */
export const inputFormatFromExtension = (path: string): InputFormat | undefined => {
  if (/\.(csv|tsv)$/i.test(path)) return 'csv';
  if (/\.json$/i.test(path)) return 'json';
  return undefined;
};

export const detectInputFormat = (path: string, override?: InputFormat): InputFormat =>
  override ?? inputFormatFromExtension(path) ?? 'json';

export type CsvRowInfo = { path: string; line: number };

const csvRowInfo = Symbol('csvRowInfo');

export const getCsvRowInfo = (value: unknown): CsvRowInfo | undefined =>
  value && typeof value === 'object' ? (value as { [csvRowInfo]?: CsvRowInfo })[csvRowInfo] : undefined;

export class CsvReadError extends Error {
  public constructor(path: string, line: number, detail: string) {
    super(`${path}:${line} — ${detail}`);
    this.name = 'CsvReadError';
  }
}

export type ParsedCsvRow = { cells: string[]; line: number };

// CSV quoting has several mutually exclusive parser states; keeping them together makes line tracking auditable.
// eslint-disable-next-line complexity
export const readCsvRows = (source: string, path: string, delimiter: string): ParsedCsvRow[] => {
  const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  const rows: ParsedCsvRow[] = [];
  let cells: string[] = [];
  let cell = '';
  let cellStarted = false;
  let quoteClosed = false;
  let inQuotes = false;
  let rowTouched = false;
  let rowLine = 1;
  let line = 1;

  const finishRow = (): void => {
    rows.push({ cells: [...cells, cell], line: rowLine });
    cells = [];
    cell = '';
    cellStarted = false;
    quoteClosed = false;
    rowTouched = false;
    rowLine = line;
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inQuotes) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          inQuotes = false;
          quoteClosed = true;
        }
      } else {
        cell += character;
        if (character === '\r') {
          if (text[index + 1] === '\n') {
            cell += '\n';
            index += 1;
          }
          line += 1;
        } else if (character === '\n') {
          line += 1;
        }
      }
      continue;
    }

    if (quoteClosed) {
      if (character === delimiter) {
        cells.push(cell);
        cell = '';
        cellStarted = false;
        quoteClosed = false;
        rowTouched = true;
        continue;
      }
      if (character === '\r' || character === '\n') {
        if (character === '\r' && text[index + 1] === '\n') index += 1;
        line += 1;
        finishRow();
        continue;
      }
      throw new CsvReadError(path, line, 'Unexpected character after a closing quote.');
    }

    if (character === '"') {
      if (cellStarted) throw new CsvReadError(path, line, 'Unexpected quote in an unquoted cell.');
      inQuotes = true;
      cellStarted = true;
      rowTouched = true;
    } else if (character === delimiter) {
      cells.push(cell);
      cell = '';
      cellStarted = false;
      rowTouched = true;
    } else if (character === '\r' || character === '\n') {
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      line += 1;
      finishRow();
    } else {
      cell += character;
      cellStarted = true;
      rowTouched = true;
    }
  }

  if (inQuotes) throw new CsvReadError(path, line, 'Unterminated quoted cell.');
  if (rowTouched || cells.length > 0 || cell.length > 0) finishRow();
  if (/[\r\n]$/.test(text) && rows.at(-1)?.cells.length === 1 && rows.at(-1)?.cells[0] === '') rows.pop();
  return rows;
};

const levenshtein = (left: string, right: string): number => {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    let diagonal = previous[0];
    previous[0] = row;
    for (let column = 1; column <= right.length; column += 1) {
      const above = previous[column];
      previous[column] = Math.min(
        previous[column] + 1,
        previous[column - 1] + 1,
        diagonal + (left[row - 1] === right[column - 1] ? 0 : 1)
      );
      diagonal = above;
    }
  }
  return previous[right.length];
};

const suggestedHeader = (header: string, validHeaders: string[]): string | undefined => {
  const lowerHeader = header.toLowerCase();
  const suggestion = validHeaders
    .map((candidate) => ({ candidate, distance: levenshtein(lowerHeader, candidate.toLowerCase()) }))
    .filter(({ distance }) => distance <= 2)
    .sort((left, right) => left.distance - right.distance || left.candidate.localeCompare(right.candidate))[0];
  return suggestion?.candidate;
};

const parseBoolean = (value: string): boolean | undefined => {
  switch (value.toLowerCase()) {
    case 'true':
    case '1':
    case 'yes':
      return true;
    case 'false':
    case '0':
    case 'no':
      return false;
    default:
      return undefined;
  }
};

const splitList = (value: string, delimiter: string): string[] =>
  value
    .split(delimiter)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

export const readCsvUsers = async (
  path: string,
  fieldMap: Map<string, UserFieldMeta>,
  listDelimiter = ';'
): Promise<{ users: Array<Record<string, unknown>> }> => {
  if (listDelimiter.length === 0) throw new Error('--csv-list-delimiter must not be empty.');
  const delimiter = /\.tsv$/i.test(path) ? '\t' : ',';
  const rows = readCsvRows(await readFile(path, 'utf8'), path, delimiter);
  if (rows.length === 0) throw new CsvReadError(path, 1, 'CSV must contain a header row.');

  const headerRow = rows[0];
  const metaHeaders = new Map([
    ['personas', 'personas'],
    ['match', 'match'],
    ['fuzzyusername', 'fuzzyUsername'],
  ]);
  const validHeaders = [...metaHeaders.values(), ...[...fieldMap.values()].map((field) => field.name)];
  const seen = new Set<string>();
  const headers = headerRow.cells.map((rawHeader) => {
    const header = rawHeader.trim();
    const key = header.toLowerCase();
    if (seen.has(key)) throw new CsvReadError(path, headerRow.line, `Duplicate column "${rawHeader}".`);
    seen.add(key);
    const metaHeader = metaHeaders.get(key);
    const field = fieldMap.get(key);
    if (!metaHeader && !field) {
      const suggestion = suggestedHeader(header, validHeaders);
      const suffix = suggestion ? `; did you mean "${suggestion}"?` : '';
      throw new CsvReadError(path, headerRow.line, `Unknown column "${rawHeader}"${suffix}`);
    }
    return { raw: rawHeader, key, name: metaHeader ?? field?.name, field };
  });

  const users: Array<Record<string, unknown>> = [];
  for (const row of rows.slice(1)) {
    if (row.cells.length !== headers.length) {
      throw new CsvReadError(path, row.line, `Expected ${headers.length} cells but found ${row.cells.length}.`);
    }
    const user: Record<string, unknown> = {};
    headers.forEach((header, index) => {
      const value = row.cells[index];
      if (value.length === 0) return;
      if (header.name === 'personas') {
        user.personas = splitList(value, listDelimiter);
        return;
      }
      if (header.name === 'fuzzyUsername' || header.field?.isBoolean) {
        const parsed = parseBoolean(value);
        if (parsed === undefined) {
          throw new CsvReadError(path, row.line, `${header.raw} must be a boolean; got "${value}".`);
        }
        user[header.name as string] = parsed;
        return;
      }
      user[header.name as string] = value;
    });
    Object.defineProperty(user, csvRowInfo, { value: { path, line: row.line }, enumerable: false });
    users.push(user);
  }
  return { users };
};

export const neutralizeCsvFormula = (value: string): string => {
  if (value.startsWith("'") && FORMULA_PREFIX.test(value.slice(1))) return value;
  return FORMULA_PREFIX.test(value) ? `'${value}` : value;
};

export const restoreCsvFormula = (value: string): string =>
  value.startsWith("'") && FORMULA_PREFIX.test(value.slice(1)) ? value.slice(1) : value;

export const csvEscape = (value: unknown): string => {
  const text = value === null || value === undefined ? '' : String(value);
  const escaped = neutralizeCsvFormula(text).replaceAll('"', '""');
  return /[,"\n\r]/.test(escaped) ? `"${escaped}"` : escaped;
};

export const serializeCsv = (rows: Array<Record<string, unknown>>, columns: string[]): string => {
  const lines = [columns.join(',')];
  for (const row of rows) lines.push(columns.map((column) => csvEscape(row[column])).join(','));
  return lines.join('\n');
};
