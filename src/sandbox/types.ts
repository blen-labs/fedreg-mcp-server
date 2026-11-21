import type { SandboxLimits } from './limits.js';

export interface ExecuteOptions {
  code: string;
  timeoutMs?: number;
  memoryMb?: number;
  bindings?: string[];
  /** Overrides for the runner's byte budgets. */
  limits?: Partial<SandboxLimits>;
  /** Aborts the execution (client cancelled, server shutting down). */
  signal?: AbortSignal;
}

export interface ExecuteResult {
  ok: boolean;
  value?: unknown;
  logs: string[];
  error?: { name: string; message: string; status?: number };
  durationMs: number;
}

export type SandboxKind = 'isolate' | 'deno' | 'auto';

export interface SandboxRunner {
  kind: 'isolate' | 'deno' | 'unavailable';
  available(): Promise<boolean>;
  execute(opts: ExecuteOptions, rpc: RpcBridge): Promise<ExecuteResult>;
}

export interface RpcCall {
  binding: string;
  path: string[];
  args: unknown[];
}

export interface RpcContext {
  /** Aborted when the execution ends; in-flight and queued upstream work must stop. */
  signal?: AbortSignal;
}

export interface RpcBridge {
  dispatch(call: RpcCall, ctx?: RpcContext): Promise<{ ok: boolean; value?: unknown; error?: { name: string; message: string; status?: number } }>;
}

/**
 * Attached (non-enumerably) to a result whose sandbox process had not yet exited when the result
 * was returned. Resolves once it has. Callers must not release execution capacity before then.
 */
export const TEARDOWN = Symbol('fedreg.sandbox.teardown');
export type WithTeardown<T> = T & { [TEARDOWN]?: Promise<void> };
