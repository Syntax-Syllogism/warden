import type { Connection } from '@salesforce/core';
import { resolveAssignees, resultFor, type PermissionSetParent } from '../assignees.js';
import { queryAll, queryAllInChunks, soqlIn } from '../soql.js';
import { validateFieldTarget } from '../targetValidation.js';
import { fieldCsvColumns } from '../output.js';
import type { AccessTargetResolver, FieldAccess, UserAccessResult, ValidatedAccessTarget } from '../types.js';
import { UserAccessError } from '../types.js';

type FieldPermissionRecord = {
  ParentId: string;
  Parent?: PermissionSetParent;
  PermissionsRead?: boolean;
  PermissionsEdit?: boolean;
};

type MutingPermissionRow = {
  ParentId: string;
  PermissionsRead?: boolean;
  PermissionsEdit?: boolean;
};

type PsgComponentRow = { PermissionSetGroupId: string; PermissionSetId: string };
type FieldPermissionMask = Pick<FieldAccess, 'read' | 'edit'>;

const truthy = (value: boolean | undefined): boolean => value === true;
const anyAccess = (access: FieldAccess): boolean => access.read || access.edit;

export const fieldResolver: AccessTargetResolver = {
  type: 'field',
  validateTarget: validateFieldTarget,
  async resolve(conn: Connection, target: ValidatedAccessTarget): Promise<UserAccessResult> {
    if (!target.sobjectType || !target.fieldApiName)
      throw new UserAccessError('errorInvalidTarget', [target.targetName]);
    const qualifiedField = `${target.sobjectType}.${target.fieldApiName}`;
    const warnings: string[] = [];
    try {
      const entitlementRows = await queryAll<FieldPermissionRecord>(
        conn,
        [
          'SELECT ParentId, Parent.Id, Parent.Name, Parent.IsOwnedByProfile, Parent.ProfileId, Parent.Profile.Name, Parent.Type, PermissionsRead, PermissionsEdit',
          'FROM FieldPermissions',
          `WHERE SobjectType = '${target.sobjectType}'`,
          `AND Field = '${qualifiedField}'`,
          "AND Parent.Type != 'Muting'",
        ].join(' ')
      );
      const grantByPermissionSetId = new Map<string, FieldAccess>();
      const permissionSetById = new Map<string, PermissionSetParent>();
      for (const row of entitlementRows) {
        const access: FieldAccess = {
          kind: 'field',
          read: truthy(row.PermissionsRead),
          edit: truthy(row.PermissionsEdit),
        };
        if (!anyAccess(access)) continue;
        grantByPermissionSetId.set(row.ParentId, access);
        if (row.Parent) permissionSetById.set(row.ParentId, { ...row.Parent, Id: row.ParentId });
      }
      if (grantByPermissionSetId.size === 0) {
        warnings.push(
          `No explicit FieldPermissions records were found for ${qualifiedField}. Standard fields may still be visible through base object/profile behavior. This command reports explicit field-level security grants only.`
        );
        return resultFor('field', qualifiedField, [], warnings, {
          sobjectType: target.sobjectType,
          fieldApiName: target.fieldApiName,
        });
      }

      const mutingAccessByPsId = new Map<string, FieldPermissionMask>();
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
            'SELECT ParentId, PermissionsRead, PermissionsEdit',
            'FROM FieldPermissions',
            'WHERE Parent.IsOwnedByProfile = false',
            `AND ParentId IN (${soqlIn(chunk)})`,
            `AND SobjectType = '${target.sobjectType}'`,
            `AND Field = '${qualifiedField}'`,
          ].join(' ')
        );
        for (const row of mutingRows)
          mutingAccessByPsId.set(row.ParentId, {
            read: truthy(row.PermissionsRead),
            edit: truthy(row.PermissionsEdit),
          });
      };

      const rows = await resolveAssignees(
        conn,
        'field',
        qualifiedField,
        grantByPermissionSetId,
        permissionSetById,
        (grant, context) => {
          if (context.assignmentType === 'PermissionSet') return grant;
          const muted = (mutingByPsgId.get(context.psgId ?? '') ?? []).reduce(
            (acc, id) => {
              const mask = mutingAccessByPsId.get(id);
              return { read: acc.read || (mask?.read ?? false), edit: acc.edit || (mask?.edit ?? false) };
            },
            { read: false, edit: false }
          );
          const effective: FieldAccess = {
            kind: 'field',
            read: grant.read && !muted.read,
            edit: grant.edit && !muted.edit,
          };
          return anyAccess(effective) ? effective : undefined;
        },
        { preparePsg }
      );
      return resultFor('field', qualifiedField, rows, warnings, {
        sobjectType: target.sobjectType,
        fieldApiName: target.fieldApiName,
      });
    } catch (error) {
      if (error instanceof UserAccessError) throw error;
      throw new UserAccessError('errorAccessQueryFailed', [target.type, target.targetName], error);
    }
  },
  csvColumns: fieldCsvColumns,
};
