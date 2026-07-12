import type { Connection } from '@salesforce/core';
import { type UserFieldMeta, validateExternalIdField } from '../userProvisioning/planner.js';
import { soqlIn } from '../userShared/sfUtils.js';
import type { ResolvedTargetUser, TargetError, TargetRequest } from './types.js';

const readCaseInsensitive = (source: Record<string, unknown>, field: string): unknown => {
  const rawKey = Object.keys(source).find((key) => key.toLowerCase() === field.toLowerCase());
  return rawKey ? source[rawKey] : undefined;
};

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

const resolveFieldName = (field: string, fieldMap: Map<string, UserFieldMeta>, allowId = true): string | undefined => {
  if (allowId && field.toLowerCase() === 'id') return 'Id';
  return fieldMap.get(field.toLowerCase())?.name;
};

export const resolveTargetField = (field: string, fieldMap: Map<string, UserFieldMeta>): string | undefined =>
  resolveFieldName(field, fieldMap, true);

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
    const key = `user[${index + 1}]`;
    if (!rawUser || typeof rawUser !== 'object') {
      errors.push({
        key,
        field: 'users',
        value: '',
        message: 'Each users-def entry must be an object.',
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
        message: 'Each users-def entry must specify a match field or the --external-id flag must be set.',
        order: index,
      });
      continue;
    }
    const matchField = resolveFieldName(rawField, fieldMap) ?? validateExternalIdField(rawField, fieldMap).name;
    const matchValue = readCaseInsensitive(user, matchField);
    if (typeof matchValue !== 'string' || matchValue.length === 0) {
      errors.push({
        key,
        field: matchField,
        value: '',
        message: `${matchField} must be populated on the user-def entry.`,
        order: index,
      });
      continue;
    }
    requests.push({
      key: `${matchField}:${matchValue}`,
      field: matchField,
      value: matchValue,
      order: index,
    });
  }

  return { requests, errors };
};

export const resolveTargets = async (
  conn: Connection,
  requests: TargetRequest[]
): Promise<{ targets: ResolvedTargetUser[]; errors: TargetError[] }> => {
  const grouped = new Map<string, TargetRequest[]>();
  for (const request of requests) {
    const group = grouped.get(request.field) ?? [];
    group.push(request);
    grouped.set(request.field, group);
  }

  const targets: ResolvedTargetUser[] = [];
  const errors: TargetError[] = [];

  await Promise.all(
    [...grouped.entries()].map(async ([field, fieldRequests]) => {
      const values = [...new Set(fieldRequests.map((request) => request.value))];
      const query =
        field === 'Id'
          ? `SELECT Id, IsActive FROM User WHERE Id IN (${soqlIn(values)})`
          : `SELECT Id, IsActive, ${field} FROM User WHERE ${field} IN (${soqlIn(values)})`;
      const rows = (await conn.query<Record<string, unknown>>(query)).records;
      const rowsByValue = new Map<string, Array<Record<string, unknown>>>();
      for (const row of rows) {
        const value = String(row[field === 'Id' ? 'Id' : field] ?? '');
        const group = rowsByValue.get(value) ?? [];
        group.push(row);
        rowsByValue.set(value, group);
      }

      for (const request of fieldRequests) {
        const matches = rowsByValue.get(request.value) ?? [];
        if (matches.length === 0) {
          errors.push({
            key: request.key,
            field: request.field,
            value: request.value,
            message: `${request.field}="${request.value}" matched no user`,
            order: request.order,
          });
          continue;
        }
        if (matches.length > 1) {
          errors.push({
            key: request.key,
            field: request.field,
            value: request.value,
            message: `${request.field}="${request.value}" matched multiple users`,
            order: request.order,
          });
          continue;
        }
        const row = matches[0];
        targets.push({
          key: request.key,
          Id: String(row.Id),
          IsActive: Boolean(row.IsActive),
          field: request.field,
          value: request.value,
          order: request.order,
        });
      }
    })
  );

  return { targets: targets.sort((a, b) => a.order - b.order), errors: errors.sort((a, b) => a.order - b.order) };
};
