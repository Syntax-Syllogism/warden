import type { Connection } from '@salesforce/core';
import { esc, soqlIn } from '../userShared/sfUtils.js';

const MATCH_QUERY_MAX_LENGTH = 18_000;

export type UserFieldMeta = {
  name: string;
  createable: boolean;
  updateable: boolean;
  filterable: boolean;
  externalId?: boolean;
  isBoolean?: boolean;
};

export type ExistingUser = { Id: string; IsActive?: boolean; Name?: string; Username?: string };

export type UserMatchRequest = {
  field: string;
  value: string;
  fuzzy?: boolean;
  key?: string;
};

export type ExistingUserResolution = {
  existingByField: Map<string, Map<string, ExistingUser>>;
  duplicates: Set<string>;
  matchesByRequest: Map<string, ExistingUser[]>;
};

export const matchKey = (field: string, value: string): string => `${field}:${value}`;

export const validateMatchField = (field: string, fieldMap: Map<string, UserFieldMeta>): UserFieldMeta => {
  const meta = fieldMap.get(field.toLowerCase());
  if (!meta || !meta.filterable) throw new Error(`Invalid match field "${field}".`);
  return meta;
};

export const escapeSoqlLike = (value: string): string =>
  value.replaceAll('\\', '\\\\\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_').replaceAll("'", "\\'");

const batchesByQueryLength = <T>(
  values: T[],
  render: (value: T) => string,
  prefixLength: number,
  suffixLength = 0
): T[][] => {
  const batches: T[][] = [];
  let current: T[] = [];
  let currentLength = prefixLength + suffixLength;
  for (const value of values) {
    const renderedLength = render(value).length;
    const nextLength = currentLength + (current.length > 0 ? 1 : 0) + renderedLength;
    if (current.length > 0 && nextLength > MATCH_QUERY_MAX_LENGTH) {
      batches.push(current);
      current = [];
      currentLength = prefixLength + suffixLength;
    }
    current.push(value);
    currentLength += (current.length > 1 ? 1 : 0) + renderedLength;
  }
  if (current.length > 0) batches.push(current);
  return batches;
};

const distinctUsers = (rows: ExistingUser[]): ExistingUser[] => {
  const seen = new Set<string>();
  return rows.filter((row) => {
    if (seen.has(row.Id)) return false;
    seen.add(row.Id);
    return true;
  });
};

const requestKey = (request: UserMatchRequest): string => request.key ?? matchKey(request.field, request.value);

const selectUserFields = (matchField: string): string[] => {
  const fields = ['Id', 'IsActive', 'Name', 'Username'];
  if (!fields.some((field) => field.toLowerCase() === matchField.toLowerCase())) fields.push(matchField);
  return fields;
};

const toExistingUser = (row: ExistingUser): ExistingUser => ({
  Id: row.Id,
  IsActive: row.IsActive,
  Name: row.Name,
  Username: row.Username,
});

const addRequestMatches = (
  matchesByRequest: Map<string, ExistingUser[]>,
  request: UserMatchRequest,
  matches: ExistingUser[]
): void => {
  matchesByRequest.set(requestKey(request), matches);
};

type ResolutionPart = ExistingUserResolution;

