import { expect } from 'chai';
import sinon from 'sinon';
import {
  groupMemberLabel,
  loadAssignmentState,
  permissionSetAssignmentLabel,
  permissionSetLicenseLabel,
  type GroupMemberRow,
  type PermissionSetAssignmentRow,
  type PermissionSetLicenseAssignRow,
} from '../../src/userLifecycle/assignmentState.js';

describe('userLifecycle assignmentState', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('maps permission set assignments to group labels with group precedence', () => {
    const row: PermissionSetAssignmentRow = {
      Id: '0PA1',
      AssigneeId: '0051',
      PermissionSetId: '0PS1',
      PermissionSetGroupId: '0PG1',
      PermissionSet: { Name: 'Permission_Set', Label: 'Permission Set' },
      PermissionSetGroup: { DeveloperName: 'Permission_Set_Group', MasterLabel: 'Permission Set Group' },
    };

    expect(permissionSetAssignmentLabel(row)).to.deep.equal({
      id: '0PG1',
      apiName: 'Permission_Set_Group',
      label: 'Permission Set Group',
      type: 'PermissionSetGroup',
    });
  });

  it('maps standalone and unidentifiable permission set assignments', () => {
    const row: PermissionSetAssignmentRow = {
      Id: '0PA1',
      AssigneeId: '0051',
      PermissionSetId: '0PS1',
      PermissionSet: { Name: 'Permission_Set', Label: 'Permission Set' },
    };
    expect(permissionSetAssignmentLabel(row)).to.deep.equal({
      id: '0PS1',
      apiName: 'Permission_Set',
      label: 'Permission Set',
      type: 'PermissionSet',
    });
    expect(permissionSetAssignmentLabel({ Id: '0PA2', AssigneeId: '0051' })).to.equal(undefined);
  });

  it('maps group members and licenses, including missing relationships', () => {
    const queue: GroupMemberRow = {
      Id: '0GM1',
      GroupId: '00G1',
      UserOrGroupId: '0051',
      Group: { Type: 'Queue', DeveloperName: 'Case_Queue', Name: 'Case Queue' },
    };
    const regular: GroupMemberRow = { Id: '0GM2', GroupId: '00G2', UserOrGroupId: '0051', Group: { Type: 'Regular' } };
    const missingGroup: GroupMemberRow = { Id: '0GM3', GroupId: '00G3', UserOrGroupId: '0051' };
    const license: PermissionSetLicenseAssignRow = {
      Id: '0PLA1',
      AssigneeId: '0051',
      PermissionSetLicenseId: '0PL1',
    };

    expect(groupMemberLabel(queue)).to.deep.equal({
      id: '00G1',
      apiName: 'Case_Queue',
      label: 'Case Queue',
      type: 'Queue',
    });
    expect(groupMemberLabel(regular)).to.deep.equal({
      id: '00G2',
      apiName: undefined,
      label: undefined,
      type: 'PublicGroup',
    });
    expect(groupMemberLabel(missingGroup)).to.deep.equal({
      id: '00G3',
      apiName: undefined,
      label: undefined,
      type: 'PublicGroup',
    });
    expect(permissionSetLicenseLabel(license)).to.deep.equal({
      id: '0PL1',
      apiName: undefined,
      label: undefined,
      type: 'PermissionSetLicense',
    });
  });

  it('batches assignment state queries by target ids', async () => {
    const ids = Array.from({ length: 101 }, (_, index) => `005xx000000${String(index).padStart(6, '0')}`);
    const conn = {
      query: sinon.stub().resolves({ records: [] }),
    };

    await loadAssignmentState(conn as never, ids, { groupMemberships: true });

    expect(conn.query.callCount).to.equal(2);
    expect(conn.query.firstCall.args[0]).to.include(ids[0]);
    expect(conn.query.firstCall.args[0]).to.not.include(ids[100]);
    expect(conn.query.secondCall.args[0]).to.include(ids[100]);
    expect(conn.query.firstCall.args[0]).to.include('Group.DeveloperName, Group.Name');

    await loadAssignmentState(conn as never, [ids[0]]);
    const queries = conn.query.args.map(([soql]) => soql as string);
    expect(queries.some((soql) => soql.includes('PermissionSet.Name, PermissionSet.Label'))).to.equal(true);
    expect(
      queries.some((soql) => soql.includes('PermissionSetLicense.DeveloperName, PermissionSetLicense.MasterLabel'))
    ).to.equal(true);
  });
});
