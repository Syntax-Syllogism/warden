/* eslint-disable sf-plugin/command-summary, sf-plugin/command-example */
import type { Errors } from '@oclif/core';
import { SfError } from '@salesforce/core';
import { SfCommand } from '@salesforce/sf-plugins-core';
import { isWardenError, type WardenError } from '@syntax-syllogism/warden-core';
import {
  assertOutputCompatibility,
  emitOutput,
  resolveOutputFormat,
  type OutputFormat,
} from './userShared/outputFlags.js';

export type OutputContext = {
  format: OutputFormat;
  outputFile?: string;
  jsonOutput: boolean;
  /** True when stdout belongs to a human, so prompts and warnings are appropriate. */
  interactive: boolean;
};

/**
 * Pre-cutover, every one of these codes' call sites threw either a bare `new SfError(text)`
 * (name `SfError`) or a plain `new Error(text)` (name `Error`) — never a code-derived name.
 * `--json` consumers may match on `name`, so keep that split instead of deriving a new
 * PascalCase name from `error.code`.
 *
 * `errorInvalidUserValue` is deliberately absent: core reuses that single code for two
 * call sites that disagreed pre-cutover (`userLifecycle/targeting.ts`'s bare `Error` behind
 * `freeze`/`unfreeze`/`snapshot`/`strip`'s `--user` flag, vs. `userLifecycle/userDiff.ts`'s
 * `SfError`-wrapped `--user`/`--against` in `diff`'s user-to-user mode), so no single global
 * mapping can be right for both. `diff.ts` re-wraps that one code locally instead.
 */
const LEGACY_SF_ERROR_CODES = new Set<string>([
  'errorInvalidJson',
  'errorPersonasWithoutDefinition',
  'errorPromptDeclined',
  'errorInvalidUserMatchField',
  'errorInvalidAgainstMatchField',
  'errorInvalidAgainstValue',
]);

const toSfError = (error: WardenError): SfError => {
  const cause = 'cause' in error && error.cause instanceof Error ? error.cause : undefined;
  const name = LEGACY_SF_ERROR_CODES.has(error.code) ? 'SfError' : 'Error';
  // Pre-cutover call sites never attached a `data` payload to these errors; core's
  // `WardenError.data` is a debugging/matching aid for callers that inspect the error
  // (see `rethrowLegacyPersonaDefinitionError` above), not part of the `--json` envelope.
  // Copying it here would add a field golden `--json` error output never had.
  return new SfError(error.message, name, undefined, 1, cause);
};

/**
 * `diff`'s user-to-user mode pre-cutover wrapped an invalid `--user` value as `SfError`
 * (`userLifecycle/userDiff.ts`'s `parseUserFlagAsSfError`), unlike every other command's
 * `--user` flag (which let the bare `Error` through). Reproduce that one exception locally.
 */
export const rethrowLegacyUserValueError = (error: unknown): never => {
  if (isWardenError(error) && error.code === 'errorInvalidUserValue') throw new SfError(error.message);
  throw error;
};

/**
 * Core's zod-based definition schema collapses every personas-shape problem into the
 * generic `schema-invalid` code. Pre-cutover, a personas document missing its `personas`
 * key had its own fixed, command-specific message; reproduce that by recognizing the
 * single-issue-on-`personas` shape and swapping in the legacy text.
 */
export const rethrowLegacyPersonaDefinitionError = (
  error: unknown,
  personasPath: string | undefined,
  invalidPersonaDefinitionMessage: string
): never => {
  if (isWardenError(error) && error.code === 'schema-invalid' && personasPath) {
    const issues = (error.data as { issues?: Array<{ path?: unknown[] }> } | undefined)?.issues;
    if (issues?.some((issue) => issue.path?.length === 1 && issue.path[0] === 'personas')) {
      throw new SfError(invalidPersonaDefinitionMessage);
    }
  }
  throw error;
};

/** Keep successful JSON envelopes independent from a partial-failure exit code. */
export abstract class WardenCommand<T> extends SfCommand<T> {
  protected override async catch(error: Error | SfError | Errors.CLIError): Promise<never> {
    return super.catch(isWardenError(error) ? toSfError(error) : error);
  }

  protected override toSuccessJson(result: T): SfCommand.Json<T> {
    const exitCode = process.exitCode;
    try {
      process.exitCode = undefined;
      return super.toSuccessJson(result);
    } finally {
      process.exitCode = exitCode;
    }
  }

  /** Resolve and validate the command's shared output behavior. */
  protected resolveOutputContext(flags: { output?: unknown; 'output-file'?: unknown }): OutputContext {
    const format = resolveOutputFormat(flags.output);
    const outputFile = typeof flags['output-file'] === 'string' ? flags['output-file'] : undefined;
    const jsonOutput = this.jsonEnabled();
    assertOutputCompatibility(format, outputFile, jsonOutput);
    return { format, outputFile, jsonOutput, interactive: !jsonOutput };
  }

  protected async emitResult<R>(
    context: OutputContext,
    payload: { result: R; csv: string; human: string }
  ): Promise<void> {
    await emitOutput({
      ...payload,
      format: context.format,
      outputFile: context.outputFile,
      jsonOutput: context.jsonOutput,
      log: (message) => this.log(message),
    });
  }
}
