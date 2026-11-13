import type { SandboxLimits } from './limits.js';

export interface ExecuteOptions {
  code: string;
  timeoutMs?: number;
  memoryMb?: number;
  bindings?: string[];
  /** Overrides for the runner's byte budgets. */
  limits?: Partial<SandboxLimits>;
}

export interface ExecuteResult {
  ok: boolean;
  value?: unknown;
  logs: string[];
  error?: { name: string; message: string; stack?: string; status?: number };
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

export interface RpcBridge {
  dispatch(call: RpcCall): Promise<{ ok: boolean; value?: unknown; error?: { name: string; message: string; status?: number } }>;
}
