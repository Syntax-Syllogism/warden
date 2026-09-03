import { expect } from 'chai';
import sinon from 'sinon';
import { METADATA_BATCH_SIZE, METADATA_CONCURRENCY, readMetadataInBatches } from '../../src/userAccess/metadata.js';
import { UserAccessError } from '../../src/userAccess/types.js';

describe('userAccess metadata reads', () => {
  it('short-circuits empty input and reads scalar responses', async () => {
    const read = sinon.stub().resolves({ fullName: 'Admin' });
    const conn = { metadata: { read } };
    expect(await readMetadataInBatches(conn as never, 'Profile', [])).to.deep.equal({ metadata: new Map(), missing: [] });
    expect(read.called).to.equal(false);
    const result = await readMetadataInBatches(conn as never, 'Profile', ['Admin']);
    expect([...result.metadata.keys()]).to.deep.equal(['Admin']);
    expect(result.missing).to.deep.equal([]);
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
    expect(result.metadata.size).to.equal(101);
    expect(result.missing).to.deep.equal([]);
  });

  it('maps array responses by fullName and reports incomplete responses as partial', async () => {
    const read = sinon.stub().resolves([{ fullName: 'Second' }, { fullName: 'First' }]);
    const result = await readMetadataInBatches(connFor(read), 'PermissionSet', ['First', 'Second']);
    expect([...result.metadata.keys()]).to.deep.equal(['Second', 'First']);
    expect(result.missing).to.deep.equal([]);

    // An incomplete-but-well-formed response fails open: return what came back
    // and report the omitted names as missing rather than throwing.
    for (const response of [null, [{ fullName: 'First' }]]) {
      read.resetBehavior();
      read.resolves(response);
      // eslint-disable-next-line no-await-in-loop
      const partial = await readMetadataInBatches(connFor(read), 'PermissionSet', ['First', 'Second']);
      expect(partial.missing).to.include('Second');
    }
  });

  it('fails closed for malformed or unexpected responses', async () => {
    for (const response of [[{ fullName: 'Only' }], [{ name: 'Missing full name' }]]) {
      const read = sinon.stub().resolves(response);
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
