import { expect } from 'chai';
import sinon from 'sinon';
import { chunkValues, queryAllInChunks } from '../../src/userAccess/soql.js';

describe('userAccess soql helpers', () => {
  it('chunks values by requested size', () => {
    const chunks = chunkValues([1, 2, 3, 4, 5], 2);
    expect(chunks).to.deep.equal([[1, 2], [3, 4], [5]]);
  });

  it('queries each chunk and merges records', async () => {
    const conn = {
      query: sinon.stub().callsFake(async (soql: string) => {
        if (soql.includes("IN ('A','B')")) return { done: true, records: [{ id: '1' }] };
        if (soql.includes("IN ('C')")) return { done: true, records: [{ id: '2' }] };
        return { done: true, records: [] };
      }),
      queryMore: sinon.stub(),
    } as never;
    const rows = await queryAllInChunks<{ id: string }>(
      conn,
      ['A', 'B', 'C'],
      (chunk) => `SELECT id FROM X WHERE Name IN (${chunk.map((value) => `'${value}'`).join(',')})`,
      2
    );
    expect(rows.map((row) => row.id)).to.deep.equal(['1', '2']);
    expect((conn as unknown as { query: sinon.SinonStub }).query.callCount).to.equal(2);
  });
});
