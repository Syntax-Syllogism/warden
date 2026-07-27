import type { CsvRowInfo } from '../userShared/csv.js';

export type LifecycleNotice = {
  key: string;
  count?: number;
  items?: LabelBundle[];
};

export type LabelBundle = {
  id: string;
  apiName?: string;
  label?: string;
  type?:
    | 'PermissionSet'
    | 'PermissionSetGroup'
    | 'PublicGroup'
    | 'Queue'
    | 'Profile'
    | 'UserRole'
    | 'PermissionSetLicense';
};

export type LabelMap = Record<string, LabelBundle>;

export type LifecycleStatus = 'changed' | 'failed' | 'planned' | 'unchanged';

export type LifecycleUserResult = {
  key: string;
  id?: string;
  name?: string;
  username?: string;
  isActive?: boolean;
  isFrozen?: boolean;
  status: LifecycleStatus;
  actions: LifecycleNotice[];
  skipped: LifecycleNotice[];
  warnings: string[];
  errors: string[];
};

export type LifecycleSummary = {
  total: number;
  changed: number;
  unchanged: number;
  failed: number;
};

export type LifecycleResult = {
  summary: LifecycleSummary;
  users: LifecycleUserResult[];
};

export type TargetRequest = {
  key: string;
  field: string;
  value: string;
  order: number;
  fuzzy?: boolean;
  source?: CsvRowInfo;
};

export type ResolvedTargetUser = {
  key: string;
  Id: string;
  IsActive: boolean;
  name?: string;
  username?: string;
  field: string;
  value: string;
  order: number;
};

export type TargetError = {
  key: string;
  field: string;
  value: string;
  message: string;
  order: number;
  source?: CsvRowInfo;
};
