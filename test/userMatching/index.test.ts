import { expect } from 'chai';
import sinon from 'sinon';
import { escapeSoqlLike, resolveExistingUsers, validateMatchField } from '../../src/userMatching/index.js';
import { buildFieldMap } from '../../src/userProvisioning/planner.js';
import { getExistingUsers } from '../../src/userProvisioning/provisionUserUseCase.js';

describe('user matching', () => {
  const fieldMap = buildFieldMap([
    { name: 'Name', createable: true, updateable: true, filterable: true },
    { name: 'Username', createable: true, updateable: true, filterable: true },
    { name: 'LastName', createable: true, updateable: true, filterable: true },
    { name: 'Title', createable: true, updateable: true, filterable: false },
  ]);

  it('accepts filterable fields and rejects non-filterable fields', () => {
    expect(validateMatchField('LastName', fieldMap).name).to.equal('LastName');
    expect(() => validateMatchField('Title', fieldMap)).to.throw('Invalid match field');
  });

  it('escapes SOQL LIKE wildcards and escape characters', () => {
    expect(escapeSoqlLike(String.raw`foo_%\bar`)).to.equal(String.raw`foo\_\%\\\\bar`);
  });

  it('maps fuzzy sandbox usernames to their base and marks ambiguous matches', async () => {
    const query = sinon.stub().resolves({
      records: [
        { Id: '005000000000001AAA', IsActive: true, Name: 'Foo User', Username: 'Foo@Bar.com.sbx' },
        { Id: '005000000000002AAA', IsActive: true, Name: 'Duplicate One', Username: 'dup@bar.com.one' },
        { Id: '005000000000003AAA', IsActive: true, Name: 'Duplicate Two', Username: 'dup@bar.com.two' },
      ],
    });
    const result = await resolveExistingUsers(
      { query } as never,
      [
        { field: 'Username', value: 'foo@bar.com', fuzzy: true },
        { field: 'Username', value: 'dup@bar.com', fuzzy: true },
      ],
      fieldMap
    );

    expect(result.existingByField.get('Username')?.get('foo@bar.com')?.Id).to.equal('005000000000001AAA');
    expect(result.existingByField.get('Username')?.get('foo@bar.com')?.Name).to.equal('Foo User');
    expect(result.duplicates.has('Username:dup@bar.com')).to.equal(true);
    expect(query.firstCall.args[0]).to.include("Username LIKE 'foo@bar.com.%'");
    expect(query.firstCall.args[0]).to.include('SELECT Id, IsActive, Name, Username FROM User');
  });

  it('keeps exact matching grouped and preserves duplicate detection', async () => {
    const query = sinon.stub().resolves({
      records: [
        { Id: '005000000000001AAA', IsActive: true, LastName: 'Unique' },
        { Id: '005000000000002AAA', IsActive: true, LastName: 'Duplicate' },
        { Id: '005000000000003AAA', IsActive: false, LastName: 'Duplicate' },
      ],
    });
    const result = await resolveExistingUsers(
      { query } as never,
      [
        { field: 'LastName', value: 'Unique' },
        { field: 'LastName', value: 'Duplicate' },
      ],
      fieldMap
    );

    expect(query.callCount).to.equal(1);
    expect(result.existingByField.get('LastName')?.get('Unique')?.Id).to.equal('005000000000001AAA');
    expect(result.duplicates.has('LastName:Duplicate')).to.equal(true);
  });

  it('uses the per-user fuzzy value over the global default even when exact is slower', async () => {
    const query = sinon.stub().callsFake((soql: string) => {
      if (soql.includes('LIKE')) {
        return Promise.resolve({
          records: [{ Id: '005000000000001AAA', IsActive: true, Username: 'foo@bar.com.sbx' }],
        });
      }
      return new Promise((resolve) =>
        setTimeout(
          () => resolve({ records: [{ Id: '005000000000002AAA', IsActive: true, Username: 'bar@bar.com' }] }),
          25
        )
      );
    });
    const result = await getExistingUsers(
      { query } as never,
      [
        { matchField: 'Username', fuzzyUsername: undefined, fields: { Username: 'foo@bar.com' } },
        { matchField: 'Username', fuzzyUsername: false, fields: { Username: 'bar@bar.com' } },
      ] as never,
      { defaultFuzzyUsername: true, fieldMap }
    );

    expect(query.callCount).to.equal(2);
    expect(result.existingByField.get('Username')?.get('foo@bar.com')?.Id).to.equal('005000000000001AAA');
    expect(result.existingByField.get('Username')?.get('bar@bar.com')?.Id).to.equal('005000000000002AAA');
  });

  it('splits long exact-match queries below the SOQL length budget', async () => {
    const query = sinon.stub().resolves({ records: [] });
    const requests = Array.from({ length: 100 }, (_, index) => ({
      field: 'LastName',
      value: `${String(index).padStart(3, '0')}-${'x'.repeat(300)}`,
    }));

    await resolveExistingUsers({ query } as never, requests, fieldMap);

    expect(query.callCount).to.be.greaterThan(1);
    expect(query.args.every(([soql]) => (soql as string).length <= 18_000)).to.equal(true);
  });

  it('deduplicates identity fields when matching by Name or Username', async () => {
    const query = sinon.stub().resolves({ records: [{ Id: '005000000000001AAA', IsActive: true, Name: 'Alice' }] });
    await resolveExistingUsers(
      { query } as never,
      [
        { field: 'Name', value: 'Alice' },
        { field: 'Username', value: 'alice@example.com' },
      ],
      fieldMap
    );

    expect(query.firstCall.args[0]).to.equal("SELECT Id, IsActive, Name, Username FROM User WHERE Name IN ('Alice')");
    expect(query.secondCall.args[0]).to.equal(
      "SELECT Id, IsActive, Name, Username FROM User WHERE Username IN ('alice@example.com')"
    );
  });
});
