import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'chai';
import sinon from 'sinon';
import { TestContext } from '@salesforce/core/testSetup';
import { stubSfCommandUx } from '@salesforce/sf-plugins-core';
import {
  freeze,
  provision,
  restore,
  summarizeLifecycle,
  unfreeze,
  type FreezePlan,
  type LifecycleResult,
  type ProvisionPlan,
  type ProvisionResult,
  type RestorePlan,
} from '@syntax-syllogism/warden-core';
import UserFreeze from '../../src/commands/warden/freeze.js';
import PersonaImport from '../../src/commands/warden/persona/import.js';
import UserProvision from '../../src/commands/warden/provision.js';
import UserRestore from '../../src/commands/warden/restore.js';
import UserUnfreeze from '../../src/commands/warden/unfreeze.js';
import {
  COMPONENT_PERSONA_FIELD,
  COMPONENT_REFERENCE_FIELD,
  COMPONENT_TYPE_FIELD,
  PERSONA_COMPONENT_OBJECT,
  PERSONA_OBJECT,
  type PersonaDiff,
  type PersonaPromotionResult,
} from '../../src/userShared/personas.js';
import type { Effect, OperationContext, WriteOperation } from '../../src/sfd/contract.js';
import operations from '../../src/sfd/operations.js';

type FailureContext = OperationContext & { failures?: number };

const context = (cwd: string): FailureContext => {
  const ctx: FailureContext = {
    signal: new AbortController().signal,
    onProgress: () => undefined,
    notice: () => undefined,
    resolvePath: (path) => join(cwd, path),
    org: { username: 'warden-dev@example.test', apiVersion: '66.0', type: 'scratch' },
  };
  ctx.reportFailures = (count) => {
    ctx.failures = count;
  };
  return ctx;
};

type PersonaImportOptions = { input: string; prune?: boolean };
type PersonaImportOperationPlan = {
  effects: Effect[];
  preview: PersonaDiff;
  core: unknown;
};
type PersonaImportOperation = WriteOperation<PersonaImportOptions, PersonaImportOperationPlan, PersonaPromotionResult>;

const personaImportOperation = (): PersonaImportOperation => {
  const found = operations.operations.find((operation) => operation.descriptor.id === 'warden.persona-import');
  if (!found || found.kind !== 'write') throw new Error('Missing write operation warden.persona-import');
  return found as unknown as PersonaImportOperation;
};

const personaConnection = (personas: Array<Record<string, unknown>>) => ({
  query: sinon.stub().resolves({ records: personas }),
  sobject: sinon.spy(),
});

const personaWriteConnection = () => {
  const remove = sinon.stub().resolves({ success: true, id: 'c01' });
  const sobject = sinon.stub();
  sobject.withArgs(PERSONA_OBJECT).returns({ upsert: sinon.stub().resolves({ success: true, id: 'a01' }) });
  sobject.withArgs(PERSONA_COMPONENT_OBJECT).returns({ create: sinon.stub(), delete: remove });
  return {
    query: sinon.stub().callsFake(async (soql: string) => ({
      records: soql.includes('FROM wdn_Persona__c')
        ? [persona('support')]
        : [
            {
              Id: 'c01',
              [COMPONENT_PERSONA_FIELD]: 'a01',
              [COMPONENT_TYPE_FIELD]: 'Permission Set',
              [COMPONENT_REFERENCE_FIELD]: 'Legacy_Read',
            },
          ],
    })),
    sobject,
    remove,
  };
};

const persona = (apiName: string): Record<string, unknown> => ({
  Id: 'a01',
  ['wdn_Api_Name__c']: apiName,
  ['wdn_Active__c']: true,
});

type WriteId = 'warden.provision' | 'warden.restore' | 'warden.freeze' | 'warden.unfreeze';
type WriteUnderTest = WriteOperation<Record<string, unknown>, Record<string, unknown>, unknown>;

const writeOperation = (id: WriteId): WriteUnderTest => {
  const found = operations.operations.find((operation) => operation.descriptor.id === id);
  if (!found || found.kind !== 'write') throw new Error(`Missing write operation ${id}`);
  return found as unknown as WriteUnderTest;
};

