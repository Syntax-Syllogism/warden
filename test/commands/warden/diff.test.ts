import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TestContext } from '@salesforce/core/testSetup';
import { stubSfCommandUx } from '@salesforce/sf-plugins-core';
import { expect } from 'chai';
import sinon from 'sinon';
import UserDiff from '../../../src/commands/warden/diff.js';
import { renderUserDiffCsv, renderUserDiffHuman } from '../../../src/userLifecycle/userDiff.js';

type FakeConnection = {
  describe: sinon.SinonStub;
  query: sinon.SinonStub;
  sobject: sinon.SinonStub;
};

const userFields = [
  { name: 'Username', createable: true, updateable: true, externalId: false },
  { name: 'FederationIdentifier', createable: true, updateable: true, externalId: true },
  { name: 'ProfileId', createable: true, updateable: true, externalId: false },
  { name: 'UserRoleId', createable: true, updateable: true, externalId: false },
  { name: 'LastName', createable: true, updateable: true, externalId: false },
];

const makeFakeConnection = (): FakeConnection => ({
  describe: sinon.stub().resolves({ fields: userFields }),
  query: sinon.stub().resolves({ records: [] }),
  sobject: sinon.stub(),
});

describe('warden user diff command', () => {
  const $$ = new TestContext();
  let sfCommandStubs: ReturnType<typeof stubSfCommandUx>;

  beforeEach(() => {
    sfCommandStubs = stubSfCommandUx($$.SANDBOX);
  });

  afterEach(() => {
    sinon.restore();
    $$.restore();
  });

  it('reports user-vs-persona drift and does not perform DML', async () => {
    const fakeConn = makeFakeConnection();
    const dir = mkdtempSync(join(tmpdir(), 'warden-diff-test-'));
    const usersPath = join(dir, 'users.json');
    const personasPath = join(dir, 'personas.json');
    writeFileSync(
      usersPath,
      JSON.stringify({
        users: [{ personas: ['support'], FederationIdentifier: 'A001', LastName: 'User' }],
      })
    );
    writeFileSync(
      personasPath,
      JSON.stringify({
        personas: {
          support: {
            profile: 'Support Profile',
            role: 'SupportRole',
            permissionSetMode: 'sync',
            permissionSets: ['KeepPerm', 'AddPerm'],
            permissionSetGroupMode: 'additive',
            permissionSetGroups: ['AddGroup'],
            publicGroupMode: 'sync',
            publicGroups: ['KeepPublic'],
            queueMode: 'additive',
            queues: ['KeepQueue', 'AddQueue'],
          },
        },
      })
    );
    fakeConn.query.callsFake(async (soql: string) => {
      if (soql.includes('FROM Profile')) return { records: [{ Id: '00eProfileTarget1', Name: 'Support Profile' }] };
      if (soql.includes('FROM UserRole'))
        return { records: [{ Id: '00ERoleTarget001', DeveloperName: 'SupportRole', Name: 'Support Role' }] };
      if (soql.includes("FROM Group WHERE DeveloperName IN ('KeepPublic')"))
        return { records: [{ Id: '00GPublicKeep01', DeveloperName: 'KeepPublic' }] };
      if (soql.includes("FROM Group WHERE DeveloperName IN ('KeepQueue','AddQueue')"))
        return {
          records: [
            { Id: '00GQueueKeep001', DeveloperName: 'KeepQueue' },
            { Id: '00GQueueAdd0002', DeveloperName: 'AddQueue' },
          ],
        };
      if (soql.includes('FROM User WHERE FederationIdentifier IN'))
        return {
          records: [
            {
              Id: '005User00000001',
              IsActive: true,
              FederationIdentifier: 'A001',
            },
          ],
        };
      if (soql.includes('SELECT Id, ProfileId, UserRoleId FROM User WHERE Id IN'))
        return {
          records: [
            {
              Id: '005User00000001',
              ProfileId: '00eProfileCurrent',
              UserRoleId: '00ERoleTarget001',
            },
          ],
        };
      if (soql.includes('FROM UserLogin')) return { records: [] };
      if (soql.includes('FROM PermissionSetAssignment'))
        return {
          records: [
            {
              Id: '0PaKeep',
              AssigneeId: '005User00000001',
              PermissionSetId: '0PSPermKeep0001',
              PermissionSetGroupId: null,
              PermissionSet: { IsOwnedByProfile: false },
            },
            {
              Id: '0PaRemove',
              AssigneeId: '005User00000001',
              PermissionSetId: '0PSPermRemove',
              PermissionSetGroupId: null,
              PermissionSet: { IsOwnedByProfile: false },
            },
          ],
        };
      if (soql.includes('FROM PermissionSetGroup'))
        return { records: [{ Id: '0PGGroupAdd0001', DeveloperName: 'AddGroup' }] };
      if (soql.includes('FROM PermissionSet'))
        return {
          records: [
            { Id: '0PSPermKeep0001', Name: 'KeepPerm' },
            { Id: '0PSPermAdd0002', Name: 'AddPerm' },
          ],
        };
      if (soql.includes('FROM GroupMember'))
        return {
          records: [
            {
              Id: '0GMKeepPublic',
              GroupId: '00GPublicKeep01',
              UserOrGroupId: '005User00000001',
              Group: { Type: 'Regular' },
            },
            {
              Id: '0GMKeepQueue',
              GroupId: '00GQueueKeep001',
              UserOrGroupId: '005User00000001',
              Group: { Type: 'Queue' },
            },
            {
              Id: '0GMExtraQueue',
              GroupId: '00GQueueExtra',
              UserOrGroupId: '005User00000001',
              Group: { Type: 'Queue' },
            },
          ],
        };
      return { records: [] };
    });
    sinon.stub(UserDiff.prototype as unknown as Record<string, unknown>, 'parse').resolves({
      flags: {
        'target-org': { getConnection: () => fakeConn },
        'users-def': usersPath,
        'personas-def': personasPath,
        'external-id': 'FederationIdentifier',
        output: 'human',
        'api-version': undefined,
      },
    } as never);

    const result = await UserDiff.run(['--json']);
    expect(result.summary.changed).to.equal(1);
    expect(result.users[0].profile.matches).to.equal(false);
    expect(result.users[0].role.matches).to.equal(true);
    expect(result.users[0].assignments.permissionSets.adds).to.deep.equal(['0PSPermAdd0002']);
    expect(result.users[0].assignments.permissionSets.removes).to.deep.equal(['0PSPermRemove']);
    expect(result.users[0].assignments.permissionSets.inBoth).to.deep.equal(['0PSPermKeep0001']);
    expect(result.users[0].assignments.permissionSetGroups.adds).to.deep.equal(['0PGGroupAdd0001']);
    expect(result.users[0].assignments.queues.adds).to.deep.equal(['00GQueueAdd0002']);
    expect(result.users[0].assignments.queues.removes).to.deep.equal([]);
    expect(result.users[0].assignments.queues.onlyInOrg).to.include('00GQueueExtra');
    expect(fakeConn.sobject.called).to.equal(false);
  });

  it('does not report profile or role drift when the persona does not manage them', async () => {
    const fakeConn = makeFakeConnection();
    const dir = mkdtempSync(join(tmpdir(), 'warden-diff-test-'));
    const usersPath = join(dir, 'users.json');
    const personasPath = join(dir, 'personas.json');
    writeFileSync(
      usersPath,
      JSON.stringify({
        users: [{ personas: ['support'], FederationIdentifier: 'A002', LastName: 'User' }],
      })
    );
    writeFileSync(
      personasPath,
      JSON.stringify({
        personas: {
          support: {
            permissionSetMode: 'sync',
            permissionSets: ['KeepPerm'],
          },
        },
      })
    );
    fakeConn.query.callsFake(async (soql: string) => {
      if (soql.includes('FROM User WHERE FederationIdentifier IN'))
        return {
          records: [
            {
              Id: '005User00000002',
              IsActive: true,
              FederationIdentifier: 'A002',
            },
          ],
        };
      if (soql.includes('SELECT Id, ProfileId, UserRoleId FROM User WHERE Id IN'))
        return {
          records: [
            {
              Id: '005User00000002',
              ProfileId: '00eCurrentProfile',
              UserRoleId: '00ECurrentRole',
            },
          ],
        };
      if (soql.includes('FROM PermissionSetAssignment'))
        return {
          records: [
            {
              Id: '0PaKeep',
              AssigneeId: '005User00000002',
              PermissionSetId: '0PSPermKeep0001',
              PermissionSetGroupId: null,
              PermissionSet: { IsOwnedByProfile: false },
            },
          ],
        };
      if (soql.includes('FROM PermissionSet')) return { records: [{ Id: '0PSPermKeep0001', Name: 'KeepPerm' }] };
      if (soql.includes('FROM GroupMember')) return { records: [] };
      return { records: [] };
    });
    sinon.stub(UserDiff.prototype as unknown as Record<string, unknown>, 'parse').resolves({
      flags: {
        'target-org': { getConnection: () => fakeConn },
        'users-def': usersPath,
        'personas-def': personasPath,
        'external-id': 'FederationIdentifier',
        output: 'human',
        'api-version': undefined,
      },
    } as never);

    const result = await UserDiff.run(['--json']);
    expect(result.summary.changed).to.equal(0);
    expect(result.users[0].profile.matches).to.equal(true);
    expect(result.users[0].role.matches).to.equal(true);
  });

  it('does not invent assignment modes for failed persona users', async () => {
    const fakeConn = makeFakeConnection();
    const dir = mkdtempSync(join(tmpdir(), 'warden-diff-test-'));
    const usersPath = join(dir, 'users.json');
    const personasPath = join(dir, 'personas.json');
    writeFileSync(usersPath, JSON.stringify({ users: [{ FederationIdentifier: 'A003', LastName: 'User' }] }));
    writeFileSync(
      personasPath,
      JSON.stringify({
        personas: {
          support: {
            permissionSetMode: 'sync',
            permissionSets: ['KeepPerm'],
          },
        },
      })
    );
    sinon.stub(UserDiff.prototype as unknown as Record<string, unknown>, 'parse').resolves({
      flags: {
        'target-org': { getConnection: () => fakeConn },
        'users-def': usersPath,
        'personas-def': personasPath,
        'external-id': 'FederationIdentifier',
        output: 'human',
        'api-version': undefined,
      },
    } as never);

    const result = await UserDiff.run(['--json']);
    expect(result.users[0].status).to.equal('failed');
    expect(result.users[0].assignments.permissionSets.mode).to.equal(undefined);
  });

  it('reports user-vs-user effective assignment delta', async () => {
    const fakeConn = makeFakeConnection();
    fakeConn.query.callsFake(async (soql: string) => {
      if (soql.includes("Username IN ('new@example.test','template@example.test')"))
        return {
          records: [
            { Id: '005NewUser00001', IsActive: true, Username: 'new@example.test' },
            { Id: '005Template0001', IsActive: true, Username: 'template@example.test' },
          ],
        };
      if (soql.includes('FROM UserLogin')) return { records: [] };
      if (soql.includes('SELECT Id, ProfileId, UserRoleId FROM User WHERE Id IN'))
        return {
          records: [
            { Id: '005NewUser00001', ProfileId: '00eCurrent', UserRoleId: null },
            { Id: '005Template0001', ProfileId: '00eTemplate', UserRoleId: '00ETemplateRole' },
          ],
        };
      if (soql.includes('FROM PermissionSetAssignment'))
        return {
          records: [
            {
              Id: '0PaCurrent',
              AssigneeId: '005NewUser00001',
              PermissionSetId: '0PSCurrent',
              PermissionSetGroupId: null,
              PermissionSet: { IsOwnedByProfile: false },
            },
            {
              Id: '0PaShared',
              AssigneeId: '005NewUser00001',
              PermissionSetId: '0PSShared',
              PermissionSetGroupId: null,
              PermissionSet: { IsOwnedByProfile: false },
            },
            {
              Id: '0PaTarget',
              AssigneeId: '005Template0001',
              PermissionSetId: '0PSTarget',
              PermissionSetGroupId: null,
              PermissionSet: { IsOwnedByProfile: false },
            },
            {
              Id: '0PaTargetShared',
              AssigneeId: '005Template0001',
              PermissionSetId: '0PSShared',
              PermissionSetGroupId: null,
              PermissionSet: { IsOwnedByProfile: false },
            },
          ],
        };
      if (soql.includes('FROM GroupMember')) return { records: [] };
      return { records: [] };
    });
    sinon.stub(UserDiff.prototype as unknown as Record<string, unknown>, 'parse').resolves({
      flags: {
        'target-org': { getConnection: () => fakeConn },
        user: 'Username:new@example.test',
        against: 'Username:template@example.test',
        output: 'human',
        'api-version': undefined,
      },
    } as never);

    const result = await UserDiff.run(['--json']);
    expect(result.users[0].assignments.permissionSets.adds).to.deep.equal(['0PSTarget']);
    expect(result.users[0].assignments.permissionSets.removes).to.deep.equal(['0PSCurrent']);
    expect(result.users[0].assignments.permissionSets.inBoth).to.deep.equal(['0PSShared']);
    expect(result.users[0].profile.matches).to.equal(false);
    expect(result.users[0].role.matches).to.equal(false);
    expect(fakeConn.sobject.called).to.equal(false);
  });

  it('renders csv output rows', async () => {
    const csv = renderUserDiffCsv({
      summary: { total: 1, compared: 1, wouldCreate: 0, failed: 0, changed: 1 },
      warnings: [],
      users: [],
      rows: [
        {
          userKey: 'Username:user@example.test',
          userId: '005User',
          category: 'permissionSets',
          kind: 'add',
          value: '0PSAdd',
          mode: 'sync',
        },
      ],
    });
    expect(csv).to.equal(
      'userKey,userId,category,kind,value,mode\nUsername:user@example.test,005User,permissionSets,add,0PSAdd,sync'
    );
    expect(sfCommandStubs.log.called).to.equal(false);
  });

  it('omits meaningless mode values for user-vs-user csv rows', async () => {
    const csv = renderUserDiffCsv({
      summary: { total: 1, compared: 1, wouldCreate: 0, failed: 0, changed: 1 },
      warnings: [],
      users: [],
      rows: [
        {
          userKey: 'Username:user@example.test',
          userId: '005User',
          category: 'permissionSets',
          kind: 'remove',
          value: '0PSCurrent',
        },
      ],
    });
    expect(csv).to.equal(
      'userKey,userId,category,kind,value,mode\nUsername:user@example.test,005User,permissionSets,remove,0PSCurrent,'
    );
  });

  it('renders human output with labels and gates in-both rows behind verbose', async () => {
    const result = {
      summary: { total: 1, compared: 1, wouldCreate: 0, failed: 0, changed: 1 },
      warnings: [],
      labels: { '0PSAdd': 'AddPerm', '0PSKeep': 'KeepPerm' },
      rows: [],
      users: [
        {
          key: 'A002',
          id: '005User',
          status: 'compared' as const,
          matchedBy: 'FederationIdentifier',
          profile: { matches: true },
          role: { matches: true },
          assignments: {
            permissionSets: {
              adds: ['0PSAdd'],
              removes: [],
              inBoth: ['0PSKeep'],
              onlyInOrg: [],
              mode: 'sync' as const,
            },
            permissionSetGroups: { adds: [], removes: [], inBoth: [], onlyInOrg: [], mode: 'additive' as const },
            publicGroups: { adds: [], removes: [], inBoth: [], onlyInOrg: [], mode: 'additive' as const },
            queues: { adds: [], removes: [], inBoth: [], onlyInOrg: [], mode: 'additive' as const },
          },
          errors: [],
        },
      ],
    };

    expect(renderUserDiffHuman(result)).to.include('+ AddPerm (0PSAdd)');
    expect(renderUserDiffHuman(result)).to.not.include('= KeepPerm');
    expect(renderUserDiffHuman(result, { verbose: true })).to.include('= KeepPerm (0PSKeep)');
  });

  it('rejects verbose output for non-human formats', async () => {
    const fakeConn = makeFakeConnection();
    sinon.stub(UserDiff.prototype as unknown as Record<string, unknown>, 'parse').resolves({
      flags: {
        'target-org': { getConnection: () => fakeConn },
        user: 'Username:new@example.test',
        against: 'Username:template@example.test',
        output: 'csv',
        verbose: true,
        'api-version': undefined,
      },
    } as never);

    try {
      await UserDiff.run(['--json']);
      expect.fail('Expected command to reject verbose non-human output');
    } catch (error) {
      expect(error).to.have.property('message').that.includes('--verbose');
    }
  });

  it('rejects verbose output with global json output', async () => {
    const fakeConn = makeFakeConnection();
    sinon.stub(UserDiff.prototype as unknown as Record<string, unknown>, 'parse').resolves({
      flags: {
        'target-org': { getConnection: () => fakeConn },
        user: 'Username:new@example.test',
        against: 'Username:template@example.test',
        output: 'human',
        verbose: true,
        'api-version': undefined,
      },
    } as never);

    try {
      await UserDiff.run(['--json']);
      expect.fail('Expected command to reject verbose json output');
    } catch (error) {
      expect(error).to.have.property('message').that.includes('--verbose');
    }
  });
});
