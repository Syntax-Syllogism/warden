import type { Connection } from '@salesforce/core';
import { batch, soqlIn } from '../userShared/sfUtils.js';

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
  PermissionSet?: { IsOwnedByProfile?: boolean };
};

export type GroupMemberRow = {
  Id: string;
  GroupId: string;
  UserOrGroupId: string;
  Group?: { Type?: string };
};

export type PermissionSetLicenseAssignRow = {
  Id: string;
  AssigneeId: string;
  PermissionSetLicenseId: string;
};

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
            `SELECT Id, AssigneeId, PermissionSetId, PermissionSetGroupId, PermissionSet.IsOwnedByProfile FROM PermissionSetAssignment WHERE AssigneeId IN (${inClause})`,
          'AssigneeId'
        )
      : Promise.resolve(new Map<string, PermissionSetAssignmentRow[]>()),
    shouldLoad(options, 'groupMemberships')
      ? queryRowsByUserBatched<GroupMemberRow>(
          conn,
          targetIds,
          (inClause) =>
            `SELECT Id, GroupId, UserOrGroupId, Group.Type FROM GroupMember WHERE UserOrGroupId IN (${inClause}) AND Group.Type IN ('Regular', 'Queue')`,
          'UserOrGroupId'
        )
      : Promise.resolve(new Map<string, GroupMemberRow[]>()),
    shouldLoad(options, 'permissionSetLicenses')
      ? queryRowsByUserBatched<PermissionSetLicenseAssignRow>(
          conn,
          targetIds,
          (inClause) =>
            `SELECT Id, AssigneeId, PermissionSetLicenseId FROM PermissionSetLicenseAssign WHERE AssigneeId IN (${inClause})`,
          'AssigneeId'
        )
      : Promise.resolve(new Map<string, PermissionSetLicenseAssignRow[]>()),
  ]);

  return { userLoginByUserId, psaByUserId, groupByUserId, pslByUserId };
};