const lifecycleUser = (actionKey: string) => ({
  key: 'Username:target@example.test',
  userId: '005target',
  userName: 'Target User',
  username: 'target@example.test',
  status: 'planned' as const,
  actions: [{ key: actionKey, label: actionKey }],
  skipped: [],
  warnings: [],
  errors: [],
});

const lifecycleResult = (changed = true, actionKey = 'frozen', failed = 0): LifecycleResult =>
  ({
    summary: { total: (changed ? 1 : 0) + failed, changed: changed ? 1 : 0, unchanged: 0, failed },
    users: changed ? [lifecycleUser(actionKey)] : [],
  } as LifecycleResult);

const lifecyclePlan = (changed = true, actionKey = 'frozen'): FreezePlan =>
  ({
    updates: changed ? ([{ Id: '0LLtarget', IsFrozen: true }] as unknown[]) : [],
    users: changed ? [lifecycleUser(actionKey)] : [],
    warnings: [],
  } as unknown as FreezePlan);

const failedLifecyclePlan = (actionKey = 'frozen'): FreezePlan =>
  ({
    updates: [],
    users: [{ ...lifecycleUser(actionKey), status: 'failed', actions: [], errors: ['User could not be resolved'] }],
    warnings: [],
  } as unknown as FreezePlan);

const restorePlan = (changed = true): RestorePlan =>
  ({
    preview: lifecycleResult(changed, 'assignedPermissionSet'),
    users: [],
    warnings: [],
    errors: [],
  } as unknown as RestorePlan);

const provisionResult = (changed = true, failed = 0): ProvisionResult =>
  ({
    summary: { total: (changed ? 1 : 0) + failed, created: 0, updated: changed ? 1 : 0, failed, warnings: 0 },
    users: changed
      ? [
          {
            key: 'target',
            personas: [],
            matchedBy: 'Username',
            matchValue: 'target@example.test',
            matched: true,
            status: 'updated',
            actions: ['updated'],
            errors: [],
            relatedRecords: [],
          },
        ]
      : failed > 0
      ? [
          {
            key: 'failed-target',
            personas: [],
            matchedBy: 'Username',
            matchValue: 'failed@example.test',
            matched: false,
            status: 'failed',
            actions: [],
            errors: ['User could not be resolved'],
            relatedRecords: [],
          },
        ]
      : [],
  } as unknown as ProvisionResult);

const provisionPlan = (changed = true): ProvisionPlan =>
  ({
    preview: provisionResult(changed),
    warnings: [],
    plans: [],
    refs: [],
    validationResults: [],
    licenses: [],
  } as unknown as ProvisionPlan);

const writeConnection = () => {
  const write = sinon.stub().resolves([{ success: true, id: '0LLtarget', errors: [] }]);
  return {
    describe: sinon.stub().resolves({ fields: [{ name: 'Username', filterable: true }] }),
    query: sinon.stub().resolves({ records: [{ Id: '005target', Username: 'target@example.test', IsActive: true }] }),
    sobject: sinon.stub().returns({ create: write, update: write, delete: write }),
    write,
  };
};

const lifecycleFlags = (connection: ReturnType<typeof writeConnection>, dryRun: boolean) => ({
  'target-org': { getConnection: () => connection },
  user: 'Username:target@example.test',
  'users-def': undefined,
  'external-id': undefined,
  'input-format': undefined,
  'csv-list-delimiter': undefined,
  'no-prompt': true,
  'dry-run': dryRun,
  'api-version': undefined,
  interactive: false,
});

const provisionFlags = (connection: ReturnType<typeof writeConnection>, usersDef: string, dryRun: boolean) => ({
  'target-org': { getConnection: () => connection },
  'users-def': usersDef,
  'personas-def': undefined,
  'persona-source': 'file',
  'related-def': undefined,
  'external-id': undefined,
  'input-format': undefined,
  'csv-list-delimiter': undefined,
  'fuzzy-username': false,
  'cleanup-on-failure': false,
  'fail-on-insufficient-license': false,
  'log-to-org': false,
  'log-detail': 'summary',
  'no-prompt': true,
  'dry-run': dryRun,
  'api-version': undefined,
  interactive: false,
});

const restoreFlags = (connection: ReturnType<typeof writeConnection>, snapshot: string, dryRun: boolean) => ({
  'target-org': { getConnection: () => connection },
  snapshot,
  'no-prompt': true,
  'dry-run': dryRun,
  'api-version': undefined,
  interactive: false,
});

