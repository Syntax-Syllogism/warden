/* eslint-disable camelcase */
import type { Connection } from '@salesforce/core';
import {
  buildSnapshotFile,
  describeUserFields,
  detectInputFormat,
  loadAssignmentState,
  makeNotice,
  readProvisionDefinitions,
  strip,
  stripOptionsSchema,
  writeSnapshotFile,
  type InputFormat,
  type LifecycleResult,
  type UseCaseContext,
} from '@syntax-syllogism/warden-core';
import { readHeldPersonas, readOrgPersonas, personaPackageDetected, type HeldPersonaAssignment } from './personas.js';
import {
  describeObjectFields,
  detectConnectedPackage,
  readLedgerProvenance,
  saveRun,
  updateBatch,
  WARDEN_LEDGER_OBJECT,
  WARDEN_RUN_OBJECT,
  type LedgerProvenance,
} from './orgWrites.js';
import { PERSONA_ASSIGNMENT_OBJECT, PERSONA_ASSIGNMENT_STATUS_FIELD } from './personas.js';
import { validateUserTarget } from './useCaseOptions.js';
import { requireExactlyOne } from './targetFlags.js';

type StripTarget = { Id: string; field: string; value: string };
type StripPlan = Awaited<ReturnType<typeof strip.plan>>;

export type StripRequestInput = {
  user?: string;
  usersDef?: string;
  externalId?: string;
  inputFormat?: 'json' | 'csv';
  csvListDelimiter?: string;
  noFreeze: boolean;
  noDeactivate: boolean;
  keepPermsets: boolean;
  keepPermsetGroups: boolean;
  keepLicenses: boolean;
  keepPublicGroups: boolean;
  keepQueues: boolean;
  personas: string[];
  allPersonas: boolean;
  personasDef?: string;
  personaSource: 'file' | 'org';
  freeze: boolean;
  deactivate: boolean;
};

export type StripRequestHooks = {
  invalidUserMatchField: (field: string) => string;
  warn: (message: string) => void;
  ctx?: UseCaseContext;
};

export type PlannedStripRequest = {
  core: StripPlan;
  personaMode: boolean;
  heldAssignments: HeldPersonaAssignment[];
  ledgerProvenance?: LedgerProvenance[];
  removedPersonasByUser: Record<string, string[]>;
};

const heldPersonasForTarget = (usersDoc: { users?: unknown }, target: StripTarget): string[] => {
  if (!Array.isArray(usersDoc.users)) return [];
  const user = usersDoc.users.find((candidate): candidate is Record<string, unknown> => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
    const record = candidate as Record<string, unknown>;
    const match = typeof record.match === 'string' && record.match.length > 0 ? record.match : target.field;
    const value = Object.entries(record).find(([key]) => key.toLowerCase() === match.toLowerCase())?.[1];
    return typeof value === 'string' && value === target.value;
  });
  return Array.isArray(user?.personas)
    ? user.personas.filter((persona): persona is string => typeof persona === 'string')
    : [];
};

const selectedPersonasByUser = (
  assignments: HeldPersonaAssignment[],
  requestedPersonas: string[],
  allPersonas: boolean
): Map<string, Set<string>> => {
  const selected = new Map<string, Set<string>>();
  for (const assignment of assignments) {
    if (!allPersonas && !requestedPersonas.includes(assignment.persona)) continue;
    const personas = selected.get(assignment.userId) ?? new Set<string>();
    personas.add(assignment.persona);
    selected.set(assignment.userId, personas);
  }
  return selected;
};

const selectedFilePersonasByUser = async (
  conn: Connection,
  states: StripPlan['states'],
  input: StripRequestInput
): Promise<Map<string, Set<string>>> => {
  if (!input.usersDef) return new Map();
  const inputFormat = detectInputFormat(input.usersDef, input.inputFormat as InputFormat | undefined);
  const definitions = await readProvisionDefinitions(input.usersDef, input.personasDef, {
    ...(inputFormat === 'csv'
      ? { inputFormat, fieldMap: await describeUserFields(conn), csvListDelimiter: input.csvListDelimiter }
      : {}),
  });
  const selected = new Map<string, Set<string>>();
  for (const state of states) {
    const held = heldPersonasForTarget(definitions.usersDoc, state.target as StripTarget);
    const removed = input.allPersonas ? held : held.filter((persona) => input.personas.includes(persona));
    if (removed.length > 0) selected.set(state.target.Id, new Set(removed));
  }
  return selected;
};

const jsonPersonas = (selected: ReadonlyMap<string, ReadonlySet<string>>): Record<string, string[]> =>
  Object.fromEntries([...selected].map(([userId, personas]) => [userId, [...personas]]));

