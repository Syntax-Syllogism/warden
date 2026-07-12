import type { Connection } from '@salesforce/core';
import { resolveAssignees, resultFor, type PermissionSetParent } from '../assignees.js';
import { queryAll, queryAllInChunks, soqlIn } from '../soql.js';
import { objectCsvColumns } from '../output.js';
import { validateObjectTarget } from '../targetValidation.js';
import type { AccessTargetResolver, ObjectAccess, UserAccessResult, ValidatedAccessTarget } from '../types.js';
import { UserAccessError } from '../types.js';

type ObjectPermissionRecord = {
  ParentId: string;
  Parent?: PermissionSetParent;
  PermissionsRead?: boolean;
  PermissionsCreate?: boolean;
  PermissionsEdit?: boolean;
  PermissionsDelete?: boolean;
  PermissionsViewAllRecords?: boolean;
  PermissionsModifyAllRecords?: boolean;
};

type MutingPermissionRow = ObjectPermissionRecord;
type PsgComponentRow = { PermissionSetGroupId: string; PermissionSetId: string };

const truthy = (value: boolean | undefined): boolean => value === true;
const toObjectAccess = (row: ObjectPermissionRecord): ObjectAccess => ({
  kind: 'object',
  read: truthy(row.PermissionsRead),
  create: truthy(row.PermissionsCreate),
  edit: truthy(row.PermissionsEdit),
  delete: truthy(row.PermissionsDelete),
  viewAll: truthy(row.PermissionsViewAllRecords),
  modifyAll: truthy(row.PermissionsModifyAllRecords),
});
const anyAccess = (access: ObjectAccess): boolean =>
  access.read || access.create || access.edit || access.delete || access.viewAll || access.modifyAll;

export const objectResolver: AccessTargetResolver = {
  type: 'object',
  validateTarget: validateObjectTarget,
  async resolve(conn: Connection, target: ValidatedAccessTarget): Promise<UserAccessResult> {
    if (!target.sobjectType) throw new UserAccessError('errorInvalidTarget', [target.targetName]);
    const warnings: string[] = [];
    try {
      const entitlementRows = await queryAll<ObjectPermissionRecord>(
        conn,
        [
          'SELECT ParentId, Parent.Id, Parent.Name, Parent.IsOwnedByProfile, Parent.ProfileId, Parent.Profile.Name, Parent.Type, PermissionsRead, PermissionsCreate, PermissionsEdit, PermissionsDelete, PermissionsViewAllRecords, PermissionsModifyAllRecords',
          'FROM ObjectPermissions',
          `WHERE SobjectType = '${target.sobjectType}'`,
          "AND Parent.Type != 'Muting'",
        ].join(' ')
      );
      const grantByPermissionSetId = new Map<string, ObjectAccess>();
      const permissionSetById = new Map<string, PermissionSetParent>();
      for (const row of entitlementRows) {
        const access = toObjectAccess(row);
        if (!anyAccess(access)) continue;
        grantByPermissionSetId.set(row.ParentId, access);
        if (row.Parent) permissionSetById.set(row.ParentId, { ...row.Parent, Id: row.ParentId });
      }
      if (grantByPermissionSetId.size === 0) return resultFor('object', target.sobjectType, [], warnings, { sobjectType: target.sobjectType });

      const mutingAccessByPsId = new Map<string, ObjectAccess>();
      const mutingByPsgId = new Map<string, string[]>();
      const preparePsg = async (psgIds: string[]): Promise<void> => {
        if (psgIds.length === 0) return;
        const mutingComponents = await queryAllInChunks<PsgComponentRow>(conn, psgIds, (chunk) =>
          [
            'SELECT PermissionSetGroupId, PermissionSetId',
            'FROM PermissionSetGroupComponent',
            `WHERE PermissionSetGroupId IN (${soqlIn(chunk)})`,
            "AND PermissionSet.Type = 'Muting'",
          ].join(' ')
        );
        for (const row of mutingComponents) {
          const ids = mutingByPsgId.get(row.PermissionSetGroupId) ?? [];
          ids.push(row.PermissionSetId);
          mutingByPsgId.set(row.PermissionSetGroupId, ids);
        }
        const mutingSetIds = [...new Set(mutingComponents.map((row) => row.PermissionSetId))];
        const mutingRows = await queryAllInChunks<MutingPermissionRow>(conn, mutingSetIds, (chunk) =>
          [
            'SELECT ParentId, PermissionsRead, PermissionsCreate, PermissionsEdit, PermissionsDelete, PermissionsViewAllRecords, PermissionsModifyAllRecords',
            'FROM ObjectPermissions',
            'WHERE Parent.IsOwnedByProfile = false',
            `AND ParentId IN (${soqlIn(chunk)})`,
            `AND SobjectType = '${target.sobjectType}'`,
          ].join(' ')
        );
        for (const row of mutingRows) mutingAccessByPsId.set(row.ParentId, toObjectAccess(row));
      };

      const rows = await resolveAssignees(
        conn,
        'object',
        target.sobjectType,
        grantByPermissionSetId,
        permissionSetById,
        (grant, context) => {
          if (context.assignmentType === 'PermissionSet') return grant;
          const muted = (mutingByPsgId.get(context.psgId ?? '') ?? []).reduce<ObjectAccess>(
            (acc, id) => {
              const mask = mutingAccessByPsId.get(id);
              return {
                kind: 'object',
                read: acc.read || (mask?.read ?? false),
                create: acc.create || (mask?.create ?? false),
                edit: acc.edit || (mask?.edit ?? false),
                delete: acc.delete || (mask?.delete ?? false),
                viewAll: acc.viewAll || (mask?.viewAll ?? false),
                modifyAll: acc.modifyAll || (mask?.modifyAll ?? false),
              };
            },
            { kind: 'object', read: false, create: false, edit: false, delete: false, viewAll: false, modifyAll: false }
          );
          const effective = {
            kind: 'object' as const,
            read: grant.read && !muted.read,
            create: grant.create && !muted.create,
            edit: grant.edit && !muted.edit,
            delete: grant.delete && !muted.delete,
            viewAll: grant.viewAll && !muted.viewAll,
            modifyAll: grant.modifyAll && !muted.modifyAll,
          };
          return anyAccess(effective) ? effective : undefined;
        },
        { preparePsg }
      );
      return resultFor('object', target.sobjectType, rows, warnings, { sobjectType: target.sobjectType });
    } catch (error) {
      if (error instanceof UserAccessError) throw error;
      throw new UserAccessError('errorAccessQueryFailed', [target.type, target.targetName], error);
    }
  },
  csvColumns: objectCsvColumns,
};
