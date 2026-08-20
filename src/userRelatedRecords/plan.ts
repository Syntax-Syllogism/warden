import type { Connection } from '@salesforce/core';
import type { CanonicalizedUser, UserFieldMeta, ValidationError } from '../userProvisioning/planner.js';
import { esc, soqlIn } from '../userShared/sfUtils.js';
import type { RelatedPreflightResult } from './preflight.js';
import { resolveSource } from './sources.js';
import type { RelatedCatalog, RelatedMessage, RelatedRecordPlan, RelationshipDef } from './types.js';

/** Salesforce accepts at most 200 records per create/update request. */
export const RELATED_DML_CHUNK_SIZE = 200;
const MATCH_QUERY_CHUNK_SIZE = 200;
const MATCH_QUERY_MAX_LENGTH = 18_000;

type ExistingRelatedRecord = Record<string, unknown> & { Id: string; RecordTypeId?: string | null };

type MatchGroupKey = string;
const matchGroupKey = (sobject: string, matchField: string): MatchGroupKey =>
  `${sobject.toLowerCase()}|${matchField.toLowerCase()}`;

const matchValueKey = (value: string, def: RelationshipDef, preflight: RelatedPreflightResult): string => {
  const matchField = preflight.fieldsBySobject.get(def.sobject.toLowerCase())?.get(def.match.field.toLowerCase());
  return matchField?.caseSensitive === false ? value.toLowerCase() : value;
};

type PendingMatch = {
  order: number;
  relationship: string;
  def: RelationshipDef;
  matchValue: string;
};

/**
 * A value is "empty" only when it is literally null or the empty string. A
 * whitespace-only value counts as populated and is preserved by `setIfEmpty`.
 */
const isEmptyExistingValue = (value: unknown): boolean => value === null || value === '';

const canonicalFieldName = (field: string, fieldMap: Map<string, UserFieldMeta> | undefined): string =>
  fieldMap?.get(field.toLowerCase())?.name ?? field;

/** Split IN-list values at Salesforce's count and query-text limits. */
const matchQueryBatches = (values: string[], prefix: string): string[][] => {
  const batches: string[][] = [];
  let current: string[] = [];
  let currentLength = prefix.length + 1; // Closing parenthesis.
  for (const value of values) {
    const renderedLength = `'${esc(value)}'`.length;
    const nextLength = currentLength + (current.length > 0 ? 1 : 0) + renderedLength;
    if (current.length > 0 && (current.length === MATCH_QUERY_CHUNK_SIZE || nextLength > MATCH_QUERY_MAX_LENGTH)) {
      batches.push(current);
      current = [];
      currentLength = prefix.length + 1;
    }
    current.push(value);
    currentLength += (current.length > 1 ? 1 : 0) + renderedLength;
  }
  if (current.length > 0) batches.push(current);
  return batches;
};

const toErrorMessage = (message: RelatedMessage, error: ValidationError): string =>
  message(error.messageKey, error.messageArgs);

const selectFieldsFor = (defs: RelationshipDef[], fieldMap: Map<string, UserFieldMeta> | undefined): string[] => {
  const names = new Set<string>(['Id']);
  if (fieldMap?.has('recordtypeid')) names.add('RecordTypeId');
  for (const def of defs) {
    names.add(canonicalFieldName(def.match.field, fieldMap));
    for (const field of Object.keys(def.fields)) names.add(canonicalFieldName(field, fieldMap));
  }
  return [...names];
};

const skippedPlan = (relationship: string, def: RelationshipDef): RelatedRecordPlan => ({
  relationship,
  phase: 'after',
  sobject: def.sobject,
  matchField: def.match.field,
  fields: {},
  pendingUserIdFields: [],
  mode: def.mode ?? 'setIfEmpty',
  status: 'skipped',
  errors: [],
});

const failedPlan = (relationship: string, def: RelationshipDef, errors: string[]): RelatedRecordPlan => ({
  ...skippedPlan(relationship, def),
  status: 'failed',
  errors,
});

/** Resolve each user's match value; a resolution failure fails that user's plan only. */
const resolveMatchValues = (options: {
  users: Array<{ user: CanonicalizedUser; order: number }>;
  catalog: RelatedCatalog;
  preflight: RelatedPreflightResult;
  userFieldMap: Map<string, UserFieldMeta>;
  message: RelatedMessage;
}): { pending: PendingMatch[]; plansByOrder: Map<number, RelatedRecordPlan[]> } => {
  const { users, catalog, preflight, userFieldMap, message } = options;
  const pending: PendingMatch[] = [];
  const plansByOrder = new Map<number, RelatedRecordPlan[]>();
  for (const { user, order } of users) {
    const plans: RelatedRecordPlan[] = [];
    for (const relationship of user.related ?? []) {
      const def = catalog.relationships[relationship];
      if (!def) continue;
      if (!preflight.eligible.has(relationship)) {
        plans.push(skippedPlan(relationship, def));
        continue;
      }
      const resolved = resolveSource(
        { from: def.match.from },
        { relationship, fieldName: 'match.from', userFields: user.fields, userFieldMap }
      );
      if (resolved.error) {
        plans.push(failedPlan(relationship, def, [toErrorMessage(message, resolved.error)]));
        continue;
      }
      const matchValue = String(resolved.value);
      plans.push({
        ...skippedPlan(relationship, def),
        matchField: canonicalFieldName(def.match.field, preflight.fieldsBySobject.get(def.sobject.toLowerCase())),
        status: 'planned',
        matchValue,
      });
      pending.push({ order, relationship, def, matchValue });
    }
    if (plans.length > 0) plansByOrder.set(order, plans);
  }
  return { pending, plansByOrder };
};

