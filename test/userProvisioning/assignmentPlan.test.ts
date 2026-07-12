import { expect } from 'chai';
import {
  computeAssignmentDeltaFromState,
  toDmlPlan,
  type ResolvedRefs,
} from '../../src/userProvisioning/assignmentPlan.js';

const refs: ResolvedRefs = {
  profilesByRef: new Map(),
  rolesByRef: new Map(),
  permissionSetIdsByRef: new Map([
    ['Keep', '0PSKeep'],
    ['Add', '0PSAdd'],
  ]),
  permissionSetGroupIdsByRef: new Map(),
  publicGroupIdsByRef: new Map([
    ['KeepPublic', '00GKeepPublic'],
    ['AddPublic', '00GAddPublic'],
  ]),
  queueIdsByRef: new Map(),
  warnings: [],
};

describe('userProvisioning assignmentPlan', () => {
  it('returns adds/removes/inBoth and keeps additive extras informational', () => {
    const delta = computeAssignmentDeltaFromState(
      {
        permissionSetMode: 'sync',
        permissionSets: ['Keep', 'Add'],
        publicGroupMode: 'additive',
        publicGroups: ['KeepPublic', 'AddPublic'],
      },
      refs,
      [
        {
          Id: '0PaKeep',
          AssigneeId: '005User',
          PermissionSetId: '0PSKeep',
          PermissionSetGroupId: null,
          PermissionSet: { IsOwnedByProfile: false },
        },
        {
          Id: '0PaExtra',
          AssigneeId: '005User',
          PermissionSetId: '0PSExtra',
          PermissionSetGroupId: null,
          PermissionSet: { IsOwnedByProfile: false },
        },
      ],
      [
        {
          Id: '0GMKeep',
          GroupId: '00GKeepPublic',
          UserOrGroupId: '005User',
          Group: { Type: 'Regular' },
        },
        {
          Id: '0GMExtra',
          GroupId: '00GExtraPublic',
          UserOrGroupId: '005User',
          Group: { Type: 'Regular' },
        },
      ]
    );

    expect(delta.permissionSets.adds).to.deep.equal(['0PSAdd']);
    expect(delta.permissionSets.removes).to.deep.equal(['0PSExtra']);
    expect(delta.permissionSets.inBoth).to.deep.equal(['0PSKeep']);
    expect(delta.publicGroups.adds).to.deep.equal(['00GAddPublic']);
    expect(delta.publicGroups.removes).to.deep.equal([]);
    expect(delta.publicGroups.onlyInOrg).to.deep.equal(['00GExtraPublic']);
  });

  it('maps remove deltas back to assignment record ids for DML', () => {
    const dmlPlan = toDmlPlan(
      {
        permissionSets: { adds: ['0PSAdd'], removes: ['0PSRemove'], inBoth: [], onlyInOrg: ['0PSRemove'], mode: 'sync' },
        permissionSetGroups: {
          adds: ['0PGAdd'],
          removes: ['0PGRemove'],
          inBoth: [],
          onlyInOrg: ['0PGRemove'],
          mode: 'sync',
        },
        publicGroups: {
          adds: ['00GPublicAdd'],
          removes: ['00GPublicRemove'],
          inBoth: [],
          onlyInOrg: ['00GPublicRemove'],
          mode: 'sync',
        },
        queues: {
          adds: ['00GQueueAdd'],
          removes: ['00GQueueRemove'],
          inBoth: [],
          onlyInOrg: ['00GQueueRemove'],
          mode: 'sync',
        },
      },
      [
        {
          Id: '0PaRemove',
          AssigneeId: '005User',
          PermissionSetId: '0PSRemove',
          PermissionSetGroupId: null,
          PermissionSet: { IsOwnedByProfile: false },
        },
        {
          Id: '0PaGroupRemove',
          AssigneeId: '005User',
          PermissionSetId: null,
          PermissionSetGroupId: '0PGRemove',
        },
      ],
      [
        {
          Id: '0GMPublicRemove',
          GroupId: '00GPublicRemove',
          UserOrGroupId: '005User',
          Group: { Type: 'Regular' },
        },
        {
          Id: '0GMQueueRemove',
          GroupId: '00GQueueRemove',
          UserOrGroupId: '005User',
          Group: { Type: 'Queue' },
        },
      ]
    );

    expect(dmlPlan.permissionSets).to.deep.equal({ adds: ['0PSAdd'], removes: ['0PaRemove'] });
    expect(dmlPlan.permissionSetGroups).to.deep.equal({ adds: ['0PGAdd'], removes: ['0PaGroupRemove'] });
    expect(dmlPlan.publicGroups).to.deep.equal({ adds: ['00GPublicAdd'], removes: ['0GMPublicRemove'] });
    expect(dmlPlan.queues).to.deep.equal({ adds: ['00GQueueAdd'], removes: ['0GMQueueRemove'] });
  });
});
