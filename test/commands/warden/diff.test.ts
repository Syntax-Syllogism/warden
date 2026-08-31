import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TestContext } from '@salesforce/core/testSetup';
import { stubSfCommandUx } from '@salesforce/sf-plugins-core';
import { expect } from 'chai';
import sinon from 'sinon';
import UserDiff from '../../../src/commands/warden/diff.js';
import {
  executePersonaDiff,
  type UserDiffResult,
} from '../../../src/userLifecycle/userDiff.js';
import { renderUserDiffCsv, renderUserDiffHuman } from '../../../src/userLifecycle/diffOutput.js';
import {
  renderUserConformanceCsv,
  renderUserConformanceHuman,
  verifyUserDiff,
} from '../../../src/userLifecycle/conformance.js';

type FakeConnection = {
  describe: sinon.SinonStub;
  query: sinon.SinonStub;
  sobject: sinon.SinonStub;
};

const userFields = [
  { name: 'Username', createable: true, updateable: true, filterable: true, externalId: false },
  { name: 'FederationIdentifier', createable: true, updateable: true, filterable: true, externalId: true },
  { name: 'ProfileId', createable: true, updateable: true, filterable: true, externalId: false },
  { name: 'UserRoleId', createable: true, updateable: true, filterable: true, externalId: false },
  { name: 'LastName', createable: true, updateable: true, filterable: true, externalId: false },
];

const makeFakeConnection = (): FakeConnection => ({
  describe: sinon.stub().resolves({ fields: userFields }),
  query: sinon.stub().resolves({ records: [] }),
  sobject: sinon.stub(),
});

const diffLookup = (key: string, args: string[] = []): string => {
  const messages: Record<string, string> = {
    'info.summary': `Compared ${args[0]} users: ${args[1]} with drift, ${args[2]} failed.`,
    'verify.summary': `Verified ${args[0]} users: ${args[1]} conformant, ${args[2]} non-conformant.`,
    'verify.user': `${args[0]}: non-conformant`,
    'verify.violation.notFound': 'user not found',
    'verify.violation.error': `error: ${args[0]}`,
    'verify.violation.missing': `${args[0]} missing: ${args[1]}`,
    'verify.violation.extra': `${args[0]} extra (sync): ${args[1]}`,
    'verify.violation.profile': `profile mismatch: ${args[0]} -> ${args[1]}`,
    'verify.violation.role': `role mismatch: ${args[0]} -> ${args[1]}`,
  };
  return messages[key] ?? key;
};

const runDiff = async (args: string[] = []): Promise<UserDiffResult> => {
  const result = await UserDiff.run(args);
  if (Array.isArray(result)) throw new Error('Expected a diff result, received verify verdicts.');
  return result;
};

