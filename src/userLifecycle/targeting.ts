import { SfError, type Connection } from '@salesforce/core';
import { type UserFieldMeta } from '../userProvisioning/planner.js';
import { readUsersDefinition } from '../userProvisioning/definitionReader.js';
import { resolveExistingUsers, validateMatchField } from '../userMatching/index.js';
import { getCsvRowInfo, type InputFormat } from '../userShared/csv.js';
import type { ResolvedTargetUser, TargetError, TargetRequest } from './types.js';

export type TargetSelectionFlags<TInputFormat extends string = InputFormat> = {
  user?: string;
  'users-def'?: string;
  'external-id'?: string;
  'input-format'?: TInputFormat;
  'csv-list-delimiter'?: string;
};

export type TargetSelectionMessages = {
  invalidUserMatchField: (field: string) => string;
  invalidJson: (path: string, error: string) => string;
};

const readCaseInsensitive = (source: Record<string, unknown>, field: string): unknown => {
  const rawKey = Object.keys(source).find((key) => key.toLowerCase() === field.toLowerCase());
  return rawKey ? source[rawKey] : undefined;
};

const relationshipName = (
  id: string | null | undefined,
  relationship: { Name?: string } | null | undefined
): string | undefined => relationship?.Name ?? id ?? undefined;

export const parseUserFlag = (raw: string): { field: string; value: string } => {
  const colon = raw.indexOf(':');
  if (colon <= 0 || colon === raw.length - 1) {
    throw new Error(`Invalid --user value "${raw}". Expected field:value.`);
  }
  return {
    field: raw.slice(0, colon).trim(),
    value: raw.slice(colon + 1),
  };
};

const resolveFieldName = (field: string, fieldMap: Map<string, UserFieldMeta>): string | undefined => {
  if (field.toLowerCase() === 'id') return 'Id';
  return fieldMap.get(field.toLowerCase())?.name;
};

