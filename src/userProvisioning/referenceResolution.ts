import { Connection, Messages } from '@salesforce/core';
import type { LabelBundle, LabelMap } from '../userLifecycle/types.js';
import { soqlIn } from '../userShared/sfUtils.js';
import type { ResolvedRefs } from './assignmentPlan.js';
import { isSalesforceId, type CanonicalizedUser, type PersonaDefinition } from './planner.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('@syntax-syllogism/warden', 'warden.provision');

const collectPersonaRefs = (personas: Record<string, PersonaDefinition>): Record<string, Set<string>> => {
  const refs = {
    profiles: new Set<string>(),
    roles: new Set<string>(),
    permissionSets: new Set<string>(),
    permissionSetGroups: new Set<string>(),
    publicGroups: new Set<string>(),
    queues: new Set<string>(),
  };
  for (const persona of Object.values(personas)) {
    if (persona.profile) refs.profiles.add(persona.profile);
    if (persona.role) refs.roles.add(persona.role);
    for (const value of persona.permissionSets ?? []) refs.permissionSets.add(value);
    for (const value of persona.permissionSetGroups ?? []) refs.permissionSetGroups.add(value);
    for (const value of persona.publicGroups ?? []) refs.publicGroups.add(value);
    for (const value of persona.queues ?? []) refs.queues.add(value);
  }
  return refs;
};

const addReferenceLabel = (
  labels: LabelMap,
  row: Record<string, string | undefined>,
  apiNameField: string,
  labelField: string | undefined,
  type: LabelBundle['type']
): void => {
  const apiName = row[apiNameField];
  const label = labelField ? row[labelField] : apiName;
  labels[row.Id as string] = {
    id: row.Id as string,
    ...(apiName ? { apiName } : {}),
    ...(label ? { label } : {}),
    type,
  };
};

type ResolveByIdOrNameOptions = {
  conn: Connection;
  table: string;
  idOrNameRefs: Set<string>;
  nameField: string;
  whereClause?: string;
  warnings: string[];
  idPrefixes?: string[];
  labelField?: string;
  type: LabelBundle['type'];
  labels: LabelMap;
};

const resolveByIdOrName = async ({
  conn,
  table,
  idOrNameRefs,
  nameField,
  whereClause,
  warnings,
  idPrefixes,
  labelField,
  type,
  labels,
}: ResolveByIdOrNameOptions): Promise<Map<string, string>> => {
  const resolved = new Map<string, string>();
  const fields = ['Id', nameField, labelField].filter((field): field is string => Boolean(field));
  const ids = [...idOrNameRefs].filter(
    (ref) => isSalesforceId(ref) && (!idPrefixes || idPrefixes.includes(ref.slice(0, 3)))
  );
  const names = [...idOrNameRefs].filter((ref) => !isSalesforceId(ref));
  if (ids.length > 0) {
    const where = [`Id IN (${soqlIn(ids)})`, whereClause].filter(Boolean).join(' AND ');
    const rows = (
      await conn.query<Record<string, string | undefined>>(`SELECT ${fields.join(', ')} FROM ${table} WHERE ${where}`)
    ).records;
    for (const row of rows) {
      resolved.set(row.Id as string, row.Id as string);
      addReferenceLabel(labels, row, nameField, labelField, type);
    }
  }
  if (names.length > 0) {
    const where = [`${nameField} IN (${soqlIn(names)})`, whereClause].filter(Boolean).join(' AND ');
    const rows = (
      await conn.query<Record<string, string | undefined>>(`SELECT ${fields.join(', ')} FROM ${table} WHERE ${where}`)
    ).records;
    for (const row of rows) {
      resolved.set(row[nameField] as string, row.Id as string);
      addReferenceLabel(labels, row, nameField, labelField, type);
    }
  }
  for (const ref of idOrNameRefs) {
    if (!resolved.has(ref)) warnings.push(messages.getMessage('warningReferenceMissing', [table, ref]));
  }
  return resolved;
};

