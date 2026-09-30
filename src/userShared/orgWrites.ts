/* eslint-disable camelcase */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { Connection } from '@salesforce/core';
import type { ProvisionResult } from '@syntax-syllogism/warden-core';

export const WARDEN_LEDGER_OBJECT = 'wdn_Provisioned_Grant__c';
export const WARDEN_RUN_OBJECT = 'wdn_Reconciliation_Run__c';
export const WARDEN_ITEM_OBJECT = 'wdn_Reconciliation_Item__c';

export type ConnectedPackage = {
  ledgerAvailable: boolean;
  runAvailable: boolean;
};

export type GrantType = 'Permission Set' | 'Permission Set Group' | 'Public Group' | 'Queue';

export type CapturedGrant = {
  userId: string;
  type: GrantType;
  targetId: string;
};

export type Provenance = {
  sourceSystem: string;
  cliVersion?: string;
  invokingUser?: string;
  ciJob?: string;
  definitionPath?: string;
  definitionSha?: string;
};

export type LedgerRow = {
  wdn_User__c: string;
  wdn_Type__c: GrantType;
  wdn_Target_Id__c: string;
  wdn_Target_Label__c: string;
  wdn_Granted_On__c: string;
  wdn_Granted_By_Run__c?: string;
};

export type ReconciliationItem = {
  wdn_Reconciliation_Run__c: string;
  wdn_User_Key__c: string;
  wdn_User_Id__c: string;
  wdn_Category__c: string;
  wdn_Action__c: string;
  wdn_Status__c: 'Planned' | 'Applied' | 'Failed' | 'Unmanaged';
  wdn_Detail__c: string;
  wdn_Error__c: string;
};

type SaveResult = { success?: boolean; id?: string; errors?: unknown[] };
type QueryResult = { records?: Array<Record<string, unknown>> };
type JsonRecord = Record<string, unknown>;

type CaptureState = {
  grants: CapturedGrant[];
  labelsByTypeAndId: Map<string, Map<string, string>>;
  referenceIdsByType: Map<string, Map<string, string>>;
  groupTypesById: Map<string, Extract<GrantType, 'Public Group' | 'Queue'>>;
};

const packageVersion = (): string | undefined => {
  try {
    const packagePath = fileURLToPath(new URL('../../package.json', import.meta.url));
    const packageJson = JSON.parse(readFileSync(packagePath, 'utf8')) as { version?: unknown };
    return typeof packageJson.version === 'string' ? packageJson.version : undefined;
  } catch {
    return undefined;
  }
};

const asArray = <T>(value: T | T[]): T[] => (Array.isArray(value) ? value : [value]);

export const describeObject = async (connection: Connection, objectName: string): Promise<boolean> => {
  try {
    const description = (await connection.describe(objectName)) as { name?: unknown };
    return description.name === objectName;
  } catch {
    return false;
  }
};

/** Detect only through describe; InstalledSubscriberPackage is intentionally not consulted. */
export const detectConnectedPackage = async (connection: Connection): Promise<ConnectedPackage> => {
  const [ledgerAvailable, runAvailable] = await Promise.all([
    describeObject(connection, WARDEN_LEDGER_OBJECT),
    describeObject(connection, WARDEN_RUN_OBJECT),
  ]);
  return { ledgerAvailable, runAvailable };
};

const mapFor = (maps: Map<string, Map<string, string>>, key: string): Map<string, string> => {
  let map = maps.get(key);
  if (!map) {
    map = new Map<string, string>();
    maps.set(key, map);
  }
  return map;
};

const rememberReference = (state: CaptureState, type: GrantType, record: JsonRecord): void => {
  const id = typeof record.Id === 'string' ? record.Id : undefined;
  if (!id) return;
  const label = typeof record.Name === 'string' ? record.Name : undefined;
  const developerName = typeof record.DeveloperName === 'string' ? record.DeveloperName : undefined;
  const references = mapFor(state.referenceIdsByType, type);
  if (label) references.set(label, id);
  if (developerName) references.set(developerName, id);
  if (label) mapFor(state.labelsByTypeAndId, type).set(id, label);
  if (type === 'Public Group' || type === 'Queue') state.groupTypesById.set(id, type);
}

