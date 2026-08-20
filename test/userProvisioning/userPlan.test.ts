import { expect } from 'chai';
import { toUserResult, type UserPlan } from '../../src/userProvisioning/userPlan.js';

const makePlan = (existing?: UserPlan['existing']): UserPlan => ({
  planId: '1:alice:admin',
  order: 1,
  key: 'alice',
  personas: ['admin'],
  effectivePersona: {},
  matchedBy: 'Username',
  matchValue: 'target@example.test',
  target: { Name: 'Target Name', Username: 'target@example.test' },
  existing,
  actions: ['wouldUpdate'],
  errors: [],
});

describe('userProvisioning userPlan', () => {
  it('matches the original result literals, including their id behavior', () => {
    const existing = { Id: '005existing', Name: 'Existing Name', Username: 'existing@example.test' };
    const cases: Array<{
      name: string;
      plan: UserPlan;
      status: 'created' | 'updated' | 'failed' | 'planned';
      overrides?: Parameters<typeof toUserResult>[2];
      expectedId?: string;
    }> = [
      { name: 'plan error', plan: makePlan(existing), status: 'failed', overrides: { includeExistingId: false } },
      { name: 'dry-run existing', plan: makePlan(existing), status: 'planned', expectedId: '005existing' },
      { name: 'dry-run create', plan: makePlan(), status: 'planned' },
      {
        name: 'missing save id',
        plan: makePlan(),
        status: 'failed',
        overrides: { errors: ['The save returned no Id.'] },
      },
      {
        name: 'saved create',
        plan: makePlan(),
        status: 'created',
        overrides: { id: '005created' },
        expectedId: '005created',
      },
      {
        name: 'saved update',
        plan: makePlan(existing),
        status: 'updated',
        overrides: { id: '005updated' },
        expectedId: '005updated',
      },
      {
        name: 'live invalid plan',
        plan: makePlan(existing),
        status: 'failed',
        overrides: { includeExistingId: false },
      },
    ];

    for (const testCase of cases) {
      const result = toUserResult(testCase.plan, testCase.status, testCase.overrides);
      expect(result, testCase.name).to.include({
        planId: '1:alice:admin',
        order: 1,
        key: 'alice',
        userName: testCase.plan.existing ? 'Existing Name' : 'Target Name',
        username: testCase.plan.existing ? 'existing@example.test' : 'target@example.test',
        status: testCase.status,
      });
      if (testCase.expectedId) expect(result, testCase.name).to.have.property('id', testCase.expectedId);
      else expect(result, testCase.name).not.to.have.property('id');
    }
  });
});
