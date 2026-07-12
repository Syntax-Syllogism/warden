import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TestContext } from '@salesforce/core/testSetup';
import { stubSfCommandUx } from '@salesforce/sf-plugins-core';
import { expect } from 'chai';
import sinon from 'sinon';
import UserProvision from '../../../src/commands/warden/provision.js';
import {
  ProvisionUserUseCase,
  type ProvisionUserRequest,
} from '../../../src/userProvisioning/provisionUserUseCase.js';

type FakeConnection = {
  describe: sinon.SinonStub;
  query: sinon.SinonStub;
  sobject: sinon.SinonStub;
  sobjectMap: Record<string, { create: sinon.SinonStub; update: sinon.SinonStub; delete: sinon.SinonStub }>;
  instanceUrl: string;
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

const createFakeConnection = (instanceUrl = 'https://myorg.my.salesforce.com'): FakeConnection => {
  const sobjectMap: Record<string, { create: sinon.SinonStub; update: sinon.SinonStub; delete: sinon.SinonStub }> = {
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
  };
  return {
    instanceUrl,
    describe: sinon.stub().resolves({
      fields: [
        { name: 'Username', createable: true, updateable: true, externalId: false },
        { name: 'LastName', createable: true, updateable: true, externalId: false },
        { name: 'FirstName', createable: true, updateable: true, externalId: false },
        { name: 'Email', createable: true, updateable: true, externalId: false },
        { name: 'Alias', createable: true, updateable: true, externalId: false },
        { name: 'TimeZoneSidKey', createable: true, updateable: true, externalId: false },
        { name: 'LocaleSidKey', createable: true, updateable: true, externalId: false },
        { name: 'EmailEncodingKey', createable: true, updateable: true, externalId: false },
        { name: 'LanguageLocaleKey', createable: true, updateable: true, externalId: false },
        { name: 'ProfileId', createable: true, updateable: true, externalId: false },
        { name: 'UserRoleId', createable: true, updateable: true, externalId: false },
        { name: 'Title', createable: true, updateable: true, externalId: false },
        { name: 'Department', createable: true, updateable: true, externalId: false },
        { name: 'UserPermissionKnowledgeUser', createable: true, updateable: true, externalId: false },
        { name: 'FederationIdentifier', createable: true, updateable: true, externalId: true },
      ],
    }),
    query: sinon.stub().callsFake(async (soql: string) => {
      if (soql.includes('FROM Profile')) return { records: [{ Id: '00exx0000000001AAA', Name: 'Admin' }] };
      if (soql.includes('FROM UserRole')) return { records: [] };
      return { records: [] };
    }),
    sobject: sinon.stub().callsFake((name: string) => sobjectMap[name] ?? sobjectMap.User),
    sobjectMap,
  };
};

describe('warden user provision command', () => {
  const $$ = new TestContext();
  let sfCommandStubs: ReturnType<typeof stubSfCommandUx>;

  beforeEach(() => {
    sfCommandStubs = stubSfCommandUx($$.SANDBOX);
  });

  afterEach(() => {
    sinon.restore();
    $$.restore();
  });

  it('dry-run does not perform write operations', async () => {
    const fakeConn = createFakeConnection();
    sinon.stub(UserProvision.prototype as unknown as Record<string, unknown>, 'parse').resolves({
      flags: {
        'target-org': { getConnection: () => fakeConn },
        'users-def': 'test/fixtures/user-def.json',
        'personas-def': 'test/fixtures/persona-def.json',
        'external-id': undefined,
        'no-prompt': true,
        'dry-run': true,
        'api-version': undefined,
      },
    } as never);

    const result = await UserProvision.run(['--json']);
    expect(result.summary.total).to.be.greaterThan(0);
    expect(fakeConn.sobject.called).to.equal(false);
  });

  it('keeps the command as an adapter around the provisioning use case', async () => {
    const fakeConn = createFakeConnection();
    const dir = mkdtempSync(join(tmpdir(), 'warden-provision-adapter-test-'));
    const usersPath = join(dir, 'users.json');
    const personasPath = join(dir, 'personas.json');
    writeFileSync(usersPath, JSON.stringify({ users: [] }));
    writeFileSync(personasPath, JSON.stringify({ personas: {} }));
    let request: ProvisionUserRequest | undefined;
    sinon.stub(ProvisionUserUseCase.prototype, 'execute').callsFake(async (nextRequest) => {
      request = nextRequest;
      return {
        summary: { total: 0, created: 0, updated: 0, failed: 0, warnings: 0 },
        users: [],
      };
    });
    sinon.stub(UserProvision.prototype as unknown as Record<string, unknown>, 'parse').resolves({
      flags: {
        'target-org': { getConnection: () => fakeConn },
        'users-def': usersPath,
        'personas-def': personasPath,
        'external-id': 'FederationIdentifier',
        'no-prompt': true,
        'dry-run': true,
        'api-version': undefined,
      },
    } as never);

    const result = await UserProvision.run(['--json']);
    expect(result.summary.total).to.equal(0);
    expect(request?.connection).to.equal(fakeConn);
    expect(request?.usersDoc).to.deep.equal({ users: [] });
    expect(request?.personasDoc).to.deep.equal({ personas: {} });
    expect(request?.externalId).to.equal('FederationIdentifier');
    expect(request?.dryRun).to.equal(true);
    expect(request?.acknowledgeWarnings).to.equal(undefined);
    expect(fakeConn.describe.called).to.equal(false);
    expect(fakeConn.query.called).to.equal(false);
    expect(fakeConn.sobject.called).to.equal(false);
  });

  it('prompts once when global warnings exist', async () => {
    const fakeConn = createFakeConnection();
    fakeConn.query.callsFake(async (soql: string) => {
      if (soql.includes('FROM Profile')) return { records: [] };
      if (soql.includes('FROM UserRole')) return { records: [] };
      if (soql.includes('FROM PermissionSet')) return { records: [] };
      if (soql.includes('FROM PermissionSetGroup')) return { records: [] };
      if (soql.includes("FROM Group WHERE DeveloperName IN ('admin') AND Type = 'Regular'")) return { records: [] };
      if (soql.includes("FROM Group WHERE DeveloperName IN ('admin') AND Type = 'Queue'")) return { records: [] };
      return { records: [] };
    });

    sinon.stub(UserProvision.prototype as unknown as Record<string, unknown>, 'parse').resolves({
      flags: {
        'target-org': { getConnection: () => fakeConn },
        'users-def': 'test/fixtures/user-def.json',
        'personas-def': 'test/fixtures/persona-def.json',
        'external-id': undefined,
        'no-prompt': false,
        'dry-run': true,
        'api-version': undefined,
      },
    } as never);
    const confirmStub = sinon
      .stub(UserProvision.prototype as unknown as { confirm: () => Promise<boolean> }, 'confirm')
      .resolves(true);

    await UserProvision.run([]);
    expect(confirmStub.calledOnce).to.equal(true);
    expect(sfCommandStubs.warn.called).to.equal(true);
  });

  it('does not prompt in json mode when warnings exist', async () => {
    const fakeConn = createFakeConnection();
    fakeConn.query.callsFake(async (soql: string) => {
      if (soql.includes('FROM Profile')) return { records: [] };
      if (soql.includes('FROM UserRole')) return { records: [] };
      if (soql.includes('FROM PermissionSet')) return { records: [] };
      if (soql.includes('FROM PermissionSetGroup')) return { records: [] };
      if (soql.includes("FROM Group WHERE DeveloperName IN ('admin') AND Type = 'Regular'")) return { records: [] };
      if (soql.includes("FROM Group WHERE DeveloperName IN ('admin') AND Type = 'Queue'")) return { records: [] };
      return { records: [] };
    });

    sinon.stub(UserProvision.prototype as unknown as Record<string, unknown>, 'parse').resolves({
      flags: {
        'target-org': { getConnection: () => fakeConn },
        'users-def': 'test/fixtures/user-def.json',
        'personas-def': 'test/fixtures/persona-def.json',
        'external-id': undefined,
        'no-prompt': false,
        'dry-run': true,
        'api-version': undefined,
      },
    } as never);
    const confirmStub = sinon
      .stub(UserProvision.prototype as unknown as { confirm: () => Promise<boolean> }, 'confirm')
      .resolves(true);

    await UserProvision.run(['--json']);
    expect(confirmStub.called).to.equal(false);
  });

  it('uses bulk create/update arrays for user saves', async () => {
    const fakeConn = createFakeConnection();
    const dir = mkdtempSync(join(tmpdir(), 'warden-provision-test-'));
    const usersPath = join(dir, 'users.json');
    const personasPath = join(dir, 'personas.json');
    writeFileSync(
      usersPath,
      JSON.stringify({
        users: [
          {
            Username: 'new.user@example.test',
            FederationIdentifier: 'A001',
            personas: ['default'],
            FirstName: 'New',
            LastName: 'User',
            Alias: 'nuser',
            TimeZoneSidKey: 'America/Los_Angeles',
            LocaleSidKey: 'en_US',
            EmailEncodingKey: 'UTF-8',
            LanguageLocaleKey: 'en_US',
          },
          {
            Username: 'existing.user@example.test',
            FederationIdentifier: 'A002',
            personas: ['default'],
            FirstName: 'Existing',
            LastName: 'User',
            Alias: 'euser',
            TimeZoneSidKey: 'America/Los_Angeles',
            LocaleSidKey: 'en_US',
            EmailEncodingKey: 'UTF-8',
            LanguageLocaleKey: 'en_US',
          },
        ],
      })
    );
    writeFileSync(
      personasPath,
      JSON.stringify({
        personas: {
          default: {
            profile: 'Admin',
          },
        },
      })
    );
    fakeConn.query.callsFake(async (soql: string) => {
      if (soql.includes('FROM Profile')) return { records: [{ Id: '00exx0000000001AAA', Name: 'Admin' }] };
      if (soql.includes('SELECT Id, IsActive, FederationIdentifier FROM User')) {
        return { records: [{ Id: '005xx0000000002AAA', IsActive: true, FederationIdentifier: 'A002' }] };
      }
      if (soql.includes('FROM UserLogin')) return { records: [] };
      if (soql.includes('FROM PermissionSetAssignment')) return { records: [] };
      if (soql.includes('FROM GroupMember')) return { records: [] };
      return { records: [] };
    });
    sinon.stub(UserProvision.prototype as unknown as Record<string, unknown>, 'parse').resolves({
      flags: {
        'target-org': { getConnection: () => fakeConn },
        'users-def': usersPath,
        'personas-def': personasPath,
        'external-id': 'FederationIdentifier',
        'no-prompt': true,
        'dry-run': false,
        'api-version': undefined,
      },
    } as never);

    const result = await UserProvision.run(['--json']);
    const userSobject = fakeConn.sobject.withArgs('User').returnValues[0] as {
      create: sinon.SinonStub;
      update: sinon.SinonStub;
    };
    expect(userSobject.create.calledOnce).to.equal(true);
    expect(Array.isArray(userSobject.create.firstCall.args[0])).to.equal(true);
    expect((userSobject.create.firstCall.args[0] as unknown[]).length).to.equal(1);
    expect(userSobject.update.calledOnce).to.equal(true);
    expect(Array.isArray(userSobject.update.firstCall.args[0])).to.equal(true);
    expect((userSobject.update.firstCall.args[0] as unknown[]).length).to.equal(1);
    expect(result.summary.created + result.summary.updated).to.equal(2);
  });

  it('routes mixed per-user match fields through distinct lookups', async () => {
    const fakeConn = createFakeConnection();
    const dir = mkdtempSync(join(tmpdir(), 'warden-provision-test-'));
    const usersPath = join(dir, 'users-mixed.json');
    const personasPath = join(dir, 'personas-mixed.json');
    writeFileSync(
      usersPath,
      JSON.stringify({
        users: [
          {
            match: 'FederationIdentifier',
            FederationIdentifier: 'A101',
            personas: ['default'],
            LastName: 'One',
            Alias: 'one',
            TimeZoneSidKey: 'America/Los_Angeles',
            LocaleSidKey: 'en_US',
            EmailEncodingKey: 'UTF-8',
            LanguageLocaleKey: 'en_US',
          },
          {
            match: 'Username',
            Username: 'two@example.test',
            personas: ['default'],
            LastName: 'Two',
            Alias: 'two',
            TimeZoneSidKey: 'America/Los_Angeles',
            LocaleSidKey: 'en_US',
            EmailEncodingKey: 'UTF-8',
            LanguageLocaleKey: 'en_US',
          },
        ],
      })
    );
    writeFileSync(personasPath, JSON.stringify({ personas: { default: { profile: 'Admin' } } }));
    fakeConn.query.callsFake(async (soql: string) => {
      if (soql.includes('FROM Profile')) return { records: [{ Id: '00exx0000000001AAA', Name: 'Admin' }] };
      if (soql.includes("FROM User WHERE FederationIdentifier IN ('A101')"))
        return { records: [{ Id: '005xx0000000001AAA', IsActive: true, FederationIdentifier: 'A101' }] };
      if (soql.includes("FROM User WHERE Username IN ('two@example.test')"))
        return { records: [{ Id: '005xx0000000002AAA', IsActive: true, Username: 'two@example.test' }] };
      if (soql.includes('FROM UserLogin')) return { records: [] };
      if (soql.includes('FROM PermissionSetAssignment')) return { records: [] };
      if (soql.includes('FROM GroupMember')) return { records: [] };
      return { records: [] };
    });
    sinon.stub(UserProvision.prototype as unknown as Record<string, unknown>, 'parse').resolves({
      flags: {
        'target-org': { getConnection: () => fakeConn },
        'users-def': usersPath,
        'personas-def': personasPath,
        'external-id': undefined,
        'no-prompt': true,
        'dry-run': false,
        'api-version': undefined,
      },
    } as never);

    const result = await UserProvision.run(['--json']);
    const userQueries = fakeConn.query
      .getCalls()
      .map((call) => call.args[0] as string)
      .filter((soql) => soql.includes('FROM User WHERE'));
    expect(userQueries).to.have.length(2);
    expect(userQueries.some((soql) => soql.includes('FederationIdentifier IN'))).to.equal(true);
    expect(userQueries.some((soql) => soql.includes('Username IN'))).to.equal(true);
    expect(result.users.map((user) => user.matchedBy)).to.deep.equal(['FederationIdentifier', 'Username']);
    expect(result.summary.updated).to.equal(2);
  });

  it('does not treat the same value across different match fields as a duplicate', async () => {
    const fakeConn = createFakeConnection();
    const dir = mkdtempSync(join(tmpdir(), 'warden-provision-test-'));
    const usersPath = join(dir, 'users-shared-value.json');
    const personasPath = join(dir, 'personas-shared-value.json');
    writeFileSync(
      usersPath,
      JSON.stringify({
        users: [
          {
            match: 'FederationIdentifier',
            FederationIdentifier: 'A200',
            personas: ['default'],
            LastName: 'One',
            Alias: 'one',
            TimeZoneSidKey: 'America/Los_Angeles',
            LocaleSidKey: 'en_US',
            EmailEncodingKey: 'UTF-8',
            LanguageLocaleKey: 'en_US',
          },
          {
            match: 'Username',
            Username: 'A200',
            personas: ['default'],
            LastName: 'Two',
            Alias: 'two',
            TimeZoneSidKey: 'America/Los_Angeles',
            LocaleSidKey: 'en_US',
            EmailEncodingKey: 'UTF-8',
            LanguageLocaleKey: 'en_US',
          },
        ],
      })
    );
    writeFileSync(personasPath, JSON.stringify({ personas: { default: { profile: 'Admin' } } }));
    fakeConn.query.callsFake(async (soql: string) => {
      if (soql.includes('FROM Profile')) return { records: [{ Id: '00exx0000000001AAA', Name: 'Admin' }] };
      if (soql.includes("FROM User WHERE FederationIdentifier IN ('A200')"))
        return { records: [{ Id: '005xx0000000001AAA', IsActive: true, FederationIdentifier: 'A200' }] };
      if (soql.includes("FROM User WHERE Username IN ('A200')"))
        return { records: [{ Id: '005xx0000000002AAA', IsActive: true, Username: 'A200' }] };
      if (soql.includes('FROM UserLogin')) return { records: [] };
      if (soql.includes('FROM PermissionSetAssignment')) return { records: [] };
      if (soql.includes('FROM GroupMember')) return { records: [] };
      return { records: [] };
    });
    sinon.stub(UserProvision.prototype as unknown as Record<string, unknown>, 'parse').resolves({
      flags: {
        'target-org': { getConnection: () => fakeConn },
        'users-def': usersPath,
        'personas-def': personasPath,
        'external-id': undefined,
        'no-prompt': true,
        'dry-run': false,
        'api-version': undefined,
      },
    } as never);

    const result = await UserProvision.run(['--json']);
    expect(result.users.every((user) => user.status !== 'failed')).to.equal(true);
    expect(result.users.map((user) => user.matchedBy)).to.deep.equal(['FederationIdentifier', 'Username']);
  });

  it('records per-user match validation errors without stopping other users', async () => {
    const fakeConn = createFakeConnection();
    const dir = mkdtempSync(join(tmpdir(), 'warden-provision-test-'));
    const usersPath = join(dir, 'users-match-invalid.json');
    const personasPath = join(dir, 'personas-match-invalid.json');
    writeFileSync(
      usersPath,
      JSON.stringify({
        users: [
          {
            match: 'FederationIdentifier',
            FederationIdentifier: '',
            personas: ['default'],
            LastName: 'Bad',
            Alias: 'bad',
            TimeZoneSidKey: 'America/Los_Angeles',
            LocaleSidKey: 'en_US',
            EmailEncodingKey: 'UTF-8',
            LanguageLocaleKey: 'en_US',
          },
          {
            Username: 'insert-only@example.test',
            personas: ['default'],
            LastName: 'Good',
            Alias: 'good',
            TimeZoneSidKey: 'America/Los_Angeles',
            LocaleSidKey: 'en_US',
            EmailEncodingKey: 'UTF-8',
            LanguageLocaleKey: 'en_US',
          },
        ],
      })
    );
    writeFileSync(personasPath, JSON.stringify({ personas: { default: { profile: 'Admin' } } }));
    fakeConn.query.callsFake(async (soql: string) => {
      if (soql.includes('FROM Profile')) return { records: [{ Id: '00exx0000000001AAA', Name: 'Admin' }] };
      if (soql.includes('FROM UserLogin')) return { records: [] };
      if (soql.includes('FROM PermissionSetAssignment')) return { records: [] };
      if (soql.includes('FROM GroupMember')) return { records: [] };
      return { records: [] };
    });
    sinon.stub(UserProvision.prototype as unknown as Record<string, unknown>, 'parse').resolves({
      flags: {
        'target-org': { getConnection: () => fakeConn },
        'users-def': usersPath,
        'personas-def': personasPath,
        'external-id': undefined,
        'no-prompt': true,
        'dry-run': false,
        'api-version': undefined,
      },
    } as never);

    const result = await UserProvision.run(['--json']);
    expect(result.users[0].status).to.equal('failed');
    expect(result.users[0].matchedBy).to.equal('FederationIdentifier');
    expect(result.users[0].errors.join(' ')).to.include('must be populated');
    expect(result.users[1].status).to.equal('created');
    expect(result.users[1].matchedBy).to.equal(null);
  });

  it('overrides the external-id flag with a per-user match field', async () => {
    const fakeConn = createFakeConnection();
    const dir = mkdtempSync(join(tmpdir(), 'warden-provision-test-'));
    const usersPath = join(dir, 'users-override.json');
    const personasPath = join(dir, 'personas-override.json');
    writeFileSync(
      usersPath,
      JSON.stringify({
        users: [
          {
            match: 'Username',
            Username: 'override@example.test',
            FederationIdentifier: 'FLAG-IGNORED',
            personas: ['default'],
            LastName: 'Override',
            Alias: 'over',
            TimeZoneSidKey: 'America/Los_Angeles',
            LocaleSidKey: 'en_US',
            EmailEncodingKey: 'UTF-8',
            LanguageLocaleKey: 'en_US',
          },
          {
            FederationIdentifier: 'FLAG-001',
            personas: ['default'],
            LastName: 'Flag',
            Alias: 'flag',
            TimeZoneSidKey: 'America/Los_Angeles',
            LocaleSidKey: 'en_US',
            EmailEncodingKey: 'UTF-8',
            LanguageLocaleKey: 'en_US',
          },
        ],
      })
    );
    writeFileSync(personasPath, JSON.stringify({ personas: { default: { profile: 'Admin' } } }));
    fakeConn.query.callsFake(async (soql: string) => {
      if (soql.includes('FROM Profile')) return { records: [{ Id: '00exx0000000001AAA', Name: 'Admin' }] };
      if (soql.includes("FROM User WHERE Username IN ('override@example.test')"))
        return { records: [{ Id: '005xx0000000001AAA', IsActive: true, Username: 'override@example.test' }] };
      if (soql.includes("FROM User WHERE FederationIdentifier IN ('FLAG-001')"))
        return { records: [{ Id: '005xx0000000002AAA', IsActive: true, FederationIdentifier: 'FLAG-001' }] };
      if (soql.includes('FROM UserLogin')) return { records: [] };
      if (soql.includes('FROM PermissionSetAssignment')) return { records: [] };
      if (soql.includes('FROM GroupMember')) return { records: [] };
      return { records: [] };
    });
    sinon.stub(UserProvision.prototype as unknown as Record<string, unknown>, 'parse').resolves({
      flags: {
        'target-org': { getConnection: () => fakeConn },
        'users-def': usersPath,
        'personas-def': personasPath,
        'external-id': 'FederationIdentifier',
        'no-prompt': true,
        'dry-run': false,
        'api-version': undefined,
      },
    } as never);

    const result = await UserProvision.run(['--json']);
    expect(result.users.map((user) => user.matchedBy)).to.deep.equal(['Username', 'FederationIdentifier']);
    expect(result.summary.updated).to.equal(2);
  });

  it('reports global warning count in summary', async () => {
    const fakeConn = createFakeConnection();
    fakeConn.query.callsFake(async (soql: string) => {
      if (soql.includes('FROM Profile')) return { records: [] };
      if (soql.includes('FROM UserRole')) return { records: [] };
      if (soql.includes('FROM PermissionSet')) return { records: [] };
      if (soql.includes('FROM PermissionSetGroup')) return { records: [] };
      if (soql.includes('FROM Group')) return { records: [] };
      return { records: [] };
    });
    sinon.stub(UserProvision.prototype as unknown as Record<string, unknown>, 'parse').resolves({
      flags: {
        'target-org': { getConnection: () => fakeConn },
        'users-def': 'test/fixtures/user-def.json',
        'personas-def': 'test/fixtures/persona-def.json',
        'external-id': undefined,
        'no-prompt': true,
        'dry-run': true,
        'api-version': undefined,
      },
    } as never);

    const result = await UserProvision.run(['--json']);
    expect(result.summary.warnings).to.be.greaterThan(0);
  });

  it('does not remove queue membership during public-group sync', async () => {
    const fakeConn = createFakeConnection();
    const dir = mkdtempSync(join(tmpdir(), 'warden-provision-test-'));
    const usersPath = join(dir, 'users-sync.json');
    const personasPath = join(dir, 'personas-sync.json');
    writeFileSync(
      usersPath,
      JSON.stringify({
        users: [
          {
            Username: 'existing.user@example.test',
            FederationIdentifier: 'A002',
            personas: ['default'],
            LastName: 'User',
            Alias: 'euser',
            TimeZoneSidKey: 'America/Los_Angeles',
            LocaleSidKey: 'en_US',
            EmailEncodingKey: 'UTF-8',
            LanguageLocaleKey: 'en_US',
          },
        ],
      })
    );
    writeFileSync(
      personasPath,
      JSON.stringify({
        personas: {
          default: { profile: 'Admin', publicGroupMode: 'sync', publicGroups: ['Pub1'] },
        },
      })
    );
    fakeConn.query.callsFake(async (soql: string) => {
      if (soql.includes('FROM Profile')) return { records: [{ Id: '00exx0000000001AAA', Name: 'Admin' }] };
      if (soql.includes('SELECT Id, IsActive, FederationIdentifier FROM User'))
        return { records: [{ Id: '005xx0000000002AAA', IsActive: true, FederationIdentifier: 'A002' }] };
      if (soql.includes("FROM Group WHERE DeveloperName IN ('Pub1') AND Type = 'Regular'"))
        return { records: [{ Id: '00Gpub000000001AAA', DeveloperName: 'Pub1' }] };
      if (soql.includes('FROM PermissionSetAssignment')) return { records: [] };
      if (soql.includes('FROM GroupMember')) {
        return {
          records: [
            {
              Id: '0GMpub',
              GroupId: '00Gold000000001AAA',
              UserOrGroupId: '005xx0000000002AAA',
              Group: { Type: 'Regular' },
            },
            {
              Id: '0GMqueue',
              GroupId: '00Gqueue0000001AAA',
              UserOrGroupId: '005xx0000000002AAA',
              Group: { Type: 'Queue' },
            },
          ],
        };
      }
      if (soql.includes('FROM UserLogin')) return { records: [] };
      return { records: [] };
    });
    fakeConn.sobjectMap.User.update.callsFake(async (items: Array<{ Id: string }>) =>
      items.map((item) => ({ success: true, id: item.Id, errors: [] }))
    );
    sinon.stub(UserProvision.prototype as unknown as Record<string, unknown>, 'parse').resolves({
      flags: {
        'target-org': { getConnection: () => fakeConn },
        'users-def': usersPath,
        'personas-def': personasPath,
        'external-id': 'FederationIdentifier',
        'no-prompt': true,
        'dry-run': false,
        'api-version': undefined,
      },
    } as never);
    await UserProvision.run(['--json']);
    const groupMember = fakeConn.sobject.withArgs('GroupMember').returnValues[0] as { delete: sinon.SinonStub };
    const deletes = groupMember.delete
      .getCalls()
      .map((c) => c.args[0] as string[])
      .flat();
    expect(deletes).to.include('0GMpub');
    expect(deletes).to.not.include('0GMqueue');
  });

  it('does not remove profile-owned or permission-set-group-backed permission sets during permission-set sync', async () => {
    const fakeConn = createFakeConnection();
    const dir = mkdtempSync(join(tmpdir(), 'warden-provision-test-'));
    const usersPath = join(dir, 'users-sync-psa.json');
    const personasPath = join(dir, 'personas-sync-psa.json');
    writeFileSync(
      usersPath,
      JSON.stringify({
        users: [
          {
            Username: 'existing.user@example.test',
            FederationIdentifier: 'A003',
            personas: ['default'],
            LastName: 'User',
            Alias: 'euser',
            TimeZoneSidKey: 'America/Los_Angeles',
            LocaleSidKey: 'en_US',
            EmailEncodingKey: 'UTF-8',
            LanguageLocaleKey: 'en_US',
          },
        ],
      })
    );
    writeFileSync(
      personasPath,
      JSON.stringify({
        personas: {
          default: { profile: 'Admin', permissionSetMode: 'sync', permissionSets: ['KeepPerm'] },
        },
      })
    );
    fakeConn.query.callsFake(async (soql: string) => {
      if (soql.includes('FROM Profile')) return { records: [{ Id: '00exx0000000001AAA', Name: 'Admin' }] };
      if (soql.includes('SELECT Id, IsActive, FederationIdentifier FROM User'))
        return { records: [{ Id: '005xx0000000003AAA', IsActive: true, FederationIdentifier: 'A003' }] };
      if (soql.includes("FROM PermissionSet WHERE Name IN ('KeepPerm')"))
        return { records: [{ Id: '0PSkeep00000001AAA', Name: 'KeepPerm' }] };
      if (soql.includes('FROM PermissionSetAssignment'))
        return {
          records: [
            {
              Id: '0PaKeep',
              AssigneeId: '005xx0000000003AAA',
              PermissionSetId: '0PSkeep00000001AAA',
              PermissionSetGroupId: null,
              PermissionSet: { IsOwnedByProfile: false },
            },
            {
              Id: '0PaProfileOwned',
              AssigneeId: '005xx0000000003AAA',
              PermissionSetId: '0PSprofileOwned',
              PermissionSetGroupId: null,
              PermissionSet: { IsOwnedByProfile: true },
            },
            {
              Id: '0PaPsgBacked',
              AssigneeId: '005xx0000000003AAA',
              PermissionSetId: '0PSpsgBacked',
              PermissionSetGroupId: '0PGsourceGroup',
              PermissionSet: { IsOwnedByProfile: false },
            },
            {
              Id: '0PaExtra',
              AssigneeId: '005xx0000000003AAA',
              PermissionSetId: '0PSextra',
              PermissionSetGroupId: null,
              PermissionSet: { IsOwnedByProfile: false },
            },
          ],
        };
      if (soql.includes('FROM GroupMember')) return { records: [] };
      return { records: [] };
    });
    fakeConn.sobjectMap.User.update.callsFake(async (items: Array<{ Id: string }>) =>
      items.map((item) => ({ success: true, id: item.Id, errors: [] }))
    );
    sinon.stub(UserProvision.prototype as unknown as Record<string, unknown>, 'parse').resolves({
      flags: {
        'target-org': { getConnection: () => fakeConn },
        'users-def': usersPath,
        'personas-def': personasPath,
        'external-id': 'FederationIdentifier',
        'no-prompt': true,
        'dry-run': false,
        'api-version': undefined,
      },
    } as never);

    await UserProvision.run(['--json']);
    const permissionSetAssignment = fakeConn.sobject.withArgs('PermissionSetAssignment').returnValues[0] as {
      delete: sinon.SinonStub;
    };
    const deletes = permissionSetAssignment.delete
      .getCalls()
      .map((call) => call.args[0] as string[])
      .flat();
    expect(deletes).to.include('0PaExtra');
    expect(deletes).to.not.include('0PaProfileOwned');
    expect(deletes).to.not.include('0PaPsgBacked');
  });

  it('fails duplicate external-id matches per user', async () => {
    const fakeConn = createFakeConnection();
    const dir = mkdtempSync(join(tmpdir(), 'warden-provision-test-'));
    const usersPath = join(dir, 'users-dup.json');
    const personasPath = join(dir, 'personas-dup.json');
    writeFileSync(
      usersPath,
      JSON.stringify({
        users: [
          {
            Username: 'dup@example.test',
            FederationIdentifier: 'A100',
            personas: ['default'],
            LastName: 'Dup',
            Alias: 'dup',
            TimeZoneSidKey: 'America/Los_Angeles',
            LocaleSidKey: 'en_US',
            EmailEncodingKey: 'UTF-8',
            LanguageLocaleKey: 'en_US',
          },
        ],
      })
    );
    writeFileSync(personasPath, JSON.stringify({ personas: { default: { profile: 'Admin' } } }));
    fakeConn.query.callsFake(async (soql: string) => {
      if (soql.includes('FROM Profile')) return { records: [{ Id: '00exx0000000001AAA', Name: 'Admin' }] };
      if (soql.includes('SELECT Id, IsActive, FederationIdentifier FROM User'))
        return {
          records: [
            { Id: '0051', IsActive: true, FederationIdentifier: 'A100' },
            { Id: '0052', IsActive: true, FederationIdentifier: 'A100' },
          ],
        };
      return { records: [] };
    });
    sinon.stub(UserProvision.prototype as unknown as Record<string, unknown>, 'parse').resolves({
      flags: {
        'target-org': { getConnection: () => fakeConn },
        'users-def': usersPath,
        'personas-def': personasPath,
        'external-id': 'FederationIdentifier',
        'no-prompt': true,
        'dry-run': false,
        'api-version': undefined,
      },
    } as never);
    const result = await UserProvision.run(['--json']);
    expect(result.users[0].status).to.equal('failed');
    expect(result.users[0].matchedBy).to.equal('FederationIdentifier');
    expect(result.users[0].errors.join(' ')).to.include('Multiple users matched');
    expect(result.users[0].errors.join(' ')).to.include('FederationIdentifier');
  });

  it('surfaces assignment dml failures in per-user errors', async () => {
    const fakeConn = createFakeConnection();
    fakeConn.sobjectMap.PermissionSetAssignment.create.resolves([
      { success: false, errors: [{ message: 'PSA failed' }] },
    ]);
    const dir = mkdtempSync(join(tmpdir(), 'warden-provision-test-'));
    const usersPath = join(dir, 'users-psa.json');
    const personasPath = join(dir, 'personas-psa.json');
    writeFileSync(
      usersPath,
      JSON.stringify({
        users: [
          {
            Username: 'u@example.test',
            personas: ['default'],
            LastName: 'U',
            Alias: 'u',
            TimeZoneSidKey: 'America/Los_Angeles',
            LocaleSidKey: 'en_US',
            EmailEncodingKey: 'UTF-8',
            LanguageLocaleKey: 'en_US',
          },
        ],
      })
    );
    writeFileSync(
      personasPath,
      JSON.stringify({ personas: { default: { profile: 'Admin', permissionSets: ['PermA'] } } })
    );
    fakeConn.query.callsFake(async (soql: string) => {
      if (soql.includes('FROM Profile')) return { records: [{ Id: '00exx0000000001AAA', Name: 'Admin' }] };
      if (soql.includes("FROM PermissionSet WHERE Name IN ('PermA')"))
        return { records: [{ Id: '0PSx', Name: 'PermA' }] };
      if (soql.includes('FROM UserLogin')) return { records: [] };
      if (soql.includes('FROM PermissionSetAssignment')) return { records: [] };
      if (soql.includes('FROM GroupMember')) return { records: [] };
      return { records: [] };
    });
    sinon.stub(UserProvision.prototype as unknown as Record<string, unknown>, 'parse').resolves({
      flags: {
        'target-org': { getConnection: () => fakeConn },
        'users-def': usersPath,
        'personas-def': personasPath,
        'external-id': undefined,
        'no-prompt': true,
        'dry-run': false,
        'api-version': undefined,
      },
    } as never);
    const result = await UserProvision.run(['--json']);
    expect(result.users[0].status).to.equal('failed');
    expect(result.users[0].errors.join(' ')).to.include('PSA failed');
  });

  it('fails when updating non-updateable fields', async () => {
    const fakeConn = createFakeConnection();
    fakeConn.describe.resolves({
      fields: [
        { name: 'FederationIdentifier', createable: true, updateable: true, externalId: true },
        { name: 'LastName', createable: true, updateable: false, externalId: false },
        { name: 'Alias', createable: true, updateable: true, externalId: false },
        { name: 'TimeZoneSidKey', createable: true, updateable: true, externalId: false },
        { name: 'LocaleSidKey', createable: true, updateable: true, externalId: false },
        { name: 'EmailEncodingKey', createable: true, updateable: true, externalId: false },
        { name: 'LanguageLocaleKey', createable: true, updateable: true, externalId: false },
        { name: 'ProfileId', createable: true, updateable: true, externalId: false },
      ],
    });
    const dir = mkdtempSync(join(tmpdir(), 'warden-provision-test-'));
    const usersPath = join(dir, 'users-write.json');
    const personasPath = join(dir, 'personas-write.json');
    writeFileSync(
      usersPath,
      JSON.stringify({
        users: [
          {
            FederationIdentifier: 'A200',
            personas: ['default'],
            LastName: 'Nope',
            Alias: 'np',
            TimeZoneSidKey: 'America/Los_Angeles',
            LocaleSidKey: 'en_US',
            EmailEncodingKey: 'UTF-8',
            LanguageLocaleKey: 'en_US',
          },
        ],
      })
    );
    writeFileSync(personasPath, JSON.stringify({ personas: { default: { profile: 'Admin' } } }));
    fakeConn.query.callsFake(async (soql: string) => {
      if (soql.includes('FROM Profile')) return { records: [{ Id: '00exx0000000001AAA', Name: 'Admin' }] };
      if (soql.includes('SELECT Id, IsActive, FederationIdentifier FROM User'))
        return { records: [{ Id: '005x', IsActive: true, FederationIdentifier: 'A200' }] };
      return { records: [] };
    });
    sinon.stub(UserProvision.prototype as unknown as Record<string, unknown>, 'parse').resolves({
      flags: {
        'target-org': { getConnection: () => fakeConn },
        'users-def': usersPath,
        'personas-def': personasPath,
        'external-id': 'FederationIdentifier',
        'no-prompt': true,
        'dry-run': false,
        'api-version': undefined,
      },
    } as never);
    const result = await UserProvision.run(['--json']);
    expect(result.users[0].status).to.equal('failed');
    expect(result.users[0].errors.join(' ')).to.include('not updateable');
  });

  it('reports cross-reference candidate fields for update failures', async () => {
    const fakeConn = createFakeConnection();
    const dir = mkdtempSync(join(tmpdir(), 'warden-provision-test-'));
    const usersPath = join(dir, 'users-xref.json');
    const personasPath = join(dir, 'personas-xref.json');
    writeFileSync(
      usersPath,
      JSON.stringify({
        users: [
          {
            FederationIdentifier: 'A002',
            personas: ['default'],
            LastName: 'User',
            Alias: 'euser',
            TimeZoneSidKey: 'America/Los_Angeles',
            LocaleSidKey: 'en_US',
            EmailEncodingKey: 'UTF-8',
            LanguageLocaleKey: 'en_US',
          },
        ],
      })
    );
    writeFileSync(
      personasPath,
      JSON.stringify({
        personas: {
          default: { profile: 'Admin', role: 'CEO' },
        },
      })
    );
    fakeConn.query.callsFake(async (soql: string) => {
      if (soql.includes('FROM Profile')) return { records: [{ Id: '00exx0000000001AAA', Name: 'Admin' }] };
      if (soql.includes('FROM UserRole'))
        return { records: [{ Id: '00Exx0000000001AAA', Name: 'CEO', DeveloperName: 'CEO' }] };
      if (soql.includes('SELECT Id, IsActive, FederationIdentifier FROM User'))
        return { records: [{ Id: '005xx0000000002AAA', IsActive: true, FederationIdentifier: 'A002' }] };
      if (soql.includes('FROM UserLogin')) return { records: [] };
      if (soql.includes('FROM PermissionSetAssignment')) return { records: [] };
      if (soql.includes('FROM GroupMember')) return { records: [] };
      return { records: [] };
    });
    fakeConn.sobjectMap.User.update.resolves([
      {
        success: false,
        errors: [{ message: 'invalid cross reference id', statusCode: 'INVALID_CROSS_REFERENCE_KEY', fields: [] }],
      },
    ]);
    sinon.stub(UserProvision.prototype as unknown as Record<string, unknown>, 'parse').resolves({
      flags: {
        'target-org': { getConnection: () => fakeConn },
        'users-def': usersPath,
        'personas-def': personasPath,
        'external-id': 'FederationIdentifier',
        'no-prompt': true,
        'dry-run': false,
        'api-version': undefined,
      },
    } as never);

    const result = await UserProvision.run(['--json']);
    expect(result.users[0].errors.join(' ')).to.include('Cross-reference update candidates for this user:');
    expect(result.users[0].errors.join(' ')).to.include('ProfileId=');
    expect(result.users[0].errors.join(' ')).to.include('UserRoleId=');
  });

  // --- Multi-persona tests ---

  it('multi-persona happy path: unions assignment lists', async () => {
    const fakeConn = createFakeConnection();
    const dir = mkdtempSync(join(tmpdir(), 'warden-provision-test-'));
    const usersPath = join(dir, 'users-multi.json');
    const personasPath = join(dir, 'personas-multi.json');
    writeFileSync(
      usersPath,
      JSON.stringify({
        users: [
          {
            personas: ['base', 'support'],
            FirstName: 'John',
            LastName: 'Doe',
            Email: 'jdoe@example.test',
            Username: 'jdoe@example.test.myorg',
            Alias: 'jdoe',
            TimeZoneSidKey: 'America/Los_Angeles',
            LocaleSidKey: 'en_US',
            EmailEncodingKey: 'UTF-8',
            LanguageLocaleKey: 'en_US',
          },
        ],
      })
    );
    writeFileSync(
      personasPath,
      JSON.stringify({
        personas: {
          base: { profile: 'Admin', permissionSets: ['BasePS'] },
          support: { permissionSets: ['SupportPS'] },
        },
      })
    );
    fakeConn.query.callsFake(async (soql: string) => {
      if (soql.includes('FROM Profile')) return { records: [{ Id: '00exx0000000001AAA', Name: 'Admin' }] };
      if (soql.includes('FROM PermissionSet WHERE Name IN')) {
        return {
          records: [
            { Id: '0PSbase000000001AAA', Name: 'BasePS' },
            { Id: '0PSsupport00001AAA', Name: 'SupportPS' },
          ],
        };
      }
      if (soql.includes('FROM UserLogin')) return { records: [] };
      if (soql.includes('FROM PermissionSetAssignment')) return { records: [] };
      if (soql.includes('FROM GroupMember')) return { records: [] };
      return { records: [] };
    });
    sinon.stub(UserProvision.prototype as unknown as Record<string, unknown>, 'parse').resolves({
      flags: {
        'target-org': { getConnection: () => fakeConn },
        'users-def': usersPath,
        'personas-def': personasPath,
        'external-id': undefined,
        'no-prompt': true,
        'dry-run': false,
        'api-version': undefined,
      },
    } as never);

    const result = await UserProvision.run(['--json']);
    expect(result.users[0].status).to.equal('created');
    expect(result.users[0].personas).to.deep.equal(['base', 'support']);
    const psaCreate = fakeConn.sobjectMap.PermissionSetAssignment.create;
    const psaArgs = (psaCreate.firstCall.args[0] as Array<{ PermissionSetId: string }>).map((r) => r.PermissionSetId);
    expect(psaArgs).to.include('0PSbase000000001AAA');
    expect(psaArgs).to.include('0PSsupport00001AAA');
  });

  it('conflict on persona profile fails that user, batch continues', async () => {
    const fakeConn = createFakeConnection();
    const dir = mkdtempSync(join(tmpdir(), 'warden-provision-test-'));
    const usersPath = join(dir, 'users-conflict.json');
    const personasPath = join(dir, 'personas-conflict.json');
    writeFileSync(
      usersPath,
      JSON.stringify({
        users: [
          {
            personas: ['a', 'b'],
            LastName: 'Conflict',
            Email: 'conflict@example.test',
          },
          {
            personas: ['a'],
            LastName: 'Good',
            Username: 'good@example.test',
            Alias: 'good',
            TimeZoneSidKey: 'America/Los_Angeles',
            LocaleSidKey: 'en_US',
            EmailEncodingKey: 'UTF-8',
            LanguageLocaleKey: 'en_US',
          },
        ],
      })
    );
    writeFileSync(
      personasPath,
      JSON.stringify({
        personas: {
          a: { profile: 'Admin' },
          b: { profile: 'Standard' },
        },
      })
    );
    fakeConn.query.callsFake(async (soql: string) => {
      if (soql.includes('FROM Profile'))
        return {
          records: [
            { Id: '00exx0000000001AAA', Name: 'Admin' },
            { Id: '00exx0000000002AAA', Name: 'Standard' },
          ],
        };
      return { records: [] };
    });
    sinon.stub(UserProvision.prototype as unknown as Record<string, unknown>, 'parse').resolves({
      flags: {
        'target-org': { getConnection: () => fakeConn },
        'users-def': usersPath,
        'personas-def': personasPath,
        'external-id': undefined,
        'no-prompt': true,
        'dry-run': false,
        'api-version': undefined,
      },
    } as never);

    const result = await UserProvision.run(['--json']);
    const conflictUser = result.users.find((u) => u.personas.includes('b'));
    const goodUser = result.users.find((u) => u.personas.length === 1 && u.personas[0] === 'a');
    expect(conflictUser?.status).to.equal('failed');
    expect(conflictUser?.errors.join(' ')).to.include('conflict');
    expect(goodUser?.status).to.equal('created');
  });

  it('Username default applied on insert when not provided', async () => {
    const fakeConn = createFakeConnection('https://myorg.my.salesforce.com');
    const dir = mkdtempSync(join(tmpdir(), 'warden-provision-test-'));
    const usersPath = join(dir, 'users-default-un.json');
    const personasPath = join(dir, 'personas-default-un.json');
    writeFileSync(
      usersPath,
      JSON.stringify({
        users: [
          {
            personas: ['default'],
            FirstName: 'Jane',
            LastName: 'Smith',
            Email: 'jsmith@example.test',
            Alias: 'jsmi',
            TimeZoneSidKey: 'America/Los_Angeles',
            LocaleSidKey: 'en_US',
            EmailEncodingKey: 'UTF-8',
            LanguageLocaleKey: 'en_US',
          },
        ],
      })
    );
    writeFileSync(personasPath, JSON.stringify({ personas: { default: { profile: 'Admin' } } }));
    fakeConn.query.callsFake(async (soql: string) => {
      if (soql.includes('FROM Profile')) return { records: [{ Id: '00exx0000000001AAA', Name: 'Admin' }] };
      if (soql.includes('FROM UserLogin')) return { records: [] };
      if (soql.includes('FROM PermissionSetAssignment')) return { records: [] };
      if (soql.includes('FROM GroupMember')) return { records: [] };
      return { records: [] };
    });
    sinon.stub(UserProvision.prototype as unknown as Record<string, unknown>, 'parse').resolves({
      flags: {
        'target-org': { getConnection: () => fakeConn },
        'users-def': usersPath,
        'personas-def': personasPath,
        'external-id': undefined,
        'no-prompt': true,
        'dry-run': false,
        'api-version': undefined,
      },
    } as never);

    await UserProvision.run(['--json']);
    const createCall = fakeConn.sobjectMap.User.create.firstCall;
    const createdUser = (createCall.args[0] as Array<Record<string, unknown>>)[0];
    expect(createdUser.Username).to.equal('jsmith@example.test.myorg');
  });

  it('Alias default applied on insert when not provided', async () => {
    const fakeConn = createFakeConnection();
    const dir = mkdtempSync(join(tmpdir(), 'warden-provision-test-'));
    const usersPath = join(dir, 'users-default-alias.json');
    const personasPath = join(dir, 'personas-default-alias.json');
    writeFileSync(
      usersPath,
      JSON.stringify({
        users: [
          {
            personas: ['default'],
            FirstName: 'John',
            LastName: 'Doe',
            Username: 'jdoe@example.test',
            Email: 'jdoe@example.test',
            TimeZoneSidKey: 'America/Los_Angeles',
            LocaleSidKey: 'en_US',
            EmailEncodingKey: 'UTF-8',
            LanguageLocaleKey: 'en_US',
          },
        ],
      })
    );
    writeFileSync(personasPath, JSON.stringify({ personas: { default: { profile: 'Admin' } } }));
    fakeConn.query.callsFake(async (soql: string) => {
      if (soql.includes('FROM Profile')) return { records: [{ Id: '00exx0000000001AAA', Name: 'Admin' }] };
      if (soql.includes('FROM UserLogin')) return { records: [] };
      if (soql.includes('FROM PermissionSetAssignment')) return { records: [] };
      if (soql.includes('FROM GroupMember')) return { records: [] };
      return { records: [] };
    });
    sinon.stub(UserProvision.prototype as unknown as Record<string, unknown>, 'parse').resolves({
      flags: {
        'target-org': { getConnection: () => fakeConn },
        'users-def': usersPath,
        'personas-def': personasPath,
        'external-id': undefined,
        'no-prompt': true,
        'dry-run': false,
        'api-version': undefined,
      },
    } as never);

    await UserProvision.run(['--json']);
    const createCall = fakeConn.sobjectMap.User.create.firstCall;
    const createdUser = (createCall.args[0] as Array<Record<string, unknown>>)[0];
    expect(createdUser.Alias).to.equal('johdoe');
  });

  it('defaults NOT applied on update (existing user)', async () => {
    const fakeConn = createFakeConnection();
    const dir = mkdtempSync(join(tmpdir(), 'warden-provision-test-'));
    const usersPath = join(dir, 'users-no-defaults-update.json');
    const personasPath = join(dir, 'personas-no-defaults-update.json');
    writeFileSync(
      usersPath,
      JSON.stringify({
        users: [
          {
            FederationIdentifier: 'EX001',
            personas: ['default'],
            FirstName: 'John',
            LastName: 'Doe',
            Email: 'jdoe@example.test',
            TimeZoneSidKey: 'America/Los_Angeles',
            LocaleSidKey: 'en_US',
            EmailEncodingKey: 'UTF-8',
            LanguageLocaleKey: 'en_US',
          },
        ],
      })
    );
    writeFileSync(personasPath, JSON.stringify({ personas: { default: { profile: 'Admin' } } }));
    fakeConn.query.callsFake(async (soql: string) => {
      if (soql.includes('FROM Profile')) return { records: [{ Id: '00exx0000000001AAA', Name: 'Admin' }] };
      if (soql.includes('SELECT Id, IsActive, FederationIdentifier FROM User'))
        return { records: [{ Id: '005xx0000000001AAA', IsActive: true, FederationIdentifier: 'EX001' }] };
      if (soql.includes('FROM UserLogin')) return { records: [] };
      if (soql.includes('FROM PermissionSetAssignment')) return { records: [] };
      if (soql.includes('FROM GroupMember')) return { records: [] };
      return { records: [] };
    });
    sinon.stub(UserProvision.prototype as unknown as Record<string, unknown>, 'parse').resolves({
      flags: {
        'target-org': { getConnection: () => fakeConn },
        'users-def': usersPath,
        'personas-def': personasPath,
        'external-id': 'FederationIdentifier',
        'no-prompt': true,
        'dry-run': false,
        'api-version': undefined,
      },
    } as never);

    await UserProvision.run(['--json']);
    const updateCall = fakeConn.sobjectMap.User.update.firstCall;
    const updatedUser = (updateCall.args[0] as Array<Record<string, unknown>>)[0];
    expect(updatedUser.Username).to.equal(undefined);
    expect(updatedUser.Alias).to.equal(undefined);
  });

  it('explicit Username and Alias are never overwritten by defaults', async () => {
    const fakeConn = createFakeConnection('https://myorg.my.salesforce.com');
    const dir = mkdtempSync(join(tmpdir(), 'warden-provision-test-'));
    const usersPath = join(dir, 'users-explicit.json');
    const personasPath = join(dir, 'personas-explicit.json');
    writeFileSync(
      usersPath,
      JSON.stringify({
        users: [
          {
            personas: ['default'],
            FirstName: 'Jane',
            LastName: 'Doe',
            Email: 'jdoe@example.test',
            Username: 'explicit@custom.test',
            Alias: 'custom',
            TimeZoneSidKey: 'America/Los_Angeles',
            LocaleSidKey: 'en_US',
            EmailEncodingKey: 'UTF-8',
            LanguageLocaleKey: 'en_US',
          },
        ],
      })
    );
    writeFileSync(personasPath, JSON.stringify({ personas: { default: { profile: 'Admin' } } }));
    fakeConn.query.callsFake(async (soql: string) => {
      if (soql.includes('FROM Profile')) return { records: [{ Id: '00exx0000000001AAA', Name: 'Admin' }] };
      if (soql.includes('FROM UserLogin')) return { records: [] };
      if (soql.includes('FROM PermissionSetAssignment')) return { records: [] };
      if (soql.includes('FROM GroupMember')) return { records: [] };
      return { records: [] };
    });
    sinon.stub(UserProvision.prototype as unknown as Record<string, unknown>, 'parse').resolves({
      flags: {
        'target-org': { getConnection: () => fakeConn },
        'users-def': usersPath,
        'personas-def': personasPath,
        'external-id': undefined,
        'no-prompt': true,
        'dry-run': false,
        'api-version': undefined,
      },
    } as never);

    await UserProvision.run(['--json']);
    const createCall = fakeConn.sobjectMap.User.create.firstCall;
    const createdUser = (createCall.args[0] as Array<Record<string, unknown>>)[0];
    expect(createdUser.Username).to.equal('explicit@custom.test');
    expect(createdUser.Alias).to.equal('custom');
  });

  it('json output includes personas array per user', async () => {
    const fakeConn = createFakeConnection();
    const dir = mkdtempSync(join(tmpdir(), 'warden-provision-test-'));
    const usersPath = join(dir, 'users-json.json');
    const personasPath = join(dir, 'personas-json.json');
    writeFileSync(
      usersPath,
      JSON.stringify({
        users: [
          {
            personas: ['base', 'support'],
            Username: 'u@example.test',
            LastName: 'U',
            Alias: 'u',
            TimeZoneSidKey: 'America/Los_Angeles',
            LocaleSidKey: 'en_US',
            EmailEncodingKey: 'UTF-8',
            LanguageLocaleKey: 'en_US',
          },
        ],
      })
    );
    writeFileSync(personasPath, JSON.stringify({ personas: { base: { profile: 'Admin' }, support: {} } }));
    fakeConn.query.callsFake(async (soql: string) => {
      if (soql.includes('FROM Profile')) return { records: [{ Id: '00exx0000000001AAA', Name: 'Admin' }] };
      if (soql.includes('FROM UserLogin')) return { records: [] };
      if (soql.includes('FROM PermissionSetAssignment')) return { records: [] };
      if (soql.includes('FROM GroupMember')) return { records: [] };
      return { records: [] };
    });
    sinon.stub(UserProvision.prototype as unknown as Record<string, unknown>, 'parse').resolves({
      flags: {
        'target-org': { getConnection: () => fakeConn },
        'users-def': usersPath,
        'personas-def': personasPath,
        'external-id': undefined,
        'no-prompt': true,
        'dry-run': false,
        'api-version': undefined,
      },
    } as never);

    const result = await UserProvision.run(['--json']);
    expect(result.users[0].personas).to.deep.equal(['base', 'support']);
  });

  // --- Feature 4: user-level profile/role overrides ---

  it('user profile by name overrides persona profile', async () => {
    const fakeConn = createFakeConnection();
    const dir = mkdtempSync(join(tmpdir(), 'warden-provision-test-'));
    const usersPath = join(dir, 'users-profile-override.json');
    const personasPath = join(dir, 'personas-profile-override.json');
    writeFileSync(
      usersPath,
      JSON.stringify({
        users: [
          {
            personas: ['base'],
            profile: 'Standard',
            Username: 'u@example.test',
            LastName: 'User',
            Alias: 'u',
            TimeZoneSidKey: 'America/Los_Angeles',
            LocaleSidKey: 'en_US',
            EmailEncodingKey: 'UTF-8',
            LanguageLocaleKey: 'en_US',
          },
        ],
      })
    );
    writeFileSync(personasPath, JSON.stringify({ personas: { base: { profile: 'Admin' } } }));
    fakeConn.query.callsFake(async (soql: string) => {
      if (soql.includes('FROM Profile'))
        return {
          records: [
            { Id: '00exx0000000001AAA', Name: 'Admin' },
            { Id: '00exx0000000002AAA', Name: 'Standard' },
          ],
        };
      if (soql.includes('FROM UserLogin')) return { records: [] };
      if (soql.includes('FROM PermissionSetAssignment')) return { records: [] };
      if (soql.includes('FROM GroupMember')) return { records: [] };
      return { records: [] };
    });
    sinon.stub(UserProvision.prototype as unknown as Record<string, unknown>, 'parse').resolves({
      flags: {
        'target-org': { getConnection: () => fakeConn },
        'users-def': usersPath,
        'personas-def': personasPath,
        'external-id': undefined,
        'no-prompt': true,
        'dry-run': false,
        'api-version': undefined,
      },
    } as never);

    await UserProvision.run(['--json']);
    const createCall = fakeConn.sobjectMap.User.create.firstCall;
    const createdUser = (createCall.args[0] as Array<Record<string, unknown>>)[0];
    expect(createdUser.ProfileId).to.equal('00exx0000000002AAA');
  });

  it('user raw ProfileId overrides persona profile (regression guard against clobber)', async () => {
    const fakeConn = createFakeConnection();
    const dir = mkdtempSync(join(tmpdir(), 'warden-provision-test-'));
    const usersPath = join(dir, 'users-profileid-override.json');
    const personasPath = join(dir, 'personas-profileid-override.json');
    writeFileSync(
      usersPath,
      JSON.stringify({
        users: [
          {
            personas: ['base'],
            ProfileId: '00exx0000000002AAA',
            Username: 'u@example.test',
            LastName: 'User',
            Alias: 'u',
            TimeZoneSidKey: 'America/Los_Angeles',
            LocaleSidKey: 'en_US',
            EmailEncodingKey: 'UTF-8',
            LanguageLocaleKey: 'en_US',
          },
        ],
      })
    );
    writeFileSync(personasPath, JSON.stringify({ personas: { base: { profile: 'Admin' } } }));
    fakeConn.query.callsFake(async (soql: string) => {
      if (soql.includes('FROM Profile')) return { records: [{ Id: '00exx0000000001AAA', Name: 'Admin' }] };
      if (soql.includes('FROM UserLogin')) return { records: [] };
      if (soql.includes('FROM PermissionSetAssignment')) return { records: [] };
      if (soql.includes('FROM GroupMember')) return { records: [] };
      return { records: [] };
    });
    sinon.stub(UserProvision.prototype as unknown as Record<string, unknown>, 'parse').resolves({
      flags: {
        'target-org': { getConnection: () => fakeConn },
        'users-def': usersPath,
        'personas-def': personasPath,
        'external-id': undefined,
        'no-prompt': true,
        'dry-run': false,
        'api-version': undefined,
      },
    } as never);

    await UserProvision.run(['--json']);
    const createCall = fakeConn.sobjectMap.User.create.firstCall;
    const createdUser = (createCall.args[0] as Array<Record<string, unknown>>)[0];
    expect(createdUser.ProfileId).to.equal('00exx0000000002AAA');
  });

  it('user role by name overrides persona role', async () => {
    const fakeConn = createFakeConnection();
    const dir = mkdtempSync(join(tmpdir(), 'warden-provision-test-'));
    const usersPath = join(dir, 'users-role-override.json');
    const personasPath = join(dir, 'personas-role-override.json');
    writeFileSync(
      usersPath,
      JSON.stringify({
        users: [
          {
            personas: ['base'],
            role: 'SalesRep',
            Username: 'u@example.test',
            LastName: 'User',
            Alias: 'u',
            TimeZoneSidKey: 'America/Los_Angeles',
            LocaleSidKey: 'en_US',
            EmailEncodingKey: 'UTF-8',
            LanguageLocaleKey: 'en_US',
          },
        ],
      })
    );
    writeFileSync(personasPath, JSON.stringify({ personas: { base: { profile: 'Admin', role: 'CEO' } } }));
    fakeConn.query.callsFake(async (soql: string) => {
      if (soql.includes('FROM Profile')) return { records: [{ Id: '00exx0000000001AAA', Name: 'Admin' }] };
      if (soql.includes('FROM UserRole'))
        return {
          records: [
            { Id: '00Exx0000000001AAA', DeveloperName: 'CEO', Name: 'CEO' },
            { Id: '00Exx0000000002AAA', DeveloperName: 'SalesRep', Name: 'Sales Rep' },
          ],
        };
      if (soql.includes('FROM UserLogin')) return { records: [] };
      if (soql.includes('FROM PermissionSetAssignment')) return { records: [] };
      if (soql.includes('FROM GroupMember')) return { records: [] };
      return { records: [] };
    });
    sinon.stub(UserProvision.prototype as unknown as Record<string, unknown>, 'parse').resolves({
      flags: {
        'target-org': { getConnection: () => fakeConn },
        'users-def': usersPath,
        'personas-def': personasPath,
        'external-id': undefined,
        'no-prompt': true,
        'dry-run': false,
        'api-version': undefined,
      },
    } as never);

    await UserProvision.run(['--json']);
    const createCall = fakeConn.sobjectMap.User.create.firstCall;
    const createdUser = (createCall.args[0] as Array<Record<string, unknown>>)[0];
    expect(createdUser.UserRoleId).to.equal('00Exx0000000002AAA');
  });

  it('user profile suppresses persona profile conflict and resolves user value', async () => {
    const fakeConn = createFakeConnection();
    const dir = mkdtempSync(join(tmpdir(), 'warden-provision-test-'));
    const usersPath = join(dir, 'users-conflict-override.json');
    const personasPath = join(dir, 'personas-conflict-override.json');
    writeFileSync(
      usersPath,
      JSON.stringify({
        users: [
          {
            personas: ['a', 'b'],
            profile: 'Custom',
            Username: 'u@example.test',
            LastName: 'User',
            Alias: 'u',
            TimeZoneSidKey: 'America/Los_Angeles',
            LocaleSidKey: 'en_US',
            EmailEncodingKey: 'UTF-8',
            LanguageLocaleKey: 'en_US',
          },
        ],
      })
    );
    writeFileSync(personasPath, JSON.stringify({ personas: { a: { profile: 'Admin' }, b: { profile: 'Standard' } } }));
    fakeConn.query.callsFake(async (soql: string) => {
      if (soql.includes('FROM Profile'))
        return {
          records: [
            { Id: '00exx0000000001AAA', Name: 'Admin' },
            { Id: '00exx0000000002AAA', Name: 'Standard' },
            { Id: '00exx0000000003AAA', Name: 'Custom' },
          ],
        };
      if (soql.includes('FROM UserLogin')) return { records: [] };
      if (soql.includes('FROM PermissionSetAssignment')) return { records: [] };
      if (soql.includes('FROM GroupMember')) return { records: [] };
      return { records: [] };
    });
    sinon.stub(UserProvision.prototype as unknown as Record<string, unknown>, 'parse').resolves({
      flags: {
        'target-org': { getConnection: () => fakeConn },
        'users-def': usersPath,
        'personas-def': personasPath,
        'external-id': undefined,
        'no-prompt': true,
        'dry-run': false,
        'api-version': undefined,
      },
    } as never);

    const result = await UserProvision.run(['--json']);
    expect(result.users[0].status).to.equal('created');
    const createCall = fakeConn.sobjectMap.User.create.firstCall;
    const createdUser = (createCall.args[0] as Array<Record<string, unknown>>)[0];
    expect(createdUser.ProfileId).to.equal('00exx0000000003AAA');
  });

  it('raw ProfileId suppresses persona profile conflict and is used as-is', async () => {
    const fakeConn = createFakeConnection();
    const dir = mkdtempSync(join(tmpdir(), 'warden-provision-test-'));
    const usersPath = join(dir, 'users-conflict-rawid.json');
    const personasPath = join(dir, 'personas-conflict-rawid.json');
    writeFileSync(
      usersPath,
      JSON.stringify({
        users: [
          {
            personas: ['a', 'b'],
            ProfileId: '00exx0000000009AAA',
            Username: 'u@example.test',
            LastName: 'User',
            Alias: 'u',
            TimeZoneSidKey: 'America/Los_Angeles',
            LocaleSidKey: 'en_US',
            EmailEncodingKey: 'UTF-8',
            LanguageLocaleKey: 'en_US',
          },
        ],
      })
    );
    writeFileSync(personasPath, JSON.stringify({ personas: { a: { profile: 'Admin' }, b: { profile: 'Standard' } } }));
    fakeConn.query.callsFake(async (soql: string) => {
      if (soql.includes('FROM Profile'))
        return {
          records: [
            { Id: '00exx0000000001AAA', Name: 'Admin' },
            { Id: '00exx0000000002AAA', Name: 'Standard' },
          ],
        };
      if (soql.includes('FROM UserLogin')) return { records: [] };
      if (soql.includes('FROM PermissionSetAssignment')) return { records: [] };
      if (soql.includes('FROM GroupMember')) return { records: [] };
      return { records: [] };
    });
    sinon.stub(UserProvision.prototype as unknown as Record<string, unknown>, 'parse').resolves({
      flags: {
        'target-org': { getConnection: () => fakeConn },
        'users-def': usersPath,
        'personas-def': personasPath,
        'external-id': undefined,
        'no-prompt': true,
        'dry-run': false,
        'api-version': undefined,
      },
    } as never);

    const result = await UserProvision.run(['--json']);
    expect(result.users[0].status).to.equal('created');
    expect(result.users[0].errors).to.deep.equal([]);
    const createCall = fakeConn.sobjectMap.User.create.firstCall;
    const createdUser = (createCall.args[0] as Array<Record<string, unknown>>)[0];
    expect(createdUser.ProfileId).to.equal('00exx0000000009AAA');
  });

  it('profile + ProfileId on same user produces errorUserProfileConflict per row', async () => {
    const fakeConn = createFakeConnection();
    const dir = mkdtempSync(join(tmpdir(), 'warden-provision-test-'));
    const usersPath = join(dir, 'users-profile-conflict.json');
    const personasPath = join(dir, 'personas-profile-conflict.json');
    writeFileSync(
      usersPath,
      JSON.stringify({
        users: [
          {
            personas: ['base'],
            profile: 'Admin',
            ProfileId: '00exx0000000001AAA',
            Username: 'bad@example.test',
            LastName: 'Bad',
          },
          {
            personas: ['base'],
            Username: 'good@example.test',
            LastName: 'Good',
            Alias: 'good',
            TimeZoneSidKey: 'America/Los_Angeles',
            LocaleSidKey: 'en_US',
            EmailEncodingKey: 'UTF-8',
            LanguageLocaleKey: 'en_US',
          },
        ],
      })
    );
    writeFileSync(personasPath, JSON.stringify({ personas: { base: { profile: 'Admin' } } }));
    fakeConn.query.callsFake(async (soql: string) => {
      if (soql.includes('FROM Profile')) return { records: [{ Id: '00exx0000000001AAA', Name: 'Admin' }] };
      if (soql.includes('FROM UserLogin')) return { records: [] };
      if (soql.includes('FROM PermissionSetAssignment')) return { records: [] };
      if (soql.includes('FROM GroupMember')) return { records: [] };
      return { records: [] };
    });
    sinon.stub(UserProvision.prototype as unknown as Record<string, unknown>, 'parse').resolves({
      flags: {
        'target-org': { getConnection: () => fakeConn },
        'users-def': usersPath,
        'personas-def': personasPath,
        'external-id': undefined,
        'no-prompt': true,
        'dry-run': false,
        'api-version': undefined,
      },
    } as never);

    const result = await UserProvision.run(['--json']);
    const badUser = result.users.find((u) => u.key.includes('bad'));
    const goodUser = result.users.find((u) => u.key.includes('good'));
    expect(badUser?.status).to.equal('failed');
    expect(badUser?.errors.join(' ')).to.include('profile');
    expect(badUser?.errors.join(' ')).to.include('ProfileId');
    expect(goodUser?.status).to.equal('created');
  });

  it('unresolved user profile name fails that user only', async () => {
    const fakeConn = createFakeConnection();
    const dir = mkdtempSync(join(tmpdir(), 'warden-provision-test-'));
    const usersPath = join(dir, 'users-unresolved-profile.json');
    const personasPath = join(dir, 'personas-unresolved-profile.json');
    writeFileSync(
      usersPath,
      JSON.stringify({
        users: [
          {
            personas: ['base'],
            profile: 'DoesNotExist',
            Username: 'bad@example.test',
            LastName: 'Bad',
            Alias: 'bad',
            TimeZoneSidKey: 'America/Los_Angeles',
            LocaleSidKey: 'en_US',
            EmailEncodingKey: 'UTF-8',
            LanguageLocaleKey: 'en_US',
          },
          {
            personas: ['base'],
            Username: 'good@example.test',
            LastName: 'Good',
            Alias: 'good',
            TimeZoneSidKey: 'America/Los_Angeles',
            LocaleSidKey: 'en_US',
            EmailEncodingKey: 'UTF-8',
            LanguageLocaleKey: 'en_US',
          },
        ],
      })
    );
    writeFileSync(personasPath, JSON.stringify({ personas: { base: { profile: 'Admin' } } }));
    fakeConn.query.callsFake(async (soql: string) => {
      if (soql.includes('FROM Profile')) return { records: [{ Id: '00exx0000000001AAA', Name: 'Admin' }] };
      if (soql.includes('FROM UserLogin')) return { records: [] };
      if (soql.includes('FROM PermissionSetAssignment')) return { records: [] };
      if (soql.includes('FROM GroupMember')) return { records: [] };
      return { records: [] };
    });
    sinon.stub(UserProvision.prototype as unknown as Record<string, unknown>, 'parse').resolves({
      flags: {
        'target-org': { getConnection: () => fakeConn },
        'users-def': usersPath,
        'personas-def': personasPath,
        'external-id': undefined,
        'no-prompt': true,
        'dry-run': false,
        'api-version': undefined,
      },
    } as never);

    const result = await UserProvision.run(['--json']);
    const badUser = result.users.find((u) => u.key.includes('bad'));
    const goodUser = result.users.find((u) => u.key.includes('good'));
    expect(badUser?.status).to.equal('failed');
    expect(badUser?.errors.join(' ')).to.include('Profile');
    expect(goodUser?.status).to.equal('created');
  });

  it('unresolved user profile (no persona profile) reports one error, not a duplicate ProfileId-missing', async () => {
    const fakeConn = createFakeConnection();
    const dir = mkdtempSync(join(tmpdir(), 'warden-provision-test-'));
    const usersPath = join(dir, 'users-unresolved-noprofile.json');
    const personasPath = join(dir, 'personas-unresolved-noprofile.json');
    writeFileSync(
      usersPath,
      JSON.stringify({
        users: [
          {
            personas: ['base'],
            profile: 'DoesNotExist',
            Username: 'bad@example.test',
            LastName: 'Bad',
            Alias: 'bad',
            TimeZoneSidKey: 'America/Los_Angeles',
            LocaleSidKey: 'en_US',
            EmailEncodingKey: 'UTF-8',
            LanguageLocaleKey: 'en_US',
          },
        ],
      })
    );
    // Persona deliberately has NO profile, so the only profile source is the (unresolved) user ref.
    writeFileSync(personasPath, JSON.stringify({ personas: { base: { permissionSets: [] } } }));
    fakeConn.query.callsFake(async (soql: string) => {
      if (soql.includes('FROM Profile')) return { records: [] };
      if (soql.includes('FROM UserLogin')) return { records: [] };
      if (soql.includes('FROM PermissionSetAssignment')) return { records: [] };
      if (soql.includes('FROM GroupMember')) return { records: [] };
      return { records: [] };
    });
    sinon.stub(UserProvision.prototype as unknown as Record<string, unknown>, 'parse').resolves({
      flags: {
        'target-org': { getConnection: () => fakeConn },
        'users-def': usersPath,
        'personas-def': personasPath,
        'external-id': undefined,
        'no-prompt': true,
        'dry-run': false,
        'api-version': undefined,
      },
    } as never);

    const result = await UserProvision.run(['--json']);
    const badUser = result.users[0];
    expect(badUser.status).to.equal('failed');
    expect(badUser.errors.join(' ')).to.include('Profile');
    // The unresolved reference is the single root cause; ProfileId should NOT also be flagged as missing.
    expect(badUser.errors.join(' ')).to.not.include('Missing required fields');
  });

  it('passes through permission-flag user fields, with user value winning over persona', async () => {
    const fakeConn = createFakeConnection();
    const dir = mkdtempSync(join(tmpdir(), 'warden-provision-test-'));
    const usersPath = join(dir, 'users-permflag.json');
    const personasPath = join(dir, 'personas-permflag.json');
    writeFileSync(
      usersPath,
      JSON.stringify({
        users: [
          {
            personas: ['base'],
            UserPermissionKnowledgeUser: true,
            Username: 'kuser@example.test',
            LastName: 'Knowledge',
            Alias: 'kuser',
            TimeZoneSidKey: 'America/Los_Angeles',
            LocaleSidKey: 'en_US',
            EmailEncodingKey: 'UTF-8',
            LanguageLocaleKey: 'en_US',
          },
        ],
      })
    );
    // Persona sets the flag false via userAttributes; the user-level true must win.
    writeFileSync(
      personasPath,
      JSON.stringify({
        personas: { base: { profile: 'Admin', userAttributes: { UserPermissionKnowledgeUser: false } } },
      })
    );
    fakeConn.query.callsFake(async (soql: string) => {
      if (soql.includes('FROM Profile')) return { records: [{ Id: '00exx0000000001AAA', Name: 'Admin' }] };
      if (soql.includes('FROM UserLogin')) return { records: [] };
      if (soql.includes('FROM PermissionSetAssignment')) return { records: [] };
      if (soql.includes('FROM GroupMember')) return { records: [] };
      return { records: [] };
    });
    sinon.stub(UserProvision.prototype as unknown as Record<string, unknown>, 'parse').resolves({
      flags: {
        'target-org': { getConnection: () => fakeConn },
        'users-def': usersPath,
        'personas-def': personasPath,
        'external-id': undefined,
        'no-prompt': true,
        'dry-run': false,
        'api-version': undefined,
      },
    } as never);

    const result = await UserProvision.run(['--json']);
    expect(result.users[0].status).to.equal('created');
    const createCall = fakeConn.sobjectMap.User.create.firstCall;
    const createdUser = (createCall.args[0] as Array<Record<string, unknown>>)[0];
    expect(createdUser.UserPermissionKnowledgeUser).to.equal(true);
  });

  it('surfaces per-user errors in human (non-json) output', async () => {
    const fakeConn = createFakeConnection();
    const dir = mkdtempSync(join(tmpdir(), 'warden-provision-test-'));
    const usersPath = join(dir, 'users-human-errors.json');
    const personasPath = join(dir, 'personas-human-errors.json');
    writeFileSync(
      usersPath,
      JSON.stringify({
        users: [
          {
            personas: ['a', 'b'],
            Username: 'conflict@example.test',
            LastName: 'Conflict',
            Alias: 'cflt',
            TimeZoneSidKey: 'America/Los_Angeles',
            LocaleSidKey: 'en_US',
            EmailEncodingKey: 'UTF-8',
            LanguageLocaleKey: 'en_US',
          },
        ],
      })
    );
    writeFileSync(personasPath, JSON.stringify({ personas: { a: { profile: 'Admin' }, b: { profile: 'Standard' } } }));
    fakeConn.query.callsFake(async (soql: string) => {
      if (soql.includes('FROM Profile'))
        return {
          records: [
            { Id: '00exx0000000001AAA', Name: 'Admin' },
            { Id: '00exx0000000002AAA', Name: 'Standard' },
          ],
        };
      return { records: [] };
    });
    sinon.stub(UserProvision.prototype as unknown as Record<string, unknown>, 'parse').resolves({
      flags: {
        'target-org': { getConnection: () => fakeConn },
        'users-def': usersPath,
        'personas-def': personasPath,
        'external-id': undefined,
        'no-prompt': true,
        'dry-run': false,
        'api-version': undefined,
      },
    } as never);

    // No --json: per-user failures must be surfaced as warnings, not hidden behind the summary line.
    await UserProvision.run([]);
    const warned = sfCommandStubs.warn.getCalls().map((c) => String(c.args[0]));
    expect(warned.some((m) => m.includes('conflict@example.test') && m.toLowerCase().includes('failed'))).to.equal(
      true
    );
    expect(warned.some((m) => m.includes('Personas conflict on profile'))).to.equal(true);
  });

  it('legacy persona key produces migration error per user', async () => {
    const fakeConn = createFakeConnection();
    const dir = mkdtempSync(join(tmpdir(), 'warden-provision-test-'));
    const usersPath = join(dir, 'users-legacy.json');
    const personasPath = join(dir, 'personas-legacy.json');
    writeFileSync(
      usersPath,
      JSON.stringify({
        users: [
          {
            persona: 'default',
            Username: 'u@example.test',
            LastName: 'U',
            Alias: 'u',
            TimeZoneSidKey: 'America/Los_Angeles',
            LocaleSidKey: 'en_US',
            EmailEncodingKey: 'UTF-8',
            LanguageLocaleKey: 'en_US',
          },
        ],
      })
    );
    writeFileSync(personasPath, JSON.stringify({ personas: { default: { profile: 'Admin' } } }));
    fakeConn.query.callsFake(async (soql: string) => {
      if (soql.includes('FROM Profile')) return { records: [{ Id: '00exx0000000001AAA', Name: 'Admin' }] };
      return { records: [] };
    });
    sinon.stub(UserProvision.prototype as unknown as Record<string, unknown>, 'parse').resolves({
      flags: {
        'target-org': { getConnection: () => fakeConn },
        'users-def': usersPath,
        'personas-def': personasPath,
        'external-id': undefined,
        'no-prompt': true,
        'dry-run': false,
        'api-version': undefined,
      },
    } as never);

    const result = await UserProvision.run(['--json']);
    expect(result.users[0].status).to.equal('failed');
    expect(result.users[0].errors.join(' ')).to.include('persona');
    expect(result.users[0].errors.join(' ')).to.include('personas');
  });
});
