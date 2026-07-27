import { expect } from 'chai';
import {
  buildDefaultAlias,
  buildDefaultUsername,
  buildFieldMap,
  canonicalizeFieldObject,
  deriveMyDomain,
  isSalesforceId,
  mergePersonas,
  mergeUserFields,
  missingRequiredFieldsForInsert,
  normalizeMode,
  validateAndCanonicalizeUsers,
  validateExternalIdField,
  validateExternalIdFieldForFlag,
  validatePersonaModes,
} from '../../src/userProvisioning/planner.js';

describe('userProvisioning planner', () => {
  const fieldMap = buildFieldMap([
    { name: 'Username', createable: true, updateable: true, filterable: true },
    { name: 'FederationIdentifier', createable: true, updateable: true, filterable: true, externalId: true },
    { name: 'FirstName', createable: true, updateable: true, filterable: true },
    { name: 'LastName', createable: true, updateable: true, filterable: true },
    { name: 'Email', createable: true, updateable: true, filterable: true },
    { name: 'Alias', createable: true, updateable: true, filterable: true },
    { name: 'Title', createable: true, updateable: true, filterable: true },
    { name: 'ProfileId', createable: true, updateable: true, filterable: true },
    { name: 'UserRoleId', createable: true, updateable: true, filterable: true },
  ]);

  it('canonicalizes user fields case-insensitively', () => {
    const result = canonicalizeFieldObject({ username: 'u', lastname: 'doe' }, fieldMap, 'test');
    expect(result).to.deep.equal({ Username: 'u', LastName: 'doe' });
  });

  it('merges persona attributes and prefers user-level values', () => {
    const result = mergeUserFields({ LastName: 'Persona' }, { LastName: 'User', Email: 'x@y.com' });
    expect(result).to.deep.equal({ LastName: 'User', Email: 'x@y.com' });
  });

  it('defaults assignment modes to additive', () => {
    expect(normalizeMode(undefined)).to.equal('additive');
  });

  it('rejects invalid assignment mode', () => {
    expect(() => normalizeMode('replace')).to.throw('Invalid assignment mode');
  });

  it('validates persona mode/list shape', () => {
    expect(() =>
      validatePersonaModes({ admin: { permissionSetMode: 'additive', permissionSets: ['A'] } })
    ).not.to.throw();
    expect(() => validatePersonaModes({ admin: { permissionSetMode: 'bad' as never } })).to.throw(
      'Invalid assignment mode'
    );
  });

  it('validates filterable match fields', () => {
    expect(() => validateExternalIdField('FederationIdentifier', fieldMap)).not.to.throw();
    expect(() => validateExternalIdField('Email', fieldMap)).not.to.throw();
    expect(() => validateExternalIdField('LastName', fieldMap)).not.to.throw();
    expect(() => validateExternalIdFieldForFlag('LastName', fieldMap)).not.to.throw();
  });

  it('canonicalizes and merges users with persona defaults', () => {
    const users = validateAndCanonicalizeUsers(
      [{ personas: ['admin'], username: 'u1', firstname: 'Jane', lastname: 'User' }],
      { admin: { userAttributes: { LastName: 'Persona' } } },
      fieldMap
    );
    expect(users[0].fields.LastName).to.equal('User');
    expect(users[0].fields.Username).to.equal('u1');
    expect(users[0].personas).to.deep.equal(['admin']);
  });

  it('canonicalizes per-user match fields case-insensitively', () => {
    const users = validateAndCanonicalizeUsers(
      [{ personas: ['admin'], match: 'federationidentifier', FederationIdentifier: 'A1', username: 'u1' }],
      { admin: {} },
      fieldMap
    );
    expect(users[0].matchField).to.equal('FederationIdentifier');
    expect(users[0].validationErrors).to.equal(undefined);
  });

  it('records an error for unknown per-user match fields', () => {
    const users = validateAndCanonicalizeUsers(
      [{ personas: ['admin'], match: 'DoesNotExist' }],
      { admin: {} },
      fieldMap
    );
    expect(users[0].validationErrors?.[0]).to.deep.equal({
      messageKey: 'errorInvalidUserMatchField',
      messageArgs: ['DoesNotExist'],
    });
  });

  it('accepts a filterable non-external-id per-user match field', () => {
    const users = validateAndCanonicalizeUsers(
      [{ personas: ['admin'], match: 'LastName', LastName: 'User' }],
      { admin: {} },
      fieldMap
    );
    expect(users[0].matchField).to.equal('LastName');
    expect(users[0].validationErrors).to.equal(undefined);
  });

  it('canonicalizes and validates per-user fuzzy username', () => {
    const users = validateAndCanonicalizeUsers(
      [
        { personas: ['admin'], Username: 'u1', fuzzyUsername: true },
        { personas: ['admin'], Username: 'u2', fuzzyUsername: false },
        { personas: ['admin'], Username: 'u3' },
        { personas: ['admin'], Username: 'u4', fuzzyUsername: 'yes' },
      ],
      { admin: {} },
      fieldMap
    );
    expect(users.map((user) => user.fuzzyUsername)).to.deep.equal([true, false, undefined, undefined]);
    expect(users[3].validationErrors?.[0]).to.deep.equal({
      messageKey: 'errorInvalidFuzzyUsername',
      messageArgs: ['yes'],
    });
  });

  it('records an error when the matched field is empty', () => {
    const users = validateAndCanonicalizeUsers(
      [{ personas: ['admin'], match: 'FederationIdentifier', FederationIdentifier: '' }],
      { admin: {} },
      fieldMap
    );
    expect(users[0].matchField).to.equal('FederationIdentifier');
    expect(users[0].validationErrors?.[0]).to.deep.equal({
      messageKey: 'errorUserMatchFieldEmpty',
      messageArgs: ['FederationIdentifier'],
    });
  });

  it('leaves matchField undefined when match is absent', () => {
    const users = validateAndCanonicalizeUsers([{ personas: ['admin'], username: 'u1' }], { admin: {} }, fieldMap);
    expect(users[0].matchField).to.equal(undefined);
  });

  it('validates practical required fields for inserts', () => {
    const missing = missingRequiredFieldsForInsert(
      {
        Username: 'u',
        LastName: 'ln',
      },
      false
    );
    expect(missing).to.include('Alias');
    expect(missing).to.include('ProfileId');
  });

  it('does not flag ProfileId missing when a profile was intended', () => {
    const missing = missingRequiredFieldsForInsert({ Username: 'u', LastName: 'ln' }, true);
    expect(missing).to.not.include('ProfileId');
  });

  it('treats only base62 15 or 18 char as ids', () => {
    expect(isSalesforceId('005000000000001')).to.equal(true);
    expect(isSalesforceId('Admin_Permissions')).to.equal(false);
  });

  // --- errorNoPersonas / errorLegacyPersonaKey ---

  it('records errorNoPersonas when personas is missing', () => {
    const users = validateAndCanonicalizeUsers([{ username: 'u1' }], { admin: {} }, fieldMap);
    expect(users[0].validationErrors?.[0].messageKey).to.equal('errorNoPersonas');
  });

  it('records errorNoPersonas when personas is empty array', () => {
    const users = validateAndCanonicalizeUsers([{ personas: [], username: 'u1' }], { admin: {} }, fieldMap);
    expect(users[0].validationErrors?.[0].messageKey).to.equal('errorNoPersonas');
  });

  it('allows a missing personas key in profile-only mode', () => {
    const users = validateAndCanonicalizeUsers(
      [
        {
          profile: 'Admin',
          role: 'Sales',
          match: 'Username',
          fuzzyUsername: true,
          Username: 'u1',
          Title: 'Contractor',
        },
      ],
      {},
      fieldMap,
      false
    );
    expect(users[0].validationErrors).to.equal(undefined);
    expect(users[0].personas).to.deep.equal([]);
    expect(users[0].profileRef).to.equal('Admin');
    expect(users[0].roleRef).to.equal('Sales');
    expect(users[0].matchField).to.equal('Username');
    expect(users[0].fuzzyUsername).to.equal(true);
    expect(users[0].fields.Title).to.equal('Contractor');
  });

  it('allows an empty personas array in profile-only mode', () => {
    const users = validateAndCanonicalizeUsers(
      [{ personas: [], profile: 'Admin', Username: 'u1' }],
      {},
      fieldMap,
      false
    );
    expect(users[0].validationErrors).to.equal(undefined);
    expect(users[0].personas).to.deep.equal([]);
    expect(users[0].profileRef).to.equal('Admin');
  });

  it('records errorLegacyPersonaKey when the old persona string key is present', () => {
    const users = validateAndCanonicalizeUsers([{ persona: 'admin', username: 'u1' }], { admin: {} }, fieldMap);
    expect(users[0].validationErrors?.[0].messageKey).to.equal('errorLegacyPersonaKey');
  });

  it('records errorLegacyPersonaKey for capitalized variant Persona key (not a whole-run abort)', () => {
    const users = validateAndCanonicalizeUsers([{ Persona: 'admin', username: 'u1' }], { admin: {} }, fieldMap);
    expect(users[0].validationErrors?.[0].messageKey).to.equal('errorLegacyPersonaKey');
  });

  it('keeps the legacy persona key fatal in profile-only mode', () => {
    const users = validateAndCanonicalizeUsers([{ persona: 'admin', Username: 'u1' }], {}, fieldMap, false);
    expect(users[0].validationErrors?.[0].messageKey).to.equal('errorLegacyPersonaKey');
  });

  it('keeps profile and ProfileId conflicts fatal in profile-only mode', () => {
    const users = validateAndCanonicalizeUsers(
      [{ profile: 'Admin', ProfileId: '00e000000000001AAA', Username: 'u1' }],
      {},
      fieldMap,
      false
    );
    expect(users[0].validationErrors?.[0].messageKey).to.equal('errorUserProfileConflict');
  });

  it('defaults all assignment modes to additive without personas', () => {
    const users = validateAndCanonicalizeUsers([{ profile: 'Admin', Username: 'u1' }], {}, fieldMap, false);
    expect(users[0].effectivePersona).to.deep.equal({});
    expect(normalizeMode(users[0].effectivePersona.permissionSetMode)).to.equal('additive');
    expect(normalizeMode(users[0].effectivePersona.permissionSetGroupMode)).to.equal('additive');
    expect(normalizeMode(users[0].effectivePersona.publicGroupMode)).to.equal('additive');
    expect(normalizeMode(users[0].effectivePersona.queueMode)).to.equal('additive');
  });

  it('records errorUnknownPersona for a missing persona name', () => {
    const users = validateAndCanonicalizeUsers([{ personas: ['missing'] }], { admin: {} }, fieldMap);
    expect(users[0].validationErrors?.some((e) => e.messageKey === 'errorUnknownPersona')).to.equal(true);
  });

  // --- mergePersonas: assignment list union ---

  it('unions assignment lists across personas and deduplicates', () => {
    const { effective, errors } = mergePersonas(
      ['a', 'b'],
      {
        a: { permissionSets: ['PS1', 'PS2'], publicGroups: ['G1'] },
        b: { permissionSets: ['PS2', 'PS3'], publicGroups: ['G2'] },
      },
      {},
      fieldMap
    );
    expect(errors).to.have.length(0);
    expect(effective.permissionSets).to.deep.equal(['PS1', 'PS2', 'PS3']);
    expect(effective.publicGroups).to.deep.equal(['G1', 'G2']);
  });

  // --- mergePersonas: profile/role ---

  it('accepts agreed profile across personas', () => {
    const { effective, errors } = mergePersonas(
      ['a', 'b'],
      { a: { profile: 'Admin' }, b: { profile: 'Admin' } },
      {},
      fieldMap
    );
    expect(errors).to.have.length(0);
    expect(effective.profile).to.equal('Admin');
  });

  it('records errorPersonaConflictProfile when profiles differ', () => {
    const { errors } = mergePersonas(['a', 'b'], { a: { profile: 'Admin' }, b: { profile: 'Standard' } }, {}, fieldMap);
    expect(errors.some((e) => e.messageKey === 'errorPersonaConflictProfile')).to.equal(true);
  });

  it('records errorPersonaConflictRole when roles differ', () => {
    const { errors } = mergePersonas(['a', 'b'], { a: { role: 'CEO' }, b: { role: 'CFO' } }, {}, fieldMap);
    expect(errors.some((e) => e.messageKey === 'errorPersonaConflictRole')).to.equal(true);
  });

  // --- mergePersonas: userAttributes ---

  it('records errorPersonaConflictUserAttribute for differing attribute values', () => {
    const { errors } = mergePersonas(
      ['a', 'b'],
      { a: { userAttributes: { Title: 'Dev' } }, b: { userAttributes: { Title: 'Admin' } } },
      {},
      fieldMap
    );
    expect(errors.some((e) => e.messageKey === 'errorPersonaConflictUserAttribute')).to.equal(true);
  });

  it('suppresses userAttribute conflict when user overrides that key', () => {
    const { errors } = mergePersonas(
      ['a', 'b'],
      { a: { userAttributes: { Title: 'Dev' } }, b: { userAttributes: { Title: 'Admin' } } },
      { Title: 'Manager' },
      fieldMap
    );
    expect(errors.some((e) => e.messageKey === 'errorPersonaConflictUserAttribute')).to.equal(false);
  });

  it('detects conflict when persona attributes use different cases for the same canonical field', () => {
    const { errors } = mergePersonas(
      ['a', 'b'],
      { a: { userAttributes: { Title: 'Dev' } }, b: { userAttributes: { title: 'Admin' } } },
      {},
      fieldMap
    );
    expect(errors.some((e) => e.messageKey === 'errorPersonaConflictUserAttribute')).to.equal(true);
  });

  it('suppresses case-variant userAttribute conflict when user overrides the canonical key', () => {
    const { errors } = mergePersonas(
      ['a', 'b'],
      { a: { userAttributes: { Title: 'Dev' } }, b: { userAttributes: { title: 'Admin' } } },
      { Title: 'Manager' },
      fieldMap
    );
    expect(errors.some((e) => e.messageKey === 'errorPersonaConflictUserAttribute')).to.equal(false);
  });

  // --- mergePersonas: modes ---

  it('accepts agreed mode across personas', () => {
    const { effective, errors } = mergePersonas(
      ['a', 'b'],
      { a: { permissionSetMode: 'sync' }, b: { permissionSetMode: 'sync' } },
      {},
      fieldMap
    );
    expect(errors).to.have.length(0);
    expect(effective.permissionSetMode).to.equal('sync');
  });

  it('records errorPersonaConflictMode when modes differ', () => {
    const { errors } = mergePersonas(
      ['a', 'b'],
      { a: { permissionSetMode: 'sync' }, b: { permissionSetMode: 'additive' } },
      {},
      fieldMap
    );
    expect(errors.some((e) => e.messageKey === 'errorPersonaConflictMode')).to.equal(true);
  });

  // --- mergePersonas: profile/role override suppression ---

  it('suppresses errorPersonaConflictProfile when hasProfileOverride is true', () => {
    const { errors } = mergePersonas(
      ['a', 'b'],
      { a: { profile: 'Admin' }, b: { profile: 'Standard' } },
      {},
      fieldMap,
      true
    );
    expect(errors.some((e) => e.messageKey === 'errorPersonaConflictProfile')).to.equal(false);
  });

  it('suppresses errorPersonaConflictRole when hasRoleOverride is true', () => {
    const { errors } = mergePersonas(['a', 'b'], { a: { role: 'CEO' }, b: { role: 'CFO' } }, {}, fieldMap, false, true);
    expect(errors.some((e) => e.messageKey === 'errorPersonaConflictRole')).to.equal(false);
  });

  // --- user-level profile/role meta keys ---

  it('extracts profileRef from user-level profile key', () => {
    const users = validateAndCanonicalizeUsers(
      [{ personas: ['admin'], profile: 'Custom Profile' }],
      { admin: {} },
      fieldMap
    );
    expect(users[0].profileRef).to.equal('Custom Profile');
    expect(users[0].validationErrors).to.equal(undefined);
  });

  it('extracts roleRef from user-level role key', () => {
    const users = validateAndCanonicalizeUsers([{ personas: ['admin'], role: 'SalesRep' }], { admin: {} }, fieldMap);
    expect(users[0].roleRef).to.equal('SalesRep');
    expect(users[0].validationErrors).to.equal(undefined);
  });

  it('records errorUserProfileConflict when profile and ProfileId are both set', () => {
    const users = validateAndCanonicalizeUsers(
      [{ personas: ['admin'], profile: 'Admin', ProfileId: '00exx0000000001AAA' }],
      { admin: {} },
      fieldMap
    );
    expect(users[0].validationErrors?.some((e) => e.messageKey === 'errorUserProfileConflict')).to.equal(true);
  });

  it('records errorUserRoleConflict when role and UserRoleId are both set', () => {
    const users = validateAndCanonicalizeUsers(
      [{ personas: ['admin'], role: 'CEO', UserRoleId: '00Exx0000000001AAA' }],
      { admin: {} },
      fieldMap
    );
    expect(users[0].validationErrors?.some((e) => e.messageKey === 'errorUserRoleConflict')).to.equal(true);
  });

  it('profile key suppresses persona profile conflict (via validateAndCanonicalizeUsers)', () => {
    const users = validateAndCanonicalizeUsers(
      [{ personas: ['a', 'b'], profile: 'Override' }],
      { a: { profile: 'Admin' }, b: { profile: 'Standard' } },
      fieldMap
    );
    expect(users[0].profileRef).to.equal('Override');
    expect(users[0].validationErrors?.some((e) => e.messageKey === 'errorPersonaConflictProfile') ?? false).to.equal(
      false
    );
  });

  it('raw ProfileId suppresses persona profile conflict (via validateAndCanonicalizeUsers)', () => {
    const users = validateAndCanonicalizeUsers(
      [{ personas: ['a', 'b'], ProfileId: '00exx0000000009AAA' }],
      { a: { profile: 'Admin' }, b: { profile: 'Standard' } },
      fieldMap
    );
    expect(users[0].validationErrors?.some((e) => e.messageKey === 'errorPersonaConflictProfile') ?? false).to.equal(
      false
    );
  });

  it('raw UserRoleId suppresses persona role conflict (via validateAndCanonicalizeUsers)', () => {
    const users = validateAndCanonicalizeUsers(
      [{ personas: ['a', 'b'], UserRoleId: '00Exx0000000009AAA' }],
      { a: { role: 'CEO' }, b: { role: 'CFO' } },
      fieldMap
    );
    expect(users[0].validationErrors?.some((e) => e.messageKey === 'errorPersonaConflictRole') ?? false).to.equal(
      false
    );
  });

  it('records errorInvalidUserProfile when profile is not a string', () => {
    const users = validateAndCanonicalizeUsers([{ personas: ['admin'], profile: ['Admin'] }], { admin: {} }, fieldMap);
    expect(users[0].validationErrors?.some((e) => e.messageKey === 'errorInvalidUserProfile')).to.equal(true);
    expect(users[0].profileRef).to.equal(undefined);
  });

  it('records errorInvalidUserRole when role is not a string', () => {
    const users = validateAndCanonicalizeUsers([{ personas: ['admin'], role: 42 }], { admin: {} }, fieldMap);
    expect(users[0].validationErrors?.some((e) => e.messageKey === 'errorInvalidUserRole')).to.equal(true);
    expect(users[0].roleRef).to.equal(undefined);
  });

  it('treats an empty-string profile as absent (no override, no error)', () => {
    const users = validateAndCanonicalizeUsers(
      [{ personas: ['a', 'b'], profile: '   ' }],
      { a: { profile: 'Admin' }, b: { profile: 'Standard' } },
      fieldMap
    );
    expect(users[0].profileRef).to.equal(undefined);
    expect(users[0].validationErrors?.some((e) => e.messageKey === 'errorInvalidUserProfile') ?? false).to.equal(false);
    // With no real override, the persona profile conflict is NOT suppressed.
    expect(users[0].validationErrors?.some((e) => e.messageKey === 'errorPersonaConflictProfile')).to.equal(true);
  });

  // --- buildDefaultAlias ---

  it('buildDefaultAlias: John/Doe -> johdoe', () => {
    expect(buildDefaultAlias('John', 'Doe')).to.equal('johdoe');
  });

  it('buildDefaultAlias: Jo/Anderson -> joande', () => {
    expect(buildDefaultAlias('Jo', 'Anderson')).to.equal('joande');
  });

  it('buildDefaultAlias: Al/Bo -> albo (best-effort 4)', () => {
    expect(buildDefaultAlias('Al', 'Bo')).to.equal('albo');
  });

  it('buildDefaultAlias: A/Anderson -> aander', () => {
    expect(buildDefaultAlias('A', 'Anderson')).to.equal('aander');
  });

  it('buildDefaultAlias: missing first + Anderson -> anders', () => {
    expect(buildDefaultAlias(undefined, 'Anderson')).to.equal('anders');
  });

  it('buildDefaultAlias: both missing -> undefined', () => {
    expect(buildDefaultAlias(undefined, undefined)).to.equal(undefined);
  });

  it('buildDefaultAlias: strips non-alphanumeric characters', () => {
    const alias = buildDefaultAlias('Anne-Marie', "O'Neil");
    expect(alias).to.match(/^[a-z0-9]+$/);
    expect(alias!.length).to.be.lessThanOrEqual(8);
  });

  it('buildDefaultAlias: long names truncate at 8', () => {
    const alias = buildDefaultAlias('Alexander', 'Thompson');
    expect(alias!.length).to.be.lessThanOrEqual(8);
  });

  // --- buildDefaultUsername ---

  it('buildDefaultUsername: produces email.myDomain', () => {
    expect(buildDefaultUsername('user@example.com', 'myorg')).to.equal('user@example.com.myorg');
  });

  it('buildDefaultUsername: empty email -> undefined', () => {
    expect(buildDefaultUsername('', 'myorg')).to.equal(undefined);
  });

  it('buildDefaultUsername: non-string email -> undefined', () => {
    expect(buildDefaultUsername(null, 'myorg')).to.equal(undefined);
  });

  // --- deriveMyDomain ---

  it('deriveMyDomain: prod My Domain -> first label', () => {
    expect(deriveMyDomain('https://mycompany.my.salesforce.com')).to.equal('mycompany');
  });

  it('deriveMyDomain: sandbox host -> name--sbx', () => {
    expect(deriveMyDomain('https://mycompany--sbx.sandbox.my.salesforce.com')).to.equal('mycompany--sbx');
  });

  it('deriveMyDomain: invalid URL -> undefined', () => {
    expect(deriveMyDomain('not-a-url')).to.equal(undefined);
  });
});
