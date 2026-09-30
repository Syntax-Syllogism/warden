import { readFile } from 'node:fs/promises';
import {
  parsePersonaDefinitions,
  type PersonaDefinition,
  type PersonaDefinitionsFile,
} from '@syntax-syllogism/warden-core';
import type { Connection } from '@salesforce/core';
import { describeObject } from './orgWrites.js';

export const PERSONA_OBJECT = 'wdn_Persona__c';
export const PERSONA_COMPONENT_OBJECT = 'wdn_Persona_Component__c';
export const PERSONA_NAME_FIELD = 'Name';
export const PERSONA_API_NAME_FIELD = 'wdn_Api_Name__c';
export const PERSONA_ACTIVE_FIELD = 'wdn_Active__c';
export const COMPONENT_PERSONA_FIELD = 'wdn_Persona__c';
export const COMPONENT_TYPE_FIELD = 'wdn_Type__c';
export const COMPONENT_REFERENCE_FIELD = 'wdn_Reference__c';

type JsonRecord = Record<string, unknown>;
type QueryResult = { records?: JsonRecord[] };
type SaveResult = { success?: boolean; id?: string; errors?: unknown[] };

const COLLECTION_BATCH_SIZE = 200;

export type PersonaDocument = PersonaDefinitionsFile;

export type OrgPersonaRead = {
  document: PersonaDocument;
  count: number;
};

export type PersonaPromotionResult = {
  personas: number;
  components: number;
  prunedComponents?: number;
};

export const personaPackageDetected = (connection: Connection): Promise<boolean> =>
  describeObject(connection, PERSONA_OBJECT);

const listFields = {
  'Permission Set': 'permissionSets',
  'Permission Set Group': 'permissionSetGroups',
  'Public Group': 'publicGroups',
  Queue: 'queues',
} as const;

type ListField = (typeof listFields)[keyof typeof listFields];

const asString = (record: JsonRecord, field: string): string | undefined =>
  typeof record[field] === 'string' ? (record[field] as string) : undefined;

const asArray = <T>(value: T | T[]): T[] => (Array.isArray(value) ? value : [value]);

const escapeSoql = (value: string): string => value.replaceAll('\\', '\\\\').replaceAll("'", "\\'");

const batches = <T>(items: T[]): T[][] => {
  const result: T[][] = [];
  for (let start = 0; start < items.length; start += COLLECTION_BATCH_SIZE)
    result.push(items.slice(start, start + COLLECTION_BATCH_SIZE));
  return result;
};

const soqlValues = (values: string[]): string =>
  values
    .map(escapeSoql)
    .map((value) => `'${value}'`)
    .join(',');

const queryRecords = async (connection: Connection, soql: string): Promise<JsonRecord[]> => {
  const result = (await connection.query(soql)) as QueryResult;
  return result.records ?? [];
};

const saveResults = (result: unknown): SaveResult[] => asArray(result as SaveResult | SaveResult[]);

const assertSuccessful = (operation: string, result: unknown): string[] => {
  const failures = saveResults(result).flatMap((item) => (item.success === false ? item.errors ?? [item] : []));
  if (failures.length > 0) throw new Error(`${operation} failed: ${JSON.stringify(failures)}`);
  return saveResults(result)
    .map((item) => item.id)
    .filter((id): id is string => typeof id === 'string');
};

const queryRecordsInBatches = async (
  connection: Connection,
  values: string[],
  query: (batch: string[]) => string
): Promise<JsonRecord[]> => {
  const records: JsonRecord[] = [];
  for (const batch of batches(values)) {
    // eslint-disable-next-line no-await-in-loop
    records.push(...(await queryRecords(connection, query(batch))));
  }
  return records;
};

const saveInBatches = async <T>(
  records: T[],
  save: (batch: T[]) => Promise<unknown>,
  operation: string
): Promise<void> => {
  for (const batch of batches(records)) {
    // eslint-disable-next-line no-await-in-loop
    assertSuccessful(operation, await save(batch));
  }
};

const emptyPersona = (): PersonaDefinition => ({
  permissionSets: [],
  permissionSetGroups: [],
  publicGroups: [],
  queues: [],
});

const addComponent = (persona: PersonaDefinition, type: string, reference: string): PersonaDefinition => {
  const field = listFields[type as keyof typeof listFields] as ListField | undefined;
  if (!field) return persona;
  const values = persona[field] ?? [];
  return values.includes(reference) ? persona : { ...persona, [field]: [...values, reference] };
};

