import type { UserLoginRow } from './assignmentState.js';
import type {
  LabelBundle,
  LifecycleNotice,
  LifecycleResult,
  LifecycleSummary,
  LifecycleUserResult,
  ResolvedTargetUser,
  TargetError,
} from './types.js';

const sortItems = (items: LabelBundle[]): LabelBundle[] =>
  [...items].sort((left, right) =>
    (left.apiName ?? left.label ?? left.id).localeCompare(right.apiName ?? right.label ?? right.id)
  );

export const makeNotice = (key: string, count?: number, items?: LabelBundle[]): LifecycleNotice => ({
  key,
  ...(count === undefined ? {} : { count }),
  ...(items && items.length > 0 ? { items: sortItems(items) } : {}),
});

/** `planned` counts as changed: a dry run reports what would change. */
export const summarizeLifecycle = (users: LifecycleUserResult[]): LifecycleSummary => ({
  total: users.length,
  changed: users.filter((user) => user.status === 'changed' || user.status === 'planned').length,
  unchanged: users.filter((user) => user.status === 'unchanged').length,
  failed: users.filter((user) => user.status === 'failed').length,
});

export const failedResult = (error: TargetError): LifecycleUserResult => ({
  key: error.key,
  status: 'failed',
  actions: [],
  skipped: [],
  warnings: [],
  errors: [error.message],
});

export const resolvedTargetResult = (
  target: ResolvedTargetUser,
  loginRow?: Pick<UserLoginRow, 'IsFrozen'>
): LifecycleUserResult => ({
  key: target.key,
  id: target.Id,
  name: target.name,
  username: target.username,
  isActive: target.IsActive,
  isFrozen: loginRow?.IsFrozen,
  status: 'unchanged',
  actions: [],
  skipped: [],
  warnings: [],
  errors: [],
});

export type LifecycleCsvRow = {
  userKey: string;
  userId: string;
  userName: string;
  username: string;
  status: string;
  wasFrozen: string;
  action: string;
  category: string;
  name: string;
  error: string;
  itemId: string;
  itemApiName: string;
};

const emptyLifecycleCsvRow = (user: LifecycleResult['users'][number]): LifecycleCsvRow => ({
  userKey: user.key,
  userId: user.id ?? '',
  userName: user.name ?? '',
  username: user.username ?? '',
  status: user.status,
  wasFrozen: user.isFrozen === undefined ? '' : String(user.isFrozen),
  action: '',
  category: '',
  name: '',
  error: '',
  itemId: '',
  itemApiName: '',
});

const itemName = (item: LabelBundle): string => item.apiName ?? item.label ?? item.id;

export const lifecycleToCsvRows = (result: LifecycleResult): LifecycleCsvRow[] => {
  const rows: LifecycleCsvRow[] = [];
  for (const user of result.users) {
    const base = emptyLifecycleCsvRow(user);
    for (const action of user.actions) {
      const items = action.items ? sortItems(action.items) : [];
      if (items.length === 0) {
        rows.push({ ...base, action: action.key });
        continue;
      }
      for (const item of items) {
        rows.push({
          ...base,
          action: action.key,
          category: item.type ?? '',
          name: itemName(item),
          itemId: item.id,
          itemApiName: item.apiName ?? '',
        });
      }
    }
    for (const error of user.errors) rows.push({ ...base, error });
    if (user.actions.length === 0 && user.errors.length === 0) rows.push(base);
  }
  return rows;
};

const renderLabelBundle = (item: LabelBundle): string => {
  if (item.apiName && item.label && item.apiName !== item.label) return `${item.apiName} (${item.label})`;
  return item.apiName ?? item.label ?? item.id;
};

const renderNoticeLines = (notice: LifecycleNotice, lookup: (key: string, args?: string[]) => string): string[] => [
  lookup(notice.key, notice.count === undefined ? [] : [String(notice.count)]),
  ...(notice.items ?? []).map((item) => `    · ${renderLabelBundle(item)}`),
];

const renderUserIdentity = (user: LifecycleResult['users'][number]): string | undefined =>
  user.name && user.username && user.id ? `${user.name} <${user.username}> · ${user.id}` : undefined;

const renderMatchProvenance = (user: LifecycleResult['users'][number]): string => {
  const match = user.key.replace(':', ' = ');
  const state = user.isFrozen ? 'frozen' : user.isActive === false ? 'inactive' : 'active';
  return `  matched ${match} · was ${state}`;
};

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
    const identity = renderUserIdentity(user);
    if (identity) {
      lines.push(identity);
      lines.push(renderMatchProvenance(user));
    } else {
      lines.push(`${user.key}${user.id ? ` (${user.id})` : ''}: ${user.status}`);
    }
    for (const warning of user.warnings) lines.push(`  warning: ${warning}`);
    for (const skipped of user.skipped) {
      const [summary, ...items] = renderNoticeLines(skipped, lookup);
      lines.push(`  skipped: ${summary}`);
      lines.push(...items);
    }
    for (const action of user.actions) {
      const [summary, ...items] = renderNoticeLines(action, lookup);
      lines.push(`  action: ${summary}`);
      lines.push(...items);
    }
    for (const error of user.errors) lines.push(`  error: ${error}`);
  }
  return lines.join('\n');
};
