import { existsSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect } from 'chai';
import sinon from 'sinon';
import {
  assertSnapshotFile,
  buildSnapshotFile,
  deserializeSnapshotCsv,
  serializeSnapshotCsv,
  writeSnapshotFile,
} from '../../src/userLifecycle/snapshotState.js';

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

  it('round-trips identity, frozen state, empty assignments, and neutralized names through CSV', () => {
    const snapshot = {
      snapshotVersion: 1 as const,
      capturedAt: '2026-07-25T14:02:11.000Z',
      org: 'acme-uat',
      users: [
        {
          match: 'FederationIdentifier',
          matchValue: 'E-9981',
          userId: '005Ana',
          name: 'Ana Park',
          username: 'apark@acme.com.dev',
          email: 'apark@acme.com',
          profile: '=System Administrator',
          role: 'Support_Role',
          IsActive: true,
          IsFrozen: false,
          permissionSets: ['=Case_Agent', 'Knowledge_Reader'],
          permissionSetGroups: [],
          publicGroups: ['EMEA_Support'],
          queues: [],
          permissionSetLicenses: [],
        },
        {
          match: 'FederationIdentifier',
          matchValue: "'=A1",
          userId: '005Ravi',
          name: 'Ravi Suresh',
          username: 'rsuresh@acme.com.dev',
          email: 'rsuresh@acme.com',
          profile: 'Standard User',
          IsActive: false,
          IsFrozen: true,
          permissionSets: [],
          permissionSetGroups: [],
          publicGroups: [],
          queues: [],
          permissionSetLicenses: [],
        },
      ],
    };

    const csv = serializeSnapshotCsv(snapshot);
    expect(csv).to.include(
      'snapshotVersion,capturedAt,org,match,matchValue,userId,userName,username,email,profile,role,isActive,isFrozen,category,name'
    );
    expect(csv).to.include("'=Case_Agent");
    expect(csv).to.include("''=A1,005Ravi,Ravi Suresh");
    expect(deserializeSnapshotCsv(csv)).to.deep.equal(JSON.parse(JSON.stringify(snapshot)));
    expect(serializeSnapshotCsv(deserializeSnapshotCsv(csv))).to.equal(csv);
  });

  it('round-trips an empty snapshot with its file metadata', () => {
    const snapshot = {
      snapshotVersion: 1 as const,
      capturedAt: '2026-07-25T14:02:11.000Z',
      org: 'acme-uat',
      users: [],
    };

    const csv = serializeSnapshotCsv(snapshot);
    expect(csv).to.include('2026-07-25T14:02:11.000Z,acme-uat,,,,,,,,,,,emptySnapshot,');
    expect(deserializeSnapshotCsv(csv)).to.deep.equal(snapshot);
    expect(serializeSnapshotCsv(deserializeSnapshotCsv(csv))).to.equal(csv);
  });

  it('rejects a header-only CSV because it cannot preserve file metadata', () => {
    const header =
      'snapshotVersion,capturedAt,org,match,matchValue,userId,userName,username,email,profile,role,isActive,isFrozen,category,name';

    expect(() => deserializeSnapshotCsv(header)).to.throw('must contain an empty-snapshot row with metadata');
  });

  it('keeps v1 snapshots valid without advisory identity fields', () => {
    expect(
      assertSnapshotFile({
        snapshotVersion: 1,
        capturedAt: '2026-07-25T00:00:00.000Z',
        users: [
          {
            match: 'Username',
            matchValue: 'legacy@example.com',
            userId: '005Legacy',
            IsActive: true,
            IsFrozen: true,
            permissionSets: [],
            permissionSetGroups: [],
            publicGroups: [],
            queues: [],
            permissionSetLicenses: [],
          },
        ],
      }).users[0]
    ).to.not.have.any.keys('name', 'username', 'email', 'profile', 'role');
  });

  it('rejects conflicting CSV metadata and keeps users with the same match value separate by Id', () => {
    const header =
      'snapshotVersion,capturedAt,org,match,matchValue,userId,userName,username,email,profile,role,isActive,isFrozen,category,name';
    const row = '1,2026-07-25T00:00:00.000Z,org,Email,same,005One,One,one@example.com,,Standard,,true,false,none,';
    const otherUser =
      '1,2026-07-25T00:00:00.000Z,org,Email,same,005Two,Two,two@example.com,,Standard,,true,false,none,';
    expect(deserializeSnapshotCsv(`${header}\n${row}\n${otherUser}\n`).users).to.have.length(2);
    expect(() => deserializeSnapshotCsv(`${header}\n${row}\n${row.replace(',org,', ',other-org,')}\n`)).to.throw(
      'conflicts with metadata from row 2'
    );
  });
});
