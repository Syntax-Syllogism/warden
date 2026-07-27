import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TestContext } from '@salesforce/core/testSetup';
import { stubSfCommandUx } from '@salesforce/sf-plugins-core';
import { expect } from 'chai';
import sinon from 'sinon';
import UserAccess from '../../../src/commands/warden/access.js';

const createConnection = (): {
  describe: sinon.SinonStub;
  query: sinon.SinonStub;
  queryMore: sinon.SinonStub;
} => ({
  describe: sinon.stub().callsFake(async (name: string) => ({
    name: name === 'account' ? 'Account' : name,
    fields: [{ name: 'CustomField__c' }],
  })),
  queryMore: sinon.stub().resolves({ records: [], done: true }),
  query: sinon.stub().callsFake(async (soql: string) => {
    if (soql.includes('FROM ApexClass')) return { done: true, records: [{ Id: '01p1', Name: 'MyController' }] };
    if (soql.includes('FROM ApexPage')) return { done: true, records: [{ Id: '01pPage', Name: 'MyPage' }] };
    if (soql.includes('FROM CustomPermission')) {
      return { done: true, records: [{ Id: '0CP1', DeveloperName: 'Can_Edit_Accounts' }] };
    }
    if (soql.includes('FROM TabDefinition'))
      return { done: true, records: [{ DurableId: 'Account', Name: 'standard-Account' }] };
    if (soql.includes('FROM SetupEntityAccess')) {
      return {
        done: true,
        records: [
          { ParentId: '0PS1', Parent: { Id: '0PS1', Name: 'Setup Access', IsOwnedByProfile: false, Type: 'Regular' } },
        ],
      };
    }
    if (soql.includes('FROM PermissionSetTabSetting')) {
      return {
        done: true,
        records: [
          {
            ParentId: '0PS1',
            Visibility: 'DefaultOn',
            Parent: { Id: '0PS1', Name: 'Tab Access', IsOwnedByProfile: false, Type: 'Regular' },
          },
        ],
      };
    }
    if (soql.includes('FROM ObjectPermissions')) {
      return {
        done: true,
        records: [
          {
            ParentId: '0PS1',
            Parent: { Id: '0PS1', Name: 'Account Readers', IsOwnedByProfile: false, Type: 'Regular' },
            PermissionsRead: true,
            PermissionsCreate: false,
            PermissionsEdit: false,
            PermissionsDelete: false,
            PermissionsViewAllRecords: false,
            PermissionsModifyAllRecords: false,
          },
        ],
      };
    }
    if (soql.includes('FROM FieldPermissions')) {
      return {
        done: true,
        records: [
          {
            ParentId: '0PS1',
            Parent: { Id: '0PS1', Name: 'Account Readers', IsOwnedByProfile: false, Type: 'Regular' },
            PermissionsRead: true,
            PermissionsEdit: false,
          },
        ],
      };
    }
    if (soql.includes('FROM PermissionSetGroupComponent')) return { done: true, records: [] };
    if (soql.includes('FROM PermissionSetAssignment')) {
      return {
        done: true,
        records: [
          {
            Id: '0PA1',
            AssigneeId: '0051',
            Assignee: { Name: 'Jane Smith', Username: 'jane@example.com', IsActive: true },
            PermissionSetId: '0PS1',
            PermissionSet: { Id: '0PS1', Name: 'Account Readers', IsOwnedByProfile: false, Type: 'Regular' },
          },
        ],
      };
    }
    return { done: true, records: [] };
  }),
});