export const resolveExistingUsers = async (
  conn: Connection,
  requests: UserMatchRequest[],
  fieldMap: Map<string, UserFieldMeta>
): Promise<ExistingUserResolution> => {
  const existingByField = new Map<string, Map<string, ExistingUser>>();
  const duplicates = new Set<string>();
  const matchesByRequest = new Map<string, ExistingUser[]>();
  const exactByField = new Map<string, UserMatchRequest[]>();
  const fuzzyUsernameRequests = requests.filter((request) => request.fuzzy === true && request.field === 'Username');

  for (const request of requests) {
    if (request.field !== 'Id') validateMatchField(request.field, fieldMap);
    if (request.fuzzy === true && request.field === 'Username') continue;
    const group = exactByField.get(request.field) ?? [];
    group.push(request);
    exactByField.set(request.field, group);
  }

  const exactQueries = Promise.all(
    [...exactByField.entries()].map(async ([field, fieldRequests]): Promise<ResolutionPart | undefined> => {
      const values = [...new Set(fieldRequests.map((request) => request.value))];
      if (values.length === 0) return;
      const prefix = `SELECT ${selectUserFields(field).join(', ')} FROM User WHERE ${field} IN (`;
      const chunks = batchesByQueryLength(values, (value) => `'${esc(value)}'`, prefix.length, 1);
      const rows = (
        await Promise.all(
          chunks.map(
            async (chunk) =>
              (
                await conn.query<ExistingUser & Record<string, unknown>>(`${prefix}${soqlIn(chunk)})`)
              ).records
          )
        )
      ).flat();
      const fieldMatches = new Map<string, ExistingUser>();
      const exactMatchesByRequest = new Map<string, ExistingUser[]>();
      const exactDuplicates = new Set<string>();
      for (const request of fieldRequests) {
        const matches = distinctUsers(
          rows
            .filter((row) => String(row[field] ?? '').toLowerCase() === request.value.toLowerCase())
            .map(toExistingUser)
        );
        addRequestMatches(exactMatchesByRequest, request, matches);
        if (matches.length > 1) exactDuplicates.add(matchKey(field, request.value));
        else if (matches.length === 1) fieldMatches.set(request.value, matches[0]);
      }
      return {
        existingByField: new Map([[field, fieldMatches]]),
        duplicates: exactDuplicates,
        matchesByRequest: exactMatchesByRequest,
      };
    })
  );

  const fuzzyQuery = (async (): Promise<ResolutionPart | undefined> => {
    if (fuzzyUsernameRequests.length === 0) return;
    const bases = [...new Set(fuzzyUsernameRequests.map((request) => request.value))];
    const renderClause = (base: string): string =>
      `(Username = '${esc(base)}' OR Username LIKE '${escapeSoqlLike(base)}.%')`;
    const prefix = 'SELECT Id, IsActive, Name, Username FROM User WHERE ';
    const chunks = batchesByQueryLength(bases, renderClause, prefix.length);
    const rows = (
      await Promise.all(
        chunks.map(
          async (chunk) => (await conn.query<ExistingUser>(`${prefix}${chunk.map(renderClause).join(' OR ')}`)).records
        )
      )
    ).flat();
    const fieldMatches = new Map<string, ExistingUser>();
    const fuzzyMatchesByRequest = new Map<string, ExistingUser[]>();
    const fuzzyDuplicates = new Set<string>();
    const rowsByBase = new Map<string, ExistingUser[]>();
    const basesByRowId = new Map<string, Set<string>>();
    for (const base of bases) {
      const normalizedBase = base.toLowerCase();
      const matches = distinctUsers(
        rows
          .filter((row) => {
            const username = row.Username?.toLowerCase() ?? '';
            return username === normalizedBase || username.startsWith(`${normalizedBase}.`);
          })
          .map(toExistingUser)
      );
      rowsByBase.set(base, matches);
      for (const match of matches) {
        const matchingBases = basesByRowId.get(match.Id) ?? new Set<string>();
        matchingBases.add(base);
        basesByRowId.set(match.Id, matchingBases);
      }
    }
    for (const base of bases) {
      const matches = rowsByBase.get(base) ?? [];
      for (const request of fuzzyUsernameRequests.filter((candidate) => candidate.value === base)) {
        addRequestMatches(fuzzyMatchesByRequest, request, matches);
      }
      const matchesAnotherBase = matches.some((match) => (basesByRowId.get(match.Id)?.size ?? 0) > 1);
      if (matches.length > 1 || matchesAnotherBase) fuzzyDuplicates.add(matchKey('Username', base));
      else if (matches.length === 1) fieldMatches.set(base, matches[0]);
    }
    return {
      existingByField: new Map([['Username', fieldMatches]]),
      duplicates: fuzzyDuplicates,
      matchesByRequest: fuzzyMatchesByRequest,
    };
  })();

  const [exactResolutions, fuzzyResolution] = await Promise.all([exactQueries, fuzzyQuery]);
  for (const resolution of [...exactResolutions, fuzzyResolution]) {
    if (!resolution) continue;
    for (const [field, fieldMatches] of resolution.existingByField) {
      const mergedFieldMatches = existingByField.get(field) ?? new Map<string, ExistingUser>();
      for (const [value, user] of fieldMatches) mergedFieldMatches.set(value, user);
      existingByField.set(field, mergedFieldMatches);
    }
    for (const duplicate of resolution.duplicates) duplicates.add(duplicate);
    for (const [key, matches] of resolution.matchesByRequest) matchesByRequest.set(key, matches);
  }

  return { existingByField, duplicates, matchesByRequest };
};
