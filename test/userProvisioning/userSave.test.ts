import { expect } from 'chai';
import sinon from 'sinon';
import { applySavedPlan, planDryRunResult } from '../../src/userProvisioning/userSave.js';
import type { ResolvedRefs } from '../../src/userProvisioning/assignmentPlan.js';
import type { UserPlan } from '../../src/userProvisioning/userPlan.js';

const refs: ResolvedRefs = {
  profilesByRef: new Map(),
  rolesByRef: new Map(),
  permissionSetIdsByRef: new Map([['Perm', '0PS000000000001']]),
  permissionSetGroupIdsByRef: new Map(),
  publicGroupIdsByRef: new Map(),
  queueIdsByRef: new Map(),
  warnings: [],
};

const makePlan = (persona: UserPlan['effectivePersona'] = { permissionSets: ['Perm'] }): UserPlan => ({
  planId: '0:alice:admin',
  order: 0,
  key: 'alice',
  personas: ['admin'],
  effectivePersona: persona,
  matchedBy: null,
  matchValue: null,
  target: { LastName: 'Alice' },
  actions: ['created'],
  errors: [],
});

describe('userProvisioning userSave', () => {
  it('plans assignment actions during a dry run without DML', async () => {
    const query = sinon.stub().resolves({ records: [] });
    const conn = { query, sobject: sinon.stub() } as never;
    const result = await planDryRunResult({ conn, plan: makePlan(), refs });

    expect(result.status).to.equal('planned');
    expect(result.actions).to.include('wouldAssignPermissionSet');
    expect((conn as { sobject: sinon.SinonStub }).sobject.called).to.equal(false);
  });

  it('unfreezes a saved user before applying assignments', async () => {
    const query = sinon
      .stub()
      .callsFake(async (soql: string) =>
        soql.includes('FROM UserLogin') ? { records: [{ Id: '0LL000000000001' }] } : { records: [] }
      );
    const update = sinon.stub().resolves({ success: true, id: '0LL000000000001', errors: [] });
    const conn = { query, sobject: sinon.stub().withArgs('UserLogin').returns({ update }) } as never;
    const plan = makePlan({});

    const result = await applySavedPlan({
      conn,
      outcome: { plan, success: true, id: '005000000000001', errors: [] },
      refs,
      message: () => 'missing save id',
    });

    expect(result.status).to.equal('created');
    expect(result.actions).to.include('unfrozen');
    expect(update.calledWith([{ Id: '0LL000000000001', IsFrozen: false }], { allOrNone: false })).to.equal(true);
  });

  it('keeps partial assignment DML failures on the result', async () => {
    const query = sinon.stub().resolves({ records: [] });
    const create = sinon.stub().resolves({
      success: false,
      errors: [{ statusCode: 'INVALID', message: 'assignment rejected' }],
    });
    const conn = {
      query,
      sobject: sinon.stub().withArgs('PermissionSetAssignment').returns({ create }),
    } as never;
    const plan = makePlan();

    const result = await applySavedPlan({
      conn,
      outcome: { plan, success: true, id: '005000000000001', errors: [] },
      refs,
      message: () => 'missing save id',
    });

    expect(result.status).to.equal('failed');
    expect(result.errors).to.deep.equal(['INVALID: assignment rejected']);
  });
});
