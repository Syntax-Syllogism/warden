import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TestContext } from '@salesforce/core/testSetup';
import { stubSfCommandUx } from '@salesforce/sf-plugins-core';
import { diff as coreDiff } from '@syntax-syllogism/warden-core';
import { expect } from 'chai';
import sinon from 'sinon';
import UserAccess from '../../src/commands/warden/access.js';
import UserDiff from '../../src/commands/warden/diff.js';
import PersonaDiffCommand from '../../src/commands/warden/persona/diff.js';
import PersonaExport from '../../src/commands/warden/persona/export.js';
import UserSnapshot from '../../src/commands/warden/snapshot.js';
import type { CliTable, OperationModule } from '../../src/sfd/contract.js';
import operations, { diffFailureCount } from '../../src/sfd/operations.js';

const expectedCliOptions: Record<string, string[]> = {
  'warden.access': ['type', 'target', 'user', 'sobject'],
  'warden.diff': [
    'user',
    'against',
    'usersDef',
    'personasDef',
    'externalId',
    'inputFormat',
    'csvListDelimiter',
    'verbose',
    'verify',
    'failOnDrift',
  ],
  'warden.snapshot': ['user', 'usersDef', 'externalId', 'inputFormat', 'csvListDelimiter', 'out'],
  'warden.persona-diff': ['input'],
  'warden.persona-export': ['output'],
  'warden.provision': [
    'usersDef',
    'personasDef',
    'personaSource',
    'relatedDef',
    'externalId',
    'inputFormat',
    'csvListDelimiter',
    'fuzzyUsername',
    'cleanupOnFailure',
    'failOnInsufficientLicense',
  ],
  'warden.restore': ['snapshot'],
  'warden.freeze': ['user', 'usersDef', 'externalId', 'inputFormat', 'csvListDelimiter'],
  'warden.unfreeze': ['user', 'usersDef', 'externalId', 'inputFormat', 'csvListDelimiter'],
  'warden.strip': [
    'user',
    'usersDef',
    'externalId',
    'inputFormat',
    'csvListDelimiter',
    'noFreeze',
    'noDeactivate',
    'personas',
    'allPersonas',
    'personasDef',
    'personaSource',
    'freeze',
    'deactivate',
    'keepPermsets',
    'keepPermsetGroups',
    'keepLicenses',
    'keepPublicGroups',
    'keepQueues',
    'snapshot',
  ],
  'warden.persona-import': ['input', 'prune'],
};

const assertConformance = (module: OperationModule): void => {
  expect(module.apiVersion).to.equal(0);
  expect(module.operations).to.have.length(11);

  const ids = new Set<string>();
  for (const candidate of module.operations) {
    expect(candidate.descriptor.id).to.match(/^warden\./);
    expect(ids.has(candidate.descriptor.id)).to.equal(false);
    ids.add(candidate.descriptor.id);
    expect(candidate.descriptor.cliId).to.match(/^warden:/);
    expect(candidate.descriptor.title).to.be.a('string').and.not.empty;
    expect(candidate.descriptor.summary).to.be.a('string').and.not.empty;
    expect(candidate.descriptor.effects).to.not.be.empty;
    expect(candidate.descriptor.requiresOrg).to.equal('required');
    expect(candidate.descriptor.requiresProject).to.equal(false);
    expect(candidate.descriptor.retry).to.equal(candidate.kind === 'read' ? 'safe' : 'unsafe');
    if (candidate.kind === 'write') expect(candidate.descriptor.effects).to.include('org-write');
  }
};

const assertCliTable = (table: CliTable, module: OperationModule): void => {
  expect(table.apiVersion).to.equal(module.apiVersion);
  expect(table.commands).to.have.length(module.operations.length);

  const operationById = new Map(module.operations.map((candidate) => [candidate.descriptor.id, candidate]));
  const commandIds = new Set<string>();
  for (const command of table.commands) {
    const candidate = operationById.get(command.operation);
    expect(candidate, `Missing operation for ${command.operation}`).to.not.equal(undefined);
    expect(commandIds.has(command.operation), `Duplicate CLI command for ${command.operation}`).to.equal(false);
    commandIds.add(command.operation);
    expect(command.name).to.deep.equal(candidate?.descriptor.cliId?.split(':'));
    expect(command.sf).to.deep.equal(command.name);
    expect(command.summary).to.be.a('string').and.not.empty;
    expect(command.agentTip).to.be.a('string').and.not.empty;
    expect(command.formatter).to.be.oneOf(['table', 'csv', 'summary', 'json']);
    expect(
      command.flags.map((flag) => flag.option).filter((option): option is string => option !== undefined)
    ).to.deep.equal(expectedCliOptions[command.operation]);
  }

  expect([...commandIds].sort()).to.deep.equal([...operationById.keys()].sort());
};

