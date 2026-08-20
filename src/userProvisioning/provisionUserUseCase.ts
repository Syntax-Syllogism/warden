import { Connection, Messages } from '@salesforce/core';
import { runBatches } from '../userShared/sfUtils.js';
import { resolveExistingUsers, usableMatchValue, type ExistingUser } from '../userMatching/index.js';
export type { ExistingUser } from '../userMatching/index.js';
import type { CsvRowInfo } from '../userShared/csv.js';
import { describeUserFields, type SobjectDescribeCache } from '../userShared/userFields.js';
import { assertValidRelatedCatalog } from '../userRelatedRecords/catalog.js';
import { applyRelatedPhase } from '../userRelatedRecords/apply.js';
import { buildRelatedPlans } from '../userRelatedRecords/plan.js';
import { emptyPreflightResult, runRelatedPreflight, type RelatedPreflightResult } from '../userRelatedRecords/preflight.js';
import type { RelatedCatalog, RelatedRecordPlan } from '../userRelatedRecords/types.js';
import {
  CanonicalizedUser,
  deriveMyDomain,
  PersonaDefinition,
  UserFieldMeta,
  validateAndCanonicalizeUsers,
  validateExternalIdFieldForFlag,
  validatePersonaModes,
} from './planner.js';
import {
  loadValidatedDefinitions,
  type DefinitionMessages,
  type ProvisionDefinitionDocuments,
} from './definitionReader.js';
import { calculateUserLicenseUsage, type PermissionSetLicenseSummary, type UserLicenseUsage } from './licenseUsage.js';
import { resolveReferences } from './referenceResolution.js';
import type { ResolvedRefs } from './assignmentPlan.js';
import {
  appendCrossReferenceCandidates,
  buildUserPlans,
  identityFromTarget,
  summarize,
  toUserResult,
  type OrderedUserResult,
  type UserResult,
} from './userPlan.js';
import { applySavedPlan, executeBulkUserSaves, markRelatedUnapplied, planDryRunResult } from './userSave.js';
export type { OrderedUserResult, UserPlan, UserResult } from './userPlan.js';
export type { PermissionSetLicenseSummary, UserLicenseUsage } from './licenseUsage.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('@syntax-syllogism/warden', 'warden.provision');
const provisionDefinitionMessages: DefinitionMessages = {
  invalidPersonaDefinition: () => messages.getMessage('errorInvalidPersonaDefinition'),
  personasWithoutDefinition: (userKey) => messages.getMessage('errorPersonasWithoutDefinition', [userKey]),
  invalidJson: (path, error) => messages.getMessage('errorInvalidJson', [path, error]),
};

type JsonRecord = Record<string, unknown>;
const addSourceContext = (source: CsvRowInfo | undefined, errors: string[]): string[] =>
  source ? errors.map((error) => `${source.path}:${source.line} — ${error}`) : errors;

export type ProvisionResult = {
  summary: { total: number; created: number; updated: number; failed: number; warnings: number };
  users: UserResult[];
  licenses?: UserLicenseUsage[];
  permissionSetLicenses?: PermissionSetLicenseSummary;
};
const USER_PROCESS_CONCURRENCY = 10;

export type ExistingUserMatchOptions = {
  defaultExternalIdField?: string;
  defaultFuzzyUsername?: boolean;
  fieldMap: Map<string, UserFieldMeta>;
};
export const getExistingUsers = async (
  conn: Connection,
  users: CanonicalizedUser[],
  options: ExistingUserMatchOptions
): Promise<{ existingByField: Map<string, Map<string, ExistingUser>>; duplicates: Set<string> }> => {
  const requests = users.flatMap((user) => {
    const field = user.matchField ?? options.defaultExternalIdField;
    const value = field ? usableMatchValue(user.fields[field]) : null;
    return field && value !== null
      ? [{ field, value, fuzzy: field === 'Username' && (user.fuzzyUsername ?? options.defaultFuzzyUsername ?? false) }]
      : [];
  });
  const { existingByField, duplicates } = await resolveExistingUsers(conn, requests, options.fieldMap);
  return { existingByField, duplicates };
};
export type ProvisionUserRequest = {
  connection: Connection;
  usersDoc?: JsonRecord;
  personasDoc?: JsonRecord;
  usersPath?: string;
  personasPath?: string;
  inputFormat?: 'json' | 'csv';
  csvListDelimiter?: string;
  externalId?: string;
  fuzzyUsername?: boolean;
  dryRun: boolean;
  personasSupplied?: boolean;
  relatedDoc?: JsonRecord;
  relatedPath?: string;
  acknowledgeWarnings?: (warnings: string[]) => Promise<void>;
};
const message = (key: string, args?: string[]): string => messages.getMessage(key, args);

