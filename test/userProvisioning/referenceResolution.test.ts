import { expect } from 'chai';
import sinon from 'sinon';
import { resolveReferences } from '../../src/userProvisioning/referenceResolution.js';

describe('userProvisioning referenceResolution', () => {
  it('resolves names and permitted Id prefixes while preserving labels and warnings', async () => {
    const query = sinon.stub().callsFake(async (soql: string) => {
      if (soql.includes('FROM Profile')) {
        return { records: [{ Id: '00e000000000001', Name: 'Admin' }] };
      }
      if (soql.includes('FROM PermissionSet ')) {
        return { records: [{ Id: '0PS000000000001', Name: 'Perm', Label: 'Permission' }] };
      }
      if (soql.includes('FROM PermissionSetGroup')) {
        return { records: [{ Id: '0PG000000000001', DeveloperName: 'Group', MasterLabel: 'Group Label' }] };
      }
      if (soql.includes('FROM Group WHERE Id IN') && soql.includes("Type = 'Regular'")) {
        return { records: [{ Id: '00G000000000001', DeveloperName: 'Public', Name: 'Public Group' }] };
      }
      if (soql.includes('FROM Group WHERE DeveloperName') && soql.includes("Type = 'Queue'")) {
        return { records: [{ Id: '00G000000000002', DeveloperName: 'Queue', Name: 'Queue Group' }] };
      }
      if (soql.includes('FROM UserRole')) {
        return { records: [{ Id: '00E000000000001', DeveloperName: 'RoleDev', Name: 'Role Label' }] };
      }
      return { records: [] };
    });
    const conn = { query } as never;

    const refs = await resolveReferences(
      conn,
      {
        admin: {
          profile: 'Admin',
          role: 'RoleDev',
          permissionSets: ['Perm'],
          permissionSetGroups: ['Group'],
          publicGroups: ['00G000000000001'],
          queues: ['Queue'],
        },
      },
      [
        {
          inputKey: 'one',
          personas: ['admin'],
          effectivePersona: {},
          profileRef: '00G000000000003',
          roleRef: 'Role Label',
          fields: {},
        },
      ]
    );

    expect(refs.profilesByRef.get('Admin')).to.equal('00e000000000001');
    expect(refs.rolesByRef.get('RoleDev')).to.equal('00E000000000001');
    expect(refs.rolesByRef.get('Role Label')).to.equal('00E000000000001');
    expect(refs.permissionSetIdsByRef.get('Perm')).to.equal('0PS000000000001');
    expect(refs.permissionSetGroupIdsByRef.get('Group')).to.equal('0PG000000000001');
    expect(refs.publicGroupIdsByRef.get('00G000000000001')).to.equal('00G000000000001');
    expect(refs.queueIdsByRef.get('Queue')).to.equal('00G000000000002');
    expect(refs.labels?.['00E000000000001']).to.deep.include({
      apiName: 'RoleDev',
      label: 'Role Label',
      type: 'UserRole',
    });
    expect(refs.warnings).to.deep.equal(['Profile reference "00G000000000003" was not found.']);
  });
});
