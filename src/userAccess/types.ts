import type { Connection } from '@salesforce/core';

export type AccessTargetType = 'field' | 'object' | 'apex-class' | 'vf-page' | 'custom-permission' | 'tab';
export type AssignmentType = 'Profile' | 'PermissionSet' | 'PermissionSetGroup';

export type FieldAccess = {
  kind: 'field';
  read: boolean;
  edit: boolean;
};

export type ObjectAccess = {
  kind: 'object';
  read: boolean;
  create: boolean;
  edit: boolean;
  delete: boolean;
  viewAll: boolean;
  modifyAll: boolean;
};

export type EnabledAccess = {
  kind: 'enabled';
  enabled: boolean;
};

export type TabAccess = {
  kind: 'tab';
  visibility: string;
};

export type UserAccessRow = {
  userId: string;
  userName: string;
  username: string;
  targetType: AccessTargetType;
  targetName: string;
  assignmentType: AssignmentType;
  sourceId: string;
  sourceName: string;
  sourceApiName?: string;
  sourceLabel?: string;
  viaPermissionSetId?: string;
  viaPermissionSetName?: string;
  access: FieldAccess | ObjectAccess | EnabledAccess | TabAccess;
};

export type UserAccessStats = {
  totalActiveUsersWithAccess: number;
  profileGrants: number;
  permissionSetGrants: number;
  permissionSetGroupGrants: number;
};

export type UserAccessResult = {
  targetType: AccessTargetType;
  targetName: string;
  sobjectType?: string;
  fieldApiName?: string;
  rows: UserAccessRow[];
  stats: UserAccessStats;
  warnings: string[];
};

export type ValidatedAccessTarget = {
  type: AccessTargetType;
  targetName: string;
  sobjectType?: string;
  fieldApiName?: string;
  setupEntityId?: string;
};

export type AccessTargetResolver = {
  type: AccessTargetType;
  validateTarget(conn: Connection, target: string): Promise<ValidatedAccessTarget>;
  resolve(conn: Connection, target: ValidatedAccessTarget): Promise<UserAccessResult>;
  csvColumns(): string[];
};

export type AccessErrorCode =
  | 'errorUnsupportedAccessType'
  | 'errorInvalidTarget'
  | 'errorFieldTargetMustBeQualified'
  | 'errorObjectNotFound'
  | 'errorFieldNotFound'
  | 'errorApexClassNotFound'
  | 'errorVisualforcePageNotFound'
  | 'errorCustomPermissionNotFound'
  | 'errorTabNotFound'
  | 'errorAccessQueryFailed';

export class UserAccessError extends Error {
  public readonly code: AccessErrorCode;
  public readonly args: string[];
  public readonly cause?: unknown;

  public constructor(code: AccessErrorCode, args: string[] = [], cause?: unknown) {
    super(code);
    this.name = 'UserAccessError';
    this.code = code;
    this.args = args;
    this.cause = cause;
  }
}
