import type { ExecuteOptions, ExecuteResult, RpcBridge, SandboxKind, SandboxRunner } from './types.js';
import { IsolateRunner } from './isolate.js';
import { DenoRunner } from './deno.js';

export { IsolateRunner, DenoRunner };
export type { SandboxKind, SandboxRunner } from './types.js';
export type { ExecuteOptions, ExecuteResult, RpcBridge, RpcCall } from './types.js';

/**
 * Placeholder runner that returns a clear error when `execute` is invoked.
 * Keeps `search_api` and `describe_schema` functional in environments where
 * neither `isolated-vm` nor `deno` is available.
 */
export class UnavailableRunner implements SandboxRunner {
  kind = 'unavailable' as const;
  constructor(private readonly reason: string) {}
  async available(): Promise<boolean> { return false; }
  async execute(_opts: ExecuteOptions, _rpc: RpcBridge): Promise<ExecuteResult> {
    return {
      ok: false,
      logs: [],
      error: { name: 'SandboxUnavailable', message: this.reason },
      durationMs: 0,
    };
  }
}

export async function pickSandbox(preferred: SandboxKind): Promise<SandboxRunner> {
  if (preferred === 'isolate') {
    const r = new IsolateRunner();
    if (await r.available()) return r;
    return new UnavailableRunner('isolated-vm is not installed on this platform; install it or run with --sandbox deno');
  }
  if (preferred === 'deno') {
    const r = new DenoRunner();
    if (await r.available()) return r;
    return new UnavailableRunner('Deno is not available on PATH; install Deno or run with --sandbox isolate');
  }
  const iso = new IsolateRunner();
  if (await iso.available()) return iso;
  const deno = new DenoRunner();
  if (await deno.available()) return deno;
  return new UnavailableRunner('No sandbox runner available. Install isolated-vm or Deno to use the `execute` tool. search_api and describe_schema still work.');
}
