import type { Connection } from '@salesforce/core';
import { queryAllInChunks, soqlIn } from './soql.js';
import type { AccessTargetType, UserAccessResult, UserAccessRow, UserAccessStats } from './types.js';

export type PermissionSetParent = {
  Id: string;
  Name?: string;
  DeveloperName?: string;
  Label?: string;
  MasterLabel?: string;
  Type?: string;
  IsOwnedByProfile?: boolean;
  ProfileId?: string;
  Profile?: { Name?: string };
};

type PsgComponentRow = {
  PermissionSetGroupId: string;
  PermissionSetId: string;
  PermissionSetGroup?: { DeveloperName?: string; MasterLabel?: string };
  PermissionSet?: { Name?: string; Type?: string };
};

type AssignmentRow = {
  Id: string;
  AssigneeId: string;
  Assignee?: { Name?: string; Username?: string; IsActive?: boolean };
  PermissionSetId?: string;
  PermissionSet?: PermissionSetParent;
  PermissionSetGroupId?: string;
  PermissionSetGroup?: { DeveloperName?: string; MasterLabel?: string };
};

export type AccessBuildContext = {
  assignmentType: 'PermissionSet' | 'PermissionSetGroup';
  permissionSetId: string;
  psgId?: string;
};

export type BuildAccess<TGrant, TAccess extends UserAccessRow['access']> = (
  grant: TGrant,
  context: AccessBuildContext
) => TAccess | undefined;

export type AssigneeResolutionOptions = {
  preparePsg?: (psgIds: string[]) => Promise<void>;
};

export const computeStats = (rows: UserAccessRow[]): UserAccessStats => ({
  totalActiveUsersWithAccess: new Set(rows.map((row) => row.userId)).size,
  profileGrants: new Set(rows.filter((row) => row.assignmentType === 'Profile').map((row) => row.sourceId)).size,
  permissionSetGrants: new Set(rows.filter((row) => row.assignmentType === 'PermissionSet').map((row) => row.sourceId))
    .size,
  permissionSetGroupGrants: new Set(
    rows.filter((row) => row.assignmentType === 'PermissionSetGroup').map((row) => row.sourceId)
  ).size,
});

const keyFor = (row: UserAccessRow): string =>
  [row.userId, row.assignmentType, row.sourceId, row.viaPermissionSetId ?? ''].join('|');

