/* eslint-disable camelcase */
import { Messages, SfError, type Connection } from '@salesforce/core';
import { Flags } from '@salesforce/sf-plugins-core';
import { describeUserFields } from '@syntax-syllogism/warden-core';
import { renderProvisionCsv, renderProvisionHuman } from '@syntax-syllogism/warden-core';
import { detectInputFormat, type InputFormat } from '@syntax-syllogism/warden-core';
import { parseUsersDefinition, DefinitionError } from '@syntax-syllogism/warden-core';
import { provision, provisionOptionsSchema, type ProvisionResult } from '@syntax-syllogism/warden-core';
import { readProvisionDefinitions } from '@syntax-syllogism/warden-core';
import { confirmWithTimeout } from '../../userShared/prompting.js';
import { applyProvisionWithLegacyOutput } from '../../userShared/useCaseOptions.js';
import { outputFlags } from '../../userShared/outputFlags.js';
import {
  buildLedgerRows,
  buildProvenance,
  buildReconciliationItems,
  captureProvisioningWrites,
  detectConnectedPackage,
  saveRun,
  updateRun,
  bestEffortOrgWrite,
  writeBatch,
  WARDEN_ITEM_OBJECT,
  WARDEN_LEDGER_OBJECT,
  type ConnectedPackage,
} from '../../userShared/orgWrites.js';
import {
  apiVersionFlag,
  assertInteractiveAllowed,
  csvListDelimiterFlag,
  dryRunFlag,
  flagWasSupplied,
  inputFormatFlag,
  interactiveFlag,
  requireFlagValue,
  requireTargetOrg,
  resolveFlagsInteractively,
  resolveOrgInteractively,
  targetOrgFlag,
  type InteractiveParse,
  type InteractivePrompt,
} from '../../userShared/targetFlags.js';
import {
  effectiveInputFormat,
  promptBoolean,
  promptExistingFile,
  promptInputFormatForPath,
  promptOptionalApiVersion,
  promptOptionalExistingFile,
  promptOptionalText,
  promptOrgAlias,
  promptOutputFormat,
  promptText,
} from '../../userShared/prompting.js';
import { rethrowLegacyPersonaDefinitionError, WardenCommand } from '../../wardenCommand.js';
import { PERSONA_OBJECT, personaPackageDetected, readOrgPersonas } from '../../userShared/personas.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('@syntax-syllogism/warden', 'warden.provision');

type ProvisionDefinitions = Awaited<ReturnType<typeof readProvisionDefinitions>>;
type PersonaSource = 'file' | 'org';