const componentKey = (personaId: string, type: string, reference: string): string =>
  `${personaId}|${type}|${reference}`;

export const readOrgPersonas = async (connection: Connection, activeOnly = true): Promise<OrgPersonaRead> => {
  const activeClause = activeOnly ? ` WHERE ${PERSONA_ACTIVE_FIELD} = true` : '';
  const personas = await queryRecords(
    connection,
    `SELECT Id, ${PERSONA_API_NAME_FIELD}, ${PERSONA_ACTIVE_FIELD} FROM ${PERSONA_OBJECT}${activeClause}`
  );
  const ids = personas.map((persona) => asString(persona, 'Id')).filter((id): id is string => Boolean(id));
  const components = await queryRecordsInBatches(
    connection,
    ids,
    (batch) =>
      `SELECT Id, ${COMPONENT_PERSONA_FIELD}, ${COMPONENT_TYPE_FIELD}, ${COMPONENT_REFERENCE_FIELD} FROM ${PERSONA_COMPONENT_OBJECT} WHERE ${COMPONENT_PERSONA_FIELD} IN (${soqlValues(
        batch
      )})`
  );
  const personaById = new Map<string, { name: string; definition: PersonaDefinition }>();
  for (const persona of personas) {
    const id = asString(persona, 'Id');
    const name = asString(persona, PERSONA_API_NAME_FIELD);
    if (id && name) personaById.set(id, { name, definition: emptyPersona() });
  }
  for (const component of components) {
    const parentId = asString(component, COMPONENT_PERSONA_FIELD);
    const type = asString(component, COMPONENT_TYPE_FIELD);
    const reference = asString(component, COMPONENT_REFERENCE_FIELD);
    const persona = parentId ? personaById.get(parentId) : undefined;
    if (persona && type && reference) persona.definition = addComponent(persona.definition, type, reference);
  }
  const definitions: Record<string, PersonaDefinition> = {};
  for (const { name, definition } of personaById.values()) definitions[name] = definition;
  return { document: { personas: definitions }, count: Object.keys(definitions).length };
};

export const readPersonaFile = async (path: string): Promise<PersonaDocument> =>
  parsePersonaDefinitions(JSON.parse(await readFile(path, 'utf8')));

const componentRecords = (document: PersonaDocument): Array<Record<string, string>> =>
  Object.entries(document.personas).flatMap(([apiName, persona]) => {
    const entries: Array<Record<string, string>> = [];
    for (const [type, field] of Object.entries(listFields)) {
      for (const reference of persona[field] ?? []) {
        entries.push({ apiName, type, reference });
      }
    }
    return entries;
  });

const loadPersonaIds = async (connection: Connection, names: string[]): Promise<Map<string, string>> => {
  if (names.length === 0) return new Map();
  const records = await queryRecordsInBatches(
    connection,
    names,
    (batch) =>
      `SELECT Id, ${PERSONA_API_NAME_FIELD} FROM ${PERSONA_OBJECT} WHERE ${PERSONA_API_NAME_FIELD} IN (${soqlValues(
        batch
      )})`
  );
  return new Map(
    records.flatMap((record) => {
      const id = asString(record, 'Id');
      const name = asString(record, PERSONA_API_NAME_FIELD);
      return id && name ? [[name, id] as const] : [];
    })
  );
};

