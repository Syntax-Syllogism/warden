import { Messages } from '@salesforce/core';
import { matchKey, usableMatchValue, type ExistingUser } from '../userMatching/index.js';
import type { RelatedRecordPlan, RelatedRecordResult } from '../userRelatedRecords/types.js';
import type { CsvRowInfo } from '../userShared/csv.js';
import {
  buildDefaultAlias,
  buildDefaultUsername,
  type CanonicalizedUser,
  type PersonaDefinition,
  missingRequiredFieldsForInsert,
  type UserFieldMeta,
} from './planner.js';
import type { ResolvedRefs } from './assignmentPlan.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('@syntax-syllogism/warden', 'warden.provision');

type JsonRecord = Record<string, unknown>;

export type UserPlan = {
  planId: string;
  order: number;
  key: string;
  personas: string[];
  effectivePersona: PersonaDefinition;
  matchedBy: string | null;
  /** The value looked up under `matchedBy`; null when no lookup was issued under it. */
  matchValue: string | null;
  target: JsonRecord;
  existing?: ExistingUser;
  actions: string[];
  errors: string[];
  source?: CsvRowInfo;
  /** `after`-phase related-record plans for this user, when `--related-def` is in play. */
  relatedPlans?: RelatedRecordPlan[];
  /** Reported related-record outcomes, filled in by the dry-run or live related stage. */
  relatedResults?: RelatedRecordResult[];
};

export type UserResult = {
  key: string;
  id?: string;
  userName?: string;
  username?: string;
  personas: string[];
  matchedBy: string | null;
  /** The value looked up under `matchedBy`; null when no lookup was issued under it. */
  matchValue: string | null;
  /**
   * Whether an existing user was actually found. `matchedBy` only reports that a match
   * field was configured, so it cannot stand in for this on a net-new user.
   */
  matched: boolean;
  status: 'created' | 'updated' | 'failed' | 'planned';
  actions: string[];
  errors: string[];
  relatedRecords?: RelatedRecordResult[];
};

export type OrderedUserResult = UserResult & { order: number; planId: string; source?: CsvRowInfo };

export const identityFromTarget = (
  target: JsonRecord,
  existing?: ExistingUser
): { userName?: string; username?: string } => ({
  userName:
    existing?.Name ??
    (typeof target.Name === 'string'
      ? target.Name
      : [target.FirstName, target.LastName]
          .filter((value): value is string => typeof value === 'string' && value.length > 0)
          .join(' ') || undefined),
  username: existing?.Username ?? (typeof target.Username === 'string' ? target.Username : undefined),
});

const ensureWritableFields = (
  target: JsonRecord,
  existing: ExistingUser | undefined,
  fieldMap: Map<string, UserFieldMeta>,
  errors: string[]
): void => {
  for (const field of Object.keys(target)) {
    if (field === 'Id') continue;
    const meta = fieldMap.get(field.toLowerCase());
    if (!meta) continue;
    if (existing ? !meta.updateable : !meta.createable) {
      errors.push(messages.getMessage('errorFieldNotWritable', [field, existing ? 'updateable' : 'createable']));
    }
  }
};

export const buildTarget = (user: CanonicalizedUser, refs: ResolvedRefs, errors: string[]): JsonRecord => {
  const persona = user.effectivePersona;
  const target: JsonRecord = { ...user.fields, IsActive: true };
  // Profile: user profileRef > user raw ProfileId (already in target) > persona profile
  if (user.profileRef) {
    const profileId = refs.profilesByRef.get(user.profileRef);
    if (!profileId) errors.push(messages.getMessage('errorReferenceRequiredMissing', ['Profile', user.profileRef]));
    else target.ProfileId = profileId;
  } else if (!target.ProfileId && persona.profile) {
    const profileId = refs.profilesByRef.get(persona.profile);
    if (!profileId) errors.push(messages.getMessage('errorReferenceRequiredMissing', ['Profile', persona.profile]));
    else target.ProfileId = profileId;
  }
  // Role: user roleRef > user raw UserRoleId (already in target) > persona role
  if (user.roleRef) {
    const roleId = refs.rolesByRef.get(user.roleRef);
    if (!roleId) errors.push(messages.getMessage('errorReferenceRequiredMissing', ['UserRole', user.roleRef]));
    else target.UserRoleId = roleId;
  } else if (!target.UserRoleId && persona.role) {
    const roleId = refs.rolesByRef.get(persona.role);
    if (!roleId) errors.push(messages.getMessage('errorReferenceRequiredMissing', ['UserRole', persona.role]));
    else target.UserRoleId = roleId;
  }
  return target;
};

const applyInsertDefaults = (target: JsonRecord, myDomain: string | undefined): void => {
  if (!target.Username && myDomain) {
    const username = buildDefaultUsername(target.Email, myDomain);
    if (username) target.Username = username;
  }
  if (!target.Alias) {
    const alias = buildDefaultAlias(target.FirstName, target.LastName);
    if (alias) target.Alias = alias;
  }
};

