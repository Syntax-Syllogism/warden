import { expect } from 'chai';
import {
  failedResult,
  makeNotice,
  renderLifecycleResult,
  resolvedTargetResult,
  summarizeLifecycle,
} from '../../src/userLifecycle/output.js';
import { renderUserDiffCsv } from '../../src/userLifecycle/diffOutput.js';
import { displayName } from '../../src/userLifecycle/userDiff.js';
import {
  renderLifecycleCsv,
  renderProvisionCsv,
  renderRestoreCsv,
  renderStripCsv,
} from '../../src/userShared/output.js';

describe('userLifecycle output', () => {
  const lookup = (key: string, args: string[] = []): string =>
    key === 'info.summary' ? `summary ${args.join('/')}` : key;

  it('summarizes planned users as changed', () => {
    expect(
      summarizeLifecycle([
        { key: 'one', status: 'planned', actions: [], skipped: [], warnings: [], errors: [] },
        { key: 'two', status: 'changed', actions: [], skipped: [], warnings: [], errors: [] },
        { key: 'three', status: 'unchanged', actions: [], skipped: [], warnings: [], errors: [] },
        { key: 'four', status: 'failed', actions: [], skipped: [], warnings: [], errors: ['failed'] },
      ])
    ).to.deep.equal({ total: 4, changed: 2, unchanged: 1, failed: 1 });
  });

  it('constructs failed and resolved lifecycle results', () => {
    expect(
      failedResult({ key: 'Username:missing', field: 'Username', value: 'missing', message: 'not found', order: 0 })
    ).to.deep.equal({
      key: 'Username:missing',
      status: 'failed',
      actions: [],
      skipped: [],
      warnings: [],
      errors: ['not found'],
    });
    expect(
      resolvedTargetResult(
        {
          key: 'Username:alice',
          Id: '005User',
          IsActive: true,
          name: 'Alice Park',
          username: 'alice@example.com',
          field: 'Username',
          value: 'alice',
          order: 0,
        },
        { IsFrozen: true }
      )
    ).to.deep.equal({
      key: 'Username:alice',
      id: '005User',
      name: 'Alice Park',
      username: 'alice@example.com',
      isActive: true,
      isFrozen: true,
      status: 'unchanged',
      actions: [],
      skipped: [],
      warnings: [],
      errors: [],
    });
  });

  it('falls back to the relationship Id when Salesforce omits a relationship row', () => {
    expect(displayName('00eProfile', null)).to.equal('00eProfile');
    expect(displayName('00eProfile', undefined)).to.equal('00eProfile');
  });

  it('renders resolved identity, match provenance, and sorted assignment items', () => {
    const output = renderLifecycleResult(
      {
        summary: { total: 1, changed: 1, unchanged: 0, failed: 0 },
        users: [
          {
            key: 'Employee_ID__c:E-9981',
            id: '005User',
            name: 'Ana Park',
            username: 'apark@acme.com.dev',
            isActive: true,
            isFrozen: false,
            status: 'changed',
            actions: [
              makeNotice('removedPermissionSet', 2, [
                { id: '0PS2', apiName: 'Zeta', label: 'Zeta Label', type: 'PermissionSet' },
                { id: '0PS1', apiName: 'Alpha', label: 'Alpha Label', type: 'PermissionSet' },
              ]),
            ],
            skipped: [],
            warnings: [],
            errors: [],
          },
        ],
      },
      lookup
    );

    expect(output).to.include('Ana Park <apark@acme.com.dev> · 005User');
    expect(output).to.include('  matched Employee_ID__c = E-9981 · was active');
    expect(output.indexOf('    · Alpha (Alpha Label)')).to.be.lessThan(output.indexOf('    · Zeta (Zeta Label)'));
  });

  it('keeps the key and status fallback when identity is unavailable', () => {
    const output = renderLifecycleResult(
      {
        summary: { total: 1, changed: 0, unchanged: 0, failed: 1 },
        users: [
          {
            key: 'Username:missing@example.com',
            id: undefined,
            status: 'failed',
            actions: [],
            skipped: [],
            warnings: [],
            errors: ['not found'],
          },
        ],
      },
      lookup
    );

    expect(output).to.include('Username:missing@example.com: failed');
    expect(output).to.not.include('matched Username');
  });

  it('renders one row per lifecycle action item and retains empty and failed users', () => {
    const csv = renderRestoreCsv({
      summary: { total: 3, changed: 1, unchanged: 1, failed: 1 },
      users: [
        {
          key: 'Username:one@example.test',
          id: '005One',
          name: 'One User',
          username: 'one@example.test',
          status: 'planned',
          actions: [
            makeNotice('wouldAssign', 2, [
              { id: '0PS2', apiName: 'Zeta', type: 'PermissionSet' },
              { id: '0PS1', apiName: 'Alpha', type: 'PermissionSet' },
            ]),
            makeNotice('wouldActivate'),
          ],
          skipped: [],
          warnings: [],
          errors: [],
        },
        {
          key: 'Username:two@example.test',
          id: '005Two',
          name: 'Two User',
          username: 'two@example.test',
          status: 'unchanged',
          actions: [],
          skipped: [],
          warnings: [],
          errors: [],
        },
        {
          key: 'Username:missing@example.test',
          status: 'failed',
          actions: [],
          skipped: [],
          warnings: [],
          errors: ['not found'],
        },
      ],
    });

    expect(csv).to.equal(
      'userKey,userId,userName,username,status,action,category,name,error\n' +
        'Username:one@example.test,005One,One User,one@example.test,planned,wouldAssign,PermissionSet,Alpha,\n' +
        'Username:one@example.test,005One,One User,one@example.test,planned,wouldAssign,PermissionSet,Zeta,\n' +
        'Username:one@example.test,005One,One User,one@example.test,planned,wouldActivate,,,\n' +
        'Username:two@example.test,005Two,Two User,two@example.test,unchanged,,,,\n' +
        'Username:missing@example.test,,,,failed,,,,not found'
    );
  });

  it('renders freeze rows with the original frozen state', () => {
    const csv = renderLifecycleCsv({
      summary: { total: 1, changed: 1, unchanged: 0, failed: 0 },
      users: [
        {
          key: 'Username:user@example.test',
          id: '005User',
          name: 'User',
          username: 'user@example.test',
          isFrozen: false,
          status: 'changed',
          actions: [makeNotice('frozen')],
          skipped: [],
          warnings: [],
          errors: [],
        },
      ],
    });
    expect(csv).to.equal(
      'userKey,userId,userName,username,wasFrozen,status,action,error\n' +
        'Username:user@example.test,005User,User,user@example.test,false,changed,frozen,'
    );
  });

  it('renders strip item ids and API names', () => {
    const csv = renderStripCsv({
      summary: { total: 1, changed: 1, unchanged: 0, failed: 0 },
      users: [
        {
          key: 'Username:user@example.test',
          id: '005User',
          status: 'planned',
          actions: [makeNotice('wouldRemove', 1, [{ id: '0PS1', apiName: 'Sales_Perms', type: 'PermissionSet' }])],
          skipped: [],
          warnings: [],
          errors: [],
        },
      ],
    });
    expect(csv).to.equal(
      'userKey,userId,userName,username,status,action,category,itemId,itemApiName,error\n' +
        'Username:user@example.test,005User,,,planned,wouldRemove,PermissionSet,0PS1,Sales_Perms,'
    );
  });

  it('renders provision actions and errors at one row per event', () => {
    const csv = renderProvisionCsv({
      users: [
        {
          key: 'FederationIdentifier:ABC123',
          id: '005User',
          userName: 'Ana Park',
          username: 'ana@example.test',
          personas: ['sales'],
          matchedBy: 'FederationIdentifier',
          status: 'updated',
          actions: ['updated', 'unfrozen'],
          errors: ['assignment failed'],
        },
        {
          key: 'FederationIdentifier:EMPTY',
          personas: [],
          matchedBy: null,
          status: 'failed',
          actions: [],
          errors: [],
        },
      ],
    });

    expect(csv).to.equal(
      'userKey,userId,userName,username,personas,matchedBy,status,action,detail,error\n' +
        'FederationIdentifier:ABC123,005User,Ana Park,ana@example.test,sales,FederationIdentifier,updated,updated,,\n' +
        'FederationIdentifier:ABC123,005User,Ana Park,ana@example.test,sales,FederationIdentifier,updated,unfrozen,,\n' +
        'FederationIdentifier:ABC123,005User,Ana Park,ana@example.test,sales,FederationIdentifier,updated,,,assignment failed\n' +
        'FederationIdentifier:EMPTY,,,,,,failed,,,'
    );
  });

  it('keeps diff, provision, freeze, unfreeze, strip, and restore CSV byte-identical', () => {
    const lifecycleResult = {
      summary: { total: 1, changed: 1, unchanged: 0, failed: 0 },
      users: [
        {
          key: 'Username:user@example.test',
          id: '005User',
          name: 'User',
          username: 'user@example.test',
          isFrozen: false,
          status: 'planned' as const,
          actions: [
            makeNotice('wouldAssign', 3, [
              { id: '0PS1', apiName: 'Alpha_Perms', type: 'PermissionSet' as const },
              { id: '00G1', apiName: 'Sales_Group', type: 'PublicGroup' as const },
              { id: '00G2', apiName: 'Case_Queue', type: 'Queue' as const },
            ]),
          ],
          skipped: [],
          warnings: [],
          errors: [],
        },
      ],
    };
    const provisionResult = {
      users: [
        {
          key: 'Username:user@example.test',
          id: '005User',
          userName: 'User',
          username: 'user@example.test',
          personas: ['support'],
          matchedBy: 'Username',
          status: 'updated',
          actions: ['updated', 'assignedPermissionSet'],
          errors: [],
        },
      ],
    };
    const diffResult = {
      summary: { total: 1, compared: 1, wouldCreate: 0, failed: 0, changed: 1 },
      warnings: [],
      users: [],
      rows: [
        {
          userKey: 'Username:user@example.test',
          userId: '005User',
          category: 'permissionSets',
          kind: 'add' as const,
          value: '0PS1',
          mode: 'sync',
        },
        {
          userKey: 'Username:user@example.test',
          userId: '005User',
          category: 'publicGroups',
          kind: 'remove' as const,
          value: '00G1',
          mode: 'sync',
        },
      ],
      labels: {
        '0PS1': { id: '0PS1', apiName: 'Alpha_Perms', type: 'PermissionSet' as const },
        '00G1': { id: '00G1', apiName: 'Sales_Group', type: 'PublicGroup' as const },
      },
    };
    const renderers = [
      () => renderUserDiffCsv(diffResult),
      () => renderProvisionCsv(provisionResult),
      () => renderLifecycleCsv(lifecycleResult),
      () =>
        renderLifecycleCsv({
          ...lifecycleResult,
          users: [{ ...lifecycleResult.users[0], actions: [makeNotice('wouldUnfreeze')] }],
        }),
      () => renderStripCsv(lifecycleResult),
      () => renderRestoreCsv(lifecycleResult),
    ];
    const outputs = renderers.map((render) => [render(), render()]);

    expect(outputs).to.have.length(6);
    expect(outputs.every(([first, second]) => first === second)).to.equal(true);
    expect(outputs[4][0]).to.include('Alpha_Perms');
    expect(outputs[4][0]).to.include('Sales_Group');
    expect(outputs[4][0]).to.include('Case_Queue');
  });
});
