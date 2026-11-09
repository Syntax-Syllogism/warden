import type { Connection } from '@salesforce/core';
import {
  freeze,
  freezeOptionsSchema,
  restore,
  type FreezePlan,
  type FreezeOptions,
  type LifecycleResult,
  type RestorePlan,
  unfreeze,
  unfreezeOptionsSchema,
  type UseCaseContext,
} from '@syntax-syllogism/warden-core';
import { readSnapshotFile } from '@syntax-syllogism/warden-core';
import { validateUserTarget } from './useCaseOptions.js';

export type LifecycleRequestInput = {
  user?: string;
  usersDef?: string;
  externalId?: string;
  inputFormat?: string;
  csvListDelimiter?: string;
};

export type RestoreRequestInput = { snapshot: string };

const toLifecycleOptions = (input: LifecycleRequestInput): FreezeOptions => ({
  user: input.user,
  usersPath: input.usersDef,
  externalId: input.externalId,
  inputFormat: input.inputFormat,
  csvListDelimiter: input.csvListDelimiter,
});

const planLifecycleRequest = async (
  conn: Connection,
  input: LifecycleRequestInput,
  options: {
    schema: typeof freezeOptionsSchema | typeof unfreezeOptionsSchema;
    plan: (connection: Connection, options: FreezeOptions, ctx?: UseCaseContext) => Promise<FreezePlan>;
  },
  invalidFieldMessage: (field: string) => string,
  ctx?: UseCaseContext
): Promise<FreezePlan> => {
  await validateUserTarget(conn, input.user, invalidFieldMessage);
  return options.plan(conn, options.schema.parse(toLifecycleOptions(input)), ctx);
};

export const planFreezeRequest = (
  conn: Connection,
  input: LifecycleRequestInput,
  invalidFieldMessage: (field: string) => string,
  ctx?: UseCaseContext
): Promise<FreezePlan> =>
  planLifecycleRequest(
    conn,
    input,
    {
      schema: freezeOptionsSchema,
      plan: (connection, options, useCaseCtx) => freeze.plan(connection, options, useCaseCtx),
    },
    invalidFieldMessage,
    ctx
  );

export const planUnfreezeRequest = (
  conn: Connection,
  input: LifecycleRequestInput,
  invalidFieldMessage: (field: string) => string,
  ctx?: UseCaseContext
): Promise<FreezePlan> =>
  planLifecycleRequest(
    conn,
    input,
    {
      schema: unfreezeOptionsSchema,
      plan: (connection, options, useCaseCtx) => unfreeze.plan(connection, options, useCaseCtx),
    },
    invalidFieldMessage,
    ctx
  );

const normalizeRestoreWarnings = (
  plan: RestorePlan,
  missingReferenceMessage: (type: string, reference: string) => string
): RestorePlan => {
  for (const user of plan.users) {
    const warnings = user.result.warnings.map((warning) => {
      const missing = /^(\w+) reference "(.*)" was not found\.$/.exec(warning);
      return missing ? missingReferenceMessage(missing[1], missing[2]) : warning;
    });
    user.result.warnings = warnings;
    user.preview.warnings = warnings;
  }
  return plan;
};

export const planRestoreRequest = async (
  conn: Connection,
  input: RestoreRequestInput,
  options: {
    invalidSnapshot: (error: unknown) => never;
    missingReferenceMessage: (type: string, reference: string) => string;
    ctx?: UseCaseContext;
  }
): Promise<RestorePlan> => {
  let snapshot;
  try {
    snapshot = await readSnapshotFile(input.snapshot);
  } catch (error) {
    return options.invalidSnapshot(error);
  }
  const plan = await restore.plan(conn, { snapshotDoc: { ...snapshot } }, options.ctx);
  return normalizeRestoreWarnings(plan, options.missingReferenceMessage);
};

export const applyFreezeRequest = (
  conn: Connection,
  plan: FreezePlan,
  ctx?: UseCaseContext
): Promise<LifecycleResult> => freeze.apply(conn, plan, ctx);

export const applyUnfreezeRequest = (
  conn: Connection,
  plan: FreezePlan,
  ctx?: UseCaseContext
): Promise<LifecycleResult> => unfreeze.apply(conn, plan, ctx);

export const applyRestoreRequest = (
  conn: Connection,
  plan: RestorePlan,
  ctx?: UseCaseContext
): Promise<LifecycleResult> => restore.apply(conn, plan, ctx);