// The call ordering intentionally mirrors the legacy command's target and persona resolution passes.
// eslint-disable-next-line complexity
export const planStripRequest = async (
  conn: Connection,
  input: StripRequestInput,
  hooks: StripRequestHooks
): Promise<PlannedStripRequest> => {
  const personaMode = input.personas.length > 0 || input.allPersonas;
  if (!personaMode || input.personaSource !== 'file') requireExactlyOne(input, ['user', 'usersDef']);
  await validateUserTarget(conn, input.user, hooks.invalidUserMatchField);
  const baseOptions = {
    user: input.user,
    usersPath: input.usersDef,
    externalId: input.externalId,
    inputFormat: input.inputFormat,
    csvListDelimiter: input.csvListDelimiter,
    noFreeze: input.noFreeze,
    noDeactivate: input.noDeactivate,
    keepPermsets: input.keepPermsets,
    keepPermsetGroups: input.keepPermsetGroups,
    keepPublicGroups: input.keepPublicGroups,
    keepQueues: input.keepQueues,
    keepLicenses: input.keepLicenses,
  };
  let ledgerProvenance: LedgerProvenance[] | undefined;
  let heldAssignments: HeldPersonaAssignment[] = [];
  let selectedStates: StripPlan['states'] | undefined;
  let options: Record<string, unknown> = {
    ...baseOptions,
    personas: input.personas,
    allPersonas: input.allPersonas,
    personasPath: input.personasDef,
    personaSource: input.personaSource,
    freeze: input.freeze,
    deactivate: input.deactivate,
  };
  if (personaMode && input.personaSource === 'org') {
    if (!(await personaPackageDetected(conn))) {
      throw new Error('--persona-source org requires the Warden package with persona objects installed.');
    }
    const selection = await strip.plan(conn, stripOptionsSchema.parse(baseOptions), hooks.ctx);
    selectedStates = selection.states;
    const targets = selection.states.map((state) => state.target);
    const [orgPersonas, assignments] = await Promise.all([
      readOrgPersonas(conn, true),
      readHeldPersonas(
        conn,
        targets.map((target) => target.Id)
      ),
    ]);
    heldAssignments = assignments;
    const heldByUser = new Map<string, string[]>();
    for (const assignment of assignments) {
      const held = heldByUser.get(assignment.userId) ?? [];
      held.push(assignment.persona);
      heldByUser.set(assignment.userId, held);
    }
    options = {
      ...baseOptions,
      usersDoc: {
        users: targets.map((target) => ({
          match: target.field,
          [target.field]: target.value,
          personas: heldByUser.get(target.Id) ?? [],
        })),
      },
      personasDoc: orgPersonas.document,
      personas: input.personas,
      allPersonas: input.allPersonas,
      personaSource: 'file',
      freeze: input.freeze,
      deactivate: input.deactivate,
    };
  }
  if (personaMode) {
    const connected = await detectConnectedPackage(conn);
    if (!selectedStates)
      selectedStates = (await strip.plan(conn, stripOptionsSchema.parse(baseOptions), hooks.ctx)).states;
    const targetIds = selectedStates.map((state) => state.target.Id);
    if (input.personaSource === 'file' && (await personaPackageDetected(conn))) {
      try {
        heldAssignments = await readHeldPersonas(conn, targetIds);
      } catch (error) {
        hooks.warn(
          `Could not read Warden persona assignments: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    if (connected.ledgerAvailable) {
      try {
        ledgerProvenance = await readLedgerProvenance(
          conn,
          input.personaSource === 'org' ? heldAssignments.map((assignment) => assignment.userId) : targetIds
        );
        options.ledgerTargets = ledgerProvenance;
      } catch (error) {
        hooks.warn(
          `Could not read Warden ledger provenance: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }
  const core = await strip.plan(
    conn,
    { ...stripOptionsSchema.parse(options), ...(ledgerProvenance ? { ledgerTargets: ledgerProvenance } : {}) },
    hooks.ctx
  );
  const removed = !personaMode
    ? new Map<string, Set<string>>()
    : input.personaSource === 'org'
    ? selectedPersonasByUser(heldAssignments, input.personas, input.allPersonas)
    : await selectedFilePersonasByUser(conn, core.states, input);
  return { core, personaMode, heldAssignments, ledgerProvenance, removedPersonasByUser: jsonPersonas(removed) };
};

const writePersonaRevocations = async (
  conn: Connection,
  output: LifecycleResult,
  assignments: HeldPersonaAssignment[],
  ledger: LedgerProvenance[],
  removedPersonasByUser: Record<string, string[]>,
  warn: (message: string) => void
): Promise<void> => {
  const [assignmentFields, ledgerFields, runFields] = await Promise.all([
    describeObjectFields(conn, PERSONA_ASSIGNMENT_OBJECT),
    describeObjectFields(conn, WARDEN_LEDGER_OBJECT),
    describeObjectFields(conn, WARDEN_RUN_OBJECT),
  ]);
  const assignmentsAvailable = Boolean(
    assignmentFields &&
      [PERSONA_ASSIGNMENT_STATUS_FIELD, 'wdn_Revoked_On__c', 'wdn_Revoked_By__c'].every((field) =>
        assignmentFields.has(field)
      )
  );
  if (!assignmentsAvailable)
    warn('Warden persona revocation fields are unavailable; skipped persona-assignment revocation bookkeeping.');
  const successfulUserIds = new Set(
    output.users.filter((user) => user.status !== 'failed').flatMap((user) => (user.id ? [user.id] : []))
  );
  const removedAssignments = assignments.filter(
    (assignment) =>
      successfulUserIds.has(assignment.userId) && removedPersonasByUser[assignment.userId]?.includes(assignment.persona)
  );
  let identity: { user_id?: string } | undefined;
  try {
    identity = await (conn as unknown as { identity?: () => Promise<{ user_id?: string }> }).identity?.();
  } catch (error) {
    warn(
      `Could not determine the running user for persona revocation: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  const now = new Date().toISOString();
  const runId =
    runFields?.has('wdn_Mode__c') && runFields.has('wdn_Source_System__c')
      ? await saveRun(conn, { wdn_Mode__c: 'Revoke', wdn_Source_System__c: 'Warden CLI' }, warn)
      : undefined;
  if (assignmentsAvailable) {
    await updateBatch(
      conn,
      PERSONA_ASSIGNMENT_OBJECT,
      removedAssignments.map((assignment) => ({
        Id: assignment.id,
        [PERSONA_ASSIGNMENT_STATUS_FIELD]: 'Revoked',
        wdn_Revoked_On__c: now,
        ...(identity?.user_id ? { wdn_Revoked_By__c: identity.user_id } : {}),
      })),
      warn,
      'persona assignment revocation'
    );
  }
  const successfulTargets = new Map<string, Set<string>>();
  for (const user of output.users) {
    if (!user.id) continue;
    successfulTargets.set(
      user.id,
      new Set(
        user.actions
          .filter((action) => action.key.startsWith('removed'))
          .flatMap((action) => action.items ?? [])
          .map((item) => item.id)
      )
    );
  }
  if (!ledgerFields || ['wdn_Revoked_On__c', 'wdn_Revoked_By_Run__c'].some((field) => !ledgerFields.has(field))) {
    warn('Warden ledger revocation fields are unavailable; skipped ledger revocation bookkeeping.');
    return;
  }
  await updateBatch(
    conn,
    WARDEN_LEDGER_OBJECT,
    ledger
      .filter(
        (row) =>
          successfulTargets.get(row.userId)?.has(row.targetId) &&
          removedPersonasByUser[row.userId]?.includes(row.persona)
      )
      .map((row) => ({ Id: row.id, wdn_Revoked_On__c: now, ...(runId ? { wdn_Revoked_By_Run__c: runId } : {}) })),
    warn,
    'ledger revocation'
  );
};

export const applyStripRequest = async (
  conn: Connection,
  planned: PlannedStripRequest,
  hooks: StripRequestHooks
): Promise<LifecycleResult> => {
  const result = await strip.apply(conn, planned.core, hooks.ctx);
  if (planned.personaMode) {
    await writePersonaRevocations(
      conn,
      result,
      planned.heldAssignments,
      planned.ledgerProvenance ?? [],
      planned.removedPersonasByUser,
      hooks.warn
    );
  }
  return result;
};

export const writeStripSnapshot = async (
  conn: Connection,
  planned: PlannedStripRequest,
  path: string,
  org: string | undefined,
  users: Array<{ status: string; actions: Array<ReturnType<typeof makeNotice>> }> = planned.core.states.map(
    (state) => state.result
  )
): Promise<void> => {
  const targets = planned.core.states.map((state) => state.target);
  const stateMaps = await loadAssignmentState(
    conn,
    targets.map((target) => target.Id)
  );
  const file = await buildSnapshotFile(conn, targets, stateMaps, org);
  await writeSnapshotFile(path, file);
  for (const user of users) if (user.status !== 'failed') user.actions.push(makeNotice('snapshotWritten'));
};
