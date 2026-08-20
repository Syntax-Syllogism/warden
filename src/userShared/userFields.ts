import type { Connection } from '@salesforce/core';
import { buildFieldMap, type UserFieldMeta } from '../userProvisioning/planner.js';

/**
 * The subset of an sObject field describe warden projects. Declared locally so the
 * projection does not depend on the exact optionality of the jsforce describe types.
 */
type DescribeFieldLike = {
  name: string;
  createable: boolean;
  updateable: boolean;
  filterable: boolean;
  readable?: boolean;
  externalId?: boolean;
  unique?: boolean;
  caseSensitive?: boolean;
  type?: string;
};

type DescribeRecordTypeLike = {
  recordTypeId: string;
  available?: boolean;
  isPersonType?: boolean;
};

export type SobjectRecordTypeInfo = {
  available: boolean;
  isPersonType: boolean;
};

export type SobjectDescribeInfo = {
  name: string;
  queryable: boolean;
  fields: Map<string, UserFieldMeta>;
  recordTypeInfos: Map<string, SobjectRecordTypeInfo>;
};

/**
 * Per-run describe cache. Owned by the caller (the provisioning use case) rather than
 * this module so it cannot leak between orgs or between tests in the same process.
 */
export type SobjectDescribeCache = Map<string, SobjectDescribeInfo>;

const projectFields = (fields: DescribeFieldLike[]): Map<string, UserFieldMeta> =>
  buildFieldMap(
    fields.map(
      (field): UserFieldMeta => ({
        name: field.name,
        createable: field.createable,
        updateable: field.updateable,
        filterable: field.filterable,
        // Older describe responses do not include this flag; preserve that distinction
        // so preflight can treat an explicit false as inaccessible without breaking them.
        ...(field.readable === undefined ? {} : { readable: field.readable }),
        externalId: field.externalId,
        // Describes that omit `unique` must not gain an own property holding `undefined`.
        ...(field.unique === undefined ? {} : { unique: field.unique }),
        ...(field.caseSensitive === undefined ? {} : { caseSensitive: field.caseSensitive }),
        isBoolean: field.type === 'boolean',
      })
    )
  );

/** Describe any sObject, reusing the per-run cache when one is supplied. */
export const describeSobject = async (
  conn: Connection,
  sobject: string,
  cache?: SobjectDescribeCache
): Promise<SobjectDescribeInfo> => {
  const cacheKey = sobject.toLowerCase();
  const cached = cache?.get(cacheKey);
  if (cached) return cached;
  const described = (await conn.describe(sobject)) as {
    name?: string;
    queryable?: boolean;
    fields: DescribeFieldLike[];
    recordTypeInfos?: DescribeRecordTypeLike[];
  };
  const info: SobjectDescribeInfo = {
    name: described.name ?? sobject,
    // Standard describes always carry `queryable`; treat an absent flag as queryable
    // so a trimmed test fixture is not reported as an unreadable object.
    queryable: described.queryable !== false,
    fields: projectFields(described.fields),
    recordTypeInfos: new Map(
      (described.recordTypeInfos ?? []).map((recordType) => [
        recordType.recordTypeId,
        { available: recordType.available !== false, isPersonType: recordType.isPersonType === true },
      ])
    ),
  };
  cache?.set(cacheKey, info);
  return info;
};

/** Describe an sObject and project it into the field map callers need. */
export const describeSobjectFields = async (
  conn: Connection,
  sobject: string,
  cache?: SobjectDescribeCache
): Promise<Map<string, UserFieldMeta>> => (await describeSobject(conn, sobject, cache)).fields;

/** Describe the User sObject and project it into the field map callers need. */
export const describeUserFields = async (
  conn: Connection,
  cache?: SobjectDescribeCache
): Promise<Map<string, UserFieldMeta>> => describeSobjectFields(conn, 'User', cache);
