import { expect } from 'chai';
import type { AssignmentCategoryDelta } from '../../src/userProvisioning/assignmentPlan.js';
import type { UserAssignmentDiff, UserDiffResult } from '../../src/userLifecycle/userDiff.js';
import { verifyUserDiff } from '../../src/userLifecycle/conformance.js';

const emptyCategory = (mode?: 'additive' | 'sync'): AssignmentCategoryDelta => ({
  adds: [],
  removes: [],
  inBoth: [],
  onlyInOrg: [],
  ...(mode ? { mode } : {}),
});

const makeUser = (key: string, overrides: Partial<UserAssignmentDiff> = {}): UserAssignmentDiff => ({
  key,
  status: 'compared',
  profile: { matches: true },
  role: { matches: true },
  assignments: {
    permissionSets: emptyCategory('additive'),
    permissionSetGroups: emptyCategory('additive'),
    publicGroups: emptyCategory('additive'),
    queues: emptyCategory('additive'),
  },
  errors: [],
  ...overrides,
});

const lookup = (key: string, args: string[] = []): string => {
  const messages: Record<string, string> = {
    'verify.violation.notFound': 'not found',
    'verify.violation.error': `error: ${args[0]}`,
    'verify.violation.missing': `${args[0]} missing: ${args[1]}`,
    'verify.violation.extra': `${args[0]} extra (sync): ${args[1]}`,
    'verify.violation.profile': `profile mismatch: ${args[0]} -> ${args[1]}`,
    'verify.violation.role': `role mismatch: ${args[0]} -> ${args[1]}`,
  };
  return messages[key] ?? key;
};

describe('user diff conformance', () => {
  it('reports each conformance status without changing the diff result', () => {
    const result: UserDiffResult = {
      summary: { total: 5, compared: 3, wouldCreate: 1, failed: 1, changed: 2 },
      warnings: [],
      rows: [],
      users: [
        makeUser('conformant'),
        makeUser('missing', {
          assignments: {
            permissionSets: { ...emptyCategory('additive'), adds: ['MissingPerm'] },
            permissionSetGroups: emptyCategory('additive'),
            publicGroups: emptyCategory('additive'),
            queues: emptyCategory('additive'),
          },
        }),
        makeUser('extra', {
          assignments: {
            permissionSets: { ...emptyCategory('sync'), removes: ['ExtraPerm'], onlyInOrg: ['ExtraPerm'] },
            permissionSetGroups: emptyCategory('additive'),
            publicGroups: emptyCategory('additive'),
            queues: emptyCategory('additive'),
          },
        }),
        makeUser('would-create', { status: 'would-create' }),
        makeUser('failed', { status: 'failed', errors: ['validation failed'] }),
      ],
    };

    expect(verifyUserDiff(result, lookup)).to.deep.equal([
      { key: 'conformant', conformant: true, violations: [] },
      { key: 'missing', conformant: false, violations: ['permissionSets missing: MissingPerm'] },
      { key: 'extra', conformant: false, violations: ['permissionSets extra (sync): ExtraPerm'] },
      { key: 'would-create', conformant: false, violations: ['not found'] },
      { key: 'failed', conformant: false, violations: ['error: validation failed'] },
    ]);
    expect(result.users).to.have.length(5);
  });
});
