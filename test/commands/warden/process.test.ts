import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect } from 'chai';

describe('warden process-level output', () => {
  it('does not expose its shared command base class as warden base', () => {
    const repoRoot = process.cwd();
    const child = spawnSync(
      process.execPath,
      [
        '--loader',
        'ts-node/esm',
        '--no-warnings=ExperimentalWarning',
        join(repoRoot, 'bin/dev.js'),
        'warden',
        '--help',
      ],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 30_000,
        env: {
          ...process.env,
          FORCE_COLOR: '0',
          NODE_V8_COVERAGE: undefined,
          SF_DISABLE_LOG_FILE: 'true',
        },
      }
    );

    expect(child.error, child.error?.stack).to.equal(undefined);
    expect(child.status).to.equal(0);
    expect(child.stdout).to.not.include('warden base');
  });

  it('keeps the global json envelope successful while returning exit code 1 for partial failure', () => {
    const repoRoot = process.cwd();
    const dir = mkdtempSync(join(tmpdir(), 'warden-process-test-'));
    const usersPath = join(dir, 'users.json');
    const personasPath = join(dir, 'personas.json');
    const preloadPath = join(dir, 'preload.mjs');
    writeFileSync(usersPath, JSON.stringify({ users: [] }));
    writeFileSync(personasPath, JSON.stringify({ personas: {} }));

    const provisionCommand = pathToFileURL(join(repoRoot, 'src/commands/warden/provision.js')).href;
    const provisionUseCase = pathToFileURL(
      join(repoRoot, 'node_modules/@syntax-syllogism/warden-core/lib/index.js')
    ).href;
    writeFileSync(
      preloadPath,
      `
import UserProvision from ${JSON.stringify(provisionCommand)};
import { provision } from ${JSON.stringify(provisionUseCase)};

UserProvision.prototype.parse = async () => ({
  flags: {
    'target-org': { getConnection: () => ({}) },
    'users-def': ${JSON.stringify(usersPath)},
    'personas-def': ${JSON.stringify(personasPath)},
    'external-id': undefined,
    'fuzzy-username': false,
    'no-prompt': true,
    'dry-run': false,
    output: 'human',
    'output-file': undefined,
    'api-version': undefined,
  },
});
UserProvision.prototype.jsonEnabled = () => true;
provision.plan = async () => ({ warnings: [], plans: [], validationResults: [], licenses: [] });
provision.apply = async () => ({
  summary: { total: 1, created: 0, updated: 0, failed: 1, warnings: 0 },
  users: [{
    key: 'Username:failed@example.com',
    status: 'failed',
    personas: [],
    matchedBy: null,
    actions: [],
    errors: ['fixture failure'],
  }],
});
      `.trim()
    );

    const child = spawnSync(
      process.execPath,
      [
        '--loader',
        'ts-node/esm',
        '--import',
        preloadPath,
        join(repoRoot, 'bin/dev.js'),
        'warden',
        'provision',
        '--target-org',
        'test-org',
        '--users-def',
        usersPath,
        '--personas-def',
        personasPath,
        '--json',
      ],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 30_000,
        env: {
          ...process.env,
          FORCE_COLOR: '0',
          NODE_V8_COVERAGE: undefined,
          SF_DISABLE_LOG_FILE: 'true',
        },
      }
    );

    expect(child.error, child.error?.stack).to.equal(undefined);
    expect(child.status).to.equal(1);
    expect(child.stdout, child.stderr).to.not.equal('');
    const envelope = JSON.parse(child.stdout) as {
      status: number;
      result: { summary: { failed: number } };
    };
    expect(envelope.status).to.equal(0);
    expect(envelope.result.summary.failed).to.equal(1);
  });

  it('converts core validation errors to the sf json error envelope', () => {
    const repoRoot = process.cwd();
    const personaPath = join(mkdtempSync(join(tmpdir(), 'warden-process-core-error-test-')), 'personas.json');
    writeFileSync(personaPath, JSON.stringify({ personas: { invalid: [] } }));
    const preloadPath = join(mkdtempSync(join(tmpdir(), 'warden-process-error-test-')), 'preload.mjs');
    const provisionCommand = pathToFileURL(join(repoRoot, 'src/commands/warden/provision.js')).href;
    writeFileSync(
      preloadPath,
      `
import UserProvision from ${JSON.stringify(provisionCommand)};
UserProvision.prototype.parse = async () => ({ flags: {
  'target-org': { getConnection: () => ({}) },
  'users-def': 'test/fixtures/user-def.json',
  'personas-def': ${JSON.stringify(personaPath)},
  'external-id': undefined,
  'fuzzy-username': false,
  'no-prompt': true,
  'dry-run': false,
  output: 'human',
  'output-file': undefined,
  'api-version': undefined,
  'fail-on-insufficient-license': false,
  'related-def': undefined,
  'input-format': undefined,
  'csv-list-delimiter': undefined,
  interactive: false,
} });
UserProvision.prototype.jsonEnabled = () => true;
      `.trim()
    );

    const child = spawnSync(
      process.execPath,
      [
        '--loader',
        'ts-node/esm',
        '--import',
        preloadPath,
        join(repoRoot, 'bin/dev.js'),
        'warden',
        'provision',
        '--json',
      ],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 30_000,
        env: { ...process.env, FORCE_COLOR: '0', NODE_V8_COVERAGE: undefined, SF_DISABLE_LOG_FILE: 'true' },
      }
    );

    expect(child.error, child.error?.stack).to.equal(undefined);
    expect(child.status).to.equal(1);
    // KNOWN BEHAVIOR CHANGE, operator-waived for this phase (see the Round 2 review
    // response in wdc-extract-domain-library.md): on master,
    // `assertValidDefinitions` only checked that `personas` is an object, so
    // `{ invalid: [] }` passed and provisioning proceeded. Core 0.2.0's zod
    // schema now rejects a non-object persona entry at read time. This is a
    // genuine new failure mode with no pre-cutover baseline. Loosening the schema to
    // match master requires a warden-core change, which this phase's operator
    // instruction ("cutover only against 0.2.0, do not release") forecloses; the
    // operator has therefore accepted this behavior change for this phase. The
    // envelope `name` below is
    // 'Error' (not a code-derived name) because it is not one of the
    // pre-cutover `SfError` codes in `wardenCommand.ts`'s legacy name map.
    expect(JSON.parse(child.stdout)).to.include({
      name: 'Error',
      message: 'personas.invalid: Invalid input: expected object, received array',
      exitCode: 1,
    });
  });

  /**
   * Golden `--json` error envelopes captured against `master` (pre-cutover, commit
   * `d453bab`) with the same preload-stub technique used above, run from the plugin's
   * own repo root so relative fixture paths in messages match byte for byte regardless
   * of checkout location. `stack` is excluded: it embeds the absolute checkout path and
   * source line numbers, neither of which is meaningful to a `--json` consumer.
   */
  const assertGoldenErrorEnvelope = (stdout: string, expected: Record<string, unknown>): void => {
    const envelope = JSON.parse(stdout) as Record<string, unknown>;
    delete envelope.stack;
    expect(envelope).to.deep.equal(expected);
  };

  it('keeps the invalid persona JSON golden stable', () => {
    const repoRoot = process.cwd();
    const preloadPath = join(mkdtempSync(join(tmpdir(), 'warden-process-golden-test-')), 'preload.mjs');
    const provisionCommand = pathToFileURL(join(repoRoot, 'src/commands/warden/provision.js')).href;
    writeFileSync(
      preloadPath,
      `
import UserProvision from ${JSON.stringify(provisionCommand)};
UserProvision.prototype.parse = async () => ({ flags: {
  'target-org': { getConnection: () => ({}) },
  'users-def': 'test/fixtures/user-def.json',
  'personas-def': 'test/fixtures/user-def.json',
  'external-id': undefined,
  'fuzzy-username': false,
  'no-prompt': true,
  'dry-run': false,
  output: 'human',
  'output-file': undefined,
  'api-version': undefined,
  'fail-on-insufficient-license': false,
  'related-def': undefined,
  'input-format': undefined,
  'csv-list-delimiter': undefined,
  interactive: false,
} });
UserProvision.prototype.jsonEnabled = () => true;
      `.trim()
    );

    const child = spawnSync(
      process.execPath,
      [
        '--loader',
        'ts-node/esm',
        '--import',
        preloadPath,
        join(repoRoot, 'bin/dev.js'),
        'warden',
        'provision',
        '--json',
      ],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 30_000,
        env: { ...process.env, FORCE_COLOR: '0', NODE_V8_COVERAGE: undefined, SF_DISABLE_LOG_FILE: 'true' },
      }
    );

    expect(child.error, child.error?.stack).to.equal(undefined);
    expect(child.status).to.equal(1);
    assertGoldenErrorEnvelope(child.stdout, {
      name: 'SfError',
      message: 'persona-def.json must contain a personas object.',
      exitCode: 1,
      context: 'UserProvision',
      cause: 'undefined',
      warnings: [],
      code: 'SfError',
      status: 1,
      commandName: 'UserProvision',
    });
  });

  it('keeps the malformed JSON input golden stable', () => {
    const repoRoot = process.cwd();
    const preloadPath = join(mkdtempSync(join(tmpdir(), 'warden-process-golden-json-test-')), 'preload.mjs');
    const provisionCommand = pathToFileURL(join(repoRoot, 'src/commands/warden/provision.js')).href;
    writeFileSync(
      preloadPath,
      `
import UserProvision from ${JSON.stringify(provisionCommand)};
UserProvision.prototype.parse = async () => ({ flags: {
  'target-org': { getConnection: () => ({}) },
  'users-def': 'test/fixtures/malformed.json',
  'personas-def': undefined,
  'external-id': undefined,
  'fuzzy-username': false,
  'no-prompt': true,
  'dry-run': false,
  output: 'human',
  'output-file': undefined,
  'api-version': undefined,
  'fail-on-insufficient-license': false,
  'related-def': undefined,
  'input-format': undefined,
  'csv-list-delimiter': undefined,
  interactive: false,
} });
UserProvision.prototype.jsonEnabled = () => true;
      `.trim()
    );

    const child = spawnSync(
      process.execPath,
      [
        '--loader',
        'ts-node/esm',
        '--import',
        preloadPath,
        join(repoRoot, 'bin/dev.js'),
        'warden',
        'provision',
        '--json',
      ],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 30_000,
        env: { ...process.env, FORCE_COLOR: '0', NODE_V8_COVERAGE: undefined, SF_DISABLE_LOG_FILE: 'true' },
      }
    );

    expect(child.error, child.error?.stack).to.equal(undefined);
    expect(child.status).to.equal(1);
    assertGoldenErrorEnvelope(child.stdout, {
      name: 'SfError',
      message: 'Failed to parse JSON file test/fixtures/malformed.json: Unexpected end of JSON input',
      exitCode: 1,
      context: 'UserProvision',
      cause: 'undefined',
      warnings: [],
      code: 'SfError',
      status: 1,
      commandName: 'UserProvision',
    });
  });

  it('keeps the --output plus --json conflict golden stable', () => {
    const repoRoot = process.cwd();
    const preloadPath = join(mkdtempSync(join(tmpdir(), 'warden-process-golden-output-test-')), 'preload.mjs');
    const provisionCommand = pathToFileURL(join(repoRoot, 'src/commands/warden/provision.js')).href;
    writeFileSync(
      preloadPath,
      `
import UserProvision from ${JSON.stringify(provisionCommand)};
UserProvision.prototype.parse = async () => ({ flags: {
  'target-org': { getConnection: () => ({}) },
  'users-def': 'test/fixtures/user-def.json',
  'personas-def': 'test/fixtures/persona-def.json',
  'external-id': undefined,
  'fuzzy-username': false,
  'no-prompt': true,
  'dry-run': false,
  output: 'csv',
  'output-file': undefined,
  'api-version': undefined,
  'fail-on-insufficient-license': false,
  'related-def': undefined,
  'input-format': undefined,
  'csv-list-delimiter': undefined,
  interactive: false,
} });
UserProvision.prototype.jsonEnabled = () => true;
      `.trim()
    );

    const child = spawnSync(
      process.execPath,
      [
        '--loader',
        'ts-node/esm',
        '--import',
        preloadPath,
        join(repoRoot, 'bin/dev.js'),
        'warden',
        'provision',
        '--json',
      ],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 30_000,
        env: { ...process.env, FORCE_COLOR: '0', NODE_V8_COVERAGE: undefined, SF_DISABLE_LOG_FILE: 'true' },
      }
    );

    expect(child.error, child.error?.stack).to.equal(undefined);
    expect(child.status).to.equal(1);
    assertGoldenErrorEnvelope(child.stdout, {
      name: 'SfError',
      message:
        '`--output` and `--json` both write to stdout. Pass `--output-file <path>` to write the `--output` payload to a file.',
      exitCode: 1,
      context: 'UserProvision',
      cause: 'undefined',
      warnings: [],
      code: 'SfError',
      status: 1,
      commandName: 'UserProvision',
    });
  });

  it('keeps the unknown diff target golden stable', () => {
    const repoRoot = process.cwd();
    const preloadPath = join(mkdtempSync(join(tmpdir(), 'warden-process-golden-diff-test-')), 'preload.mjs');
    const diffCommand = pathToFileURL(join(repoRoot, 'src/commands/warden/diff.js')).href;
    writeFileSync(
      preloadPath,
      `
import UserDiff from ${JSON.stringify(diffCommand)};
UserDiff.prototype.parse = async () => ({ flags: {
  'target-org': { getConnection: () => ({ describe: async () => ({ fields: [] }) }) },
  user: 'not-a-field-value-pair',
  against: 'Username:template@example.test',
  output: 'human',
  verbose: false,
  verify: false,
  'fail-on-drift': false,
  'api-version': undefined,
} });
UserDiff.prototype.jsonEnabled = () => true;
      `.trim()
    );

    const child = spawnSync(
      process.execPath,
      ['--loader', 'ts-node/esm', '--import', preloadPath, join(repoRoot, 'bin/dev.js'), 'warden', 'diff', '--json'],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 30_000,
        env: { ...process.env, FORCE_COLOR: '0', NODE_V8_COVERAGE: undefined, SF_DISABLE_LOG_FILE: 'true' },
      }
    );

    expect(child.error, child.error?.stack).to.equal(undefined);
    expect(child.status).to.equal(1);
    assertGoldenErrorEnvelope(child.stdout, {
      name: 'SfError',
      message: 'Invalid --user value "not-a-field-value-pair". Expected field:value.',
      exitCode: 1,
      context: 'UserDiff',
      cause: 'undefined',
      warnings: [],
      code: 'SfError',
      status: 1,
      commandName: 'UserDiff',
    });
  });
});
