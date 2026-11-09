import { writeFile } from 'node:fs/promises';
import { Messages, type Connection } from '@salesforce/core';
import type {
  FreezePlan,
  LifecycleResult,
  ProvisionPlan,
  ProvisionResult,
  RestorePlan,
  UseCaseContext,
} from '@syntax-syllogism/warden-core';
import { summarizeLifecycle, writeSnapshotFile } from '@syntax-syllogism/warden-core';
import { z } from 'zod';
import {
  applyFreezeRequest,
  applyRestoreRequest,
  applyUnfreezeRequest,
  planFreezeRequest,
  planRestoreRequest,
  planUnfreezeRequest,
} from '../userShared/lifecycleRequest.js';
import {
  applyPersonaImportRequest,
  planPersonaImportRequest,
  type PersonaImportPlan,
} from '../userShared/personaImportRequest.js';
import { type PersonaDiff, diffPersonaDocuments, readOrgPersonas, readPersonaFile } from '../userShared/personas.js';
import { applyProvisionRequest, planProvisionRequest } from '../userShared/provisionRequest.js';
import {
  applyStripRequest,
  planStripRequest,
  writeStripSnapshot,
  type PlannedStripRequest,
} from '../userShared/stripRequest.js';
import {
  captureProvisioningWrites,
  detectConnectedPackage,
  serializeCaptureState,
  type SerializedCaptureState,
} from '../userShared/orgWrites.js';
import { writeProvisionLedger } from '../userShared/provisionLedger.js';
import { runAccessRequest, type AccessRequestInput } from '../userShared/accessRequest.js';
import { runDiffRequest, type DiffRequestInput, type DiffRequestResult } from '../userShared/diffRequest.js';
import { defaultSnapshotOut, runSnapshotRequest } from '../userShared/snapshotRequest.js';
import { requireExactlyOne } from '../userShared/targetFlags.js';
import { toOperationError } from './errors.js';
import type { Effect, OperationContext, OperationModule, ReadOperation, WriteOperation } from './contract.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const accessMessages = Messages.loadMessages('@syntax-syllogism/warden', 'warden.access');
const diffMessages = Messages.loadMessages('@syntax-syllogism/warden', 'warden.diff');
const snapshotMessages = Messages.loadMessages('@syntax-syllogism/warden', 'warden.snapshot');
const personaDiffMessages = Messages.loadMessages('@syntax-syllogism/warden', 'warden.persona.diff');
const personaExportMessages = Messages.loadMessages('@syntax-syllogism/warden', 'warden.persona.export');
const provisionMessages = Messages.loadMessages('@syntax-syllogism/warden', 'warden.provision');
const restoreMessages = Messages.loadMessages('@syntax-syllogism/warden', 'warden.restore');
const freezeMessages = Messages.loadMessages('@syntax-syllogism/warden', 'warden.freeze');
const unfreezeMessages = Messages.loadMessages('@syntax-syllogism/warden', 'warden.unfreeze');
const stripMessages = Messages.loadMessages('@syntax-syllogism/warden', 'warden.strip');
const personaImportMessages = Messages.loadMessages('@syntax-syllogism/warden', 'warden.persona.import');

const accessSchema = z
  .object({
    type: z.enum(['field', 'object', 'apex-class', 'vf-page', 'custom-permission', 'tab', 'record-type']),
    target: z.string().optional(),
    user: z.string().optional(),
    sobject: z.string().optional(),
  })
  .strict();
const diffSchema = z
  .object({
    user: z.string().optional(),
    against: z.string().optional(),
    usersDef: z.string().optional(),
    personasDef: z.string().optional(),
    externalId: z.string().optional(),
    inputFormat: z.enum(['json', 'csv']).optional(),
    csvListDelimiter: z.string().optional(),
    verbose: z.boolean().default(false),
    verify: z.boolean().default(false),
    failOnDrift: z.boolean().default(false),
  })
  .strict();
const snapshotSchema = z
  .object({
    user: z.string().optional(),
    usersDef: z.string().optional(),
    externalId: z.string().optional(),
    inputFormat: z.enum(['json', 'csv']).optional(),
    csvListDelimiter: z.string().optional(),
    out: z.string().optional(),
  })
  .strict();
