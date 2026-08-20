import { validateMatchField } from '../userMatching/index.js';
import type { UserFieldMeta } from '../userMatching/index.js';
import { getCsvRowInfo, type CsvRowInfo } from '../userShared/csv.js';

export type AssignmentMode = 'additive' | 'sync';

export type PersonaDefinition = {
  profile?: string;
  role?: string;
  permissionSetMode?: AssignmentMode;
  permissionSetGroupMode?: AssignmentMode;
  publicGroupMode?: AssignmentMode;
  queueMode?: AssignmentMode;
  permissionSets?: string[];
  permissionSetGroups?: string[];
  publicGroups?: string[];
  queues?: string[];
  userAttributes?: Record<string, unknown>;
};

export type UserInput = Record<string, unknown> & { personas?: string[] };

export type ValidationWarning = { message: string; userKey?: string };
export type ValidationError = {
  messageKey:
    | 'errorInvalidUserMatchField'
    | 'errorInvalidFuzzyUsername'
    | 'errorUserMatchFieldEmpty'
    | 'errorNoPersonas'
    | 'errorLegacyPersonaKey'
    | 'errorUnknownPersona'
    | 'errorPersonaConflictProfile'
    | 'errorPersonaConflictRole'
    | 'errorPersonaConflictUserAttribute'
    | 'errorPersonaConflictMode'
    | 'errorUserProfileConflict'
    | 'errorUserRoleConflict'
    | 'errorInvalidUserProfile'
    | 'errorInvalidUserRole'
    | 'errorInvalidRelatedKey'
    | 'errorUnknownRelationship'
    | 'errorDuplicateRelationshipSelection'
    | 'errorRelatedWithoutCatalog'
    | 'errorRelatedSourceEmpty'
    | 'errorRelatedInvalidSourceValue'
    | 'errorAmbiguousRelatedMatch'
    | 'errorRelatedMatchCollision'
    | 'errorRelatedRecordTypeMismatch';
  messageArgs: string[];
};

/**
 * Relationship names available to a user's `related` meta key.
 * `catalogSupplied` is false when no `--related-def` was passed, which turns a stale
 * `related` key into a per-user failure rather than a batch-wide abort.
 */
export type RelatedSelectionContext = { catalogSupplied: boolean; names: Set<string> };

export type CanonicalizedUser = {
  inputKey: string;
  personas: string[];
  effectivePersona: PersonaDefinition;
  profileRef?: string;
  roleRef?: string;
  matchField?: string;
  fuzzyUsername?: boolean;
  /** Relationship names selected by this user's `related` meta key. Never persona-inferred. */
  related?: string[];
  fields: Record<string, unknown>;
  validationErrors?: ValidationError[];
  source?: CsvRowInfo;
};

export const modeKeys = ['permissionSetMode', 'permissionSetGroupMode', 'publicGroupMode', 'queueMode'] as const;

export const assignmentListKeys = ['permissionSets', 'permissionSetGroups', 'publicGroups', 'queues'] as const;
const reservedUserKeys = new Set(['personas', 'match', 'profile', 'role', 'fuzzyusername', 'related']);

export type { UserFieldMeta } from '../userMatching/index.js';

/**
 * Lightweight shape check only.
 * Callers should apply object-specific Id prefix filtering at use sites.
 */
export const isSalesforceId = (value: string): boolean =>
  /^[a-zA-Z0-9]{3}[a-zA-Z0-9]{12}(?:[a-zA-Z0-9]{3})?$/.test(value);

export const normalizeMode = (value: unknown): AssignmentMode => {
  if (value === undefined) return 'additive';
  if (value === 'additive' || value === 'sync') return value;
  throw new Error(`Invalid assignment mode "${String(value)}". Expected additive or sync.`);
};

export const buildFieldMap = (fields: UserFieldMeta[]): Map<string, UserFieldMeta> => {
  const map = new Map<string, UserFieldMeta>();
  for (const field of fields) map.set(field.name.toLowerCase(), field);
  return map;
};

export const canonicalizeFieldObject = (
  source: Record<string, unknown> | undefined,
  fieldMap: Map<string, UserFieldMeta>,
  context: string
): Record<string, unknown> => {
  if (!source) return {};
  const output: Record<string, unknown> = {};
  for (const [rawKey, value] of Object.entries(source)) {
    const meta = fieldMap.get(rawKey.toLowerCase());
    if (!meta) throw new Error(`${context}: unknown User field "${rawKey}".`);
    output[meta.name] = value;
  }
  return output;
};