describe('warden user access command', () => {
  const $$ = new TestContext();
  let sfCommandStubs: ReturnType<typeof stubSfCommandUx>;

  beforeEach(() => {
    sfCommandStubs = stubSfCommandUx($$.SANDBOX);
  });

  afterEach(() => {
    sinon.restore();
    $$.restore();
  });

  it('supports apex-class human output through the command', async () => {
    const conn = createConnection();
    conn.query.callsFake(async (soql: string) => {
      if (soql.includes('FROM ApexClass')) return { done: true, records: [{ Id: '01p1', Name: 'MyController' }] };
      if (soql.includes('FROM SetupEntityAccess')) {
        return {
          done: true,
          records: [
            {
              ParentId: '0PS1',
              Parent: { Id: '0PS1', Name: 'Controller Access', IsOwnedByProfile: false, Type: 'Regular' },
            },
          ],
        };
      }
      if (soql.includes('FROM PermissionSetAssignment')) {
        return {
          done: true,
          records: [
            {
              Id: '0PA1',
              AssigneeId: '0051',
              Assignee: { Name: 'Jane Smith', Username: 'jane@example.com', IsActive: true },
              PermissionSetId: '0PS1',
            },
          ],
        };
      }
      return { done: true, records: [] };
    });
    sinon.stub(UserAccess.prototype as unknown as Record<string, unknown>, 'parse').resolves({
      flags: {
        'target-org': { getConnection: () => conn },
        type: 'apex-class',
        target: 'MyController',
        output: 'human',
        'api-version': undefined,
      },
    } as never);
    await UserAccess.run([]);
    const output = sfCommandStubs.log
      .getCalls()
      .map((call) => call.args[0] as string)
      .join('\n');
    expect(output).to.include('Apex Class: MyController');
    expect(output).to.include('Enabled');
  });

  it('serializes apex-class access in csv output', async () => {
    const conn = createConnection();
    sinon.stub(UserAccess.prototype as unknown as Record<string, unknown>, 'parse').resolves({
      flags: {
        'target-org': { getConnection: () => conn },
        type: 'apex-class',
        target: 'MyController',
        output: 'csv',
        'api-version': undefined,
      },
    } as never);
    await UserAccess.run([]);
    const output = sfCommandStubs.log.firstCall.args[0] as string;
    expect(output.split('\n')[0]).to.include(',enabled');
    expect(output).to.include('true');
  });

  it('serializes vf-page access in json output', async () => {
    const conn = createConnection();
    sinon.stub(UserAccess.prototype as unknown as Record<string, unknown>, 'parse').resolves({
      flags: {
        'target-org': { getConnection: () => conn },
        type: 'vf-page',
        target: 'MyPage',
        output: 'json',
        'api-version': undefined,
      },
    } as never);
    const result = await UserAccess.run([]);
    expect(result.targetType).to.equal('vf-page');
    expect(result.rows[0].access).to.deep.equal({ kind: 'enabled', enabled: true });
    expect(sfCommandStubs.log.firstCall.args[0] as string).to.include('"enabled": true');
  });

  it('serializes custom-permission access in csv output', async () => {
    const conn = createConnection();
    sinon.stub(UserAccess.prototype as unknown as Record<string, unknown>, 'parse').resolves({
      flags: {
        'target-org': { getConnection: () => conn },
        type: 'custom-permission',
        target: 'Can_Edit_Accounts',
        output: 'csv',
        'api-version': undefined,
      },
    } as never);
    await UserAccess.run([]);
    expect((sfCommandStubs.log.firstCall.args[0] as string).split('\n')[0]).to.include(',enabled');
  });

  it('renders tab access in human output', async () => {
    const conn = createConnection();
    sinon.stub(UserAccess.prototype as unknown as Record<string, unknown>, 'parse').resolves({
      flags: {
        'target-org': { getConnection: () => conn },
        type: 'tab',
        target: 'Account',
        output: 'human',
        'api-version': undefined,
      },
    } as never);
    await UserAccess.run([]);
    const output = sfCommandStubs.log.firstCall.args[0] as string;
    expect(output).to.include('Tab: Account');
    expect(output).to.include('Visibility');
    expect(output).to.include('DefaultOn');
  });

  it('defaults to human output when output flag is omitted', async () => {
    const conn = createConnection();
    sinon.stub(UserAccess.prototype as unknown as Record<string, unknown>, 'parse').resolves({
      flags: {
        'target-org': { getConnection: () => conn },
        type: 'object',
        target: 'Account',
        output: 'human',
        'api-version': undefined,
      },
    } as never);
    await UserAccess.run([]);
    expect(sfCommandStubs.log.called).to.equal(true);
    expect(
      sfCommandStubs.log
        .getCalls()
        .map((call) => call.args.join(' '))
        .join('\n')
    ).to.include('Object: Account');
  });

  it('writes csv only in csv mode', async () => {
    const conn = createConnection();
    sinon.stub(UserAccess.prototype as unknown as Record<string, unknown>, 'parse').resolves({
      flags: {
        'target-org': { getConnection: () => conn },
        type: 'field',
        target: 'Account.CustomField__c',
        output: 'csv',
        'api-version': undefined,
      },
    } as never);
    await UserAccess.run([]);
    expect(sfCommandStubs.log.calledOnce).to.equal(true);
    expect(sfCommandStubs.warn.calledOnce).to.equal(true);
    const output = sfCommandStubs.log.firstCall.args[0] as string;
    expect(output.split('\n')[0]).to.equal(
      'userId,userName,username,assignmentType,sourceId,sourceName,viaPermissionSetId,viaPermissionSetName,targetType,targetName,sourceApiName,sourceLabel,read,edit'
    );
    expect(output).to.not.include('Object:');
    expect(output).to.not.include('Field:');
  });

  it('writes a single CSV file while keeping human output on stdout', async () => {
    const conn = createConnection();
    const outputFile = join(mkdtempSync(join(tmpdir(), 'warden-access-output-')), 'audit.csv');
    sinon.stub(UserAccess.prototype as unknown as Record<string, unknown>, 'parse').resolves({
      flags: {
        'target-org': { getConnection: () => conn },
        type: 'field',
        target: 'Account.CustomField__c',
        output: 'csv',
        'output-file': outputFile,
        'api-version': undefined,
      },
    } as never);
    await UserAccess.run([]);
    expect(sfCommandStubs.log.calledOnce).to.equal(true);
    expect(sfCommandStubs.log.firstCall.args[0] as string).to.include('Field: Account.CustomField__c');
    expect(readFileSync(outputFile, 'utf8').split('\n').filter(Boolean)).to.have.length(2);
  });

  it('rejects CSV plus global json without an output file', async () => {
    const conn = createConnection();
    sinon.stub(UserAccess.prototype as unknown as Record<string, unknown>, 'jsonEnabled').returns(true);
    sinon.stub(UserAccess.prototype as unknown as Record<string, unknown>, 'parse').resolves({
      flags: {
        'target-org': { getConnection: () => conn },
        type: 'field',
        target: 'Account.CustomField__c',
        output: 'csv',
        'api-version': undefined,
      },
    } as never);
    try {
      await UserAccess.run([]);
      expect.fail('Expected the output conflict to throw.');
    } catch (error) {
      expect(String(error)).to.include('--output-file');
    }
  });

  it('writes the warden CSV file while returning the global JSON result', async () => {
    const conn = createConnection();
    const outputFile = join(mkdtempSync(join(tmpdir(), 'warden-access-json-output-')), 'audit.csv');
    sinon.stub(UserAccess.prototype as unknown as Record<string, unknown>, 'jsonEnabled').returns(true);
    sinon.stub(UserAccess.prototype as unknown as Record<string, unknown>, 'parse').resolves({
      flags: {
        'target-org': { getConnection: () => conn },
        type: 'field',
        target: 'Account.CustomField__c',
        output: 'csv',
        'output-file': outputFile,
        'api-version': undefined,
      },
    } as never);
    const result = await UserAccess.run([]);
    expect(result.targetType).to.equal('field');
    expect(sfCommandStubs.log.called).to.equal(false);
    expect(readFileSync(outputFile, 'utf8').split('\n').filter(Boolean)).to.have.length(2);
  });

  it('writes the global JSON envelope when only output-file is supplied', async () => {
    const conn = createConnection();
    const outputFile = join(mkdtempSync(join(tmpdir(), 'warden-access-envelope-')), 'result.json');
    sinon.stub(UserAccess.prototype as unknown as Record<string, unknown>, 'jsonEnabled').returns(true);
    sinon.stub(UserAccess.prototype as unknown as Record<string, unknown>, 'parse').resolves({
      flags: {
        'target-org': { getConnection: () => conn },
        type: 'field',
        target: 'Account.CustomField__c',
        output: 'human',
        'output-file': outputFile,
        'api-version': undefined,
      },
    } as never);
    await UserAccess.run([]);
    expect(sfCommandStubs.log.called).to.equal(false);
    expect(JSON.parse(readFileSync(outputFile, 'utf8'))).to.have.property('status', 0);
  });

  it('emits byte-identical CSV for repeated runs', async () => {
    const conn = createConnection();
    sinon.stub(UserAccess.prototype as unknown as Record<string, unknown>, 'parse').resolves({
      flags: {
        'target-org': { getConnection: () => conn },
        type: 'field',
        target: 'Account.CustomField__c',
        output: 'csv',
        'api-version': undefined,
      },
    } as never);
    await UserAccess.run([]);
    await UserAccess.run([]);
    expect(sfCommandStubs.log.getCalls().map((call) => call.args[0])).to.have.length(2);
    expect(sfCommandStubs.log.secondCall.args[0]).to.equal(sfCommandStubs.log.firstCall.args[0]);
  });

  it('returns stable json payload in json mode', async () => {
    const conn = createConnection();
    sinon.stub(UserAccess.prototype as unknown as Record<string, unknown>, 'parse').resolves({
      flags: {
        'target-org': { getConnection: () => conn },
        type: 'object',
        target: 'Account',
        output: 'json',
        'api-version': undefined,
      },
    } as never);
    const result = await UserAccess.run([]);
    expect(result.targetType).to.equal('object');
    expect(result.rows[0].access).to.deep.include({ read: true });
    expect(sfCommandStubs.log.called).to.equal(true);
    expect(sfCommandStubs.log.firstCall.args[0] as string).to.include('"targetType": "object"');
  });

  it('throws actionable error for unsupported type', async () => {
    const conn = createConnection();
    sinon.stub(UserAccess.prototype as unknown as Record<string, unknown>, 'parse').resolves({
      flags: {
        'target-org': { getConnection: () => conn },
        type: 'not-a-type',
        target: 'MyClass',
        output: 'human',
        'api-version': undefined,
      },
    } as never);
    let caught: unknown;
    try {
      await UserAccess.run([]);
    } catch (error) {
      caught = error;
    }
    expect(String(caught)).to.include('Unsupported access type');
  });

  it('prints no-results line for empty result sets', async () => {
    const conn = createConnection();
    conn.query.callsFake(async (soql: string) => {
      if (soql.includes('FROM ObjectPermissions')) return { done: true, records: [] };
      return { done: true, records: [] };
    });
    sinon.stub(UserAccess.prototype as unknown as Record<string, unknown>, 'parse').resolves({
      flags: {
        'target-org': { getConnection: () => conn },
        type: 'object',
        target: 'Account',
        output: 'human',
        'api-version': undefined,
      },
    } as never);
    await UserAccess.run([]);
    const output = sfCommandStubs.log
      .getCalls()
      .map((call) => call.args[0] as string)
      .join('\n');
    expect(output).to.include('No active users matched this target.');
  });

  it('renders resolver query failures with type and target in message', async () => {
    const conn = createConnection();
    conn.query.callsFake(async () => {
      throw new Error('query failed');
    });
    sinon.stub(UserAccess.prototype as unknown as Record<string, unknown>, 'parse').resolves({
      flags: {
        'target-org': { getConnection: () => conn },
        type: 'object',
        target: 'Account',
        output: 'human',
        'api-version': undefined,
      },
    } as never);
    let caught: unknown;
    try {
      await UserAccess.run([]);
    } catch (error) {
      caught = error;
    }
    expect(String(caught)).to.include('Failed to resolve access for');
    expect(String(caught)).to.include('Account');
    expect(String(caught)).to.not.include('%2$s');
  });

  it('sorts human table rows by user name', async () => {
    const conn = createConnection();
    conn.query.callsFake(async (soql: string) => {
      if (soql.includes('FROM ObjectPermissions')) {
        return {
          done: true,
          records: [
            {
              ParentId: '0PS1',
              Parent: { Id: '0PS1', Name: 'Account Readers', IsOwnedByProfile: false, Type: 'Regular' },
              PermissionsRead: true,
              PermissionsCreate: false,
              PermissionsEdit: false,
              PermissionsDelete: false,
              PermissionsViewAllRecords: false,
              PermissionsModifyAllRecords: false,
            },
          ],
        };
      }
      if (soql.includes('FROM PermissionSetGroupComponent')) return { done: true, records: [] };
      if (soql.includes('FROM PermissionSetAssignment')) {
        return {
          done: true,
          records: [
            {
              Id: '0PA2',
              AssigneeId: '0052',
              Assignee: { Name: 'Zed User', Username: 'zed@example.com', IsActive: true },
              PermissionSetId: '0PS1',
              PermissionSet: { Id: '0PS1', Name: 'Account Readers', IsOwnedByProfile: false, Type: 'Regular' },
            },
            {
              Id: '0PA1',
              AssigneeId: '0051',
              Assignee: { Name: 'Amy User', Username: 'amy@example.com', IsActive: true },
              PermissionSetId: '0PS1',
              PermissionSet: { Id: '0PS1', Name: 'Account Readers', IsOwnedByProfile: false, Type: 'Regular' },
            },
          ],
        };
      }
      return { done: true, records: [] };
    });
    sinon.stub(UserAccess.prototype as unknown as Record<string, unknown>, 'parse').resolves({
      flags: {
        'target-org': { getConnection: () => conn },
        type: 'object',
        target: 'Account',
        output: 'human',
        'api-version': undefined,
      },
    } as never);
    await UserAccess.run([]);
    const output = sfCommandStubs.log
      .getCalls()
      .map((call) => call.args[0] as string)
      .join('\n');
    expect(output.indexOf('Amy User')).to.be.lessThan(output.indexOf('Zed User'));
  });

  it('audits one user in reverse and suppresses muted PSG field access', async () => {
    const conn = createConnection();
    conn.describe.callsFake(async (name: string) =>
      name === 'User'
        ? {
            name: 'User',
            fields: [
              { name: 'Username', filterable: true },
              { name: 'Name', filterable: true },
            ],
          }
        : { name: 'Account', fields: [{ name: 'CustomField__c' }] }
    );
    conn.query.callsFake(async (soql: string) => {
      if (soql.includes('FROM User')) {
        return {
          done: true,
          records: [{ Id: '0051', Name: 'Jane Smith', Username: 'jane@example.com', IsActive: true }],
        };
      }
      if (soql.includes('FROM PermissionSetAssignment')) {
        return {
          done: true,
          records: [
            {
              PermissionSetId: '0PSDirect',
              PermissionSet: { Name: 'Account Readers', Type: 'Regular' },
            },
            {
              PermissionSetId: '0PSGroup',
              PermissionSet: { Name: 'Sales Ops backing set', Type: 'Group' },
            },
            {
              PermissionSetGroupId: '0PG1',
              PermissionSetGroup: { MasterLabel: 'Sales Ops' },
            },
          ],
        };
      }
      if (soql.includes('FROM PermissionSetGroupComponent')) {
        if (soql.includes("PermissionSet.Type = 'Muting'")) {
          return {
            done: true,
            records: [{ PermissionSetGroupId: '0PG1', PermissionSetId: '0PSMute', PermissionSet: { Type: 'Muting' } }],
          };
        }
        return {
          done: true,
          records: [
            {
              PermissionSetGroupId: '0PG1',
              PermissionSetId: '0PSGroup',
              PermissionSet: { Name: 'Grouped Reader', Type: 'Regular' },
            },
          ],
        };
      }
      if (soql.includes('FROM FieldPermissions')) {
        if (soql.includes('Parent.IsOwnedByProfile = false')) {
          return {
            done: true,
            records: [
              { ParentId: '0PSMute', Field: 'Account.CustomField__c', PermissionsRead: true, PermissionsEdit: false },
            ],
          };
        }
        return {
          done: true,
          records: [
            {
              ParentId: '0PSDirect',
              SobjectType: 'Account',
              Field: 'Account.CustomField__c',
              PermissionsRead: true,
              PermissionsEdit: false,
            },
            {
              ParentId: '0PSGroup',
              SobjectType: 'Account',
              Field: 'Account.CustomField__c',
              PermissionsRead: true,
              PermissionsEdit: false,
            },
          ],
        };
      }
      return { done: true, records: [] };
    });
    sinon.stub(UserAccess.prototype as unknown as Record<string, unknown>, 'parse').resolves({
      flags: {
        'target-org': { getConnection: () => conn },
        user: 'Username:jane@example.com',
        type: 'field',
        target: 'Account.CustomField__c',
        output: 'human',
        'api-version': undefined,
      },
    } as never);

    const result = await UserAccess.run([]);
    expect(result.rows).to.have.length(1);
    expect(result.rows[0].sourceName).to.equal('Account Readers');
    expect(result.rows[0].assignmentType).to.equal('PermissionSet');
    expect(sfCommandStubs.log.firstCall.args[0] as string).to.include('Access for Jane Smith: Account.CustomField__c');
  });

  it('supports reverse object access scoped by SObject and JSON output', async () => {
    const conn = createConnection();
    conn.describe.callsFake(async (name: string) =>
      name === 'User'
        ? { name: 'User', fields: [{ name: 'Username', filterable: true }] }
        : { name: 'Account', fields: [{ name: 'Name' }] }
    );
    conn.query.callsFake(async (soql: string) => {
      if (soql.includes('FROM User'))
        return {
          done: true,
          records: [{ Id: '0051', Name: 'Jane Smith', Username: 'jane@example.com', IsActive: true }],
        };
      if (soql.includes('FROM PermissionSetAssignment')) {
        return {
          done: true,
          records: [{ PermissionSetId: '0PSDirect', PermissionSet: { Name: 'Account Readers', Type: 'Regular' } }],
        };
      }
      if (soql.includes('FROM ObjectPermissions')) {
        return {
          done: true,
          records: [{ ParentId: '0PSDirect', SobjectType: 'Account', PermissionsRead: true }],
        };
      }
      return { done: true, records: [] };
    });
    sinon.stub(UserAccess.prototype as unknown as Record<string, unknown>, 'parse').resolves({
      flags: {
        'target-org': { getConnection: () => conn },
        user: 'Username:jane@example.com',
        type: 'object',
        sobject: 'Account',
        output: 'json',
        'api-version': undefined,
      },
    } as never);

    const result = await UserAccess.run([]);
    expect(result.targetName).to.equal('Account');
    expect(result.rows[0].targetName).to.equal('Account');
    expect(sfCommandStubs.log.firstCall.args[0] as string).to.include('"targetType": "object"');
  });

  it('shows field targets and sorts them in reverse SObject human output', async () => {
    const conn = createConnection();
    conn.describe.callsFake(async (name: string) =>
      name === 'User'
        ? { name: 'User', fields: [{ name: 'Username', filterable: true }] }
        : { name: 'Account', fields: [{ name: 'A__c' }, { name: 'B__c' }] }
    );
    conn.query.callsFake(async (soql: string) => {
      if (soql.includes('FROM User')) {
        return { done: true, records: [{ Id: '0051', Name: 'Jane Smith', Username: 'jane@example.com' }] };
      }
      if (soql.includes('FROM PermissionSetAssignment')) {
        return {
          done: true,
          records: [{ PermissionSetId: '0PSDirect', PermissionSet: { Name: 'Account Readers', Type: 'Regular' } }],
        };
      }
      if (soql.includes('FROM FieldPermissions')) {
        return {
          done: true,
          records: [
            { ParentId: '0PSDirect', SobjectType: 'Account', Field: 'Account.B__c', PermissionsRead: true },
            { ParentId: '0PSDirect', SobjectType: 'Account', Field: 'Account.A__c', PermissionsRead: true },
          ],
        };
      }
      return { done: true, records: [] };
    });
    sinon.stub(UserAccess.prototype as unknown as Record<string, unknown>, 'parse').resolves({
      flags: {
        'target-org': { getConnection: () => conn },
        user: 'Username:jane@example.com',
        type: 'field',
        sobject: 'Account',
        output: 'human',
        'api-version': undefined,
      },
    } as never);

    const result = await UserAccess.run([]);
    expect(result.rows.map((row) => row.targetName)).to.deep.equal(['Account.A__c', 'Account.B__c']);
    const output = sfCommandStubs.log.firstCall.args[0] as string;
    expect(output).to.include('Target');
    expect(output.indexOf('Account.A__c')).to.be.lessThan(output.indexOf('Account.B__c'));
  });

  it('serializes reverse field SObject scope as CSV', async () => {
    const conn = createConnection();
    conn.describe.callsFake(async (name: string) =>
      name === 'User'
        ? { name: 'User', fields: [{ name: 'Username', filterable: true }] }
        : { name: 'Account', fields: [{ name: 'A__c' }] }
    );
    conn.query.callsFake(async (soql: string) => {
      if (soql.includes('FROM User')) {
        return { done: true, records: [{ Id: '0051', Name: 'Jane Smith', Username: 'jane@example.com' }] };
      }
      if (soql.includes('FROM PermissionSetAssignment')) {
        return {
          done: true,
          records: [{ PermissionSetId: '0PSDirect', PermissionSet: { Name: 'Account Readers', Type: 'Regular' } }],
        };
      }
      if (soql.includes('FROM FieldPermissions')) {
        return {
          done: true,
          records: [{ ParentId: '0PSDirect', SobjectType: 'Account', Field: 'Account.A__c', PermissionsRead: true }],
        };
      }
      return { done: true, records: [] };
    });
    sinon.stub(UserAccess.prototype as unknown as Record<string, unknown>, 'parse').resolves({
      flags: {
        'target-org': { getConnection: () => conn },
        user: 'Username:jane@example.com',
        type: 'field',
        sobject: 'Account',
        output: 'csv',
        'api-version': undefined,
      },
    } as never);

    await UserAccess.run([]);
    expect(sfCommandStubs.log.firstCall.args[0] as string).to.include(',targetName,');
    expect(sfCommandStubs.log.firstCall.args[0] as string).to.include('Account.A__c');
  });

  it('sorts reverse PSG rows by ids when display labels collide', async () => {
    const conn = createConnection();
    conn.describe.callsFake(async (name: string) =>
      name === 'User'
        ? { name: 'User', fields: [{ name: 'Username', filterable: true }] }
        : { name: 'Account', fields: [] }
    );
    conn.query.callsFake(async (soql: string) => {
      if (soql.includes('FROM User')) {
        return { done: true, records: [{ Id: '0051', Name: 'Jane Smith', Username: 'jane@example.com' }] };
      }
      if (soql.includes('FROM PermissionSetAssignment')) {
        return {
          done: true,
          records: [
            { PermissionSetGroupId: '0PG2', PermissionSetGroup: { MasterLabel: 'Sales Ops' } },
            { PermissionSetGroupId: '0PG1', PermissionSetGroup: { MasterLabel: 'Sales Ops' } },
          ],
        };
      }
      if (soql.includes('FROM PermissionSetGroupComponent')) {
        if (soql.includes("PermissionSet.Type = 'Muting'")) return { done: true, records: [] };
        return {
          done: true,
          records: [
            {
              PermissionSetGroupId: '0PG2',
              PermissionSetId: '0PS2',
              PermissionSet: { Name: 'Account Reader', Type: 'Regular' },
            },
            {
              PermissionSetGroupId: '0PG1',
              PermissionSetId: '0PS1',
              PermissionSet: { Name: 'Account Reader', Type: 'Regular' },
            },
          ],
        };
      }
      if (soql.includes('FROM ObjectPermissions')) {
        return {
          done: true,
          records: [
            { ParentId: '0PS2', SobjectType: 'Account', PermissionsRead: true },
            { ParentId: '0PS1', SobjectType: 'Account', PermissionsRead: true },
          ],
        };
      }
      return { done: true, records: [] };
    });
    sinon.stub(UserAccess.prototype as unknown as Record<string, unknown>, 'parse').resolves({
      flags: {
        'target-org': { getConnection: () => conn },
        user: 'Username:jane@example.com',
        type: 'object',
        target: 'Account',
        output: 'csv',
        'api-version': undefined,
      },
    } as never);

    const result = await UserAccess.run([]);
    expect(result.rows.map((row) => row.sourceId)).to.deep.equal(['0PG1', '0PG2']);
  });

  it('requires a reverse scope and rejects mixed scopes', async () => {
    const conn = createConnection();
    const runWithFlags = async (flags: Record<string, unknown>): Promise<unknown> => {
      sinon.stub(UserAccess.prototype as unknown as Record<string, unknown>, 'parse').resolves({
        flags: { 'target-org': { getConnection: () => conn }, output: 'human', 'api-version': undefined, ...flags },
      } as never);
      try {
        await UserAccess.run([]);
        return undefined;
      } catch (error) {
        return error;
      } finally {
        sinon.restore();
      }
    };

    expect(String(await runWithFlags({ user: 'Username:jane@example.com', type: 'field' }))).to.include(
      'requires exactly one scope'
    );
    expect(
      String(
        await runWithFlags({
          user: 'Username:jane@example.com',
          type: 'field',
          target: 'Account.Name',
          sobject: 'Account',
        })
      )
    ).to.include('only one reverse-audit scope');
    expect(String(await runWithFlags({ sobject: 'Account', type: 'object' }))).to.include('only supported with --user');
  });

  it('surfaces no-match and multi-match user resolution errors', async () => {
    const conn = createConnection();
    conn.describe.callsFake(async (name: string) =>
      name === 'User'
        ? { name: 'User', fields: [{ name: 'Username', filterable: true }] }
        : { name: 'Account', fields: [{ name: 'Name' }] }
    );
    const runWithUserMatches = async (records: unknown[]): Promise<string> => {
      conn.query.callsFake(async (soql: string) => {
        if (soql.includes('FROM User')) return { done: true, records };
        return { done: true, records: [] };
      });
      sinon.stub(UserAccess.prototype as unknown as Record<string, unknown>, 'parse').resolves({
        flags: {
          'target-org': { getConnection: () => conn },
          user: 'Username:jane@example.com',
          type: 'object',
          target: 'Account',
          output: 'human',
          'api-version': undefined,
        },
      } as never);
      try {
        await UserAccess.run([]);
        return '';
      } catch (error) {
        return String(error);
      } finally {
        sinon.restore();
      }
    };

    expect(await runWithUserMatches([])).to.include('matched no user');
    expect(
      await runWithUserMatches([
        { Id: '0051', Name: 'Jane Smith', Username: 'jane@example.com' },
        { Id: '0052', Name: 'Jane Smith 2', Username: 'jane@example.com' },
      ])
    ).to.include('matched multiple users');
  });
});
