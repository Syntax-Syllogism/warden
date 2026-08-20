import type { Connection } from '@salesforce/core';
import type { UserFieldMeta } from '../userProvisioning/planner.js';
import { soqlIn } from '../userShared/sfUtils.js';
import { describeSobject, type SobjectDescribeCache, type SobjectDescribeInfo } from '../userShared/userFields.js';
import type { RelatedCatalog, RelatedMessage, RelationshipDef } from './types.js';

export type RelatedPreflightResult = {
  eligible: Set<string>;
  ineligible: Map<string, string>;
  warnings: string[];
  /** Field metadata for every relationship sObject that could be described. */
  fieldsBySobject: Map<string, Map<string, UserFieldMeta>>;
  /** Resolved `RecordTypeId` per relationship name, when the relationship declares one. */
  recordTypeIdByRelationship: Map<string, string>;
};

export const emptyPreflightResult = (): RelatedPreflightResult => ({
  eligible: new Set(),
  ineligible: new Map(),
  warnings: [],
  fieldsBySobject: new Map(),
  recordTypeIdByRelationship: new Map(),
});

type RecordTypeRow = {
  Id: string;
  DeveloperName: string;
  SobjectType: string;
  IsActive?: boolean;
  /** Only selected, and only present, when the org has person accounts enabled. */
  IsPersonType?: boolean;
};

/**
 * An `Account` relationship must accept either spelling of the record type's owning
 * sObject.
 *
 * Confirmed against a person-accounts-enabled org: `RecordType.SobjectType` reads
 * `Account` there, not `PersonAccount`, so the extra alias is currently unused. It is
 * kept because it costs one IN value and guards the other spelling.
 */
const sobjectAliases = (sobject: string): string[] =>
  sobject.toLowerCase() === 'account' ? ['Account', 'PersonAccount'] : [sobject];

/**
 * `RecordType.IsPersonType` only exists when the org has person accounts enabled --
 * selecting it elsewhere fails the whole query with `No such column 'IsPersonType'`,
 * which would take down record-type resolution for every relationship. So it is only
 * requested once the Account describe has shown person accounts to be on.
 */
const queryRecordTypes = async (
  conn: Connection,
  requests: Array<{ sobject: string; developerName: string }>,
  personAccountsEnabled: boolean
): Promise<RecordTypeRow[]> => {
  if (requests.length === 0) return [];
  const sobjects = [...new Set(requests.flatMap((request) => sobjectAliases(request.sobject)))];
  const developerNames = [...new Set(requests.map((request) => request.developerName))];
  const columns = [
    'Id',
    'DeveloperName',
    'SobjectType',
    'IsActive',
    ...(personAccountsEnabled ? ['IsPersonType'] : []),
  ];
  const soql =
    `SELECT ${columns.join(', ')} FROM RecordType ` +
    `WHERE SobjectType IN (${soqlIn(sobjects)}) AND DeveloperName IN (${soqlIn(developerNames)})`;
  return (await conn.query<RecordTypeRow>(soql)).records;
};

/**
 * `Account.IsPersonAccount` exists only when person accounts are enabled, which makes it
 * the cheapest reliable signal -- the Account describe is already in hand.
 */
const hasPersonAccounts = (described: SobjectDescribeInfo | undefined): boolean =>
  described?.fields.has('ispersonaccount') === true;

const missingFields = (def: RelationshipDef, fieldMap: Map<string, UserFieldMeta>): string[] =>
  [def.match.field, ...Object.keys(def.fields)].filter((field) => !fieldMap.has(field.toLowerCase()));

const unwritableFields = (def: RelationshipDef, fieldMap: Map<string, UserFieldMeta>): string[] =>
  Object.keys(def.fields).filter((field) => {
    const meta = fieldMap.get(field.toLowerCase());
    return meta ? !meta.createable && !meta.updateable : false;
  });

const unreadableFields = (def: RelationshipDef, fieldMap: Map<string, UserFieldMeta>): string[] =>
  [def.match.field, ...Object.keys(def.fields)].filter(
    (field) => fieldMap.get(field.toLowerCase())?.readable === false
  );

const describeOrUndefined = async (
  conn: Connection,
  sobject: string,
  cache: SobjectDescribeCache
): Promise<SobjectDescribeInfo | undefined> => {
  try {
    return await describeSobject(conn, sobject, cache);
  } catch {
    return undefined;
  }
};

/**
 * The REST describe omits `isPersonType` from `recordTypeInfos` -- verified absent at
 * API v67.0 in a person-accounts-enabled org, for every Account record type including
 * the person one. Reading it there silently rejects every Account relationship, so the
 * SOQL `IsPersonType` is the primary source and the describe flag is only a fallback for
 * describes that do carry it.
 */
