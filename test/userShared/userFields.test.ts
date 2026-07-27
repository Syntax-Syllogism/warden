import type { Connection } from '@salesforce/core';
import { expect } from 'chai';
import { describeUserFields } from '../../src/userShared/userFields.js';

describe('describeUserFields', () => {
  it('lowercases field-map keys and records boolean metadata', async () => {
    let describeCalls = 0;
    const connection = {
      describe: async (name: string) => {
        describeCalls += 1;
        expect(name).to.equal('User');
        return {
          fields: [
            {
              name: 'IsActive',
              createable: false,
              updateable: true,
              filterable: true,
              externalId: false,
              type: 'boolean',
            },
            {
              name: 'FederationIdentifier',
              createable: true,
              updateable: true,
              filterable: true,
              externalId: true,
              type: 'string',
            },
          ],
        };
      },
    } as unknown as Connection;

    const fieldMap = await describeUserFields(connection);

    expect(describeCalls).to.equal(1);
    expect(fieldMap.get('isactive')).to.deep.equal({
      name: 'IsActive',
      createable: false,
      updateable: true,
      filterable: true,
      externalId: false,
      isBoolean: true,
    });
    expect(fieldMap.get('federationidentifier')?.isBoolean).to.equal(false);
  });
});
