import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'chai';
import {
  csvEscape,
  detectInputFormat,
  neutralizeCsvFormula,
  readCsvUsers,
  serializeCsv,
} from '../../src/userShared/csv.js';
import { readUsersDefinition } from '../../src/userProvisioning/definitionReader.js';
import { buildFieldMap, validateAndCanonicalizeUsers } from '../../src/userProvisioning/planner.js';
import UserDiff from '../../src/commands/warden/diff.js';
import UserFreeze from '../../src/commands/warden/freeze.js';
import UserProvision from '../../src/commands/warden/provision.js';
import UserSnapshot from '../../src/commands/warden/snapshot.js';
import UserStrip from '../../src/commands/warden/strip.js';
import UserUnfreeze from '../../src/commands/warden/unfreeze.js';

const fieldMap = buildFieldMap([
  { name: 'Username', createable: true, updateable: true, filterable: true },
  { name: 'FederationIdentifier', createable: true, updateable: true, filterable: true, externalId: true },
  { name: 'Employee_ID__c', createable: true, updateable: true, filterable: true },
  { name: 'FirstName', createable: true, updateable: true, filterable: true },
  { name: 'LastName', createable: true, updateable: true, filterable: true },
  { name: 'Email', createable: true, updateable: true, filterable: true },
  { name: 'Title', createable: true, updateable: true, filterable: true },
  { name: 'IsActive', createable: true, updateable: true, filterable: true, isBoolean: true },
]);

