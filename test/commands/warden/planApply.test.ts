import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TestContext } from '@salesforce/core/testSetup';
import { stubSfCommandUx } from '@salesforce/sf-plugins-core';
import { provision, restore, type ProvisionPlan } from '@syntax-syllogism/warden-core';
import { expect } from 'chai';
import sinon from 'sinon';
import UserFreeze from '../../../src/commands/warden/freeze.js';
import UserUnfreeze from '../../../src/commands/warden/unfreeze.js';
import UserStrip from '../../../src/commands/warden/strip.js';
import UserProvision from '../../../src/commands/warden/provision.js';
import UserRestore from '../../../src/commands/warden/restore.js';
import { confirmWithTimeout } from '../../../src/userShared/prompting.js';

const connection = (frozen = false) => {
  const write = sinon.stub().resolves([{ success: true, id: '005user', errors: [] }]);
  return {
    write,
    describe: sinon
      .stub()
      .resolves({ fields: [{ name: 'Username', filterable: true, createable: true, updateable: true }] }),
    query: sinon.stub().callsFake(async (soql: string) => {
      if (soql.includes('FROM UserLogin'))
        return { records: [{ Id: '0LLlogin', UserId: '005user', IsFrozen: frozen }] };
      if (soql.includes('FROM User WHERE'))
        return { records: [{ Id: '005user', IsActive: true, Username: 'target@example.test' }] };
      return { records: [] };
    }),
    sobject: sinon.stub().returns({ create: write, update: write, delete: write }),
  };
};