export const appendCrossReferenceCandidates = (errors: string[], target: JsonRecord): string[] => {
  const hasCrossRefError = errors.some((error) => error.includes('INVALID_CROSS_REFERENCE_KEY'));
  if (!hasCrossRefError) return errors;
  const candidateFields = Object.entries(target)
    .filter(([field]) => field.endsWith('Id') && field !== 'Id')
    .map(([field, value]) => `${field}=${String(value)}`);
  if (candidateFields.length === 0) return errors;
  return errors.concat(messages.getMessage('errorCrossReferenceCandidates', [candidateFields.join(', ')]));
};

const resolveExistingUser = (
  matchedBy: string | null,
  target: JsonRecord,
  existing: { existingByField: Map<string, Map<string, ExistingUser>> }
): { matchValue: unknown; existingUser?: ExistingUser } => {
  const matchValue = matchedBy ? target[matchedBy] : undefined;
  if (!matchedBy || typeof matchValue !== 'string') return { matchValue };
  return { matchValue, existingUser: existing.existingByField.get(matchedBy)?.get(matchValue) };
};

export const buildUserPlans = (options: {
  validUsers: Array<{ user: CanonicalizedUser; order: number }>;
  refs: ResolvedRefs;
  existing: { existingByField: Map<string, Map<string, ExistingUser>>; duplicates: Set<string> };
  fieldMap: Map<string, UserFieldMeta>;
  defaultExternalIdField?: string;
  myDomain?: string;
  dryRun: boolean;
  message: (key: string, args?: string[]) => string;
  relatedPlansByOrder?: Map<number, RelatedRecordPlan[]>;
}): UserPlan[] => {
  const { validUsers, refs, existing, fieldMap, defaultExternalIdField, myDomain, dryRun, message } = options;
  return validUsers.map(({ user, order }) => {
    const effectivePersona = user.effectivePersona;
    const errors: string[] = [];
    const target = buildTarget(user, refs, errors);
    const matchedBy = user.matchField ?? defaultExternalIdField ?? null;
    const { matchValue, existingUser } = resolveExistingUser(matchedBy, target, existing);
    if (matchedBy && typeof matchValue === 'string' && existing.duplicates.has(matchKey(matchedBy, matchValue))) {
      errors.push(message('errorDuplicateExternalIdMatch', [matchedBy, matchValue]));
    }
    if (!existingUser) {
      applyInsertDefaults(target, myDomain);
      const profileIntended = Boolean(user.profileRef) || Boolean(effectivePersona.profile);
      const missing = missingRequiredFieldsForInsert(target, profileIntended);
      if (missing.length > 0) errors.push(message('errorMissingRequiredFields', [missing.join(', ')]));
    }
    ensureWritableFields(target, existingUser, fieldMap, errors);
    const actions = [existingUser ? (dryRun ? 'wouldUpdate' : 'updated') : dryRun ? 'wouldCreate' : 'created'];
    if (!existingUser || existingUser.IsActive !== true) actions.push(dryRun ? 'wouldActivate' : 'activated');
    const relatedPlans = options.relatedPlansByOrder?.get(order);
    // A related planning failure (ambiguity, collision, unresolvable source) fails the user
    // before any DML, which is exactly what a non-empty `errors` list already means here.
    for (const relatedPlan of relatedPlans ?? []) errors.push(...relatedPlan.errors);
    return {
      planId: `${order}:${user.inputKey}:${user.personas.join('+')}`,
      order,
      key: user.inputKey,
      personas: user.personas,
      effectivePersona,
      matchedBy,
      matchValue: usableMatchValue(matchValue),
      target,
      existing: existingUser,
      actions,
      errors,
      source: user.source,
      ...(relatedPlans ? { relatedPlans } : {}),
    };
  });
};

export const toUserResult = (
  plan: UserPlan,
  status: UserResult['status'],
  overrides?: { id?: string; errors?: string[]; includeExistingId?: boolean }
): OrderedUserResult => ({
  planId: plan.planId,
  order: plan.order,
  key: plan.key,
  ...identityFromTarget(plan.target, plan.existing),
  ...(overrides?.id
    ? { id: overrides.id }
    : overrides?.includeExistingId === false
    ? {}
    : plan.existing
    ? { id: plan.existing.Id }
    : {}),
  personas: plan.personas,
  matchedBy: plan.matchedBy,
  matchValue: plan.matchValue,
  matched: Boolean(plan.existing),
  status,
  actions: plan.actions,
  errors: overrides?.errors ?? plan.errors,
  ...(plan.relatedResults && plan.relatedResults.length > 0 ? { relatedRecords: plan.relatedResults } : {}),
  source: plan.source,
});

export const summarize = (
  results: UserResult[],
  globalWarningCount: number
): { total: number; created: number; updated: number; failed: number; warnings: number } => ({
  total: results.length,
  created: results.filter((result) => result.status === 'created').length,
  updated: results.filter((result) => result.status === 'updated').length,
  failed: results.filter((result) => result.status === 'failed').length,
  warnings: globalWarningCount,
});