const personaDiffSchema = z.object({ input: z.string() }).strict();
const personaExportSchema = z.object({ output: z.string() }).strict();
const provisionSchema = z
  .object({
    usersDef: z.string(),
    personasDef: z.string().optional(),
    personaSource: z.enum(['file', 'org']).optional(),
    relatedDef: z.string().optional(),
    externalId: z.string().optional(),
    inputFormat: z.enum(['json', 'csv']).optional(),
    csvListDelimiter: z.string().optional(),
    fuzzyUsername: z.boolean().default(false),
    cleanupOnFailure: z.boolean().default(false),
    failOnInsufficientLicense: z.boolean().default(false),
  })
  .strict();
const restoreSchema = z.object({ snapshot: z.string() }).strict();
const lifecycleHasExactlyOneTarget = (options: { user?: string; usersDef?: string }): boolean =>
  (options.user === undefined) !== (options.usersDef === undefined);

const lifecycleSchema = z
  .object({
    user: z.string().optional(),
    usersDef: z.string().optional(),
    externalId: z.string().optional(),
    inputFormat: z.enum(['json', 'csv']).optional(),
    csvListDelimiter: z.string().optional(),
  })
  .refine(lifecycleHasExactlyOneTarget, {
    message: 'Exactly one of the following must be provided: --user, --users-def',
  })
  .strict();
const personaImportSchema = z.object({ input: z.string(), prune: z.boolean().default(false) }).strict();
const stripSchema = z
  .object({
    user: z.string().optional(),
    usersDef: z.string().optional(),
    externalId: z.string().optional(),
    inputFormat: z.enum(['json', 'csv']).optional(),
    csvListDelimiter: z.string().optional(),
    noFreeze: z.boolean().default(false),
    noDeactivate: z.boolean().default(false),
    keepPermsets: z.boolean().default(false),
    keepPermsetGroups: z.boolean().default(false),
    keepLicenses: z.boolean().default(false),
    keepPublicGroups: z.boolean().default(false),
    keepQueues: z.boolean().default(false),
    personas: z.array(z.string()).default([]),
    allPersonas: z.boolean().default(false),
    personasDef: z.string().optional(),
    personaSource: z.enum(['file', 'org']).default('file'),
    freeze: z.boolean().default(false),
    deactivate: z.boolean().default(false),
    snapshot: z.string().optional(),
  })
  .refine((options) => !(options.personas.length > 0 && options.allPersonas), {
    message: 'personas and allPersonas are mutually exclusive.',
  })
  .strict();

type AccessOptions = z.infer<typeof accessSchema>;
type DiffOptions = z.infer<typeof diffSchema>;
type SnapshotOptions = z.infer<typeof snapshotSchema>;
type PersonaDiffOptions = z.infer<typeof personaDiffSchema>;
type PersonaExportOptions = z.infer<typeof personaExportSchema>;
type ProvisionOptions = z.infer<typeof provisionSchema>;
type RestoreOptions = z.infer<typeof restoreSchema>;
type LifecycleOptions = z.infer<typeof lifecycleSchema>;
type PersonaImportOptions = z.infer<typeof personaImportSchema>;
type StripOptions = z.infer<typeof stripSchema>;

type ProvisionOperationPlan = {
  effects: Effect[];
  summary: string;
  preview: ProvisionResult & { personaSource: string };
  warnings: string[];
  core: ProvisionPlan;
  personaSourceLabel: string;
  failOnInsufficientLicense: boolean;
  ledger?: {
    capture: SerializedCaptureState;
    personasDoc?: Awaited<ReturnType<typeof planProvisionRequest>>['personasDoc'];
  };
};
type RestoreOperationPlan = {
  effects: Effect[];
  summary: string;
  preview: LifecycleResult;
  warnings: string[];
  core: RestorePlan;
};
type LifecycleOperationPlan = {
  effects: Effect[];
  summary: string;
  preview: LifecycleResult;
  warnings: string[];
  core: FreezePlan;
};
type PersonaImportOperationPlan = { effects: Effect[]; summary: string; preview: PersonaDiff; core: PersonaImportPlan };
type StripOperationPlan = {
  effects: Effect[];
  summary: string;
  preview: LifecycleResult;
  warnings: string[];
  planned: PlannedStripRequest;
  snapshot?: string;
};