const rememberQueryRecords = (state: CaptureState, soql: string, result: QueryResult): void => {
  const objectMatch = /\bFROM\s+([A-Za-z_][A-Za-z0-9_]*)/i.exec(soql);
  const objectName = objectMatch?.[1];
  if (!objectName) return;
  const type =
    objectName === 'PermissionSet'
      ? ('Permission Set' as const)
      : objectName === 'PermissionSetGroup'
        ? ('Permission Set Group' as const)
        : objectName === 'Group'
          ? undefined
          : undefined;
  const groupTypeFromQuery = /\bType\s*=\s*'Queue'/i.test(soql)
    ? ('Queue' as const)
    : /\bType\s*=\s*'Regular'/i.test(soql)
    ? ('Public Group' as const)
    : undefined;
  for (const record of result.records ?? []) {
    if (objectName === 'Group') {
      const groupType = record.Type === 'Queue' ? 'Queue' : record.Type === 'Regular' ? 'Public Group' : groupTypeFromQuery;
      if (groupType) rememberReference(state, groupType, record);
    } else if (type) {
      rememberReference(state, type, record);
    }
  }
};

const captureSuccessfulAssignments = (
  state: CaptureState,
  objectName: string,
  records: unknown[],
  results: SaveResult[]
): void => {
  if (objectName !== 'PermissionSetAssignment' && objectName !== 'GroupMember') return;
  records.forEach((value, index) => {
    const record = value as JsonRecord;
    if (results[index]?.success !== true) return;
    const userId =
      objectName === 'PermissionSetAssignment'
        ? record.AssigneeId
        : record.UserOrGroupId;
    const targetId = objectName === 'PermissionSetAssignment' ? record.PermissionSetId ?? record.PermissionSetGroupId : record.GroupId;
    if (typeof userId !== 'string' || typeof targetId !== 'string') return;
    let type: GrantType;
    if (objectName === 'GroupMember') {
      type = state.groupTypesById.get(targetId) ?? 'Public Group';
    } else {
      type = typeof record.PermissionSetGroupId === 'string' ? 'Permission Set Group' : 'Permission Set';
    }
    state.grants.push({ userId, type, targetId });
  });
};

const wrapSObject = (sobject: object, objectName: string, state: CaptureState): object => {
  const originalCreate = Reflect.get(sobject, 'create') as unknown as (...args: unknown[]) => Promise<SaveResult | SaveResult[]>;
  return new Proxy(sobject, {
    get(target, property, receiver): unknown {
      if (property !== 'create') return Reflect.get(target, property, receiver) as unknown;
      return async (...args: unknown[]): Promise<SaveResult | SaveResult[]> => {
        const records = asArray(args[0]);
        const result = await originalCreate.apply(sobject, args);
        captureSuccessfulAssignments(state, objectName, records, asArray(result));
        return result;
      };
    },
  });
};

