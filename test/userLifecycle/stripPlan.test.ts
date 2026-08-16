import { expect } from 'chai';
import { buildTargetState, type StripFlags, type TargetAssignmentRows } from '../../src/userLifecycle/stripPlan.js';
import type { ResolvedTargetUser } from '../../src/userLifecycle/types.js';

const target: ResolvedTargetUser = {
  key: 'Username:strip@example.com',
  Id: '005Strip',
  IsActive: true,
  field: 'Username',
  value: 'strip@example.com',
  order: 0,
};

const rows: TargetAssignmentRows = {
  psa: [
    {
      Id: '0PSASet',
      AssigneeId: target.Id,
      PermissionSetId: '0PSSet',
      PermissionSet: { IsOwnedByProfile: false, Name: 'Support_Permissions' },
    },
    {
      Id: '0PSAOwned',
      AssigneeId: target.Id,
      PermissionSetId: '0PSOwned',
      PermissionSet: { IsOwnedByProfile: true, Name: 'Profile_Permissions' },
    },
    {
      Id: '0PSAGroup',
      AssigneeId: target.Id,
      PermissionSetGroupId: '0PGGroup',
      PermissionSetGroup: { DeveloperName: 'Support_Group' },
    },
  ],
  group: [
    {
      Id: '0GMRegular',
      GroupId: '00GRegular',
      UserOrGroupId: target.Id,
      Group: { Type: 'Regular', DeveloperName: 'Support_Public' },
    },
    {
      Id: '0GMQueue',
      GroupId: '00GQueue',
      UserOrGroupId: target.Id,
      Group: { Type: 'Queue', DeveloperName: 'Support_Queue' },
    },
  ],
  psl: [
    {
      Id: '0PLAssign',
      AssigneeId: target.Id,
      PermissionSetLicenseId: '0PLLicense',
      PermissionSetLicense: { DeveloperName: 'Support_License' },
    },
  ],
};

const defaultFlags = (): StripFlags => ({
  'no-freeze': false,
  'no-deactivate': false,
  'keep-permsets': false,
  'keep-permset-groups': false,
  'keep-public-groups': false,
  'keep-queues': false,
  'keep-licenses': false,
  'dry-run': false,
});

const build = (flags = defaultFlags(), assignmentRows = rows) =>
  buildTargetState({
    target,
    loginRows: [{ Id: '0ULLogin', UserId: target.Id, IsFrozen: false }],
    rows: assignmentRows,
    flags,
    message: (key) => key,
  });

describe('userLifecycle strip plan', () => {
  it('plans freeze, every category, and deactivation in execution order', () => {
    const state = build();

    expect(state.steps.map(({ sobject, actionKey }) => ({ sobject, actionKey }))).to.deep.equal([
      { sobject: 'UserLogin', actionKey: 'frozen' },
      { sobject: 'PermissionSetAssignment', actionKey: 'removedPermissionSet' },
      { sobject: 'PermissionSetAssignment', actionKey: 'removedPermissionSetGroup' },
      { sobject: 'GroupMember', actionKey: 'removedPublicGroupMember' },
      { sobject: 'GroupMember', actionKey: 'removedQueueMember' },
      { sobject: 'PermissionSetLicenseAssign', actionKey: 'removedPermissionSetLicense' },
      { sobject: 'User', actionKey: 'deactivated' },
    ]);
  });

  it('skips only freezing when no-freeze is set', () => {
    const state = build({ ...defaultFlags(), 'no-freeze': true });

    expect(state.steps.map((step) => step.actionKey)).to.deep.equal([
      'removedPermissionSet',
      'removedPermissionSetGroup',
      'removedPublicGroupMember',
      'removedQueueMember',
      'removedPermissionSetLicense',
      'deactivated',
    ]);
    expect(state.result.skipped.map((notice) => notice.key)).to.deep.equal([
      'skippedProfileOwnedPermissionSets',
      'skippedFreeze',
    ]);
  });

  for (const [flag, skippedKey, actionKey] of [
    ['keep-permsets', 'skippedPermissionSets', 'removedPermissionSet'],
    ['keep-permset-groups', 'skippedPermissionSetGroups', 'removedPermissionSetGroup'],
    ['keep-public-groups', 'skippedPublicGroups', 'removedPublicGroupMember'],
    ['keep-queues', 'skippedQueues', 'removedQueueMember'],
    ['keep-licenses', 'skippedPermissionSetLicenses', 'removedPermissionSetLicense'],
  ] as const) {
    it(`keeps only the ${flag} category`, () => {
      const state = build({ ...defaultFlags(), [flag]: true });

      expect(state.steps.map((step) => step.actionKey)).not.to.include(actionKey);
      expect(state.steps).to.have.length(6);
      expect(state.result.skipped.map((notice) => notice.key)).to.include(skippedKey);
      expect(
        state.result.skipped.filter((notice) => notice.key !== 'skippedProfileOwnedPermissionSets')
      ).to.have.length(1);
    });
  }

  it('always excludes profile-owned permission sets from removal', () => {
    const state = build();
    const permissionSetStep = state.steps.find((step) => step.actionKey === 'removedPermissionSet');

    expect(permissionSetStep).to.deep.include({ ids: ['0PSASet'] });
    expect(state.result.skipped).to.deep.include({ key: 'skippedProfileOwnedPermissionSets', count: 1 });
  });

  it('reports only planned actions and creates no steps during a dry run', () => {
    const state = build({ ...defaultFlags(), 'dry-run': true });

    expect(state.steps).to.deep.equal([]);
    expect(state.result.actions.map((notice) => notice.key)).to.deep.equal([
      'wouldFreeze',
      'wouldRemovePermissionSet',
      'wouldRemovePermissionSetGroup',
      'wouldRemovePublicGroupMember',
      'wouldRemoveQueueMember',
      'wouldRemovePermissionSetLicense',
      'wouldDeactivate',
    ]);
    expect(state.result.status).to.equal('planned');
  });

  it('skips only deactivation when no-deactivate is set', () => {
    const state = build({ ...defaultFlags(), 'no-deactivate': true });

    expect(state.steps.map((step) => step.actionKey)).to.deep.equal([
      'frozen',
      'removedPermissionSet',
      'removedPermissionSetGroup',
      'removedPublicGroupMember',
      'removedQueueMember',
      'removedPermissionSetLicense',
    ]);
    expect(state.result.skipped.map((notice) => notice.key)).to.deep.equal([
      'skippedProfileOwnedPermissionSets',
      'skippedDeactivate',
    ]);
  });
});
