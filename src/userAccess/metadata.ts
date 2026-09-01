import type { Connection } from '@salesforce/core';
import { UserAccessError } from './types.js';

export const METADATA_BATCH_SIZE = 10;
export const METADATA_CONCURRENCY = 2;

type MetadataComponent = { fullName: string } & Record<string, unknown>;
export type MetadataType = 'Profile' | 'PermissionSet' | 'MutingPermissionSet';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const responseItems = (response: unknown): unknown[] => {
  if (response === null || response === undefined) return [];
  if (Array.isArray(response)) return response;
  if (isRecord(response)) return [response];
  throw new Error('Metadata API returned a non-object response.');
};

const metadataFailure = (type: MetadataType, names: string[], cause: unknown): UserAccessError =>
  new UserAccessError('errorRecordTypeMetadataReadFailed', [type, names.join(', ')], cause);

const validateBatch = (type: MetadataType, requestedNames: string[], response: unknown): MetadataComponent[] => {
  let items: unknown[];
  try {
    items = responseItems(response);
  } catch (error) {
    throw metadataFailure(type, requestedNames, error);
  }
  const requested = new Set(requestedNames);
  const seen = new Set<string>();
  const components: MetadataComponent[] = [];
  for (const item of items) {
    if (!isRecord(item) || typeof item.fullName !== 'string' || !item.fullName) {
      throw metadataFailure(type, requestedNames, new Error('Metadata API returned a malformed component.'));
    }
    if (!requested.has(item.fullName)) {
      throw metadataFailure(type, requestedNames, new Error(`Unexpected component ${item.fullName}.`));
    }
    if (seen.has(item.fullName)) {
      throw metadataFailure(type, requestedNames, new Error(`Duplicate component ${item.fullName}.`));
    }
    seen.add(item.fullName);
    components.push(item as MetadataComponent);
  }
  return components;
};

export async function readMetadataInBatches<T>(
  conn: Connection,
  type: MetadataType,
  fullNames: string[],
  options: { batchSize?: number; concurrency?: number } = {}
): Promise<Map<string, T>> {
  const batchSize = options.batchSize ?? METADATA_BATCH_SIZE;
  const concurrency = options.concurrency ?? METADATA_CONCURRENCY;
  if (!Number.isInteger(batchSize) || batchSize <= 0) throw new Error('Metadata batchSize must be greater than 0.');
  if (!Number.isInteger(concurrency) || concurrency <= 0)
    throw new Error('Metadata concurrency must be greater than 0.');

  const uniqueNames = [...new Set(fullNames)];
  if (uniqueNames.length === 0) return new Map();
  const batches: string[][] = [];
  for (let index = 0; index < uniqueNames.length; index += batchSize) {
    batches.push(uniqueNames.slice(index, index + batchSize));
  }
  const batchResults: MetadataComponent[][] = Array.from({ length: batches.length }, () => []);
  let nextBatch = 0;
  const worker = async (): Promise<void> => {
    while (nextBatch < batches.length) {
      const batchIndex = nextBatch;
      nextBatch += 1;
      const batch = batches[batchIndex];
      try {
        // eslint-disable-next-line no-await-in-loop
        const response = await conn.metadata.read(type, batch);
        batchResults[batchIndex] = validateBatch(type, batch, response);
      } catch (error) {
        if (error instanceof UserAccessError) throw error;
        throw metadataFailure(type, batch, error);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, () => worker()));

  const result = new Map<string, T>();
  for (const components of batchResults) {
    for (const component of components) {
      if (result.has(component.fullName)) {
        throw metadataFailure(type, [component.fullName], new Error(`Duplicate component ${component.fullName}.`));
      }
      result.set(component.fullName, component as T);
    }
  }
  if (result.size !== uniqueNames.length || uniqueNames.some((name) => !result.has(name))) {
    const missing = uniqueNames.filter((name) => !result.has(name));
    throw metadataFailure(
      type,
      missing.length > 0 ? missing : uniqueNames,
      new Error('Metadata API returned incomplete data.')
    );
  }
  return result;
}

type MetadataListing = { id?: string; fullName?: string };

/**
 * Map each component's record Id (15- and 18-char) to the fullName the Metadata
 * API expects, using a metadata listing.
 *
 * This solves two record-type audit problems that only appear against real orgs.
 * Standard profiles expose a metadata name that differs from the SOQL Name/label
 * (for example "Contract Manager" is "ContractManager" and "Standard User" is
 * "Standard"), and non-auditable system profiles such as Automated Process are
 * omitted from the listing entirely. Muting permission sets are a separate object
 * whose Ids are not returned by a PermissionSet SOQL query and whose
 * PermissionSetGroupComponent.PermissionSet relationship is null; the listing is
 * the reliable Id to fullName source. Callers translate through this map and skip
 * Ids it does not contain.
 */
const metadataNamesById = async (
  conn: Connection,
  type: 'Profile' | 'MutingPermissionSet'
): Promise<Map<string, string>> => {
  const response = await conn.metadata.list([{ type }], conn.getApiVersion());
  const items = Array.isArray(response) ? response : response ? [response] : [];
  const byId = new Map<string, string>();
  for (const item of items as MetadataListing[]) {
    if (typeof item?.id === 'string' && item.id && typeof item.fullName === 'string' && item.fullName) {
      // Key on the canonical 15-char Id so lookups work whether the listing and
      // the SOQL Id come back 15- or 18-char.
      byId.set(item.id.substring(0, 15), item.fullName);
    }
  }
  return byId;
};

export const profileMetadataNamesById = (conn: Connection): Promise<Map<string, string>> =>
  metadataNamesById(conn, 'Profile');

export const mutingPermissionSetMetadataNamesById = (conn: Connection): Promise<Map<string, string>> =>
  metadataNamesById(conn, 'MutingPermissionSet');

export type RecordTypeVisibility = { recordType: string; visible: boolean; default?: boolean };

export const recordTypeVisibilities = (metadata: MetadataComponent, type: MetadataType): RecordTypeVisibility[] => {
  const raw = metadata.recordTypeVisibilities;
  const entries = raw === undefined || raw === null ? [] : Array.isArray(raw) ? raw : [raw];
  const normalized: RecordTypeVisibility[] = [];
  for (const entry of entries) {
    if (!isRecord(entry) || typeof entry.recordType !== 'string' || typeof entry.visible !== 'boolean') {
      throw metadataFailure(type, [metadata.fullName], new Error('Malformed recordTypeVisibilities entry.'));
    }
    if (entry.default !== undefined && typeof entry.default !== 'boolean') {
      throw metadataFailure(type, [metadata.fullName], new Error('Malformed record type default value.'));
    }
    normalized.push({
      recordType: entry.recordType,
      visible: entry.visible,
      ...(entry.default === undefined ? {} : { default: entry.default }),
    });
  }
  return normalized;
};
