import { expect } from 'chai';
import sinon from 'sinon';
import { buildFieldMap } from '../../src/userProvisioning/planner.js';
import {
  extractDefTargets,
  parseUserFlag,
  resolveTargetField,
  resolveTargets,
} from '../../src/userLifecycle/targeting.js';

describe('userLifecycle targeting', () => {
  const fieldMap = buildFieldMap([
    { name: 'Username', createable: true, updateable: true, externalId: true },
    { name: 'FederationIdentifier', createable: true, updateable: true, externalId: true },
    { name: 'Email', createable: true, updateable: true, externalId: true },
    { name: 'LastName', createable: true, updateable: true },
  ]);

  it('parses --user values on the first colon only', () => {
    expect(parseUserFlag('username:alice@example.com:extra')).to.deep.equal({
      field: 'username',
      value: 'alice@example.com:extra',
    });
  });

  it('canonicalizes target fields case-insensitively and supports Id', () => {
    expect(resolveTargetField('federationidentifier', fieldMap)).to.equal('FederationIdentifier');
    expect(resolveTargetField('Id', fieldMap)).to.equal('Id');
    expect(resolveTargetField('missing', fieldMap)).to.equal(undefined);
  });

  it('extracts match requests from a users-def document and reports missing match fields', () => {
    const { requests, errors } = extractDefTargets(
      {
        users: [{ match: 'username', username: 'alice@example.com' }, { federationidentifier: 'A001' }],
      },
      undefined,
      fieldMap
    );
    expect(requests).to.deep.equal([
      { key: 'Username:alice@example.com', field: 'Username', value: 'alice@example.com', order: 0 },
    ]);
    expect(errors).to.have.length(1);
    expect(errors[0].message).to.include('match field');
  });

  it('resolves targets with grouped queries and surfaces ambiguous and missing matches', async () => {
    const query = sinon.stub().callsFake(async (soql: string) => {
      if (soql.includes("FROM User WHERE Username IN ('alice@example.com')")) {
        return {
          records: [{ Id: '005000000000001AAA', IsActive: true, Username: 'alice@example.com' }],
        };
      }
      if (soql.includes("FROM User WHERE FederationIdentifier IN ('dup')")) {
        return {
          records: [
            { Id: '005000000000002AAA', IsActive: true, FederationIdentifier: 'dup' },
            { Id: '005000000000003AAA', IsActive: false, FederationIdentifier: 'dup' },
          ],
        };
      }
      if (soql.includes("FROM User WHERE Email IN ('missing@example.com')")) {
        return { records: [] };
      }
      return { records: [] };
    });

    const result = await resolveTargets({ query } as never, [
      { key: 'Username:alice@example.com', field: 'Username', value: 'alice@example.com', order: 0 },
      { key: 'FederationIdentifier:dup', field: 'FederationIdentifier', value: 'dup', order: 1 },
      { key: 'Email:missing@example.com', field: 'Email', value: 'missing@example.com', order: 2 },
    ]);

    expect(result.targets).to.have.length(1);
    expect(result.targets[0]).to.include({
      key: 'Username:alice@example.com',
      Id: '005000000000001AAA',
      IsActive: true,
    });
    expect(result.errors).to.have.length(2);
    expect(result.errors.map((error) => error.message).join(' ')).to.include('matched multiple users');
    expect(result.errors.map((error) => error.message).join(' ')).to.include('matched no user');
    expect(query.callCount).to.equal(3);
  });
});
