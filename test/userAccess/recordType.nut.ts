import path from 'node:path';
import { AuthInfo, Connection } from '@salesforce/core';
import { execCmd, TestSession } from '@salesforce/cli-plugins-testkit';
import { expect } from 'chai';

type AccessRow = {
  username: string;
  assignmentType: 'Profile' | 'PermissionSet' | 'PermissionSetGroup';
  viaPermissionSetName?: string;
  access: { kind: 'record-type'; visible: boolean; default: boolean | null };
};

type AccessResult = { rows: AccessRow[] };
type MetadataComponent = { fullName: string; recordTypeVisibilities?: unknown };

const fixtureRoot = path.resolve('test/nuts/recordType');
const targetName = 'Access_Audit__c.Visible_Record';
const permissionSetName = 'Record_Type_Direct';
const permissionSetGroupName = 'Record_Type_Access_Group';
// A custom profile so its SOQL Name and Metadata API fullName match; standard
// profiles alias to a different metadata name (SOQL "Standard User" is metadata
// "Standard"), which would deploy the fixture visibility onto the wrong profile.
const fixtureProfileName = 'Record_Type_Fixture';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const metadataComponents = (response: unknown): MetadataComponent[] => {
  const components = Array.isArray(response) ? response : [response];
  return components.filter(
    (component): component is MetadataComponent => isRecord(component) && typeof component.fullName === 'string'
  );
};

const visibilityFor = (component: MetadataComponent): { visible: boolean; default?: boolean } | undefined => {
  const raw = component.recordTypeVisibilities;
  const entries = raw === undefined || raw === null ? [] : Array.isArray(raw) ? raw : [raw];
  const match = entries.find(
    (entry): entry is { recordType: string; visible: boolean; default?: boolean } =>
      isRecord(entry) && entry.recordType === targetName && typeof entry.visible === 'boolean'
  );
  if (!match) return undefined;
  // The raw metadata entry also carries recordType; return only the visibility
  // shape callers assert against.
  return typeof match.default === 'boolean' ? { visible: match.visible, default: match.default } : { visible: match.visible };
};

const createUser = async (conn: Connection, profileId: string, username: string, alias: string): Promise<string> => {
  const result = await conn.sobject('User').create({
    Alias: alias,
    Email: username,
    EmailEncodingKey: 'UTF-8',
    LanguageLocaleKey: 'en_US',
    LastName: alias,
    LocaleSidKey: 'en_US',
    ProfileId: profileId,
    TimeZoneSidKey: 'America/New_York',
    Username: username,
  });
  if (!result.success || !result.id) throw new Error(`Could not create NUT user ${username}.`);
  return result.id;
};

const waitForPermissionSetGroup = async (conn: Connection): Promise<void> => {
  // Recalculation of a freshly deployed group can take a while in a new scratch
  // org, so allow a generous budget before giving up.
  for (let attempt = 0; attempt < 60; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const group = await conn.singleRecordQuery<{ Status?: string }>(
      `SELECT Status FROM PermissionSetGroup WHERE DeveloperName = '${permissionSetGroupName}' LIMIT 1`
    );
    if (group.Status === 'Updated') return;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`Permission Set Group ${permissionSetGroupName} did not finish recalculating.`);
};

const addAssignment = async (conn: Connection, values: Record<string, string>): Promise<void> => {
  const result = await conn.sobject('PermissionSetAssignment').create(values);
  if (!result.success) throw new Error(`Could not create PermissionSetAssignment: ${JSON.stringify(result.errors)}`);
};