const resolveMatchField = (
  rawField: string,
  fieldMap: Map<string, UserFieldMeta>
): { field: string } | { error: string } => {
  try {
    return { field: rawField.toLowerCase() === 'id' ? 'Id' : validateMatchField(rawField, fieldMap).name };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
};

export const resolveTargetField = (field: string, fieldMap: Map<string, UserFieldMeta>): string | undefined =>
  resolveFieldName(field, fieldMap);

export const buildTargetRequests = async (
  flags: TargetSelectionFlags<string>,
  fieldMap: Map<string, UserFieldMeta>,
  message: TargetSelectionMessages
): Promise<{ requests: TargetRequest[]; errors: TargetError[] }> => {
  if (typeof flags.user === 'string' && flags.user.length > 0) {
    const { field, value } = parseUserFlag(flags.user);
    const matchField = resolveTargetField(field, fieldMap);
    if (!matchField) throw new SfError(message.invalidUserMatchField(field));
    return { requests: [{ key: `${matchField}:${value}`, field: matchField, value, order: 0 }], errors: [] };
  }

  const inputFormat: InputFormat | undefined =
    flags['input-format'] === 'json' || flags['input-format'] === 'csv' ? flags['input-format'] : undefined;
  const usersDoc = await readUsersDefinition(
    String(flags['users-def']),
    {
      fieldMap,
      inputFormat,
      csvListDelimiter: flags['csv-list-delimiter'],
    },
    message.invalidJson
  );
  return extractDefTargets(usersDoc, flags['external-id'], fieldMap);
};

export const extractDefTargets = (
  rawDoc: unknown,
  defaultExternalId: string | undefined,
  fieldMap: Map<string, UserFieldMeta>
): { requests: TargetRequest[]; errors: TargetError[] } => {
  const errors: TargetError[] = [];
  const requests: TargetRequest[] = [];
  if (!rawDoc || typeof rawDoc !== 'object') {
    return {
      requests,
      errors: [
        {
          key: 'user-def',
          field: 'users',
          value: '',
          message: 'users-def.json must contain a users array.',
          order: 0,
        },
      ],
    };
  }
  const users = (rawDoc as { users?: unknown }).users;
  if (!Array.isArray(users)) {
    return {
      requests,
      errors: [
        {
          key: 'user-def',
          field: 'users',
          value: '',
          message: 'users-def.json must contain a users array.',
          order: 0,
        },
      ],
    };
  }

  for (const [index, rawUser] of users.entries()) {
    const rowInfo = getCsvRowInfo(rawUser);
    const key = rowInfo ? `${rowInfo.path}:${rowInfo.line}` : `user[${index + 1}]`;
    const withRowContext = (message: string): string => (rowInfo ? `${key} — ${message}` : message);
    if (!rawUser || typeof rawUser !== 'object') {
      errors.push({
        key,
        field: 'users',
        value: '',
        message: withRowContext('Each users-def entry must be an object.'),
        order: index,
      });
      continue;
    }
    const user = rawUser as Record<string, unknown>;
    const matchFieldRaw = readCaseInsensitive(user, 'match');
    const rawField =
      typeof matchFieldRaw === 'string' && matchFieldRaw.trim().length > 0 ? matchFieldRaw : defaultExternalId;
    if (!rawField || rawField.trim().length === 0) {
      errors.push({
        key,
        field: 'match',
        value: '',
        message: withRowContext(
          'Each users-def entry must specify a match field or the --external-id flag must be set.'
        ),
        order: index,
      });
      continue;
    }
    const matchFieldResult = resolveMatchField(rawField, fieldMap);
    if ('error' in matchFieldResult) {
      errors.push({
        key,
        field: 'match',
        value: rawField,
        message: withRowContext(matchFieldResult.error),
        order: index,
        ...(rowInfo ? { source: rowInfo } : {}),
      });
      continue;
    }
    const matchField = matchFieldResult.field;
    const matchValue = readCaseInsensitive(user, matchField);
    if (typeof matchValue !== 'string' || matchValue.length === 0) {
      errors.push({
        key,
        field: matchField,
        value: '',
        message: withRowContext(`${matchField} must be populated on the user-def entry.`),
        order: index,
      });
      continue;
    }
    requests.push({
      key: `${matchField}:${matchValue}`,
      field: matchField,
      value: matchValue,
      order: index,
      ...(rowInfo ? { source: rowInfo } : {}),
      ...(matchField === 'Username' && readCaseInsensitive(user, 'fuzzyUsername') === true ? { fuzzy: true } : {}),
    });
  }

  return { requests, errors };
};

export const resolveTargets = async (
  conn: Connection,
  requests: TargetRequest[],
  fieldMap: Map<string, UserFieldMeta>
): Promise<{ targets: ResolvedTargetUser[]; errors: TargetError[] }> => {
  const targets: ResolvedTargetUser[] = [];
  const errors: TargetError[] = [];
  const resolution = await resolveExistingUsers(conn, requests, fieldMap);
  for (const request of requests) {
    const matches = resolution.matchesByRequest.get(request.key) ?? [];
    const sourcePrefix = request.source ? `${request.source.path}:${request.source.line} — ` : '';
    if (matches.length === 0) {
      errors.push({
        key: request.key,
        field: request.field,
        value: request.value,
        message: `${sourcePrefix}${request.field}="${request.value}" matched no user`,
        order: request.order,
        ...(request.source ? { source: request.source } : {}),
      });
      continue;
    }
    if (matches.length > 1 || resolution.duplicates.has(`${request.field}:${request.value}`)) {
      errors.push({
        key: request.key,
        field: request.field,
        value: request.value,
        message: `${sourcePrefix}${request.field}="${request.value}" matched multiple users`,
        order: request.order,
        ...(request.source ? { source: request.source } : {}),
      });
      continue;
    }
    const row = matches[0];
    targets.push({
      key: request.key,
      Id: row.Id,
      IsActive: Boolean(row.IsActive),
      name: row.Name,
      username: row.Username,
      email: row.Email,
      profile: relationshipName(row.ProfileId, row.Profile),
      role: relationshipName(row.UserRoleId, row.UserRole),
      field: request.field,
      value: request.value,
      order: request.order,
    });
  }

  return { targets: targets.sort((a, b) => a.order - b.order), errors: errors.sort((a, b) => a.order - b.order) };
};
