export type LifecycleNotice = {
  key: string;
  count?: number;
};

export type LifecycleStatus = 'changed' | 'failed' | 'planned' | 'unchanged';

export type LifecycleUserResult = {
  key: string;
  id?: string;
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
};

export type ResolvedTargetUser = {
  key: string;
  Id: string;
  IsActive: boolean;
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
};
