import type { Connection } from '@salesforce/core';
import { resolveAssignees, resultFor, type PermissionSetParent } from '../assignees.js';
import { esc, queryAll } from '../soql.js';
import { tabCsvColumns } from '../output.js';
import { validateTabTarget } from '../targetValidation.js';
import type { AccessTargetResolver, TabAccess, UserAccessResult, ValidatedAccessTarget } from '../types.js';
import { UserAccessError } from '../types.js';

type TabSettingRow = {
  ParentId: string;
  Visibility: string;
  Parent?: PermissionSetParent;
};

const profileWarning =
  'Profile-level tab visibility is not included because it is not exposed as a clean PermissionSetTabSetting data-API grant.';

export const tabResolver: AccessTargetResolver = {
  type: 'tab',
  validateTarget: validateTabTarget,
  async resolve(conn: Connection, target: ValidatedAccessTarget): Promise<UserAccessResult> {
    try {
      const settings = await queryAll<TabSettingRow>(
        conn,
        [
          'SELECT ParentId, Visibility, Parent.Id, Parent.Name, Parent.IsOwnedByProfile, Parent.ProfileId, Parent.Profile.Name, Parent.Type',
          'FROM PermissionSetTabSetting',
          `WHERE Name = '${esc(target.targetName)}'`,
          "AND Visibility != 'Hidden'",
        ].join(' ')
      );
      const grantByPermissionSetId = new Map<string, TabAccess>();
      const permissionSetById = new Map<string, PermissionSetParent>();
      for (const row of settings) {
        grantByPermissionSetId.set(row.ParentId, { kind: 'tab', visibility: row.Visibility });
        if (row.Parent) permissionSetById.set(row.ParentId, { ...row.Parent, Id: row.ParentId });
      }
      const rows = await resolveAssignees(
        conn,
        'tab',
        target.targetName,
        grantByPermissionSetId,
        permissionSetById,
        (grant) => grant
      );
      return resultFor('tab', target.targetName, rows, [profileWarning]);
    } catch (error) {
      if (error instanceof UserAccessError) throw error;
      throw new UserAccessError('errorAccessQueryFailed', [target.type, target.targetName], error);
    }
  },
  csvColumns: tabCsvColumns,
};
