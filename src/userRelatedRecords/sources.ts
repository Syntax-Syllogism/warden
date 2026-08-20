import type { UserFieldMeta, ValidationError } from '../userProvisioning/planner.js';
import type { ParsedSource, SourceExpr } from './types.js';

const USER_SOURCE_PREFIX = 'user.';
const CONTEXT_SOURCE_PREFIX = 'context.';

/** Split a source expression string into the shape the resolver dispatches on. */
export const parseSource = (from: unknown): ParsedSource => {
  if (typeof from !== 'string') return { kind: 'invalid' };
  const trimmed = from.trim();
  if (trimmed.toLowerCase().startsWith(CONTEXT_SOURCE_PREFIX)) {
    const name = trimmed.slice(CONTEXT_SOURCE_PREFIX.length);
    return name.length > 0 ? { kind: 'context', name } : { kind: 'invalid' };
  }
  if (!trimmed.toLowerCase().startsWith(USER_SOURCE_PREFIX)) return { kind: 'invalid' };
  const field = trimmed.slice(USER_SOURCE_PREFIX.length);
  if (field.length === 0 || field.includes('.')) return { kind: 'invalid' };
  return field.toLowerCase() === 'id' ? { kind: 'userId' } : { kind: 'userField', field };
};

export const isSourceExpr = (value: unknown): value is SourceExpr => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  const hasFrom = 'from' in entry;
  const hasValue = 'value' in entry;
  return Object.keys(entry).length === 1 && hasFrom !== hasValue;
};

export type SourceContext = {
  relationship: string;
  fieldName: string;
  userFields: Record<string, unknown>;
  userFieldMap: Map<string, UserFieldMeta>;
  savedUserId?: string;
};

export type SourceResolution = {
  value?: unknown;
  /** True when the source is `user.Id` and the User has not been saved yet. */
  pending?: boolean;
  error?: ValidationError;
};

/**
 * A value is "absent" only when it is literally undefined, null, or the empty string.
 * `0` and `false` are values, not absences, so this must never be written as a falsy test.
 */
const isAbsent = (value: unknown): boolean => value === undefined || value === null || value === '';

/**
 * Resolve one configured field source against a canonicalized user.
 *
 * Syntax problems and unknown `User` fields are caught during catalog validation, so
 * anything reported here is per-user: a known source whose effective value is absent.
 */
export const resolveSource = (expr: SourceExpr, ctx: SourceContext): SourceResolution => {
  if ('value' in expr) return { value: expr.value };
  const parsed = parseSource(expr.from);
  if (parsed.kind === 'userId') {
    return ctx.savedUserId ? { value: ctx.savedUserId } : { pending: true };
  }
  if (parsed.kind !== 'userField') {
    return {
      error: {
        messageKey: 'errorRelatedInvalidSourceValue',
        messageArgs: [ctx.relationship, ctx.fieldName, String(expr.from)],
      },
    };
  }
  const canonical = ctx.userFieldMap.get(parsed.field.toLowerCase())?.name ?? parsed.field;
  const value = ctx.userFields[canonical];
  if (isAbsent(value)) {
    return {
      error: {
        messageKey: 'errorRelatedSourceEmpty',
        messageArgs: [ctx.relationship, ctx.fieldName, canonical],
      },
    };
  }
  return { value };
};
