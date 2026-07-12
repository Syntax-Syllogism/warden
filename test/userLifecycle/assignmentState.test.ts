import { expect } from 'chai';
import sinon from 'sinon';
import { loadAssignmentState } from '../../src/userLifecycle/assignmentState.js';

describe('userLifecycle assignmentState', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('batches assignment state queries by target ids', async () => {
    const ids = Array.from({ length: 101 }, (_, index) => `005xx000000${String(index).padStart(6, '0')}`);
    const conn = {
      query: sinon.stub().resolves({ records: [] }),
    };

    await loadAssignmentState(conn as never, ids, { groupMemberships: true });

    expect(conn.query.callCount).to.equal(2);
    expect(conn.query.firstCall.args[0]).to.include(ids[0]);
    expect(conn.query.firstCall.args[0]).to.not.include(ids[100]);
    expect(conn.query.secondCall.args[0]).to.include(ids[100]);
  });
});
