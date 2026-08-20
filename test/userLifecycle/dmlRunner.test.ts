import { expect } from 'chai';
import sinon from 'sinon';
import {
  markSuccess,
  runAssignmentCreates,
  runAssignmentDeletes,
  runRecordUpdate,
} from '../../src/userLifecycle/dmlRunner.js';
import type { LifecycleUserResult } from '../../src/userLifecycle/types.js';

const result = (): LifecycleUserResult => ({
  key: 'Username:lifecycle@example.com',
  status: 'unchanged',
  actions: [],
  skipped: [],
  warnings: [],
  errors: [],
});

const item = (id: string) => ({ id, apiName: id, type: 'PermissionSet' as const });

const connection = () => {
  const create = sinon.stub();
  const remove = sinon.stub();
  const update = sinon.stub();
  const conn = { sobject: sinon.stub().returns({ create, delete: remove, update }) };
  return { conn, create, remove, update };
};

describe('userLifecycle dmlRunner', () => {
  it('records every successful assignment create', async () => {
    const { conn, create } = connection();
    create.resolves([
      { success: true, id: '0PSA1', errors: [] },
      { success: true, id: '0PSA2', errors: [] },
    ]);
    const lifecycleResult = result();
    const items = [item('First'), item('Second')];

    await runAssignmentCreates({
      conn: conn as never,
      result: lifecycleResult,
      sobject: 'PermissionSetAssignment',
      rows: [
        { AssigneeId: '005user', PermissionSetId: '0PS1' },
        { AssigneeId: '005user', PermissionSetId: '0PS2' },
      ],
      actionKey: 'assignedPermissionSet',
      items,
    });

    expect(create.firstCall.args[1]).to.deep.equal({ allOrNone: false });
    expect(lifecycleResult.status).to.equal('changed');
    expect(lifecycleResult.actions).to.deep.equal([{ key: 'assignedPermissionSet', count: 2, items }]);
    expect(lifecycleResult.errors).to.deep.equal([]);
  });

  it('records only successful assignment deletes and marks partial failure immediately', async () => {
    const { conn, remove } = connection();
    remove.resolves([
      { success: true, id: '0PSA1', errors: [] },
      { success: false, errors: [{ message: 'Second removal failed' }] },
    ]);
    const lifecycleResult = result();
    const items = [item('First'), item('Second')];

    await runAssignmentDeletes({
      conn: conn as never,
      result: lifecycleResult,
      sobject: 'PermissionSetAssignment',
      ids: ['0PSA1', '0PSA2'],
      actionKey: 'removedPermissionSet',
      items,
    });

    expect(lifecycleResult.status).to.equal('failed');
    expect(lifecycleResult.actions).to.deep.equal([{ key: 'removedPermissionSet', count: 1, items: [items[0]] }]);
    expect(lifecycleResult.errors).to.deep.equal(['Second removal failed']);
  });

  it('records no action when every assignment create fails', async () => {
    const { conn, create } = connection();
    create.resolves([
      { success: false, errors: [{ message: 'First assignment failed' }] },
      { success: false, errors: [{ message: 'Second assignment failed' }] },
    ]);
    const lifecycleResult = result();

    await runAssignmentCreates({
      conn: conn as never,
      result: lifecycleResult,
      sobject: 'PermissionSetAssignment',
      rows: [
        { AssigneeId: '005user', PermissionSetId: '0PS1' },
        { AssigneeId: '005user', PermissionSetId: '0PS2' },
      ],
      actionKey: 'assignedPermissionSet',
      items: [item('First'), item('Second')],
    });

    expect(lifecycleResult.status).to.equal('failed');
    expect(lifecycleResult.actions).to.deep.equal([]);
    expect(lifecycleResult.errors).to.deep.equal(['First assignment failed', 'Second assignment failed']);
  });

  it('handles a successful multi-row update', async () => {
    const { conn, update } = connection();
    update.resolves([
      { success: true, id: '0LL1', errors: [] },
      { success: true, id: '0LL2', errors: [] },
    ]);
    const lifecycleResult = result();
    const rows = [
      { Id: '0LL1', IsFrozen: false },
      { Id: '0LL2', IsFrozen: false },
    ];

    await runRecordUpdate({
      conn: conn as never,
      result: lifecycleResult,
      sobject: 'UserLogin',
      rows,
      actionKey: 'unfrozen',
    });

    expect(update.firstCall.args).to.deep.equal([rows, { allOrNone: false }]);
    expect(lifecycleResult.status).to.equal('changed');
    expect(lifecycleResult.actions).to.deep.equal([{ key: 'unfrozen' }]);
  });

  it('leaves the result untouched for empty input', async () => {
    const { conn } = connection();
    const lifecycleResult = result();

    await runAssignmentCreates({
      conn: conn as never,
      result: lifecycleResult,
      sobject: 'PermissionSetAssignment',
      rows: [],
      actionKey: 'assignedPermissionSet',
      items: [],
    });
    await runAssignmentDeletes({
      conn: conn as never,
      result: lifecycleResult,
      sobject: 'PermissionSetAssignment',
      ids: [],
      actionKey: 'removedPermissionSet',
      items: [],
    });
    await runRecordUpdate({
      conn: conn as never,
      result: lifecycleResult,
      sobject: 'User',
      rows: [],
      actionKey: 'activated',
    });

    expect(conn.sobject.called).to.equal(false);
    expect(lifecycleResult).to.deep.equal(result());
  });

  it('does not downgrade a failed result when recording a later success', () => {
    const lifecycleResult = result();
    lifecycleResult.status = 'failed';

    markSuccess(lifecycleResult, 'laterAction');

    expect(lifecycleResult.status).to.equal('failed');
    expect(lifecycleResult.actions).to.deep.equal([{ key: 'laterAction' }]);
  });
});