// eslint-disable-next-line complexity
export async function resolveAssignees<TGrant, TAccess extends UserAccessRow['access']>(
  conn: Connection,
  targetType: AccessTargetType,
  targetName: string,
  grantByPermissionSetId: Map<string, TGrant>,
  permissionSetById: Map<string, PermissionSetParent>,
  buildAccess: BuildAccess<TGrant, TAccess>,
  options: AssigneeResolutionOptions = {}
): Promise<UserAccessRow[]> {
  const directPermissionSetIds = [...grantByPermissionSetId.keys()].filter(
    (id) => permissionSetById.get(id)?.Type !== 'Group'
  );
  const componentPermissionSetIds = directPermissionSetIds.filter((id) => !permissionSetById.get(id)?.IsOwnedByProfile);
  const psgComponentRows = await queryAllInChunks<PsgComponentRow>(conn, componentPermissionSetIds, (chunk) =>
    [
      'SELECT PermissionSetGroupId, PermissionSetGroup.DeveloperName, PermissionSetGroup.MasterLabel, PermissionSetId, PermissionSet.Name, PermissionSet.Type',
      'FROM PermissionSetGroupComponent',
      `WHERE PermissionSetId IN (${soqlIn(chunk)})`,
    ].join(' ')
  );
  const psgByPermissionSetId = new Map<string, Array<{ psgId: string; psgName: string }>>();
  const psgNameById = new Map<string, string>();
  const psgApiNameById = new Map<string, string>();
  const psgLabelById = new Map<string, string>();
  for (const row of psgComponentRows) {
    if (row.PermissionSetGroup?.DeveloperName) {
      psgApiNameById.set(row.PermissionSetGroupId, row.PermissionSetGroup.DeveloperName);
    }
    if (row.PermissionSetGroup?.MasterLabel) {
      psgLabelById.set(row.PermissionSetGroupId, row.PermissionSetGroup.MasterLabel);
    }
    const psgName =
      row.PermissionSetGroup?.MasterLabel ??
      row.PermissionSetGroup?.DeveloperName ??
      psgNameById.get(row.PermissionSetGroupId) ??
      '(Unnamed Permission Set Group)';
    psgNameById.set(row.PermissionSetGroupId, psgName);
    const entries = psgByPermissionSetId.get(row.PermissionSetId) ?? [];
    entries.push({ psgId: row.PermissionSetGroupId, psgName });
    psgByPermissionSetId.set(row.PermissionSetId, entries);
  }
  const psgIds = [...new Set(psgComponentRows.map((row) => row.PermissionSetGroupId))];
  await options.preparePsg?.(psgIds);

  if (directPermissionSetIds.length === 0 && psgIds.length === 0) return [];

  const assignmentRowsById = new Map<string, AssignmentRow>();
  const assignmentSelect = [
    'SELECT Id, AssigneeId, Assignee.Name, Assignee.Username, Assignee.IsActive, PermissionSetId, PermissionSet.Name, PermissionSet.IsOwnedByProfile, PermissionSet.ProfileId, PermissionSet.Profile.Name, PermissionSet.Type, PermissionSetGroupId, PermissionSetGroup.DeveloperName, PermissionSetGroup.MasterLabel',
    'FROM PermissionSetAssignment',
    'WHERE Assignee.IsActive = true',
  ];
  const assignmentRowsByPermissionSet = await queryAllInChunks<AssignmentRow>(conn, directPermissionSetIds, (chunk) =>
    [...assignmentSelect, `AND PermissionSetId IN (${soqlIn(chunk)})`, 'ORDER BY Assignee.Name, Id'].join(' ')
  );
  for (const row of assignmentRowsByPermissionSet) assignmentRowsById.set(row.Id, row);
  const assignmentRowsByPsg = await queryAllInChunks<AssignmentRow>(conn, psgIds, (chunk) =>
    [...assignmentSelect, `AND PermissionSetGroupId IN (${soqlIn(chunk)})`, 'ORDER BY Assignee.Name, Id'].join(' ')
  );
  for (const row of assignmentRowsByPsg) assignmentRowsById.set(row.Id, row);

  const rowsByKey = new Map<string, UserAccessRow>();
  for (const row of assignmentRowsById.values()) {
    if (row.Assignee?.IsActive === false) continue;
    const userName = row.Assignee?.Name ?? row.AssigneeId;
    const username = row.Assignee?.Username ?? '';
    if (row.PermissionSetId && grantByPermissionSetId.has(row.PermissionSetId)) {
      const parent = permissionSetById.get(row.PermissionSetId) ?? row.PermissionSet;
      if (parent?.Type !== 'Group') {
        const context: AccessBuildContext = { assignmentType: 'PermissionSet', permissionSetId: row.PermissionSetId };
        const grant = grantByPermissionSetId.get(row.PermissionSetId);
        const access = grant === undefined ? undefined : buildAccess(grant, context);
        if (access !== undefined) {
          const isProfile = parent?.IsOwnedByProfile === true;
          const resolvedRow: UserAccessRow = {
            userId: row.AssigneeId,
            userName,
            username,
            targetType,
            targetName,
            assignmentType: isProfile ? 'Profile' : 'PermissionSet',
            sourceId: isProfile ? parent?.ProfileId ?? row.PermissionSetId : row.PermissionSetId,
            sourceName: isProfile
              ? parent?.Profile?.Name ?? parent?.Name ?? 'Profile'
              : parent?.Name ?? row.PermissionSetId,
            sourceApiName: parent?.DeveloperName ?? parent?.Name ?? row.PermissionSetId,
            sourceLabel:
              parent?.MasterLabel ?? parent?.Label ?? parent?.Profile?.Name ?? parent?.Name ?? row.PermissionSetId,
            access,
          };
          rowsByKey.set(keyFor(resolvedRow), resolvedRow);
        }
      }
    }
    if (row.PermissionSetGroupId) {
      const entries = [...psgByPermissionSetId.entries()]
        .filter(([, psgEntries]) => psgEntries.some((entry) => entry.psgId === row.PermissionSetGroupId))
        .flatMap(([permissionSetId, psgEntries]) =>
          psgEntries.filter((entry) => entry.psgId === row.PermissionSetGroupId).map(() => permissionSetId)
        );
      for (const permissionSetId of entries) {
        const grantingAccess = grantByPermissionSetId.get(permissionSetId);
        if (grantingAccess === undefined) continue;
        const context: AccessBuildContext = {
          assignmentType: 'PermissionSetGroup',
          permissionSetId,
          psgId: row.PermissionSetGroupId,
        };
        const access = buildAccess(grantingAccess, context);
        if (access === undefined) continue;
        const sourceName =
          row.PermissionSetGroup?.MasterLabel ??
          row.PermissionSetGroup?.DeveloperName ??
          psgNameById.get(row.PermissionSetGroupId) ??
          row.PermissionSetGroupId;
        const resolvedRow: UserAccessRow = {
          userId: row.AssigneeId,
          userName,
          username,
          targetType,
          targetName,
          assignmentType: 'PermissionSetGroup',
          sourceId: row.PermissionSetGroupId,
          sourceName,
          sourceApiName:
            row.PermissionSetGroup?.DeveloperName ??
            psgApiNameById.get(row.PermissionSetGroupId) ??
            row.PermissionSetGroupId,
          sourceLabel: row.PermissionSetGroup?.MasterLabel ?? psgLabelById.get(row.PermissionSetGroupId) ?? sourceName,
          viaPermissionSetId: permissionSetId,
          viaPermissionSetName: permissionSetById.get(permissionSetId)?.Name ?? permissionSetId,
          access,
        };
        rowsByKey.set(keyFor(resolvedRow), resolvedRow);
      }
    }
  }
  return [...rowsByKey.values()];
}

export const resultFor = (
  targetType: AccessTargetType,
  targetName: string,
  rows: UserAccessRow[],
  warnings: string[] = [],
  extras: Pick<UserAccessResult, 'sobjectType' | 'fieldApiName'> = {}
): UserAccessResult => ({
  targetType,
  targetName,
  ...extras,
  rows,
  stats: computeStats(rows),
  warnings,
});
