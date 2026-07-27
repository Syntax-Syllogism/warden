import type { Connection } from '@salesforce/core';
import { buildFieldMap, type UserFieldMeta } from '../userProvisioning/planner.js';

/** Describe the User sObject and project it into the field map callers need. */
export const describeUserFields = async (conn: Connection): Promise<Map<string, UserFieldMeta>> => {
  const userDescribe = await conn.describe('User');
  return buildFieldMap(
    userDescribe.fields.map(
      (field): UserFieldMeta => ({
        name: field.name,
        createable: field.createable,
        updateable: field.updateable,
        filterable: field.filterable,
        externalId: field.externalId,
        isBoolean: field.type === 'boolean',
      })
    )
  );
};