describe('plan/apply command gates', () => {
  const $$ = new TestContext();
  beforeEach(() => {
    stubSfCommandUx($$.SANDBOX);
  });
  afterEach(() => {
    process.exitCode = undefined;
    sinon.restore();
    $$.restore();
  });

  for (const command of [UserFreeze, UserUnfreeze, UserStrip]) {
    it(`${command.name} keeps an unknown --user field as an SfError`, async () => {
      const conn = connection();
      sinon.stub(command.prototype as unknown as Record<string, unknown>, 'parse').resolves({
        flags: {
          'target-org': { getConnection: () => conn },
          user: 'UnknownField:value',
          'dry-run': true,
        },
      } as never);
      try {
        await command.run(['--json']);
        expect.fail('Expected unknown match field to fail');
      } catch (error) {
        expect(error).to.have.property('name', 'SfError');
        expect(error).to.have.property('message', 'Invalid user match field "UnknownField".');
      }
      expect(conn.query.called).to.equal(false);
      expect(conn.write.called).to.equal(false);
    });

    it(`${command.name} declines before any lifecycle writes`, async () => {
      const conn = connection(command === UserUnfreeze);
      sinon.stub(command.prototype as unknown as Record<string, unknown>, 'parse').resolves({
        flags: {
          'target-org': { getConnection: () => conn },
          user: 'Username:target@example.test',
          'dry-run': false,
          'no-prompt': false,
        },
      } as never);
      const confirm = sinon.stub(command.prototype as unknown as Record<string, unknown>, 'confirm').resolves(false);
      try {
        await command.run([]);
        expect.fail('Expected confirmation decline');
      } catch (error) {
        expect(error).to.have.property('name', 'SfError');
        expect(error).to.have.property('message', 'Operation cancelled.');
      }
      expect(confirm.calledOnce).to.equal(true);
      expect(conn.write.called).to.equal(false);
    });

    for (const mode of ['no-prompt', 'json', 'dry-run']) {
      it(`${command.name} bypasses confirmation for ${mode}`, async () => {
        const conn = connection(command === UserUnfreeze);
        sinon.stub(command.prototype as unknown as Record<string, unknown>, 'parse').resolves({
          flags: {
            'target-org': { getConnection: () => conn },
            user: 'Username:target@example.test',
            'dry-run': mode === 'dry-run',
            'no-prompt': mode === 'no-prompt',
          },
        } as never);
        const confirm = sinon.stub(command.prototype as unknown as Record<string, unknown>, 'confirm');
        await command.run(mode === 'json' ? ['--json'] : []);
        expect(confirm.called).to.equal(false);
        expect(conn.write.called).to.equal(mode !== 'dry-run');
      });
    }
  }

  it('writes a live strip snapshot of successful targets before DML, retaining failed rows', async () => {
    const conn = connection();
    const dir = mkdtempSync(join(tmpdir(), 'warden-strip-live-parity-'));
    const usersPath = join(dir, 'users.json');
    const snapshotPath = join(dir, 'snapshot.json');
    writeFileSync(
      usersPath,
      JSON.stringify({
        users: [
          { match: 'Username', Username: 'missing@example.test' },
          { match: 'Username', Username: 'target@example.test' },
        ],
      })
    );
    conn.write.callsFake(async () => {
      expect(existsSync(snapshotPath)).to.equal(true);
      return [{ success: true, id: '005user', errors: [] }];
    });
    sinon.stub(UserStrip.prototype as unknown as Record<string, unknown>, 'parse').resolves({
      flags: {
        'target-org': { getConnection: () => conn, getUsername: () => 'org@example.test' },
        'users-def': usersPath,
        snapshot: snapshotPath,
        'no-prompt': true,
        'dry-run': false,
      },
    } as never);
    const result = await UserStrip.run(['--json']);
    expect(result.summary).to.deep.equal({ total: 2, changed: 1, unchanged: 0, failed: 1 });
    expect(result.users[0].actions).to.deep.equal([]);
    expect(result.users[1].actions.map((action) => action.key)).to.deep.equal([
      'snapshotWritten',
      'frozen',
      'deactivated',
    ]);
    const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8')) as { users: Array<{ IsFrozen: boolean }> };
    expect(snapshot.users).to.have.length(1);
    expect(snapshot.users[0].IsFrozen).to.equal(false);
  });

  it('declines provisioning warnings before user or connected-org writes', async () => {
    const conn = connection();
    conn.describe.callsFake(async (name: string) => ({ name, fields: [] }));
    const dir = mkdtempSync(join(tmpdir(), 'warden-provision-decline-'));
    const usersPath = join(dir, 'users.json');
    const personasPath = join(dir, 'personas.json');
    writeFileSync(usersPath, JSON.stringify({ users: [] }));
    writeFileSync(personasPath, JSON.stringify({ personas: {} }));
    sinon.stub(provision, 'plan').resolves({ warnings: ['reference warning'] } as ProvisionPlan);
    const apply = sinon.stub(provision, 'apply');
    sinon.stub(UserProvision.prototype as unknown as Record<string, unknown>, 'parse').resolves({
      flags: {
        'target-org': { getConnection: () => conn },
        'users-def': usersPath,
        'personas-def': personasPath,
        'no-prompt': false,
        'dry-run': false,
        'log-to-org': true,
      },
    } as never);
    const confirm = sinon
      .stub(UserProvision.prototype as unknown as Record<string, unknown>, 'confirm')
      .callsFake(async () => {
        expect(conn.write.called).to.equal(false);
        return false;
      });
    try {
      await UserProvision.run([]);
      expect.fail('Expected provisioning decline');
    } catch (error) {
      expect(error).to.have.property('name', 'SfError');
      expect(error).to.have.property('message', 'Provisioning cancelled because warnings were not confirmed.');
    }
    expect(confirm.calledOnce).to.equal(true);
    expect(apply.called).to.equal(false);
    expect(conn.write.called).to.equal(false);
  });

  for (const mode of ['decline', 'accept', 'no-prompt', 'json', 'dry-run', 'unchanged']) {
    it(`restore plans before confirmation and handles ${mode}`, async () => {
      const conn = connection(mode !== 'unchanged');
      const dir = mkdtempSync(join(tmpdir(), 'warden-restore-gate-'));
      const snapshotPath = join(dir, 'snapshot.json');
      writeFileSync(
        snapshotPath,
        JSON.stringify({
          snapshotVersion: 1,
          users: [
            {
              match: 'Username',
              matchValue: 'target@example.test',
              userId: '005old',
              IsActive: true,
              IsFrozen: true,
              permissionSets: [],
              permissionSetGroups: [],
              publicGroups: [],
              queues: [],
              permissionSetLicenses: [],
            },
          ],
        })
      );
      sinon.stub(UserRestore.prototype as unknown as Record<string, unknown>, 'parse').resolves({
        flags: {
          'target-org': { getConnection: () => conn },
          snapshot: snapshotPath,
          'dry-run': mode === 'dry-run',
          'no-prompt': mode === 'no-prompt',
        },
      } as never);
      const plan = sinon.spy(restore, 'plan');
      const apply = sinon.spy(restore, 'apply');
      const confirm = sinon
        .stub(UserRestore.prototype as unknown as Record<string, unknown>, 'confirm')
        .callsFake(async () => {
          expect(plan.calledOnce).to.equal(true);
          expect(apply.called).to.equal(false);
          expect(conn.write.called).to.equal(false);
          return mode !== 'decline';
        });
      if (mode === 'decline') {
        try {
          await UserRestore.run([]);
          expect.fail('Expected restore decline');
        } catch (error) {
          expect(error).to.have.property('name', 'SfError');
          expect(error).to.have.property('message', 'Operation cancelled.');
        }
      } else {
        await UserRestore.run(mode === 'json' ? ['--json'] : []);
      }
      expect(plan.calledOnce).to.equal(true);
      expect(confirm.called).to.equal(mode === 'accept' || mode === 'decline');
      expect(apply.called).to.equal(mode !== 'dry-run' && mode !== 'decline');
      expect(conn.write.called).to.equal(!['dry-run', 'decline', 'unchanged'].includes(mode));
    });
  }

  it('times out confirmation and clears the timer', async () => {
    const fakeTime = sinon.useFakeTimers();
    const pending = confirmWithTimeout(() => new Promise<boolean>(() => undefined), 'Continue?', 10);
    await fakeTime.tickAsync(10);
    expect(await pending).to.deep.equal({ confirmed: false, timedOut: true });
    expect(fakeTime.countTimers()).to.equal(0);
  });
});