const requiredConnection = (conn: Connection | undefined): Connection => {
  if (!conn) throw new Error('A Salesforce connection is required.');
  return conn;
};

const resolveOptionalPath = (ctx: OperationContext, path: string | undefined): string | undefined =>
  path === undefined ? undefined : ctx.resolvePath(path);

const useCaseContext = (ctx: OperationContext): UseCaseContext => ({
  signal: ctx.signal,
  onProgress: (event): void => ctx.onProgress(event),
});

const jsonSafe = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const hasRemoval = (actions: string[]): boolean => actions.some((action) => action.toLowerCase().includes('remove'));

const actionCount = (users: Array<{ actions: string[] }>): number =>
  users.reduce((count, user) => count + user.actions.length, 0);

const unsafeOperationError = (error: unknown): never => {
  try {
    toOperationError(error);
  } catch (mapped) {
    if (mapped && typeof mapped === 'object') Object.assign(mapped, { retryable: 'unsafe' as const });
    throw mapped;
  }
  throw error instanceof Error ? error : new Error(String(error));
};

const personaDiffHasRemovals = (diff: PersonaDiff): boolean => {
  if (diff.removed.length > 0) return true;
  return diff.changed.some(({ before, after }) => {
    const beforeComponents = [
      ...(before.permissionSets ?? []),
      ...(before.permissionSetGroups ?? []),
      ...(before.publicGroups ?? []),
      ...(before.queues ?? []),
    ];
    const afterComponents = new Set([
      ...(after.permissionSets ?? []),
      ...(after.permissionSetGroups ?? []),
      ...(after.publicGroups ?? []),
      ...(after.queues ?? []),
    ]);
    return beforeComponents.some((component) => !afterComponents.has(component));
  });
};

const reportFailed = (ctx: OperationContext, summary: { failed: number } | undefined): void => {
  ctx.reportFailures?.(summary?.failed ?? 0);
};

const reportCount = (ctx: OperationContext, count: number): void => {
  ctx.reportFailures?.(count);
};

export const diffFailureCount = (result: DiffRequestResult, failOnDrift: boolean): number => {
  if (Array.isArray(result)) return result.filter((verdict) => !verdict.conformant).length;
  return result.summary.failed + (failOnDrift ? result.summary.changed : 0);
};

const access: ReadOperation<AccessOptions> = {
  kind: 'read',
  descriptor: {
    id: 'warden.access',
    cliId: 'warden:access',
    title: 'Explain who can access a component',
    summary: accessMessages.getMessage('summary'),
    effects: ['read'],
    requiresOrg: 'required',
    requiresProject: false,
    optionsSchema: accessSchema,
    retry: 'safe',
  },
  async run(conn, options, ctx) {
    try {
      ctx.onProgress({ phase: 'resolve' });
      return (await runAccessRequest(requiredConnection(conn), options as AccessRequestInput)).result;
    } catch (error) {
      return toOperationError(error);
    }
  },
};

const diff: ReadOperation<DiffOptions> = {
  kind: 'read',
  descriptor: {
    id: 'warden.diff',
    cliId: 'warden:diff',
    title: 'Compare user access to intended state',
    summary: diffMessages.getMessage('summary'),
    effects: ['read'],
    requiresOrg: 'required',
    requiresProject: false,
    optionsSchema: diffSchema,
    retry: 'safe',
  },
  async run(conn, options, ctx) {
    try {
      ctx.onProgress({ phase: 'compare' });
      const { failOnDrift, ...request } = options;
      const result = await runDiffRequest(requiredConnection(conn), {
        ...request,
        usersDef: resolveOptionalPath(ctx, request.usersDef),
        personasDef: resolveOptionalPath(ctx, request.personasDef),
      } as DiffRequestInput);
      reportCount(ctx, diffFailureCount(result, failOnDrift));
      return result;
    } catch (error) {
      return toOperationError(error);
    }
  },
};

