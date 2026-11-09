/* eslint-disable camelcase */
import { Messages, SfError } from '@salesforce/core';
import type { Connection } from '@salesforce/core';
import { Flags } from '@salesforce/sf-plugins-core';
import {
  describeUserFields,
  detectInputFormat,
  readProvisionDefinitions,
  renderLifecycleResult,
} from '@syntax-syllogism/warden-core';
import type { InputFormat } from '@syntax-syllogism/warden-core';
import {
  strip,
  stripOptionsSchema,
  buildSnapshotFile,
  loadAssignmentState,
  writeSnapshotFile,
  makeNotice,
} from '@syntax-syllogism/warden-core';
import type { LifecycleResult } from '@syntax-syllogism/warden-core';
import { renderStripCsv } from '@syntax-syllogism/warden-core';
import { toTargetOptions, validateUserTarget } from '../../userShared/useCaseOptions.js';
import { outputFlags } from '../../userShared/outputFlags.js';
import {
  apiVersionFlag,
  assertInteractiveAllowed,
  csvListDelimiterFlag,
  dryRunFlag,
  externalIdFlag,
  flagWasSupplied,
  interactiveFlag,
  inputFormatFlag,
  noPromptFlag,
  requireTargetOrg,
  requireExactlyOne,
  resolveFlagsInteractively,
  resolveOrgInteractively,
  targetOrgFlag,
  userFlag,
  usersDefFlag,
  type InteractiveParse,
  type InteractivePrompt,
} from '../../userShared/targetFlags.js';
import {
  confirmLifecycleWrites,
  effectiveInputFormat,
  promptBoolean,
  promptExistingFile,
  promptInputFormatForPath,
  promptOptionalApiVersion,
  promptOptionalText,
  promptPersonaSource,
  promptOrgAlias,
  promptOutputFormat,
  promptStripMode,
  promptStripSkips,
  promptText,
  promptUserSelection,
} from '../../userShared/prompting.js';
import { WardenCommand } from '../../wardenCommand.js';
import {
  PERSONA_ASSIGNMENT_OBJECT,
  PERSONA_ASSIGNMENT_STATUS_FIELD,
  readHeldPersonas,
  readOrgPersonas,
  personaPackageDetected,
} from '../../userShared/personas.js';
import {
  WARDEN_LEDGER_OBJECT,
  WARDEN_RUN_OBJECT,
  describeObjectFields,
  detectConnectedPackage,
  readLedgerProvenance,
  saveRun,
  updateBatch,
  type LedgerProvenance,
} from '../../userShared/orgWrites.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('@syntax-syllogism/warden', 'warden.strip');

type StripTarget = { Id: string; field: string; value: string };

const heldPersonasForTarget = (usersDoc: { users?: unknown }, target: StripTarget): string[] => {
  const users = usersDoc.users;
  if (!Array.isArray(users)) return [];
  const candidates: unknown[] = users;
  const user = candidates.find((candidate): candidate is Record<string, unknown> => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
    const record = candidate as Record<string, unknown>;
    const match = record.match;
    const matchField = typeof match === 'string' && match.length > 0 ? match : target.field;
    const value = Object.entries(record).find(([key]) => key.toLowerCase() === matchField.toLowerCase())?.[1];
    return typeof value === 'string' && value === target.value;
  });
  const personas = user?.personas;
  return Array.isArray(personas) ? personas.filter((persona): persona is string => typeof persona === 'string') : [];
};

const selectedPersonasByUser = (
  assignments: Awaited<ReturnType<typeof readHeldPersonas>>,
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
  states: Awaited<ReturnType<typeof strip.plan>>['states'],
  usersPath: string | undefined,
  personasPath: string | undefined,
  requestedInputFormat: InputFormat | undefined,
  csvListDelimiter: string | undefined,
  requestedPersonas: string[],
  allPersonas: boolean
): Promise<Map<string, Set<string>>> => {
  if (!usersPath) return new Map();
  const inputFormat = detectInputFormat(usersPath, requestedInputFormat);
  const definitions = await readProvisionDefinitions(usersPath, personasPath, {
    ...(inputFormat === 'csv' ? { inputFormat, fieldMap: await describeUserFields(conn), csvListDelimiter } : {}),
  });
  const selected = new Map<string, Set<string>>();
  for (const state of states) {
    const held = heldPersonasForTarget(definitions.usersDoc, state.target as StripTarget);
    const removed = allPersonas ? held : held.filter((persona) => requestedPersonas.includes(persona));
    if (removed.length > 0) selected.set(state.target.Id, new Set(removed));
  }
  return selected;
};