describe('record-type access Metadata API NUT', () => {
  let session: TestSession;
  let conn: Connection;
  let fixtureUsername: string;

  before(async () => {
    // Let testkit manage dev-hub auth only when CI supplies explicit credentials;
    // otherwise reuse the dev hub already authenticated in the environment so the
    // NUT runs locally without exporting auth secrets.
    const hasManagedHubAuth = Boolean(process.env.TESTKIT_AUTH_URL ?? process.env.TESTKIT_JWT_KEY);
    session = await TestSession.create({
      project: { sourceDir: fixtureRoot },
      devhubAuthStrategy: hasManagedHubAuth ? 'AUTO' : 'NONE',
      scratchOrgs: [
        {
          config: path.join(fixtureRoot, 'config', 'project-scratch-def.json'),
          setDefault: true,
          alias: 'record-type-org',
          duration: 1,
        },
      ],
    });

    const targetOrg = session.orgs.get('default')?.username ?? process.env.TESTKIT_ORG_USERNAME;
    if (!targetOrg) throw new Error('Testkit did not provide the scratch-org username.');
    execCmd(`project deploy start --source-dir force-app --target-org ${targetOrg} --wait 10`, {
      ensureExitCode: 0,
      cli: 'sf',
    });

    conn = await Connection.create({ authInfo: await AuthInfo.create({ username: targetOrg }) });

    const profile = await conn.singleRecordQuery<{ Id: string; Name: string }>(
      // prettier-ignore
      `SELECT Id, Name FROM Profile WHERE Name = '${fixtureProfileName}' LIMIT 1`
    );
    const suffix = `${Date.now()}-${process.pid}`;
    fixtureUsername = `warden-record-type-${suffix}@example.com`;
    const userId = await createUser(conn, profile.Id, fixtureUsername, 'rtfix');

    const permissionSet = await conn.singleRecordQuery<{ Id: string }>(
      `SELECT Id FROM PermissionSet WHERE Name = '${permissionSetName}' LIMIT 1`
    );
    await addAssignment(conn, { AssigneeId: userId, PermissionSetId: permissionSet.Id });

    const group = await conn.singleRecordQuery<{ Id: string }>(
      `SELECT Id FROM PermissionSetGroup WHERE DeveloperName = '${permissionSetGroupName}' LIMIT 1`
    );
    await waitForPermissionSetGroup(conn);
    await addAssignment(conn, { AssigneeId: userId, PermissionSetGroupId: group.Id });
  });

  after(async () => {
    await session?.clean();
  });

  it('serializes real Profile and Permission Set metadata visibility entries', async () => {
    const profile = await conn.singleRecordQuery<{ Name: string }>(
      // prettier-ignore
      `SELECT Name FROM Profile WHERE Name = '${fixtureProfileName}' LIMIT 1`
    );
    const profileResponse = await conn.metadata.read('Profile', [profile.Name]);
    const profileComponent = metadataComponents(profileResponse).find(
      (component) => component.fullName === profile.Name
    );
    expect(profileComponent).to.not.equal(undefined);
    expect(visibilityFor(profileComponent!)).to.deep.include({ visible: true, default: true });

    const permissionSetResponse = await conn.metadata.read('PermissionSet', [permissionSetName]);
    const permissionSetComponent = metadataComponents(permissionSetResponse).find(
      (component) => component.fullName === permissionSetName
    );
    expect(permissionSetComponent).to.not.equal(undefined);
    expect(visibilityFor(permissionSetComponent!)).to.deep.equal({ visible: true });

    const component = await conn.singleRecordQuery<{ PermissionSetId: string }>(
      `SELECT PermissionSetId FROM PermissionSetGroupComponent WHERE PermissionSetGroup.DeveloperName = '${permissionSetGroupName}' AND PermissionSet.Name = '${permissionSetName}' LIMIT 1`
    );
    expect(component.PermissionSetId).to.be.a('string');
  });

  it('reports Profile, direct Permission Set, and PSG paths consistently forward and reverse', () => {
    const forward = execCmd<AccessResult>(
      `warden access --target-org ${
        process.env.TESTKIT_ORG_USERNAME ?? 'record-type-org'
      } --type record-type --target ${targetName} --json`,
      { ensureExitCode: 0, cli: 'dev' }
    ).jsonOutput?.result;
    expect(forward).to.not.equal(undefined);
    const forwardRows = forward!.rows.filter((row) => row.username === fixtureUsername);
    expect(forwardRows.map((row) => row.assignmentType)).to.have.members([
      'Profile',
      'PermissionSet',
      'PermissionSetGroup',
    ]);
    expect(forwardRows).to.have.length(3);
    expect(forwardRows.find((row) => row.assignmentType === 'Profile')?.access).to.deep.equal({
      kind: 'record-type',
      visible: true,
      default: true,
    });
    expect(forwardRows.find((row) => row.assignmentType === 'PermissionSet')?.access.default).to.equal(null);
    expect(forwardRows.find((row) => row.assignmentType === 'PermissionSetGroup')?.viaPermissionSetName).to.equal(
      permissionSetName
    );

    const reverse = execCmd<AccessResult>(
      `warden access --target-org ${
        process.env.TESTKIT_ORG_USERNAME ?? 'record-type-org'
      } --type record-type --target ${targetName} --user Username:${fixtureUsername} --json`,
      { ensureExitCode: 0, cli: 'dev' }
    ).jsonOutput?.result;
    expect(reverse?.rows).to.have.length(3);
    const pathKey = (row: AccessRow): string =>
      [row.assignmentType, row.viaPermissionSetName ?? '', row.access.default ?? 'n/a'].join('|');
    expect(new Set(reverse?.rows.map(pathKey))).to.deep.equal(new Set(forwardRows.map(pathKey)));
  });
});
