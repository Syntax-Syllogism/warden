import { expect } from 'chai';
import sinon from 'sinon';
import {
  validateFieldTarget,
  validateObjectTarget,
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

});