const personaImportFlags = (connection: ReturnType<typeof personaWriteConnection>, input: string, dryRun: boolean) => ({
  'target-org': { getConnection: () => connection },
  input,
  prune: true,
  'dry-run': dryRun,
  'api-version': undefined,
});

describe('sfd warden write operations', () => {
  afterEach(() => sinon.restore());

  it('declares unsafe retries and serializable plans for every write', () => {
    const writes = operations.operations.filter((operation) => operation.kind === 'write');

    expect(writes.map((operation) => operation.descriptor.id)).to.deep.equal([
      'warden.provision',
      'warden.restore',
      'warden.freeze',
      'warden.unfreeze',
      'warden.persona-import',
    ]);
    for (const operation of writes) {
      expect(operation.descriptor.retry).to.equal('unsafe');
      expect(operation.descriptor.effects).to.include('org-write');
    }
  });

  it('plans persona imports without DML, narrows no-change effects, and survives JSON round-tripping', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'warden-sfd-persona-write-'));
    writeFileSync(join(directory, 'personas.json'), JSON.stringify({ personas: { support: {} } }));
    const conn = personaConnection([persona('support')]);

    const plan = await personaImportOperation().plan(
      conn as never,
      { input: 'personas.json', prune: true },
      context(directory)
    );

    expect(conn.sobject.called).to.equal(false);
    expect(plan.effects).to.deep.equal([]);
    expect(JSON.parse(JSON.stringify(plan))).to.deep.equal(plan);
  });

  it('marks persona pruning that removes components destructive and makes apply errors unsafe', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'warden-sfd-persona-prune-'));
    writeFileSync(join(directory, 'personas.json'), JSON.stringify({ personas: {} }));
    const conn = personaConnection([persona('support')]);
    const operation = personaImportOperation();
    const plan = await operation.plan(conn as never, { input: 'personas.json', prune: true }, context(directory));

    expect(plan.effects).to.deep.equal(['org-write', 'destructive']);
    writeFileSync(join(directory, 'personas.json'), JSON.stringify({ personas: { support: {} } }));
    const failingConn = personaConnection([persona('support')]);
    const failingPlan = await operation.plan(failingConn as never, { input: 'personas.json' }, context(directory));
    try {
      await operation.apply(failingConn as never, failingPlan, context(directory));
      expect.fail('Expected persona import apply to fail with the stubbed connection.');
    } catch (error) {
      expect((error as { retryable?: string }).retryable).to.equal('unsafe');
    }
  });

  it('matches persona import command preview and apply output when pruning', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'warden-sfd-persona-parity-'));
    const input = join(directory, 'personas.json');
    writeFileSync(input, JSON.stringify({ personas: { support: {} } }));
    const operation = personaImportOperation();

    const operationPlan = await operation.plan(
      personaWriteConnection() as never,
      { input: 'personas.json', prune: true },
      context(directory)
    );
    const previewConnection = personaWriteConnection();
    sinon
      .stub(PersonaImport.prototype as unknown as Record<string, unknown>, 'parse')
      .resolves({ flags: personaImportFlags(previewConnection, input, true) } as never);
    expect(await PersonaImport.run(['--json'])).to.deep.equal(operationPlan.preview);
    expect(previewConnection.sobject.notCalled).to.equal(true);

    sinon.restore();
    const applyConnection = personaWriteConnection();
    const operationResult = await operation.apply(applyConnection as never, operationPlan, context(directory));
    const commandConnection = personaWriteConnection();
    sinon
      .stub(PersonaImport.prototype as unknown as Record<string, unknown>, 'parse')
      .resolves({ flags: personaImportFlags(commandConnection, input, false) } as never);
    expect(await PersonaImport.run(['--json'])).to.deep.equal(operationResult);
    expect(operationPlan.effects).to.deep.equal(['org-write', 'destructive']);
    expect(applyConnection.remove.calledOnceWithExactly(['c01'])).to.equal(true);
    expect(commandConnection.remove.calledOnceWithExactly(['c01'])).to.equal(true);
  });
});

