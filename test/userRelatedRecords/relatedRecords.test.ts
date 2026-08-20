/* eslint-disable camelcase -- Salesforce API field names are intentional fixture keys. */
import { SfError } from '@salesforce/core';
import { expect } from 'chai';
import sinon from 'sinon';
import { applyRelatedPhase } from '../../src/userRelatedRecords/apply.js';
import { assertValidRelatedCatalog } from '../../src/userRelatedRecords/catalog.js';
import { buildRelatedPlans } from '../../src/userRelatedRecords/plan.js';
import { runRelatedPreflight } from '../../src/userRelatedRecords/preflight.js';
import { resolveSource } from '../../src/userRelatedRecords/sources.js';
import type { RelatedCatalog, RelatedRecordPlan } from '../../src/userRelatedRecords/types.js';
import { renderProvisionCsv } from '../../src/userShared/output.js';
import type { CanonicalizedUser, UserFieldMeta } from '../../src/userProvisioning/planner.js';

const message = (key: string, args?: string[]): string => [key, ...(args ?? [])].join(':');

const userFieldMap = new Map<string, UserFieldMeta>([
  ['federationidentifier', { name: 'FederationIdentifier', createable: true, updateable: true, filterable: true }],
  ['department', { name: 'Department', createable: true, updateable: true, filterable: true }],
]);

const employeeCatalog: RelatedCatalog = {
  relationships: {
    employee: {
      sobject: 'Employee__c',
      phase: 'after',
      match: { field: 'External_Id__c', from: 'user.FederationIdentifier' },
      fields: {
        Department__c: { from: 'user.Department' },
        User__c: { from: 'user.Id' },
      },
    },
  },
};

const canonicalUser = (fields: Record<string, unknown>): CanonicalizedUser => ({
  inputKey: 'FederationIdentifier:EMP-1',
  personas: [],
  effectivePersona: {},
  fields,
  related: ['employee'],
});

