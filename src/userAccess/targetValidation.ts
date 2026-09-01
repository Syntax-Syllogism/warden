import type { Connection } from '@salesforce/core';
import { esc, queryAll } from './soql.js';
import { UserAccessError, type ValidatedAccessTarget } from './types.js';

type FieldDescribe = { name: string };
type SObjectDescribe = { name: string; fields: FieldDescribe[] };

type SetupEntityDefinition = {
  objectName: string;
  nameField: 'Name' | 'DeveloperName';
  notFoundCode: 'errorApexClassNotFound' | 'errorVisualforcePageNotFound' | 'errorCustomPermissionNotFound';
};

type RecordTypeRow = {
  Id: string;
  SobjectType?: string;
  DeveloperName?: string;
  Name?: string;
  IsActive?: boolean;
};

const setupEntityDefinitions: Record<string, SetupEntityDefinition> = {
  'apex-class': { objectName: 'ApexClass', nameField: 'Name', notFoundCode: 'errorApexClassNotFound' },
  'vf-page': { objectName: 'ApexPage', nameField: 'Name', notFoundCode: 'errorVisualforcePageNotFound' },
  'custom-permission': {
    objectName: 'CustomPermission',
    nameField: 'DeveloperName',
    notFoundCode: 'errorCustomPermissionNotFound',
  },
};

const describeObject = async (conn: Connection, sobjectType: string): Promise<SObjectDescribe> => {
  try {
    return (await conn.describe(sobjectType)) as SObjectDescribe;
  } catch (error) {
    throw new UserAccessError('errorObjectNotFound', [sobjectType], error);
  }
};

export const validateObjectTarget = async (conn: Connection, target: string): Promise<ValidatedAccessTarget> => {
  const trimmed = target.trim();
  if (!trimmed) throw new UserAccessError('errorInvalidTarget', [target]);
  const describe = await describeObject(conn, trimmed);
  return { type: 'object', targetName: describe.name, sobjectType: describe.name };
};

export const validateFieldTarget = async (conn: Connection, target: string): Promise<ValidatedAccessTarget> => {
  const trimmed = target.trim();
  const parts = trimmed.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new UserAccessError('errorFieldTargetMustBeQualified', [target]);
  }
  const [inputObjectApiName, inputFieldApiName] = parts;
  const describe = await describeObject(conn, inputObjectApiName);
  const fieldMap = new Map<string, string>();
  for (const field of describe.fields) fieldMap.set(field.name.toLowerCase(), field.name);
  const canonicalFieldApiName = fieldMap.get(inputFieldApiName.toLowerCase());
  if (!canonicalFieldApiName) {
    throw new UserAccessError('errorFieldNotFound', [inputObjectApiName, inputFieldApiName]);
  }
  return {
    type: 'field',
    targetName: `${describe.name}.${canonicalFieldApiName}`,
    sobjectType: describe.name,
    fieldApiName: canonicalFieldApiName,
  };
};

export const validateSetupEntityTarget = async (
  conn: Connection,
  type: 'apex-class' | 'vf-page' | 'custom-permission',
  target: string
): Promise<ValidatedAccessTarget> => {
  const trimmed = target.trim();
  if (!trimmed) throw new UserAccessError('errorInvalidTarget', [target]);
  const definition = setupEntityDefinitions[type];
  const rows = await queryAll<{ Id: string; Name?: string; DeveloperName?: string }>(
    conn,
    `SELECT Id, ${definition.nameField} FROM ${definition.objectName} WHERE ${definition.nameField} = '${esc(
      trimmed
    )}' LIMIT 1`
  );
  const row = rows[0];
  if (!row) throw new UserAccessError(definition.notFoundCode, [trimmed]);
  return {
    type,
    targetName: row[definition.nameField] ?? trimmed,
    setupEntityId: row.Id,
  };
};

export const validateTabTarget = async (conn: Connection, target: string): Promise<ValidatedAccessTarget> => {
  const trimmed = target.trim();
  if (!trimmed) throw new UserAccessError('errorInvalidTarget', [target]);
  const rows = await queryAll<{ DurableId?: string; Name?: string }>(
    conn,
    `SELECT DurableId, Name FROM TabDefinition WHERE DurableId = '${esc(trimmed)}' LIMIT 1`
  );
  if (!rows[0]) throw new UserAccessError('errorTabNotFound', [trimmed]);
  return { type: 'tab', targetName: rows[0].DurableId ?? trimmed };
};

export const validateRecordTypeTarget = async (conn: Connection, target: string): Promise<ValidatedAccessTarget> => {
  const trimmed = target.trim();
  const parts = trimmed.split('.');
  if (
    !trimmed ||
    (trimmed.startsWith('012') && !trimmed.includes('.')) ||
    parts.length !== 2 ||
    parts.some((part) => !part)
  ) {
    throw new UserAccessError('errorRecordTypeTargetMustBeQualified', [target]);
  }
  const [inputSobjectType, inputDeveloperName] = parts;
  if (inputDeveloperName.toLowerCase() === 'master') {
    throw new UserAccessError('errorMasterRecordTypeUnsupported', [trimmed]);
  }
  const rows = await queryAll<RecordTypeRow>(
    conn,
    [
      'SELECT Id, SobjectType, DeveloperName, Name, IsActive',
      'FROM RecordType',
      `WHERE SobjectType = '${esc(inputSobjectType)}'`,
      `AND DeveloperName = '${esc(inputDeveloperName)}'`,
      'LIMIT 2',
    ].join(' ')
  );
  if (rows.length === 0) throw new UserAccessError('errorRecordTypeNotFound', [trimmed]);
  if (rows.length > 1) throw new UserAccessError('errorRecordTypeAmbiguous', [trimmed]);
  const row = rows[0];
  if (row.IsActive !== true) throw new UserAccessError('errorRecordTypeInactive', [trimmed]);
  if (!row.SobjectType || !row.DeveloperName || !row.Id) {
    throw new UserAccessError('errorRecordTypeNotFound', [trimmed]);
  }
  return {
    type: 'record-type',
    targetName: `${row.SobjectType}.${row.DeveloperName}`,
    sobjectType: row.SobjectType,
    recordTypeId: row.Id,
  };
};
