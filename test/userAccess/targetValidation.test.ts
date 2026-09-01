import { expect } from 'chai';
import sinon from 'sinon';
import {
  validateFieldTarget,
  validateObjectTarget,
  validateRecordTypeTarget,
} from '../../src/userAccess/targetValidation.js';
import { UserAccessError } from '../../src/userAccess/types.js';

describe('userAccess target validation', () => {
  it('accepts qualified field target and canonicalizes field casing', async () => {
    const conn = {
      describe: sinon.stub().resolves({ name: 'Account', fields: [{ name: 'CustomField__c' }] }),
    };
    const result = await validateFieldTarget(conn as never, 'Account.customfield__c');
    expect(result.targetName).to.equal('Account.CustomField__c');
    expect(result.sobjectType).to.equal('Account');
    expect(result.fieldApiName).to.equal('CustomField__c');
  });

  it('accepts namespaced field target', async () => {
    const conn = {
      describe: sinon.stub().resolves({ name: 'ns__Object__c', fields: [{ name: 'ns__Field__c' }] }),
    };
    const result = await validateFieldTarget(conn as never, 'ns__Object__c.ns__Field__c');
    expect(result.targetName).to.equal('ns__Object__c.ns__Field__c');
  });

  it('rejects unqualified field target', async () => {
    const conn = { describe: sinon.stub() };
    let caught: unknown;
    try {
      await validateFieldTarget(conn as never, 'CustomField__c');
    } catch (error) {
      caught = error;
    }
    expect(caught).to.be.instanceOf(UserAccessError);
  });

  it('rejects empty field segments', async () => {
    const conn = { describe: sinon.stub() };
    let caught: unknown;
    try {
      await validateFieldTarget(conn as never, 'Account.');
    } catch (error) {
      caught = error;
    }
    expect(caught).to.be.instanceOf(UserAccessError);
  });

  it('validates and canonicalizes object targets', async () => {
    const conn = {
      describe: sinon.stub().resolves({ name: 'Account', fields: [] }),
    };
    const result = await validateObjectTarget(conn as never, 'account');
    expect(result.targetName).to.equal('Account');
    expect(result.sobjectType).to.equal('Account');
  });

  it('throws actionable error for missing field', async () => {
    const conn = {
      describe: sinon.stub().resolves({ name: 'Account', fields: [{ name: 'Name' }] }),
    };
    let caught: unknown;
    try {
      await validateFieldTarget(conn as never, 'Account.DoesNotExist__c');
    } catch (error) {
      caught = error;
    }
    expect((caught as UserAccessError).code).to.equal('errorFieldNotFound');
  });

  it('throws object not found when describe fails', async () => {
    const conn = {
      describe: sinon.stub().rejects(new Error('not found')),
    };
    let caught: unknown;
    try {
      await validateObjectTarget(conn as never, 'MissingObject__c');
    } catch (error) {
      caught = error;
    }
    expect((caught as UserAccessError).code).to.equal('errorObjectNotFound');
  });

  it('validates and canonicalizes an active qualified record type', async () => {
    const conn = {
      query: sinon.stub().resolves({
        done: true,
        records: [{ Id: '0121', SobjectType: 'Account', DeveloperName: 'Business_Account', IsActive: true }],
      }),
    };
    const result = await validateRecordTypeTarget(conn as never, 'account.business_account');
    expect(result.targetName).to.equal('Account.Business_Account');
    expect(result.sobjectType).to.equal('Account');
    expect(result.recordTypeId).to.equal('0121');
    expect(conn.query.firstCall.args[0]).to.include("SobjectType = 'account'");
  });

  it('rejects invalid, master, missing, ambiguous, and inactive record types', async () => {
    const conn = { query: sinon.stub() };
    for (const target of ['Account', '012000000000000AAA', 'Account.', 'Account.One.Two']) {
      let caught: unknown;
      try {
        // eslint-disable-next-line no-await-in-loop
        await validateRecordTypeTarget(conn as never, target);
      } catch (error) {
        caught = error;
      }
      expect((caught as UserAccessError).code).to.equal('errorRecordTypeTargetMustBeQualified');
    }
    let caught: unknown;
    try {
      await validateRecordTypeTarget(conn as never, 'Account.Master');
    } catch (error) {
      caught = error;
    }
    expect((caught as UserAccessError).code).to.equal('errorMasterRecordTypeUnsupported');

    for (const records of [
      [],
      [{ Id: '0121', SobjectType: 'Account', DeveloperName: 'Inactive', IsActive: false }],
      [
        { Id: '0121', SobjectType: 'Account', DeveloperName: 'Duplicate', IsActive: true },
        { Id: '0122', SobjectType: 'Account', DeveloperName: 'Duplicate', IsActive: true },
      ],
    ]) {
      conn.query.resolves({ done: true, records });
      try {
        // eslint-disable-next-line no-await-in-loop
        await validateRecordTypeTarget(
          conn as never,
          `Account.${records.length === 0 ? 'Missing' : records.length === 1 ? 'Inactive' : 'Duplicate'}`
        );
      } catch (error) {
        caught = error;
      }
      expect((caught as UserAccessError).code).to.equal(
        records.length === 1
          ? 'errorRecordTypeInactive'
          : records.length === 0
          ? 'errorRecordTypeNotFound'
          : 'errorRecordTypeAmbiguous'
      );
    }
  });
});