/** One bulk query per (sObject, match field) across the whole batch, never per user. */
const queryExistingRecords = async (
  conn: Connection,
  pending: PendingMatch[],
  preflight: RelatedPreflightResult
): Promise<Map<MatchGroupKey, Map<string, ExistingRelatedRecord[]>>> => {
  const groups = new Map<MatchGroupKey, { defs: RelationshipDef[]; values: Set<string> }>();
  for (const entry of pending) {
    const key = matchGroupKey(entry.def.sobject, entry.def.match.field);
    const group = groups.get(key) ?? { defs: [], values: new Set<string>() };
    if (!group.defs.includes(entry.def)) group.defs.push(entry.def);
    group.values.add(entry.matchValue);
    groups.set(key, group);
  }
  // Reads go through conn.query so dry runs never touch conn.sobject(...).
  const grouped = await Promise.all(
    [...groups].map(async ([key, group]) => {
      const primaryDef = group.defs[0];
      const fieldMap = preflight.fieldsBySobject.get(primaryDef.sobject.toLowerCase());
      const select = selectFieldsFor(group.defs, fieldMap).join(', ');
      const matchField = canonicalFieldName(primaryDef.match.field, fieldMap);
      const prefix = `SELECT ${select} FROM ${primaryDef.sobject} WHERE ${matchField} IN (`;
      const rows = (
        await Promise.all(
          matchQueryBatches([...group.values], prefix).map(
            async (chunk) => (await conn.query<ExistingRelatedRecord>(`${prefix}${soqlIn(chunk)})`)).records
          )
        )
      ).flat();
      const byValue = new Map<string, ExistingRelatedRecord[]>();
      for (const row of rows) {
        const rowValue = row[matchField];
        if (rowValue === undefined || rowValue === null) continue;
        const valueKey = matchValueKey(String(rowValue), primaryDef, preflight);
        byValue.set(valueKey, (byValue.get(valueKey) ?? []).concat(row));
      }
      return [key, byValue] as const;
    })
  );
  return new Map(grouped);
};

const applyModeFilter = (
  fields: Record<string, unknown>,
  existing: ExistingRelatedRecord | undefined,
  mode: RelatedRecordPlan['mode']
): Record<string, unknown> => {
  if (!existing || mode === 'sync') return fields;
  return Object.fromEntries(Object.entries(fields).filter(([name]) => isEmptyExistingValue(existing[name])));
};

/** Check only fields that this individual create or update will actually send. */
const assertPlannedFieldsWritable = (
  plan: RelatedRecordPlan,
  fieldMap: Map<string, UserFieldMeta>,
  message: RelatedMessage
): void => {
  const requiredPermission = plan.existingId ? 'updateable' : 'createable';
  const unavailable = [...Object.keys(plan.fields), ...plan.pendingUserIdFields].filter((field) => {
    const meta = fieldMap.get(field.toLowerCase());
    return meta ? !meta[requiredPermission] : false;
  });
  if (unavailable.length > 0) {
    plan.status = 'failed';
    plan.errors.push(
      message('errorRelatedFieldsNotWritableForOperation', [plan.sobject, unavailable.join(', '), requiredPermission])
    );
  }
};

const resolveConfiguredFields = (options: {
  relationship: string;
  def: RelationshipDef;
  user: CanonicalizedUser;
  userFieldMap: Map<string, UserFieldMeta>;
  targetFieldMap: Map<string, UserFieldMeta>;
  message: RelatedMessage;
}): { fields: Record<string, unknown>; pendingUserIdFields: string[]; errors: string[] } => {
  const { relationship, def, user, userFieldMap, targetFieldMap, message } = options;
  const fields: Record<string, unknown> = {};
  const pendingUserIdFields: string[] = [];
  const errors: string[] = [];
  for (const [fieldName, expr] of Object.entries(def.fields)) {
    const resolved = resolveSource(expr, { relationship, fieldName, userFields: user.fields, userFieldMap });
    if (resolved.error) errors.push(toErrorMessage(message, resolved.error));
    else if (resolved.pending) pendingUserIdFields.push(canonicalFieldName(fieldName, targetFieldMap));
    else fields[canonicalFieldName(fieldName, targetFieldMap)] = resolved.value;
  }
  return { fields, pendingUserIdFields, errors };
};

