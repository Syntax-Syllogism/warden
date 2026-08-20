import type { Connection } from '@salesforce/core';
import { batch, soqlIn } from '../userShared/sfUtils.js';
import type { LabelBundle } from './types.js';

export type UserLoginRow = {
  Id: string;
  UserId: string;
  IsFrozen: boolean;
};

export type PermissionSetAssignmentRow = {
  Id: string;
  AssigneeId: string;
  PermissionSetId?: string | null;
  PermissionSetGroupId?: string | null;
  PermissionSet?: { IsOwnedByProfile?: boolean; Name?: string; Label?: string } | null;
  PermissionSetGroup?: { DeveloperName?: string; MasterLabel?: string } | null;
};

export type GroupMemberRow = {
  Id: string;
  GroupId: string;
  UserOrGroupId: string;
  Group?: { Type?: string; DeveloperName?: string; Name?: string } | null;
};

export type PermissionSetLicenseAssignRow = {
  Id: string;
  AssigneeId: string;
  PermissionSetLicenseId: string;
  PermissionSetLicense?: { DeveloperName?: string; MasterLabel?: string } | null;
};

/**
 * Describe a permission set assignment by its group when it came from one,
 * otherwise by the permission set itself. Rows identifying neither assignment
 * type are ignored; loadAssignmentState's query always projects PermissionSetId.
 */
export const permissionSetAssignmentLabel = (row: PermissionSetAssignmentRow): LabelBundle | undefined => {
  if (row.PermissionSetGroupId) {
    return {
      id: row.PermissionSetGroupId,
      apiName: row.PermissionSetGroup?.DeveloperName,
      label: row.PermissionSetGroup?.MasterLabel,
      type: 'PermissionSetGroup',
    };
  }
  if (row.PermissionSetId) {
    return {
      id: row.PermissionSetId,
      apiName: row.PermissionSet?.Name,
      label: row.PermissionSet?.Label,
      type: 'PermissionSet',
    };
  }
  return undefined;
};

export const groupMemberLabel = (row: GroupMemberRow): LabelBundle => ({
  id: row.GroupId,
  apiName: row.Group?.DeveloperName,
  label: row.Group?.Name,
  type: row.Group?.Type === 'Queue' ? 'Queue' : 'PublicGroup',
});

export const permissionSetLicenseLabel = (row: PermissionSetLicenseAssignRow): LabelBundle => ({
  id: row.PermissionSetLicenseId,
  apiName: row.PermissionSetLicense?.DeveloperName,
  label: row.PermissionSetLicense?.MasterLabel,
  type: 'PermissionSetLicense',
});

export type AssignmentState = {
  userLoginByUserId: Map<string, UserLoginRow[]>;
  psaByUserId: Map<string, PermissionSetAssignmentRow[]>;
  groupByUserId: Map<string, GroupMemberRow[]>;
  pslByUserId: Map<string, PermissionSetLicenseAssignRow[]>;
};

export type AssignmentStateOptions = {
  userLogin?: boolean;
  permissionSetAssignments?: boolean;
  groupMemberships?: boolean;
  permissionSetLicenses?: boolean;
};

const QUERY_BATCH_SIZE = 100;

const emptyState = (): AssignmentState => ({
  userLoginByUserId: new Map<string, UserLoginRow[]>(),
  psaByUserId: new Map<string, PermissionSetAssignmentRow[]>(),
  groupByUserId: new Map<string, GroupMemberRow[]>(),
  pslByUserId: new Map<string, PermissionSetLicenseAssignRow[]>(),
});

const queryRowsByUser = async <T extends { [key: string]: unknown }>(
  conn: Pick<Connection, 'query'>,
  soql: string,
  keyField: string
): Promise<Map<string, T[]>> => {
  const rows = ((await conn.query(soql)) as unknown as { records: T[] }).records;
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const key = String(row[keyField] ?? '');
    const group = map.get(key) ?? [];
    group.push(row);
    map.set(key, group);
  }
  return map;
};

const mergeMaps = <T>(maps: Array<Map<string, T[]>>): Map<string, T[]> => {
  const merged = new Map<string, T[]>();
  for (const map of maps) {
    for (const [key, rows] of map.entries()) {
      merged.set(key, (merged.get(key) ?? []).concat(rows));
    }
  }
  return merged;
};

const queryRowsByUserBatched = async <T extends { [key: string]: unknown }>(
  conn: Pick<Connection, 'query'>,
  targetIds: string[],
  buildSoql: (inClause: string) => string,
  keyField: string
): Promise<Map<string, T[]>> => {
  const maps = await Promise.all(
    batch(targetIds, QUERY_BATCH_SIZE).map((idBatch) => queryRowsByUser<T>(conn, buildSoql(soqlIn(idBatch)), keyField))
  );
  return mergeMaps(maps);
};

const shouldLoad = (options: AssignmentStateOptions | undefined, key: keyof AssignmentStateOptions): boolean =>
  options ? options[key] === true : true;

export const loadAssignmentState = async (
  conn: Connection,
  targetIds: string[],
  options?: AssignmentStateOptions
): Promise<AssignmentState> => {
  if (targetIds.length === 0) return emptyState();

  const [userLoginByUserId, psaByUserId, groupByUserId, pslByUserId] = await Promise.all([
    shouldLoad(options, 'userLogin')
      ? queryRowsByUserBatched<UserLoginRow>(
          conn,
          targetIds,
          (inClause) => `SELECT Id, UserId, IsFrozen FROM UserLogin WHERE UserId IN (${inClause})`,
          'UserId'
        )
      : Promise.resolve(new Map<string, UserLoginRow[]>()),
    shouldLoad(options, 'permissionSetAssignments')
      ? queryRowsByUserBatched<PermissionSetAssignmentRow>(
          conn,
          targetIds,
          (inClause) =>
            `SELECT Id, AssigneeId, PermissionSetId, PermissionSetGroupId, PermissionSet.IsOwnedByProfile, PermissionSet.Name, PermissionSet.Label, PermissionSetGroup.DeveloperName, PermissionSetGroup.MasterLabel FROM PermissionSetAssignment WHERE AssigneeId IN (${inClause})`,
          'AssigneeId'
        )
      : Promise.resolve(new Map<string, PermissionSetAssignmentRow[]>()),
    shouldLoad(options, 'groupMemberships')
      ? queryRowsByUserBatched<GroupMemberRow>(
          conn,
          targetIds,
          (inClause) =>
            `SELECT Id, GroupId, UserOrGroupId, Group.Type, Group.DeveloperName, Group.Name FROM GroupMember WHERE UserOrGroupId IN (${inClause}) AND Group.Type IN ('Regular', 'Queue')`,
          'UserOrGroupId'
        )
      : Promise.resolve(new Map<string, GroupMemberRow[]>()),
    shouldLoad(options, 'permissionSetLicenses')
      ? queryRowsByUserBatched<PermissionSetLicenseAssignRow>(
          conn,
          targetIds,
          (inClause) =>
            `SELECT Id, AssigneeId, PermissionSetLicenseId, PermissionSetLicense.DeveloperName, PermissionSetLicense.MasterLabel FROM PermissionSetLicenseAssign WHERE AssigneeId IN (${inClause})`,
          'AssigneeId'
        )
      : Promise.resolve(new Map<string, PermissionSetLicenseAssignRow[]>()),
  ]);

  return { userLoginByUserId, psaByUserId, groupByUserId, pslByUserId };
};
