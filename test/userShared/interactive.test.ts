import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TestContext } from '@salesforce/core/testSetup';
import { stubSfCommandUx } from '@salesforce/sf-plugins-core';
import { expect } from 'chai';
import sinon from 'sinon';
import UserAccess from '../../src/commands/warden/access.js';
import UserDiff from '../../src/commands/warden/diff.js';
import UserFreeze from '../../src/commands/warden/freeze.js';
import UserProvision from '../../src/commands/warden/provision.js';
import UserRestore from '../../src/commands/warden/restore.js';
import UserSnapshot from '../../src/commands/warden/snapshot.js';
import UserStrip from '../../src/commands/warden/strip.js';
import UserUnfreeze from '../../src/commands/warden/unfreeze.js';
import {
  assertInteractiveAllowed,
  flagWasSupplied,
  resolveFlagsInteractively,
  type InteractiveParse,
} from '../../src/userShared/targetFlags.js';
import {
  effectiveInputFormat,
  promptAccessType,
  promptAccessUserScope,
  promptExistingFile,
  promptInputFormat,
  promptInputFormatForPath,
  promptOptionalApiVersion,
  promptOptionalExistingFile,
  promptOutputFormat,
  promptRuntime,
  promptStripSkips,
} from '../../src/userShared/prompting.js';

type InteractiveCommand = {
  run: (args: string[]) => Promise<unknown>;
  prototype: object;
};

const makeConnection = (): { describe: sinon.SinonStub; query: sinon.SinonStub; sobject: sinon.SinonStub } => ({
  describe: sinon.stub().callsFake(async (name: string) => ({
    name,
    fields: [
      { name: 'Username', createable: true, updateable: true, filterable: true, externalId: true },
      { name: 'FederationIdentifier', createable: true, updateable: true, filterable: true, externalId: true },
      { name: 'IsActive', createable: true, updateable: true, filterable: true, externalId: false },
    ],
  })),
  query: sinon.stub().callsFake(async (soql: string) =>
    soql.includes('FROM User')
      ? {
          records: [
            {
              Id: '005interactive000001AAA',
              Name: 'Interactive User',
              Username: 'first@example.test',
              IsActive: true,
              FederationIdentifier: 'first',
            },
          ],
          done: true,
        }
      : { records: [], done: true }
  ),
  sobject: sinon.stub().returns({
    create: sinon.stub().resolves([]),
    update: sinon.stub().resolves([]),
    delete: sinon.stub().resolves([]),
  }),
});

const rawFlags = (suppliedFlags: readonly string[]): Array<{ type: string; flag: string }> =>
  suppliedFlags.map((flag) => ({ type: 'flag', flag }));

const installInteractiveParse = (
  command: InteractiveCommand,
  flags: Record<string, unknown>,
  suppliedFlags: readonly string[],
  defaultedFlags: readonly string[] = []
): void => {
  sinon.stub(command.prototype as Record<string, unknown>, 'parse').resolves({
    flags,
    raw: rawFlags(suppliedFlags),
    metadata: {
      flags: Object.fromEntries(defaultedFlags.map((flag) => [flag, { setFromDefault: true }])),
    },
  } as never);
  sinon.stub(command.prototype as Record<string, unknown>, 'jsonEnabled').returns(false);
};

const makeOrg = (
  connection: ReturnType<typeof makeConnection>
): { getConnection: () => unknown; getUsername: () => string } => ({
  getConnection: () => connection,
  getUsername: () => 'interactive@example.test',
});

