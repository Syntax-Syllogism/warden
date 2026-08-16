import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SfError } from '@salesforce/core';
import { expect } from 'chai';
import sinon from 'sinon';
import { buildFieldMap } from '../../src/userProvisioning/planner.js';
import {
  buildTargetRequests,
  extractDefTargets,
  parseUserFlag,
  resolveTargetField,
  resolveTargets,
} from '../../src/userLifecycle/targeting.js';

describe('userLifecycle targeting', () => {
  const fieldMap = buildFieldMap([
    { name: 'Username', createable: true, updateable: true, filterable: true, externalId: true },
    { name: 'FederationIdentifier', createable: true, updateable: true, filterable: true, externalId: true },
    { name: 'Email', createable: true, updateable: true, filterable: true, externalId: true },
    { name: 'LastName', createable: true, updateable: true, filterable: true },
  ]);
  const messages = {
    invalidUserMatchField: (field: string) => `invalid match field: ${field}`,
    invalidJson: (path: string, error: string) => `invalid JSON in ${path}: ${error}`,
  };
  const writeDefinition = (extension: string, contents: string): string => {
    const directory = mkdtempSync(join(tmpdir(), 'warden-targeting-'));
    const path = join(directory, `users.${extension}`);
    writeFileSync(path, contents);
    return path;
  };

  it('builds a target request from --user', async () => {
    const result = await buildTargetRequests({ user: 'username:alice@example.com' }, fieldMap, messages);
    expect(result).to.deep.equal({
      requests: [{ key: 'Username:alice@example.com', field: 'Username', value: 'alice@example.com', order: 0 }],
      errors: [],
    });
  });

  it('throws an SfError for an invalid --user match field', async () => {
    try {
      await buildTargetRequests({ user: 'missing:value' }, fieldMap, messages);
      throw new Error('expected buildTargetRequests to reject');
    } catch (error) {
      expect(error).to.be.instanceOf(SfError);
      expect((error as SfError).message).to.equal('invalid match field: missing');
    }
  });

  it('builds target requests from a JSON users definition', async () => {
    const path = writeDefinition(
      'json',
      JSON.stringify({ users: [{ match: 'Username', Username: 'alice@example.com' }] })
    );
    const result = await buildTargetRequests({ 'users-def': path }, fieldMap, messages);
    expect(result).to.deep.equal({
      requests: [{ key: 'Username:alice@example.com', field: 'Username', value: 'alice@example.com', order: 0 }],
      errors: [],
    });
  });

  it('builds target requests from a CSV users definition', async () => {
    const path = writeDefinition('csv', 'FederationIdentifier\nA001\n');
    const result = await buildTargetRequests(
      { 'users-def': path, 'external-id': 'FederationIdentifier', 'input-format': 'csv' },
      fieldMap,
      messages
    );
    expect(result.requests).to.deep.equal([
      {
        key: 'FederationIdentifier:A001',
        field: 'FederationIdentifier',
        value: 'A001',
        order: 0,
        source: { path, line: 2 },
      },
    ]);
    expect(result.errors).to.deep.equal([]);
  });

  it('collects users-definition entry errors instead of throwing', async () => {
    const path = writeDefinition(
      'json',
      JSON.stringify({ users: [{ match: 'MissingField', MissingField: 'x' }, { match: 'Username' }] })
    );
    const result = await buildTargetRequests(
      { 'users-def': path, 'external-id': 'FederationIdentifier' },
      fieldMap,
      messages
    );
    expect(result.requests).to.deep.equal([]);
    expect(result.errors).to.have.length(2);
    expect(result.errors.map((error) => error.message).join(' ')).to.include('MissingField');
    expect(result.errors.map((error) => error.message).join(' ')).to.include('must be populated');
  });

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
          records: [
            {
              Id: '005000000000001AAA',
              IsActive: true,
              Name: 'Alice Park',
              Username: 'alice@example.com',
              Email: 'alice@example.com',
              ProfileId: '00eProfile',
              Profile: { Name: 'Standard User' },
              UserRoleId: '00eRole',
              UserRole: { Name: 'Support' },
            },
          ],
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

    const result = await resolveTargets(
      { query } as never,
      [
        { key: 'Username:alice@example.com', field: 'Username', value: 'alice@example.com', order: 0 },
        { key: 'FederationIdentifier:dup', field: 'FederationIdentifier', value: 'dup', order: 1 },
        { key: 'Email:missing@example.com', field: 'Email', value: 'missing@example.com', order: 2 },
      ],
      fieldMap
    );

    expect(result.targets).to.have.length(1);
    expect(result.targets[0]).to.include({
      key: 'Username:alice@example.com',
      Id: '005000000000001AAA',
      IsActive: true,
      name: 'Alice Park',
      username: 'alice@example.com',
      email: 'alice@example.com',
      profile: 'Standard User',
      role: 'Support',
    });
    expect(result.errors).to.have.length(2);
    expect(result.errors.map((error) => error.message).join(' ')).to.include('matched multiple users');
    expect(result.errors.map((error) => error.message).join(' ')).to.include('matched no user');
    expect(query.callCount).to.equal(3);
  });

  it('resolves Id targets without selecting Id twice', async () => {
    const query = sinon.stub().resolves({ records: [{ Id: '005000000000001AAA', IsActive: true }] });
    const result = await resolveTargets(
      { query } as never,
      [{ key: 'Id:005000000000001AAA', field: 'Id', value: '005000000000001AAA', order: 0 }],
      fieldMap
    );

    expect(query.firstCall.args[0]).to.equal(
      "SELECT Id, IsActive, Name, Username, Email, ProfileId, Profile.Name, UserRoleId, UserRole.Name FROM User WHERE Id IN ('005000000000001AAA')"
    );
    expect(result.targets).to.have.length(1);
    expect(result.targets[0].Id).to.equal('005000000000001AAA');
  });

  it('uses relationship Ids when profile and role names are unavailable', async () => {
    const query = sinon.stub().resolves({
      records: [
        {
          Id: '005000000000001AAA',
          IsActive: true,
          ProfileId: '00eProfile',
          Profile: null,
          UserRoleId: '00eRole',
          UserRole: null,
        },
      ],
    });
    const result = await resolveTargets(
      { query } as never,
      [{ key: 'Id:005000000000001AAA', field: 'Id', value: '005000000000001AAA', order: 0 }],
      fieldMap
    );

    expect(result.targets[0]).to.include({ profile: '00eProfile', role: '00eRole' });
  });
});
