import { serializeCsv } from '../userShared/csv.js';
import type { AssignmentCategoryDelta, AssignmentDelta } from '../userProvisioning/assignmentPlan.js';
import type { UserAssignmentDiff, UserDiffResult } from './userDiff.js';
import { displayValue, type MessageLookup } from './diffOutput.js';

export type UserConformanceVerdict = {
  key: string;
  conformant: boolean;
  violations: string[];
};

const conformanceViolationsForCategory = (
  result: UserDiffResult,
  category: keyof AssignmentDelta,
  delta: AssignmentCategoryDelta,
  lookup: MessageLookup
): string[] => {
  const violations: string[] = [];
  if (delta.adds.length > 0) {
    violations.push(
      lookup('verify.violation.missing', [category, delta.adds.map((value) => displayValue(result, value)).join(', ')])
    );
  }
  if (delta.mode === 'sync' && delta.removes.length > 0) {
    violations.push(
      lookup('verify.violation.extra', [category, delta.removes.map((value) => displayValue(result, value)).join(', ')])
    );
  }
  return violations;
};

const conformanceViolationsForUser = (
  result: UserDiffResult,
  user: UserAssignmentDiff,
  lookup: MessageLookup
): string[] => {
  if (user.status === 'would-create') return [lookup('verify.violation.notFound')];
  if (user.status === 'failed') {
    return user.errors.length > 0
      ? user.errors.map((error) => lookup('verify.violation.error', [error]))
      : [lookup('verify.violation.error', ['user diff failed'])];
  }

  const violations: string[] = [];
  if (!user.profile.matches) {
    violations.push(
      lookup('verify.violation.profile', [
        displayValue(result, user.profile.current ?? ''),
        displayValue(result, user.profile.intended ?? ''),
      ])
    );
  }
  if (!user.role.matches) {
    violations.push(
      lookup('verify.violation.role', [
        displayValue(result, user.role.current ?? ''),
        displayValue(result, user.role.intended ?? ''),
      ])
    );
  }
  for (const [category, delta] of Object.entries(user.assignments) as Array<
    [keyof AssignmentDelta, AssignmentCategoryDelta]
  >) {
    violations.push(...conformanceViolationsForCategory(result, category, delta, lookup));
  }
  return violations;
};

export const verifyUserDiff = (
  result: UserDiffResult,
  lookup: MessageLookup
): UserConformanceVerdict[] =>
  result.users.map((user) => {
    const violations = conformanceViolationsForUser(result, user, lookup);
    return { key: user.key, conformant: violations.length === 0, violations };
  });

export const renderUserConformanceCsv = (verdicts: UserConformanceVerdict[]): string =>
  serializeCsv(
    verdicts.map((verdict) => ({
      key: verdict.key,
      conformant: String(verdict.conformant),
      violations: verdict.violations.join('; '),
    })),
    ['key', 'conformant', 'violations']
  );

export const renderUserConformanceHuman = (
  verdicts: UserConformanceVerdict[],
  lookup: MessageLookup
): string => {
  const conformant = verdicts.filter((verdict) => verdict.conformant).length;
  const nonConformant = verdicts.length - conformant;
  const lines = [lookup('verify.summary', [String(verdicts.length), String(conformant), String(nonConformant)])];
  for (const verdict of verdicts.filter((candidate) => !candidate.conformant)) {
    lines.push('', lookup('verify.user', [verdict.key]));
    for (const violation of verdict.violations) lines.push(`  - ${violation}`);
  }
  return lines.join('\n');
};