describe('interactive command support', () => {
  const $$ = new TestContext();

  beforeEach(() => {
    process.env.SF_DISABLE_LOG_FILE = 'true';
    stubSfCommandUx($$.SANDBOX);
  });

  afterEach(() => {
    sinon.restore();
    $$.restore();
  });

  const choiceValues = (choices: readonly unknown[]): unknown[] =>
    choices.map((choice) => (choice as { value: unknown }).value);

  it('prompts for values that only came from defaults', async () => {
    const parsed: InteractiveParse<{ output: string; dryRun: boolean }> = {
      flags: { output: 'human', dryRun: false },
      metadata: { flags: { output: { setFromDefault: true }, dryRun: { setFromDefault: true } } },
      raw: [],
    };
    expect(flagWasSupplied(parsed, parsed.flags, ['output'])).to.equal(false);
    expect(flagWasSupplied(parsed, parsed.flags, ['dryRun'])).to.equal(false);
    const answers: string[] = [];
    const result = await resolveFlagsInteractively(
      parsed,
      [
        { key: 'output', prompt: async () => 'json' },
        { key: 'dryRun', prompt: async () => true },
      ],
      { log: (message) => answers.push(message), confirm: async () => true }
    );
    expect(result.flags).to.deep.equal({ output: 'json', dryRun: true });
    expect(answers[0]).to.equal('Resolved interactive values:');
  });

  it('rejects interactive mode without a human terminal or with json output', () => {
    expect(() => assertInteractiveAllowed(true, false)).to.throw(
      'Interactive mode requires a TTY and cannot be combined with --json.'
    );
  });

  it('guards interactive mode on every warden command before prompting', async () => {
    const commands = [
      UserAccess,
      UserDiff,
      UserFreeze,
      UserProvision,
      UserRestore,
      UserSnapshot,
      UserStrip,
      UserUnfreeze,
    ];
    const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
    try {
      for (const command of commands) {
        sinon.stub(command.prototype as unknown as Record<string, unknown>, 'parse').resolves({
          flags: { interactive: true, output: 'human', 'output-file': undefined },
        } as never);
        sinon.stub(command.prototype as unknown as Record<string, unknown>, 'jsonEnabled').returns(false);
        const run = (command as unknown as { run: (argv: string[]) => Promise<unknown> }).run.bind(command);
        // eslint-disable-next-line no-await-in-loop
        await run([]).then(
          () => expect.fail('Expected interactive mode to reject without a TTY.'),
          (error: unknown) =>
            expect(error).to.have.property(
              'message',
              'Interactive mode requires a TTY and cannot be combined with --json.'
            )
        );
        sinon.restore();
      }
    } finally {
      if (ttyDescriptor) Object.defineProperty(process.stdin, 'isTTY', ttyDescriptor);
      else delete (process.stdin as unknown as { isTTY?: boolean }).isTTY;
      sinon.restore();
    }
  });

  it('keeps prompt choices aligned with command flag domains', async () => {
    const select = sinon.stub(promptRuntime, 'select').resolves('field' as never);
    await promptAccessType();
    expect(choiceValues(select.firstCall.args[0].choices)).to.deep.equal([
      'field',
      'object',
      'apex-class',
      'vf-page',
      'custom-permission',
      'tab',
    ]);

    select.resetHistory();
    await promptAccessType(['field', 'object']);
    expect(choiceValues(select.firstCall.args[0].choices)).to.deep.equal(['field', 'object']);

    select.resetHistory();
    await promptAccessUserScope(false);
    expect(choiceValues(select.firstCall.args[0].choices)).to.deep.equal(['target']);

    select.resetHistory();
    await promptInputFormat();
    expect(choiceValues(select.firstCall.args[0].choices)).to.deep.equal(['json', 'csv']);

    select.resetHistory();
    await promptOutputFormat();
    expect(choiceValues(select.firstCall.args[0].choices)).to.deep.equal(['human', 'csv', 'json']);
  });

  it('infers known input formats and prompts only for unrecognized paths', async () => {
    const select = sinon.stub(promptRuntime, 'select').resolves('csv' as never);

    expect(await promptInputFormatForPath('users.json')).to.equal('json');
    expect(await promptInputFormatForPath('users.tsv')).to.equal('csv');
    expect(select.called).to.equal(false);

    expect(await promptInputFormatForPath('users.data')).to.equal('csv');
    expect(select.calledOnce).to.equal(true);
  });

  it('writes inferred formats into the summary and only resolves CSV delimiters for CSV input', async () => {
    const logs: string[] = [];
    let delimiterPrompts = 0;
    const result = await resolveFlagsInteractively(
      { flags: { 'users-def': 'users.json', 'input-format': undefined, 'csv-list-delimiter': undefined } },
      [
        { key: 'input-format', prompt: (flags) => promptInputFormatForPath(flags['users-def']) },
        {
          key: 'csv-list-delimiter',
          when: (flags) => effectiveInputFormat(flags) === 'csv',
          prompt: async () => {
            delimiterPrompts += 1;
            return ';';
          },
        },
      ],
      { log: (message) => logs.push(message), confirm: async () => true }
    );

    expect(result.flags['input-format']).to.equal('json');
    expect(delimiterPrompts).to.equal(0);
    expect(logs).to.include('  --input-format: json');
  });

  it('skips format prompts for a JSON users-definition in lifecycle mode', async () => {
    const promptedMessages: string[] = [];
    const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    try {
      sinon.stub(promptRuntime, 'select').callsFake((async (config: { message: string }) => {
        promptedMessages.push(config.message);
        return 'human' as never;
      }) as never);
      sinon.stub(promptRuntime, 'input').callsFake((async (config: { message: string }) => {
        promptedMessages.push(config.message);
        return '' as never;
      }) as never);
      sinon.stub(promptRuntime, 'confirm').callsFake((async (config: { message: string }) => {
        promptedMessages.push(config.message);
        return false;
      }) as never);
      const confirm = sinon.stub(UserFreeze.prototype as unknown as Record<string, unknown>, 'confirm').resolves(false);
      installInteractiveParse(
        UserFreeze,
        {
          'target-org': makeOrg(makeConnection()),
          user: undefined,
          'users-def': '/tmp/users.json',
          'external-id': undefined,
          'input-format': undefined,
          'csv-list-delimiter': undefined,
          'no-prompt': false,
          'dry-run': false,
          output: 'human',
          'output-file': undefined,
          'api-version': undefined,
          interactive: true,
        },
        ['target-org', 'users-def', 'interactive'],
        ['output', 'no-prompt', 'dry-run']
      );

      await UserFreeze.run([]);

      expect(promptedMessages).not.to.include('Input format');
      expect(promptedMessages).not.to.include('CSV list delimiter');
      expect(confirm.calledOnce).to.equal(true);
    } finally {
      if (ttyDescriptor) Object.defineProperty(process.stdin, 'isTTY', ttyDescriptor);
      else delete (process.stdin as unknown as { isTTY?: boolean }).isTTY;
    }
  });

  it('rejects malformed and retired prompted API versions', async () => {
    const input = sinon.stub(promptRuntime, 'input');
    input.resolves('not-a-version' as never);
    await promptOptionalApiVersion().then(
      () => expect.fail('Expected a malformed API version to be rejected.'),
      (error: Error) => expect(error.message).to.contain('not-a-version is not a valid API version')
    );

    input.resolves('20.0' as never);
    await promptOptionalApiVersion().then(
      () => expect.fail('Expected a retired API version to be rejected.'),
      (error: Error) => expect(error.message).to.equal('The API version must be greater than 21.')
    );
  });

  it('offers an already resolved api version as the prompt default', async () => {
    const input = sinon.stub(promptRuntime, 'input').callsFake((async (config: { default?: string }) =>
      config.default ?? '') as never);
    expect(await promptOptionalApiVersion('62.0')).to.equal('62.0');
    expect(input.firstCall.args[0].default).to.equal('62.0');
    expect(await promptOptionalApiVersion()).to.equal(undefined);
  });

  it('rejects a prompted path that exists but is not a file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'warden-interactive-not-a-file-'));
    const input = sinon.stub(promptRuntime, 'input').resolves(dir as never);
    await promptExistingFile('Users definition file').then(
      () => expect.fail('Expected a directory to be rejected.'),
      (error: Error) => expect(error.message).to.equal(`${dir} exists but is not a file`)
    );
    input.resolves(dir as never);
    await promptOptionalExistingFile('Personas definition file').then(
      () => expect.fail('Expected a directory to be rejected.'),
      (error: Error) => expect(error.message).to.equal(`${dir} exists but is not a file`)
    );

    input.resolves('' as never);
    expect(await promptOptionalExistingFile('Personas definition file')).to.equal(undefined);
  });

  it('uses an empty checkbox selection for a full strip by default', async () => {
    const checkbox = sinon.stub(promptRuntime, 'checkbox').resolves([] as never);
    expect(await promptStripSkips()).to.deep.equal([]);
    expect(
      checkbox.firstCall.args[0].choices.every(
        (choice: unknown) => (choice as { checked?: boolean }).checked === undefined
      )
    ).to.equal(true);
  });

  it('keeps supplied strip toggles fixed while collecting the rest with one checkbox', async () => {
    const checkbox = sinon.stub(promptRuntime, 'checkbox').resolves(['keep-licenses'] as never);
    await promptStripSkips(['keep-permsets'], ['keep-permsets']);
    const choices = checkbox.firstCall.args[0].choices as Array<{
      value: string;
      checked?: boolean;
      disabled?: boolean | string;
    }>;
    const supplied = choices.find((choice) => choice.value === 'keep-permsets');
    expect(supplied?.checked).to.equal(true);
    expect(supplied?.disabled).to.equal('Provided on the command line');
  });

  it('locks access and diff branches to supplied flags', async () => {
    const connection = makeConnection();
    const org = makeOrg(connection);
    const select = sinon.stub(promptRuntime, 'select');
    const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    try {
      installInteractiveParse(
        UserAccess,
        {
          'target-org': org,
          type: 'object',
          target: 'Account',
          user: 'Username:first@example.test',
          sobject: undefined,
          output: 'human',
          'output-file': undefined,
          'api-version': undefined,
          interactive: true,
        },
        ['target-org', 'type', 'target', 'user', 'output', 'output-file', 'api-version', 'interactive']
      );
      sinon.stub(UserAccess.prototype as unknown as Record<string, unknown>, 'confirm').resolves(true);
      await UserAccess.run([]);

      sinon.restore();
      $$.restore();
      stubSfCommandUx($$.SANDBOX);
      installInteractiveParse(
        UserDiff,
        {
          'target-org': org,
          user: 'Username:first@example.test',
          against: 'Username:second@example.test',
          'users-def': undefined,
          'personas-def': undefined,
          'external-id': undefined,
          'input-format': undefined,
          'csv-list-delimiter': undefined,
          output: 'human',
          'output-file': undefined,
          verbose: false,
          'fail-on-drift': false,
          verify: false,
          'api-version': undefined,
          interactive: true,
        },
        [
          'target-org',
          'user',
          'against',
          'output',
          'output-file',
          'api-version',
          'verbose',
          'fail-on-drift',
          'verify',
          'interactive',
        ]
      );
      sinon.stub(UserDiff.prototype as unknown as Record<string, unknown>, 'confirm').resolves(true);
      await UserDiff.run([]);

      expect(select.called).to.equal(false);
    } finally {
      if (ttyDescriptor) Object.defineProperty(process.stdin, 'isTTY', ttyDescriptor);
      else delete (process.stdin as unknown as { isTTY?: boolean }).isTTY;
    }
  });

  it('rejects a supplied access type that --sobject cannot use before prompting or confirmation', async () => {
    const connection = makeConnection();
    const org = makeOrg(connection);
    const select = sinon.stub(promptRuntime, 'select').rejects(new Error('no prompt expected'));
    const input = sinon.stub(promptRuntime, 'input').rejects(new Error('no prompt expected'));
    const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    try {
      installInteractiveParse(
        UserAccess,
        {
          'target-org': org,
          type: 'apex-class',
          target: undefined,
          user: 'Username:first@example.test',
          sobject: 'Account',
          output: 'human',
          'output-file': undefined,
          'api-version': undefined,
          interactive: true,
        },
        ['target-org', 'type', 'user', 'sobject', 'interactive'],
        ['output']
      );
      const confirmStub = sinon
        .stub(UserAccess.prototype as unknown as Record<string, unknown>, 'confirm')
        .resolves(true);
      const error = await UserAccess.run([]).then(
        () => undefined,
        (thrown: Error) => thrown
      );
      expect(error?.message).to.equal(
        '--sobject is only supported for reverse field and object audits, not apex-class.'
      );
      expect(select.called).to.equal(false);
      expect(input.called).to.equal(false);
      expect(confirmStub.called).to.equal(false);
    } finally {
      if (ttyDescriptor) Object.defineProperty(process.stdin, 'isTTY', ttyDescriptor);
      else delete (process.stdin as unknown as { isTTY?: boolean }).isTTY;
    }
  });

  it('offers only sobject-capable access types when --sobject was supplied', async () => {
    const connection = makeConnection();
    const org = makeOrg(connection);
    const select = sinon.stub(promptRuntime, 'select');
    select.callsFake((async (config: { message: string }) =>
      config.message === 'Access target type' ? 'field' : 'human') as never);
    sinon.stub(promptRuntime, 'input').resolves('' as never);
    const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    try {
      installInteractiveParse(
        UserAccess,
        {
          'target-org': org,
          type: undefined,
          target: undefined,
          user: 'Username:first@example.test',
          sobject: 'Account',
          output: 'human',
          'output-file': undefined,
          'api-version': undefined,
          interactive: true,
        },
        ['target-org', 'user', 'sobject', 'interactive'],
        ['output']
      );
      const confirmStub = sinon
        .stub(UserAccess.prototype as unknown as Record<string, unknown>, 'confirm')
        .resolves(false);
      await UserAccess.run([]);
      const typeCall = select
        .getCalls()
        .find((call) => (call.args[0] as { message: string }).message === 'Access target type');
      expect(choiceValues((typeCall?.args[0] as { choices: readonly unknown[] }).choices)).to.deep.equal([
        'field',
        'object',
      ]);
      expect(confirmStub.called).to.equal(true);
    } finally {
      if (ttyDescriptor) Object.defineProperty(process.stdin, 'isTTY', ttyDescriptor);
      else delete (process.stdin as unknown as { isTTY?: boolean }).isTTY;
    }
  });

  it('executes every command through interactive collection and confirmation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'warden-interactive-success-'));
    const usersPath = join(dir, 'users.json');
    const personasPath = join(dir, 'personas.json');
    const snapshotPath = join(dir, 'snapshot.json');
    const restorePath = join(dir, 'restore.json');
    writeFileSync(usersPath, JSON.stringify({ users: [] }));
    writeFileSync(personasPath, JSON.stringify({ personas: {} }));
    writeFileSync(restorePath, JSON.stringify({ snapshotVersion: 1, capturedAt: '', users: [] }));

    const connection = makeConnection();
    const org = makeOrg(connection);
    const cases: Array<{
      command: InteractiveCommand;
      flags: Record<string, unknown>;
      suppliedFlags: string[];
      defaultedFlags: string[];
      expectedPrompts: string[];
      mode?: string;
      interactiveMode?: 'access-target' | 'access-user-target' | 'access-user-sobject' | 'diff-users' | 'diff-personas';
    }> = [
      {
        command: UserAccess,
        flags: {
          'target-org': org,
          type: undefined,
          target: undefined,
          user: undefined,
          sobject: undefined,
          output: 'human',
          'output-file': undefined,
          'api-version': undefined,
          interactive: true,
        },
        suppliedFlags: ['target-org', 'interactive'],
        defaultedFlags: ['output'],
        expectedPrompts: [
          'Access audit mode',
          'Access target type',
          'Access target',
          'Output format',
          'Output file path',
          'API version',
        ],
        mode: 'access target mode',
        interactiveMode: 'access-target',
      },
      {
        command: UserAccess,
        flags: {
          'target-org': org,
          type: undefined,
          target: undefined,
          user: undefined,
          sobject: undefined,
          output: 'human',
          'output-file': undefined,
          'api-version': undefined,
          interactive: true,
        },
        suppliedFlags: ['target-org', 'interactive'],
        defaultedFlags: ['output'],
        expectedPrompts: [
          'Access audit mode',
          'Access target type',
          'Reverse-audit scope',
          'User match (field:value)',
          'Access target',
          'Output format',
          'Output file path',
          'API version',
        ],
        mode: 'access user-by-target mode',
        interactiveMode: 'access-user-target',
      },
      {
        command: UserAccess,
        flags: {
          'target-org': org,
          type: undefined,
          target: undefined,
          user: undefined,
          sobject: undefined,
          output: 'human',
          'output-file': undefined,
          'api-version': undefined,
          interactive: true,
        },
        suppliedFlags: ['target-org', 'interactive'],
        defaultedFlags: ['output'],
        expectedPrompts: [
          'Access audit mode',
          'Access target type',
          'Reverse-audit scope',
          'User match (field:value)',
          'SObject API name',
          'Output format',
          'Output file path',
          'API version',
        ],
        mode: 'access user-by-sobject mode',
        interactiveMode: 'access-user-sobject',
      },
      {
        command: UserDiff,
        flags: {
          'target-org': org,
          user: undefined,
          against: undefined,
          'users-def': undefined,
          'personas-def': undefined,
          'external-id': undefined,
          'input-format': undefined,
          'csv-list-delimiter': undefined,
          output: 'human',
          'output-file': undefined,
          verbose: false,
          'fail-on-drift': false,
          verify: false,
          'api-version': undefined,
          interactive: true,
        },
        suppliedFlags: ['target-org', 'interactive'],
        defaultedFlags: ['output', 'verbose', 'fail-on-drift', 'verify'],
        expectedPrompts: [
          'Diff mode',
          'User match (field:value)',
          'Reference user match (field:value)',
          'Output format',
          'Include unchanged assignments?',
          'Output file path',
          'API version',
        ],
        mode: 'diff user mode',
        interactiveMode: 'diff-users',
      },
      {
        command: UserDiff,
        flags: {
          'target-org': org,
          user: undefined,
          against: undefined,
          'users-def': undefined,
          'personas-def': undefined,
          'external-id': undefined,
          'input-format': undefined,
          'csv-list-delimiter': undefined,
          output: 'human',
          'output-file': undefined,
          verbose: false,
          'fail-on-drift': false,
          verify: false,
          'api-version': undefined,
          interactive: true,
        },
        suppliedFlags: ['target-org', 'interactive'],
        defaultedFlags: ['output', 'verbose', 'fail-on-drift', 'verify'],
        expectedPrompts: [
          'Diff mode',
          'Users definition file',
          'Personas definition file',
          'External ID field',
          'Verify conformance?',
          'Fail when drift is found?',
          'Output format',
          'Include unchanged assignments?',
          'Output file path',
          'API version',
        ],
        mode: 'diff persona mode',
        interactiveMode: 'diff-personas',
      },
      {
        command: UserFreeze,
        flags: {
          'target-org': org,
          user: undefined,
          'users-def': undefined,
          'external-id': undefined,
          'input-format': undefined,
          'csv-list-delimiter': undefined,
          'no-prompt': false,
          'dry-run': false,
          output: 'human',
          'output-file': undefined,
          'api-version': undefined,
          interactive: true,
        },
        suppliedFlags: ['target-org', 'interactive'],
        defaultedFlags: ['output', 'no-prompt', 'dry-run'],
        expectedPrompts: [
          'User selection',
          'User match (field:value)',
          'Dry run?',
          'Output format',
          'Output file path',
          'API version',
        ],
      },
      {
        command: UserUnfreeze,
        flags: {
          'target-org': org,
          user: undefined,
          'users-def': undefined,
          'external-id': undefined,
          'input-format': undefined,
          'csv-list-delimiter': undefined,
          'no-prompt': false,
          'dry-run': false,
          output: 'human',
          'output-file': undefined,
          'api-version': undefined,
          interactive: true,
        },
        suppliedFlags: ['target-org', 'interactive'],
        defaultedFlags: ['output', 'no-prompt', 'dry-run'],
        expectedPrompts: [
          'User selection',
          'User match (field:value)',
          'Dry run?',
          'Output format',
          'Output file path',
          'API version',
        ],
      },
      {
        command: UserProvision,
        flags: {
          'target-org': org,
          'users-def': undefined,
          'personas-def': undefined,
          'related-def': undefined,
          'external-id': undefined,
          'input-format': undefined,
          'csv-list-delimiter': undefined,
          'fuzzy-username': false,
          'no-prompt': false,
          'dry-run': false,
          'fail-on-insufficient-license': false,
          output: 'human',
          'output-file': undefined,
          'api-version': undefined,
          interactive: true,
        },
        suppliedFlags: ['target-org', 'interactive'],
        defaultedFlags: ['output', 'fuzzy-username', 'no-prompt', 'dry-run', 'fail-on-insufficient-license'],
        expectedPrompts: [
          'Users definition file',
          'Personas definition file',
          'External ID field',
          'Related record definition file',
          'Allow fuzzy usernames?',
          'Dry run?',
          'Fail when licenses are insufficient?',
          'Output format',
          'Output file path',
          'API version',
        ],
      },
      {
        command: UserRestore,
        flags: {
          'target-org': org,
          snapshot: undefined,
          'no-prompt': false,
          'dry-run': false,
          output: 'human',
          'output-file': undefined,
          'api-version': undefined,
          interactive: true,
        },
        suppliedFlags: ['target-org', 'interactive'],
        defaultedFlags: ['output', 'no-prompt', 'dry-run'],
        expectedPrompts: ['Snapshot file', 'Dry run?', 'Output format', 'Output file path', 'API version'],
      },
      {
        command: UserSnapshot,
        flags: {
          'target-org': org,
          user: undefined,
          'users-def': undefined,
          'external-id': undefined,
          'input-format': undefined,
          'csv-list-delimiter': undefined,
          out: undefined,
          output: 'human',
          'output-file': undefined,
          'api-version': undefined,
          interactive: true,
        },
        suppliedFlags: ['target-org', 'interactive'],
        defaultedFlags: ['output'],
        expectedPrompts: [
          'User selection',
          'User match (field:value)',
          'Snapshot output path',
          'Output format',
          'Output file path',
          'API version',
        ],
      },
      {
        command: UserStrip,
        flags: {
          'target-org': org,
          user: undefined,
          'users-def': undefined,
          'external-id': undefined,
          'input-format': undefined,
          'csv-list-delimiter': undefined,
          'no-prompt': false,
          'dry-run': false,
          'no-freeze': false,
          'no-deactivate': false,
          'keep-permsets': false,
          'keep-permset-groups': false,
          'keep-licenses': false,
          'keep-public-groups': false,
          'keep-queues': false,
          snapshot: undefined,
          output: 'human',
          'output-file': undefined,
          'api-version': undefined,
          interactive: true,
        },
        suppliedFlags: ['target-org', 'interactive'],
        defaultedFlags: [
          'output',
          'no-prompt',
          'dry-run',
          'no-freeze',
          'no-deactivate',
          'keep-permsets',
          'keep-permset-groups',
          'keep-licenses',
          'keep-public-groups',
          'keep-queues',
        ],
        expectedPrompts: [
          'User selection',
          'User match (field:value)',
          'What should this strip skip?',
          'Snapshot file path',
          'Dry run?',
          'Output format',
          'Output file path',
          'API version',
        ],
      },
    ];

    let selectCalls = 0;
    let interactiveMode: (typeof cases)[number]['interactiveMode'];
    let promptedMessages: string[] = [];
    const installPromptStubs = (): void => {
      sinon.stub(promptRuntime, 'select').callsFake((async (config: { message: string }) => {
        promptedMessages.push(config.message);
        selectCalls += 1;
        if (config.message === 'Access audit mode')
          return interactiveMode?.startsWith('access-user') ? ('user' as never) : ('target' as never);
        if (config.message === 'Reverse-audit scope')
          return interactiveMode === 'access-user-sobject' ? ('sobject' as never) : ('target' as never);
        if (config.message === 'Diff mode')
          return interactiveMode === 'diff-personas' ? ('personas' as never) : ('users' as never);
        if (config.message === 'User selection') return 'user' as never;
        if (config.message === 'Access target type') return 'object' as never;
        if (config.message === 'Input format') return 'json' as never;
        return 'human' as never;
      }) as never);
      sinon.stub(promptRuntime, 'input').callsFake((async (config: { message: string }) => {
        promptedMessages.push(config.message);
        switch (config.message) {
          case 'Access target':
          case 'SObject API name':
            return 'Account' as never;
          case 'User match (field:value)':
            return 'Username:first@example.test' as never;
          case 'Reference user match (field:value)':
            return 'Username:second@example.test' as never;
          case 'Users definition file':
            return usersPath as never;
          case 'Personas definition file':
            return personasPath as never;
          case 'Snapshot file':
            return restorePath as never;
          case 'Snapshot output path':
            return snapshotPath as never;
          case 'CSV list delimiter':
            return ';' as never;
          default:
            return '' as never;
        }
      }) as never);
      sinon.stub(promptRuntime, 'confirm').callsFake((async (config: { message: string }) => {
        promptedMessages.push(config.message);
        return config.message === 'Dry run?' ? true : false;
      }) as never);
      sinon.stub(promptRuntime, 'checkbox').callsFake((async (config: { message: string }) => {
        promptedMessages.push(config.message);
        return [] as never;
      }) as never);
    };
    installPromptStubs();

    const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    try {
      for (const testCase of cases) {
        interactiveMode = testCase.interactiveMode;
        promptedMessages = [];
        installInteractiveParse(testCase.command, testCase.flags, testCase.suppliedFlags, testCase.defaultedFlags);
        const confirm = sinon.stub(testCase.command.prototype as Record<string, unknown>, 'confirm').resolves(true);
        // eslint-disable-next-line no-await-in-loop
        const result = await testCase.command.run([]);
        expect(confirm.calledOnce, testCase.mode ?? 'lifecycle command').to.equal(true);
        expect(result).to.be.an('object');
        expect(promptedMessages, testCase.mode ?? 'lifecycle command').to.deep.equal(testCase.expectedPrompts);
        if (testCase.command === UserSnapshot) expect(existsSync(snapshotPath)).to.equal(true);
        sinon.restore();
        $$.restore();
        stubSfCommandUx($$.SANDBOX);
        installPromptStubs();
        Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
      }
      expect(selectCalls).to.be.greaterThan(0);
    } finally {
      if (ttyDescriptor) Object.defineProperty(process.stdin, 'isTTY', ttyDescriptor);
      else delete (process.stdin as unknown as { isTTY?: boolean }).isTTY;
    }
  });

  it('declining any interactive command prevents org access and file writes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'warden-interactive-decline-'));
    const snapshotPath = join(dir, 'snapshot.json');
    const outputPath = join(dir, 'output.json');
    const blockedOrg = { getConnection: sinon.stub().throws(new Error('org access should not occur')) };
    const base = { output: 'human', 'output-file': outputPath, 'api-version': '60', interactive: true };
    const cases: Array<{
      command: InteractiveCommand;
      flags: Record<string, unknown>;
      suppliedFlags: string[];
      defaultedFlags: string[];
    }> = [
      {
        command: UserAccess,
        flags: { ...base, 'target-org': blockedOrg, type: 'object', target: 'Account' },
        suppliedFlags: ['target-org', 'type', 'target', 'output', 'output-file', 'api-version', 'interactive'],
        defaultedFlags: [],
      },
      {
        command: UserDiff,
        flags: {
          ...base,
          'target-org': blockedOrg,
          user: 'Username:first@example.test',
          against: 'Username:second@example.test',
          verbose: false,
          'fail-on-drift': false,
          verify: false,
        },
        suppliedFlags: [
          'target-org',
          'user',
          'against',
          'output',
          'output-file',
          'api-version',
          'interactive',
          'verbose',
          'fail-on-drift',
          'verify',
        ],
        defaultedFlags: [],
      },
      {
        command: UserFreeze,
        flags: {
          ...base,
          'target-org': blockedOrg,
          user: 'Username:first@example.test',
          'no-prompt': false,
          'dry-run': false,
        },
        suppliedFlags: ['target-org', 'user', 'output', 'output-file', 'api-version', 'interactive'],
        defaultedFlags: ['no-prompt', 'dry-run'],
      },
      {
        command: UserUnfreeze,
        flags: {
          ...base,
          'target-org': blockedOrg,
          user: 'Username:first@example.test',
          'no-prompt': false,
          'dry-run': false,
        },
        suppliedFlags: ['target-org', 'user', 'output', 'output-file', 'api-version', 'interactive'],
        defaultedFlags: ['no-prompt', 'dry-run'],
      },
      {
        command: UserProvision,
        flags: {
          ...base,
          'target-org': blockedOrg,
          'users-def': join(dir, 'users.json'),
          'personas-def': join(dir, 'personas.json'),
          'external-id': 'FederationIdentifier',
          'input-format': 'json',
          'csv-list-delimiter': ';',
          'no-prompt': false,
          'dry-run': false,
          'fuzzy-username': false,
          'fail-on-insufficient-license': false,
        },
        suppliedFlags: [
          'target-org',
          'users-def',
          'personas-def',
          'external-id',
          'input-format',
          'csv-list-delimiter',
          'output',
          'output-file',
          'api-version',
          'interactive',
        ],
        defaultedFlags: ['no-prompt', 'dry-run', 'fuzzy-username', 'fail-on-insufficient-license'],
      },
      {
        command: UserRestore,
        flags: {
          ...base,
          'target-org': blockedOrg,
          snapshot: join(dir, 'restore.json'),
          'no-prompt': false,
          'dry-run': false,
        },
        suppliedFlags: ['target-org', 'snapshot', 'output', 'output-file', 'api-version', 'interactive'],
        defaultedFlags: ['no-prompt', 'dry-run'],
      },
      {
        command: UserSnapshot,
        flags: { ...base, 'target-org': blockedOrg, user: 'Username:first@example.test', out: snapshotPath },
        suppliedFlags: ['target-org', 'user', 'out', 'output', 'output-file', 'api-version', 'interactive'],
        defaultedFlags: [],
      },
      {
        command: UserStrip,
        flags: {
          ...base,
          'target-org': blockedOrg,
          user: 'Username:first@example.test',
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
        },
        suppliedFlags: ['target-org', 'user', 'snapshot', 'output', 'output-file', 'api-version', 'interactive'],
        defaultedFlags: [
          'no-prompt',
          'dry-run',
          'no-freeze',
          'no-deactivate',
          'keep-permsets',
          'keep-permset-groups',
          'keep-licenses',
          'keep-public-groups',
          'keep-queues',
        ],
      },
    ];
    writeFileSync(join(dir, 'users.json'), JSON.stringify({ users: [] }));
    writeFileSync(join(dir, 'personas.json'), JSON.stringify({ personas: {} }));
    writeFileSync(join(dir, 'restore.json'), JSON.stringify({ snapshotVersion: 1, capturedAt: '', users: [] }));

    const installPromptStubs = (): void => {
      sinon.stub(promptRuntime, 'select').callsFake((async (config: { message: string }) => {
        if (config.message === 'Access audit mode') return 'target' as never;
        if (config.message === 'Diff mode') return 'users' as never;
        return 'human' as never;
      }) as never);
      sinon.stub(promptRuntime, 'input').resolves('' as never);
      sinon.stub(promptRuntime, 'confirm').resolves(false as never);
      sinon.stub(promptRuntime, 'checkbox').resolves([] as never);
    };
    installPromptStubs();
    const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    try {
      for (const testCase of cases) {
        installInteractiveParse(testCase.command, testCase.flags, testCase.suppliedFlags, testCase.defaultedFlags);
        const confirm = sinon.stub(testCase.command.prototype as Record<string, unknown>, 'confirm').resolves(false);
        // eslint-disable-next-line no-await-in-loop
        const result = await testCase.command.run([]);
        expect(confirm.calledOnce).to.equal(true);
        if (testCase.command === UserAccess) expect(result).to.deep.include({ targetType: 'object' });
        else expect((result as { summary: { total: number } }).summary.total).to.equal(0);
        expect(existsSync(snapshotPath)).to.equal(false);
        expect(existsSync(outputPath)).to.equal(false);
        sinon.restore();
        $$.restore();
        stubSfCommandUx($$.SANDBOX);
        installPromptStubs();
        Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
      }
    } finally {
      if (ttyDescriptor) Object.defineProperty(process.stdin, 'isTTY', ttyDescriptor);
      else delete (process.stdin as unknown as { isTTY?: boolean }).isTTY;
    }
  });

  it('rejects contradictory diff branch flags before prompting or confirmation', async () => {
    const org = makeOrg(makeConnection());
    const baseFlags = {
      'target-org': org,
      user: undefined,
      against: undefined,
      'users-def': undefined,
      'personas-def': undefined,
      'external-id': undefined,
      'input-format': undefined,
      'csv-list-delimiter': undefined,
      output: 'human',
      'output-file': undefined,
      verbose: false,
      'fail-on-drift': false,
      verify: false,
      'api-version': undefined,
      interactive: true,
    };
    const cases: Array<{ label: string; flags: Record<string, unknown>; suppliedFlags: string[]; message: string }> = [
      {
        label: 'against with a users definition',
        flags: { against: 'Username:second@example.test', 'users-def': 'users.json' },
        suppliedFlags: ['against', 'users-def'],
        message: 'Supply flags for one mode, not both.',
      },
      {
        label: 'user with a users definition',
        flags: { user: 'Username:first@example.test', 'users-def': 'users.json' },
        suppliedFlags: ['user', 'users-def'],
        message: '--users-def cannot also be provided when using --user',
      },
      {
        label: 'user with an external id',
        flags: { user: 'Username:first@example.test', 'external-id': 'FederationIdentifier' },
        suppliedFlags: ['user', 'external-id'],
        message: '--external-id is only valid with --users-def',
      },
      {
        label: 'against with a personas definition',
        flags: { against: 'Username:second@example.test', 'personas-def': 'personas.json' },
        suppliedFlags: ['against', 'personas-def'],
        message: '--personas-def is only valid with --users-def',
      },
      {
        label: 'user mode with verify',
        flags: { user: 'Username:first@example.test', against: 'Username:second@example.test', verify: true },
        suppliedFlags: ['user', 'against', 'verify'],
        message: '--verify is only valid with --users-def',
      },
    ];

    const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    try {
      for (const testCase of cases) {
        const select = sinon.stub(promptRuntime, 'select').rejects(new Error('no prompt expected'));
        const input = sinon.stub(promptRuntime, 'input').rejects(new Error('no prompt expected'));
        installInteractiveParse(
          UserDiff,
          { ...baseFlags, ...testCase.flags },
          ['target-org', 'interactive', ...testCase.suppliedFlags],
          ['output', 'verbose', 'fail-on-drift', ...(testCase.flags.verify === true ? [] : ['verify'])]
        );
        const confirm = sinon.stub(UserDiff.prototype as unknown as Record<string, unknown>, 'confirm').resolves(true);
        // eslint-disable-next-line no-await-in-loop
        const error = await UserDiff.run([]).then(
          () => undefined,
          (thrown: Error) => thrown
        );
        expect(error?.message, testCase.label).to.contain(testCase.message);
        expect(confirm.called, testCase.label).to.equal(false);
        expect(select.called || input.called, testCase.label).to.equal(false);
        sinon.restore();
        $$.restore();
        stubSfCommandUx($$.SANDBOX);
        Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
      }
    } finally {
      if (ttyDescriptor) Object.defineProperty(process.stdin, 'isTTY', ttyDescriptor);
      else delete (process.stdin as unknown as { isTTY?: boolean }).isTTY;
    }
  });

  it('rejects supplied user and users-def conflicts before prompting on lifecycle commands', async () => {
    const org = makeOrg(makeConnection());
    const commonFlags = {
      'target-org': org,
      user: 'Username:first@example.test',
      'users-def': 'users.json',
      'external-id': undefined,
      'input-format': undefined,
      'csv-list-delimiter': undefined,
      output: 'human',
      'output-file': undefined,
      'api-version': undefined,
      interactive: true,
    };
    const cases: Array<{ label: string; command: InteractiveCommand; flags: Record<string, unknown> }> = [
      { label: 'freeze', command: UserFreeze, flags: { ...commonFlags, 'no-prompt': false, 'dry-run': false } },
      { label: 'unfreeze', command: UserUnfreeze, flags: { ...commonFlags, 'no-prompt': false, 'dry-run': false } },
      { label: 'snapshot', command: UserSnapshot, flags: { ...commonFlags, out: undefined } },
      {
        label: 'strip',
        command: UserStrip,
        flags: {
          ...commonFlags,
          'no-prompt': false,
          'dry-run': false,
          'no-freeze': false,
          'no-deactivate': false,
          'keep-permsets': false,
          'keep-permset-groups': false,
          'keep-licenses': false,
          'keep-public-groups': false,
          'keep-queues': false,
          snapshot: undefined,
        },
      },
    ];

    const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    try {
      for (const testCase of cases) {
        const select = sinon.stub(promptRuntime, 'select').rejects(new Error('no prompt expected'));
        const input = sinon.stub(promptRuntime, 'input').rejects(new Error('no prompt expected'));
        installInteractiveParse(testCase.command, testCase.flags, [
          'target-org',
          'user',
          'users-def',
          'output',
          'interactive',
        ]);
        const confirm = sinon
          .stub(testCase.command.prototype as unknown as Record<string, unknown>, 'confirm')
          .resolves(true);
        // eslint-disable-next-line no-await-in-loop
        const error = await testCase.command.run([]).then(
          () => undefined,
          (thrown: Error) => thrown
        );
        expect(error?.message, testCase.label).to.equal('--users-def cannot also be provided when using --user');
        expect(confirm.called, testCase.label).to.equal(false);
        expect(select.called || input.called, testCase.label).to.equal(false);
        sinon.restore();
        $$.restore();
        stubSfCommandUx($$.SANDBOX);
        Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
      }
    } finally {
      if (ttyDescriptor) Object.defineProperty(process.stdin, 'isTTY', ttyDescriptor);
      else delete (process.stdin as unknown as { isTTY?: boolean }).isTTY;
    }
  });

  it('rejects prompted non-human output with supplied verbose before confirmation', async () => {
    const org = makeOrg(makeConnection());
    const flags = {
      'target-org': org,
      user: 'Username:first@example.test',
      against: 'Username:second@example.test',
      'users-def': undefined,
      'personas-def': undefined,
      'external-id': undefined,
      'input-format': undefined,
      'csv-list-delimiter': undefined,
      output: 'human',
      'output-file': undefined,
      verbose: true,
      'fail-on-drift': false,
      verify: false,
      'api-version': undefined,
      interactive: true,
    };
    const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    try {
      const select = sinon.stub(promptRuntime, 'select').callsFake((async (config: { message: string }) => {
        expect(config.message).to.equal('Output format');
        return 'csv' as never;
      }) as never);
      const confirm = sinon.stub(UserDiff.prototype as unknown as Record<string, unknown>, 'confirm').resolves(true);
      installInteractiveParse(UserDiff, flags, ['target-org', 'user', 'against', 'verbose', 'interactive'], ['output']);
      const error = await UserDiff.run([]).then(
        () => undefined,
        (thrown: Error) => thrown
      );
      expect(error?.message).to.contain('--verbose');
      expect(confirm.called).to.equal(false);
      expect(select.calledOnce).to.equal(true);
    } finally {
      if (ttyDescriptor) Object.defineProperty(process.stdin, 'isTTY', ttyDescriptor);
      else delete (process.stdin as unknown as { isTTY?: boolean }).isTTY;
    }
  });

  it('only offers a related-record catalog after JSON input is selected', async () => {
    const getConnection = sinon.stub().throws(new Error('org access should not occur'));
    const org = { getConnection, getUsername: () => 'interactive@example.test' };
    const promptedMessages: string[] = [];
    const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    try {
      sinon.stub(promptRuntime, 'select').callsFake((async (config: { message: string }) => {
        promptedMessages.push(config.message);
        return config.message === 'Input format' ? ('csv' as never) : ('human' as never);
      }) as never);
      sinon.stub(promptRuntime, 'input').callsFake((async (config: { message: string }) => {
        promptedMessages.push(config.message);
        return '' as never;
      }) as never);
      sinon.stub(promptRuntime, 'confirm').callsFake((async (config: { message: string }) => {
        promptedMessages.push(config.message);
        return false;
      }) as never);
      const confirm = sinon.stub(UserProvision.prototype as unknown as Record<string, unknown>, 'confirm').resolves(false);
      installInteractiveParse(
        UserProvision,
        {
          'target-org': org,
          'users-def': '/tmp/users.data',
          'personas-def': undefined,
          'related-def': undefined,
          'external-id': undefined,
          'input-format': undefined,
          'csv-list-delimiter': undefined,
          'fuzzy-username': false,
          'no-prompt': false,
          'dry-run': false,
          'fail-on-insufficient-license': false,
          output: 'human',
          'output-file': undefined,
          'api-version': undefined,
          interactive: true,
        },
        ['target-org', 'users-def', 'interactive'],
        ['output', 'fuzzy-username', 'no-prompt', 'dry-run', 'fail-on-insufficient-license']
      );

      await UserProvision.run([]);

      expect(promptedMessages).to.include('Input format');
      expect(promptedMessages).to.include('CSV list delimiter');
      expect(promptedMessages).not.to.include('Related record definition file');
      expect(confirm.calledOnce).to.equal(true);
      expect(getConnection.called).to.equal(false);
    } finally {
      if (ttyDescriptor) Object.defineProperty(process.stdin, 'isTTY', ttyDescriptor);
      else delete (process.stdin as unknown as { isTTY?: boolean }).isTTY;
    }
  });

  it('rejects a supplied related-record catalog with CSV before prompting, confirmation, or org access', async () => {
    const getConnection = sinon.stub().throws(new Error('org access should not occur'));
    const org = { getConnection, getUsername: () => 'interactive@example.test' };
    const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    try {
      const select = sinon.stub(promptRuntime, 'select').rejects(new Error('no prompt expected'));
      const input = sinon.stub(promptRuntime, 'input').rejects(new Error('no prompt expected'));
      const confirm = sinon.stub(UserProvision.prototype as unknown as Record<string, unknown>, 'confirm').resolves(true);
      installInteractiveParse(
        UserProvision,
        {
          'target-org': org,
          'users-def': '/tmp/users.csv',
          'personas-def': undefined,
          'related-def': '/tmp/related.json',
          'external-id': undefined,
          'input-format': 'csv',
          'csv-list-delimiter': undefined,
          'fuzzy-username': false,
          'no-prompt': false,
          'dry-run': false,
          'fail-on-insufficient-license': false,
          output: 'human',
          'output-file': undefined,
          'api-version': undefined,
          interactive: true,
        },
        ['target-org', 'users-def', 'related-def', 'input-format', 'interactive']
      );

      const error = await UserProvision.run([]).then(
        () => undefined,
        (thrown: Error) => thrown
      );

      expect(error?.message).to.equal(
        '--related-def requires a JSON --users-def. CSV user definitions cannot select relationships.'
      );
      expect(select.called).to.equal(false);
      expect(input.called).to.equal(false);
      expect(confirm.called).to.equal(false);
      expect(getConnection.called).to.equal(false);
    } finally {
      if (ttyDescriptor) Object.defineProperty(process.stdin, 'isTTY', ttyDescriptor);
      else delete (process.stdin as unknown as { isTTY?: boolean }).isTTY;
    }
  });

  it('rejects a related-record catalog with an inferred CSV format before prompting, confirmation, or org access', async () => {
    const getConnection = sinon.stub().throws(new Error('org access should not occur'));
    const org = { getConnection, getUsername: () => 'interactive@example.test' };
    const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    try {
      const select = sinon.stub(promptRuntime, 'select').rejects(new Error('no prompt expected'));
      const input = sinon.stub(promptRuntime, 'input').rejects(new Error('no prompt expected'));
      const confirm = sinon.stub(UserProvision.prototype as unknown as Record<string, unknown>, 'confirm').resolves(true);
      installInteractiveParse(
        UserProvision,
        {
          'target-org': org,
          'users-def': '/tmp/users.csv',
          'personas-def': undefined,
          'related-def': '/tmp/related.json',
          'external-id': undefined,
          'input-format': undefined,
          'csv-list-delimiter': undefined,
          'fuzzy-username': false,
          'no-prompt': false,
          'dry-run': false,
          'fail-on-insufficient-license': false,
          output: 'human',
          'output-file': undefined,
          'api-version': undefined,
          interactive: true,
        },
        ['target-org', 'users-def', 'related-def', 'interactive']
      );

      const error = await UserProvision.run([]).then(
        () => undefined,
        (thrown: Error) => thrown
      );

      expect(error?.message).to.equal(
        '--related-def requires a JSON --users-def. CSV user definitions cannot select relationships.'
      );
      expect(select.called).to.equal(false);
      expect(input.called).to.equal(false);
      expect(confirm.called).to.equal(false);
      expect(getConnection.called).to.equal(false);
    } finally {
      if (ttyDescriptor) Object.defineProperty(process.stdin, 'isTTY', ttyDescriptor);
      else delete (process.stdin as unknown as { isTTY?: boolean }).isTTY;
    }
  });

  it('rejects prompted paths for existing-file flags before the confirmation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'warden-interactive-missing-'));
    const usersPath = join(dir, 'users.json');
    const outPath = join(dir, 'out.json');
    const missingPath = join(dir, 'missing.json');
    writeFileSync(usersPath, JSON.stringify({ users: [] }));

    const org = makeOrg(makeConnection());
    const lifecycleFlags = {
      'target-org': org,
      user: undefined,
      'users-def': undefined,
      'external-id': undefined,
      'input-format': undefined,
      'csv-list-delimiter': undefined,
      output: 'human',
      'output-file': undefined,
      'api-version': undefined,
      interactive: true,
    };
    const cases: Array<{
      label: string;
      command: InteractiveCommand;
      flags: Record<string, unknown>;
      defaultedFlags: string[];
      answers: Record<string, string>;
    }> = [
      {
        label: 'diff --users-def',
        command: UserDiff,
        flags: {
          ...lifecycleFlags,
          against: undefined,
          'personas-def': undefined,
          verbose: false,
          'fail-on-drift': false,
          verify: false,
        },
        defaultedFlags: ['output', 'verbose', 'fail-on-drift', 'verify'],
        answers: { 'Users definition file': missingPath },
      },
      {
        label: 'diff --personas-def',
        command: UserDiff,
        flags: {
          ...lifecycleFlags,
          against: undefined,
          'personas-def': undefined,
          verbose: false,
          'fail-on-drift': false,
          verify: false,
        },
        defaultedFlags: ['output', 'verbose', 'fail-on-drift', 'verify'],
        answers: { 'Users definition file': usersPath, 'Personas definition file': missingPath },
      },
      {
        label: 'provision --related-def',
        command: UserProvision,
        flags: {
          ...lifecycleFlags,
          user: undefined,
          'personas-def': undefined,
          'related-def': undefined,
          'fuzzy-username': false,
          'no-prompt': false,
          'dry-run': false,
          'fail-on-insufficient-license': false,
        },
        defaultedFlags: ['output', 'fuzzy-username', 'no-prompt', 'dry-run', 'fail-on-insufficient-license'],
        answers: { 'Users definition file': usersPath, 'Related record definition file': missingPath },
      },
      {
        label: 'provision --users-def',
        command: UserProvision,
        flags: {
          ...lifecycleFlags,
          user: undefined,
          'personas-def': undefined,
          'fuzzy-username': false,
          'no-prompt': false,
          'dry-run': false,
          'fail-on-insufficient-license': false,
        },
        defaultedFlags: ['output', 'fuzzy-username', 'no-prompt', 'dry-run', 'fail-on-insufficient-license'],
        answers: { 'Users definition file': missingPath },
      },
      {
        label: 'provision --personas-def',
        command: UserProvision,
        flags: {
          ...lifecycleFlags,
          user: undefined,
          'personas-def': undefined,
          'fuzzy-username': false,
          'no-prompt': false,
          'dry-run': false,
          'fail-on-insufficient-license': false,
        },
        defaultedFlags: ['output', 'fuzzy-username', 'no-prompt', 'dry-run', 'fail-on-insufficient-license'],
        answers: { 'Users definition file': usersPath, 'Personas definition file': missingPath },
      },
      {
        label: 'restore --snapshot',
        command: UserRestore,
        flags: {
          'target-org': org,
          snapshot: undefined,
          'no-prompt': false,
          'dry-run': false,
          output: 'human',
          'output-file': undefined,
          'api-version': undefined,
          interactive: true,
        },
        defaultedFlags: ['output', 'no-prompt', 'dry-run'],
        answers: { 'Snapshot file': missingPath },
      },
      {
        label: 'freeze --users-def',
        command: UserFreeze,
        flags: { ...lifecycleFlags, 'no-prompt': false, 'dry-run': false },
        defaultedFlags: ['output', 'no-prompt', 'dry-run'],
        answers: { 'Users definition file': missingPath },
      },
      {
        label: 'unfreeze --users-def',
        command: UserUnfreeze,
        flags: { ...lifecycleFlags, 'no-prompt': false, 'dry-run': false },
        defaultedFlags: ['output', 'no-prompt', 'dry-run'],
        answers: { 'Users definition file': missingPath },
      },
      {
        label: 'snapshot --users-def',
        command: UserSnapshot,
        flags: { ...lifecycleFlags, out: undefined },
        defaultedFlags: ['output'],
        answers: { 'Users definition file': missingPath, 'Snapshot output path': outPath },
      },
      {
        label: 'strip --users-def',
        command: UserStrip,
        flags: {
          ...lifecycleFlags,
          'no-prompt': false,
          'dry-run': false,
          'no-freeze': false,
          'no-deactivate': false,
          'keep-permsets': false,
          'keep-permset-groups': false,
          'keep-licenses': false,
          'keep-public-groups': false,
          'keep-queues': false,
          snapshot: undefined,
        },
        defaultedFlags: [
          'output',
          'no-prompt',
          'dry-run',
          'no-freeze',
          'no-deactivate',
          'keep-permsets',
          'keep-permset-groups',
          'keep-licenses',
          'keep-public-groups',
          'keep-queues',
        ],
        answers: { 'Users definition file': missingPath },
      },
    ];

    const installPromptStubs = (answers: Record<string, string>): void => {
      sinon.stub(promptRuntime, 'select').callsFake((async (config: { message: string }) => {
        if (config.message === 'Diff mode') return 'personas' as never;
        if (config.message === 'User selection') return 'users-def' as never;
        if (config.message === 'Input format') return 'json' as never;
        return 'human' as never;
      }) as never);
      sinon.stub(promptRuntime, 'input').callsFake((async (config: { message: string }) => {
        if (config.message in answers) return answers[config.message] as never;
        return (config.message === 'CSV list delimiter' ? ';' : '') as never;
      }) as never);
      sinon.stub(promptRuntime, 'confirm').resolves(false as never);
      sinon.stub(promptRuntime, 'checkbox').resolves([] as never);
    };

    const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    try {
      for (const testCase of cases) {
        installPromptStubs(testCase.answers);
        installInteractiveParse(
          testCase.command,
          testCase.flags,
          ['target-org', 'interactive'],
          testCase.defaultedFlags
        );
        const confirm = sinon.stub(testCase.command.prototype as Record<string, unknown>, 'confirm').resolves(true);
        // eslint-disable-next-line no-await-in-loop
        const error = await testCase.command.run([]).then(
          () => undefined,
          (thrown: Error) => thrown
        );
        expect(error?.message, testCase.label).to.equal(`No file found at ${missingPath}`);
        expect(confirm.called, testCase.label).to.equal(false);
        expect(existsSync(outPath), testCase.label).to.equal(false);
        sinon.restore();
        $$.restore();
        stubSfCommandUx($$.SANDBOX);
        Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
      }
    } finally {
      if (ttyDescriptor) Object.defineProperty(process.stdin, 'isTTY', ttyDescriptor);
      else delete (process.stdin as unknown as { isTTY?: boolean }).isTTY;
    }
  });
});