const isEligiblePersonAccountRecordType = (
  def: RelationshipDef,
  described: SobjectDescribeInfo,
  id: string,
  row: RecordTypeRow
): boolean => {
  if (def.sobject.toLowerCase() !== 'account') return true;
  const recordType = described.recordTypeInfos.get(id);
  if (recordType?.available !== true) return false;
  return row.IsPersonType === true || recordType.isPersonType === true;
};

const checkFieldMetadata = (
  def: RelationshipDef,
  fieldMap: Map<string, UserFieldMeta>,
  message: RelatedMessage
): string | undefined => {
  const missing = missingFields(def, fieldMap);
  if (missing.length > 0) return message('errorRelatedUnknownFields', [def.sobject, missing.join(', ')]);
  const matchMeta = fieldMap.get(def.match.field.toLowerCase());
  if (!matchMeta?.filterable || !(matchMeta.externalId === true || matchMeta.unique === true)) {
    return message('errorRelatedMatchFieldNotUnique', [def.match.field, def.sobject]);
  }
  const unreadable = unreadableFields(def, fieldMap);
  if (unreadable.length > 0) return message('errorRelatedFieldsNotReadable', [def.sobject, unreadable.join(', ')]);
  const unwritable = unwritableFields(def, fieldMap);
  if (unwritable.length > 0) return message('errorRelatedFieldsNotWritable', [def.sobject, unwritable.join(', ')]);
  return undefined;
};

/**
 * Validate every relationship at least one user selected, once per batch.
 *
 * Ineligible relationships become warning lines rather than errors: they flow into the
 * single `acknowledgeWarnings` confirmation the command already issues, so confirming
 * skips them, declining exits before any DML, and `--no-prompt`/JSON runs skip
 * automatically.
 */
export const runRelatedPreflight = async (options: {
  conn: Connection;
  catalog: RelatedCatalog;
  selected: string[];
  cache: SobjectDescribeCache;
  message: RelatedMessage;
}): Promise<RelatedPreflightResult> => {
  const { conn, catalog, selected, cache, message } = options;
  const result = emptyPreflightResult();
  const names = [...new Set(selected)].filter((name) => Boolean(catalog.relationships[name]));
  if (names.length === 0) return result;

  const describedByName = new Map<string, SobjectDescribeInfo | undefined>();
  for (const name of names) {
    const def = catalog.relationships[name];
    // Sequential so the describe cache is shared between relationships on one sObject.
    // eslint-disable-next-line no-await-in-loop
    describedByName.set(name, await describeOrUndefined(conn, def.sobject, cache));
  }

  const recordTypeRequests = names
    .filter((name) => catalog.relationships[name].recordType)
    .map((name) => ({
      sobject: catalog.relationships[name].sobject,
      developerName: catalog.relationships[name].recordType!.developerName,
    }));
  const recordTypeRows = await queryRecordTypes(
    conn,
    recordTypeRequests,
    names.some(
      (name) =>
        catalog.relationships[name].sobject.toLowerCase() === 'account' && hasPersonAccounts(describedByName.get(name))
    )
  );

  for (const name of names) {
    const def = catalog.relationships[name];
    const described = describedByName.get(name);
    if (!described) {
      result.ineligible.set(name, message('errorRelatedSobjectUnavailable', [def.sobject]));
      continue;
    }
    result.fieldsBySobject.set(def.sobject.toLowerCase(), described.fields);
    if (!described.queryable) {
      result.ineligible.set(name, message('errorRelatedSobjectNotQueryable', [def.sobject]));
      continue;
    }
    const fieldProblem = checkFieldMetadata(def, described.fields, message);
    if (fieldProblem) {
      result.ineligible.set(name, fieldProblem);
      continue;
    }
    if (def.sobject.toLowerCase() === 'account' && !def.recordType) {
      result.ineligible.set(name, message('errorRelatedPersonAccountRecordTypeRequired', [def.sobject]));
      continue;
    }
    if (def.recordType) {
      const allowed = new Set(sobjectAliases(def.sobject).map((alias) => alias.toLowerCase()));
      const row = recordTypeRows.find(
        (candidate) =>
          candidate.DeveloperName === def.recordType!.developerName &&
          allowed.has(String(candidate.SobjectType).toLowerCase()) &&
          candidate.IsActive !== false
      );
      if (!row) {
        result.ineligible.set(
          name,
          message('errorRelatedRecordTypeUnavailable', [def.recordType.developerName, def.sobject])
        );
        continue;
      }
      if (!isEligiblePersonAccountRecordType(def, described, row.Id, row)) {
        result.ineligible.set(
          name,
          message('errorRelatedRecordTypeUnavailable', [def.recordType.developerName, def.sobject])
        );
        continue;
      }
      result.recordTypeIdByRelationship.set(name, row.Id);
    }
    result.eligible.add(name);
  }

  // One aggregated warning line per ineligible relationship, never one per user.
  for (const [name, reason] of result.ineligible) {
    result.warnings.push(message('warningRelationshipSkipped', [name, reason]));
  }
  return result;
};