const snapshot: ReadOperation<SnapshotOptions> = {
  kind: 'read',
  descriptor: {
    id: 'warden.snapshot',
    cliId: 'warden:snapshot',
    title: 'Capture user assignment state',
    summary: snapshotMessages.getMessage('summary'),
    effects: ['read', 'local-write'],
    requiresOrg: 'required',
    requiresProject: false,
    optionsSchema: snapshotSchema,
    retry: 'safe',
  },
  async run(conn, options, ctx) {
    try {
      ctx.onProgress({ phase: 'snapshot' });
      const output = resolveOptionalPath(ctx, options.out) ?? ctx.resolvePath(defaultSnapshotOut());
      const result = await runSnapshotRequest(
        requiredConnection(conn),
        {
          ...options,
          usersDef: resolveOptionalPath(ctx, options.usersDef),
          out: output,
          org: ctx.org?.username,
        },
        writeSnapshotFile
      );
      reportFailed(ctx, result.summary);
      return result;
    } catch (error) {
      return toOperationError(error);
    }
  },
};

const personaDiff: ReadOperation<PersonaDiffOptions, PersonaDiff> = {
  kind: 'read',
  descriptor: {
    id: 'warden.persona-diff',
    cliId: 'warden:persona:diff',
    title: 'Compare file and org personas',
    summary: personaDiffMessages.getMessage('summary'),
    effects: ['read'],
    requiresOrg: 'required',
    requiresProject: false,
    optionsSchema: personaDiffSchema,
    retry: 'safe',
  },
  async run(conn, options, ctx) {
    try {
      ctx.onProgress({ phase: 'compare' });
      const [file, org] = await Promise.all([
        readPersonaFile(ctx.resolvePath(options.input)),
        readOrgPersonas(requiredConnection(conn)),
      ]);
      return diffPersonaDocuments(file, org.document);
    } catch (error) {
      return toOperationError(error);
    }
  },
};

const personaExport: ReadOperation<PersonaExportOptions, { personas: number; output: string }> = {
  kind: 'read',
  descriptor: {
    id: 'warden.persona-export',
    cliId: 'warden:persona:export',
    title: 'Export org personas',
    summary: personaExportMessages.getMessage('summary'),
    effects: ['read', 'local-write'],
    requiresOrg: 'required',
    requiresProject: false,
    optionsSchema: personaExportSchema,
    retry: 'safe',
  },
  async run(conn, options, ctx) {
    try {
      ctx.onProgress({ phase: 'export' });
      const output = ctx.resolvePath(options.output);
      const read = await readOrgPersonas(requiredConnection(conn));
      await writeFile(output, `${JSON.stringify(read.document, null, 2)}\n`, 'utf8');
      return { personas: read.count, output };
    } catch (error) {
      return toOperationError(error);
    }
  },
};