const withCsv = async <T>(
  contents: string,
  callback: (path: string) => Promise<T>,
  fileName = 'users.csv'
): Promise<T> => {
  const directory = await mkdtemp(join(tmpdir(), 'warden-csv-'));
  const path = join(directory, fileName);
  await writeFile(path, contents, 'utf8');
  try {
    return await callback(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

const expectCsvError = async (contents: string, expected: string): Promise<void> => {
  await withCsv(contents, async (path) => {
    try {
      await readCsvUsers(path, fieldMap);
      expect.fail('Expected CSV parsing to fail');
    } catch (error) {
      expect(error).to.be.instanceOf(Error);
      expect((error as Error).message).to.contain(expected);
    }
  });
};

describe('shared csv output', () => {
  it('escapes all CSV control cases consistently', () => {
    expect(csvEscape('plain')).to.equal('plain');
    expect(csvEscape('a,b')).to.equal('"a,b"');
    expect(csvEscape('a"b')).to.equal('"a""b"');
    expect(csvEscape('line\nbreak')).to.equal('"line\nbreak"');
    expect(csvEscape('line\r\nbreak')).to.equal('"line\r\nbreak"');
    expect(csvEscape('"')).to.equal('""""');
  });

  it('serializes flattened rows with a stable header', () => {
    expect(serializeCsv([{ id: '2' }, { id: '1' }], ['id'])).to.equal('id\n2\n1');
  });

  it('neutralizes formula-like cells once on write', () => {
    for (const value of ['=1', '+1', '-1', '@name', '\tvalue', '\rvalue']) {
      expect(neutralizeCsvFormula(value)).to.equal(`'${value}`);
      expect(neutralizeCsvFormula(`'${value}`)).to.equal(`'${value}`);
    }
    expect(csvEscape('=1')).to.equal("'=1");
  });

  it('infers and overrides input formats', () => {
    expect(detectInputFormat('users.csv')).to.equal('csv');
    expect(detectInputFormat('USERS.CSV')).to.equal('csv');
    expect(detectInputFormat('users.tsv')).to.equal('csv');
    expect(detectInputFormat('users.json')).to.equal('json');
    expect(detectInputFormat('users.data')).to.equal('json');
    expect(detectInputFormat('users.data', 'csv')).to.equal('csv');
    expect(detectInputFormat('users.csv', 'json')).to.equal('json');
  });

  it('parses inferred TSV and explicit format overrides', async () => {
    await withCsv(
      'personas\tEmail\nops\tana@example.com\n',
      async (path) => {
        expect((await readCsvUsers(path, fieldMap)).users).to.deep.equal([
          { personas: ['ops'], Email: 'ana@example.com' },
        ]);
      },
      'users.tsv'
    );
    await withCsv(
      '{"users":[{"Email":"ana@example.com"}]}',
      async (path) => {
        expect((await readUsersDefinition(path, { fieldMap, inputFormat: 'json' })).users).to.deep.equal([
          { Email: 'ana@example.com' },
        ]);
      },
      'users.csv'
    );
    await withCsv(
      'Email\nana@example.com\n',
      async (path) => {
        expect((await readUsersDefinition(path, { fieldMap, inputFormat: 'csv' })).users).to.deep.equal([
          { Email: 'ana@example.com' },
        ]);
      },
      'users.json'
    );
  });

  it('exposes format controls on every users-def command', () => {
    for (const command of [UserProvision, UserDiff, UserFreeze, UserUnfreeze, UserStrip, UserSnapshot]) {
      expect(command.flags).to.have.property('input-format');
      expect(command.flags).to.have.property('csv-list-delimiter');
    }
  });

  it('produces the same canonical users as equivalent JSON', async () => {
    const csv = await readFile(new URL('../fixtures/users.csv', import.meta.url), 'utf8');
    await withCsv(csv, async (path) => {
      const csvUsers = (await readCsvUsers(path, fieldMap)).users;
      const jsonUsers = [
        {
          personas: ['ops', 'support'],
          match: 'FederationIdentifier',
          fuzzyUsername: true,
          FederationIdentifier: 'ABC123',
          FirstName: 'Ana',
          LastName: 'Park',
          Email: 'apark@acme.com',
        },
        {
          personas: ['finance'],
          match: 'Employee_ID__c',
          ['Employee_ID__c']: '00123',
          FirstName: 'Ravi',
          LastName: 'Suresh',
          Email: 'rsuresh@acme.com',
        },
      ];
      expect(
        validateAndCanonicalizeUsers(csvUsers, { ops: {}, support: {}, finance: {} }, fieldMap, true)
      ).to.deep.equal(validateAndCanonicalizeUsers(jsonUsers, { ops: {}, support: {}, finance: {} }, fieldMap, true));
    });
  });

  it('preserves strings, parses booleans, and handles BOM, CRLF, quoting, and embedded newlines', async () => {
    const contents = '\ufeffEmployee_ID__c,IsActive,Title,Email\r\n00123,YES,"Support,\r\nLead ""now""","  "\r\n';
    await withCsv(contents, async (path) => {
      const users = (await readCsvUsers(path, fieldMap)).users;
      expect(users).to.deep.equal([
        { ['Employee_ID__c']: '00123', IsActive: true, Title: 'Support,\r\nLead "now"', Email: '  ' },
      ]);
    });
  });

  it('supports a custom list delimiter and omits empty cells', async () => {
    await withCsv('personas,LastName\n"ops | support",\n', async (path) => {
      const users = (await readCsvUsers(path, fieldMap, '|')).users;
      expect(users[0]).to.deep.equal({ personas: ['ops', 'support'] });
    });
  });

  it('rejects malformed headers, booleans, and row widths with file and physical line', async () => {
    await expectCsvError('Email,email\na,b\n', 'users.csv:1 — Duplicate column "email".');
    await expectCsvError('Emial\na\n', 'Unknown column "Emial"; did you mean "Email"?');
    await expectCsvError('IsActive\nmaybe\n', 'users.csv:2 — IsActive must be a boolean');
    await expectCsvError(
      'Email,LastName\n"first\nname",Doe\nonly-one\n',
      'users.csv:4 — Expected 2 cells but found 1.'
    );
    await expectCsvError(
      'Email,LastName\nfirst@example.com,First\n\nsecond@example.com,Second\n',
      'users.csv:3 — Expected 2 cells but found 1.'
    );
  });

  it('rejects unsupported boolean values instead of coercing them', async () => {
    await expectCsvError('fuzzyUsername\ntrue-ish\n', 'fuzzyUsername must be a boolean');
  });

  it('round-trips the worked fixture as UTF-8 text', async () => {
    const fixture = await readFile(new URL('../fixtures/users.csv', import.meta.url), 'utf8');
    expect(fixture).to.contain('personas');
    const users = (await withCsv(fixture, (path) => readCsvUsers(path, fieldMap))).users;
    const canonical = validateAndCanonicalizeUsers(users, { ops: {}, support: {}, finance: {} }, fieldMap, true);
    expect(canonical[0].fields.FederationIdentifier).to.equal('ABC123');
    expect(canonical[1].fields['Employee_ID__c']).to.equal('00123');
  });

  it('retains the physical source line after embedded newlines', async () => {
    await withCsv('Email,LastName\n"first\nuser@example.com",First\nsecond@example.com,\n', async (path) => {
      const users = (await readCsvUsers(path, fieldMap)).users;
      const canonical = validateAndCanonicalizeUsers(users, {}, fieldMap, false);
      expect(canonical[1].source).to.deep.equal({ path, line: 4 });
    });
  });
});