export default class UserProvision extends WardenCommand<ProvisionResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public static readonly flags = {
    'target-org': targetOrgFlag,
    'users-def': Flags.file({ exists: true, summary: messages.getMessage('flags.users-def.summary') }),
    'personas-def': Flags.file({
      exists: true,
      summary: messages.getMessage('flags.personas-def.summary'),
    }),
    'persona-source': Flags.string({
      options: ['file', 'org'] as const,
      summary: messages.getMessage('flags.persona-source.summary'),
    }),
    'related-def': Flags.file({
      exists: true,
      summary: messages.getMessage('flags.related-def.summary'),
    }),
    'external-id': Flags.string({
      aliases: ['match-field'],
      summary: messages.getMessage('flags.external-id.summary'),
    }),
    'input-format': inputFormatFlag,
    'csv-list-delimiter': csvListDelimiterFlag,
    'fuzzy-username': Flags.boolean({ default: false, summary: messages.getMessage('flags.fuzzy-username.summary') }),
    'no-prompt': Flags.boolean({ default: false, summary: messages.getMessage('flags.no-prompt.summary') }),
    'dry-run': dryRunFlag,
    'cleanup-on-failure': Flags.boolean({
      default: false,
      summary: messages.getMessage('flags.cleanup-on-failure.summary'),
      description: messages.getMessage('flags.cleanup-on-failure.description'),
    }),
    'fail-on-insufficient-license': Flags.boolean({
      default: false,
      summary: messages.getMessage('flags.fail-on-insufficient-license.summary'),
    }),
    'log-to-org': Flags.boolean({
      default: false,
      allowNo: true,
      summary: messages.getMessage('flags.log-to-org.summary'),
    }),
    'log-detail': Flags.string({
      options: ['summary', 'full'] as const,
      default: 'summary',
      summary: messages.getMessage('flags.log-detail.summary'),
    }),
    ...outputFlags,
    'api-version': apiVersionFlag,
    interactive: interactiveFlag,
  };

  // eslint-disable-next-line complexity
  public async run(): Promise<ProvisionResult> {
    const parsed = await this.parse(UserProvision);
    let { flags } = parsed;
    assertInteractiveAllowed(flags.interactive, !this.jsonEnabled());
    let context = this.resolveOutputContext(flags);
    if (flags.interactive) {
      const parsedInteractive = parsed as InteractiveParse<typeof flags>;
      // The interactive summary confirmation replaces the downstream operation gate.
      flags['no-prompt'] = true;
      const prompts: InteractivePrompt[] = [];
      if (!flagWasSupplied(parsedInteractive, flags, ['users-def'])) {
        prompts.push({ key: 'users-def', prompt: () => promptExistingFile('Users definition file') });
      }
      if (!flagWasSupplied(parsedInteractive, flags, ['personas-def'])) {
        prompts.push({ key: 'personas-def', prompt: () => promptOptionalExistingFile('Personas definition file') });
      }
      if (!flagWasSupplied(parsedInteractive, flags, ['external-id'])) {
        prompts.push({ key: 'external-id', prompt: () => promptOptionalText('External ID field') });
      }
      prompts.push({
        key: 'input-format',
        prompt: (resolvedFlags) => promptInputFormatForPath(resolvedFlags['users-def']),
      });
      prompts.push({
        key: 'related-def',
        when: (resolvedFlags) => effectiveInputFormat(resolvedFlags) !== 'csv',
        prompt: () => promptOptionalExistingFile('Related record definition file'),
      });
      prompts.push({
        key: 'csv-list-delimiter',
        when: (resolvedFlags) => effectiveInputFormat(resolvedFlags) === 'csv',
        prompt: () => promptText('CSV list delimiter', ';'),
      });
      if (!flagWasSupplied(parsedInteractive, flags, ['fuzzy-username'])) {
        prompts.push({
          key: 'fuzzy-username',
          prompt: () => promptBoolean('Allow fuzzy usernames?', flags['fuzzy-username']),
        });
      }
      if (!flagWasSupplied(parsedInteractive, flags, ['dry-run'])) {
        prompts.push({ key: 'dry-run', prompt: () => promptBoolean('Dry run?', flags['dry-run']) });
      }
      if (!flagWasSupplied(parsedInteractive, flags, ['fail-on-insufficient-license'])) {
        prompts.push({
          key: 'fail-on-insufficient-license',
          prompt: () => promptBoolean('Fail when licenses are insufficient?', flags['fail-on-insufficient-license']),
        });
      }
      if (!flags['target-org']) flags['target-org'] = await resolveOrgInteractively(undefined, promptOrgAlias);
      prompts.push(
        { key: 'output', prompt: promptOutputFormat },
        { key: 'output-file', prompt: () => promptOptionalText('Output file path') },
        { key: 'api-version', prompt: () => promptOptionalApiVersion(flags['api-version']) }
      );
      const resolved = await resolveFlagsInteractively(parsedInteractive, prompts, {
        log: (message) => this.log(message),
        confirm: () => this.confirm({ message: 'Proceed with these values?' }),
        validate: (resolvedFlags) => {
          if (resolvedFlags['related-def'] && effectiveInputFormat(resolvedFlags) === 'csv') {
            throw new SfError(messages.getMessage('errorRelatedRequiresJson'));
          }
        },
      });
      flags = resolved.flags;
      if (!resolved.confirmed) {
        return { summary: { total: 0, created: 0, updated: 0, failed: 0, warnings: 0 }, users: [] };
      }
      context = this.resolveOutputContext(flags);
    }
    const targetOrg = requireTargetOrg(flags['target-org']);
    const usersPath = requireFlagValue(flags['users-def'], '--users-def');
    const logToOrg = flags['log-to-org'] === true;
    const logDetail = flags['log-detail'] === 'full' ? 'full' : 'summary';
    const inputFormat = detectInputFormat(usersPath, flags['input-format'] as InputFormat | undefined);
    // Refuse before the connection is used, so a misconfigured invocation costs zero API calls.
    if (flags['related-def'] && inputFormat === 'csv') {
      throw new SfError(messages.getMessage('errorRelatedRequiresJson'));
    }
    const conn = targetOrg.getConnection(flags['api-version'] ?? undefined);
    const personaSource: PersonaSource =
      (flags['persona-source'] as PersonaSource | undefined) ??
      (flags['personas-def'] ? 'file' : (await personaPackageDetected(conn)) ? 'org' : 'file');
    let orgPersonas: Awaited<ReturnType<typeof readOrgPersonas>> | undefined;
    if (personaSource === 'org') orgPersonas = await readOrgPersonas(conn);
    let definitions: ProvisionDefinitions;
    try {
      definitions = await readProvisionDefinitions(
        usersPath,
        personaSource === 'file' ? flags['personas-def'] : undefined,
        {
          relatedPath: flags['related-def'],
          ...(inputFormat === 'csv'
            ? { inputFormat, fieldMap: await describeUserFields(conn), csvListDelimiter: flags['csv-list-delimiter'] }
            : {}),
        },
        (path, error) => messages.getMessage('errorInvalidJson', [path, error])
      );
    } catch (error) {
      return rethrowLegacyPersonaDefinitionError(
        error,
        flags['personas-def'],
        messages.getMessage('errorInvalidPersonaDefinition')
      );
    }
    // The legacy reader reparsed CSV rows through the schema, dropping source metadata.
    // Keep that machine-output contract until a separate change explicitly adopts source prefixes.
    const usersDoc = parseUsersDefinition(definitions.usersDoc);
    definitions.usersDoc = usersDoc;
    if (personaSource === 'file' && !definitions.personasSupplied) {
      const users = usersDoc.users;
      const index = users.findIndex((user) => Object.keys(user).some((key) => key.toLowerCase() === 'personas'));
      if (index >= 0) {
        const user = users[index] as Record<string, unknown>;
        const identity = ['FederationIdentifier', 'Username', 'Email']
          .map((field) => user[Object.keys(user).find((key) => key.toLowerCase() === field.toLowerCase()) ?? ''])
          .find((value) => typeof value === 'string' && value.length > 0);
        throw new DefinitionError(
          'errorPersonasWithoutDefinition',
          messages.getMessage('errorPersonasWithoutDefinition', [String(identity ?? index + 1)])
        );
      }
    }
    const ledgerPersonasDoc = orgPersonas?.document ?? definitions.personasDoc;
    const personaSourceLabel =
      personaSource === 'org'
        ? `org (${PERSONA_OBJECT}, ${orgPersonas?.count ?? 0} personas)`
        : `file${flags['personas-def'] ? ` (${flags['personas-def']})` : ' (no --personas-def)'}${
            flags['persona-source'] ? '' : ' [default]'
          }`;
    // Connected writes are intentionally composed around the core use case. Core remains
    // responsible for provisioning policy and DML; this adapter only observes successful
    // assignment inserts and persists optional audit records.
    let connectedPackage: ConnectedPackage = { ledgerAvailable: false, runAvailable: false };
    let runId: string | undefined;
    let capturedWrites: ReturnType<typeof captureProvisioningWrites> | undefined;
    // The command contract keeps dry-run completely write-free, including optional audit sinks.
    const connectedWritesRequested = !flags['dry-run'];
    if (connectedWritesRequested) {
      connectedPackage = await detectConnectedPackage(conn);
      if (connectedPackage.ledgerAvailable) capturedWrites = captureProvisioningWrites(conn);
    }
    const provisioningConnection = capturedWrites?.connection ?? conn;

    if (flags['dry-run'] && flags['cleanup-on-failure']) {
      this.warn(messages.getMessage('warning.cleanupIgnoredInDryRun'));
    }
    const plan = await provision.plan(
      provisioningConnection,
      provisionOptionsSchema.parse({
        usersDoc: definitions.usersDoc,
        personasDoc: orgPersonas?.document ?? definitions.personasDoc,
        personasSupplied: personaSource === 'org' ? true : definitions.personasSupplied,
        relatedDoc: definitions.relatedDoc,
        csvListDelimiter: flags['csv-list-delimiter'],
        externalId: flags['external-id'],
        fuzzyUsername: flags['fuzzy-username'],
        cleanupOnFailure: flags['cleanup-on-failure'],
      })
    );
    if (plan.warnings.length > 0 && context.interactive) {
      await this.acknowledgeWarnings(plan.warnings, flags['no-prompt'] || Boolean(flags.interactive));
    }
    if (logToOrg && connectedPackage.runAvailable) {
      const provenance = buildProvenance({
        definitionPath: flags['personas-def'] ?? usersPath,
      });
      runId = await saveRun(
        provisioningConnection,
        {
          wdn_Mode__c: flags['dry-run'] ? 'Preview' : 'Apply',
          wdn_Scope__c: [usersPath, flags['personas-def']].filter(Boolean).join(', '),
          wdn_Planned_Count__c: 0,
          wdn_Applied_Count__c: 0,
          wdn_Error_Count__c: 0,
          wdn_Unmanaged_Count__c: 0,
          wdn_Source_System__c: provenance.sourceSystem,
          wdn_Cli_Version__c: provenance.cliVersion,
          wdn_Invoking_User__c: provenance.invokingUser,
          wdn_Ci_Job__c: provenance.ciJob,
          wdn_Definition_Path__c: provenance.definitionPath,
          wdn_Definition_Sha__c: provenance.definitionSha,
        },
        (message) => this.warn(message)
      );
    }
    const output = flags['dry-run']
      ? plan.preview
      : await applyProvisionWithLegacyOutput(provisioningConnection, plan, messages.getMessage.bind(messages));

    await this.writeConnectedRecords({
      connection: provisioningConnection,
      connectedPackage,
      capturedWrites,
      personasDoc: ledgerPersonasDoc,
      output,
      runId,
      logDetail,
      dryRun: flags['dry-run'],
    });

    const result = { ...output, personaSource: personaSourceLabel };
    const csv = renderProvisionCsv(output);
    if (!context.jsonOutput) {
      this.warnUserFailures(output);
      this.warnLicenseShortfalls(output);
    }
    await this.emitResult(context, {
      result,
      csv,
      human: renderProvisionHuman(output, personaSourceLabel, messages.getMessage.bind(messages)),
    });
    if (output.summary.failed > 0) process.exitCode = 1;
    if (flags['fail-on-insufficient-license'] && output.licenses?.some((license) => license.shortfall > 0)) {
      const shortfalls = output.licenses
        .filter((license) => license.shortfall > 0)
        .map((license) => `${license.licenseName} (${license.shortfall})`)
        .join(', ');
      throw Object.assign(new SfError(messages.getMessage('errorInsufficientLicense', [shortfalls])), {
        result: output,
      });
    }
    return result;
  }

  private async acknowledgeWarnings(warnings: string[], noPrompt: boolean): Promise<void> {
    for (const warning of warnings) this.warn(warning);
    if (noPrompt) return;
    const { confirmed } = await confirmWithTimeout(
      (message) => this.confirm({ message }),
      messages.getMessage('promptWarningsContinue')
    );
    if (!confirmed) {
      this.warn(messages.getMessage('warningPromptTimeout'));
      throw new SfError(messages.getMessage('errorPromptDeclined'));
    }
  }

  private warnUserFailures(output: ProvisionResult): void {
    for (const user of output.users) {
      if (user.errors.length > 0)
        this.warn(messages.getMessage('warningUserFailed', [user.key, user.errors.join('; ')]));
    }
  }

  private warnLicenseShortfalls(output: ProvisionResult): void {
    for (const license of output.licenses ?? []) {
      if (license.shortfall > 0)
        this.warn(messages.getMessage('warningInsufficientLicense', [license.licenseName, license.shortfall]));
    }
  }

  private async writeConnectedRecords(options: {
    connection: Connection;
    connectedPackage: ConnectedPackage;
    capturedWrites?: ReturnType<typeof captureProvisioningWrites>;
    personasDoc?: ProvisionDefinitions['personasDoc'];
    output: ProvisionResult;
    runId?: string;
    logDetail: 'summary' | 'full';
    dryRun: boolean;
  }): Promise<void> {
    const warn = (message: string): void => {
      this.warn(message);
    };
    try {
      if (!options.dryRun && options.connectedPackage.ledgerAvailable && options.capturedWrites) {
        const ledgerRows = buildLedgerRows({
          grants: options.capturedWrites.state.grants,
          result: options.output,
          personasDoc: options.personasDoc,
          labelsByTypeAndId: options.capturedWrites.state.labelsByTypeAndId,
          referenceIdsByType: options.capturedWrites.state.referenceIdsByType,
          runId: options.runId,
        });
        await bestEffortOrgWrite(
          () => writeBatch(options.connection, WARDEN_LEDGER_OBJECT, ledgerRows, warn, 'ledger'),
          warn,
          'ledger'
        );
      }
      if (!options.runId) return;
      const items = options.logDetail === 'full' ? buildReconciliationItems(options.output, options.runId) : [];
      if (items.length > 0) {
        await bestEffortOrgWrite(
          () => writeBatch(options.connection, WARDEN_ITEM_OBJECT, items, warn, 'item'),
          warn,
          'item'
        );
      }
      await updateRun(
        options.connection,
        options.runId,
        {
          wdn_Planned_Count__c: options.logDetail === 'full' ? items.length : options.output.summary.total,
          wdn_Applied_Count__c: options.output.users.filter(
            (user) => user.status === 'created' || user.status === 'updated'
          ).length,
          wdn_Error_Count__c: options.output.summary.failed,
          wdn_Unmanaged_Count__c: 0,
        },
        warn
      );
    } catch (error) {
      // Connected records are an audit sink. They must never change provisioning's result.
      warn(`Warden org audit write failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