export const validateExternalIdField = (externalId: string, fieldMap: Map<string, UserFieldMeta>): UserFieldMeta =>
  validateMatchField(externalId, fieldMap);

export const validateExternalIdFieldForFlag = (
  externalId: string | undefined,
  fieldMap: Map<string, UserFieldMeta>
): UserFieldMeta | undefined => {
  if (!externalId) return undefined;
  try {
    return validateExternalIdField(externalId, fieldMap);
  } catch {
    throw new Error(`Invalid --external-id field "${externalId}". Must be a filterable User field.`);
  }
};

const buildValidationError = (messageKey: ValidationError['messageKey'], messageArgs: string[]): ValidationError => ({
  messageKey,
  messageArgs,
});

const resolveUserMatchField = (
  rawMatch: unknown,
  merged: Record<string, unknown>,
  fieldMap: Map<string, UserFieldMeta>
): { matchField?: string; validationErrors: ValidationError[] } => {
  if (rawMatch === undefined) return { validationErrors: [] };
  if (typeof rawMatch !== 'string') {
    return {
      validationErrors: [buildValidationError('errorInvalidUserMatchField', [String(rawMatch)])],
    };
  }
  try {
    const meta = validateExternalIdField(rawMatch, fieldMap);
    const matchField = meta.name;
    const matchValue = merged[matchField];
    if (typeof matchValue !== 'string' || matchValue.length === 0) {
      return {
        matchField,
        validationErrors: [buildValidationError('errorUserMatchFieldEmpty', [matchField])],
      };
    }
    return { matchField, validationErrors: [] };
  } catch {
    return {
      validationErrors: [buildValidationError('errorInvalidUserMatchField', [rawMatch])],
    };
  }
};

export const mergeUserFields = (
  personaUserAttributes: Record<string, unknown>,
  userFields: Record<string, unknown>
): Record<string, unknown> => ({
  ...personaUserAttributes,
  ...userFields,
});

const unionArray = <T>(arrays: Array<T[] | undefined>): T[] => {
  const seen = new Set<T>();
  const result: T[] = [];
  for (const arr of arrays) {
    for (const item of arr ?? []) {
      if (!seen.has(item)) {
        seen.add(item);
        result.push(item);
      }
    }
  }
  return result;
};

// Extracted to keep mergePersonas under the eslint complexity ceiling (max 20).
const mergePersonaAttributes = (
  validDefs: PersonaDefinition[],
  userOverrideFields: Record<string, unknown>,
  fieldMap: Map<string, UserFieldMeta>
): { userAttributes: Record<string, unknown> | undefined; errors: ValidationError[] } => {
  const attrMap = new Map<string, unknown>();
  const attrConflicts = new Set<string>();
  for (const def of validDefs) {
    for (const [rawKey, value] of Object.entries(def.userAttributes ?? {})) {
      const canonicalKey = fieldMap.get(rawKey.toLowerCase())?.name ?? rawKey;
      if (attrMap.has(canonicalKey) && attrMap.get(canonicalKey) !== value) {
        attrConflicts.add(canonicalKey);
      } else {
        attrMap.set(canonicalKey, value);
      }
    }
  }
  const errors: ValidationError[] = [];
  for (const conflictKey of attrConflicts) {
    if (!(conflictKey in userOverrideFields)) {
      errors.push(buildValidationError('errorPersonaConflictUserAttribute', [conflictKey]));
    }
  }
  return { userAttributes: attrMap.size > 0 ? Object.fromEntries(attrMap) : undefined, errors };
};