const resolveByRoleRef = async (
  conn: Connection,
  refs: Set<string>,
  warnings: string[],
  labels: LabelMap
): Promise<Map<string, string>> => {
  const resolved = new Map<string, string>();
  const ids = [...refs].filter((ref) => isSalesforceId(ref) && ref.startsWith('00E'));
  const names = [...refs].filter((ref) => !isSalesforceId(ref));
  if (ids.length > 0) {
    const rows = (
      await conn.query<Record<string, string | undefined>>(
        `SELECT Id, DeveloperName, Name FROM UserRole WHERE Id IN (${soqlIn(ids)})`
      )
    ).records;
    for (const row of rows) {
      resolved.set(row.Id as string, row.Id as string);
      addReferenceLabel(labels, row, 'DeveloperName', 'Name', 'UserRole');
    }
  }
  if (names.length > 0) {
    const rows = (
      await conn.query<Record<string, string | undefined>>(
        `SELECT Id, DeveloperName, Name FROM UserRole WHERE DeveloperName IN (${soqlIn(names)}) OR Name IN (${soqlIn(
          names
        )})`
      )
    ).records;
    for (const row of rows) {
      if (row.DeveloperName && names.includes(row.DeveloperName)) resolved.set(row.DeveloperName, row.Id as string);
      if (row.Name && names.includes(row.Name)) resolved.set(row.Name, row.Id as string);
      addReferenceLabel(labels, row, 'DeveloperName', 'Name', 'UserRole');
    }
  }
  for (const ref of refs) {
    if (!resolved.has(ref)) warnings.push(messages.getMessage('warningReferenceMissing', ['UserRole', ref]));
  }
  return resolved;
};

export const resolveReferences = async (
  conn: Connection,
  personas: Record<string, PersonaDefinition>,
  users: CanonicalizedUser[]
): Promise<ResolvedRefs> => {
  const warnings: string[] = [];
  const labels: LabelMap = {};
  const refs = collectPersonaRefs(personas);
  for (const user of users) {
    if (user.profileRef) refs.profiles.add(user.profileRef);
    if (user.roleRef) refs.roles.add(user.roleRef);
  }
  const [
    profilesByRef,
    rolesByRef,
    permissionSetIdsByRef,
    permissionSetGroupIdsByRef,
    publicGroupIdsByRef,
    queueIdsByRef,
  ] = await Promise.all([
    resolveByIdOrName({
      conn,
      table: 'Profile',
      idOrNameRefs: refs.profiles,
      nameField: 'Name',
      warnings,
      idPrefixes: ['00e'],
      type: 'Profile',
      labels,
    }),
    resolveByRoleRef(conn, refs.roles, warnings, labels),
    resolveByIdOrName({
      conn,
      table: 'PermissionSet',
      idOrNameRefs: refs.permissionSets,
      nameField: 'Name',
      warnings,
      idPrefixes: ['0PS'],
      labelField: 'Label',
      type: 'PermissionSet',
      labels,
    }),
    resolveByIdOrName({
      conn,
      table: 'PermissionSetGroup',
      idOrNameRefs: refs.permissionSetGroups,
      nameField: 'DeveloperName',
      warnings,
      idPrefixes: ['0PG'],
      labelField: 'MasterLabel',
      type: 'PermissionSetGroup',
      labels,
    }),
    resolveByIdOrName({
      conn,
      table: 'Group',
      idOrNameRefs: refs.publicGroups,
      nameField: 'DeveloperName',
      whereClause: "Type = 'Regular'",
      warnings,
      idPrefixes: ['00G'],
      labelField: 'Name',
      type: 'PublicGroup',
      labels,
    }),
    resolveByIdOrName({
      conn,
      table: 'Group',
      idOrNameRefs: refs.queues,
      nameField: 'DeveloperName',
      whereClause: "Type = 'Queue'",
      warnings,
      idPrefixes: ['00G'],
      labelField: 'Name',
      type: 'Queue',
      labels,
    }),
  ]);
  return {
    profilesByRef,
    rolesByRef,
    permissionSetIdsByRef,
    permissionSetGroupIdsByRef,
    publicGroupIdsByRef,
    queueIdsByRef,
    labels,
    warnings,
  };
};
