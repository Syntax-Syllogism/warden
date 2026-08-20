import { SfError } from '@salesforce/core';
import type { UserFieldMeta } from '../userProvisioning/planner.js';
import { isSourceExpr, parseSource } from './sources.js';
import type { RelatedCatalog, RelatedMessage, RelationshipDef, RelationshipMode, SourceExpr } from './types.js';

/** Not writable through the Account API; catalogs that try get a dedicated error. */
const UNWRITABLE_FIELDS = new Set(['personcontactid']);
const RELATIONSHIP_MODES: RelationshipMode[] = ['setIfEmpty', 'sync'];

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

const fail = (message: RelatedMessage, key: string, args: string[]): never => {
  throw new SfError(message(key, args));
};

const assertUserSource = (
  from: unknown,
  name: string,
  fieldName: string,
  userFieldMap: Map<string, UserFieldMeta>,
  message: RelatedMessage,
  options: { allowUserId: boolean }
): void => {
  const parsed = parseSource(from);
  if (parsed.kind === 'context') fail(message, 'errorRelatedContextUnsupported', [name, fieldName]);
  if (parsed.kind === 'invalid') fail(message, 'errorRelationshipInvalidFrom', [name, fieldName, String(from)]);
  if (parsed.kind === 'userId' && !options.allowUserId) {
    fail(message, 'errorRelationshipMatchFromUserId', [name]);
  }
  if (parsed.kind === 'userField' && !userFieldMap.has(parsed.field.toLowerCase())) {
    fail(message, 'errorRelationshipUnknownUserField', [name, fieldName, parsed.field]);
  }
};

const assertValidFields = (
  raw: unknown,
  name: string,
  userFieldMap: Map<string, UserFieldMeta>,
  message: RelatedMessage
): Record<string, SourceExpr> => {
  if (!isPlainObject(raw) || Object.keys(raw).length === 0) {
    fail(message, 'errorRelationshipInvalidFields', [name]);
  }
  const fields: Record<string, SourceExpr> = {};
  for (const [fieldName, expr] of Object.entries(raw as Record<string, unknown>)) {
    if (UNWRITABLE_FIELDS.has(fieldName.toLowerCase())) {
      fail(message, 'errorRelationshipUnwritableField', [name, fieldName]);
    }
    if (!isSourceExpr(expr)) fail(message, 'errorRelationshipInvalidSource', [name, fieldName]);
    const source = expr as SourceExpr;
    if ('from' in source) {
      assertUserSource(source.from, name, fieldName, userFieldMap, message, { allowUserId: true });
    }
    fields[fieldName] = source;
  }
  return fields;
};

const assertValidPhase = (raw: unknown, name: string, message: RelatedMessage): 'after' => {
  if (raw === undefined || raw === null) fail(message, 'errorRelationshipMissingPhase', [name]);
  if (raw === 'before') fail(message, 'errorPhaseBeforeUnsupported', [name]);
  if (raw !== 'after') fail(message, 'errorRelationshipInvalidPhase', [name, String(raw)]);
  return 'after';
};

const assertValidRecordType = (
  raw: unknown,
  name: string,
  message: RelatedMessage
): { developerName: string } | undefined => {
  if (raw === undefined || raw === null) return undefined;
  if (!isPlainObject(raw) || !isNonEmptyString(raw.developerName)) {
    fail(message, 'errorRelationshipInvalidRecordType', [name]);
  }
  return { developerName: (raw as { developerName: string }).developerName };
};

const assertValidMode = (raw: unknown, name: string, message: RelatedMessage): RelationshipMode => {
  if (raw === undefined || raw === null) return 'setIfEmpty';
  if (!RELATIONSHIP_MODES.includes(raw as RelationshipMode)) {
    fail(message, 'errorRelationshipInvalidMode', [name, String(raw)]);
  }
  return raw as RelationshipMode;
};

const assertValidRelationship = (
  name: string,
  raw: unknown,
  userFieldMap: Map<string, UserFieldMeta>,
  message: RelatedMessage
): RelationshipDef => {
  if (!isPlainObject(raw)) fail(message, 'errorRelationshipInvalidDefinition', [name]);
  const def = raw as Record<string, unknown>;
  if ('linkUser' in def) fail(message, 'errorLinkUserUnsupported', [name]);
  if (!isNonEmptyString(def.sobject)) fail(message, 'errorRelationshipInvalidSobject', [name]);
  const phase = assertValidPhase(def.phase, name, message);
  const match = def.match;
  if (!isPlainObject(match) || !isNonEmptyString(match.field) || !isNonEmptyString(match.from)) {
    fail(message, 'errorRelationshipInvalidMatch', [name]);
  }
  const matchDef = match as { field: string; from: string };
  assertUserSource(matchDef.from, name, 'match.from', userFieldMap, message, { allowUserId: false });
  return {
    sobject: def.sobject as string,
    phase,
    recordType: assertValidRecordType(def.recordType, name, message),
    match: { field: matchDef.field, from: matchDef.from },
    fields: assertValidFields(def.fields, name, userFieldMap, message),
    mode: assertValidMode(def.mode, name, message),
  };
};

/**
 * Validate a `--related-def` document. A malformed catalog is an operator error rather
 * than a row error, so every problem here throws and aborts the run.
 */
export const assertValidRelatedCatalog = (
  doc: Record<string, unknown>,
  userFieldMap: Map<string, UserFieldMeta>,
  message: RelatedMessage
): RelatedCatalog => {
  if (!isPlainObject(doc.relationships)) fail(message, 'errorInvalidRelatedCatalog', []);
  const relationships: Record<string, RelationshipDef> = {};
  for (const [name, raw] of Object.entries(doc.relationships as Record<string, unknown>)) {
    relationships[name] = assertValidRelationship(name, raw, userFieldMap, message);
  }
  return { relationships };
};