describe('warden user diff command', () => {
  const $$ = new TestContext();
  let sfCommandStubs: ReturnType<typeof stubSfCommandUx>;

  beforeEach(() => {
    sfCommandStubs = stubSfCommandUx($$.SANDBOX);
  });

  afterEach(() => {
    process.exitCode = undefined;
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
      if (soql.includes('SELECT Id, ProfileId, Profile.Name, UserRoleId, UserRole.Name FROM User WHERE Id IN'))
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
              PermissionSet: { IsOwnedByProfile: false, Name: 'Current_Perms', Label: 'Current Permissions' },
            },
            {
              Id: '0PaRemove',
              AssigneeId: '005User00000001',
              PermissionSetId: '0PSPermRemove',
              PermissionSetGroupId: null,
              PermissionSet: { IsOwnedByProfile: false, Name: 'Shared_Perms', Label: 'Shared Permissions' },
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
        'fail-on-drift': true,
        'api-version': undefined,
      },
    } as never);

    const result = await runDiff(['--json']);
    expect(result.summary.changed).to.equal(1);
    expect(process.exitCode).to.equal(1);
    expect(result.users[0].profile.matches).to.equal(false);
    expect(result.users[0].role.matches).to.equal(true);
    expect(result.users[0].assignments.permissionSets.adds).to.deep.equal(['0PSPermAdd0002']);
    expect(result.users[0].assignments.permissionSets.removes).to.deep.equal(['0PSPermRemove']);
    expect(result.users[0].assignments.permissionSets.inBoth).to.deep.equal(['0PSPermKeep0001']);
    expect(result.users[0].assignments.permissionSets.onlyInOrg).to.deep.equal([]);
    expect(
      result.rows
        .filter((row) => row.category === 'permissionSets' && row.value === '0PSPermRemove')
        .map((row) => row.kind)
    ).to.deep.equal(['remove']);
    expect(result.users[0].assignments.permissionSetGroups.adds).to.deep.equal(['0PGGroupAdd0001']);
    expect(result.users[0].assignments.queues.adds).to.deep.equal(['00GQueueAdd0002']);
    expect(result.users[0].assignments.queues.removes).to.deep.equal([]);
    expect(result.users[0].assignments.queues.onlyInOrg).to.include('00GQueueExtra');
    expect(
      result.rows
        .filter((row) => row.category === 'queues' && row.value === '00GQueueExtra')
        .map((row) => row.kind)
    ).to.deep.equal(['onlyInOrg']);
    expect(fakeConn.sobject.called).to.equal(false);
  });

  it('reads a CSV users-def through diff with an explicit format override', async () => {
    const fakeConn = makeFakeConnection();
    const dir = mkdtempSync(join(tmpdir(), 'warden-diff-csv-input-test-'));
    const usersPath = join(dir, 'users.json');
    writeFileSync(usersPath, 'Username\ncsv@example.test\n');
    sinon.stub(UserDiff.prototype as unknown as Record<string, unknown>, 'parse').resolves({
      flags: {
        'target-org': { getConnection: () => fakeConn },
        'users-def': usersPath,
        'personas-def': undefined,
        'external-id': undefined,
        'input-format': 'csv',
        'csv-list-delimiter': undefined,
        output: 'human',
        verbose: false,
        verify: false,
        'fail-on-drift': false,
        'api-version': undefined,
      },
    } as never);

    const result = await runDiff([]);
    expect(result.summary.wouldCreate).to.equal(1);
    expect(result.users[0].key).to.equal('csv@example.test');
  });

  it('keeps the CSV physical line on persona validation errors', async () => {
    const fakeConn = makeFakeConnection();
    const dir = mkdtempSync(join(tmpdir(), 'warden-diff-csv-line-test-'));
    const usersPath = join(dir, 'users.csv');
    const personasPath = join(dir, 'personas.json');
    writeFileSync(usersPath, 'personas,Username\nmissing-persona,csv@example.test\n');
    writeFileSync(personasPath, JSON.stringify({ personas: {} }));
    sinon.stub(UserDiff.prototype as unknown as Record<string, unknown>, 'parse').resolves({
      flags: {
        'target-org': { getConnection: () => fakeConn },
        'users-def': usersPath,
        'personas-def': personasPath,
        'external-id': undefined,
        'input-format': undefined,
        'csv-list-delimiter': undefined,
        output: 'human',
        verbose: false,
        verify: false,
        'fail-on-drift': false,
        'api-version': undefined,
      },
    } as never);

    const result = await runDiff([]);
    expect(result.users[0].errors[0]).to.include(`${usersPath}:2 — Unknown persona "missing-persona".`);
  });

  it('maps persona deltas to conformance violations', () => {
    const emptyCategory = (mode: 'additive' | 'sync') => ({
      adds: [],
      removes: [],
      inBoth: [],
      onlyInOrg: [],
      mode,
    });
    const result: UserDiffResult = {
      summary: { total: 4, compared: 3, wouldCreate: 1, failed: 0, changed: 1 },
      warnings: [],
      rows: [],
      users: [
        {
          key: 'conformant',
          status: 'compared',
          profile: { matches: true },
          role: { matches: true },
          assignments: {
            permissionSets: emptyCategory('additive'),
            permissionSetGroups: emptyCategory('additive'),
            publicGroups: emptyCategory('additive'),
            queues: emptyCategory('additive'),
          },
          errors: [],
        },
        {
          key: 'sync-drift',
          status: 'compared',
          profile: { current: 'CurrentProfile', intended: 'TargetProfile', matches: false },
          role: { current: 'CurrentRole', intended: 'TargetRole', matches: false },
          assignments: {
            permissionSets: {
              adds: ['MissingPerm'],
              removes: ['ExtraPerm'],
              inBoth: [],
              onlyInOrg: [],
              mode: 'sync',
            },
            permissionSetGroups: {
              ...emptyCategory('additive'),
              onlyInOrg: ['AdditiveExtra'],
            },
            publicGroups: emptyCategory('additive'),
            queues: emptyCategory('additive'),
          },
          errors: [],
        },
        {
          key: 'missing-user',
          status: 'would-create',
          profile: { matches: true },
          role: { matches: true },
          assignments: {
            permissionSets: emptyCategory('sync'),
            permissionSetGroups: emptyCategory('additive'),
            publicGroups: emptyCategory('additive'),
            queues: emptyCategory('additive'),
          },
          errors: [],
        },
      ],
    };

    const verdicts = verifyUserDiff(result, diffLookup);
    expect(verdicts).to.deep.include.members([
      { key: 'conformant', conformant: true, violations: [] },
      { key: 'missing-user', conformant: false, violations: ['user not found'] },
    ]);
    expect(verdicts.find((verdict) => verdict.key === 'sync-drift')).to.deep.equal({
      key: 'sync-drift',
      conformant: false,
      violations: [
        'profile mismatch: CurrentProfile -> TargetProfile',
        'role mismatch: CurrentRole -> TargetRole',
        'permissionSets missing: MissingPerm',
        'permissionSets extra (sync): ExtraPerm',
      ],
    });
    expect(renderUserConformanceHuman(verdicts, diffLookup)).to.include('Verified 3 users: 1 conformant, 2 non-conformant.');
    expect(renderUserConformanceHuman(verdicts, diffLookup)).to.include('permissionSets extra (sync): ExtraPerm');
    expect(renderUserConformanceHuman(verdicts, diffLookup)).to.not.include('AdditiveExtra');
    expect(renderUserConformanceCsv(verdicts)).to.include('key,conformant,violations');
    expect(renderUserConformanceCsv(verdicts)).to.include('sync-drift,false,');
  });

  it('returns verify verdicts and sets a non-zero exit for a missing user', async () => {
    const fakeConn = makeFakeConnection();
    const dir = mkdtempSync(join(tmpdir(), 'warden-diff-test-'));
    const usersPath = join(dir, 'users.json');
    const personasPath = join(dir, 'personas.json');
    writeFileSync(
      usersPath,
      JSON.stringify({ users: [{ personas: ['support'], FederationIdentifier: 'A004', LastName: 'User' }] })
    );
    writeFileSync(personasPath, JSON.stringify({ personas: { support: {} } }));
    sinon.stub(UserDiff.prototype as unknown as Record<string, unknown>, 'parse').resolves({
      flags: {
        'target-org': { getConnection: () => fakeConn },
        'users-def': usersPath,
        'personas-def': personasPath,
        'external-id': 'FederationIdentifier',
        output: 'human',
        verify: true,
        'fail-on-drift': false,
        'api-version': undefined,
      },
    } as never);

    const result = await UserDiff.run(['--json']);
    expect(result).to.deep.equal([{ key: 'A004', conformant: false, violations: ['user not found'] }]);
    expect(sfCommandStubs.log.called).to.equal(false);
    expect(process.exitCode).to.equal(1);
  });

  it('emits failed-user verdicts for direct and global JSON output', async () => {
    const fakeConn = makeFakeConnection();
    const dir = mkdtempSync(join(tmpdir(), 'warden-diff-test-'));
    const usersPath = join(dir, 'users.json');
    const personasPath = join(dir, 'personas.json');
    writeFileSync(usersPath, JSON.stringify({ users: [{ FederationIdentifier: 'A006', LastName: 'User' }] }));
    writeFileSync(personasPath, JSON.stringify({ personas: { support: {} } }));
    const parseStub = sinon.stub(UserDiff.prototype as unknown as Record<string, unknown>, 'parse');
    const baseFlags = {
      'target-org': { getConnection: () => fakeConn },
      'users-def': usersPath,
      'personas-def': personasPath,
      'external-id': 'FederationIdentifier',
      verify: true,
      'fail-on-drift': false,
      'api-version': undefined,
    };
    parseStub.onFirstCall().resolves({ flags: { ...baseFlags, output: 'json' } });
    parseStub.onSecondCall().resolves({ flags: { ...baseFlags, output: 'human' } });

    const directResult = await UserDiff.run([]);
    if (!Array.isArray(directResult)) throw new Error('Expected verify verdicts.');
    expect(directResult[0].conformant).to.equal(false);
    expect(directResult[0].violations[0]).to.include('error:');
    expect(sfCommandStubs.log.firstCall.args[0]).to.equal(JSON.stringify(directResult, null, 2));
    expect(process.exitCode).to.equal(1);

    process.exitCode = undefined;
    sfCommandStubs.log.resetHistory();
    const globalResult = await UserDiff.run(['--json']);
    expect(globalResult).to.deep.equal(directResult);
    expect(sfCommandStubs.log.called).to.equal(false);
    expect(process.exitCode).to.equal(1);
  });

  it('keeps a zero exit for conformant verify results', async () => {
    const fakeConn = makeFakeConnection();
    fakeConn.query.callsFake(async (soql: string) => {
      if (soql.includes('FROM User WHERE FederationIdentifier IN')) {
        return { records: [{ Id: '005User00000004', IsActive: true, FederationIdentifier: 'A005' }] };
      }
      return { records: [] };
    });
    const dir = mkdtempSync(join(tmpdir(), 'warden-diff-test-'));
    const usersPath = join(dir, 'users.json');
    const personasPath = join(dir, 'personas.json');
    writeFileSync(
      usersPath,
      JSON.stringify({ users: [{ personas: ['support'], FederationIdentifier: 'A005', LastName: 'User' }] })
    );
    writeFileSync(personasPath, JSON.stringify({ personas: { support: {} } }));
    sinon.stub(UserDiff.prototype as unknown as Record<string, unknown>, 'parse').resolves({
      flags: {
        'target-org': { getConnection: () => fakeConn },
        'users-def': usersPath,
        'personas-def': personasPath,
        'external-id': 'FederationIdentifier',
        output: 'human',
        verify: true,
        'fail-on-drift': false,
        'api-version': undefined,
      },
    } as never);

    const result = await UserDiff.run(['--json']);
    expect(result).to.deep.equal([{ key: 'A005', conformant: true, violations: [] }]);
    expect(process.exitCode).to.equal(undefined);
  });

  it('rejects verify in user-vs-user mode', async () => {
    const fakeConn = makeFakeConnection();
    sinon.stub(UserDiff.prototype as unknown as Record<string, unknown>, 'parse').resolves({
      flags: {
        'target-org': { getConnection: () => fakeConn },
        user: 'Username:user@example.test',
        against: 'Username:template@example.test',
        output: 'human',
        verify: true,
        'api-version': undefined,
      },
    } as never);

    try {
      await UserDiff.run([]);
      expect.fail('Expected verify to reject user-vs-user mode');
    } catch (error) {
      expect(error).to.have.property('message').that.includes('--verify');
    }
  });

  it('supports users-def without personas-def for profile and role drift', async () => {
    const fakeConn = makeFakeConnection();
    fakeConn.query.callsFake(async (soql: string) => {
      if (soql.includes('FROM Profile')) return { records: [{ Id: '00eProfileTarget1', Name: 'Admin' }] };
      return { records: [] };
    });
    const dir = mkdtempSync(join(tmpdir(), 'warden-diff-profile-only-test-'));
    const usersPath = join(dir, 'users.json');
    writeFileSync(
      usersPath,
      JSON.stringify({
        users: [
          {
            profile: 'Admin',
            match: 'FederationIdentifier',
            FederationIdentifier: 'PROFILE-001',
            LastName: 'Profile',
          },
        ],
      })
    );
    sinon.stub(UserDiff.prototype as unknown as Record<string, unknown>, 'parse').resolves({
      flags: {
        'target-org': { getConnection: () => fakeConn },
        'users-def': usersPath,
        output: 'human',
        verbose: false,
        verify: false,
        'fail-on-drift': false,
        'api-version': undefined,
      },
    } as never);

    const result = await runDiff([]);

    expect(result.summary.wouldCreate).to.equal(1);
    expect(result.users[0].personas).to.deep.equal([]);
    expect(result.rows.every((row) => row.category === 'profile' || row.category === 'role')).to.equal(true);
  });

  it('supports profile-only verify mode', async () => {
    const fakeConn = makeFakeConnection();
    fakeConn.query.callsFake(async (soql: string) => {
      if (soql.includes('FROM Profile')) return { records: [{ Id: '00eProfileTarget1', Name: 'Admin' }] };
      return { records: [] };
    });
    const dir = mkdtempSync(join(tmpdir(), 'warden-diff-profile-only-verify-test-'));
    const usersPath = join(dir, 'users.json');
    writeFileSync(
      usersPath,
      JSON.stringify({
        users: [{ profile: 'Admin', match: 'FederationIdentifier', FederationIdentifier: 'PROFILE-VERIFY' }],
      })
    );
    sinon.stub(UserDiff.prototype as unknown as Record<string, unknown>, 'parse').resolves({
      flags: {
        'target-org': { getConnection: () => fakeConn },
        'users-def': usersPath,
        output: 'human',
        verbose: false,
        verify: true,
        'fail-on-drift': false,
        'api-version': undefined,
      },
    } as never);

    const result = await UserDiff.run(['--json']);

    expect(result).to.deep.equal([{ key: 'PROFILE-VERIFY', conformant: false, violations: ['user not found'] }]);
  });

  it('rejects personas in users-def when diff has no persona definition', async () => {
    const fakeConn = makeFakeConnection();
    const dir = mkdtempSync(join(tmpdir(), 'warden-diff-profile-only-invalid-test-'));
    const usersPath = join(dir, 'users.json');
    writeFileSync(usersPath, JSON.stringify({ users: [{ Username: 'first@example.test', personas: ['admin'] }] }));
    sinon.stub(UserDiff.prototype as unknown as Record<string, unknown>, 'parse').resolves({
      flags: {
        'target-org': { getConnection: () => fakeConn },
        'users-def': usersPath,
        output: 'human',
        verbose: false,
        verify: false,
        'fail-on-drift': false,
        'api-version': undefined,
      },
    } as never);

    try {
      await UserDiff.run(['--json']);
      expect.fail('Expected personas without a definition file to be rejected');
    } catch (error) {
      expect(error).to.have.property('message').that.includes('first@example.test');
      expect(error).to.have.property('message').that.includes('--personas-def');
    }
    expect(fakeConn.describe.called).to.equal(false);
  });

  it('rejects personas-def with user mode', async () => {
    const fakeConn = makeFakeConnection();
    sinon.stub(UserDiff.prototype as unknown as Record<string, unknown>, 'parse').resolves({
      flags: {
        'target-org': { getConnection: () => fakeConn },
        user: 'Username:user@example.test',
        'personas-def': 'personas.json',
        output: 'human',
        verbose: false,
        verify: false,
        'fail-on-drift': false,
        'api-version': undefined,
      },
    } as never);

    try {
      await UserDiff.run([]);
      expect.fail('Expected personas-def with user mode to be rejected');
    } catch (error) {
      expect(error).to.have.property('message').that.includes('--personas-def');
    }
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
      if (soql.includes('SELECT Id, ProfileId, Profile.Name, UserRoleId, UserRole.Name FROM User WHERE Id IN'))
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
              PermissionSet: { IsOwnedByProfile: false, Name: 'Target_Perms', Label: 'Target Permissions' },
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
        'fail-on-drift': true,
        'api-version': undefined,
      },
    } as never);

    const result = await runDiff(['--json']);
    expect(result.summary.changed).to.equal(0);
    expect(process.exitCode).to.equal(undefined);
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
        'fail-on-drift': false,
        'api-version': undefined,
      },
    } as never);

    const result = await runDiff(['--json']);
    expect(result.users[0].status).to.equal('failed');
    expect(process.exitCode).to.equal(1);
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
      if (soql.includes('SELECT Id, ProfileId, Profile.Name, UserRoleId, UserRole.Name FROM User WHERE Id IN'))
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
              PermissionSet: { IsOwnedByProfile: false, Name: 'Current_Perms', Label: 'Current Permissions' },
            },
            {
              Id: '0PaShared',
              AssigneeId: '005NewUser00001',
              PermissionSetId: '0PSShared',
              PermissionSetGroupId: null,
              PermissionSet: { IsOwnedByProfile: false, Name: 'Shared_Perms', Label: 'Shared Permissions' },
            },
            {
              Id: '0PaTarget',
              AssigneeId: '005Template0001',
              PermissionSetId: '0PSTarget',
              PermissionSetGroupId: null,
              PermissionSet: { IsOwnedByProfile: false, Name: 'Target_Perms', Label: 'Target Permissions' },
            },
            {
              Id: '0PaTargetShared',
              AssigneeId: '005Template0001',
              PermissionSetId: '0PSShared',
              PermissionSetGroupId: null,
              PermissionSet: { IsOwnedByProfile: false, Name: 'Shared_Perms', Label: 'Shared Permissions' },
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
        output: 'csv',
        'api-version': undefined,
      },
    } as never);

    const result = await runDiff([]);
    const firstCsv = sfCommandStubs.log.firstCall.args[0] as string;
    await runDiff([]);
    expect(result.summary.changed).to.equal(1);
    expect(process.exitCode).to.equal(undefined);
    expect(sfCommandStubs.log.secondCall.args[0]).to.equal(firstCsv);
    expect(result.users[0].assignments.permissionSets.adds).to.deep.equal(['0PSTarget']);
    expect(result.users[0].assignments.permissionSets.removes).to.deep.equal(['0PSCurrent']);
    expect(result.users[0].assignments.permissionSets.inBoth).to.deep.equal(['0PSShared']);
    expect(result.users[0].assignments.permissionSets.onlyInOrg).to.deep.equal([]);
    expect(
      result.rows
        .filter((row) => row.category === 'permissionSets' && row.value === '0PSCurrent')
        .map((row) => row.kind)
    ).to.deep.equal(['remove']);
    expect(result.users[0].profile.matches).to.equal(false);
    expect(result.users[0].role.matches).to.equal(false);
    expect(result.labels?.['0PSCurrent']).to.include({ id: '0PSCurrent', apiName: 'Current_Perms' });
    expect(result.labels?.['0PSTarget']).to.include({ id: '0PSTarget', apiName: 'Target_Perms' });
    expect(renderUserDiffHuman(result, diffLookup)).to.include('+ Target_Perms (Target Permissions)');
    expect(result.labels).to.not.deep.equal({});
    expect(fakeConn.sobject.called).to.equal(false);
  });

  it('renders org labels for intended persona references supplied as Ids', async () => {
    const fakeConn = makeFakeConnection();
    fakeConn.query.callsFake(async (soql: string) => {
      if (soql.includes('FROM PermissionSet WHERE Id IN')) {
        return { records: [{ Id: '0PS000000000001AAA', Name: 'Actual_Perms', Label: 'Actual Permissions' }] };
      }
      if (soql.includes('FROM User WHERE FederationIdentifier IN')) {
        return {
          records: [
            {
              Id: '005User00000009',
              IsActive: true,
              Name: 'Ana Park',
              Username: 'ana@example.test',
              FederationIdentifier: 'A009',
            },
          ],
        };
      }
      if (soql.includes('FROM User WHERE Id IN')) return { records: [{ Id: '005User00000009' }] };
      return { records: [] };
    });

    const result = await executePersonaDiff({
      connection: fakeConn as never,
      usersDoc: { users: [{ personas: ['support'], FederationIdentifier: 'A009', LastName: 'Park' }] },
      personasDoc: {
        personas: {
          support: {
            permissionSetMode: 'additive',
            permissionSets: ['0PS000000000001AAA'],
          },
        },
      },
      externalId: 'FederationIdentifier',
    });

    expect(result.labels?.['0PS000000000001AAA']).to.deep.equal({
      id: '0PS000000000001AAA',
      apiName: 'Actual_Perms',
      label: 'Actual Permissions',
      type: 'PermissionSet',
    });
    expect(renderUserDiffHuman(result, diffLookup)).to.include('+ Actual_Perms (Actual Permissions)');
    expect(renderUserDiffHuman(result, diffLookup)).to.not.include('+ 0PS000000000001AAA');
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
      'userKey,userId,category,kind,value,mode,userName,username,valueApiName,valueLabel,valueType,valueBefore,valueAfter\n' +
        'Username:user@example.test,005User,permissionSets,add,0PSAdd,sync,,,,,,,'
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
      'userKey,userId,category,kind,value,mode,userName,username,valueApiName,valueLabel,valueType,valueBefore,valueAfter\n' +
        'Username:user@example.test,005User,permissionSets,remove,0PSCurrent,,,,,,,,'
    );
  });

  it('appends resolved labels and profile before/after values to csv rows', () => {
    const csv = renderUserDiffCsv({
      summary: { total: 1, compared: 1, wouldCreate: 0, failed: 0, changed: 1 },
      warnings: [],
      labels: {
        '00eNewProfile': {
          id: '00eNewProfile',
          apiName: 'New_Profile',
          label: 'New Profile',
          type: 'Profile',
        },
      },
      users: [],
      rows: [
        {
          userKey: 'Username:user@example.test',
          userId: '005User',
          userName: 'User',
          username: 'user@example.test',
          category: 'profile',
          kind: 'profile',
          value: '00eOldProfile -> 00eNewProfile',
          valueBefore: '00eOldProfile',
          valueAfter: '00eNewProfile',
        },
      ],
    });

    expect(csv).to.include(
      'Username:user@example.test,005User,profile,profile,00eOldProfile -> 00eNewProfile,,User,user@example.test,New_Profile,New Profile,Profile,00eOldProfile,00eNewProfile'
    );
  });

  it('renders human output with labels and gates in-both rows behind verbose', async () => {
    const result = {
      summary: { total: 1, compared: 1, wouldCreate: 0, failed: 0, changed: 1 },
      warnings: [],
      labels: {
        '0PSAdd': { id: '0PSAdd', apiName: 'AddPerm', label: 'Add Permission', type: 'PermissionSet' as const },
        '0PSKeep': { id: '0PSKeep', apiName: 'KeepPerm', label: 'KeepPerm', type: 'PermissionSet' as const },
      },
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

    expect(renderUserDiffHuman(result, diffLookup)).to.include('+ AddPerm (Add Permission)');
    expect(renderUserDiffHuman(result, diffLookup)).to.not.include('= KeepPerm');
    expect(renderUserDiffHuman(result, diffLookup, { verbose: true })).to.include('= KeepPerm');
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
