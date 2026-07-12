import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TestContext } from '@salesforce/core/testSetup';
import { stubSfCommandUx } from '@salesforce/sf-plugins-core';
import { expect } from 'chai';
import sinon from 'sinon';
import UserFreeze from '../../../src/commands/warden/freeze.js';
import UserRestore from '../../../src/commands/warden/restore.js';
import UserSnapshot from '../../../src/commands/warden/snapshot.js';
import UserStrip from '../../../src/commands/warden/strip.js';
import UserUnfreeze from '../../../src/commands/warden/unfreeze.js';

type FakeConnection = {
  describe: sinon.SinonStub;
  query: sinon.SinonStub;
  sobject: sinon.SinonStub;
  sobjectMap: Record<string, { create: sinon.SinonStub; update: sinon.SinonStub; delete: sinon.SinonStub }>;
};

const makeSuccessResults = (items: unknown, prefix: string): Array<{ success: true; id: string; errors: [] }> => {
  const records = Array.isArray(items) ? items : [items];
  return records.map((_, idx) => ({
    success: true as const,
    id: `${prefix}${String(idx + 1).padStart(13, '0')}AAA`,
    errors: [] as [],
  }));
};

const bulkSuccessStub = (prefix: string): sinon.SinonStub =>
  sinon.stub().callsFake(async (items: unknown) => makeSuccessResults(items, prefix));

const createConnection = (): FakeConnection => {
  const sobjectMap = {
    User: {
      create: bulkSuccessStub('005xx000000000'),
      update: bulkSuccessStub('005xx000000000'),
      delete: bulkSuccessStub('005xx000000000'),
    },
    UserLogin: {
      create: bulkSuccessStub('0LLxx000000000'),
      update: bulkSuccessStub('0LLxx000000000'),
      delete: bulkSuccessStub('0LLxx000000000'),
    },
    PermissionSetAssignment: {
      create: bulkSuccessStub('0PSxx000000000'),
      update: bulkSuccessStub('0PSxx000000000'),
      delete: bulkSuccessStub('0PSxx000000000'),
    },
    GroupMember: {
      create: bulkSuccessStub('0GMxx000000000'),
      update: bulkSuccessStub('0GMxx000000000'),
      delete: bulkSuccessStub('0GMxx000000000'),
    },
    PermissionSetLicenseAssign: {
      create: bulkSuccessStub('0PLxx000000000'),
      update: bulkSuccessStub('0PLxx000000000'),
      delete: bulkSuccessStub('0PLxx000000000'),
    },
  };
  return {
    describe: sinon.stub().resolves({
      fields: [
        { name: 'Username', createable: true, updateable: true, externalId: true },
        { name: 'FederationIdentifier', createable: true, updateable: true, externalId: true },
        { name: 'IsFrozen', createable: true, updateable: true, externalId: false },
        { name: 'IsActive', createable: true, updateable: true, externalId: false },
      ],
    }),
    query: sinon.stub().resolves({ records: [] }),
    sobject: sinon.stub().callsFake((name: string) => sobjectMap[name as keyof typeof sobjectMap] ?? sobjectMap.User),
    sobjectMap,
  };
};

