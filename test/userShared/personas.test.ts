import type { Connection } from '@salesforce/core';
import { expect } from 'chai';
import sinon from 'sinon';
import {
  COMPONENT_PERSONA_FIELD,
  COMPONENT_REFERENCE_FIELD,
  COMPONENT_TYPE_FIELD,
  PERSONA_API_NAME_FIELD,
  PERSONA_ACTIVE_FIELD,
  PERSONA_COMPONENT_OBJECT,
  PERSONA_NAME_FIELD,
  PERSONA_OBJECT,
  diffPersonaDocuments,
  importOrgPersonas,
  readOrgPersonas,
} from '../../src/userShared/personas.js';

const connection = (value: unknown): Connection => value as Connection;

describe('org persona adapter', () => {
  afterEach(() => sinon.restore());

  it('maps active org personas into the canonical persona document', async () => {
    const query = sinon.stub();
    query.onFirstCall().resolves({
      records: [
        { Id: 'a01', [PERSONA_API_NAME_FIELD]: 'ops', [PERSONA_ACTIVE_FIELD]: true },
        { Id: 'a02', [PERSONA_API_NAME_FIELD]: 'support', [PERSONA_ACTIVE_FIELD]: true },
      ],
    });
    query.onSecondCall().resolves({
      records: [
        {
          Id: 'c01',
          [COMPONENT_PERSONA_FIELD]: 'a01',
          [COMPONENT_TYPE_FIELD]: 'Permission Set',
          [COMPONENT_REFERENCE_FIELD]: 'Ops_Read',
        },
        {
          Id: 'c02',
          [COMPONENT_PERSONA_FIELD]: 'a01',
          [COMPONENT_TYPE_FIELD]: 'Queue',
          [COMPONENT_REFERENCE_FIELD]: 'Support_Queue',
        },
        {
          Id: 'c03',
          [COMPONENT_PERSONA_FIELD]: 'a02',
          [COMPONENT_TYPE_FIELD]: 'Public Group',
          [COMPONENT_REFERENCE_FIELD]: 'Support_Group',
        },
      ],
    });

    const result = await readOrgPersonas(connection({ query }));

    expect(result.count).to.equal(2);
    expect(result.document).to.deep.equal({
      personas: {
        ops: { permissionSets: ['Ops_Read'], permissionSetGroups: [], publicGroups: [], queues: ['Support_Queue'] },
        support: { permissionSets: [], permissionSetGroups: [], publicGroups: ['Support_Group'], queues: [] },
      },
    });
  });

  it('adds missing components and only prunes them when requested', async () => {
    const query = sinon.stub();
    query.onFirstCall().resolves({ records: [{ Id: 'a01', [PERSONA_API_NAME_FIELD]: 'ops' }] });
    query.onSecondCall().resolves({
      records: [
        {
          Id: 'c01',
          [COMPONENT_PERSONA_FIELD]: 'a01',
          [COMPONENT_TYPE_FIELD]: 'Permission Set',
          [COMPONENT_REFERENCE_FIELD]: 'Old',
        },
      ],
    });
    const upsert = sinon.stub().resolves({ success: true, id: 'a01' });
    const create = sinon.stub().resolves({ success: true, id: 'c02' });
    const remove = sinon.stub().resolves({ success: true, id: 'c01' });
    const personaSObject = { upsert };
    const componentSObject = { create, delete: remove };
    const sobject = sinon.stub();
    sobject.withArgs(PERSONA_OBJECT).returns(personaSObject);
    sobject.withArgs(PERSONA_COMPONENT_OBJECT).returns(componentSObject);

    const result = await importOrgPersonas(
      connection({ query, sobject }),
      { personas: { ops: { permissionSets: ['New'] } } },
      false
    );

    expect(result).to.deep.equal({ personas: 1, components: 1 });
    expect(
      create.calledOnceWithExactly([
        {
          [COMPONENT_PERSONA_FIELD]: 'a01',
          [COMPONENT_TYPE_FIELD]: 'Permission Set',
          [COMPONENT_REFERENCE_FIELD]: 'New',
        },
      ])
    ).to.equal(true);
    expect(remove.notCalled).to.equal(true);

    query.resetHistory();
    query.onFirstCall().resolves({ records: [{ Id: 'a01', [PERSONA_API_NAME_FIELD]: 'ops' }] });
    query.onSecondCall().resolves({
      records: [
        {
          Id: 'c01',
          [COMPONENT_PERSONA_FIELD]: 'a01',
          [COMPONENT_TYPE_FIELD]: 'Permission Set',
          [COMPONENT_REFERENCE_FIELD]: 'Old',
        },
      ],
    });
    await importOrgPersonas(connection({ query, sobject }), { personas: { ops: { permissionSets: ['New'] } } }, true);
    expect(remove.calledOnceWithExactly(['c01'])).to.equal(true);
  });

  it('sets a deterministic standard Name when creating a new persona', async () => {
    const query = sinon.stub();
    query.onFirstCall().resolves({ records: [{ Id: 'a-new', [PERSONA_API_NAME_FIELD]: 'new' }] });
    query.onSecondCall().resolves({ records: [] });
    const upsert = sinon.stub().resolves({ success: true, id: 'a-new' });
    const sobject = sinon.stub().withArgs(PERSONA_OBJECT).returns({ upsert });

    await importOrgPersonas(connection({ query, sobject }), { personas: { new: {} } });

    expect(
      upsert.calledOnceWithExactly(
        [{ [PERSONA_NAME_FIELD]: 'new', [PERSONA_API_NAME_FIELD]: 'new', [PERSONA_ACTIVE_FIELD]: true }],
        PERSONA_API_NAME_FIELD
      )
    ).to.equal(true);
  });

  it('batches large persona imports across queries and collection writes', async () => {
    const names = Array.from({ length: 201 }, (_, index) => `persona-${index}`);
    const personaRecords = names.map((name, index) => ({ Id: `a${index}`, [PERSONA_API_NAME_FIELD]: name }));
    const query = sinon.stub().callsFake(async (soql: string) => {
      if (soql.includes(PERSONA_API_NAME_FIELD)) return { records: personaRecords };
      return { records: [] };
    });
    const upsert = sinon
      .stub()
      .callsFake(async (records: unknown[]) => records.map((_, index) => ({ success: true, id: `a${index}` })));
    const create = sinon
      .stub()
      .callsFake(async (records: unknown[]) => records.map((_, index) => ({ success: true, id: `c${index}` })));
    const personaSObject = { upsert };
    const componentSObject = { create, delete: sinon.stub() };
    const sobject = sinon.stub();
    sobject.withArgs(PERSONA_OBJECT).returns(personaSObject);
    sobject.withArgs(PERSONA_COMPONENT_OBJECT).returns(componentSObject);

    const result = await importOrgPersonas(connection({ query, sobject }), {
      personas: Object.fromEntries(names.map((name) => [name, { permissionSets: [`${name}-read`] }])),
    });

    expect(result).to.deep.equal({ personas: 201, components: 201 });
    expect(upsert.callCount).to.equal(2);
    expect(upsert.getCall(0).args[0]).to.have.length(200);
    expect(upsert.getCall(1).args[0]).to.have.length(1);
    expect(create.getCall(0).args[0]).to.have.length(200);
    expect(create.getCall(1).args[0]).to.have.length(1);
    expect(query.getCalls().map((call) => (call.args[0] as string).match(/'[^']*'/g)?.length)).to.deep.equal([
      200, 1, 200, 1,
    ]);
  });

  it('batches pruned component deletes', async () => {
    const names = Array.from({ length: 201 }, (_, index) => `persona-${index}`);
    const personaRecords = names.map((name, index) => ({ Id: `a${index}`, [PERSONA_API_NAME_FIELD]: name }));
    const existingComponents = names.map((name, index) => ({
      Id: `c${index}`,
      [COMPONENT_PERSONA_FIELD]: `a${index}`,
      [COMPONENT_TYPE_FIELD]: 'Permission Set',
      [COMPONENT_REFERENCE_FIELD]: `${name}-old`,
    }));
    let componentQuery = 0;
    const query = sinon.stub().callsFake(async (soql: string) => {
      if (soql.includes(PERSONA_API_NAME_FIELD)) return { records: personaRecords };
      const start = componentQuery++ === 0 ? 0 : 200;
      return { records: existingComponents.slice(start, start + 200) };
    });
    const upsert = sinon
      .stub()
      .callsFake(async (records: unknown[]) => records.map((_, index) => ({ success: true, id: `a${index}` })));
    const remove = sinon.stub().callsFake(async (ids: string[]) => ids.map((id) => ({ success: true, id })));
    const sobject = sinon.stub();
    sobject.withArgs(PERSONA_OBJECT).returns({ upsert });
    sobject.withArgs(PERSONA_COMPONENT_OBJECT).returns({ create: sinon.stub(), delete: remove });

    const result = await importOrgPersonas(
      connection({ query, sobject }),
      { personas: Object.fromEntries(names.map((name) => [name, {}])) },
      true
    );

    expect(result).to.deep.equal({ personas: 201, components: 0, prunedComponents: 201 });
    expect(remove.getCall(0).args[0]).to.have.length(200);
    expect(remove.getCall(1).args[0]).to.have.length(1);
  });

  it('fails when a later parent upsert batch returns an error', async () => {
    const names = Array.from({ length: 201 }, (_, index) => `persona-${index}`);
    const query = sinon.stub();
    const upsert = sinon.stub();
    upsert
      .onFirstCall()
      .callsFake(async (records: unknown[]) => records.map((_, index) => ({ success: true, id: `a${index}` })));
    upsert.onSecondCall().resolves({ success: false, errors: [{ message: 'second batch failed' }] });
    const sobject = sinon.stub().withArgs(PERSONA_OBJECT).returns({ upsert });

    let error: unknown;
    try {
      await importOrgPersonas(connection({ query, sobject }), {
        personas: Object.fromEntries(names.map((name) => [name, {}])),
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).to.be.instanceOf(Error);
    expect((error as Error).message).to.include('second batch failed');
    expect(upsert.callCount).to.equal(2);
    expect(query.notCalled).to.equal(true);
  });

  it('classifies added, removed, and changed persona definitions', () => {
    const result = diffPersonaDocuments(
      { personas: { ops: { permissionSets: ['New'] }, added: {} } },
      { personas: { ops: { permissionSets: ['Old'] }, removed: {} } }
    );
    expect(result.added).to.deep.equal(['added']);
    expect(result.removed).to.deep.equal(['removed']);
    expect(result.changed.map(({ name }) => name)).to.deep.equal(['ops']);
  });

  it('treats omitted persona lists as empty when comparing with org personas', () => {
    const result = diffPersonaDocuments(
      { personas: { ops: { permissionSets: ['B', 'A'] } } },
      { personas: { ops: { permissionSets: ['A', 'B'], permissionSetGroups: [], publicGroups: [], queues: [] } } }
    );
    expect(result).to.deep.equal({ added: [], removed: [], changed: [] });
  });
});
