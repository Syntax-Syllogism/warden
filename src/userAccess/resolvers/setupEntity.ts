import type { Connection } from '@salesforce/core';
import { resolveAssignees, resultFor, type PermissionSetParent } from '../assignees.js';
import { queryAll } from '../soql.js';
import { enabledCsvColumns } from '../output.js';
import { validateSetupEntityTarget } from '../targetValidation.js';
import type { AccessTargetResolver, EnabledAccess, UserAccessResult, ValidatedAccessTarget } from '../types.js';
import { UserAccessError } from '../types.js';

type SetupEntityAccessRow = {
  ParentId: string;
  Parent?: PermissionSetParent;
};

type SetupEntityConfig = {
  type: 'apex-class' | 'vf-page' | 'custom-permission';
  setupEntityType: 'ApexClass' | 'ApexPage' | 'CustomPermission';
};

const createResolver = (config: SetupEntityConfig): AccessTargetResolver => ({
  type: config.type,
  validateTarget: (conn, target) => validateSetupEntityTarget(conn, config.type, target),
  async resolve(conn: Connection, target: ValidatedAccessTarget): Promise<UserAccessResult> {
    if (!target.setupEntityId) throw new UserAccessError('errorInvalidTarget', [target.targetName]);
    try {
      const rows = await queryAll<SetupEntityAccessRow>(
        conn,
        [
          'SELECT ParentId, Parent.Id, Parent.Name, Parent.IsOwnedByProfile, Parent.ProfileId, Parent.Profile.Name, Parent.Type',
          'FROM SetupEntityAccess',
          `WHERE SetupEntityType = '${config.setupEntityType}'`,
          `AND SetupEntityId = '${target.setupEntityId}'`,
        ].join(' ')
      );
      const grantByPermissionSetId = new Map<string, EnabledAccess>();
      const permissionSetById = new Map<string, PermissionSetParent>();
      for (const row of rows) {
        grantByPermissionSetId.set(row.ParentId, { kind: 'enabled', enabled: true });
        if (row.Parent) permissionSetById.set(row.ParentId, { ...row.Parent, Id: row.ParentId });
      }
      const resolvedRows = await resolveAssignees(
        conn,
        config.type,
        target.targetName,
        grantByPermissionSetId,
        permissionSetById,
        (grant) => grant
      );
      return resultFor(config.type, target.targetName, resolvedRows);
    } catch (error) {
      if (error instanceof UserAccessError) throw error;
      throw new UserAccessError('errorAccessQueryFailed', [target.type, target.targetName], error);
    }
  },
  csvColumns: enabledCsvColumns,
});

export const apexClassResolver = createResolver({ type: 'apex-class', setupEntityType: 'ApexClass' });
export const vfPageResolver = createResolver({ type: 'vf-page', setupEntityType: 'ApexPage' });
export const customPermissionResolver = createResolver({ type: 'custom-permission', setupEntityType: 'CustomPermission' });