const finalizePlan = (options: {
  plan: RelatedRecordPlan;
  def: RelationshipDef;
  user: CanonicalizedUser;
  userFieldMap: Map<string, UserFieldMeta>;
  targetFieldMap: Map<string, UserFieldMeta>;
  matches: ExistingRelatedRecord[];
  recordTypeId?: string;
  message: RelatedMessage;
}): void => {
  const { plan, def, user, userFieldMap, targetFieldMap, matches, recordTypeId, message } = options;
  const matchValue = plan.matchValue as string;
  if (matches.length > 1) {
    plan.status = 'failed';
    plan.errors.push(
      message('errorAmbiguousRelatedMatch', [plan.relationship, def.sobject, def.match.field, matchValue])
    );
    return;
  }
  const existing = matches[0];
  const resolved = resolveConfiguredFields({
    relationship: plan.relationship,
    def,
    user,
    userFieldMap,
    targetFieldMap,
    message,
  });
  if (resolved.errors.length > 0) {
    plan.status = 'failed';
    plan.errors.push(...resolved.errors);
    return;
  }
  if (existing) {
    plan.existingId = existing.Id;
    plan.existingValues = { ...existing };
    if (recordTypeId && existing.RecordTypeId !== recordTypeId) {
      plan.status = 'failed';
      plan.errors.push(
        message('errorRelatedRecordTypeMismatch', [plan.relationship, def.sobject, def.recordType?.developerName ?? ''])
      );
      return;
    }
  } else if (recordTypeId) {
    // RecordTypeId is written on create only; warden never retags an existing record.
    plan.recordTypeId = recordTypeId;
  }
  const filtered = applyModeFilter(resolved.fields, existing, plan.mode);
  // A create always writes the match field, so a re-run can match what this run created.
  plan.fields = existing
    ? filtered
    : { ...filtered, [canonicalFieldName(def.match.field, targetFieldMap)]: matchValue };
  // `user.Id` fields are filled in after the User save, so they carry the same mode
  // filtering the resolved fields already went through.
  plan.pendingUserIdFields =
    existing && plan.mode === 'setIfEmpty'
      ? resolved.pendingUserIdFields.filter((name) => isEmptyExistingValue(existing[name]))
      : resolved.pendingUserIdFields;
  assertPlannedFieldsWritable(plan, targetFieldMap, message);
};

/** Fail every plan that shares a `(relationship, match value)` with another plan. */
const applyCollisionCheck = (
  plansByOrder: Map<number, RelatedRecordPlan[]>,
  catalog: RelatedCatalog,
  preflight: RelatedPreflightResult,
  message: RelatedMessage
): void => {
  const byKey = new Map<string, RelatedRecordPlan[]>();
  for (const plans of plansByOrder.values()) {
    for (const plan of plans) {
      if (plan.status !== 'planned' || plan.matchValue === undefined) continue;
      const def = catalog.relationships[plan.relationship];
      const key = `${plan.relationship} ${matchValueKey(plan.matchValue, def, preflight)}`;
      byKey.set(key, (byKey.get(key) ?? []).concat(plan));
    }
  }
  for (const colliding of byKey.values()) {
    if (colliding.length < 2) continue;
    for (const plan of colliding) {
      plan.status = 'failed';
      plan.errors.push(
        message('errorRelatedMatchCollision', [plan.relationship, plan.matchField, plan.matchValue as string])
      );
    }
  }
};

/**
 * Build every user's `after`-phase related-record plans for the batch.
 *
 * Matching is a read, so this is safe in a dry run; the returned plans carry no DML.
 */
export const buildRelatedPlans = async (options: {
  conn: Connection;
  users: Array<{ user: CanonicalizedUser; order: number }>;
  catalog: RelatedCatalog;
  preflight: RelatedPreflightResult;
  userFieldMap: Map<string, UserFieldMeta>;
  message: RelatedMessage;
}): Promise<Map<number, RelatedRecordPlan[]>> => {
  const { conn, users, catalog, preflight, userFieldMap, message } = options;
  const { pending, plansByOrder } = resolveMatchValues({ users, catalog, preflight, userFieldMap, message });
  if (plansByOrder.size === 0) return plansByOrder;
  const index = await queryExistingRecords(conn, pending, preflight);
  const usersByOrder = new Map(users.map(({ user, order }) => [order, user]));

  for (const [order, plans] of plansByOrder) {
    const user = usersByOrder.get(order);
    if (!user) continue;
    for (const plan of plans) {
      if (plan.status !== 'planned' || plan.matchValue === undefined) continue;
      const def = catalog.relationships[plan.relationship];
      const matches =
        index.get(matchGroupKey(def.sobject, def.match.field))?.get(matchValueKey(plan.matchValue, def, preflight)) ??
        [];
      finalizePlan({
        plan,
        def,
        user,
        userFieldMap,
        targetFieldMap: preflight.fieldsBySobject.get(def.sobject.toLowerCase()) ?? new Map<string, UserFieldMeta>(),
        matches,
        recordTypeId: preflight.recordTypeIdByRelationship.get(plan.relationship),
        message,
      });
    }
  }
  applyCollisionCheck(plansByOrder, catalog, preflight, message);
  return plansByOrder;
};
