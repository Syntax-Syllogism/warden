// Vendored from sfd d948fb7eaaace7cdaa7ee2d157f42c7de2b17755 packages/sfd-plugin/index.d.ts. Do not edit; re-copy.
/* eslint-disable */
import type { ZodType } from 'zod';
import type { Connection } from '@salesforce/core';

export type ApiVersion = 0;
export type Effect = 'read' | 'local-write' | 'org-write' | 'destructive';
export type OrgRequirement = 'required' | 'optional' | 'none';
export type OrgType = 'scratch' | 'sandbox' | 'production' | 'unknown';
export interface OperationDescriptor<O = unknown> {
  id: string;
  cliId?: string;
  title: string;
  summary: string;
  effects: Effect[];
  requiresOrg: OrgRequirement;
  requiresProject: boolean;
  optionsSchema: ZodType<O>;
  retry: 'safe' | 'unsafe';
  paged?: boolean;
}
export interface ProgressEvent {
  phase: string;
  done?: number;
  total?: number;
  message?: string;
}
export interface OrgInfo {
  alias?: string;
  username: string;
  apiVersion: string;
  type: OrgType;
  instanceUrl?: string;
}
export interface OperationContext {
  signal: AbortSignal;
  onProgress(event: ProgressEvent): void;
  notice(message: string): void;
  reportFailures?(count: number): void;
  projectRoot?: string;
  resolvePath(path: string): string;
  org?: OrgInfo;
}
export interface ReadOperation<O = unknown, R = unknown> {
  kind: 'read';
  descriptor: OperationDescriptor<O>;
  run(conn: Connection | undefined, options: O, ctx: OperationContext): Promise<R>;
}
export interface WritePlan {
  effects?: Effect[];
  summary?: string;
}
export interface WriteOperation<O = unknown, P extends object = WritePlan, R = unknown> {
  kind: 'write';
  descriptor: OperationDescriptor<O>;
  plan(conn: Connection | undefined, options: O, ctx: OperationContext): Promise<P & WritePlan>;
  apply(conn: Connection | undefined, plan: P & WritePlan, ctx: OperationContext): Promise<R>;
}
export type Operation = ReadOperation<any, any> | WriteOperation<any, any, any>;
export interface OperationModule {
  apiVersion: ApiVersion;
  operations: Operation[];
}
export interface OperationErrorShape {
  code: string;
  message: string;
  actions?: string[];
  retryable?: 'safe' | 'unsafe' | 'no';
}
export type Ok<R> = { ok: true; data: R; total?: number; truncated?: boolean; warnings: string[] };
export type Err = { ok: false; code: string; message: string; actions: string[]; retryable: 'safe' | 'unsafe' | 'no' };
export type Envelope<R> = Ok<R> | Err;
export interface SfdManifest {
  apiVersion: ApiVersion;
  operations: string;
  cli?: string;
  requires?: { sfd?: string };
}
export interface CliTable {
  apiVersion: ApiVersion;
  commands: CliCommand[];
}
export interface CliCommand {
  operation: string;
  name: string[];
  summary: string;
  agentTip?: string;
  docs?: string;
  sf?: string[];
  flags: CliFlag[];
  formatter?: 'table' | 'csv' | 'summary' | 'json' | { module: string };
}
export interface CliFlag {
  name: string;
  char?: string;
  type: 'string' | 'boolean' | 'integer' | 'file' | 'directory';
  multiple?: boolean;
  option?: string;
  required?: boolean;
}
export const API_VERSIONS: readonly ApiVersion[];
export const EFFECTS: readonly Effect[];
export function validateCliTable(table: unknown, operations?: readonly unknown[]): string[];
export function validateManifest(manifest: unknown): string[];
export function validateOperationModule(mod: unknown): string[];
export function effectsExceeding(ceiling: readonly Effect[], planEffects?: readonly Effect[]): Effect[];
export interface StubContext extends OperationContext {
  _progress: ProgressEvent[];
  _notices: string[];
  _failures?: number;
}
export function stubContext(overrides?: Partial<OperationContext> & { cwd?: string }): StubContext;
export function stubOrg(overrides?: Partial<OrgInfo>): OrgInfo;
export interface RunOperationOptions<O> {
  conn?: Connection;
  options: unknown;
  ctx?: OperationContext;
}
export function runOperation<O, R>(op: ReadOperation<O, R>, args: RunOperationOptions<O>): Promise<{ data: R }>;
export function runOperation<O, P extends object, R>(
  op: WriteOperation<O, P, R>,
  args: RunOperationOptions<O> & { confirmPlan?: (plan: P & WritePlan) => boolean | void | Promise<boolean | void> }
): Promise<{ plan: P & WritePlan; data?: R }>;
export function assertConformance(mod: unknown): void;
