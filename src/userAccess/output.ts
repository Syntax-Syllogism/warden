import type { AssignmentType, UserAccessRow } from './types.js';

const baseColumns = [
  'userId',
  'userName',
  'username',
  'assignmentType',
  'sourceId',
  'sourceName',
  'viaPermissionSetId',
  'viaPermissionSetName',
  'targetType',
  'targetName',
  'sourceApiName',
  'sourceLabel',
] as const;

export const fieldCsvColumns = (): string[] => [...baseColumns, 'read', 'edit'];
export const enabledCsvColumns = (): string[] => [...baseColumns, 'enabled'];
export const tabCsvColumns = (): string[] => [...baseColumns, 'visibility'];
export const objectCsvColumns = (): string[] => [
  ...baseColumns,
  'read',
  'create',
  'edit',
  'delete',
  'viewAll',
  'modifyAll',
];

const csvValue = (row: UserAccessRow, column: string): unknown => {
  if (column in row.access) return row.access[column as keyof typeof row.access];
  return row[column as keyof UserAccessRow] ?? '';
};

export const flattenAccessRow = (row: UserAccessRow, columns: string[]): Record<string, unknown> =>
  Object.fromEntries(columns.map((column) => [column, csvValue(row, column)]));

const formatVia = (assignmentType: AssignmentType, sourceName: string, viaName?: string): string => {
  if (assignmentType === 'Profile') return `Profile: ${sourceName}`;
  if (assignmentType === 'PermissionSet') return `Permission Set: ${sourceName}`;
  return viaName ? `PSG: ${sourceName} / PS: ${viaName}` : `PSG: ${sourceName}`;
};

const paddedTable = (headers: string[], rows: string[][]): string => {
  const widths = headers.map((header, idx) => Math.max(header.length, ...rows.map((row) => (row[idx] ?? '').length)));
  const render = (cells: string[]): string =>
    cells
      .map((cell, idx) => cell.padEnd(widths[idx]))
      .join('  ')
      .trimEnd();
  return [render(headers), ...rows.map(render)].join('\n');
};

export const renderFieldTable = (rows: UserAccessRow[], showTarget = false): string =>
  paddedTable(
    [...(showTarget ? ['Target'] : []), 'User Name', 'Username', 'Read', 'Edit', 'Via'],
    rows.map((row) => {
      if (row.access.kind !== 'field') throw new Error('Field table received non-field access');
      return [
        ...(showTarget ? [row.targetName] : []),
        row.userName,
        row.username,
        row.access.read ? 'yes' : 'no',
        row.access.edit ? 'yes' : 'no',
        formatVia(row.assignmentType, row.sourceName, row.viaPermissionSetName),
      ];
    })
  );

export const renderObjectTable = (rows: UserAccessRow[]): string =>
  paddedTable(
    ['User Name', 'Username', 'R', 'C', 'E', 'D', 'VA', 'MA', 'Via'],
    rows.map((row) => {
      if (row.access.kind !== 'object') throw new Error('Object table received non-object access');
      const access = row.access;
      return [
        row.userName,
        row.username,
        access.read ? 'Y' : 'N',
        access.create ? 'Y' : 'N',
        access.edit ? 'Y' : 'N',
        access.delete ? 'Y' : 'N',
        access.viewAll ? 'Y' : 'N',
        access.modifyAll ? 'Y' : 'N',
        formatVia(row.assignmentType, row.sourceName, row.viaPermissionSetName),
      ];
    })
  );

export const renderEnabledTable = (rows: UserAccessRow[]): string =>
  paddedTable(
    ['User Name', 'Username', 'Enabled', 'Via'],
    rows.map((row) => {
      if (row.access.kind !== 'enabled') throw new Error('Enabled table received non-enabled access');
      return [
        row.userName,
        row.username,
        row.access.enabled ? 'yes' : 'no',
        formatVia(row.assignmentType, row.sourceName, row.viaPermissionSetName),
      ];
    })
  );

export const renderTabTable = (rows: UserAccessRow[]): string =>
  paddedTable(
    ['User Name', 'Username', 'Visibility', 'Via'],
    rows.map((row) => {
      if (row.access.kind !== 'tab') throw new Error('Tab table received non-tab access');
      return [
        row.userName,
        row.username,
        row.access.visibility,
        formatVia(row.assignmentType, row.sourceName, row.viaPermissionSetName),
      ];
    })
  );
