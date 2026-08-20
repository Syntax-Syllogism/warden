import { expect } from 'chai';
import sinon from 'sinon';
import { runAssignmentDeletes } from '../../src/userLifecycle/dmlRunner.js';
import type { LifecycleUserResult } from '../../src/userLifecycle/types.js';

const result = (): LifecycleUserResult => ({
  key: 'Username:strip@example.com',
  status: 'unchanged',
  actions: [],
  skipped: [],
  warnings: [],
  errors: [],
});

describe('userLifecycle strip apply', () => {
  it('reports only items whose delete result succeeded', async () => {
    const remove = sinon.stub().resolves([
      { success: true, id: '0PSAFirst', errors: [] },
      { success: false, errors: [{ message: 'Second removal failed' }] },
    ]);
    const lifecycleResult = result();

    await runAssignmentDeletes({
      conn: { sobject: sinon.stub().returns({ delete: remove }) } as never,
      result: lifecycleResult,
      sobject: 'PermissionSetAssignment',
      ids: ['0PSAFirst', '0PSASecond'],
      actionKey: 'removedPermissionSet',
      items: [
        { id: '0PSFirst', apiName: 'First_Permissions', type: 'PermissionSet' },
        { id: '0PSSecond', apiName: 'Second_Permissions', type: 'PermissionSet' },
      ],
    });

    expect(remove.firstCall.args).to.deep.equal([['0PSAFirst', '0PSASecond'], { allOrNone: false }]);
    expect(lifecycleResult.status).to.equal('failed');
    expect(lifecycleResult.actions).to.deep.equal([
      {
        key: 'removedPermissionSet',
        count: 1,
        items: [{ id: '0PSFirst', apiName: 'First_Permissions', type: 'PermissionSet' }],
      },
    ]);
    expect(lifecycleResult.errors).to.deep.equal(['Second removal failed']);
  });
});
