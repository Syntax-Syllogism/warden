/* eslint-disable camelcase */
import { expect } from 'chai';
import sinon from 'sinon';
import {
  bestEffortOrgWrite,
  buildLedgerRows,
  buildProvenance,
  captureProvisioningWrites,
  detectConnectedPackage,
  updateRun,
  WARDEN_ITEM_OBJECT,
  WARDEN_LEDGER_OBJECT,
  WARDEN_RUN_OBJECT,
  type CapturedGrant,
  writeBatch,
} from '../../src/userShared/orgWrites.js';

describe('connected org writes', () => {
  afterEach(() => sinon.restore());

  it('detects the package through empty-namespace object describes', async () => {
    expect(WARDEN_LEDGER_OBJECT).to.equal('wdn_Provisioned_Grant__c');
    expect(WARDEN_RUN_OBJECT).to.equal('wdn_Reconciliation_Run__c');
    expect(WARDEN_ITEM_OBJECT).to.equal('wdn_Reconciliation_Item__c');
    const connection = {
      describe: sinon.stub(),
    };
    connection.describe.withArgs(WARDEN_LEDGER_OBJECT).resolves({ name: WARDEN_LEDGER_OBJECT });
    connection.describe.withArgs(WARDEN_RUN_OBJECT).rejects(new Error('not installed'));

    const detected = await detectConnectedPackage(connection as never);
    expect(detected).to.deep.equal({
      ledgerAvailable: true,
      runAvailable: false,
    });
  });

  it('builds provenance from injected environment and git values', () => {
    const provenance = buildProvenance({
      definitionPath: './personas.json',
      env: { GITHUB_JOB: 'provision', CI: 'true' },
      cliVersion: '0.6.2',
      invokingUser: 'runner',
      gitSha: () => 'abc123',
    });

    expect(provenance).to.deep.include({
      sourceSystem: 'warden-cli',
      cliVersion: '0.6.2',
      invokingUser: 'runner',
      ciJob: 'provision',
      definitionSha: 'abc123',
    });
    expect(provenance.definitionPath).to.match(/personas\.json$/);
  });

  it('preserves queue type and duplicate-persona matching from developer-name-only group rows', async () => {
    const groupMemberCreate = sinon.stub().resolves([
      { success: true, id: '0GM-public' },
      { success: true, id: '0GM-queue' },
    ]);
    const connection = {
      query: sinon.stub().callsFake(async (soql: string) =>
        soql.includes("Type = 'Queue'")
          ? { records: [{ Id: '00G-queue', DeveloperName: 'Case_Queue' }] }
          : { records: [{ Id: '00G-public', DeveloperName: 'Internal_Users' }] }
      ),
      sobject: sinon.stub().returns({ create: groupMemberCreate }),
    };
    const captured = captureProvisioningWrites(connection as never);
    await captured.connection.query(
      "SELECT Id, DeveloperName FROM Group WHERE DeveloperName IN ('Internal_Users') AND Type = 'Regular'"
    );
    await captured.connection.query(
      "SELECT Id, DeveloperName FROM Group WHERE DeveloperName IN ('Case_Queue') AND Type = 'Queue'"
    );
    const groupMember = captured.connection.sobject('GroupMember') as unknown as {
      create(records: Array<Record<string, string>>): Promise<unknown>;
    };
    await groupMember.create([
      { UserOrGroupId: '005-user', GroupId: '00G-public' },
      { UserOrGroupId: '005-user', GroupId: '00G-queue' },
    ]);

    expect(captured.state.grants).to.deep.equal([
      { userId: '005-user', type: 'Public Group', targetId: '00G-public' },
      { userId: '005-user', type: 'Queue', targetId: '00G-queue' },
    ]);
    const rows = buildLedgerRows({
      grants: [captured.state.grants[1]],
      result: {
        summary: { total: 1, created: 1, updated: 0, failed: 0, warnings: 0 },
        users: [
          {
            id: '005-user',
            key: 'FederationIdentifier:ONE',
            personas: ['first', 'second'],
            matchedBy: null,
            matchValue: null,
            matched: false,
            status: 'created',
            actions: ['assignedQueue'],
            errors: [],
          },
        ],
      },
      personasDoc: { personas: { first: { queues: ['Case_Queue'] }, second: { queues: ['Case_Queue'] } } },
      referenceIdsByType: captured.state.referenceIdsByType,
      labelsByTypeAndId: captured.state.labelsByTypeAndId,
    });
    expect(rows).to.have.length(2);
    expect(rows[0].wdn_Type__c).to.equal('Queue');
  });

  it('emits one ledger row per contributing persona for a duplicated grant', () => {
    const grants: CapturedGrant[] = [{ userId: '005-user', type: 'Permission Set', targetId: '0PS-target' }];
    const rows = buildLedgerRows({
      grants,
      result: {
        summary: { total: 1, created: 1, updated: 0, failed: 0, warnings: 0 },
        users: [
          {
            id: '005-user',
            key: 'FederationIdentifier:ONE',
            personas: ['first', 'second'],
            matchedBy: null,
            matchValue: null,
            matched: false,
            status: 'created',
            actions: ['assignedPermissionSet'],
            errors: [],
          },
        ],
      },
      personasDoc: {
        personas: {
          first: { permissionSets: ['Shared'] },
          second: { permissionSets: ['Shared'] },
        },
      },
      referenceIdsByType: new Map([['Permission Set', new Map([['Shared', '0PS-target']])]]),
      labelsByTypeAndId: new Map([['Permission Set', new Map([['0PS-target', 'Shared']])]]),
      runId: 'a-run',
      grantedOn: '2026-09-26T00:00:00.000Z',
    });

    expect(rows).to.have.length(2);
    expect(rows[0]).to.deep.include({
      wdn_User__c: '005-user',
      wdn_Type__c: 'Permission Set',
      wdn_Target_Id__c: '0PS-target',
      wdn_Target_Label__c: 'Shared',
      wdn_Granted_By_Run__c: 'a-run',
    });
  });

  it('swallows an org write failure without changing the provisioning exit code', async () => {
    process.exitCode = 1;
    const warnings: string[] = [];
    const result = await bestEffortOrgWrite(
      async () => {
        throw new Error('audit unavailable');
      },
      (warning) => warnings.push(warning),
      'ledger'
    );

    expect(result).to.equal(undefined);
    expect(process.exitCode).to.equal(1);
    expect(warnings[0]).to.include('audit unavailable');
    process.exitCode = undefined;
  });

  it('chunks collection writes at 200 records', async () => {
    const create = sinon
      .stub()
      .callsFake(async (records: Array<Record<string, unknown>>) =>
        records.map(() => ({ success: true, id: 'audit-id' }))
      );
    const connection = { sobject: sinon.stub().returns({ create }) };
    const warnings: string[] = [];
    const records = Array.from({ length: 401 }, (_, index) => ({ index }));

    const results = await writeBatch(
      connection as never,
      WARDEN_LEDGER_OBJECT,
      records,
      (warning) => warnings.push(warning),
      'ledger'
    );

    expect(create.callCount).to.equal(3);
    expect(create.getCall(0).args[0]).to.have.length(200);
    expect(create.getCall(1).args[0]).to.have.length(200);
    expect(create.getCall(2).args[0]).to.have.length(1);
    expect(results).to.have.length(401);
    expect(warnings).to.deep.equal([]);
  });

  it('continues later collection batches after a failed batch and warns', async () => {
    const create = sinon.stub();
    create.onFirstCall().rejects(new Error('request too large'));
    create.onSecondCall().resolves([{ success: true, id: 'audit-id' }]);
    const connection = { sobject: sinon.stub().returns({ create }) };
    const warnings: string[] = [];
    const records = Array.from({ length: 201 }, (_, index) => ({ index }));

    const results = await writeBatch(
      connection as never,
      WARDEN_ITEM_OBJECT,
      records,
      (warning) => warnings.push(warning),
      'item'
    );

    expect(create.callCount).to.equal(2);
    expect(results).to.deep.equal([{ success: true, id: 'audit-id' }]);
    expect(warnings).to.have.length(1);
    expect(warnings[0]).to.include('item batch 1/2 write failed');
  });

  it('warns when a collection returns partial save failures', async () => {
    const create = sinon.stub().resolves([{ success: true, id: 'audit-id' }, { success: false, errors: ['invalid'] }]);
    const connection = { sobject: sinon.stub().returns({ create }) };
    const warnings: string[] = [];

    const results = await writeBatch(
      connection as never,
      WARDEN_ITEM_OBJECT,
      [{ index: 1 }, { index: 2 }],
      (warning) => warnings.push(warning),
      'item'
    );

    expect(results).to.have.length(2);
    expect(warnings).to.deep.equal(['Warden org item batch 1/1 returned 1 failed record(s).']);
  });

  it('warns when a resolved Run summary update contains a failed SaveResult', async () => {
    const update = sinon.stub().resolves([
      { success: false, errors: [{ message: 'run is locked' }] },
      { success: true, id: 'run-id' },
    ]);
    const connection = { sobject: sinon.stub().returns({ update }) };
    const warnings: string[] = [];

    await updateRun(connection as never, 'run-id', { wdn_Error_Count__c: 1 }, (warning) => warnings.push(warning));

    expect(update.calledOnce).to.equal(true);
    expect(update.firstCall.args[1]).to.deep.equal({ allOrNone: false });
    expect(warnings).to.deep.equal(['Warden org run summary update result 1/2 failed: run is locked']);
  });
});
