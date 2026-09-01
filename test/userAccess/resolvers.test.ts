import { expect } from 'chai';
import sinon from 'sinon';
import { fieldResolver } from '../../src/userAccess/resolvers/field.js';
import { objectResolver } from '../../src/userAccess/resolvers/object.js';
import {
  apexClassResolver,
  customPermissionResolver,
  vfPageResolver,
} from '../../src/userAccess/resolvers/setupEntity.js';
import { tabResolver } from '../../src/userAccess/resolvers/tab.js';
import { recordTypeResolver } from '../../src/userAccess/resolvers/recordType.js';
import { resolveReverseAccess } from '../../src/userAccess/reverse.js';
import type { ValidatedAccessTarget } from '../../src/userAccess/types.js';

type QueryPage = { records: unknown[]; done: boolean; nextRecordsUrl?: string };

const createConn = (queryHandler: (soql: string) => QueryPage, more: Record<string, QueryPage> = {}) =>
  ({
    query: sinon.stub().callsFake(async (soql: string) => queryHandler(soql)),
    queryMore: sinon.stub().callsFake(async (url: string) => more[url]),
    describe: sinon.stub(),
    getApiVersion: sinon.stub().returns('66.0'),
  } as never);

describe('userAccess resolvers', () => {
  it('resolves reverse setup and tab access for direct permission sets', async () => {
    const user = { Id: '005Reverse', name: 'Reverse User', username: 'reverse@example.com' };
    const targets: ValidatedAccessTarget[] = [
      { type: 'apex-class', targetName: 'MyClass', setupEntityId: '01p1' },
      { type: 'vf-page', targetName: 'MyPage', setupEntityId: '0661' },
      { type: 'custom-permission', targetName: 'Can_Edit_Accounts', setupEntityId: '0CP1' },
      { type: 'tab', targetName: 'Account' },
    ];
    for (const target of targets) {
      const conn = createConn((soql) => {
        if (soql.includes('FROM PermissionSetAssignment')) {
          return {
            done: true,
            records: [
              {
                PermissionSetId: '0PSDirect',
                PermissionSet: { Name: 'Reverse Access', Type: 'Regular' },
              },
            ],
          };
        }
        if (target.type === 'tab' && soql.includes('FROM PermissionSetTabSetting')) {
          return { done: true, records: [{ ParentId: '0PSDirect', Name: 'Account', Visibility: 'DefaultOn' }] };
        }
        if (target.type !== 'tab' && soql.includes('FROM SetupEntityAccess')) {
          return { done: true, records: [{ ParentId: '0PSDirect' }] };
        }
        return { done: true, records: [] };
      });
      // eslint-disable-next-line no-await-in-loop
      const result = await resolveReverseAccess(conn, user, target);
      expect(result.rows).to.have.length(1);
      expect(result.rows[0].assignmentType).to.equal('PermissionSet');
      expect(result.rows[0].access.kind).to.equal(target.type === 'tab' ? 'tab' : 'enabled');
    }
  });

  it('resolves SetupEntityAccess grants to profiles, permission sets, and PSGs', async () => {
    const conn = createConn((soql) => {
      if (soql.includes('FROM ApexClass')) return { done: true, records: [{ Id: '01pClass', Name: 'MyClass' }] };
      if (soql.includes('FROM SetupEntityAccess')) {
        return {
          done: true,
          records: [
            {
              ParentId: '0PSProfile',
              Parent: {
                Id: '0PSProfile',
                Name: 'Sales Profile',
                IsOwnedByProfile: true,
                ProfileId: '00e1',
                Profile: { Name: 'Sales User' },
                Type: 'Regular',
              },
            },
            {
              ParentId: '0PSDirect',
              Parent: { Id: '0PSDirect', Name: 'Direct Class Access', IsOwnedByProfile: false, Type: 'Regular' },
            },
            {
              ParentId: '0PSGroupMember',
              Parent: { Id: '0PSGroupMember', Name: 'Group Class Access', IsOwnedByProfile: false, Type: 'Regular' },
            },
          ],
        };
      }
      if (soql.includes('FROM PermissionSetGroupComponent') && soql.includes('PermissionSetId IN')) {
        return {
          done: true,
          records: [
            {
              PermissionSetGroupId: '0PGClass',
              PermissionSetId: '0PSGroupMember',
              PermissionSetGroup: { MasterLabel: 'Class PSG' },
            },
          ],
        };
      }
      if (soql.includes('FROM PermissionSetAssignment')) {
        return {
          done: true,
          records: [
            {
              Id: '0PAProfile',
              AssigneeId: '005Profile',
              Assignee: { Name: 'Profile User', Username: 'profile@example.com', IsActive: true },
              PermissionSetId: '0PSProfile',
            },
            {
              Id: '0PADirect',
              AssigneeId: '005Direct',
              Assignee: { Name: 'Direct User', Username: 'direct@example.com', IsActive: true },
              PermissionSetId: '0PSDirect',
            },
            {
              Id: '0PAInactive',
              AssigneeId: '005Inactive',
              Assignee: { Name: 'Inactive User', Username: 'inactive@example.com', IsActive: false },
              PermissionSetId: '0PSDirect',
            },
            {
              Id: '0PAPsg',
              AssigneeId: '005Psg',
              Assignee: { Name: 'PSG User', Username: 'psg@example.com', IsActive: true },
              PermissionSetGroupId: '0PGClass',
              PermissionSetGroup: { MasterLabel: 'Class PSG' },
            },
          ],
        };
      }
      return { done: true, records: [] };
    });
    const result = await apexClassResolver.resolve(conn, await apexClassResolver.validateTarget(conn, 'MyClass'));
    expect(result.rows.map((row) => row.assignmentType)).to.deep.equal([
      'Profile',
      'PermissionSet',
      'PermissionSetGroup',
    ]);
    expect(result.rows.map((row) => row.userId)).to.not.include('005Inactive');
    expect(result.rows.every((row) => row.access).valueOf()).to.equal(true);
  });

  it('validates each SetupEntityAccess target with a specific not-found error', async () => {
    const conn = createConn(() => ({ done: true, records: [] }));
    for (const [resolver, code] of [
      [apexClassResolver, 'errorApexClassNotFound'],
      [vfPageResolver, 'errorVisualforcePageNotFound'],
      [customPermissionResolver, 'errorCustomPermissionNotFound'],
    ] as const) {
      let caught: unknown;
      try {
        // eslint-disable-next-line no-await-in-loop
        await resolver.validateTarget(conn, 'Missing');
      } catch (error) {
        caught = error;
      }
      expect((caught as { code: string }).code).to.equal(code);
    }
  });

  it('maps tab visibility and warns that profile tab visibility is excluded', async () => {
    const target = await tabResolver.validateTarget(
      createConn((soql) =>
        soql.includes("FROM TabDefinition WHERE DurableId = 'Account'")
          ? { done: true, records: [{ DurableId: 'Account', Name: 'standard-Account' }] }
          : { done: true, records: [] }
      ),
      'Account'
    );
    expect(target.targetName).to.equal('Account');
    const conn = createConn((soql) => {
      if (soql.includes('FROM PermissionSetTabSetting')) {
        return {
          done: true,
          records: [
            {
              ParentId: '0PSTab',
              Visibility: 'DefaultOn',
              Parent: { Id: '0PSTab', Name: 'Tab Access', IsOwnedByProfile: false, Type: 'Regular' },
            },
          ],
        };
      }
      if (soql.includes('FROM PermissionSetAssignment')) {
        return {
          done: true,
          records: [
            {
              Id: '0PATab',
              AssigneeId: '005Tab',
              Assignee: { Name: 'Tab User', Username: 'tab@example.com', IsActive: true },
              PermissionSetId: '0PSTab',
            },
          ],
        };
      }
      return { done: true, records: [] };
    });
    const result = await tabResolver.resolve(conn, target);
    const tabQuery = (conn as unknown as { query: sinon.SinonStub }).query
      .getCalls()
      .map((call) => call.args[0] as string)
      .find((query) => query.includes('FROM PermissionSetTabSetting'));
    expect(tabQuery).to.include("WHERE Name = 'Account'");
    expect(result.rows[0].access).to.deep.equal({ kind: 'tab', visibility: 'DefaultOn' });
    expect(result.warnings[0]).to.include('Profile-level tab visibility');
  });

  it('returns a specific error when a tab target does not exist', async () => {
    let caught: unknown;
    try {
      await tabResolver.validateTarget(
        createConn(() => ({ done: true, records: [] })),
        'MissingTab'
      );
    } catch (error) {
      caught = error;
    }
    expect((caught as { code: string }).code).to.equal('errorTabNotFound');
  });

  it('field resolver keeps standalone access when PSG path is muted', async () => {
    const target: ValidatedAccessTarget = {
      type: 'field',
      targetName: 'Account.CustomField__c',
      sobjectType: 'Account',
      fieldApiName: 'CustomField__c',
    };
    const conn = createConn((soql) => {
      if (soql.includes("FROM FieldPermissions WHERE Parent.IsOwnedByProfile = false AND ParentId IN ('0PSMute1')")) {
        return { done: true, records: [{ ParentId: '0PSMute1', PermissionsRead: true, PermissionsEdit: false }] };
      }
      if (soql.includes('FROM FieldPermissions') && soql.includes("AND Field = 'Account.CustomField__c'")) {
        return {
          done: true,
          records: [
            {
              ParentId: '0PSGrant1',
              Parent: { Id: '0PSGrant1', Name: 'Account Editors', IsOwnedByProfile: false, Type: 'Regular' },
              PermissionsRead: true,
              PermissionsEdit: true,
            },
            {
              ParentId: '0PSGrant2',
              Parent: { Id: '0PSGrant2', Name: 'Account PSG Grant', IsOwnedByProfile: false, Type: 'Regular' },
              PermissionsRead: true,
              PermissionsEdit: false,
            },
          ],
        };
      }
      if (
        soql.includes('FROM PermissionSetGroupComponent') &&
        soql.includes("WHERE PermissionSetId IN ('0PSGrant1','0PSGrant2')")
      ) {
        return {
          done: true,
          records: [
            {
              PermissionSetGroupId: '0PG1',
              PermissionSetId: '0PSGrant2',
              PermissionSetGroup: { MasterLabel: 'Sales Ops' },
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
              AssigneeId: '005U1',
              Assignee: { Name: 'Alex Lee', Username: 'alex@example.com', IsActive: true },
              PermissionSetId: '0PSGrant1',
              PermissionSet: { Id: '0PSGrant1', Name: 'Account Editors', IsOwnedByProfile: false, Type: 'Regular' },
            },
            {
              Id: '0PA2',
              AssigneeId: '005U1',
              Assignee: { Name: 'Alex Lee', Username: 'alex@example.com', IsActive: true },
              PermissionSetGroupId: '0PG1',
              PermissionSetGroup: { MasterLabel: 'Sales Ops' },
            },
          ],
        };
      }
      if (soql.includes("FROM PermissionSetGroupComponent WHERE PermissionSetGroupId IN ('0PG1')")) {
        return {
          done: true,
          records: [{ PermissionSetGroupId: '0PG1', PermissionSetId: '0PSMute1', PermissionSet: { Type: 'Muting' } }],
        };
      }
      return { done: true, records: [] };
    });
    const result = await fieldResolver.resolve(conn, target);
    expect(result.rows.length).to.equal(1);
    expect(result.rows[0].assignmentType).to.equal('PermissionSet');
    expect(result.rows[0].sourceId).to.equal('0PSGrant1');
  });

  it('object resolver applies partial PSG muting', async () => {
    const target: ValidatedAccessTarget = { type: 'object', targetName: 'Account', sobjectType: 'Account' };
    const conn = createConn((soql) => {
      if (soql.includes('FROM ObjectPermissions') && soql.includes("WHERE SobjectType = 'Account'")) {
        return {
          done: true,
          records: [
            {
              ParentId: '0PSGrant3',
              Parent: { Id: '0PSGrant3', Name: 'Account Managers', IsOwnedByProfile: false, Type: 'Regular' },
              PermissionsRead: true,
              PermissionsCreate: true,
              PermissionsEdit: true,
              PermissionsDelete: false,
              PermissionsViewAllRecords: false,
              PermissionsModifyAllRecords: false,
            },
          ],
        };
      }
      if (
        soql.includes('FROM PermissionSetGroupComponent') &&
        soql.includes("WHERE PermissionSetId IN ('0PSGrant3')")
      ) {
        return {
          done: true,
          records: [
            {
              PermissionSetGroupId: '0PG2',
              PermissionSetId: '0PSGrant3',
              PermissionSetGroup: { MasterLabel: 'Sales Ops' },
            },
          ],
        };
      }
      if (soql.includes('FROM PermissionSetAssignment')) {
        return {
          done: true,
          records: [
            {
              Id: '0PA3',
              AssigneeId: '005U2',
              Assignee: { Name: 'Jane Smith', Username: 'jane@example.com', IsActive: true },
              PermissionSetGroupId: '0PG2',
              PermissionSetGroup: { MasterLabel: 'Sales Ops' },
            },
          ],
        };
      }
      if (soql.includes("FROM PermissionSetGroupComponent WHERE PermissionSetGroupId IN ('0PG2')")) {
        return { done: true, records: [{ PermissionSetGroupId: '0PG2', PermissionSetId: '0PSMute2' }] };
      }
      if (
        soql.includes("FROM ObjectPermissions WHERE Parent.IsOwnedByProfile = false AND ParentId IN ('0PSMute2')") &&
        soql.includes("SobjectType = 'Account'")
      ) {
        return {
          done: true,
          records: [
            {
              ParentId: '0PSMute2',
              PermissionsRead: false,
              PermissionsCreate: true,
              PermissionsEdit: false,
              PermissionsDelete: false,
              PermissionsViewAllRecords: false,
              PermissionsModifyAllRecords: false,
            },
          ],
        };
      }
      return { done: true, records: [] };
    });
    const result = await objectResolver.resolve(conn, target);
    expect(result.rows.length).to.equal(1);
    const access = result.rows[0].access;
    if (access.kind !== 'object') throw new Error('Expected object access');
    expect(access.read).to.equal(true);
    expect(access.create).to.equal(false);
    expect(access.edit).to.equal(true);
  });

  it('drains paginated assignment rows with queryMore', async () => {
    const target: ValidatedAccessTarget = { type: 'object', targetName: 'Account', sobjectType: 'Account' };
    const conn = createConn(
      (soql) => {
        if (soql.includes('FROM ObjectPermissions') && soql.includes("WHERE SobjectType = 'Account'")) {
          return {
            done: true,
            records: [
              {
                ParentId: '0PSGrant4',
                Parent: { Id: '0PSGrant4', Name: 'PS One', IsOwnedByProfile: false, Type: 'Regular' },
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
            done: false,
            nextRecordsUrl: '/next/psa',
            records: [
              {
                Id: '0PA4',
                AssigneeId: '005A',
                Assignee: { Name: 'A', Username: 'a@example.com', IsActive: true },
                PermissionSetId: '0PSGrant4',
                PermissionSet: { Id: '0PSGrant4', Name: 'PS One', IsOwnedByProfile: false, Type: 'Regular' },
              },
            ],
          };
        }
        return { done: true, records: [] };
      },
      {
        '/next/psa': {
          done: true,
          records: [
            {
              Id: '0PA5',
              AssigneeId: '005B',
              Assignee: { Name: 'B', Username: 'b@example.com', IsActive: true },
              PermissionSetId: '0PSGrant4',
              PermissionSet: { Id: '0PSGrant4', Name: 'PS One', IsOwnedByProfile: false, Type: 'Regular' },
            },
          ],
        },
      }
    );
    const result = await objectResolver.resolve(conn, target);
    expect(result.rows.map((row) => row.userId)).to.deep.equal(['005A', '005B']);
    expect((conn as unknown as { queryMore: sinon.SinonStub }).queryMore.calledOnce).to.equal(true);
    const queries = (conn as unknown as { query: sinon.SinonStub }).query
      .getCalls()
      .map((call) => call.args[0] as string);
    const assignmentQueries = queries.filter((query) => query.includes('FROM PermissionSetAssignment'));
    expect(assignmentQueries.length).to.be.greaterThan(0);
    expect(assignmentQueries.some((query) => query.includes('LIMIT 2000'))).to.equal(false);
  });

  it('field resolver returns warning with empty explicit permissions', async () => {
    const target: ValidatedAccessTarget = {
      type: 'field',
      targetName: 'Account.Name',
      sobjectType: 'Account',
      fieldApiName: 'Name',
    };
    const conn = createConn((soql) => {
      if (soql.includes('FROM FieldPermissions')) return { done: true, records: [] };
      return { done: true, records: [] };
    });
    const result = await fieldResolver.resolve(conn, target);
    expect(result.rows).to.deep.equal([]);
    expect(result.warnings[0]).to.include('No explicit FieldPermissions records');
  });

  it('field resolver maps profile-owned permission sets to Profile rows', async () => {
    const target: ValidatedAccessTarget = {
      type: 'field',
      targetName: 'Account.CustomField__c',
      sobjectType: 'Account',
      fieldApiName: 'CustomField__c',
    };
    const conn = createConn((soql) => {
      if (soql.includes('FROM FieldPermissions') && soql.includes("AND Field = 'Account.CustomField__c'")) {
        return {
          done: true,
          records: [
            {
              ParentId: '0PSProfile',
              Parent: {
                Id: '0PSProfile',
                Name: 'Sales Profile',
                IsOwnedByProfile: true,
                ProfileId: '00e1',
                Profile: { Name: 'Sales User' },
                Type: 'Regular',
              },
              PermissionsRead: true,
              PermissionsEdit: false,
            },
          ],
        };
      }
      if (soql.includes('FROM PermissionSetAssignment')) {
        return {
          done: true,
          records: [
            {
              Id: '0PA6',
              AssigneeId: '005P',
              Assignee: { Name: 'P User', Username: 'p@example.com', IsActive: true },
              PermissionSetId: '0PSProfile',
              PermissionSet: {
                Id: '0PSProfile',
                Name: 'Sales Profile',
                IsOwnedByProfile: true,
                ProfileId: '00e1',
                Profile: { Name: 'Sales User' },
                Type: 'Regular',
              },
            },
          ],
        };
      }
      return { done: true, records: [] };
    });
    const result = await fieldResolver.resolve(conn, target);
    expect(result.rows.length).to.equal(1);
    expect(result.rows[0].assignmentType).to.equal('Profile');
    expect(result.rows[0].sourceId).to.equal('00e1');
  });

  it('object resolver returns empty result when no object entitlements exist', async () => {
    const target: ValidatedAccessTarget = { type: 'object', targetName: 'Account', sobjectType: 'Account' };
    const conn = createConn((soql) => {
      if (soql.includes('FROM ObjectPermissions')) return { done: true, records: [] };
      return { done: true, records: [] };
    });
    const result = await objectResolver.resolve(conn, target);
    expect(result.rows).to.deep.equal([]);
    expect(result.stats.totalActiveUsersWithAccess).to.equal(0);
  });

  it('object resolver ignores permission set type Group as standalone source', async () => {
    const target: ValidatedAccessTarget = { type: 'object', targetName: 'Account', sobjectType: 'Account' };
    const conn = createConn((soql) => {
      if (soql.includes('FROM ObjectPermissions') && soql.includes("WHERE SobjectType = 'Account'")) {
        return {
          done: true,
          records: [
            {
              ParentId: '0PSGroup',
              Parent: { Id: '0PSGroup', Name: 'PSG Aggregate', IsOwnedByProfile: false, Type: 'Group' },
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
      if (soql.includes('FROM PermissionSetAssignment')) return { done: true, records: [] };
      return { done: true, records: [] };
    });
    const result = await objectResolver.resolve(conn, target);
    expect(result.rows.length).to.equal(0);
  });

  it('field resolver returns empty when only group-type entitlement rows exist', async () => {
    const target: ValidatedAccessTarget = {
      type: 'field',
      targetName: 'Account.CustomField__c',
      sobjectType: 'Account',
      fieldApiName: 'CustomField__c',
    };
    const conn = createConn((soql) => {
      if (soql.includes('FROM FieldPermissions') && soql.includes("AND Field = 'Account.CustomField__c'")) {
        return {
          done: true,
          records: [
            {
              ParentId: '0PSGroupOnly',
              Parent: { Id: '0PSGroupOnly', Name: 'Group Aggregate', IsOwnedByProfile: false, Type: 'Group' },
              PermissionsRead: true,
              PermissionsEdit: false,
            },
          ],
        };
      }
      return { done: true, records: [] };
    });
    const result = await fieldResolver.resolve(conn, target);
    expect(result.rows.length).to.equal(0);
  });

  it('object resolver returns empty when only group-type entitlement rows exist', async () => {
    const target: ValidatedAccessTarget = { type: 'object', targetName: 'Account', sobjectType: 'Account' };
    const conn = createConn((soql) => {
      if (soql.includes('FROM ObjectPermissions') && soql.includes("WHERE SobjectType = 'Account'")) {
        return {
          done: true,
          records: [
            {
              ParentId: '0PSGroupOnly',
              Parent: { Id: '0PSGroupOnly', Name: 'Group Aggregate', IsOwnedByProfile: false, Type: 'Group' },
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
      return { done: true, records: [] };
    });
    const result = await objectResolver.resolve(conn, target);
    expect(result.rows.length).to.equal(0);
  });

  it('wraps query errors as access-query failures', async () => {
    const target: ValidatedAccessTarget = { type: 'object', targetName: 'Account', sobjectType: 'Account' };
    const conn = {
      query: sinon.stub().rejects(new Error('boom')),
      queryMore: sinon.stub(),
      describe: sinon.stub(),
    } as never;
    let caught: unknown;
    try {
      await objectResolver.resolve(conn, target);
    } catch (error) {
      caught = error;
    }
    expect((caught as { code: string }).code).to.equal('errorAccessQueryFailed');
  });

  it('emits one PSG row per underlying granting permission set', async () => {
    const target: ValidatedAccessTarget = {
      type: 'field',
      targetName: 'Account.CustomField__c',
      sobjectType: 'Account',
      fieldApiName: 'CustomField__c',
    };
    const conn = createConn((soql) => {
      if (soql.includes('FROM FieldPermissions') && soql.includes("AND Field = 'Account.CustomField__c'")) {
        return {
          done: true,
          records: [
            {
              ParentId: '0PSA',
              Parent: { Id: '0PSA', Name: 'Grant A', IsOwnedByProfile: false, Type: 'Regular' },
              PermissionsRead: true,
              PermissionsEdit: false,
            },
            {
              ParentId: '0PSB',
              Parent: { Id: '0PSB', Name: 'Grant B', IsOwnedByProfile: false, Type: 'Regular' },
              PermissionsRead: true,
              PermissionsEdit: true,
            },
          ],
        };
      }
      if (
        soql.includes('FROM PermissionSetGroupComponent') &&
        soql.includes("WHERE PermissionSetId IN ('0PSA','0PSB')")
      ) {
        return {
          done: true,
          records: [
            { PermissionSetGroupId: '0PG3', PermissionSetId: '0PSA', PermissionSetGroup: { MasterLabel: 'Ops PSG' } },
            { PermissionSetGroupId: '0PG3', PermissionSetId: '0PSB', PermissionSetGroup: { MasterLabel: 'Ops PSG' } },
          ],
        };
      }
      if (soql.includes('FROM PermissionSetAssignment')) {
        return {
          done: true,
          records: [
            {
              Id: '0PA7',
              AssigneeId: '005U3',
              Assignee: { Name: 'Casey', Username: 'casey@example.com', IsActive: true },
              PermissionSetGroupId: '0PG3',
              PermissionSetGroup: { MasterLabel: 'Ops PSG' },
            },
          ],
        };
      }
      if (soql.includes("FROM PermissionSetGroupComponent WHERE PermissionSetGroupId IN ('0PG3')")) {
        return { done: true, records: [] };
      }
      return { done: true, records: [] };
    });
    const result = await fieldResolver.resolve(conn, target);
    expect(result.rows.length).to.equal(2);
    expect(result.rows.every((row) => row.assignmentType === 'PermissionSetGroup')).to.equal(true);
  });

  it('excludes object PSG rows when muting removes all permissions', async () => {
    const target: ValidatedAccessTarget = { type: 'object', targetName: 'Account', sobjectType: 'Account' };
    const conn = createConn((soql) => {
      if (soql.includes('FROM ObjectPermissions') && soql.includes("WHERE SobjectType = 'Account'")) {
        return {
          done: true,
          records: [
            {
              ParentId: '0PSAll',
              Parent: { Id: '0PSAll', Name: 'Grant All', IsOwnedByProfile: false, Type: 'Regular' },
              PermissionsRead: true,
              PermissionsCreate: false,
              PermissionsEdit: true,
              PermissionsDelete: false,
              PermissionsViewAllRecords: false,
              PermissionsModifyAllRecords: false,
            },
          ],
        };
      }
      if (soql.includes("FROM PermissionSetGroupComponent WHERE PermissionSetId IN ('0PSAll')")) {
        return { done: true, records: [{ PermissionSetGroupId: '0PG4', PermissionSetId: '0PSAll' }] };
      }
      if (soql.includes('FROM PermissionSetAssignment')) {
        return {
          done: true,
          records: [
            {
              Id: '0PA8',
              AssigneeId: '005U4',
              Assignee: { Name: 'Riley', Username: 'riley@example.com', IsActive: true },
              PermissionSetGroupId: '0PG4',
              PermissionSetGroup: { MasterLabel: 'Muting PSG' },
            },
          ],
        };
      }
      if (soql.includes("FROM PermissionSetGroupComponent WHERE PermissionSetGroupId IN ('0PG4')")) {
        return { done: true, records: [{ PermissionSetGroupId: '0PG4', PermissionSetId: '0PSMute4' }] };
      }
      if (soql.includes("FROM ObjectPermissions WHERE Parent.IsOwnedByProfile = false AND ParentId IN ('0PSMute4')")) {
        return {
          done: true,
          records: [
            {
              ParentId: '0PSMute4',
              PermissionsRead: true,
              PermissionsCreate: false,
              PermissionsEdit: true,
              PermissionsDelete: false,
              PermissionsViewAllRecords: false,
              PermissionsModifyAllRecords: false,
            },
          ],
        };
      }
      return { done: true, records: [] };
    });
    const result = await objectResolver.resolve(conn, target);
    expect(result.rows.length).to.equal(0);
  });

  it('resolves forward record-type visibility for Profile, Permission Set, and PSG paths', async () => {
    const conn = createConn((soql) => {
      if (soql.includes('FROM User')) return { done: true, records: [{ ProfileId: '00eProfile' }] };
      if (soql.includes('FROM Profile')) return { done: true, records: [{ Id: '00eProfile', Name: 'Sales' }] };
      if (soql.includes('FROM PermissionSet ') && soql.includes('IsOwnedByProfile = true')) {
        return {
          done: true,
          records: [
            { Id: '0PSProfile', Name: 'Sales', IsOwnedByProfile: true, ProfileId: '00eProfile', Type: 'Regular' },
          ],
        };
      }
      if (soql.includes('FROM PermissionSet ') && soql.includes('Id IN')) {
        return {
          done: true,
          records: [{ Id: '0PSDirect', Name: 'Business_Access', IsOwnedByProfile: false, Type: 'Regular' }],
        };
      }
      if (soql.includes('FROM PermissionSetGroupComponent')) {
        return {
          done: true,
          records: [
            {
              PermissionSetGroupId: '0PG1',
              PermissionSetId: '0PSDirect',
              PermissionSet: { Name: 'Business_Access', Type: 'Regular' },
              PermissionSetGroup: { MasterLabel: 'Sales PSG' },
            },
          ],
        };
      }
      if (soql.includes('FROM PermissionSetAssignment')) {
        return {
          done: true,
          records: [
            {
              Id: '0PAProfile',
              AssigneeId: '005Profile',
              Assignee: { Name: 'Profile User', Username: 'profile@example.com', IsActive: true },
              PermissionSetId: '0PSProfile',
              PermissionSet: {
                Name: 'Sales',
                IsOwnedByProfile: true,
                ProfileId: '00eProfile',
                Profile: { Name: 'Sales' },
                Type: 'Regular',
              },
            },
            {
              Id: '0PADirect',
              AssigneeId: '005Direct',
              Assignee: { Name: 'Direct User', Username: 'direct@example.com', IsActive: true },
              PermissionSetId: '0PSDirect',
              PermissionSet: { Name: 'Business_Access', IsOwnedByProfile: false, Type: 'Regular' },
            },
            {
              Id: '0PAPsg',
              AssigneeId: '005Psg',
              Assignee: { Name: 'PSG User', Username: 'psg@example.com', IsActive: true },
              PermissionSetGroupId: '0PG1',
              PermissionSetGroup: { MasterLabel: 'Sales PSG' },
            },
          ],
        };
      }
      return { done: true, records: [] };
    });
    (conn as unknown as { metadata: { read: sinon.SinonStub; list: sinon.SinonStub } }).metadata = {
      list: sinon.stub().resolves([{ id: '00eProfile', fullName: 'Sales' }]),
      read: sinon.stub().callsFake(async (type: string) =>
        type === 'Profile'
          ? {
              fullName: 'Sales',
              recordTypeVisibilities: [{ recordType: 'Account.Business_Account', visible: true, default: true }],
            }
          : [
              {
                fullName: 'Business_Access',
                recordTypeVisibilities: [{ recordType: 'Account.Business_Account', visible: true }],
              },
            ]
      ),
    };
    const result = await recordTypeResolver.resolve(conn, {
      type: 'record-type',
      targetName: 'Account.Business_Account',
      sobjectType: 'Account',
      recordTypeId: '0121',
    });
    expect(result.rows.map((row) => row.assignmentType)).to.deep.equal([
      'Profile',
      'PermissionSet',
      'PermissionSetGroup',
    ]);
    expect(result.rows[0].access).to.deep.equal({ kind: 'record-type', visible: true, default: true });
    expect(
      result.rows.slice(1).every((row) => row.access.kind === 'record-type' && row.access.default === null)
    ).to.equal(true);
    expect(result.rows[2].viaPermissionSetId).to.equal('0PSDirect');
  });

  it('reads standard-profile metadata by API name and skips profiles absent from the listing', async () => {
    const conn = createConn((soql) => {
      // One standard profile whose metadata name differs from its label, plus a
      // system profile (Automated Process) that the metadata listing omits.
      if (soql.includes('FROM User')) {
        return { done: true, records: [{ ProfileId: '00eStd' }, { ProfileId: '00eAuto' }] };
      }
      if (soql.includes('FROM Profile')) return { done: true, records: [{ Id: '00eStd', Name: 'Contract Manager' }] };
      if (soql.includes('FROM PermissionSet ') && soql.includes('IsOwnedByProfile = true')) {
        return {
          done: true,
          records: [
            { Id: '0PSStd', Name: 'Contract Manager', IsOwnedByProfile: true, ProfileId: '00eStd', Type: 'Regular' },
          ],
        };
      }
      if (soql.includes('FROM PermissionSetAssignment')) {
        return {
          done: true,
          records: [
            {
              Id: '0PAStd',
              AssigneeId: '005Std',
              Assignee: { Name: 'Std User', Username: 'std@example.com', IsActive: true },
              PermissionSetId: '0PSStd',
              PermissionSet: {
                Name: 'Contract Manager',
                IsOwnedByProfile: true,
                ProfileId: '00eStd',
                Profile: { Name: 'Contract Manager' },
                Type: 'Regular',
              },
            },
          ],
        };
      }
      return { done: true, records: [] };
    });
    const read = sinon.stub().resolves({
      fullName: 'ContractManager',
      recordTypeVisibilities: [{ recordType: 'Account.Business_Account', visible: true, default: true }],
    });
    (conn as unknown as { metadata: { read: sinon.SinonStub; list: sinon.SinonStub } }).metadata = {
      // "Automated Process" (00eAuto) is intentionally absent from the listing.
      list: sinon.stub().resolves([{ id: '00eStd', fullName: 'ContractManager' }]),
      read,
    };
    const result = await recordTypeResolver.resolve(conn, {
      type: 'record-type',
      targetName: 'Account.Business_Account',
      sobjectType: 'Account',
      recordTypeId: '0121',
    });
    expect(result.rows.map((row) => row.assignmentType)).to.deep.equal(['Profile']);
    // Metadata is requested by the API name, not the SOQL label.
    expect(read.calledWith('Profile', ['ContractManager'])).to.equal(true);
  });

  it('resolves reverse record-type visibility only from the user sources', async () => {
    const conn = createConn((soql) => {
      if (soql.includes('FROM PermissionSetAssignment')) {
        return {
          done: true,
          records: [
            {
              PermissionSetId: '0PSProfile',
              PermissionSet: {
                Name: 'Sales',
                IsOwnedByProfile: true,
                ProfileId: '00eProfile',
                Profile: { Name: 'Sales' },
                Type: 'Regular',
              },
            },
            { PermissionSetId: '0PSDirect', PermissionSet: { Name: 'Business_Access', Type: 'Regular' } },
            { PermissionSetGroupId: '0PG1', PermissionSetGroup: { MasterLabel: 'Sales PSG' } },
          ],
        };
      }
      if (soql.includes('FROM PermissionSetGroupComponent')) {
        return {
          done: true,
          records: [
            {
              PermissionSetGroupId: '0PG1',
              PermissionSetId: '0PSDirect',
              PermissionSet: { Name: 'Business_Access', Type: 'Regular' },
            },
          ],
        };
      }
      return { done: true, records: [] };
    });
    (conn as unknown as { metadata: { read: sinon.SinonStub; list: sinon.SinonStub } }).metadata = {
      list: sinon.stub().resolves([{ id: '00eProfile', fullName: 'Sales' }]),
      read: sinon.stub().callsFake(async (type: string, names: string[]) =>
        type === 'Profile'
          ? {
              fullName: names[0],
              recordTypeVisibilities: [{ recordType: 'Account.Business_Account', visible: true, default: false }],
            }
          : [
              {
                fullName: names[0],
                recordTypeVisibilities: [{ recordType: 'Account.Business_Account', visible: true }],
              },
            ]
      ),
    };
    const result = await resolveReverseAccess(
      conn,
      { Id: '005User', name: 'Reverse User', username: 'reverse@example.com' },
      { type: 'record-type', targetName: 'Account.Business_Account', sobjectType: 'Account', recordTypeId: '0121' }
    );
    expect(result.rows).to.have.length(3);
    expect(result.rows[0].access).to.deep.equal({ kind: 'record-type', visible: true, default: false });
    expect(
      result.rows.slice(1).every((row) => row.access.kind === 'record-type' && row.access.default === null)
    ).to.equal(true);
    expect(result.rows.some((row) => row.assignmentType === 'PermissionSetGroup')).to.equal(true);
  });

  it('applies record-type muting to PSG rows in forward and reverse audits', async () => {
    const queryWithMuting = (soql: string): QueryPage => {
      if (soql.includes('FROM User')) return { done: true, records: [{ ProfileId: '00eProfile' }] };
      if (soql.includes('FROM Profile')) return { done: true, records: [{ Id: '00eProfile', Name: 'Sales' }] };
      if (soql.includes('FROM PermissionSet ') && soql.includes('IsOwnedByProfile = true')) {
        return {
          done: true,
          records: [
            { Id: '0PSProfile', Name: 'Sales', IsOwnedByProfile: true, ProfileId: '00eProfile', Type: 'Regular' },
          ],
        };
      }
      if (soql.includes('FROM PermissionSetGroupComponent')) {
        return {
          done: true,
          records: [
            {
              PermissionSetGroupId: '0PG1',
              PermissionSetId: '0PSGrant',
              PermissionSet: { Name: 'Record_Type_Grant', Type: 'Regular' },
            },
            {
              // Muting permission sets are a separate object: the component's
              // PermissionSet relationship is null and the Id is not a PermissionSet.
              PermissionSetGroupId: '0PG1',
              PermissionSetId: '0QMMute',
              PermissionSet: null,
            },
          ],
        };
      }
      if (soql.includes('FROM PermissionSet ') && soql.includes('Id IN')) {
        return {
          done: true,
          records: [{ Id: '0PSGrant', Name: 'Record_Type_Grant', IsOwnedByProfile: false, Type: 'Regular' }],
        };
      }
      if (soql.includes('FROM PermissionSetAssignment')) {
        return {
          done: true,
          records: [
            {
              Id: '0PADirect',
              AssigneeId: '005Direct',
              Assignee: { Name: 'Direct User', Username: 'direct@example.com', IsActive: true },
              PermissionSetId: '0PSGrant',
              PermissionSet: { Name: 'Record_Type_Grant', Type: 'Regular' },
            },
            {
              Id: '0PAPsg',
              AssigneeId: '005Psg',
              Assignee: { Name: 'PSG User', Username: 'psg@example.com', IsActive: true },
              PermissionSetGroupId: '0PG1',
              PermissionSetGroup: { MasterLabel: 'Muted PSG' },
            },
          ],
        };
      }
      return { done: true, records: [] };
    };
    const metadataRead = sinon.stub().callsFake(async (type: string, names: string[]) => {
      const fullName = names[0];
      if (type === 'Profile') {
        return {
          fullName,
          recordTypeVisibilities: [{ recordType: 'Account.Business_Account', visible: true, default: false }],
        };
      }
      return [
        {
          fullName,
          recordTypeVisibilities: [{ recordType: 'Account.Business_Account', visible: true }],
        },
      ];
    });
    const metadataList = sinon.stub().callsFake(async (queries: Array<{ type: string }>) => {
      const type = queries[0]?.type;
      if (type === 'Profile') return [{ id: '00eProfile', fullName: 'Sales' }];
      if (type === 'MutingPermissionSet') return [{ id: '0QMMute', fullName: 'Record_Type_Mute' }];
      return [];
    });
    const forward = await recordTypeResolver.resolve(
      Object.assign(createConn(queryWithMuting), { metadata: { read: metadataRead, list: metadataList } }),
      { type: 'record-type', targetName: 'Account.Business_Account', sobjectType: 'Account', recordTypeId: '0121' }
    );
    expect(forward.rows.map((row) => row.assignmentType)).to.deep.equal(['PermissionSet']);
    expect(forward.rows[0].sourceId).to.equal('0PSGrant');

    const reverse = await resolveReverseAccess(
      Object.assign(
        createConn((soql) => {
          if (soql.includes('FROM PermissionSetAssignment')) {
            return {
              done: true,
              records: [
                {
                  PermissionSetId: '0PSProfile',
                  PermissionSet: {
                    Name: 'Sales',
                    IsOwnedByProfile: true,
                    ProfileId: '00eProfile',
                    Profile: { Name: 'Sales' },
                    Type: 'Regular',
                  },
                },
                { PermissionSetId: '0PSGrant', PermissionSet: { Name: 'Record_Type_Grant', Type: 'Regular' } },
                { PermissionSetGroupId: '0PG1', PermissionSetGroup: { MasterLabel: 'Muted PSG' } },
              ],
            };
          }
          if (soql.includes('FROM PermissionSetGroupComponent')) {
            return {
              done: true,
              records: [
                {
                  PermissionSetGroupId: '0PG1',
                  PermissionSetId: '0PSGrant',
                  PermissionSet: { Name: 'Record_Type_Grant', Type: 'Regular' },
                },
                { PermissionSetGroupId: '0PG1', PermissionSetId: '0QMMute', PermissionSet: null },
              ],
            };
          }
          if (soql.includes('FROM PermissionSet ') && soql.includes('Id IN')) {
            return { done: true, records: [] };
          }
          return { done: true, records: [] };
        }),
        { metadata: { read: metadataRead, list: metadataList } }
      ),
      { Id: '005Psg', name: 'PSG User', username: 'psg@example.com' },
      { type: 'record-type', targetName: 'Account.Business_Account', sobjectType: 'Account', recordTypeId: '0121' }
    );
    expect(reverse.rows.map((row) => row.assignmentType)).to.deep.equal(['Profile', 'PermissionSet']);
  });
});
