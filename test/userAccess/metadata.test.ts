import { expect } from 'chai';
import sinon from 'sinon';
import { METADATA_BATCH_SIZE, METADATA_CONCURRENCY, readMetadataInBatches } from '../../src/userAccess/metadata.js';
import { UserAccessError } from '../../src/userAccess/types.js';

describe('userAccess metadata reads', () => {
  it('short-circuits empty input and reads scalar responses', async () => {
    const read = sinon.stub().resolves({ fullName: 'Admin' });
    const conn = { metadata: { read } };
    expect(await readMetadataInBatches(conn as never, 'Profile', [])).to.deep.equal(new Map());
    expect(read.called).to.equal(false);
    const result = await readMetadataInBatches(conn as never, 'Profile', ['Admin']);
    expect([...result.keys()]).to.deep.equal(['Admin']);
  });

  it('deduplicates names, batches deterministically, and bounds concurrency', async () => {
    let active = 0;
    let maximum = 0;
    const calls: string[][] = [];
    const read = sinon.stub().callsFake(async (_type: string, names: string[]) => {
      calls.push(names);
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return names.map((fullName) => ({ fullName }));
    });
    const names = Array.from({ length: 101 }, (_, index) => `PS${index}`).concat('PS1');
    const result = await readMetadataInBatches(connFor(read), 'PermissionSet', names);
    expect(METADATA_BATCH_SIZE).to.equal(10);
    expect(METADATA_CONCURRENCY).to.equal(2);
    expect(calls).to.have.length(11);
    expect(calls[0]).to.deep.equal(Array.from({ length: 10 }, (_, index) => `PS${index}`));
    expect(maximum).to.be.at.most(2);
    expect(result.size).to.equal(101);
  });

  it('maps array responses by fullName and fails closed for incomplete or malformed responses', async () => {
    const read = sinon.stub().resolves([{ fullName: 'Second' }, { fullName: 'First' }]);
    const result = await readMetadataInBatches(connFor(read), 'PermissionSet', ['First', 'Second']);
    expect([...result.keys()]).to.deep.equal(['Second', 'First']);

    for (const response of [null, [{ fullName: 'Only' }], [{ name: 'Missing full name' }]]) {
      read.resetBehavior();
      read.resolves(response);
      let caught: unknown;
      try {
        // eslint-disable-next-line no-await-in-loop
        await readMetadataInBatches(connFor(read), 'PermissionSet', ['First', 'Second']);
      } catch (error) {
        caught = error;
      }
      expect(caught).to.be.instanceOf(UserAccessError);
      expect((caught as UserAccessError).code).to.equal('errorRecordTypeMetadataReadFailed');
    }
  });

  it('wraps rejected reads with the metadata error and original cause', async () => {
    const cause = new Error('denied');
    const read = sinon.stub().rejects(cause);
    let caught: unknown;
    try {
      await readMetadataInBatches(connFor(read), 'Profile', ['Admin']);
    } catch (error) {
      caught = error;
    }
    expect(caught).to.be.instanceOf(UserAccessError);
    expect((caught as UserAccessError).cause).to.equal(cause);
    expect((caught as UserAccessError).args).to.deep.equal(['Profile', 'Admin']);
  });
});

const connFor = (read: sinon.SinonStub): never => ({ metadata: { read } } as never);
