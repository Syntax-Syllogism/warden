import { existsSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect } from 'chai';
import sinon from 'sinon';
import { buildSnapshotFile, writeSnapshotFile } from '../../src/userLifecycle/snapshotState.js';

describe('userLifecycle snapshot state', () => {
  it('creates parent directories before writing a snapshot', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'warden-snapshot-write-test-'));
    const path = join(dir, 'nested', 'snapshot.json');
    await writeSnapshotFile(path, {
      snapshotVersion: 1,
      capturedAt: '2026-07-25T00:00:00.000Z',
      users: [],
    });

    expect(existsSync(path)).to.equal(true);
  });

  it('reads names from assignment rows while preserving sorted, deduplicated arrays', async () => {
    const conn = { query: sinon.stub().resolves({ records: [] }) };
    const snapshot = await buildSnapshotFile(
      conn as never,
      [
        {
          key: 'Username:ana@example.com',
          Id: '005User',
          IsActive: true,
          field: 'Username',
          value: 'ana@example.com',
          order: 0,
        },
      ],
      {
        userLoginByUserId: new Map([['005User', [{ Id: '0UL', UserId: '005User', IsFrozen: false }]]]),
        psaByUserId: new Map([
          [
            '005User',
            [
              {
                Id: '0PSA1',
                AssigneeId: '005User',
                PermissionSetId: '0PS1',
                PermissionSet: { Name: 'Zeta', Label: 'Zeta Label' },
              },
              {
                Id: '0PSA2',
                AssigneeId: '005User',
                PermissionSetId: '0PS2',
                PermissionSet: { Name: 'Alpha', Label: 'Alpha Label' },
              },
              {
                Id: '0PSA3',
                AssigneeId: '005User',
                PermissionSetGroupId: '0PG1',
                PermissionSetGroup: { DeveloperName: 'Group_A' },
              },
              {
                Id: '0PSA4',
                AssigneeId: '005User',
                PermissionSetGroupId: '0PG2',
                PermissionSetGroup: { DeveloperName: 'Group_A' },
              },
            ],
          ],
        ]),
        groupByUserId: new Map([
          [
            '005User',
            [
              {
                Id: '0GM1',
                GroupId: '00G1',
                UserOrGroupId: '005User',
                Group: { Type: 'Regular', DeveloperName: 'Z_Public' },
              },
              {
                Id: '0GM2',
                GroupId: '00G2',
                UserOrGroupId: '005User',
                Group: { Type: 'Regular', DeveloperName: 'A_Public' },
              },
              {
                Id: '0GM3',
                GroupId: '00G3',
                UserOrGroupId: '005User',
                Group: { Type: 'Queue', DeveloperName: 'Case_Queue' },
              },
            ],
          ],
        ]),
        pslByUserId: new Map([
          [
            '005User',
            [
              {
                Id: '0PL1',
                AssigneeId: '005User',
                PermissionSetLicenseId: '0LIC1',
                PermissionSetLicense: { DeveloperName: 'Z_License' },
              },
              {
                Id: '0PL2',
                AssigneeId: '005User',
                PermissionSetLicenseId: '0LIC2',
                PermissionSetLicense: { DeveloperName: 'A_License' },
              },
            ],
          ],
        ]),
      },
      'test-org'
    );

    expect(snapshot.users[0].userId).to.equal('005User');
    expect(snapshot.users[0].permissionSets).to.deep.equal(['Alpha', 'Zeta']);
    expect(snapshot.users[0].permissionSetGroups).to.deep.equal(['Group_A']);
    expect(snapshot.users[0].publicGroups).to.deep.equal(['A_Public', 'Z_Public']);
    expect(snapshot.users[0].queues).to.deep.equal(['Case_Queue']);
    expect(snapshot.users[0].permissionSetLicenses).to.deep.equal(['A_License', 'Z_License']);
    expect(conn.query.called).to.equal(false);
  });

  it('falls back to direct names when relationship values are null', async () => {
    const conn = {
      query: sinon.stub().callsFake(async (soql: string) => {
        if (soql.includes('FROM PermissionSet WHERE')) return { records: [{ Id: '0PS1', Name: 'Fallback_Perms' }] };
        if (soql.includes('FROM PermissionSetGroup WHERE')) {
          return { records: [{ Id: '0PG1', DeveloperName: 'Fallback_Group' }] };
        }
        if (soql.includes('FROM Group WHERE')) {
          return {
            records: [
              { Id: '00G1', DeveloperName: 'Fallback_Public' },
              { Id: '00G2', DeveloperName: 'Fallback_Queue' },
            ],
          };
        }
        if (soql.includes('FROM PermissionSetLicense WHERE')) {
          return { records: [{ Id: '0LIC1', DeveloperName: 'Fallback_License' }] };
        }
        return { records: [] };
      }),
    };
    const snapshot = await buildSnapshotFile(
      conn as never,
      [
        {
          key: 'Username:ana@example.com',
          Id: '005User',
          IsActive: true,
          field: 'Username',
          value: 'ana@example.com',
          order: 0,
        },
      ],
      {
        userLoginByUserId: new Map(),
        psaByUserId: new Map([
          [
            '005User',
            [
              { Id: '0PSA1', AssigneeId: '005User', PermissionSetId: '0PS1', PermissionSet: null },
              {
                Id: '0PSA2',
                AssigneeId: '005User',
                PermissionSetGroupId: '0PG1',
                PermissionSetGroup: { DeveloperName: undefined },
              },
            ],
          ],
        ]),
        groupByUserId: new Map([
          [
            '005User',
            [
              { Id: '0GM1', GroupId: '00G1', UserOrGroupId: '005User', Group: { Type: 'Regular' } },
              { Id: '0GM2', GroupId: '00G2', UserOrGroupId: '005User', Group: { Type: 'Queue' } },
            ],
          ],
        ]),
        pslByUserId: new Map([
          [
            '005User',
            [{ Id: '0PL1', AssigneeId: '005User', PermissionSetLicenseId: '0LIC1', PermissionSetLicense: null }],
          ],
        ]),
      },
      'test-org'
    );

    expect(snapshot.users[0].permissionSets).to.deep.equal(['Fallback_Perms']);
    expect(snapshot.users[0].permissionSetGroups).to.deep.equal(['Fallback_Group']);
    expect(snapshot.users[0].publicGroups).to.deep.equal(['Fallback_Public']);
    expect(snapshot.users[0].queues).to.deep.equal(['Fallback_Queue']);
    expect(snapshot.users[0].permissionSetLicenses).to.deep.equal(['Fallback_License']);
    expect(conn.query.callCount).to.equal(4);
  });
});