const loadAndValidate = async (
  request: ProvisionUserRequest,
  describeCache: SobjectDescribeCache
): Promise<{
  fieldMap: Map<string, UserFieldMeta>;
  definitions: ProvisionDefinitionDocuments;
}> => {
  if (request.usersDoc) {
    const definitions = await loadValidatedDefinitions(request, new Map(), provisionDefinitionMessages);
    return { fieldMap: await describeUserFields(request.connection, describeCache), definitions };
  }
  const fieldMap = await describeUserFields(request.connection, describeCache);
  const definitions = await loadValidatedDefinitions(request, fieldMap, provisionDefinitionMessages);
  return { fieldMap, definitions };
};

const validationResultsFor = (
  validationFailureUsers: Array<{ user: CanonicalizedUser; order: number }>
): OrderedUserResult[] =>
  validationFailureUsers.map(({ user, order }) => {
    const matchedBy = user.matchField ?? null;
    const matchValue = matchedBy ? usableMatchValue(user.fields[matchedBy]) : null;
    return {
      planId: `${order}:${user.inputKey}:${user.personas.join('+')}:validation`,
      order,
      key: user.inputKey,
      ...identityFromTarget(user.fields),
      personas: user.personas,
      matchedBy,
      matchValue,
      // These users never reached matching, so nothing was matched.
      matched: false,
      status: 'failed',
      actions: [],
      errors: (user.validationErrors ?? []).map((error) => message(error.messageKey, error.messageArgs)),
      source: user.source,
    };
  });

const assembleResult = (
  resultsWithOrder: OrderedUserResult[],
  refs: ResolvedRefs,
  licenseUsage: UserLicenseUsage[] | undefined,
  dryRun: boolean
): ProvisionResult => {
  const results = resultsWithOrder
    .sort((a, b) => a.order - b.order)
    .map((result) => ({
      key: result.key,
      id: result.id,
      userName: result.userName,
      username: result.username,
      personas: result.personas,
      matchedBy: result.matchedBy ?? null,
      matchValue: result.matchValue,
      matched: result.matched,
      status: result.status,
      actions: result.actions,
      errors: addSourceContext(result.source, result.errors),
      ...(result.relatedRecords ? { relatedRecords: result.relatedRecords } : {}),
    }));
  const result: ProvisionResult = {
    summary: summarize(
      results,
      refs.warnings.length + (licenseUsage?.filter((license) => license.shortfall > 0).length ?? 0)
    ),
    users: results,
  };
  if (dryRun) {
    result.licenses = licenseUsage;
    result.permissionSetLicenses = { evaluated: false, note: 'not evaluated' };
  }
  return result;
};

const selectedRelationships = (validUsers: Array<{ user: CanonicalizedUser }>): string[] => [
  ...new Set(validUsers.flatMap(({ user }) => user.related ?? [])),
];

const loadRelatedCatalog = (
  definitions: ProvisionDefinitionDocuments,
  fieldMap: Map<string, UserFieldMeta>
): RelatedCatalog | undefined =>
  definitions.relatedDoc ? assertValidRelatedCatalog(definitions.relatedDoc, fieldMap, message) : undefined;