/** Observe core's batched assignment DML while leaving its connection contract unchanged. */
export const captureProvisioningWrites = (
  connection: Connection
): { connection: Connection; state: CaptureState } => {
  const state: CaptureState = {
    grants: [],
    labelsByTypeAndId: new Map(),
    referenceIdsByType: new Map(),
    groupTypesById: new Map(),
  };
  const originalSobject = connection.sobject.bind(connection);
  const originalQuery = connection.query.bind(connection);
  const wrapped = new Proxy(connection, {
    get(target, property, receiver): unknown {
      if (property === 'sobject') {
        return (objectName: string): object => wrapSObject(originalSobject(objectName), objectName, state);
      }
      if (property === 'query') {
        return async (...args: unknown[]): Promise<unknown> => {
          const result = (await originalQuery(...(args as Parameters<typeof originalQuery>))) as QueryResult;
          if (typeof args[0] === 'string') rememberQueryRecords(state, args[0], result);
          return result;
        };
      }
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
  return { connection: wrapped, state };
};

type PersonaDocument = { personas?: Record<string, JsonRecord> };

const refsForType = (persona: JsonRecord, type: GrantType): string[] => {
  const key =
    type === 'Permission Set'
      ? 'permissionSets'
      : type === 'Permission Set Group'
        ? 'permissionSetGroups'
        : type === 'Public Group'
          ? 'publicGroups'
          : 'queues';
  const refs = persona[key];
  return Array.isArray(refs) ? refs.filter((ref): ref is string => typeof ref === 'string') : [];
};

const matchingPersonaCount = (
  userPersonas: string[],
  personas: Record<string, JsonRecord> | undefined,
  grant: CapturedGrant,
  referenceIdsByType: Map<string, Map<string, string>>
): number => {
  const referenceIds = referenceIdsByType.get(grant.type);
  return userPersonas.filter((personaName) => {
    const refs = refsForType(personas?.[personaName] ?? {}, grant.type);
    return refs.some((ref) => (referenceIds?.get(ref) ?? ref) === grant.targetId);
  }).length;
};

export const buildLedgerRows = (options: {
  grants: CapturedGrant[];
  result: ProvisionResult;
  personasDoc?: PersonaDocument;
  labelsByTypeAndId?: Map<string, Map<string, string>>;
  referenceIdsByType?: Map<string, Map<string, string>>;
  runId?: string;
  grantedOn?: string;
}): LedgerRow[] => {
  const usersById = new Map(options.result.users.filter((user) => user.id).map((user) => [user.id as string, user]));
  const rows: LedgerRow[] = [];
  for (const grant of options.grants) {
    const user = usersById.get(grant.userId);
    const count = matchingPersonaCount(
      user?.personas ?? [],
      options.personasDoc?.personas,
      grant,
      options.referenceIdsByType ?? new Map<string, Map<string, string>>()
    );
    const duplicateCount = count > 0 ? count : 1;
    const label = options.labelsByTypeAndId?.get(grant.type)?.get(grant.targetId) ?? grant.targetId;
    for (let index = 0; index < duplicateCount; index += 1) {
      rows.push({
        wdn_User__c: grant.userId,
        wdn_Type__c: grant.type,
        wdn_Target_Id__c: grant.targetId,
        wdn_Target_Label__c: label,
        wdn_Granted_On__c: options.grantedOn ?? new Date().toISOString(),
        ...(options.runId ? { wdn_Granted_By_Run__c: options.runId } : {}),
      });
    }
  }
  return rows;
};

const actionCategory = (action: string): string => {
  if (action.includes('PermissionSetGroup')) return 'Permission Set Group';
  if (action.includes('PermissionSet')) return 'Permission Set';
  if (action.includes('PublicGroup')) return 'Public Group';
  if (action.includes('Queue')) return 'Queue';
  return 'User';
};

const itemStatus = (status: ProvisionResult['users'][number]['status']): ReconciliationItem['wdn_Status__c'] => {
  if (status === 'planned') return 'Planned';
  if (status === 'failed') return 'Failed';
  return 'Applied';
};

/** The row expansion intentionally follows renderProvisionCsv's action/error behavior. */
export const buildReconciliationItems = (result: ProvisionResult, runId: string): ReconciliationItem[] => {
  const items: ReconciliationItem[] = [];
  for (const user of result.users) {
    const base = {
      wdn_Reconciliation_Run__c: runId,
      wdn_User_Key__c: user.key,
      wdn_User_Id__c: user.id ?? '',
      wdn_Status__c: itemStatus(user.status),
    } as const;
    for (const action of user.actions) {
      items.push({
        ...base,
        wdn_Category__c: actionCategory(action),
        wdn_Action__c: action,
        wdn_Detail__c: '',
        wdn_Error__c: '',
      });
    }
    for (const related of user.relatedRecords ?? []) {
      items.push({
        ...base,
        wdn_Category__c: related.sobject,
        wdn_Action__c: 'related',
        wdn_Detail__c: `${related.relationship} ${related.phase} ${related.sobject} ${related.action}`,
        wdn_Error__c: related.error ?? '',
      });
    }
    for (const error of user.errors) {
      items.push({
        ...base,
        wdn_Category__c: 'User',
        wdn_Action__c: '',
        wdn_Detail__c: '',
        wdn_Error__c: error,
      });
    }
    if (user.actions.length === 0 && (user.relatedRecords?.length ?? 0) === 0 && user.errors.length === 0) {
      items.push({
        ...base,
        wdn_Category__c: 'User',
        wdn_Action__c: '',
        wdn_Detail__c: '',
        wdn_Error__c: '',
      });
    }
  }
  return items;
};

export const buildProvenance = (options: {
  definitionPath?: string;
  env?: NodeJS.ProcessEnv;
  cliVersion?: string;
  invokingUser?: string;
  gitSha?: (path: string) => string | undefined;
} = {}): Provenance => {
  const env = options.env ?? process.env;
  const definitionPath = options.definitionPath ? resolve(options.definitionPath) : undefined;
  const defaultGitSha = (path: string): string | undefined => {
    try {
      return execFileSync('git', ['-C', dirname(path), 'rev-parse', 'HEAD'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() || undefined;
    } catch {
      return undefined;
    }
  };
  let invokingUser = options.invokingUser;
  if (!invokingUser) {
    try {
      invokingUser = userInfo().username;
    } catch {
      invokingUser = undefined;
    }
  }
  const ciJob = env.GITHUB_JOB ?? env.GITHUB_WORKFLOW ?? (env.CI ? 'CI' : undefined);
  return {
    sourceSystem: 'warden-cli',
    cliVersion: options.cliVersion ?? packageVersion(),
    invokingUser,
    ciJob,
    definitionPath,
    definitionSha: definitionPath ? (options.gitSha ?? defaultGitSha)(definitionPath) : undefined,
  };
};

export const bestEffortOrgWrite = async <T>(operation: () => Promise<T>, warn: (message: string) => void, label: string): Promise<T | undefined> => {
  try {
    return await operation();
  } catch (error) {
    warn(`Warden org ${label} write failed: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
};

export const writeBatch = async (
  connection: Connection,
  objectName: string,
  records: JsonRecord[],
  warn: (message: string) => void,
  label: string
): Promise<SaveResult[] | undefined> => {
  if (records.length === 0) return [];
  const collectionBatchSize = 200;
  const batchCount = Math.ceil(records.length / collectionBatchSize);
  const allResults: SaveResult[] = [];
  for (let start = 0; start < records.length; start += collectionBatchSize) {
    const batch = records.slice(start, start + collectionBatchSize);
    const batchNumber = Math.floor(start / collectionBatchSize) + 1;
    // Keep collection requests sequential so a failed batch cannot cancel later batches.
    // eslint-disable-next-line no-await-in-loop
    const result = await bestEffortOrgWrite(
      () => connection.sobject(objectName).create(batch, { allOrNone: false }) as Promise<SaveResult | SaveResult[]>,
      warn,
      `${label} batch ${batchNumber}/${batchCount}`
    );
    if (!result) continue;
    const saveResults = asArray(result);
    if (saveResults.length !== batch.length) {
      warn(
        `Warden org ${label} batch ${batchNumber}/${batchCount} returned ${saveResults.length} result(s) for ${batch.length} record(s).`
      );
    }
    const failures = saveResults.filter((saveResult) => saveResult.success !== true);
    if (failures.length > 0) {
      warn(`Warden org ${label} batch ${batchNumber}/${batchCount} returned ${failures.length} failed record(s).`);
    }
    allResults.push(...saveResults);
  }
  return allResults.length > 0 ? allResults : undefined;
};

export const saveRun = async (
  connection: Connection,
  fields: JsonRecord,
  warn: (message: string) => void
): Promise<string | undefined> => {
  const results = await writeBatch(connection, WARDEN_RUN_OBJECT, [fields], warn, 'run');
  const id = results?.[0]?.id;
  if (results && (!results[0] || results[0].success !== true || typeof id !== 'string')) {
    warn('Warden org run write did not return a record id.');
  }
  return id;
};

export const updateRun = async (
  connection: Connection,
  runId: string,
  fields: JsonRecord,
  warn: (message: string) => void
): Promise<void> => {
  const result = await bestEffortOrgWrite(
    () => connection.sobject(WARDEN_RUN_OBJECT).update([{ Id: runId, ...fields }], { allOrNone: false }) as Promise<SaveResult | SaveResult[]>,
    warn,
    'run summary'
  );
  if (!result) return;
  const results = asArray(result);
  results.forEach((saveResult, index) => {
    if (saveResult.success === true) return;
    const errors = saveResult.errors?.map((error) => {
      if (typeof error === 'object' && error !== null && 'message' in error) return String(error.message);
      return String(error);
    });
    warn(
      `Warden org run summary update result ${index + 1}/${results.length} failed${errors && errors.length > 0 ? `: ${errors.join('; ')}` : '.'}`
    );
  });
};
