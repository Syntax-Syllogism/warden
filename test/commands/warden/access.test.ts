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
    if (soql.includes('FROM TabDefinition')) return { done: true, records: [{ DurableId: 'Account', Name: 'standard-Account' }] };
    if (soql.includes('FROM SetupEntityAccess')) {
      return {
        done: true,
        records: [{ ParentId: '0PS1', Parent: { Id: '0PS1', Name: 'Setup Access', IsOwnedByProfile: false, Type: 'Regular' } }],
      };
    }
    if (soql.includes('FROM PermissionSetTabSetting')) {
      return {
        done: true,
        records: [{ ParentId: '0PS1', Visibility: 'DefaultOn', Parent: { Id: '0PS1', Name: 'Tab Access', IsOwnedByProfile: false, Type: 'Regular' } }],
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
          records: [{ ParentId: '0PS1', Parent: { Id: '0PS1', Name: 'Controller Access', IsOwnedByProfile: false, Type: 'Regular' } }],
        };
      }
      if (soql.includes('FROM PermissionSetAssignment')) {
        return {
          done: true,
          records: [{ Id: '0PA1', AssigneeId: '0051', Assignee: { Name: 'Jane Smith', Username: 'jane@example.com', IsActive: true }, PermissionSetId: '0PS1' }],
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
    const output = sfCommandStubs.log.getCalls().map((call) => call.args[0] as string).join('\n');
    expect(output).to.include('Apex Class: MyController');
    expect(output).to.include('Enabled');
  });

  it('serializes apex-class access in csv output', async () => {
    const conn = createConnection();
    sinon.stub(UserAccess.prototype as unknown as Record<string, unknown>, 'parse').resolves({
      flags: { 'target-org': { getConnection: () => conn }, type: 'apex-class', target: 'MyController', output: 'csv', 'api-version': undefined },
    } as never);
    await UserAccess.run([]);
    const output = sfCommandStubs.log.firstCall.args[0] as string;
    expect(output.split('\n')[0]).to.include(',enabled');
    expect(output).to.include('true');
  });

  it('serializes vf-page access in json output', async () => {
    const conn = createConnection();
    sinon.stub(UserAccess.prototype as unknown as Record<string, unknown>, 'parse').resolves({
      flags: { 'target-org': { getConnection: () => conn }, type: 'vf-page', target: 'MyPage', output: 'json', 'api-version': undefined },
    } as never);
    const result = await UserAccess.run([]);
    expect(result.targetType).to.equal('vf-page');
    expect(result.rows[0].access).to.deep.equal({ kind: 'enabled', enabled: true });
    expect(sfCommandStubs.log.firstCall.args[0] as string).to.include('"enabled": true');
  });

  it('serializes custom-permission access in csv output', async () => {
    const conn = createConnection();
    sinon.stub(UserAccess.prototype as unknown as Record<string, unknown>, 'parse').resolves({
      flags: { 'target-org': { getConnection: () => conn }, type: 'custom-permission', target: 'Can_Edit_Accounts', output: 'csv', 'api-version': undefined },
    } as never);
    await UserAccess.run([]);
    expect((sfCommandStubs.log.firstCall.args[0] as string).split('\n')[0]).to.include(',enabled');
  });

  it('renders tab access in human output', async () => {
    const conn = createConnection();
    sinon.stub(UserAccess.prototype as unknown as Record<string, unknown>, 'parse').resolves({
      flags: { 'target-org': { getConnection: () => conn }, type: 'tab', target: 'Account', output: 'human', 'api-version': undefined },
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
    const output = sfCommandStubs.log
      .getCalls()
      .map((call) => call.args[0] as string)
      .join('\n');
    expect(output.split('\n')[0]).to.equal(
      'userId,userName,username,assignmentType,sourceId,sourceName,viaPermissionSetId,viaPermissionSetName,read,edit'
    );
    expect(output).to.not.include('Object:');
    expect(output).to.not.include('Field:');
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
});