const provision: WriteOperation<ProvisionOptions, ProvisionOperationPlan, ProvisionResult & { personaSource: string }> =
  {
    kind: 'write',
    descriptor: {
      id: 'warden.provision',
      cliId: 'warden:provision',
      title: 'Provision users',
      summary: provisionMessages.getMessage('summary'),
      effects: ['org-write', 'destructive'],
      requiresOrg: 'required',
      requiresProject: false,
      optionsSchema: provisionSchema,
      retry: 'unsafe',
    },
    async plan(conn, options, ctx) {
      try {
        ctx.onProgress({ phase: 'plan' });
        const connection = requiredConnection(conn);
        const connectedPackage = await detectConnectedPackage(connection);
        const capturedWrites = connectedPackage.ledgerAvailable ? captureProvisioningWrites(connection) : undefined;
        const planned = await planProvisionRequest(
          capturedWrites?.connection ?? connection,
          {
            ...options,
            usersDef: ctx.resolvePath(options.usersDef),
            personasDef: resolveOptionalPath(ctx, options.personasDef),
            relatedDef: resolveOptionalPath(ctx, options.relatedDef),
          },
          {
            relatedDefinitionRequiresJson: () => new Error(provisionMessages.getMessage('errorRelatedRequiresJson')),
            invalidDefinition: (path, detail) => provisionMessages.getMessage('errorInvalidJson', [path, detail]),
            invalidPersonaDefinition: (error) => {
              throw error;
            },
            personasWithoutDefinition: (identity) =>
              provisionMessages.getMessage('errorPersonasWithoutDefinition', [identity]),
            ctx: useCaseContext(ctx),
          }
        );
        const core = jsonSafe(planned.core);
        reportFailed(ctx, core.preview.summary);
        const changes = actionCount(core.preview.users);
        return {
          effects:
            changes === 0
              ? []
              : hasRemoval(core.preview.users.flatMap((user) => user.actions))
              ? ['org-write', 'destructive']
              : ['org-write'],
          summary: `provision ${core.preview.users.length} user(s): ${
            changes === 0 ? 'no changes' : `${changes} planned change(s)`
          }`,
          preview: { ...core.preview, personaSource: planned.personaSourceLabel },
          warnings: core.warnings,
          core,
          personaSourceLabel: planned.personaSourceLabel,
          failOnInsufficientLicense: options.failOnInsufficientLicense ?? false,
          ...(capturedWrites
            ? { ledger: { capture: serializeCaptureState(capturedWrites.state), personasDoc: planned.personasDoc } }
            : {}),
        };
      } catch (error) {
        return toOperationError(error);
      }
    },
    async apply(conn, plan, ctx) {
      try {
        ctx.onProgress({ phase: 'apply' });
        const connection = requiredConnection(conn);
        const capturedWrites = plan.ledger ? captureProvisioningWrites(connection, plan.ledger.capture) : undefined;
        const output = await applyProvisionRequest(
          capturedWrites?.connection ?? connection,
          plan.core,
          provisionMessages.getMessage.bind(provisionMessages)
        );
        if (capturedWrites && plan.ledger) {
          try {
            await writeProvisionLedger(connection, {
              state: capturedWrites.state,
              output,
              personasDoc: plan.ledger.personasDoc,
              warn: (message) => ctx.notice(message),
            });
          } catch (error) {
            ctx.notice(`Warden org ledger write failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        reportFailed(ctx, output.summary);
        if (plan.failOnInsufficientLicense && output.licenses?.some((license) => license.shortfall > 0)) {
          const shortfalls = output.licenses
            .filter((license) => license.shortfall > 0)
            .map((license) => `${license.licenseName} (${license.shortfall})`)
            .join(', ');
          throw Object.assign(new Error(provisionMessages.getMessage('errorInsufficientLicense', [shortfalls])), {
            result: output,
          });
        }
        return { ...output, personaSource: plan.personaSourceLabel };
      } catch (error) {
        return unsafeOperationError(error);
      }
    },
  };

const restore: WriteOperation<RestoreOptions, RestoreOperationPlan, LifecycleResult> = {
  kind: 'write',
  descriptor: {
    id: 'warden.restore',
    cliId: 'warden:restore',
    title: 'Restore user assignments',
    summary: restoreMessages.getMessage('summary'),
    effects: ['org-write', 'destructive'],
    requiresOrg: 'required',
    requiresProject: false,
    optionsSchema: restoreSchema,
    retry: 'unsafe',
  },
  async plan(conn, options, ctx): Promise<RestoreOperationPlan> {
    try {
      ctx.onProgress({ phase: 'plan' });
      const core = jsonSafe(
        await planRestoreRequest(
          requiredConnection(conn),
          { snapshot: ctx.resolvePath(options.snapshot) },
          {
            invalidSnapshot: (error) => {
              const detail = error instanceof Error ? error.message : String(error);
              throw new Error(restoreMessages.getMessage('errorInvalidJson', [options.snapshot, detail]));
            },
            missingReferenceMessage: (type, reference) =>
              restoreMessages.getMessage('warningReferenceMissing', [type, reference]),
            ctx: useCaseContext(ctx),
          }
        )
      );
      reportFailed(ctx, core.preview.summary);
      const changes = core.preview.users.filter((user) => user.status === 'planned').length;
      return {
        effects:
          changes === 0
            ? []
            : hasRemoval(core.preview.users.flatMap((user) => user.actions.map((action) => action.key)))
            ? ['org-write', 'destructive']
            : ['org-write'],
        summary: `restore ${core.preview.users.length} user(s): ${changes} planned update(s)`,
        preview: core.preview,
        warnings: core.warnings,
        core,
      };
    } catch (error) {
      return toOperationError(error);
    }
  },
  async apply(conn, plan, ctx): Promise<LifecycleResult> {
    try {
      ctx.onProgress({ phase: 'apply' });
      const result = await applyRestoreRequest(requiredConnection(conn), plan.core, useCaseContext(ctx));
      reportFailed(ctx, result.summary);
      return result;
    } catch (error) {
      return unsafeOperationError(error);
    }
  },
};

const lifecycleOperation = (
  id: 'warden.freeze' | 'warden.unfreeze',
  title: string,
  summary: string,
  planRequest: typeof planFreezeRequest,
  applyRequest: typeof applyFreezeRequest,
  invalidFieldMessage: (field: string) => string
): WriteOperation<LifecycleOptions, LifecycleOperationPlan, LifecycleResult> => ({
  kind: 'write',
  descriptor: {
    id,
    cliId: id.replace('.', ':') as 'warden:freeze' | 'warden:unfreeze',
    title,
    summary,
    effects: ['org-write'],
    requiresOrg: 'required',
    requiresProject: false,
    optionsSchema: lifecycleSchema,
    retry: 'unsafe',
  },
  async plan(conn, options, ctx): Promise<LifecycleOperationPlan> {
    try {
      requireExactlyOne(options, ['user', 'usersDef']);
      ctx.onProgress({ phase: 'plan' });
      const core = jsonSafe(
        await planRequest(
          requiredConnection(conn),
          { ...options, usersDef: resolveOptionalPath(ctx, options.usersDef) },
          invalidFieldMessage,
          useCaseContext(ctx)
        )
      );
      const preview = { summary: summarizeLifecycle(core.users), users: core.users };
      reportFailed(ctx, preview.summary);
      return {
        effects: core.updates.length === 0 ? [] : ['org-write'],
        summary: `${id === 'warden.freeze' ? 'freeze' : 'unfreeze'} ${core.updates.length} user(s)`,
        preview,
        warnings: core.warnings,
        core,
      };
    } catch (error) {
      return toOperationError(error);
    }
  },
  async apply(conn, plan, ctx): Promise<LifecycleResult> {
    try {
      ctx.onProgress({ phase: 'apply' });
      const result = await applyRequest(requiredConnection(conn), plan.core, useCaseContext(ctx));
      reportFailed(ctx, result.summary);
      return result;
    } catch (error) {
      return unsafeOperationError(error);
    }
  },
});

const freeze = lifecycleOperation(
  'warden.freeze',
  'Freeze users',
  freezeMessages.getMessage('summary'),
  planFreezeRequest,
  applyFreezeRequest,
  (field) => freezeMessages.getMessage('errorInvalidUserMatchField', [field])
);
const unfreeze = lifecycleOperation(
  'warden.unfreeze',
  'Unfreeze users',
  unfreezeMessages.getMessage('summary'),
  planUnfreezeRequest,
  applyUnfreezeRequest,
  (field) => unfreezeMessages.getMessage('errorInvalidUserMatchField', [field])
);

const strip: WriteOperation<StripOptions, StripOperationPlan, LifecycleResult> = {
  kind: 'write',
  descriptor: {
    id: 'warden.strip',
    cliId: 'warden:strip',
    title: 'Strip user access',
    summary: stripMessages.getMessage('summary'),
    effects: ['org-write', 'destructive', 'local-write'],
    requiresOrg: 'required',
    requiresProject: false,
    optionsSchema: stripSchema,
    retry: 'unsafe',
  },
  async plan(conn, options, ctx): Promise<StripOperationPlan> {
    try {
      ctx.onProgress({ phase: 'plan' });
      const warnings: string[] = [];
      const planned = await planStripRequest(
        requiredConnection(conn),
        {
          ...options,
          usersDef: resolveOptionalPath(ctx, options.usersDef),
          personasDef: resolveOptionalPath(ctx, options.personasDef),
        },
        {
          invalidUserMatchField: (field) => stripMessages.getMessage('errorInvalidUserMatchField', [field]),
          warn: (message) => warnings.push(message),
          ctx: useCaseContext(ctx),
        }
      );
      const safePlanned = jsonSafe(planned);
      reportFailed(ctx, safePlanned.core.preview.summary);
      const hasDml = safePlanned.core.states.some((state) => state.hasDml);
      const destructive = safePlanned.core.states.some((state) =>
        state.steps.some(
          (step) => step.kind === 'delete' || (step.kind === 'update' && step.actionKey === 'deactivated')
        )
      );
      const snapshotPath = resolveOptionalPath(ctx, options.snapshot);
      return {
        effects: [
          ...(hasDml ? ['org-write' as const] : []),
          ...(destructive ? ['destructive' as const] : []),
          ...(snapshotPath ? ['local-write' as const] : []),
        ],
        summary: `strip ${safePlanned.core.preview.users.length} user(s): ${safePlanned.core.preview.summary.changed} with changes`,
        preview: safePlanned.core.preview,
        warnings: [...safePlanned.core.warnings, ...warnings],
        planned: safePlanned,
        ...(snapshotPath ? { snapshot: snapshotPath } : {}),
      };
    } catch (error) {
      return toOperationError(error);
    }
  },
  async apply(conn, plan, ctx): Promise<LifecycleResult> {
    const connection = requiredConnection(conn);
    if (plan.snapshot) {
      try {
        await writeStripSnapshot(connection, plan.planned, plan.snapshot, ctx.org?.username);
      } catch (error) {
        return toOperationError(error);
      }
    }
    try {
      ctx.onProgress({ phase: 'apply' });
      const result = await applyStripRequest(connection, plan.planned, {
        invalidUserMatchField: (field) => stripMessages.getMessage('errorInvalidUserMatchField', [field]),
        warn: (message) => ctx.notice(message),
        ctx: useCaseContext(ctx),
      });
      reportFailed(ctx, result.summary);
      return result;
    } catch (error) {
      return unsafeOperationError(error);
    }
  },
};

const personaImport: WriteOperation<
  PersonaImportOptions,
  PersonaImportOperationPlan,
  { personas: number; components: number; prunedComponents?: number }
> = {
  kind: 'write',
  descriptor: {
    id: 'warden.persona-import',
    cliId: 'warden:persona:import',
    title: 'Import org personas',
    summary: personaImportMessages.getMessage('summary'),
    effects: ['org-write', 'destructive'],
    requiresOrg: 'required',
    requiresProject: false,
    optionsSchema: personaImportSchema,
    retry: 'unsafe',
  },
  async plan(conn, options, ctx) {
    try {
      ctx.onProgress({ phase: 'plan' });
      const core = jsonSafe(
        await planPersonaImportRequest(requiredConnection(conn), {
          input: ctx.resolvePath(options.input),
          prune: options.prune,
        })
      );
      const changes = core.diff.added.length + core.diff.removed.length + core.diff.changed.length;
      return {
        effects:
          changes === 0
            ? []
            : options.prune && personaDiffHasRemovals(core.diff)
            ? ['org-write', 'destructive']
            : ['org-write'],
        summary: `import personas: +${core.diff.added.length}, −${core.diff.removed.length}, ~${core.diff.changed.length}`,
        preview: core.diff,
        core,
      };
    } catch (error) {
      return toOperationError(error);
    }
  },
  async apply(conn, plan, ctx) {
    try {
      ctx.onProgress({ phase: 'apply' });
      return await applyPersonaImportRequest(requiredConnection(conn), plan.core);
    } catch (error) {
      return unsafeOperationError(error);
    }
  },
};

export default {
  apiVersion: 0,
  operations: [
    access,
    diff,
    snapshot,
    personaDiff,
    personaExport,
    provision,
    restore,
    freeze,
    unfreeze,
    strip,
    personaImport,
  ],
} satisfies OperationModule;
