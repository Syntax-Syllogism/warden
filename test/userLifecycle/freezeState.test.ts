import { expect } from 'chai';
import sinon from 'sinon';
import { executeFreezeToggle, FREEZE, UNFREEZE, type FreezeDirection } from '../../src/userLifecycle/freezeState.js';

type LoginRow = { Id: string; UserId: string; IsFrozen: boolean };

const fieldMap = new Map([
  ['username', { name: 'Username', createable: true, updateable: true, filterable: true, externalId: true }],
]);

const request = (username: string, order = 0) => ({
  key: `Username:${username}`,
  field: 'Username',
  value: username,
  order,
});

const createConnection = (users: Array<Record<string, unknown>>, loginRows: LoginRow[]) => {
  const update = sinon.stub().resolves([{ success: true, id: '0LLsave', errors: [] }]);
  const conn = {
    query: sinon.stub().callsFake(async (soql: string) => {
      if (soql.includes('FROM UserLogin')) return { records: loginRows };
      if (soql.includes('FROM User WHERE')) return { records: users };
      return { records: [] };
    }),
    sobject: sinon.stub().returns({ update }),
  };
  return { conn, update };
};

const execute = async (
  direction: FreezeDirection,
  options: {
    users?: Array<Record<string, unknown>>;
    loginRows?: LoginRow[];
    requests?: Array<ReturnType<typeof request>>;
    dryRun?: boolean;
    noPrompt?: boolean;
    interactive?: boolean;
    confirm?: sinon.SinonStub;
    warn?: sinon.SinonStub;
  } = {}
) => {
  const usernames = options.requests?.map((item) => item.value) ?? ['alice@example.com'];
  const users =
    options.users ??
    usernames.map((username, index) => ({
      Id: `005user${index + 1}`,
      IsActive: true,
      Name: `User ${index + 1}`,
      Username: username,
    }));
  const { conn, update } = createConnection(options.users ?? users, options.loginRows ?? []);
  const confirm = options.confirm ?? sinon.stub().resolves(true);
  const warn = options.warn ?? sinon.stub();
  const result = await executeFreezeToggle({
    conn: conn as never,
    fieldMap,
    requests: options.requests ?? [request('alice@example.com')],
    requestErrors: [],
    direction,
    dryRun: options.dryRun ?? false,
    noPrompt: options.noPrompt ?? true,
    interactive: options.interactive ?? false,
    message: (key) =>
      ({
        warningMissingUserLogin: 'missing login',
        promptContinue: 'continue?',
        warningPromptTimeout: 'timed out',
        errorPromptDeclined: 'Operation cancelled.',
      }[key] ?? key),
    confirm,
    warn,
  });
  return { result, update, confirm, warn };
};

describe('userLifecycle freezeState', () => {
  afterEach(() => sinon.restore());

  for (const direction of [FREEZE, UNFREEZE]) {
    const verb = direction === FREEZE ? 'freeze' : 'unfreeze';
    const initialState = !direction.targetState;

    it(`${verb}s a user and reports the direction-specific action`, async () => {
      const { result, update } = await execute(direction, {
        loginRows: [{ Id: '0LL1', UserId: '005user1', IsFrozen: initialState }],
      });

      expect(result.summary).to.deep.equal({ total: 1, changed: 1, unchanged: 0, failed: 0 });
      expect(result.users[0].actions.map((action) => action.key)).to.deep.equal([direction.actionKey]);
      expect(update.firstCall.args).to.deep.equal([
        [{ Id: '0LL1', IsFrozen: direction.targetState }],
        { allOrNone: false },
      ]);
    });

    it(`plans a ${verb} without DML`, async () => {
      const { result, update } = await execute(direction, {
        dryRun: true,
        loginRows: [{ Id: '0LL1', UserId: '005user1', IsFrozen: initialState }],
      });

      expect(result.users[0].status).to.equal('planned');
      expect(result.users[0].actions.map((action) => action.key)).to.deep.equal([direction.wouldKey]);
      expect(update.called).to.equal(false);
    });

    it(`reports a user already ${verb === 'freeze' ? 'frozen' : 'unfrozen'} without DML`, async () => {
      const { result, update } = await execute(direction, {
        loginRows: [{ Id: '0LL1', UserId: '005user1', IsFrozen: direction.targetState }],
      });

      expect(result.users[0].status).to.equal('unchanged');
      expect(result.users[0].actions.map((action) => action.key)).to.deep.equal([direction.alreadyKey]);
      expect(update.called).to.equal(false);
    });

    it('warns when the target has no UserLogin row', async () => {
      const { result, update } = await execute(direction);

      expect(result.users[0].status).to.equal('unchanged');
      expect(result.users[0].warnings).to.deep.equal(['missing login']);
      expect(update.called).to.equal(false);
    });

    it('does not apply DML when confirmation is declined', async () => {
      const confirm = sinon.stub().resolves(false);
      const { conn, update } = createConnection(
        [{ Id: '005user1', IsActive: true, Name: 'User 1', Username: 'alice@example.com' }],
        [{ Id: '0LL1', UserId: '005user1', IsFrozen: initialState }]
      );
      try {
        await executeFreezeToggle({
          conn: conn as never,
          fieldMap,
          requests: [request('alice@example.com')],
          requestErrors: [],
          direction,
          dryRun: false,
          noPrompt: false,
          interactive: true,
          message: (key) =>
            ({
              promptContinue: 'continue?',
              errorPromptDeclined: 'Operation cancelled.',
            }[key] ?? key),
          confirm,
          warn: sinon.stub(),
        });
        expect.fail('Expected the operation to be cancelled.');
      } catch (error) {
        expect(error).to.have.property('message', 'Operation cancelled.');
      }
      expect(update.called).to.equal(false);
    });

    it(`keeps DML results aligned after an already-${verb === 'freeze' ? 'frozen' : 'unfrozen'} target is skipped`, async () => {
      const requests = [request('already@example.com'), request('change@example.com', 1)];
      const { conn, update } = createConnection(
        [
          { Id: '005already', IsActive: true, Name: 'Already', Username: 'already@example.com' },
          { Id: '005change', IsActive: true, Name: 'Change', Username: 'change@example.com' },
        ],
        [
          { Id: '0LLalready', UserId: '005already', IsFrozen: direction.targetState },
          { Id: '0LLchange', UserId: '005change', IsFrozen: initialState },
        ]
      );
      update.resolves([{ success: false, id: '0LLchange', errors: [{ message: `${verb} failed` }] }]);

      const result = await executeFreezeToggle({
        conn: conn as never,
        fieldMap,
        requests,
        requestErrors: [],
        direction,
        dryRun: false,
        noPrompt: true,
        interactive: false,
        message: (key) => key,
        confirm: sinon.stub().resolves(true),
        warn: sinon.stub(),
      });

      expect(result.users[0].actions.map((action) => action.key)).to.deep.equal([direction.alreadyKey]);
      expect(result.users[1].status).to.equal('failed');
      expect(result.users[1].errors).to.deep.equal([`${verb} failed`]);
    });
  }
});