export const importOrgPersonas = async (
  connection: Connection,
  document: PersonaDocument,
  prune = false
): Promise<PersonaPromotionResult> => {
  const names = Object.keys(document.personas);
  const parentRecords = names.map((apiName) => ({
    [PERSONA_NAME_FIELD]: apiName,
    [PERSONA_API_NAME_FIELD]: apiName,
    [PERSONA_ACTIVE_FIELD]: true,
  }));
  const personaSObject = connection.sobject(PERSONA_OBJECT) as unknown as {
    upsert(records: unknown[], externalIdField: string): Promise<unknown>;
  };
  await saveInBatches(parentRecords, (batch) => personaSObject.upsert(batch, PERSONA_API_NAME_FIELD), 'Persona upsert');
  const personaIds = await loadPersonaIds(connection, names);
  const desired = componentRecords(document).flatMap((component) => {
    const personaId = personaIds.get(component.apiName);
    return personaId ? [{ personaId, type: component.type, reference: component.reference }] : [];
  });
  const existing = await queryRecordsInBatches(
    connection,
    [...personaIds.values()],
    (batch) =>
      `SELECT Id, ${COMPONENT_PERSONA_FIELD}, ${COMPONENT_TYPE_FIELD}, ${COMPONENT_REFERENCE_FIELD} FROM ${PERSONA_COMPONENT_OBJECT} WHERE ${COMPONENT_PERSONA_FIELD} IN (${soqlValues(
        batch
      )})`
  );
  const existingKeys = new Set(
    existing
      .flatMap((component) => {
        const id = asString(component, 'Id');
        const personaId = asString(component, COMPONENT_PERSONA_FIELD);
        const type = asString(component, COMPONENT_TYPE_FIELD);
        const reference = asString(component, COMPONENT_REFERENCE_FIELD);
        return id && personaId && type && reference ? [[componentKey(personaId, type, reference), id] as const] : [];
      })
      .map(([key]) => key)
  );
  const desiredKeys = new Set(
    desired.map((component) => componentKey(component.personaId, component.type, component.reference))
  );
  const toCreate = desired
    .filter((component) => !existingKeys.has(componentKey(component.personaId, component.type, component.reference)))
    .map((component) => ({
      [COMPONENT_PERSONA_FIELD]: component.personaId,
      [COMPONENT_TYPE_FIELD]: component.type,
      [COMPONENT_REFERENCE_FIELD]: component.reference,
    }));
  if (toCreate.length > 0) {
    const componentSObject = connection.sobject(PERSONA_COMPONENT_OBJECT) as unknown as {
      create(records: unknown[]): Promise<unknown>;
    };
    await saveInBatches(toCreate, (batch) => componentSObject.create(batch), 'Persona component insert');
  }
  let prunedComponents = 0;
  if (prune) {
    const toDelete = existing.flatMap((component) => {
      const id = asString(component, 'Id');
      const personaId = asString(component, COMPONENT_PERSONA_FIELD);
      const type = asString(component, COMPONENT_TYPE_FIELD);
      const reference = asString(component, COMPONENT_REFERENCE_FIELD);
      return id && personaId && type && reference && !desiredKeys.has(componentKey(personaId, type, reference))
        ? [id]
        : [];
    });
    if (toDelete.length > 0) {
      const componentSObject = connection.sobject(PERSONA_COMPONENT_OBJECT) as unknown as {
        delete(ids: string[]): Promise<unknown>;
      };
      await saveInBatches(toDelete, (batch) => componentSObject.delete(batch), 'Persona component delete');
      prunedComponents = toDelete.length;
    }
  }
  return { personas: names.length, components: desired.length, ...(prune ? { prunedComponents } : {}) };
};

export type PersonaDiff = {
  added: string[];
  removed: string[];
  changed: Array<{ name: string; before: PersonaDefinition; after: PersonaDefinition }>;
};

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value))
    return value.map(canonicalize).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)])
    );
  }
  return value;
};

const stable = (value: unknown): string => JSON.stringify(canonicalize(value));

// Org reads always carry every list; a file may omit empty ones.
const withEmptyLists = (persona: PersonaDefinition): PersonaDefinition => {
  const result: PersonaDefinition = { ...persona };
  for (const field of Object.values(listFields)) result[field] = persona[field] ?? [];
  return result;
};

const samePersona = (left: PersonaDefinition, right: PersonaDefinition): boolean =>
  stable(withEmptyLists(left)) === stable(withEmptyLists(right));

export const diffPersonaDocuments = (file: PersonaDocument, org: PersonaDocument): PersonaDiff => {
  const added = Object.keys(file.personas)
    .filter((name) => !(name in org.personas))
    .sort();
  const removed = Object.keys(org.personas)
    .filter((name) => !(name in file.personas))
    .sort();
  const changed = Object.keys(file.personas)
    .filter((name) => name in org.personas && !samePersona(file.personas[name], org.personas[name]))
    .sort()
    .map((name) => ({ name, before: org.personas[name], after: file.personas[name] }));
  return { added, removed, changed };
};

export const renderPersonaDiff = (diff: PersonaDiff): string => {
  const lines = [`Added: ${diff.added.length}`, `Removed: ${diff.removed.length}`, `Changed: ${diff.changed.length}`];
  for (const name of diff.added) lines.push(`  + ${name}`);
  for (const name of diff.removed) lines.push(`  - ${name}`);
  for (const change of diff.changed) lines.push(`  ~ ${change.name}`);
  return lines.join('\n');
};