const operation = (
  id: string
): { run: (conn: unknown, options: unknown, ctx: ReturnType<typeof context>) => Promise<unknown> } => {
  const found = operations.operations.find((candidate) => candidate.descriptor.id === id);
  if (!found || found.kind !== 'read') throw new Error(`Missing read operation ${id}`);
  return found as unknown as {
    run: (conn: unknown, options: unknown, ctx: ReturnType<typeof context>) => Promise<unknown>;
  };
};

const context = (cwd: string, preserveAbsolutePaths = false) => {
  let failures: number | undefined;
  return {
    signal: new AbortController().signal,
    onProgress: () => undefined,
    notice: () => undefined,
    reportFailures: (count: number): void => {
      failures = count;
    },
    get _failures(): number | undefined {
      return failures;
    },
    resolvePath: (path: string) => (preserveAbsolutePaths ? path : join(cwd, path)),
    org: { username: 'warden-dev@example.test', apiVersion: '66.0', type: 'scratch' as const },
  };
};

const connection = () => ({
  describe: sinon.stub().resolves({
    name: 'Account',
    fields: [
      { name: 'Username', createable: true, updateable: true, filterable: true, externalId: false },
      { name: 'FederationIdentifier', createable: true, updateable: true, filterable: true, externalId: true },
    ],
  }),
  getApiVersion: sinon.stub().returns('66.0'),
  queryMore: sinon.stub().resolves({ done: true, records: [] }),
  query: sinon.stub().resolves({ done: true, records: [] }),
});

const targetOrg = (conn: ReturnType<typeof connection>) => ({
  getConnection: () => conn,
  getUsername: () => 'warden-dev@example.test',
});

const rejected = async (run: () => Promise<unknown>): Promise<Error & { code?: string }> => {
  try {
    await run();
    expect.fail('Expected command to reject.');
  } catch (error) {
    return error as Error & { code?: string };
  }
  throw new Error('Unreachable');
};

