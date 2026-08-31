import { serializeCsv } from '../userShared/csv.js';
import type { AssignmentCategoryDelta, AssignmentDelta } from '../userProvisioning/assignmentPlan.js';
import type { DiffField, UserDiffResult } from './userDiff.js';

export type MessageLookup = (key: string, args?: string[]) => string;

export const renderUserDiffCsv = (result: UserDiffResult): string => {
  const header = [
    'userKey',
    'userId',
    'category',
    'kind',
    'value',
    'mode',
    'userName',
    'username',
    'valueApiName',
    'valueLabel',
    'valueType',
    'valueBefore',
    'valueAfter',
  ];
  return serializeCsv(
    result.rows.map((row) => {
      const label = result.labels?.[row.value] ?? (row.valueAfter ? result.labels?.[row.valueAfter] : undefined);
      return {
        userKey: row.userKey,
        userId: row.userId,
        category: row.category,
        kind: row.kind,
        value: row.value,
        mode: row.mode ?? '',
        userName: row.userName ?? '',
        username: row.username ?? '',
        valueApiName: label?.apiName ?? '',
        valueLabel: label?.label ?? '',
        valueType: label?.type ?? '',
        valueBefore: row.valueBefore ?? '',
        valueAfter: row.valueAfter ?? '',
      };
    }),
    header
  );
};

export const displayValue = (result: UserDiffResult, value: string): string =>
  result.labels?.[value]
    ? result.labels[value].apiName &&
      result.labels[value].label &&
      result.labels[value].apiName !== result.labels[value].label
      ? `${result.labels[value].apiName} (${result.labels[value].label})`
      : result.labels[value].apiName ?? result.labels[value].label ?? value
    : value;

const renderFieldDiff = (result: UserDiffResult, label: 'profile' | 'role', field: DiffField): string | undefined =>
  field.matches
    ? undefined
    : `  ${label}: ${displayValue(result, field.current ?? '')} -> ${displayValue(result, field.intended ?? '')}`;

const renderCategoryDiff = (
  result: UserDiffResult,
  label: keyof AssignmentDelta,
  delta: AssignmentCategoryDelta,
  verbose: boolean
): string[] => {
  if (
    delta.adds.length === 0 &&
    delta.removes.length === 0 &&
    delta.inBoth.length === 0 &&
    delta.onlyInOrg.length === 0
  ) {
    return [];
  }
  const lines = [`  ${label}${delta.mode ? ` (${delta.mode})` : ''}:`];
  for (const value of delta.adds) lines.push(`    + ${displayValue(result, value)}`);
  for (const value of delta.removes) lines.push(`    - ${displayValue(result, value)}`);
  if (verbose) for (const value of delta.inBoth) lines.push(`    = ${displayValue(result, value)}`);
  // onlyInOrg is exclusive of removes by construction.
  for (const value of delta.onlyInOrg) {
    lines.push(`    extra ${displayValue(result, value)}`);
  }
  return lines;
};

export const renderUserDiffHuman = (
  result: UserDiffResult,
  lookup: MessageLookup,
  options: { verbose?: boolean } = {}
): string => {
  const lines = [
    lookup('info.summary', [String(result.summary.total), String(result.summary.changed), String(result.summary.failed)]),
  ];
  for (const warning of result.warnings) lines.push(`warning: ${warning}`);
  for (const user of result.users) {
    lines.push('', `${user.key}${user.id ? ` (${user.id})` : ''}: ${user.status}`);
    for (const error of user.errors) lines.push(`  error: ${error}`);
    const profileLine = renderFieldDiff(result, 'profile', user.profile);
    const roleLine = renderFieldDiff(result, 'role', user.role);
    if (profileLine) lines.push(profileLine);
    if (roleLine) lines.push(roleLine);
    for (const [label, delta] of Object.entries(user.assignments) as Array<
      [keyof AssignmentDelta, AssignmentCategoryDelta]
    >) {
      lines.push(...renderCategoryDiff(result, label, delta, options.verbose === true));
    }
  }
  return lines.join('\n');
};
