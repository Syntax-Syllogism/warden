import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect } from 'chai';

describe('warden process-level output', () => {
  it('keeps the global json envelope successful while returning exit code 1 for partial failure', () => {
    const repoRoot = process.cwd();
    const dir = mkdtempSync(join(tmpdir(), 'warden-process-test-'));
    const usersPath = join(dir, 'users.json');
    const personasPath = join(dir, 'personas.json');
    const preloadPath = join(dir, 'preload.mjs');
    writeFileSync(usersPath, JSON.stringify({ users: [] }));
    writeFileSync(personasPath, JSON.stringify({ personas: {} }));

    const provisionCommand = pathToFileURL(join(repoRoot, 'src/commands/warden/provision.js')).href;
    const provisionUseCase = pathToFileURL(join(repoRoot, 'src/userProvisioning/provisionUserUseCase.js')).href;
    writeFileSync(
      preloadPath,
      `
import UserProvision from ${JSON.stringify(provisionCommand)};
import { ProvisionUserUseCase } from ${JSON.stringify(provisionUseCase)};

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
ProvisionUserUseCase.prototype.execute = async () => ({
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
    const envelope = JSON.parse(child.stdout) as {
      status: number;
      result: { summary: { failed: number } };
    };
    expect(envelope.status).to.equal(0);
    expect(envelope.result.summary.failed).to.equal(1);
  });
});