export const mergePersonas = (
  names: string[],
  personas: Record<string, PersonaDefinition>,
  userOverrideFields: Record<string, unknown>,
  fieldMap: Map<string, UserFieldMeta>,
  hasProfileOverride = false,
  hasRoleOverride = false
): { effective: PersonaDefinition; errors: ValidationError[] } => {
  const errors: ValidationError[] = [];
  const validDefs: PersonaDefinition[] = [];

  for (const name of names) {
    const def = personas[name];
    if (!def) {
      errors.push(buildValidationError('errorUnknownPersona', [name]));
    } else {
      validDefs.push(def);
    }
  }

  const effective: PersonaDefinition = {};

  // Union assignment lists
  for (const listKey of assignmentListKeys) {
    const unioned = unionArray(validDefs.map((d) => d[listKey]));
    if (unioned.length > 0) effective[listKey] = unioned;
  }

  // Singular: profile
  const profiles = [...new Set(validDefs.map((d) => d.profile).filter((v): v is string => Boolean(v)))];
  if (profiles.length > 1 && !hasProfileOverride) {
    errors.push(buildValidationError('errorPersonaConflictProfile', [profiles.join(', ')]));
  } else if (profiles.length === 1) {
    effective.profile = profiles[0];
  }

  // Singular: role
  const roles = [...new Set(validDefs.map((d) => d.role).filter((v): v is string => Boolean(v)))];
  if (roles.length > 1 && !hasRoleOverride) {
    errors.push(buildValidationError('errorPersonaConflictRole', [roles.join(', ')]));
  } else if (roles.length === 1) {
    effective.role = roles[0];
  }

  // Modes
  for (const modeKey of modeKeys) {
    const modes = [...new Set(validDefs.map((d) => d[modeKey]).filter((v): v is AssignmentMode => v !== undefined))];
    if (modes.length > 1) {
      errors.push(buildValidationError('errorPersonaConflictMode', [modeKey]));
    } else if (modes.length === 1) {
      effective[modeKey] = modes[0];
    }
  }

  const { userAttributes, errors: attrErrors } = mergePersonaAttributes(validDefs, userOverrideFields, fieldMap);
  errors.push(...attrErrors);
  if (userAttributes) effective.userAttributes = userAttributes;

  return { effective, errors };
};

const sanitizeAliasPart = (s: unknown): string => (typeof s === 'string' ? s : '').replace(/[^a-z0-9]/gi, '');

export const buildDefaultAlias = (firstName?: unknown, lastName?: unknown): string | undefined => {
  const first = sanitizeAliasPart(firstName);
  const last = sanitizeAliasPart(lastName);
  if (!first && !last) return undefined;
  const firstDeficit = Math.max(0, 3 - first.length);
  const lastDeficit = Math.max(0, 3 - last.length);
  const firstPart = first.slice(0, 3 + lastDeficit);
  const lastPart = last.slice(0, 3 + firstDeficit);
  const alias = (firstPart + lastPart).toLowerCase().slice(0, 8);
  return alias || undefined;
};

export const buildDefaultUsername = (email: unknown, myDomain: string): string | undefined =>
  typeof email === 'string' && email.length > 0 ? `${email}.${myDomain}` : undefined;

export const deriveMyDomain = (instanceUrl: string): string | undefined => {
  try {
    const host = new URL(instanceUrl).hostname;
    const firstLabel = host.split('.')[0];
    return firstLabel || undefined;
  } catch {
    return undefined;
  }
};

const resolveInputKey = (fields: Record<string, unknown>, fallback: string): string =>
  (typeof fields.FederationIdentifier === 'string' && fields.FederationIdentifier) ||
  (typeof fields.Username === 'string' && fields.Username) ||
  (typeof fields.Email === 'string' && fields.Email) ||
  fallback;

export const findFirstUserWithPersonas = (rawUsers: unknown): string | undefined => {
  if (!Array.isArray(rawUsers)) return undefined;
  const identityFields = ['FederationIdentifier', 'Username', 'Email'];
  for (const [index, rawUser] of rawUsers.entries()) {
    if (!rawUser || typeof rawUser !== 'object') continue;
    const input = rawUser as Record<string, unknown>;
    const personasKey = Object.keys(input).find((key) => key.toLowerCase() === 'personas');
    if (!personasKey) continue;
    for (const identityField of identityFields) {
      const fieldKey = Object.keys(input).find((key) => key.toLowerCase() === identityField.toLowerCase());
      const value = fieldKey ? input[fieldKey] : undefined;
      if (typeof value === 'string' && value.length > 0) return value;
    }
    return String(index + 1);
  }
  return undefined;
};

// Reads a user-level profile/role meta key. Empty/whitespace and null are treated as
// "not provided"; any other non-string value is reported so malformed input is not silently dropped.
const extractUserRef = (
  value: unknown,
  invalidKey: 'errorInvalidUserProfile' | 'errorInvalidUserRole',
  errors: ValidationError[]
): string | undefined => {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'string') {
    errors.push(buildValidationError(invalidKey, [String(value)]));
    return undefined;
  }
  return value.trim() === '' ? undefined : value;
};

