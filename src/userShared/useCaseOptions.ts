import type { Connection } from '@salesforce/core';
import {
  describeUserFields,
  LifecycleError,
  parseUserFlag,
  provision,
  type ProvisionPlan,
  type ProvisionResult,
  resolveTargetField,
  type FreezeOptions,
} from '@syntax-syllogism/warden-core';

type TargetFlags = {
  user?: string;
  'users-def'?: string;
  'external-id'?: string;
  'input-format'?: string;
  'csv-list-delimiter'?: string;
};

export const toTargetOptions = (flags: TargetFlags): FreezeOptions => ({
  user: flags.user,
  usersPath: flags['users-def'],
  externalId: flags['external-id'],
  inputFormat: flags['input-format'],
  csvListDelimiter: flags['csv-list-delimiter'],
});

/** Preserve the CLI's coded error (and SfError JSON envelope) for unknown fields. */
export const validateUserTarget = async (
  conn: Connection,
  user: string | undefined,
  invalidFieldMessage: (field: string) => string
): Promise<void> => {
  if (!user) return;
  const fieldMap = await describeUserFields(conn);
  const parsed = parseUserFlag(user);
  if (!resolveTargetField(parsed.field, fieldMap)) {
    throw new LifecycleError('errorInvalidUserMatchField', invalidFieldMessage(parsed.field), { field: parsed.field });
  }
};

/** Preserve legacy CLI result fields omitted or changed by core 0.4.1's apply path. */
export const applyProvisionWithLegacyOutput = async (
  conn: Connection,
  plan: ProvisionPlan,
  message: (key: string, args?: string[]) => string
): Promise<ProvisionResult> => {
  const output = await provision.apply(conn, plan);
  const ordered = [...plan.plans, ...plan.validationResults].sort((left, right) => left.order - right.order);
  for (const [index, user] of output.users.entries()) {
    const relatedErrors = (user.relatedRecords ?? [])
      .filter((related) => related.status === 'failed' && related.error)
      .map((related) => related.error!);
    if (relatedErrors.length > 0) {
      user.errors.unshift(...relatedErrors);
      user.status = 'failed';
    }
    const userPlan = ordered[index];
    if (
      userPlan &&
      'target' in userPlan &&
      !user.id &&
      user.errors.some((error) => error.includes('INVALID_CROSS_REFERENCE_KEY'))
    ) {
      const candidates = Object.entries(userPlan.target)
        .filter(([field]) => field.endsWith('Id') && field !== 'Id')
        .map(([field, value]) => `${field}=${String(value)}`);
      if (candidates.length > 0) user.errors.push(message('errorCrossReferenceCandidates', [candidates.join(', ')]));
    }
  }
  output.summary = {
    total: output.users.length,
    created: output.users.filter((user) => user.status === 'created').length,
    updated: output.users.filter((user) => user.status === 'updated').length,
    failed: output.users.filter((user) => user.status === 'failed').length,
    // Legacy live results never included license-shortfall warnings (only dry-run did).
    warnings: plan.warnings.length,
  };
  return output;
};
