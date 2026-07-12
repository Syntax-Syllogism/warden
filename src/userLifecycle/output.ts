import type { LifecycleNotice, LifecycleResult } from './types.js';

const renderNotice = (notice: LifecycleNotice, lookup: (key: string, args?: string[]) => string): string =>
  lookup(notice.key, notice.count === undefined ? [] : [String(notice.count)]);

export const renderLifecycleResult = (
  result: LifecycleResult,
  lookup: (key: string, args?: string[]) => string
): string => {
  const userSuffix = result.summary.total === 1 ? '' : 's';
  const lines = [
    lookup('info.summary', [
      String(result.summary.total),
      userSuffix,
      String(result.summary.changed),
      String(result.summary.unchanged),
      String(result.summary.failed),
    ]),
  ];
  for (const user of result.users) {
    lines.push('');
    lines.push(`${user.key}${user.id ? ` (${user.id})` : ''}: ${user.status}`);
    for (const warning of user.warnings) lines.push(`  warning: ${warning}`);
    for (const skipped of user.skipped) lines.push(`  skipped: ${renderNotice(skipped, lookup)}`);
    for (const action of user.actions) lines.push(`  action: ${renderNotice(action, lookup)}`);
    for (const error of user.errors) lines.push(`  error: ${error}`);
  }
  return lines.join('\n');
};