// Reads the user-level `related` meta key. Every problem is per-user: one row carrying a
// stale `related` key must not abort a batch that otherwise does not use the feature.
const resolveRelatedSelection = (
  rawRelated: unknown,
  related: RelatedSelectionContext | undefined,
  errors: ValidationError[]
): string[] | undefined => {
  if (rawRelated === null || rawRelated === undefined) return undefined;
  if (!Array.isArray(rawRelated) || rawRelated.some((name) => typeof name !== 'string')) {
    errors.push(buildValidationError('errorInvalidRelatedKey', [JSON.stringify(rawRelated) ?? String(rawRelated)]));
    return undefined;
  }
  const names = rawRelated as string[];
  if (names.length === 0) return [];
  if (!related?.catalogSupplied) {
    errors.push(buildValidationError('errorRelatedWithoutCatalog', []));
    return undefined;
  }
  const seen = new Set<string>();
  const selected: string[] = [];
  for (const name of names) {
    if (seen.has(name)) {
      errors.push(buildValidationError('errorDuplicateRelationshipSelection', [name]));
      continue;
    }
    seen.add(name);
    if (!related.names.has(name)) {
      errors.push(buildValidationError('errorUnknownRelationship', [name]));
      continue;
    }
    selected.push(name);
  }
  return selected;
};

const attachCsvSource = (user: CanonicalizedUser, input: unknown): CanonicalizedUser => {
  const source = getCsvRowInfo(input);
  if (source) Object.defineProperty(user, 'source', { value: source, enumerable: false });
  return user;
};

const canonicalizeValidUser = (
  input: UserInput,
  names: string[],
  personas: Record<string, PersonaDefinition>,
  fieldMap: Map<string, UserFieldMeta>,
  fallback: string,
  related?: RelatedSelectionContext
): CanonicalizedUser => {
  const candidateFields: Record<string, unknown> = {};
  const errors: ValidationError[] = [];
  let profileRef: string | undefined;
  let roleRef: string | undefined;
  for (const [k, v] of Object.entries(input)) {
    const lower = k.toLowerCase();
    if (lower === 'profile') profileRef = extractUserRef(v, 'errorInvalidUserProfile', errors);
    else if (lower === 'role') roleRef = extractUserRef(v, 'errorInvalidUserRole', errors);
    else if (!reservedUserKeys.has(lower)) candidateFields[k] = v;
  }
  const userFields = canonicalizeFieldObject(candidateFields, fieldMap, `user personas=${names.join('+')}`);
  if (profileRef !== undefined && 'ProfileId' in userFields) {
    errors.push(buildValidationError('errorUserProfileConflict', []));
    profileRef = undefined;
  }
  if (roleRef !== undefined && 'UserRoleId' in userFields) {
    errors.push(buildValidationError('errorUserRoleConflict', []));
    roleRef = undefined;
  }
  // A raw ProfileId/UserRoleId is also a user-level override, so it must suppress
  // a persona profile/role conflict the same way the profile/role meta keys do.
  const hasProfileOverride = profileRef !== undefined || 'ProfileId' in userFields;
  const hasRoleOverride = roleRef !== undefined || 'UserRoleId' in userFields;
  const { effective, errors: mergeErrors } = mergePersonas(
    names,
    personas,
    userFields,
    fieldMap,
    hasProfileOverride,
    hasRoleOverride
  );
  const personaFields = canonicalizeFieldObject(effective.userAttributes, fieldMap, 'effective persona');
  const merged = mergeUserFields(personaFields, userFields);
  const rawMatch = Object.entries(input).find(([k]) => k.toLowerCase() === 'match')?.[1];
  const { matchField, validationErrors: matchErrors } = resolveUserMatchField(rawMatch, merged, fieldMap);
  const rawFuzzy = Object.entries(input).find(([k]) => k.toLowerCase() === 'fuzzyusername')?.[1];
  let fuzzyUsername: boolean | undefined;
  if (rawFuzzy === undefined || typeof rawFuzzy === 'boolean') {
    fuzzyUsername = rawFuzzy;
  } else {
    const displayValue = typeof rawFuzzy === 'string' ? rawFuzzy : JSON.stringify(rawFuzzy) ?? typeof rawFuzzy;
    errors.push(buildValidationError('errorInvalidFuzzyUsername', [displayValue]));
  }
  const rawRelated = Object.entries(input).find(([k]) => k.toLowerCase() === 'related')?.[1];
  const relatedErrors: ValidationError[] = [];
  const selectedRelated = resolveRelatedSelection(rawRelated, related, relatedErrors);
  const allErrors = [...errors, ...mergeErrors, ...matchErrors, ...relatedErrors];
  const result: CanonicalizedUser = {
    inputKey: resolveInputKey(merged, names.length > 0 ? `${names.join('+')}:${fallback}` : fallback),
    personas: names,
    effectivePersona: effective,
    profileRef,
    roleRef,
    matchField,
    fuzzyUsername,
    related: selectedRelated,
    fields: merged,
    validationErrors: allErrors.length > 0 ? allErrors : undefined,
  };
  return attachCsvSource(result, input);
};