export default class UserStrip extends WardenCommand<LifecycleResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public static readonly flags = {
    'target-org': targetOrgFlag,
    user: userFlag,
    'users-def': usersDefFlag,
    'external-id': externalIdFlag,
    'input-format': inputFormatFlag,
    'csv-list-delimiter': csvListDelimiterFlag,
    'no-prompt': noPromptFlag,
    'dry-run': dryRunFlag,
    'no-freeze': Flags.boolean({ default: false, summary: messages.getMessage('flags.no-freeze.summary') }),
    'no-deactivate': Flags.boolean({ default: false, summary: messages.getMessage('flags.no-deactivate.summary') }),
    persona: Flags.string({ multiple: true, summary: messages.getMessage('flags.persona.summary') }),
    'all-personas': Flags.boolean({ default: false, summary: messages.getMessage('flags.all-personas.summary') }),
    'personas-def': Flags.file({ exists: true, summary: messages.getMessage('flags.personas-def.summary') }),
    'persona-source': Flags.string({
      options: ['file', 'org'] as const,
      summary: messages.getMessage('flags.persona-source.summary'),
    }),
    freeze: Flags.boolean({ default: false, summary: messages.getMessage('flags.freeze.summary') }),
    deactivate: Flags.boolean({ default: false, summary: messages.getMessage('flags.deactivate.summary') }),
    'keep-permsets': Flags.boolean({ default: false, summary: messages.getMessage('flags.keep-permsets.summary') }),
    'keep-permset-groups': Flags.boolean({
      default: false,
      summary: messages.getMessage('flags.keep-permset-groups.summary'),
    }),
    'keep-licenses': Flags.boolean({ default: false, summary: messages.getMessage('flags.keep-licenses.summary') }),
    'keep-public-groups': Flags.boolean({
      default: false,
      summary: messages.getMessage('flags.keep-public-groups.summary'),
    }),
    'keep-queues': Flags.boolean({ default: false, summary: messages.getMessage('flags.keep-queues.summary') }),
    snapshot: Flags.file({ summary: messages.getMessage('flags.snapshot.summary') }),
    ...outputFlags,
    'api-version': apiVersionFlag,
    interactive: interactiveFlag,
  };

  // eslint-disable-next-line complexity
  public async run(): Promise<LifecycleResult> {
    const parsed = await this.parse(UserStrip);
    let { flags } = parsed;
    assertInteractiveAllowed(flags.interactive, !this.jsonEnabled());
    let context = this.resolveOutputContext(flags);
    if (flags.interactive) {
      const parsedInteractive = parsed as InteractiveParse<typeof flags>;
      const hasUser = flagWasSupplied(parsedInteractive, flags, ['user']);
      const hasUsersDef = flagWasSupplied(parsedInteractive, flags, ['users-def']);
      // The interactive summary confirmation replaces the downstream operation gate.
      flags['no-prompt'] = true;
      const hasPersona = flagWasSupplied(parsedInteractive, flags, ['persona']) && (flags.persona?.length ?? 0) > 0;
      const hasAllPersonas = flagWasSupplied(parsedInteractive, flags, ['all-personas']) && flags['all-personas'];
      const suppliedPersonaFileMode = (hasPersona || hasAllPersonas) && flags['persona-source'] !== 'org';
      if (hasUser && hasUsersDef && !suppliedPersonaFileMode) requireExactlyOne(flags, ['user', 'users-def']);
      if (!hasPersona && !hasAllPersonas) {
        const mode = await promptStripMode();
        if (mode === 'selected-personas') {
          const selected = (await promptText('Persona API names (comma-separated)'))
            .split(',')
            .map((persona) => persona.trim())
            .filter(Boolean);
          if (selected.length === 0) throw new SfError(messages.getMessage('errorPersonaSelectionRequired'));
          flags.persona = selected;
        } else if (mode === 'all-personas') {
          flags['all-personas'] = true;
        }
      }
      const personaMode = (flags.persona?.length ?? 0) > 0 || flags['all-personas'];
      if (personaMode && !flagWasSupplied(parsedInteractive, flags, ['persona-source'])) {
        flags['persona-source'] = await promptPersonaSource();
      }
      const personaSource = flags['persona-source'] ?? 'file';
      const prompts: InteractivePrompt[] = [];
      let selection: 'user' | 'users-def' | undefined;
      if (personaMode && personaSource === 'file' && !hasUsersDef) {
        selection = 'users-def';
        prompts.push({ key: 'users-def', prompt: () => promptExistingFile('Users definition file') });
      } else if (!hasUser && !hasUsersDef) {
        selection = await promptUserSelection();
        prompts.push(
          selection === 'user'
            ? { key: 'user', prompt: () => promptText('User match (field:value)') }
            : { key: 'users-def', prompt: () => promptExistingFile('Users definition file') }
        );
      }
      if (hasUsersDef || selection === 'users-def') {
        prompts.push({ key: 'external-id', prompt: () => promptOptionalText('External ID field') });
        prompts.push({
          key: 'input-format',
          prompt: (resolvedFlags) => promptInputFormatForPath(resolvedFlags['users-def']),
        });
        prompts.push({
          key: 'csv-list-delimiter',
          when: (resolvedFlags) => effectiveInputFormat(resolvedFlags) === 'csv',
          prompt: () => promptText('CSV list delimiter', ';'),
        });
      }
      if (personaMode && personaSource === 'file' && !flagWasSupplied(parsedInteractive, flags, ['personas-def'])) {
        prompts.push({ key: 'personas-def', prompt: () => promptExistingFile('Persona definitions file') });
      }
      if (personaMode) {
        if (!flagWasSupplied(parsedInteractive, flags, ['freeze'])) {
          prompts.push({ key: 'freeze', prompt: () => promptBoolean('Freeze users?', flags.freeze) });
        }
        if (!flagWasSupplied(parsedInteractive, flags, ['deactivate'])) {
          prompts.push({ key: 'deactivate', prompt: () => promptBoolean('Deactivate users?', flags.deactivate) });
        }
      }
      const skipKeys = [
        ...(personaMode ? [] : ['no-freeze', 'no-deactivate']),
        'keep-permsets',
        'keep-permset-groups',
        'keep-licenses',
        'keep-public-groups',
        'keep-queues',
      ];
      const suppliedSkipKeys = skipKeys.filter((key) => flagWasSupplied(parsedInteractive, flags, [key]));
      prompts.push({
        key: 'strip-skips',
        prompt: () =>
          promptStripSkips(
            suppliedSkipKeys.filter((key) => (flags as Record<string, unknown>)[key] === true),
            suppliedSkipKeys
          ),
        assign: (currentFlags, value) =>
          Object.fromEntries(
            skipKeys.map((key) => [
              key,
              suppliedSkipKeys.includes(key) ? currentFlags[key] === true : (value as string[]).includes(key),
            ])
          ),
      });
      if (!flagWasSupplied(parsedInteractive, flags, ['snapshot'])) {
        prompts.push({ key: 'snapshot', prompt: () => promptOptionalText('Snapshot file path') });
      }
      if (!flagWasSupplied(parsedInteractive, flags, ['dry-run'])) {
        prompts.push({ key: 'dry-run', prompt: () => promptBoolean('Dry run?', flags['dry-run']) });
      }
      if (!flags['target-org']) flags['target-org'] = await resolveOrgInteractively(undefined, promptOrgAlias);
      prompts.push(
        { key: 'output', prompt: promptOutputFormat },
        { key: 'output-file', prompt: () => promptOptionalText('Output file path') },
        { key: 'api-version', prompt: () => promptOptionalApiVersion(flags['api-version']) }
      );
      const resolved = await resolveFlagsInteractively(parsedInteractive, prompts, {
        log: (message) => this.log(message),
        confirm: async (resolvedFlags) => {
          if (personaMode) {
            this.log(
              `Persona mode: remove ${
                resolvedFlags['all-personas'] ? 'all active personas' : (resolvedFlags.persona ?? []).join(', ')
              }. ` +
                `Source: ${resolvedFlags['persona-source'] ?? 'file'}. Freeze: ${
                  resolvedFlags.freeze ? 'yes' : 'no'
                }. ` +
                `Deactivate: ${resolvedFlags.deactivate ? 'yes' : 'no'}.`
            );
          }
          return this.confirm({ message: 'Proceed with these values?' });
        },
      });
      flags = resolved.flags;
      if (!resolved.confirmed) return { summary: { total: 0, changed: 0, unchanged: 0, failed: 0 }, users: [] };
      context = this.resolveOutputContext(flags);
    }
    const targetOrg = requireTargetOrg(flags['target-org']);
    const personas = flags.persona ?? [];
    const personaMode = personas.length > 0 || flags['all-personas'];
    const personaSource = flags['persona-source'] ?? 'file';
    if (!personaMode || personaSource !== 'file') requireExactlyOne(flags, ['user', 'users-def']);
    const conn = targetOrg.getConnection(flags['api-version'] ?? undefined);
    await validateUserTarget(conn, flags.user, (field) => messages.getMessage('errorInvalidUserMatchField', [field]));
    const baseOptions = {
      ...toTargetOptions(flags),
      noFreeze: flags['no-freeze'],
      noDeactivate: flags['no-deactivate'],
      keepPermsets: flags['keep-permsets'],
      keepPermsetGroups: flags['keep-permset-groups'],
      keepPublicGroups: flags['keep-public-groups'],
      keepQueues: flags['keep-queues'],
      keepLicenses: flags['keep-licenses'],
    };
    let ledgerProvenance: LedgerProvenance[] | undefined;
    let heldAssignments: Awaited<ReturnType<typeof readHeldPersonas>> = [];
    let selectedStates: Awaited<ReturnType<typeof strip.plan>>['states'] | undefined;
    let stripOptions: Record<string, unknown> = {
      ...baseOptions,
      personas,
      allPersonas: flags['all-personas'],
      personasPath: flags['personas-def'],
      personaSource,
      freeze: flags.freeze,
      deactivate: flags.deactivate,
    };
    if (personaMode && personaSource === 'org') {
      // Core owns the planner, while this adapter owns package-backed persona assignment I/O.
      if (!(await personaPackageDetected(conn))) {
        throw new SfError('--persona-source org requires the Warden package with persona objects installed.');
      }
      const selection = await strip.plan(conn, stripOptionsSchema.parse(baseOptions));
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
        const names = heldByUser.get(assignment.userId) ?? [];
        names.push(assignment.persona);
        heldByUser.set(assignment.userId, names);
      }
      stripOptions = {
        ...baseOptions,
        // Core's org source is intentionally rejected: provide its pure planner an in-memory file-shaped document.
        usersDoc: {
          users: targets.map((target) => ({
            match: target.field,
            [target.field]: target.value,
            personas: heldByUser.get(target.Id) ?? [],
          })),
        },
        personasDoc: orgPersonas.document,
        personas,
        allPersonas: flags['all-personas'],
        personaSource: 'file',
        freeze: flags.freeze,
        deactivate: flags.deactivate,
      };
      delete stripOptions.user;
      delete stripOptions.usersPath;
      delete stripOptions.externalId;
      delete stripOptions.inputFormat;
      delete stripOptions.csvListDelimiter;
    }
    if (personaMode) {
      const connected = await detectConnectedPackage(conn);
      if (!selectedStates) selectedStates = (await strip.plan(conn, stripOptionsSchema.parse(baseOptions))).states;
      const targetIds = selectedStates.map((state) => state.target.Id);
      if (personaSource === 'file' && (await personaPackageDetected(conn))) {
        try {
          heldAssignments = await readHeldPersonas(conn, targetIds);
        } catch (error) {
          this.warn(
            `Could not read Warden persona assignments: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
      if (connected.ledgerAvailable) {
        try {
          ledgerProvenance = await readLedgerProvenance(
            conn,
            personaSource === 'org' ? heldAssignments.map((assignment) => assignment.userId) : targetIds
          );
          stripOptions.ledgerTargets = ledgerProvenance;
        } catch (error) {
          this.warn(
            `Could not read Warden ledger provenance: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
    }
    const plan = await strip.plan(conn, {
      ...stripOptionsSchema.parse(stripOptions),
      ...(ledgerProvenance ? { ledgerTargets: ledgerProvenance } : {}),
    });
    let removedPersonasByUser = new Map<string, Set<string>>();
    if (personaMode && !flags['dry-run']) {
      removedPersonasByUser =
        personaSource === 'org'
          ? selectedPersonasByUser(heldAssignments, personas, flags['all-personas'])
          : await selectedFilePersonasByUser(
              conn,
              plan.states,
              flags['users-def'],
              flags['personas-def'],
              flags['input-format'] as InputFormat | undefined,
              flags['csv-list-delimiter'],
              personas,
              flags['all-personas']
            );
    }
    if (personaMode && !context.jsonOutput) {
      this.log(
        messages.getMessage('info.personaMode', [
          flags['all-personas'] ? 'all active personas' : personas.join(', '),
          String(plan.states.length),
          flags.freeze ? 'yes' : 'no',
          flags.deactivate ? 'yes' : 'no',
        ])
      );
    }
    await confirmLifecycleWrites({
      required:
        !flags['dry-run'] && plan.states.some((state) => state.hasDml) && !flags['no-prompt'] && context.interactive,
      message: messages.getMessage.bind(messages),
      confirm: (message) => this.confirm({ message }),
      warn: (message) => this.warn(message),
    });
    if (flags.snapshot) {
      const targets = plan.states.map((state) => state.target);
      const stateMaps = await loadAssignmentState(
        conn,
        targets.map((target) => target.Id)
      );
      const file = await buildSnapshotFile(conn, targets, stateMaps, targetOrg.getUsername());
      await writeSnapshotFile(flags.snapshot, file);
      const users = flags['dry-run']
        ? plan.preview.users.filter((user) => user.status !== 'failed')
        : plan.states.map((state) => state.result);
      for (const user of users) user.actions.push(makeNotice('snapshotWritten'));
    }
    const output = flags['dry-run'] ? plan.preview : await strip.apply(conn, plan);
    if (personaMode && !flags['dry-run']) {
      await this.writePersonaRevocations(conn, output, heldAssignments, ledgerProvenance ?? [], removedPersonasByUser);
    }
    await this.emitResult(context, {
      result: output,
      csv: renderStripCsv(output),
      human: renderLifecycleResult(output, messages.getMessage.bind(messages)),
    });
    if (output.summary.failed > 0) process.exitCode = 1;
    return output;
  }

  private async writePersonaRevocations(
    conn: Connection,
    output: LifecycleResult,
    assignments: Awaited<ReturnType<typeof readHeldPersonas>>,
    ledger: LedgerProvenance[],
    removedPersonasByUser: ReadonlyMap<string, ReadonlySet<string>>
  ): Promise<void> {
    const assignmentFields = await describeObjectFields(conn, PERSONA_ASSIGNMENT_OBJECT);
    const ledgerFields = await describeObjectFields(conn, WARDEN_LEDGER_OBJECT);
    const runFields = await describeObjectFields(conn, WARDEN_RUN_OBJECT);
    const requiredAssignmentFields = [PERSONA_ASSIGNMENT_STATUS_FIELD, 'wdn_Revoked_On__c', 'wdn_Revoked_By__c'];
    const assignmentsAvailable = Boolean(
      assignmentFields && requiredAssignmentFields.every((field) => assignmentFields.has(field))
    );
    if (!assignmentsAvailable) {
      this.warn('Warden persona revocation fields are unavailable; skipped persona-assignment revocation bookkeeping.');
    }
    const successfulUserIds = new Set(
      output.users.filter((user) => user.status !== 'failed').flatMap((user) => (user.id ? [user.id] : []))
    );
    const removedAssignments = assignments.filter(
      (assignment) =>
        successfulUserIds.has(assignment.userId) &&
        removedPersonasByUser.get(assignment.userId)?.has(assignment.persona)
    );
    let identity: { user_id?: string } | undefined;
    try {
      identity = await (conn as unknown as { identity?: () => Promise<{ user_id?: string }> }).identity?.();
    } catch (error) {
      this.warn(
        `Could not determine the running user for persona revocation: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
    const now = new Date().toISOString();
    const runId =
      runFields?.has('wdn_Mode__c') && runFields.has('wdn_Source_System__c')
        ? await saveRun(conn, { wdn_Mode__c: 'Revoke', wdn_Source_System__c: 'Warden CLI' }, (message) =>
            this.warn(message)
          )
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
        (message) => this.warn(message),
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
    const requiredLedgerFields = ['wdn_Revoked_On__c', 'wdn_Revoked_By_Run__c'];
    if (!ledgerFields || requiredLedgerFields.some((field) => !ledgerFields.has(field))) {
      this.warn('Warden ledger revocation fields are unavailable; skipped ledger revocation bookkeeping.');
      return;
    }
    await updateBatch(
      conn,
      WARDEN_LEDGER_OBJECT,
      ledger
        .filter(
          (row) =>
            successfulTargets.get(row.userId)?.has(row.targetId) &&
            removedPersonasByUser.get(row.userId)?.has(row.persona)
        )
        .map((row) => ({ Id: row.id, wdn_Revoked_On__c: now, ...(runId ? { wdn_Revoked_By_Run__c: runId } : {}) })),
      (message) => this.warn(message),
      'ledger revocation'
    );
  }
}
