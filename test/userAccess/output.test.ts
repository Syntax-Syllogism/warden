import { expect } from 'chai';
import {
  enabledCsvColumns,
  fieldCsvColumns,
  objectCsvColumns,
  renderFieldTable,
  renderEnabledTable,
  renderObjectTable,
  renderTabTable,
  flattenAccessRow,
  tabCsvColumns,
} from '../../src/userAccess/output.js';
import type { UserAccessRow } from '../../src/userAccess/types.js';
import { serializeCsv } from '../../src/userShared/csv.js';

const serializeAccessCsv = (rows: UserAccessRow[], columns: string[]): string =>
  serializeCsv(
    rows.map((row) => flattenAccessRow(row, columns)),
    columns
  );

describe('userAccess output', () => {
  it('serializes enabled and tab columns', () => {
    expect(enabledCsvColumns()).to.deep.equal([
      'userId',
      'userName',
      'username',
      'assignmentType',
      'sourceId',
      'sourceName',
      'viaPermissionSetId',
      'viaPermissionSetName',
      'targetType',
      'targetName',
      'sourceApiName',
      'sourceLabel',
      'enabled',
    ]);
    expect(tabCsvColumns()).to.deep.equal([
      'userId',
      'userName',
      'username',
      'assignmentType',
      'sourceId',
      'sourceName',
      'viaPermissionSetId',
      'viaPermissionSetName',
      'targetType',
      'targetName',
      'sourceApiName',
      'sourceLabel',
      'visibility',
    ]);
  });

  it('serializes field csv columns in order', () => {
    expect(fieldCsvColumns()).to.deep.equal([
      'userId',
      'userName',
      'username',
      'assignmentType',
      'sourceId',
      'sourceName',
      'viaPermissionSetId',
      'viaPermissionSetName',
      'targetType',
      'targetName',
      'sourceApiName',
      'sourceLabel',
      'read',
      'edit',
    ]);
  });

  it('serializes object csv columns in order', () => {
    expect(objectCsvColumns()).to.deep.equal([
      'userId',
      'userName',
      'username',
      'assignmentType',
      'sourceId',
      'sourceName',
      'viaPermissionSetId',
      'viaPermissionSetName',
      'targetType',
      'targetName',
      'sourceApiName',
      'sourceLabel',
      'read',
      'create',
      'edit',
      'delete',
      'viewAll',
      'modifyAll',
    ]);
  });

  it('escapes csv values with commas, quotes, and newlines', () => {
    const rows: UserAccessRow[] = [
      {
        userId: '005xx',
        userName: 'Doe, "Jane"',
        username: 'jane@example.com',
        targetType: 'field',
        targetName: 'Account.CustomField__c',
        assignmentType: 'PermissionSet',
        sourceId: '0PSxx',
        sourceName: 'Line\nBreak',
        viaPermissionSetId: undefined,
        viaPermissionSetName: undefined,
        access: { kind: 'field', read: true, edit: false },
      },
    ];
    const csv = serializeAccessCsv(rows, fieldCsvColumns());
    expect(csv).to.include('"Doe, ""Jane"""');
    expect(csv).to.include('"Line\nBreak"');
  });

  it('renders human field table and via labels', () => {
    const rows: UserAccessRow[] = [
      {
        userId: '005xx',
        userName: 'Jane',
        username: 'jane@example.com',
        targetType: 'field',
        targetName: 'Account.CustomField__c',
        assignmentType: 'Profile',
        sourceId: '00e1',
        sourceName: 'Sales User',
        access: { kind: 'field', read: true, edit: false },
      },
      {
        userId: '005yy',
        userName: 'Alex',
        username: 'alex@example.com',
        targetType: 'field',
        targetName: 'Account.CustomField__c',
        assignmentType: 'PermissionSetGroup',
        sourceId: '0PG1',
        sourceName: 'Sales Ops',
        viaPermissionSetId: '0PS1',
        viaPermissionSetName: 'Account Editors',
        access: { kind: 'field', read: true, edit: true },
      },
    ];
    const rendered = renderFieldTable(rows);
    expect(rendered).to.include('Profile: Sales User');
    expect(rendered).to.include('PSG: Sales Ops / PS: Account Editors');
  });

  it('renders human object table with Y/N columns', () => {
    const rows: UserAccessRow[] = [
      {
        userId: '005zz',
        userName: 'Sam',
        username: 'sam@example.com',
        targetType: 'object',
        targetName: 'Account',
        assignmentType: 'PermissionSetGroup',
        sourceId: '0PG2',
        sourceName: 'Ops',
        access: {
          kind: 'object',
          read: true,
          create: false,
          edit: true,
          delete: false,
          viewAll: false,
          modifyAll: false,
        },
      },
    ];
    const rendered = renderObjectTable(rows);
    expect(rendered).to.include('Y');
    expect(rendered).to.include('N');
    expect(rendered).to.include('PSG: Ops');
  });

  it('renders enabled and tab tables and serializes access values', () => {
    const enabledRow: UserAccessRow = {
      userId: '005e',
      userName: 'Ed',
      username: 'ed@example.com',
      targetType: 'apex-class',
      targetName: 'MyClass',
      assignmentType: 'PermissionSet',
      sourceId: '0PSe',
      sourceName: 'Class Access',
      access: { kind: 'enabled', enabled: true },
    };
    expect(renderEnabledTable([enabledRow])).to.include('yes');
    expect(serializeAccessCsv([enabledRow], enabledCsvColumns())).to.include('true');

    const tabRow: UserAccessRow = {
      ...enabledRow,
      targetType: 'tab',
      targetName: 'Account',
      access: { kind: 'tab', visibility: 'DefaultOn' },
    };
    expect(renderTabTable([tabRow])).to.include('DefaultOn');
    expect(serializeAccessCsv([tabRow], tabCsvColumns())).to.include('DefaultOn');
  });
});