describe('related record provisioning', () => {
  it('rejects v2-only and malformed catalog sources', () => {
    expect(() =>
      assertValidRelatedCatalog(
        {
          relationships: {
            employee: {
              sobject: 'Employee__c',
              phase: 'before',
              match: { field: 'External_Id__c', from: 'user.FederationIdentifier' },
              fields: { User__c: { from: 'user.Id' } },
            },
          },
        },
        userFieldMap,
        message
      )
    ).to.throw(SfError, 'errorPhaseBeforeUnsupported');
    expect(() =>
      assertValidRelatedCatalog(
        {
          relationships: {
            employee: {
              sobject: 'Employee__c',
              phase: 'after',
              match: { field: 'External_Id__c', from: 'user.Id' },
              fields: { User__c: { from: 'user.Id', value: 'also-invalid' } },
            },
          },
        },
        userFieldMap,
        message
      )
    ).to.throw(SfError, 'errorRelationshipMatchFromUserId');
  });

  it('resolves falsy values while treating only nullish and empty values as absent', () => {
    const fieldMap = new Map<string, UserFieldMeta>([
      ['enabled__c', { name: 'Enabled__c', createable: true, updateable: true, filterable: true }],
      ['rank__c', { name: 'Rank__c', createable: true, updateable: true, filterable: true }],
    ]);
    const context = {
      relationship: 'employee',
      fieldName: 'value',
      userFields: { Enabled__c: false, Rank__c: 0, Empty__c: '' },
      userFieldMap: fieldMap,
    };

    expect(resolveSource({ from: 'user.Enabled__c' }, context)).to.deep.equal({ value: false });
    expect(resolveSource({ from: 'user.Rank__c' }, context)).to.deep.equal({ value: 0 });
    expect(resolveSource({ from: 'user.Id' }, context)).to.deep.equal({ pending: true });
    expect(resolveSource({ from: 'user.Empty__c' }, context).error?.messageKey).to.equal('errorRelatedSourceEmpty');
  });

  it('plans a create with the match field and defers user.Id until after save', async () => {
    const query = sinon.stub().resolves({ records: [] });
    const preflight = {
      eligible: new Set(['employee']),
      ineligible: new Map<string, string>(),
      warnings: [],
      fieldsBySobject: new Map([
        [
          'employee__c',
          new Map([
            ['external_id__c', { name: 'External_Id__c', createable: true, updateable: true, filterable: true }],
            ['department__c', { name: 'Department__c', createable: true, updateable: true, filterable: true }],
            ['user__c', { name: 'User__c', createable: true, updateable: true, filterable: true }],
          ]),
        ],
      ]),
      recordTypeIdByRelationship: new Map<string, string>(),
    };
    const plans = await buildRelatedPlans({
      conn: { query } as never,
      users: [{ order: 0, user: canonicalUser({ FederationIdentifier: 'EMP-1', Department: 'Operations' }) }],
      catalog: employeeCatalog,
      preflight,
      userFieldMap,
      message,
    });
    const plan = plans.get(0)?.[0];

    expect(query.calledOnce).to.equal(true);
    expect(plan).to.deep.include({ status: 'planned', matchValue: 'EMP-1' });
    expect(plan?.fields).to.deep.equal({ Department__c: 'Operations', External_Id__c: 'EMP-1' });
    expect(plan?.pendingUserIdFields).to.deep.equal(['User__c']);
  });

  it('selects every configured field when relationships share an sObject and match field', async () => {
    const query = sinon.stub().resolves({
      records: [{ Id: 'a01000000000001AAA', External_Id__c: 'EMP-1', Department__c: null, Title__c: null }],
    });
    const catalog: RelatedCatalog = {
      relationships: {
        department: {
          ...employeeCatalog.relationships.employee,
          fields: { Department__c: { from: 'user.Department' } },
        },
        title: { ...employeeCatalog.relationships.employee, fields: { Title__c: { value: 'Manager' } } },
      },
    };
    const preflight = {
      eligible: new Set(['department', 'title']),
      ineligible: new Map<string, string>(),
      warnings: [],
      fieldsBySobject: new Map([
        [
          'employee__c',
          new Map([
            ['external_id__c', { name: 'External_Id__c', createable: true, updateable: true, filterable: true }],
            ['department__c', { name: 'Department__c', createable: true, updateable: true, filterable: true }],
            ['title__c', { name: 'Title__c', createable: true, updateable: true, filterable: true }],
          ]),
        ],
      ]),
      recordTypeIdByRelationship: new Map<string, string>(),
    };
    const plans = await buildRelatedPlans({
      conn: { query } as never,
      users: [
        {
          order: 0,
          user: {
            ...canonicalUser({ FederationIdentifier: 'EMP-1', Department: 'Operations' }),
            related: ['department', 'title'],
          },
        },
      ],
      catalog,
      preflight,
      userFieldMap,
      message,
    });

    expect(query.firstCall.args[0]).to.include('Department__c, Title__c');
    expect(plans.get(0)?.map((plan) => plan.fields)).to.deep.equal([
      { Department__c: 'Operations' },
      { Title__c: 'Manager' },
    ]);
  });

  it('chunks long related-record match values by rendered SOQL length', async () => {
    const query = sinon.stub().resolves({ records: [] });
    const preflight = {
      eligible: new Set(['employee']),
      ineligible: new Map<string, string>(),
      warnings: [],
      fieldsBySobject: new Map([
        [
          'employee__c',
          new Map([
            ['external_id__c', { name: 'External_Id__c', createable: true, updateable: true, filterable: true }],
            ['department__c', { name: 'Department__c', createable: true, updateable: true, filterable: true }],
            ['user__c', { name: 'User__c', createable: true, updateable: true, filterable: true }],
          ]),
        ],
      ]),
      recordTypeIdByRelationship: new Map<string, string>(),
    };
    const users = Array.from({ length: 100 }, (_, index) => ({
      order: index,
      user: canonicalUser({ FederationIdentifier: `EMP-${index}-${'x'.repeat(250)}`, Department: 'Operations' }),
    }));

    await buildRelatedPlans({
      conn: { query } as never,
      users,
      catalog: employeeCatalog,
      preflight,
      userFieldMap,
      message,
    });

    expect(query.callCount).to.be.greaterThan(1);
    expect(query.getCalls().map((call) => String(call.args[0]))).to.satisfy((queries: string[]) =>
      queries.every((queryText) => queryText.length <= 18_000)
    );
  });

  it('uses canonical target field names for lowercase catalog declarations', async () => {
    const query = sinon.stub().resolves({
      records: [{ Id: 'a01000000000001AAA', External_Id__c: 'EMP-1', Department__c: 'Existing' }],
    });
    const catalog: RelatedCatalog = {
      relationships: {
        employee: {
          ...employeeCatalog.relationships.employee,
          match: { field: 'external_id__c', from: 'user.FederationIdentifier' },
          fields: { department__c: { from: 'user.Department' } },
        },
      },
    };
    const preflight = {
      eligible: new Set(['employee']),
      ineligible: new Map<string, string>(),
      warnings: [],
      fieldsBySobject: new Map([
        [
          'employee__c',
          new Map([
            ['external_id__c', { name: 'External_Id__c', createable: true, updateable: true, filterable: true }],
            ['department__c', { name: 'Department__c', createable: true, updateable: true, filterable: true }],
          ]),
        ],
      ]),
      recordTypeIdByRelationship: new Map<string, string>(),
    };
    const plans = await buildRelatedPlans({
      conn: { query } as never,
      users: [
        { order: 0, user: canonicalUser({ FederationIdentifier: 'EMP-1', Department: 'Operations' }) },
        { order: 1, user: canonicalUser({ FederationIdentifier: 'EMP-2', Department: 'Sales' }) },
      ],
      catalog,
      preflight,
      userFieldMap,
      message,
    });

    expect(query.firstCall.args[0]).to.include('External_Id__c, Department__c');
    expect(plans.get(0)?.[0]).to.deep.include({
      status: 'planned',
      existingId: 'a01000000000001AAA',
      matchField: 'External_Id__c',
      fields: {},
    });
    expect(plans.get(1)?.[0]?.fields).to.deep.equal({ Department__c: 'Sales', External_Id__c: 'EMP-2' });
  });

  it('keeps case-sensitive Unique match values distinct', async () => {
    const query = sinon.stub().resolves({
      records: [
        { Id: 'a01000000000001AAA', External_Id__c: 'EMP-A', Department__c: null },
        { Id: 'a01000000000002AAA', External_Id__c: 'emp-a', Department__c: null },
      ],
    });
    const preflight = {
      eligible: new Set(['employee']),
      ineligible: new Map<string, string>(),
      warnings: [],
      fieldsBySobject: new Map([
        [
          'employee__c',
          new Map([
            [
              'external_id__c',
              {
                name: 'External_Id__c',
                createable: true,
                updateable: true,
                filterable: true,
                unique: true,
                caseSensitive: true,
              },
            ],
            ['department__c', { name: 'Department__c', createable: true, updateable: true, filterable: true }],
            ['user__c', { name: 'User__c', createable: true, updateable: true, filterable: true }],
          ]),
        ],
      ]),
      recordTypeIdByRelationship: new Map<string, string>(),
    };
    const plans = await buildRelatedPlans({
      conn: { query } as never,
      users: [
        { order: 0, user: canonicalUser({ FederationIdentifier: 'EMP-A', Department: 'Operations' }) },
        { order: 1, user: canonicalUser({ FederationIdentifier: 'emp-a', Department: 'Sales' }) },
      ],
      catalog: employeeCatalog,
      preflight,
      userFieldMap,
      message,
    });

    expect(plans.get(0)?.[0]).to.deep.include({ status: 'planned', existingId: 'a01000000000001AAA' });
    expect(plans.get(1)?.[0]).to.deep.include({ status: 'planned', existingId: 'a01000000000002AAA' });
  });

  it('matches case-insensitive Unique values without regard to letter case', async () => {
    const query = sinon.stub().resolves({
      records: [{ Id: 'a01000000000001AAA', External_Id__c: 'EMP-A', Department__c: null }],
    });
    const preflight = {
      eligible: new Set(['employee']),
      ineligible: new Map<string, string>(),
      warnings: [],
      fieldsBySobject: new Map([
        [
          'employee__c',
          new Map([
            [
              'external_id__c',
              {
                name: 'External_Id__c',
                createable: true,
                updateable: true,
                filterable: true,
                unique: true,
                caseSensitive: false,
              },
            ],
            ['department__c', { name: 'Department__c', createable: true, updateable: true, filterable: true }],
            ['user__c', { name: 'User__c', createable: true, updateable: true, filterable: true }],
          ]),
        ],
      ]),
      recordTypeIdByRelationship: new Map<string, string>(),
    };
    const plans = await buildRelatedPlans({
      conn: { query } as never,
      users: [{ order: 0, user: canonicalUser({ FederationIdentifier: 'emp-a', Department: 'Operations' }) }],
      catalog: employeeCatalog,
      preflight,
      userFieldMap,
      message,
    });

    expect(plans.get(0)?.[0]).to.deep.include({ status: 'planned', existingId: 'a01000000000001AAA' });
  });

  it('fails a matched record that lacks the configured record type', async () => {
    const query = sinon.stub().resolves({ records: [{ Id: 'a01000000000001AAA', External_Id__c: 'EMP-1' }] });
    const preflight = {
      eligible: new Set(['employee']),
      ineligible: new Map<string, string>(),
      warnings: [],
      fieldsBySobject: new Map([
        [
          'employee__c',
          new Map([
            ['external_id__c', { name: 'External_Id__c', createable: true, updateable: true, filterable: true }],
            ['department__c', { name: 'Department__c', createable: true, updateable: true, filterable: true }],
            ['user__c', { name: 'User__c', createable: true, updateable: true, filterable: true }],
          ]),
        ],
      ]),
      recordTypeIdByRelationship: new Map([['employee', '012000000000001AAA']]),
    };
    const plans = await buildRelatedPlans({
      conn: { query } as never,
      users: [{ order: 0, user: canonicalUser({ FederationIdentifier: 'EMP-1', Department: 'Operations' }) }],
      catalog: employeeCatalog,
      preflight,
      userFieldMap,
      message,
    });

    expect(plans.get(0)?.[0]).to.deep.include({ status: 'failed' });
    expect(plans.get(0)?.[0].errors.join(' ')).to.include('errorRelatedRecordTypeMismatch');
  });

  it('fails a planned update when a field remaining after setIfEmpty is not updateable', async () => {
    const query = sinon
      .stub()
      .resolves({ records: [{ Id: 'a01000000000001AAA', External_Id__c: 'EMP-1', Department__c: null }] });
    const preflight = {
      eligible: new Set(['employee']),
      ineligible: new Map<string, string>(),
      warnings: [],
      fieldsBySobject: new Map([
        [
          'employee__c',
          new Map([
            ['external_id__c', { name: 'External_Id__c', createable: true, updateable: true, filterable: true }],
            ['department__c', { name: 'Department__c', createable: true, updateable: false, filterable: true }],
            ['user__c', { name: 'User__c', createable: true, updateable: true, filterable: true }],
          ]),
        ],
      ]),
      recordTypeIdByRelationship: new Map<string, string>(),
    };
    const plans = await buildRelatedPlans({
      conn: { query } as never,
      users: [{ order: 0, user: canonicalUser({ FederationIdentifier: 'EMP-1', Department: 'Operations' }) }],
      catalog: employeeCatalog,
      preflight,
      userFieldMap,
      message,
    });

    expect(plans.get(0)?.[0]).to.deep.include({ status: 'failed' });
    expect(plans.get(0)?.[0].errors.join(' ')).to.include('errorRelatedFieldsNotWritableForOperation');
  });

  it('marks an unchanged setIfEmpty match without issuing an empty update', async () => {
    const update = sinon.stub();
    const results = await applyRelatedPhase(
      { sobject: sinon.stub().returns({ create: sinon.stub(), update }) } as never,
      [
        {
          planId: 'one',
          savedUserId: '005000000000001AAA',
          relatedPlans: [
            {
              relationship: 'employee',
              phase: 'after',
              sobject: 'Employee__c',
              matchField: 'External_Id__c',
              matchValue: 'EMP-1',
              existingId: 'a01000000000001AAA',
              fields: {},
              pendingUserIdFields: [],
              mode: 'setIfEmpty',
              status: 'planned',
              errors: [],
            },
          ],
        },
      ],
      'after'
    );

    expect(update.called).to.equal(false);
    expect(results.get('one')?.[0]).to.deep.include({ action: 'matched', status: 'applied' });
  });

  it('skips relationships whose describe explicitly denies field read access', async () => {
    const result = await runRelatedPreflight({
      conn: {
        describe: sinon.stub().resolves({
          queryable: true,
          fields: [
            {
              name: 'External_Id__c',
              createable: true,
              updateable: true,
              filterable: true,
              externalId: true,
              readable: false,
            },
            { name: 'Department__c', createable: true, updateable: true, filterable: true },
            { name: 'User__c', createable: true, updateable: true, filterable: true },
          ],
        }),
        query: sinon.stub().resolves({ records: [] }),
      } as never,
      catalog: employeeCatalog,
      selected: ['employee'],
      cache: new Map(),
      message,
    });

    expect(result.eligible.has('employee')).to.equal(false);
    expect(result.ineligible.get('employee')).to.include('errorRelatedFieldsNotReadable');
  });

  it('accepts Person Account record types and skips business Account record types', async () => {
    const accountFields = [
      { name: 'External_Id__c', createable: true, updateable: true, filterable: true, externalId: true },
      { name: 'Provisioned_User__c', createable: true, updateable: true, filterable: true },
    ];
    const accountCatalog = (developerName: string): RelatedCatalog => ({
      relationships: {
        account: {
          sobject: 'Account',
          phase: 'after',
          recordType: { developerName },
          match: { field: 'External_Id__c', from: 'user.FederationIdentifier' },
          fields: { Provisioned_User__c: { from: 'user.Id' } },
        },
      },
    });
    const conn = {
      describe: sinon.stub().resolves({
        queryable: true,
        fields: accountFields,
        recordTypeInfos: [
          { recordTypeId: '012person', available: true, isPersonType: true },
          { recordTypeId: '012business', available: true, isPersonType: false },
        ],
      }),
      query: sinon.stub().resolves({
        records: [
          { Id: '012person', DeveloperName: 'Person', SobjectType: 'PersonAccount', IsActive: true },
          { Id: '012business', DeveloperName: 'Business', SobjectType: 'Account', IsActive: true },
        ],
      }),
    };
    const person = await runRelatedPreflight({
      conn: conn as never,
      catalog: accountCatalog('Person'),
      selected: ['account'],
      cache: new Map(),
      message,
    });
    const business = await runRelatedPreflight({
      conn: conn as never,
      catalog: accountCatalog('Business'),
      selected: ['account'],
      cache: new Map(),
      message,
    });
    const missing = await runRelatedPreflight({
      conn: conn as never,
      catalog: {
        relationships: {
          account: {
            ...accountCatalog('Person').relationships.account,
            recordType: undefined,
          },
        },
      },
      selected: ['account'],
      cache: new Map(),
      message,
    });

    expect(person.eligible.has('account')).to.equal(true);
    expect(person.recordTypeIdByRelationship.get('account')).to.equal('012person');
    expect(business.eligible.has('account')).to.equal(false);
    expect(business.ineligible.get('account')).to.include('errorRelatedRecordTypeUnavailable');
    expect(missing.eligible.has('account')).to.equal(false);
    expect(missing.ineligible.get('account')).to.include('errorRelatedPersonAccountRecordTypeRequired');
  });

  it('reads person-account eligibility from RecordType.IsPersonType when the describe omits it', async () => {
    // Mirrors a real org: the REST describe carries no `isPersonType` on recordTypeInfos
    // (verified absent at API v67.0 with person accounts enabled), so the only proof the
    // record type is a person one comes from SOQL.
    const accountCatalog: RelatedCatalog = {
      relationships: {
        account: {
          sobject: 'Account',
          phase: 'after',
          recordType: { developerName: 'PersonAccount' },
          match: { field: 'External_Id__c', from: 'user.FederationIdentifier' },
          fields: { Provisioned_User__c: { from: 'user.Id' } },
        },
      },
    };
    const describeFor = (personAccountsEnabled: boolean) => ({
      queryable: true,
      fields: [
        { name: 'External_Id__c', createable: true, updateable: true, filterable: true, externalId: true },
        { name: 'Provisioned_User__c', createable: true, updateable: true, filterable: true },
        // Only present when person accounts are enabled, which is what gates the extra column.
        ...(personAccountsEnabled
          ? [{ name: 'IsPersonAccount', createable: false, updateable: false, filterable: true }]
          : []),
      ],
      recordTypeInfos: [{ recordTypeId: '012person', available: true }],
    });

    const enabledQuery = sinon
      .stub()
      .resolves({
        records: [
          {
            Id: '012person',
            DeveloperName: 'PersonAccount',
            SobjectType: 'Account',
            IsActive: true,
            IsPersonType: true,
          },
        ],
      });
    const enabled = await runRelatedPreflight({
      conn: { describe: sinon.stub().resolves(describeFor(true)), query: enabledQuery } as never,
      catalog: accountCatalog,
      selected: ['account'],
      cache: new Map(),
      message,
    });

    expect(enabled.eligible.has('account')).to.equal(true);
    expect(enabled.recordTypeIdByRelationship.get('account')).to.equal('012person');
    expect(String(enabledQuery.firstCall.args[0])).to.include('IsPersonType');

    // Without person accounts the column does not exist on RecordType at all, so selecting
    // it would fail the whole query and take down record-type resolution for every
    // relationship. It must be left out, and the Account relationship must stay ineligible.
    const disabledQuery = sinon
      .stub()
      .resolves({
        records: [{ Id: '012person', DeveloperName: 'PersonAccount', SobjectType: 'Account', IsActive: true }],
      });
    const disabled = await runRelatedPreflight({
      conn: { describe: sinon.stub().resolves(describeFor(false)), query: disabledQuery } as never,
      catalog: accountCatalog,
      selected: ['account'],
      cache: new Map(),
      message,
    });

    expect(String(disabledQuery.firstCall.args[0])).to.not.include('IsPersonType');
    expect(disabled.eligible.has('account')).to.equal(false);
    expect(disabled.ineligible.get('account')).to.include('errorRelatedRecordTypeUnavailable');
  });

  it('applies related records in a bulk request after filling saved User ids', async () => {
    const create = sinon.stub().resolves([
      { success: true, id: 'a01000000000001AAA', errors: [] },
      { success: true, id: 'a01000000000002AAA', errors: [] },
    ]);
    const sobject = sinon.stub().returns({ create, update: sinon.stub() });
    const relatedPlan = (matchValue: string): RelatedRecordPlan => ({
      relationship: 'employee',
      phase: 'after',
      sobject: 'Employee__c',
      matchField: 'External_Id__c',
      matchValue,
      fields: { External_Id__c: matchValue },
      pendingUserIdFields: ['User__c'],
      mode: 'setIfEmpty',
      status: 'planned',
      errors: [],
    });
    const results = await applyRelatedPhase(
      { sobject } as never,
      [
        { planId: 'one', relatedPlans: [relatedPlan('EMP-1')], savedUserId: '005000000000001AAA' },
        { planId: 'two', relatedPlans: [relatedPlan('EMP-2')], savedUserId: '005000000000002AAA' },
      ],
      'after'
    );

    expect(create.calledOnce).to.equal(true);
    expect(create.firstCall.args[0]).to.deep.equal([
      { External_Id__c: 'EMP-1', User__c: '005000000000001AAA' },
      { External_Id__c: 'EMP-2', User__c: '005000000000002AAA' },
    ]);
    expect(results.get('one')?.[0]).to.deep.include({ action: 'created', status: 'applied' });
  });

  it('partitions related-record writes at 200 records', async () => {
    const create = sinon
      .stub()
      .callsFake(async (payloads: Array<Record<string, unknown>>) =>
        payloads.map((_, index) => ({ success: true, id: `a01${index}`, errors: [] }))
      );
    const sobject = sinon.stub().returns({ create, update: sinon.stub() });
    const relatedPlan = (index: number): RelatedRecordPlan => ({
      relationship: 'employee',
      phase: 'after',
      sobject: 'Employee__c',
      matchField: 'External_Id__c',
      matchValue: `EMP-${index}`,
      fields: { External_Id__c: `EMP-${index}` },
      pendingUserIdFields: [],
      mode: 'setIfEmpty',
      status: 'planned',
      errors: [],
    });
    await applyRelatedPhase(
      { sobject } as never,
      Array.from({ length: 201 }, (_, index) => ({
        planId: `plan-${index}`,
        relatedPlans: [relatedPlan(index)],
        savedUserId: `005${index}`,
      })),
      'after'
    );

    expect(create.callCount).to.equal(2);
    expect(create.firstCall.args[0]).to.have.length(200);
    expect(create.secondCall.args[0]).to.have.length(1);
  });

  it('emits related CSV rows without changing the provision columns', () => {
    const csv = renderProvisionCsv({
      users: [
        {
          key: 'FederationIdentifier:EMP-1',
          personas: [],
          matchedBy: 'FederationIdentifier',
          status: 'planned',
          actions: [],
          errors: [],
          relatedRecords: [{ relationship: 'employee', phase: 'after', sobject: 'Employee__c', action: 'wouldCreate' }],
        },
      ],
    });

    expect(csv).to.equal(
      'userKey,userId,userName,username,personas,matchedBy,status,action,detail,error\n' +
        'FederationIdentifier:EMP-1,,,,,FederationIdentifier,planned,related,employee after Employee__c wouldCreate,'
    );
  });
});