describe('warden user lifecycle commands', () => {
  const $$ = new TestContext();
  let sfCommandStubs: ReturnType<typeof stubSfCommandUx>;

  beforeEach(() => {
    sfCommandStubs = stubSfCommandUx($$.SANDBOX);
  });

  afterEach(() => {
    sinon.restore();
    $$.restore();
  });

  it('freezes a matching user and emits a human summary', async () => {
    const conn = createConnection();
    conn.query.callsFake(async (soql: string) => {
      if (soql.includes("FROM User WHERE Username IN ('freeze@example.com')")) {
        return { records: [{ Id: '005xx0000000001AAA', IsActive: true, Username: 'freeze@example.com' }] };
      }
      if (soql.includes('FROM UserLogin')) {
        return { records: [{ Id: '0LLxx0000000001AAA', UserId: '005xx0000000001AAA', IsFrozen: false }] };
      }
      return { records: [] };
    });

    sinon.stub(UserFreeze.prototype as unknown as Record<string, unknown>, 'parse').resolves({
      flags: {
        'target-org': { getConnection: () => conn },
        user: 'username:freeze@example.com',
        'users-def': undefined,
        'external-id': undefined,
        'no-prompt': true,
        'dry-run': false,
        'api-version': undefined,
      },
    } as never);

    const result = await UserFreeze.run([]);
    expect(result.summary.changed).to.equal(1);
    expect(result.users[0].actions[0].key).to.equal('frozen');
    expect(conn.sobjectMap.UserLogin.update.calledOnce).to.equal(true);
    expect(conn.sobjectMap.UserLogin.update.firstCall.args[1]).to.deep.equal({ allOrNone: false });
    expect(sfCommandStubs.log.calledOnce).to.equal(true);
    expect(String(sfCommandStubs.log.firstCall.args[0])).to.include('Processed 1 user');
  });

  it('unfreezes a matching user in dry-run without DML', async () => {
    const conn = createConnection();
    conn.query.callsFake(async (soql: string) => {
      if (soql.includes("FROM User WHERE Username IN ('unfreeze@example.com')")) {
        return { records: [{ Id: '005xx0000000002AAA', IsActive: true, Username: 'unfreeze@example.com' }] };
      }
      if (soql.includes('FROM UserLogin')) {
        return { records: [{ Id: '0LLxx0000000002AAA', UserId: '005xx0000000002AAA', IsFrozen: true }] };
      }
      return { records: [] };
    });

    sinon.stub(UserUnfreeze.prototype as unknown as Record<string, unknown>, 'parse').resolves({
      flags: {
        'target-org': { getConnection: () => conn },
        user: 'username:unfreeze@example.com',
        'users-def': undefined,
        'external-id': undefined,
        'no-prompt': true,
        'dry-run': true,
        'api-version': undefined,
      },
    } as never);

    const result = await UserUnfreeze.run(['--json']);
    expect(result.users[0].status).to.equal('planned');
    expect(result.users[0].actions[0].key).to.equal('wouldUnfreeze');
    expect(conn.sobjectMap.UserLogin.update.called).to.equal(false);
    expect(sfCommandStubs.log.called).to.equal(false);
  });

  it('strips access with opt-outs and excludes profile-owned permission set assignments', async () => {
    const conn = createConnection();
    conn.query.callsFake(async (soql: string) => {
      if (soql.includes("FROM User WHERE Username IN ('strip@example.com')")) {
        return { records: [{ Id: '005xx0000000003AAA', IsActive: true, Username: 'strip@example.com' }] };
      }
      if (soql.includes('FROM UserLogin')) {
        return { records: [{ Id: '0LLxx0000000003AAA', UserId: '005xx0000000003AAA', IsFrozen: false }] };
      }
      if (soql.includes('FROM PermissionSetAssignment')) {
        return {
          records: [
            {
              Id: '0PSA1',
              AssigneeId: '005xx0000000003AAA',
              PermissionSetGroupId: null,
              PermissionSetId: '0PS1',
              PermissionSet: { IsOwnedByProfile: false },
            },
            {
              Id: '0PSA2',
              AssigneeId: '005xx0000000003AAA',
              PermissionSetGroupId: null,
              PermissionSetId: '0PS2',
              PermissionSet: { IsOwnedByProfile: true },
            },
            {
              Id: '0PSA3',
              AssigneeId: '005xx0000000003AAA',
              PermissionSetGroupId: '0PG1',
            },
          ],
        };
      }
      if (soql.includes('FROM GroupMember')) {
        return {
          records: [
            { Id: '0GM1', UserOrGroupId: '005xx0000000003AAA', Group: { Type: 'Regular' } },
            { Id: '0GM2', UserOrGroupId: '005xx0000000003AAA', Group: { Type: 'Queue' } },
          ],
        };
      }
      if (soql.includes('FROM PermissionSetLicenseAssign')) {
        return {
          records: [{ Id: '0PL1', AssigneeId: '005xx0000000003AAA' }],
        };
      }
      return { records: [] };
    });

    sinon.stub(UserStrip.prototype as unknown as Record<string, unknown>, 'parse').resolves({
      flags: {
        'target-org': { getConnection: () => conn },
        user: 'username:strip@example.com',
        'users-def': undefined,
        'external-id': undefined,
        'no-prompt': true,
        'dry-run': true,
        'no-freeze': false,
        'no-deactivate': false,
        'keep-permsets': false,
        'keep-permset-groups': false,
        'keep-licenses': true,
        'keep-public-groups': false,
        'keep-queues': false,
        'api-version': undefined,
      },
    } as never);

    const result = await UserStrip.run(['--json']);
    const actions = result.users[0].actions.map((action) => `${action.key}${action.count ? `:${action.count}` : ''}`);
    expect(actions).to.include('wouldFreeze');
    expect(actions).to.include('wouldRemovePermissionSet:1');
    expect(actions).to.include('wouldRemovePermissionSetGroup:1');
    expect(actions).to.include('wouldRemovePublicGroupMember:1');
    expect(actions).to.include('wouldRemoveQueueMember:1');
    expect(actions).to.include('wouldDeactivate');
    expect(result.users[0].skipped.some((notice) => notice.key === 'skippedPermissionSetLicenses')).to.equal(true);
    expect(result.users[0].skipped.some((notice) => notice.key === 'skippedProfileOwnedPermissionSets')).to.equal(true);
    expect(conn.sobjectMap.UserLogin.update.called).to.equal(false);
    expect(conn.sobjectMap.PermissionSetAssignment.delete.called).to.equal(false);
    expect(conn.sobjectMap.GroupMember.delete.called).to.equal(false);
    expect(conn.sobjectMap.PermissionSetLicenseAssign.delete.called).to.equal(false);
  });

  it('snapshots assignment state with portable names and excludes profile-owned permission sets', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'warden-snapshot-test-'));
    const out = join(dir, 'snapshot.json');
    const conn = createConnection();
    conn.query.callsFake(async (soql: string) => {
      if (soql.includes("FROM User WHERE Username IN ('snapshot@example.com')")) {
        return { records: [{ Id: '005xx0000000100AAA', IsActive: true, Username: 'snapshot@example.com' }] };
      }
      if (soql.includes('FROM UserLogin')) {
        return { records: [{ Id: '0LL100', UserId: '005xx0000000100AAA', IsFrozen: true }] };
      }
      if (soql.includes('FROM PermissionSetAssignment')) {
        return {
          records: [
            {
              Id: '0Pa100',
              AssigneeId: '005xx0000000100AAA',
              PermissionSetId: '0PS100',
              PermissionSetGroupId: null,
              PermissionSet: { IsOwnedByProfile: false },
            },
            {
              Id: '0Pa101',
              AssigneeId: '005xx0000000100AAA',
              PermissionSetId: '0PS101',
              PermissionSetGroupId: null,
              PermissionSet: { IsOwnedByProfile: true },
            },
            {
              Id: '0Pa102',
              AssigneeId: '005xx0000000100AAA',
              PermissionSetId: null,
              PermissionSetGroupId: '0PG100',
            },
          ],
        };
      }
      if (soql.includes('FROM GroupMember')) {
        return {
          records: [
            { Id: '0GM100', GroupId: '00G100', UserOrGroupId: '005xx0000000100AAA', Group: { Type: 'Regular' } },
            { Id: '0GM101', GroupId: '00G101', UserOrGroupId: '005xx0000000100AAA', Group: { Type: 'Queue' } },
          ],
        };
      }
      if (soql.includes('FROM PermissionSetLicenseAssign')) {
        return { records: [{ Id: '0PL100', AssigneeId: '005xx0000000100AAA', PermissionSetLicenseId: '0PLic100' }] };
      }
      if (soql.includes('FROM PermissionSet WHERE')) return { records: [{ Id: '0PS100', Name: 'Sales_Perms' }] };
      if (soql.includes('FROM PermissionSetGroup')) {
        return { records: [{ Id: '0PG100', DeveloperName: 'Sales_Group' }] };
      }
      if (soql.includes("FROM Group WHERE Id IN ('00G100')")) {
        return { records: [{ Id: '00G100', DeveloperName: 'All_Sales' }] };
      }
      if (soql.includes("FROM Group WHERE Id IN ('00G101')")) {
        return { records: [{ Id: '00G101', DeveloperName: 'Case_Queue' }] };
      }
      if (soql.includes('FROM PermissionSetLicense')) {
        return { records: [{ Id: '0PLic100', DeveloperName: 'SalesConsoleUser' }] };
      }
      return { records: [] };
    });

    sinon.stub(UserSnapshot.prototype as unknown as Record<string, unknown>, 'parse').resolves({
      flags: {
        'target-org': { getConnection: () => conn, getUsername: () => 'snapshotOrg@example.com' },
        user: 'username:snapshot@example.com',
        'users-def': undefined,
        'external-id': undefined,
        out,
        'api-version': undefined,
      },
    } as never);

    const result = await UserSnapshot.run(['--json']);
    const snapshot = JSON.parse(readFileSync(out, 'utf8')) as { org?: string; users: Array<Record<string, unknown>> };
    expect(result.summary.changed).to.equal(0);
    expect(result.users[0].status).to.equal('unchanged');
    expect(snapshot.org).to.equal('snapshotOrg@example.com');
    expect(snapshot.users[0].permissionSets).to.deep.equal(['Sales_Perms']);
    expect(snapshot.users[0].permissionSetGroups).to.deep.equal(['Sales_Group']);
    expect(snapshot.users[0].publicGroups).to.deep.equal(['All_Sales']);
    expect(snapshot.users[0].queues).to.deep.equal(['Case_Queue']);
    expect(snapshot.users[0].permissionSetLicenses).to.deep.equal(['SalesConsoleUser']);
    expect(snapshot.users[0].IsActive).to.equal(true);
    expect(snapshot.users[0].IsFrozen).to.equal(true);
  });

  it('restores only missing snapshot assignments and skips DML in dry-run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'warden-restore-test-'));
    const snapshotPath = join(dir, 'snapshot.json');
    writeFileSync(
      snapshotPath,
      JSON.stringify({
        snapshotVersion: 1,
        capturedAt: '2026-07-05T12:00:00.000Z',
        users: [
          {
            match: 'Username',
            matchValue: 'restore@example.com',
            userId: '005old',
            IsActive: true,
            IsFrozen: false,
            permissionSets: ['Existing_Perms', 'Missing_Perms'],
            permissionSetGroups: ['Missing_Group'],
            publicGroups: ['Existing_Public', 'Missing_Public'],
            queues: ['Missing_Queue'],
            permissionSetLicenses: ['MissingLicense'],
          },
        ],
      })
    );
    const conn = createConnection();
    conn.query.callsFake(async (soql: string) => {
      if (soql.includes("FROM User WHERE Username IN ('restore@example.com')")) {
        return { records: [{ Id: '005xx0000000200AAA', IsActive: false, Username: 'restore@example.com' }] };
      }
      if (soql.includes('FROM UserLogin')) {
        return { records: [{ Id: '0LL200', UserId: '005xx0000000200AAA', IsFrozen: true }] };
      }
      if (soql.includes('FROM PermissionSetAssignment WHERE AssigneeId')) {
        return {
          records: [
            {
              Id: '0Pa200',
              AssigneeId: '005xx0000000200AAA',
              PermissionSetId: '0PSExisting',
              PermissionSetGroupId: null,
              PermissionSet: { IsOwnedByProfile: false },
            },
          ],
        };
      }
      if (soql.includes('FROM GroupMember')) {
        return {
          records: [
            {
              Id: '0GM200',
              GroupId: '00GExistingPublic',
              UserOrGroupId: '005xx0000000200AAA',
              Group: { Type: 'Regular' },
            },
          ],
        };
      }
      if (soql.includes('FROM PermissionSetLicenseAssign')) return { records: [] };
      if (soql.includes('FROM PermissionSet WHERE Name IN')) {
        return {
          records: [
            { Id: '0PSExisting', Name: 'Existing_Perms' },
            { Id: '0PSMissing', Name: 'Missing_Perms' },
          ],
        };
      }
      if (soql.includes('FROM PermissionSetGroup')) {
        return { records: [{ Id: '0PGMissing', DeveloperName: 'Missing_Group' }] };
      }
      if (soql.includes("FROM Group WHERE DeveloperName IN ('Existing_Public','Missing_Public')")) {
        return {
          records: [
            { Id: '00GExistingPublic', DeveloperName: 'Existing_Public' },
            { Id: '00GMissingPublic', DeveloperName: 'Missing_Public' },
          ],
        };
      }
      if (soql.includes("FROM Group WHERE DeveloperName IN ('Missing_Queue')")) {
        return { records: [{ Id: '00GMissingQueue', DeveloperName: 'Missing_Queue' }] };
      }
      if (soql.includes('FROM PermissionSetLicense')) {
        return { records: [{ Id: '0PLicMissing', DeveloperName: 'MissingLicense' }] };
      }
      return { records: [] };
    });

    sinon.stub(UserRestore.prototype as unknown as Record<string, unknown>, 'parse').resolves({
      flags: {
        'target-org': { getConnection: () => conn },
        snapshot: snapshotPath,
        'no-prompt': true,
        'dry-run': true,
        'api-version': undefined,
      },
    } as never);

    const result = await UserRestore.run(['--json']);
    const actions = result.users[0].actions.map((action) => `${action.key}${action.count ? `:${action.count}` : ''}`);
    expect(actions).to.include.members([
      'wouldActivate',
      'wouldUnfreeze',
      'wouldAssignPermissionSet:1',
      'wouldAssignPermissionSetGroup:1',
      'wouldAddPublicGroupMember:1',
      'wouldAddQueueMember:1',
      'wouldAssignPermissionSetLicense:1',
    ]);
    expect(conn.sobjectMap.User.update.called).to.equal(false);
    expect(conn.sobjectMap.UserLogin.update.called).to.equal(false);
    expect(conn.sobjectMap.PermissionSetAssignment.create.called).to.equal(false);
    expect(conn.sobjectMap.GroupMember.create.called).to.equal(false);
    expect(conn.sobjectMap.PermissionSetLicenseAssign.create.called).to.equal(false);
  });

  it('writes a strip snapshot during dry-run without removal DML', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'warden-strip-snapshot-test-'));
    const snapshotPath = join(dir, 'snapshot.json');
    const conn = createConnection();
    conn.query.callsFake(async (soql: string) => {
      if (soql.includes("FROM User WHERE Username IN ('strip-snapshot@example.com')")) {
        return { records: [{ Id: '005xx0000000300AAA', IsActive: true, Username: 'strip-snapshot@example.com' }] };
      }
      if (soql.includes('FROM UserLogin')) {
        return { records: [{ Id: '0LL300', UserId: '005xx0000000300AAA', IsFrozen: false }] };
      }
      if (soql.includes('FROM PermissionSetAssignment')) {
        return {
          records: [
            {
              Id: '0Pa300',
              AssigneeId: '005xx0000000300AAA',
              PermissionSetId: '0PS300',
              PermissionSetGroupId: null,
              PermissionSet: { IsOwnedByProfile: false },
            },
          ],
        };
      }
      if (soql.includes('FROM GroupMember')) return { records: [] };
      if (soql.includes('FROM PermissionSetLicenseAssign')) return { records: [] };
      if (soql.includes('FROM PermissionSet WHERE')) return { records: [{ Id: '0PS300', Name: 'Strip_Perms' }] };
      return { records: [] };
    });

    sinon.stub(UserStrip.prototype as unknown as Record<string, unknown>, 'parse').resolves({
      flags: {
        'target-org': { getConnection: () => conn, getUsername: () => 'stripOrg@example.com' },
        user: 'username:strip-snapshot@example.com',
        'users-def': undefined,
        'external-id': undefined,
        'no-prompt': true,
        'dry-run': true,
        'no-freeze': false,
        'no-deactivate': false,
        'keep-permsets': false,
        'keep-permset-groups': false,
        'keep-licenses': false,
        'keep-public-groups': false,
        'keep-queues': false,
        snapshot: snapshotPath,
        'api-version': undefined,
      },
    } as never);

    const result = await UserStrip.run(['--json']);
    const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8')) as {
      org?: string;
      users: Array<Record<string, unknown>>;
    };
    expect(result.users[0].actions.map((action) => action.key)).to.include('snapshotWritten');
    expect(snapshot.org).to.equal('stripOrg@example.com');
    expect(snapshot.users[0].permissionSets).to.deep.equal(['Strip_Perms']);
    expect(conn.sobjectMap.PermissionSetAssignment.delete.called).to.equal(false);
    expect(conn.sobjectMap.User.update.called).to.equal(false);
  });

  it('does not write a strip snapshot when confirmation is declined', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'warden-strip-snapshot-declined-test-'));
    const snapshotPath = join(dir, 'snapshot.json');
    const conn = createConnection();
    conn.query.callsFake(async (soql: string) => {
      if (soql.includes("FROM User WHERE Username IN ('strip-decline@example.com')")) {
        return { records: [{ Id: '005xx0000000350AAA', IsActive: true, Username: 'strip-decline@example.com' }] };
      }
      if (soql.includes('FROM UserLogin')) {
        return { records: [{ Id: '0LL350', UserId: '005xx0000000350AAA', IsFrozen: false }] };
      }
      return { records: [] };
    });

    sinon.stub(UserStrip.prototype as unknown as Record<string, unknown>, 'parse').resolves({
      flags: {
        'target-org': { getConnection: () => conn, getUsername: () => 'stripOrg@example.com' },
        user: 'username:strip-decline@example.com',
        'users-def': undefined,
        'external-id': undefined,
        'no-prompt': false,
        'dry-run': false,
        'no-freeze': false,
        'no-deactivate': false,
        'keep-permsets': false,
        'keep-permset-groups': false,
        'keep-licenses': false,
        'keep-public-groups': false,
        'keep-queues': false,
        snapshot: snapshotPath,
        'api-version': undefined,
      },
    } as never);
    sinon.stub(UserStrip.prototype as unknown as Record<string, unknown>, 'confirm').resolves(false);

    try {
      await UserStrip.run([]);
      expect.fail('Expected strip to be cancelled.');
    } catch (error) {
      expect(error).to.have.property('message', 'Operation cancelled.');
    }
    expect(existsSync(snapshotPath)).to.equal(false);
    expect(conn.sobjectMap.UserLogin.update.called).to.equal(false);
  });

  it('round-trips snapshot output into restore dry-run planning', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'warden-roundtrip-test-'));
    const snapshotPath = join(dir, 'snapshot.json');
    const conn = createConnection();
    conn.query.callsFake(async (soql: string) => {
      if (soql.includes("FROM User WHERE Username IN ('roundtrip@example.com')")) {
        return { records: [{ Id: '005xx0000000400AAA', IsActive: false, Username: 'roundtrip@example.com' }] };
      }
      if (soql.includes('FROM UserLogin')) {
        return { records: [{ Id: '0LL400', UserId: '005xx0000000400AAA', IsFrozen: true }] };
      }
      if (soql.includes('FROM PermissionSetAssignment WHERE AssigneeId')) {
        return {
          records: [
            {
              Id: '0Pa400',
              AssigneeId: '005xx0000000400AAA',
              PermissionSetId: '0PS400',
              PermissionSetGroupId: null,
              PermissionSet: { IsOwnedByProfile: false },
            },
          ],
        };
      }
      if (soql.includes('FROM GroupMember')) return { records: [] };
      if (soql.includes('FROM PermissionSetLicenseAssign')) return { records: [] };
      if (soql.includes('FROM PermissionSet WHERE Id IN'))
        return { records: [{ Id: '0PS400', Name: 'Roundtrip_Perms' }] };
      if (soql.includes('FROM PermissionSet WHERE Name IN'))
        return { records: [{ Id: '0PS400', Name: 'Roundtrip_Perms' }] };
      return { records: [] };
    });

    const snapshotParseStub = sinon
      .stub(UserSnapshot.prototype as unknown as Record<string, unknown>, 'parse')
      .resolves({
        flags: {
          'target-org': { getConnection: () => conn, getUsername: () => 'roundtripOrg@example.com' },
          user: 'username:roundtrip@example.com',
          'users-def': undefined,
          'external-id': undefined,
          out: snapshotPath,
          'api-version': undefined,
        },
      } as never);
    await UserSnapshot.run(['--json']);
    snapshotParseStub.restore();

    sinon.stub(UserRestore.prototype as unknown as Record<string, unknown>, 'parse').resolves({
      flags: {
        'target-org': { getConnection: () => conn },
        snapshot: snapshotPath,
        'no-prompt': true,
        'dry-run': true,
        'api-version': undefined,
      },
    } as never);

    const result = await UserRestore.run(['--json']);
    expect(result.users[0].actions.map((action) => action.key)).to.include.members(['wouldActivate', 'wouldUnfreeze']);
    expect(result.users[0].warnings).to.deep.equal([]);
    expect(conn.sobjectMap.PermissionSetAssignment.create.called).to.equal(false);
  });

  it('warns and skips missing restore references while continuing the batch', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'warden-restore-missing-ref-test-'));
    const snapshotPath = join(dir, 'snapshot.json');
    writeFileSync(
      snapshotPath,
      JSON.stringify({
        snapshotVersion: 1,
        capturedAt: '2026-07-05T12:00:00.000Z',
        users: [
          {
            match: 'Username',
            matchValue: 'missing-ref@example.com',
            userId: '005old',
            IsActive: true,
            IsFrozen: false,
            permissionSets: ['Missing_Perms'],
            permissionSetGroups: [],
            publicGroups: [],
            queues: [],
            permissionSetLicenses: [],
          },
        ],
      })
    );
    const conn = createConnection();
    conn.query.callsFake(async (soql: string) => {
      if (soql.includes("FROM User WHERE Username IN ('missing-ref@example.com')")) {
        return { records: [{ Id: '005xx0000000500AAA', IsActive: true, Username: 'missing-ref@example.com' }] };
      }
      return { records: [] };
    });

    sinon.stub(UserRestore.prototype as unknown as Record<string, unknown>, 'parse').resolves({
      flags: {
        'target-org': { getConnection: () => conn },
        snapshot: snapshotPath,
        'no-prompt': true,
        'dry-run': true,
        'api-version': undefined,
      },
    } as never);

    const result = await UserRestore.run(['--json']);
    expect(result.users[0].status).to.equal('unchanged');
    expect(result.users[0].warnings[0]).to.include('Missing PermissionSet reference "Missing_Perms"');
    expect(conn.sobjectMap.PermissionSetAssignment.create.called).to.equal(false);
  });

  it('strips access in freeze-first, license-safe order on the real DML path', async () => {
    const events: string[] = [];
    const conn = createConnection();
    conn.query.callsFake(async (soql: string) => {
      if (soql.includes("FROM User WHERE Username IN ('strip-live@example.com')")) {
        return { records: [{ Id: '005xx0000000004AAA', IsActive: true, Username: 'strip-live@example.com' }] };
      }
      if (soql.includes('FROM UserLogin')) {
        return { records: [{ Id: '0LLxx0000000004AAA', UserId: '005xx0000000004AAA', IsFrozen: false }] };
      }
      if (soql.includes('FROM PermissionSetAssignment')) {
        return {
          records: [
            {
              Id: '0PSA10',
              AssigneeId: '005xx0000000004AAA',
              PermissionSetGroupId: null,
              PermissionSetId: '0PS10',
              PermissionSet: { IsOwnedByProfile: false },
            },
            {
              Id: '0PSA11',
              AssigneeId: '005xx0000000004AAA',
              PermissionSetGroupId: null,
              PermissionSetId: '0PS11',
              PermissionSet: { IsOwnedByProfile: true },
            },
            {
              Id: '0PSA12',
              AssigneeId: '005xx0000000004AAA',
              PermissionSetGroupId: '0PG10',
            },
          ],
        };
      }
      if (soql.includes('FROM GroupMember')) {
        return {
          records: [
            { Id: '0GM10', UserOrGroupId: '005xx0000000004AAA', Group: { Type: 'Regular' } },
            { Id: '0GM11', UserOrGroupId: '005xx0000000004AAA', Group: { Type: 'Queue' } },
          ],
        };
      }
      if (soql.includes('FROM PermissionSetLicenseAssign')) {
        return { records: [{ Id: '0PL10', AssigneeId: '005xx0000000004AAA' }] };
      }
      return { records: [] };
    });

    const makeWriteStub = (name: string, action: 'update' | 'delete') =>
      sinon.stub().callsFake(async (items: unknown) => {
        events.push(`${name}.${action}`);
        return makeSuccessResults(
          items,
          name === 'UserLogin' ? '0LLxx0000000000' : name === 'User' ? '005xx0000000000' : '0Xx0000000000'
        );
      });
    const sobjectMap = {
      User: { update: makeWriteStub('User', 'update'), delete: makeWriteStub('User', 'delete') },
      UserLogin: { update: makeWriteStub('UserLogin', 'update'), delete: makeWriteStub('UserLogin', 'delete') },
      PermissionSetAssignment: {
        update: makeWriteStub('PermissionSetAssignment', 'update'),
        delete: makeWriteStub('PermissionSetAssignment', 'delete'),
      },
      GroupMember: { update: makeWriteStub('GroupMember', 'update'), delete: makeWriteStub('GroupMember', 'delete') },
      PermissionSetLicenseAssign: {
        update: makeWriteStub('PermissionSetLicenseAssign', 'update'),
        delete: makeWriteStub('PermissionSetLicenseAssign', 'delete'),
      },
    };
    conn.sobject.callsFake((name: string) => sobjectMap[name as keyof typeof sobjectMap] ?? sobjectMap.User);

    sinon.stub(UserStrip.prototype as unknown as Record<string, unknown>, 'parse').resolves({
      flags: {
        'target-org': { getConnection: () => conn },
        user: 'username:strip-live@example.com',
        'users-def': undefined,
        'external-id': undefined,
        'no-prompt': true,
        'dry-run': false,
        'no-freeze': false,
        'no-deactivate': false,
        'keep-permsets': false,
        'keep-permset-groups': false,
        'keep-licenses': false,
        'keep-public-groups': false,
        'keep-queues': false,
        'api-version': undefined,
      },
    } as never);

    const result = await UserStrip.run(['--json']);
    expect(events).to.deep.equal([
      'UserLogin.update',
      'PermissionSetAssignment.delete',
      'PermissionSetAssignment.delete',
      'GroupMember.delete',
      'GroupMember.delete',
      'PermissionSetLicenseAssign.delete',
      'User.update',
    ]);
    expect(sobjectMap.PermissionSetAssignment.delete.firstCall.args[0]).to.have.length(1);
    expect(sobjectMap.PermissionSetAssignment.delete.secondCall.args[0]).to.have.length(1);
    expect(sobjectMap.GroupMember.delete.firstCall.args[0]).to.have.length(1);
    expect(sobjectMap.GroupMember.delete.secondCall.args[0]).to.have.length(1);
    expect(result.users[0].actions.map((action) => action.key)).to.include.members([
      'frozen',
      'removedPermissionSet',
      'removedPermissionSetGroup',
      'removedPublicGroupMember',
      'removedQueueMember',
      'removedPermissionSetLicense',
      'deactivated',
    ]);
    expect(result.users[0].skipped.some((notice) => notice.key === 'skippedProfileOwnedPermissionSets')).to.equal(true);
  });

  it('keeps failed strip targets aligned with later successes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'warden-strip-test-'));
    const usersPath = join(dir, 'users.json');
    writeFileSync(
      usersPath,
      JSON.stringify({
        users: [
          { match: 'Username', Username: 'missing@example.com' },
          { match: 'Username', Username: 'good@example.com' },
        ],
      })
    );

    const conn = createConnection();
    conn.query.callsFake(async (soql: string) => {
      if (soql.includes("FROM User WHERE Username IN ('missing@example.com','good@example.com')")) {
        return { records: [{ Id: '005xx0000000005AAA', IsActive: true, Username: 'good@example.com' }] };
      }
      if (soql.includes('FROM UserLogin')) {
        return { records: [{ Id: '0LLxx0000000005AAA', UserId: '005xx0000000005AAA', IsFrozen: false }] };
      }
      return { records: [] };
    });

    const sobjectMap = {
      User: {
        update: sinon.stub().callsFake(async (items: unknown) => makeSuccessResults(items, '005xx0000000000')),
        delete: sinon.stub(),
      },
      UserLogin: {
        update: sinon.stub().callsFake(async (items: unknown) => makeSuccessResults(items, '0LLxx0000000000')),
        delete: sinon.stub(),
      },
      PermissionSetAssignment: { update: sinon.stub(), delete: sinon.stub() },
      GroupMember: { update: sinon.stub(), delete: sinon.stub() },
      PermissionSetLicenseAssign: { update: sinon.stub(), delete: sinon.stub() },
    };
    conn.sobject.callsFake((name: string) => sobjectMap[name as keyof typeof sobjectMap] ?? sobjectMap.User);

    sinon.stub(UserStrip.prototype as unknown as Record<string, unknown>, 'parse').resolves({
      flags: {
        'target-org': { getConnection: () => conn },
        'users-def': usersPath,
        'external-id': undefined,
        'no-prompt': true,
        'dry-run': false,
        'no-freeze': false,
        'no-deactivate': true,
        'keep-permsets': true,
        'keep-permset-groups': true,
        'keep-licenses': true,
        'keep-public-groups': true,
        'keep-queues': true,
        'api-version': undefined,
      },
    } as never);

    const result = await UserStrip.run(['--json']);
    expect(result.users[0].status).to.equal('failed');
    expect(result.users[0].errors.join(' ')).to.include('matched no user');
    expect(result.users[1].status).to.equal('changed');
    expect(result.users[1].actions.map((action) => action.key)).to.include('frozen');
    expect(sobjectMap.UserLogin.update.calledOnce).to.equal(true);
  });
});
