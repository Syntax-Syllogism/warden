import { Messages, Org, SfError } from '@salesforce/core';
import { Flags } from '@salesforce/sf-plugins-core';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('@syntax-syllogism/warden', 'warden.shared');

export const targetOrgFlag = Flags.optionalOrg({ summary: messages.getMessage('flags.target-org.summary') });
export const apiVersionFlag = Flags.orgApiVersion({ summary: messages.getMessage('flags.api-version.summary') });
export const interactiveFlag = Flags.boolean({
  char: 'i',
  summary: messages.getMessage('flags.interactive.summary'),
});

export const userFlag = Flags.string({
  summary: messages.getMessage('flags.user.summary'),
});

export const usersDefFlag = Flags.file({
  exists: true,
  summary: messages.getMessage('flags.users-def.summary'),
});

export const externalIdFlag = Flags.string({ summary: messages.getMessage('flags.external-id.summary') });

export const inputFormatFlag = Flags.string({
  options: ['json', 'csv'] as const,
  summary: messages.getMessage('flags.input-format.summary'),
});

export const csvListDelimiterFlag = Flags.string({ summary: messages.getMessage('flags.csv-list-delimiter.summary') });
export const dryRunFlag = Flags.boolean({ default: false, summary: messages.getMessage('flags.dry-run.summary') });
export const noPromptFlag = Flags.boolean({ default: false, summary: messages.getMessage('flags.no-prompt.summary') });

export const assertInteractiveAllowed = (interactive: boolean | undefined, contextInteractive: boolean): void => {
  if (interactive && (!contextInteractive || !process.stdin.isTTY)) {
    throw new SfError(messages.getMessage('errorInteractiveGuard'));
  }
};

export const requireFlagValue = <T>(value: T | undefined, flagName: string): T => {
  if (value === undefined) throw new SfError(`Missing required flag ${flagName.replace(/^--/, '')}`);
  return value;
};

const isPresent = (value: unknown): boolean => value !== undefined;

export const requireExactlyOne = (
  flags: Record<string, unknown>,
  flagNames: readonly [string, string],
  anchor = flagNames[0]
): void => {
  const [first, second] = flagNames;
  const firstPresent = isPresent(flags[first]);
  const secondPresent = isPresent(flags[second]);
  if (firstPresent && secondPresent && anchor === first) {
    throw new SfError(`--${second} cannot also be provided when using --${first}`);
  }
  if (!firstPresent && !secondPresent) {
    throw new SfError(`Exactly one of the following must be provided: ${flagNames.map((name) => `--${name}`).join(', ')}`);
  }
};

export const requireFlagDependencies = (
  flags: Record<string, unknown>,
  flagName: string,
  dependencies: readonly string[]
): void => {
  if (!isPresent(flags[flagName]) || dependencies.every((dependency) => isPresent(flags[dependency]))) return;
  const requiredFlags = dependencies.map((name) => `--${name}`).join(', ');
  throw new SfError(`All of the following must be provided when using --${flagName}: ${requiredFlags}`);
};

export const requireTargetOrg = <T>(org: T | undefined): T => {
  if (!org) {
    throw new SfError('No default environment found. Use -o or --target-org to specify an environment.');
  }
  return org;
};

export const resolveOrgInteractively = async (org: Org | undefined, promptAlias: () => Promise<string>): Promise<Org> =>
  org ?? Org.create({ aliasOrUsername: await promptAlias() });

type InteractiveMetadata = {
  flags?: Record<string, { setFromDefault?: boolean }>;
};

type InteractiveRawToken = { type?: string; flag?: string };

export type InteractiveParse<T extends Record<string, unknown>> = {
  flags: T;
  metadata?: InteractiveMetadata;
  raw?: InteractiveRawToken[];
};

export type InteractivePrompt = {
  key: string;
  suppliedKeys?: string[];
  requireAllSupplied?: boolean;
  when?: (flags: Record<string, unknown>) => boolean;
  prompt: (flags: Record<string, unknown>) => Promise<unknown>;
  assign?: (flags: Record<string, unknown>, value: unknown) => Record<string, unknown> | void;
};

export const flagWasSupplied = <T extends Record<string, unknown>>(
  parsed: InteractiveParse<T>,
  flags: T,
  keys: string[]
): boolean => {
  const rawFlags = new Set(parsed.raw?.filter((token) => token.type === 'flag').map((token) => token.flag));
  if (keys.some((key) => rawFlags.has(key))) return true;
  if (keys.some((key) => parsed.metadata?.flags?.[key]?.setFromDefault === true)) return false;
  return keys.some((key) => flags[key] !== undefined);
};

const formatInteractiveValue = (value: unknown): string => {
  if (value === undefined || value === '') return '(none)';
  if (typeof value === 'object' && value !== null && 'getUsername' in value) {
    const username = (value as { getUsername: () => string | undefined }).getUsername();
    return username ?? '(none)';
  }
  if (Array.isArray(value)) return value.join(', ');
  return String(value);
};

export const resolveFlagsInteractively = async <T extends Record<string, unknown>>(
  parsed: InteractiveParse<T>,
  prompts: readonly InteractivePrompt[],
  options: { log: (message: string) => void; confirm: () => Promise<boolean>; validate?: (flags: T) => void }
): Promise<{ flags: T; confirmed: boolean }> => {
  const flags = { ...parsed.flags };
  options.validate?.(flags);
  for (const descriptor of prompts) {
    if (descriptor.when && !descriptor.when(flags)) continue;
    const suppliedKeys = descriptor.suppliedKeys ?? [descriptor.key];
    const supplied = descriptor.requireAllSupplied
      ? suppliedKeys.every((key) => flagWasSupplied(parsed, flags, [key]))
      : flagWasSupplied(parsed, flags, suppliedKeys);
    if (supplied) continue;
    // Prompts must remain sequential so each answer is collected predictably.
    // eslint-disable-next-line no-await-in-loop
    const value = await descriptor.prompt(flags);
    if (descriptor.assign) {
      const assignment = descriptor.assign(flags, value);
      if (assignment) Object.assign(flags, assignment);
    } else (flags as Record<string, unknown>)[descriptor.key] = value;
    options.validate?.(flags);
  }

  options.log(messages.getMessage('interactive.summary'));
  for (const [key, value] of Object.entries(flags)) {
    if (key !== 'interactive' && key !== 'json') options.log(`  --${key}: ${formatInteractiveValue(value)}`);
  }
  const confirmed = await options.confirm();
  if (!confirmed) options.log(messages.getMessage('interactive.declined'));
  return { flags, confirmed };
};
