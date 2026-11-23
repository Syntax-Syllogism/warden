import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'chai';
import { CLI_CONTRACT_USAGE } from '../../src/userShared/orgContract.js';

type ContractObject = {
  fields: Record<string, { referenceTo?: string }>;
  childRelationships: Record<string, string>;
};

const readSourceTokens = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return readSourceTokens(path);
    return entry.name.endsWith('.ts') ? readFileSync(path, 'utf8').match(/\bwdn_\w+__(c|r)\b/g) ?? [] : [];
  });

const membersOf = (object: ContractObject): string[] => [
  ...Object.keys(object.fields),
  ...Object.keys(object.childRelationships),
  // Salesforce parent traversal uses the lookup field's API name with the __r suffix.
  ...Object.entries(object.fields).flatMap(([name, field]) => (field.referenceTo ? [name.replace(/__c$/, '__r')] : [])),
];

describe('warden-base contract', () => {
  const contract = JSON.parse(
    readFileSync(new URL('../fixtures/warden-base-contract.json', import.meta.url), 'utf8')
  ) as { objects: Record<string, ContractObject> };
  const sourceTokens = [...new Set(readSourceTokens(fileURLToPath(new URL('../../src/', import.meta.url))))].sort();
  const contractTokens = new Set(
    Object.entries(contract.objects).flatMap(([name, object]) => [name, ...membersOf(object)])
  );
  const usageTokens = new Set(Object.entries(CLI_CONTRACT_USAGE).flatMap(([name, members]) => [name, ...members]));

  it('recognizes every package API name in CLI source', () => {
    expect(
      sourceTokens.filter((token) => !contractTokens.has(token)),
      'names missing from the pinned contract'
    ).to.deep.equal([]);
  });

  it('pins every listed field and relationship to its owning object', () => {
    for (const [name, members] of Object.entries(CLI_CONTRACT_USAGE)) {
      const object = contract.objects[name];
      expect(object, name).to.exist;
      expect(membersOf(object), name).to.include.members(members);
    }
  });

  it('lists every package API name used by the CLI', () => {
    expect(
      sourceTokens.filter((token) => !usageTokens.has(token)),
      'names missing from CLI_CONTRACT_USAGE'
    ).to.deep.equal([]);
  });
});