export class ProvisionUserUseCase {
  private readonly userProcessConcurrency = USER_PROCESS_CONCURRENCY;
  private async runDryRun(
    conn: Connection,
    plans: ReturnType<typeof buildUserPlans>,
    refs: ResolvedRefs,
    validationResults: OrderedUserResult[]
  ): Promise<OrderedUserResult[]> {
    const plannedResults = await runBatches(plans, this.userProcessConcurrency, (plan) =>
      planDryRunResult({ conn, plan, refs })
    );
    return validationResults.concat(plannedResults);
  }
  private async runLive(
    conn: Connection,
    plans: ReturnType<typeof buildUserPlans>,
    refs: ResolvedRefs,
    validationResults: OrderedUserResult[]
  ): Promise<OrderedUserResult[]> {
    const invalidResults = plans
      .filter((plan) => plan.errors.length > 0)
      .map((plan) => toUserResult(markRelatedUnapplied(plan), 'failed', { includeExistingId: false }));
    const outcomes = await executeBulkUserSaves(conn, plans);
    const saveFailures = outcomes
      .filter((outcome) => !outcome.success)
      .map((outcome) =>
        toUserResult(markRelatedUnapplied(outcome.plan), 'failed', {
          errors: appendCrossReferenceCandidates(outcome.errors, outcome.plan.target),
          includeExistingId: false,
        })
      );
    const savedOutcomes = outcomes.filter((outcome) => outcome.success);
    // Related records are written between the User save and the per-user post-save work,
    // as one bulk stage per sObject. `executeBulkUserSaves` above is untouched.
    const relatedByPlanId = await applyRelatedPhase(
      conn,
      savedOutcomes
        .filter((outcome) => outcome.plan.relatedPlans && outcome.id)
        .map((outcome) => ({
          planId: outcome.plan.planId,
          relatedPlans: outcome.plan.relatedPlans as RelatedRecordPlan[],
          savedUserId: outcome.id as string,
        })),
      'after'
    );
    for (const outcome of savedOutcomes) {
      const related = relatedByPlanId.get(outcome.plan.planId);
      if (related) {
        outcome.plan.relatedResults = related;
        outcome.plan.errors.push(
          ...related
            .filter((result) => result.status === 'failed' && result.error)
            .map((result) => result.error as string)
        );
      }
    }
    const postSaveResults = await runBatches(savedOutcomes, this.userProcessConcurrency, (outcome) =>
      applySavedPlan({ conn, outcome, refs, message })
    );
    return validationResults.concat(invalidResults, saveFailures, postSaveResults);
  }

  // eslint-disable-next-line @typescript-eslint/member-ordering
  public async execute(request: ProvisionUserRequest): Promise<ProvisionResult> {
    const conn = request.connection;
    // Per-run describe cache: shared by User and every relationship sObject, never module-level.
    const describeCache: SobjectDescribeCache = new Map();
    const { fieldMap, definitions } = await loadAndValidate(request, describeCache);
    const { usersDoc, personasDoc } = definitions;
    const personasSupplied = request.personasSupplied ?? definitions.personasSupplied;
    const personas = personasDoc.personas as Record<string, PersonaDefinition>;
    validatePersonaModes(personas);
    validateExternalIdFieldForFlag(request.externalId, fieldMap);
    const catalog = loadRelatedCatalog(definitions, fieldMap);
    const users = validateAndCanonicalizeUsers(usersDoc.users, personas, fieldMap, personasSupplied, {
      catalogSupplied: Boolean(catalog),
      names: new Set(Object.keys(catalog?.relationships ?? {})),
    });
    const myDomain = deriveMyDomain(conn.instanceUrl);
    const defaultExternalIdField = request.externalId
      ? fieldMap.get(request.externalId.toLowerCase())?.name
      : undefined;
    const userEntries = users.map((user, order) => ({ user, order }));
    const validationFailureUsers = userEntries.filter(
      ({ user }) => user.validationErrors && user.validationErrors.length > 0
    );
    const validUsers = userEntries.filter(({ user }) => !user.validationErrors || user.validationErrors.length === 0);

    const [refs, existingResolution, preflight] = await Promise.all([
      resolveReferences(
        conn,
        personas,
        validUsers.map(({ user }) => user)
      ),
      getExistingUsers(
        conn,
        validUsers.map(({ user }) => user),
        {
          defaultExternalIdField,
          defaultFuzzyUsername: request.fuzzyUsername,
          fieldMap,
        }
      ),
      catalog
        ? runRelatedPreflight({
            conn,
            catalog,
            selected: selectedRelationships(validUsers),
            cache: describeCache,
            message,
          })
        : Promise.resolve<RelatedPreflightResult>(emptyPreflightResult()),
    ]);
    // Ineligible relationships join the same warning list, so operators still see exactly
    // one confirmation and declining exits before any DML.
    refs.warnings.push(...preflight.warnings);
    if (refs.warnings.length > 0) await request.acknowledgeWarnings?.(refs.warnings);

    const relatedPlansByOrder = catalog
      ? await buildRelatedPlans({ conn, users: validUsers, catalog, preflight, userFieldMap: fieldMap, message })
      : undefined;
    const plans = buildUserPlans({
      validUsers,
      refs,
      existing: existingResolution,
      fieldMap,
      defaultExternalIdField,
      myDomain,
      dryRun: request.dryRun,
      message,
      relatedPlansByOrder,
    });
    const licenseUsage = request.dryRun ? await calculateUserLicenseUsage(conn, plans) : undefined;
    const validationResults = validationResultsFor(validationFailureUsers);
    const results = request.dryRun
      ? await this.runDryRun(conn, plans, refs, validationResults)
      : await this.runLive(conn, plans, refs, validationResults);
    return assembleResult(results, refs, licenseUsage, request.dryRun);
  }
}
