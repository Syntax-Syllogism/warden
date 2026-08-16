/* eslint-disable sf-plugin/command-summary, sf-plugin/command-example */
import { SfCommand } from '@salesforce/sf-plugins-core';
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

/** Keep successful JSON envelopes independent from a partial-failure exit code. */
export abstract class WardenCommand<T> extends SfCommand<T> {
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