export const validateAndCanonicalizeUsers = (
  rawUsers: unknown,
  personas: Record<string, PersonaDefinition>,
  fieldMap: Map<string, UserFieldMeta>,
  personasSupplied = true,
  related?: RelatedSelectionContext
): CanonicalizedUser[] => {
  if (!Array.isArray(rawUsers)) throw new Error('user-def.json must contain a users array.');
  const users: CanonicalizedUser[] = [];
  for (const rawUser of rawUsers) {
    if (!rawUser || typeof rawUser !== 'object') throw new Error('Each user entry must be an object.');
    const input = rawUser as UserInput;
    const fallback = String(users.length + 1);

    const hasLegacyPersonaKey = Object.keys(input).some((k) => k.toLowerCase() === 'persona');
    if (hasLegacyPersonaKey) {
      const fields: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(input)) {
        if (k.toLowerCase() !== 'persona') fields[k] = v;
      }
      const userFields = canonicalizeFieldObject(fields, fieldMap, 'user');
      users.push(
        attachCsvSource(
          {
            inputKey: resolveInputKey(userFields, `unknown:${fallback}`),
            personas: [],
            effectivePersona: {},
            fields: userFields,
            validationErrors: [buildValidationError('errorLegacyPersonaKey', [])],
          },
          input
        )
      );
      continue;
    }

    const personaNames = input.personas;
    const validNames =
      Array.isArray(personaNames) && personaNames.length > 0 && personaNames.every((n) => typeof n === 'string');
    if (!validNames) {
      if (!personasSupplied) {
        users.push(canonicalizeValidUser(input, [], personas, fieldMap, fallback, related));
        continue;
      }
      const fields: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(input)) {
        if (!reservedUserKeys.has(k.toLowerCase())) fields[k] = v;
      }
      const userFields = canonicalizeFieldObject(fields, fieldMap, 'user');
      users.push(
        attachCsvSource(
          {
            inputKey: resolveInputKey(userFields, `unknown:${fallback}`),
            personas: [],
            effectivePersona: {},
            fields: userFields,
            validationErrors: [buildValidationError('errorNoPersonas', [])],
          },
          input
        )
      );
      continue;
    }

    users.push(canonicalizeValidUser(input, personaNames, personas, fieldMap, fallback, related));
  }
  return users;
};

export const validatePersonaModes = (personas: Record<string, PersonaDefinition>): void => {
  for (const [personaKey, persona] of Object.entries(personas)) {
    for (const modeKey of modeKeys) normalizeMode(persona[modeKey]);
    for (const listKey of assignmentListKeys) {
      const candidate = persona[listKey];
      if (candidate !== undefined && !Array.isArray(candidate)) {
        throw new Error(`Persona "${personaKey}" has non-array ${listKey}.`);
      }
    }
  }
};

export const practicalRequiredUserFields = [
  'Username',
  'LastName',
  'Alias',
  'TimeZoneSidKey',
  'LocaleSidKey',
  'EmailEncodingKey',
  'LanguageLocaleKey',
] as const;

// `profileIntended` is true when a profile was specified from any source (user `profile` meta key,
// raw `ProfileId`, or persona `profile`). When intended but unresolved, buildTarget already reports a
// reference-missing error, so we must not also report ProfileId as missing here (avoids a double error).
export const missingRequiredFieldsForInsert = (fields: Record<string, unknown>, profileIntended: boolean): string[] => {
  const missing: string[] = practicalRequiredUserFields.filter((field) => !fields[field]);
  if (!profileIntended && !fields.ProfileId) missing.push('ProfileId');
  return missing;
};