describe('sfd warden write operation parity and safety', () => {
  const $$ = new TestContext();

  beforeEach(() => {
    stubSfCommandUx($$.SANDBOX);
  });

  afterEach(() => {
    process.exitCode = undefined;
    sinon.restore();
    $$.restore();
  });

  it('rejects lifecycle requests with both or neither target before planning', async () => {
    await Promise.all(
      (
        [
          ['warden.freeze', freeze],
          ['warden.unfreeze', unfreeze],
        ] as const
      ).map(async ([id, core]) => {
        const operation = writeOperation(id);
        const plan = sinon.stub(core, 'plan');
        const conn = writeConnection();

        await Promise.all(
          [{}, { user: 'Username:target@example.test', usersDef: 'users.json' }].map(async (options) => {
            try {
              await operation.plan(conn as never, options, context(tmpdir()));
              expect.fail(`Expected ${id} to reject invalid lifecycle targets.`);
            } catch (error) {
              expect((error as Error).message).to.include('user');
              expect(plan.notCalled).to.equal(true);
            }
          })
        );

        expect(operation.descriptor.optionsSchema.safeParse({}).success).to.equal(false);
        expect(
          operation.descriptor.optionsSchema.safeParse({ user: 'Username:target@example.test', usersDef: 'users.json' })
            .success
        ).to.equal(false);
        plan.restore();
      })
    );
  });

  for (const [id, command, core, options, actionKey] of [
    ['warden.freeze', UserFreeze, freeze, { user: 'Username:target@example.test' }, 'frozen'],
    ['warden.unfreeze', UserUnfreeze, unfreeze, { user: 'Username:target@example.test' }, 'unfrozen'],
  ] as const) {
    it(`${id} plans without DML, survives JSON, and matches command preview and apply output`, async () => {
      const directory = mkdtempSync(join(tmpdir(), `warden-sfd-${id}-`));
      const operation = writeOperation(id);
      sinon.stub(core, 'plan').resolves(lifecyclePlan(true, actionKey));
      sinon.stub(core, 'apply').resolves(lifecycleResult(true, actionKey));

      const planConnection = writeConnection();
      const planContext = context(directory);
      const plan = await operation.plan(planConnection as never, options, planContext);
      expect(planConnection.sobject.called).to.equal(false);
      expect(JSON.parse(JSON.stringify(plan))).to.deep.equal(plan);
      expect(planContext.failures).to.equal(0);

      const previewConnection = writeConnection();
      sinon
        .stub(command.prototype as unknown as Record<string, unknown>, 'parse')
        .resolves({ flags: lifecycleFlags(previewConnection, true) } as never);
      expect(await command.run(['--json'])).to.deep.equal(plan.preview);

      sinon.restore();
      sinon.stub(core, 'plan').resolves(lifecyclePlan(true, actionKey));
      sinon.stub(core, 'apply').resolves(lifecycleResult(true, actionKey));
      const applyConnection = writeConnection();
      const applyPlan = await operation.plan(applyConnection as never, options, context(directory));
      const applyContext = context(directory);
      const operationResult = await operation.apply(applyConnection as never, applyPlan, applyContext);
      expect(applyContext.failures).to.equal(0);
      sinon
        .stub(command.prototype as unknown as Record<string, unknown>, 'parse')
        .resolves({ flags: lifecycleFlags(writeConnection(), false) } as never);
      expect(await command.run(['--json'])).to.deep.equal(operationResult);
    });

    it(`${id} narrows no-change plans and labels apply failures unsafe`, async () => {
      const operation = writeOperation(id);
      sinon.stub(core, 'plan').resolves(lifecyclePlan(false));
      sinon.stub(core, 'apply').rejects(new Error('write failed'));
      const connection = writeConnection();
      const plan = await operation.plan(connection as never, options, context(tmpdir()));
      expect(plan.effects).to.deep.equal([]);
      try {
        await operation.apply(connection as never, plan, context(tmpdir()));
        expect.fail('Expected apply to fail.');
      } catch (error) {
        expect((error as { retryable?: string }).retryable).to.equal('unsafe');
      }
    });
  }

  it('provision plans without DML, survives JSON, and matches command preview and apply output', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'warden-sfd-provision-'));
    writeFileSync(join(directory, 'users.json'), JSON.stringify({ users: [] }));
    const operation = writeOperation('warden.provision');
    sinon.stub(provision, 'plan').resolves(provisionPlan());
    sinon.stub(provision, 'apply').resolves(provisionResult());

    const planConnection = writeConnection();
    const planContext = context(directory);
    const plan = await operation.plan(
      planConnection as never,
      { usersDef: 'users.json', personaSource: 'file' },
      planContext
    );
    expect(planConnection.sobject.called).to.equal(false);
    expect(JSON.parse(JSON.stringify(plan))).to.deep.equal(plan);
    expect(planContext.failures).to.equal(0);

    const previewConnection = writeConnection();
    sinon
      .stub(UserProvision.prototype as unknown as Record<string, unknown>, 'parse')
      .resolves({ flags: provisionFlags(previewConnection, join(directory, 'users.json'), true) } as never);
    expect(await UserProvision.run(['--json'])).to.deep.equal(plan.preview);

    sinon.restore();
    sinon.stub(provision, 'plan').resolves(provisionPlan());
    sinon.stub(provision, 'apply').resolves(provisionResult());
    const applyConnection = writeConnection();
    const applyPlan = await operation.plan(
      applyConnection as never,
      { usersDef: 'users.json', personaSource: 'file' },
      context(directory)
    );
    const applyContext = context(directory);
    const operationResult = await operation.apply(applyConnection as never, applyPlan, applyContext);
    expect(applyContext.failures).to.equal(0);
    sinon
      .stub(UserProvision.prototype as unknown as Record<string, unknown>, 'parse')
      .resolves({ flags: provisionFlags(writeConnection(), join(directory, 'users.json'), false) } as never);
    expect(await UserProvision.run(['--json'])).to.deep.equal(operationResult);
  });

  it('provision narrows no-change plans and labels apply failures unsafe', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'warden-sfd-provision-no-change-'));
    writeFileSync(join(directory, 'users.json'), JSON.stringify({ users: [] }));
    const operation = writeOperation('warden.provision');
    sinon.stub(provision, 'plan').resolves(provisionPlan(false));
    sinon.stub(provision, 'apply').rejects(new Error('write failed'));
    const connection = writeConnection();
    const plan = await operation.plan(
      connection as never,
      { usersDef: 'users.json', personaSource: 'file' },
      context(directory)
    );
    expect(plan.effects).to.deep.equal([]);
    try {
      await operation.apply(connection as never, plan, context(directory));
      expect.fail('Expected apply to fail.');
    } catch (error) {
      expect((error as { retryable?: string }).retryable).to.equal('unsafe');
    }
  });

  it('restore plans without DML, survives JSON, and matches command preview and apply output', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'warden-sfd-restore-'));
    const snapshot = join(directory, 'snapshot.json');
    writeFileSync(snapshot, JSON.stringify({ snapshotVersion: 1, capturedAt: '', users: [] }));
    const operation = writeOperation('warden.restore');
    sinon.stub(restore, 'plan').resolves(restorePlan());
    sinon.stub(restore, 'apply').resolves(lifecycleResult(true, 'assignedPermissionSet'));

    const planConnection = writeConnection();
    const planContext = context(directory);
    const plan = await operation.plan(planConnection as never, { snapshot: 'snapshot.json' }, planContext);
    expect(planConnection.sobject.called).to.equal(false);
    expect(JSON.parse(JSON.stringify(plan))).to.deep.equal(plan);
    expect(planContext.failures).to.equal(0);

    const previewConnection = writeConnection();
    sinon
      .stub(UserRestore.prototype as unknown as Record<string, unknown>, 'parse')
      .resolves({ flags: restoreFlags(previewConnection, snapshot, true) } as never);
    expect(await UserRestore.run(['--json'])).to.deep.equal(plan.preview);

    sinon.restore();
    sinon.stub(restore, 'plan').resolves(restorePlan());
    sinon.stub(restore, 'apply').resolves(lifecycleResult(true, 'assignedPermissionSet'));
    const applyConnection = writeConnection();
    const applyPlan = await operation.plan(applyConnection as never, { snapshot: 'snapshot.json' }, context(directory));
    const applyContext = context(directory);
    const operationResult = await operation.apply(applyConnection as never, applyPlan, applyContext);
    expect(applyContext.failures).to.equal(0);
    sinon
      .stub(UserRestore.prototype as unknown as Record<string, unknown>, 'parse')
      .resolves({ flags: restoreFlags(writeConnection(), snapshot, false) } as never);
    expect(await UserRestore.run(['--json'])).to.deep.equal(operationResult);
  });

  it('restore narrows no-change plans and labels apply failures unsafe', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'warden-sfd-restore-no-change-'));
    writeFileSync(join(directory, 'snapshot.json'), JSON.stringify({ snapshotVersion: 1, capturedAt: '', users: [] }));
    const operation = writeOperation('warden.restore');
    sinon.stub(restore, 'plan').resolves(restorePlan(false));
    sinon.stub(restore, 'apply').rejects(new Error('write failed'));
    const connection = writeConnection();
    const plan = await operation.plan(connection as never, { snapshot: 'snapshot.json' }, context(directory));
    expect(plan.effects).to.deep.equal([]);
    try {
      await operation.apply(connection as never, plan, context(directory));
      expect.fail('Expected apply to fail.');
    } catch (error) {
      expect((error as { retryable?: string }).retryable).to.equal('unsafe');
    }
  });

  it('reports failed users from every write plan and apply', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'warden-sfd-report-failures-'));
    writeFileSync(join(directory, 'users.json'), JSON.stringify({ users: [] }));
    writeFileSync(join(directory, 'snapshot.json'), JSON.stringify({ snapshotVersion: 1, capturedAt: '', users: [] }));
    const provisionOperation = writeOperation('warden.provision');
    const provisionFailure = provisionResult(false, 1);
    sinon.stub(provision, 'plan').resolves({ ...provisionPlan(false), preview: provisionFailure });
    sinon.stub(provision, 'apply').resolves(provisionFailure);
    const provisionPlanContext = context(directory);
    const provisionPlanResult = await provisionOperation.plan(
      writeConnection() as never,
      { usersDef: 'users.json', personaSource: 'file' },
      provisionPlanContext
    );
    expect(provisionPlanContext.failures, 'provision plan').to.equal(1);
    const provisionApplyContext = context(directory);
    await provisionOperation.apply(writeConnection() as never, provisionPlanResult, provisionApplyContext);
    expect(provisionApplyContext.failures, 'provision apply').to.equal(1);

    const restoreOperation = writeOperation('warden.restore');
    const restoreFailure = lifecycleResult(false, 'assignedPermissionSet', 1);
    sinon.stub(restore, 'plan').resolves({ ...restorePlan(false), preview: restoreFailure });
    sinon.stub(restore, 'apply').resolves(restoreFailure);
    const restorePlanContext = context(directory);
    const restorePlanResult = await restoreOperation.plan(
      writeConnection() as never,
      { snapshot: 'snapshot.json' },
      restorePlanContext
    );
    expect(restorePlanContext.failures, 'restore plan').to.equal(1);
    const restoreApplyContext = context(directory);
    await restoreOperation.apply(writeConnection() as never, restorePlanResult, restoreApplyContext);
    expect(restoreApplyContext.failures, 'restore apply').to.equal(1);

    await Promise.all(
      (
        [
          ['warden.freeze', freeze, 'frozen'],
          ['warden.unfreeze', unfreeze, 'unfrozen'],
        ] as const
      ).map(async ([id, core, actionKey]) => {
        const operation = writeOperation(id);
        const planned = failedLifecyclePlan(actionKey);
        const applied = lifecycleResult(false, actionKey, 1);
        sinon.stub(core, 'plan').resolves(planned);
        sinon.stub(core, 'apply').resolves(applied);
        const planContext = context(directory);
        const plan = await operation.plan(
          writeConnection() as never,
          { user: 'Username:target@example.test' },
          planContext
        );
        expect((plan.preview as LifecycleResult).summary).to.deep.equal(summarizeLifecycle(planned.users));
        expect(planContext.failures, `${id} plan`).to.equal(1);
        const applyContext = context(directory);
        await operation.apply(writeConnection() as never, plan, applyContext);
        expect(applyContext.failures, `${id} apply`).to.equal(1);
      })
    );
  });

  it('works with older sfd hosts that do not support failure reporting', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'warden-sfd-legacy-host-'));
    writeFileSync(join(directory, 'users.json'), JSON.stringify({ users: [] }));
    sinon.stub(provision, 'plan').resolves(provisionPlan());
    const legacyContext = context(directory);
    delete legacyContext.reportFailures;

    await writeOperation('warden.provision').plan(
      writeConnection() as never,
      { usersDef: 'users.json', personaSource: 'file' },
      legacyContext
    );
  });
});