describe('sfd warden operations', () => {
  const $$ = new TestContext();

  beforeEach(() => {
    stubSfCommandUx($$.SANDBOX);
  });

  afterEach(() => {
    process.exitCode = undefined;
    sinon.restore();
    $$.restore();
  });

  it('conforms to the committed runtime contract and CLI table', () => {
    const cli = JSON.parse(readFileSync(new URL('../../cli.json', import.meta.url), 'utf8')) as CliTable;
    const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
      sfd: { requires: { sfd: string } };
    };

    assertConformance(operations);
    assertCliTable(cli, operations);
    expect(manifest.sfd.requires.sfd).to.equal('>=0.7.0');
    const diffOperation = operations.operations.find((candidate) => candidate.descriptor.id === 'warden.diff');
    expect(diffOperation?.descriptor.optionsSchema.safeParse({ failOnDrift: true }).success).to.equal(true);
    for (const candidate of operations.operations) {
      expect(candidate.descriptor.optionsSchema.safeParse({ unexpected: true }).success).to.equal(false);
    }
  });

  it('counts comparison failures, requested drift, and nonconformant verdicts', () => {
    const comparison = (failed: number, changed: number) => ({ summary: { failed, changed } } as never);
    const verdicts = (conformant: boolean[]) => conformant.map((value) => ({ conformant: value })) as never;

    expect(diffFailureCount(comparison(0, 2), false)).to.equal(0);
    expect(diffFailureCount(comparison(0, 2), true)).to.equal(2);
    expect(diffFailureCount(comparison(1, 2), false)).to.equal(1);
    expect(diffFailureCount(verdicts([true, false]), false)).to.equal(1);
    expect(diffFailureCount(verdicts([true, false]), true)).to.equal(1);
  });

  it('reports diff failures through the operation context', async () => {
    const run = sinon.stub(coreDiff, 'run');
    const comparison = (failed: number, changed: number) => ({ summary: { failed, changed } } as never);
    const verdicts = (conformant: boolean[]) => conformant.map((value) => ({ conformant: value })) as never;
    const options = { user: 'Username:alice@example.test', against: 'Username:bob@example.test' };
    const reportFailures = async (request: object, expectedFailures: number): Promise<void> => {
      const ctx = context(tmpdir());

      await operation('warden.diff').run(connection(), request, ctx);

      expect(Reflect.get(ctx, '_failures')).to.equal(expectedFailures);
    };

    run
      .onFirstCall()
      .resolves(comparison(1, 0))
      .onSecondCall()
      .resolves(comparison(0, 2))
      .onThirdCall()
      .resolves(comparison(0, 2))
      .onCall(3)
      .resolves(verdicts([true, true]))
      .onCall(4)
      .resolves(verdicts([true, false]));

    await reportFailures({ ...options, failOnDrift: false }, 1);
    await reportFailures({ ...options, failOnDrift: false }, 0);
    await reportFailures({ ...options, failOnDrift: true }, 2);
    await reportFailures({ usersDef: 'users.csv', inputFormat: 'csv', verify: true, failOnDrift: true }, 0);
    await reportFailures({ usersDef: 'users.csv', inputFormat: 'csv', verify: true, failOnDrift: true }, 1);
  });

  it('matches access command JSON', async () => {
    const conn = connection();
    sinon.stub(UserAccess.prototype as unknown as Record<string, unknown>, 'parse').resolves({
      flags: { 'target-org': targetOrg(conn), type: 'object', target: 'Account', 'api-version': undefined },
    } as never);

    const command = await UserAccess.run(['--json']);
    const runtime = await operation('warden.access').run(
      conn,
      { type: 'object', target: 'Account' },
      context(tmpdir())
    );

    expect(runtime).to.deep.equal(command);
  });

  it('matches diff command JSON', async () => {
    const conn = connection();
    const options = { user: 'Username:alice@example.test', against: 'Username:bob@example.test' };
    sinon.stub(UserDiff.prototype as unknown as Record<string, unknown>, 'parse').resolves({
      flags: {
        'target-org': targetOrg(conn),
        ...options,
        verbose: false,
        'fail-on-drift': false,
        verify: false,
        'api-version': undefined,
      },
    } as never);

    const command = await UserDiff.run(['--json']);
    const runtime = await operation('warden.diff').run(conn, options, context(tmpdir()));

    expect(runtime).to.deep.equal(command);
  });

  it('matches snapshot command JSON', async () => {
    const conn = connection();
    const directory = mkdtempSync(join(tmpdir(), 'warden-sfd-snapshot-parity-'));
    const commandOut = join(directory, 'command.json');
    const runtimeOut = join(directory, 'runtime.json');
    const options = { user: 'Username:missing@example.test' };
    sinon.stub(UserSnapshot.prototype as unknown as Record<string, unknown>, 'parse').resolves({
      flags: {
        'target-org': targetOrg(conn),
        ...options,
        out: commandOut,
        'api-version': undefined,
      },
    } as never);

    const command = await UserSnapshot.run(['--json']);
    const runtime = await operation('warden.snapshot').run(
      conn,
      { ...options, out: runtimeOut },
      context(directory, true)
    );

    expect(runtime).to.deep.equal(command);
  });

  it('reports snapshot user failures and clears the count for a clean snapshot', async () => {
    const failedContext = context(tmpdir());

    await operation('warden.snapshot').run(
      connection(),
      { user: 'Username:missing@example.test', out: 'snapshot.json' },
      failedContext
    );

    expect(Reflect.get(failedContext, '_failures')).to.equal(1);

    const cleanConnection = connection();
    cleanConnection.query.callsFake(async (soql: string) => ({
      done: true,
      records: soql.includes('FROM User')
        ? [{ Id: '005000000000001', IsActive: true, Name: 'Alice', Username: 'alice@example.test' }]
        : [],
    }));
    const cleanContext = context(tmpdir());

    await operation('warden.snapshot').run(
      cleanConnection,
      { user: 'Username:alice@example.test', out: 'clean-snapshot.json' },
      cleanContext
    );

    expect(Reflect.get(cleanContext, '_failures')).to.equal(0);
  });

  it('writes snapshot files like the command for nested and CSV outputs', async () => {
    sinon.useFakeTimers({ now: new Date('2026-01-02T03:04:05.000Z'), toFake: ['Date'] });
    const options = { user: 'Username:missing@example.test' };

    await ['nested/new/snapshot.json', 'nested/new/snapshot.csv'].reduce(async (previous, out) => {
      await previous;
      const commandCwd = mkdtempSync(join(tmpdir(), 'warden-sfd-snapshot-command-'));
      const runtimeCwd = mkdtempSync(join(tmpdir(), 'warden-sfd-snapshot-runtime-'));
      const commandConn = connection();
      const parse = sinon.stub(UserSnapshot.prototype as unknown as Record<string, unknown>, 'parse').resolves({
        flags: {
          'target-org': targetOrg(commandConn),
          ...options,
          out: join(commandCwd, out),
          'api-version': undefined,
        },
      } as never);
      await UserSnapshot.run(['--json']);
      parse.restore();

      const runtime = await operation('warden.snapshot').run(connection(), { ...options, out }, context(runtimeCwd));

      expect(runtime).to.not.be.instanceOf(Error);
      const contents = readFileSync(join(runtimeCwd, out), 'utf8');
      expect(contents).to.equal(readFileSync(join(commandCwd, out), 'utf8'));
      if (out.endsWith('.csv')) expect(contents.trimStart().startsWith('{')).to.equal(false);
    }, Promise.resolve());
  });

  it('matches persona diff command JSON', async () => {
    const conn = connection();
    const directory = mkdtempSync(join(tmpdir(), 'warden-sfd-persona-diff-'));
    const input = join(directory, 'personas.json');
    writeFileSync(input, JSON.stringify({ personas: {} }));
    sinon.stub(PersonaDiffCommand.prototype as unknown as Record<string, unknown>, 'parse').resolves({
      flags: { 'target-org': targetOrg(conn), input, 'api-version': undefined },
    } as never);

    const command = await PersonaDiffCommand.run(['--json']);
    const runtime = await operation('warden.persona-diff').run(conn, { input }, context(directory, true));

    expect(runtime).to.deep.equal(command);
  });

  it('matches persona export command JSON', async () => {
    const conn = connection();
    const output = join(mkdtempSync(join(tmpdir(), 'warden-sfd-persona-export-')), 'personas.json');
    sinon.stub(PersonaExport.prototype as unknown as Record<string, unknown>, 'parse').resolves({
      flags: { 'target-org': targetOrg(conn), output, 'api-version': undefined },
    } as never);

    const command = await PersonaExport.run(['--json']);
    const runtime = await operation('warden.persona-export').run(conn, { output }, context(tmpdir(), true));

    expect(runtime).to.deep.equal(command);
  });

  it('maps command and runtime access validation errors identically', async () => {
    const cases = [
      [{ type: 'object', target: 'Account', sobject: 'Contact' }, 'errorUserModeScopesMutuallyExclusive'],
      [{ type: 'object', sobject: 'Account' }, 'errorSobjectRequiresUser'],
      [{ type: 'object' }, 'errorTargetRequired'],
      [{ type: 'object', user: 'Username:alice@example.test' }, 'errorUserModeRequiresScope'],
      [{ type: 'tab', user: 'Username:alice@example.test', sobject: 'Account' }, 'errorSobjectUnsupported'],
    ] as const;

    await cases.reduce(async (previous, [options, code]) => {
      await previous;
      const conn = connection();
      const parse = sinon.stub(UserAccess.prototype as unknown as Record<string, unknown>, 'parse').resolves({
        flags: { 'target-org': targetOrg(conn), ...options, 'api-version': undefined },
      } as never);
      const commandError = await rejected(() => UserAccess.run(['--json']));
      parse.restore();
      const runtimeError = await rejected(() => operation('warden.access').run(conn, options, context(tmpdir())));

      expect(commandError.name).to.equal('SfError');
      expect(runtimeError.code).to.equal(`warden.${code}`);
      expect(runtimeError.message).to.equal(commandError.message);
    }, Promise.resolve());
  });

  it('resolves snapshot and persona export outputs against the client cwd', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'warden-sfd-output-'));
    const conn = connection();
    const snapshotOutput = 'snapshot.json';
    const exportOutput = 'personas.json';

    await operation('warden.snapshot').run(
      conn,
      { user: 'Username:missing@example.test', out: snapshotOutput },
      context(cwd)
    );
    const exportResult = await operation('warden.persona-export').run(conn, { output: exportOutput }, context(cwd));

    expect(existsSync(join(cwd, snapshotOutput))).to.equal(true);
    expect(exportResult).to.deep.equal({ personas: 0, output: join(cwd, exportOutput) });
    expect(JSON.parse(readFileSync(join(cwd, exportOutput), 'utf8'))).to.deep.equal({ personas: {} });
  });
});
