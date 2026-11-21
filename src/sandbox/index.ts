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

/**
 * `auto` prefers isolated-vm (in-process, fastest) for single-user use (stdio, --insecure local).
 * With `processIsolation` (authenticated, multi-user HTTP serving) only the Deno runner is allowed:
 * user code must run in a separate, killable, permissionless process. There it never falls back
 * to the in-process runner; without Deno, `execute` is unavailable and says why.
 */
export async function pickSandbox(preferred: SandboxKind, opts: { processIsolation?: boolean } = {}): Promise<SandboxRunner> {
  if (opts.processIsolation && preferred === 'isolate') {
    throw new Error('--sandbox isolate runs user code inside the server process and is not allowed for authenticated multi-user HTTP serving. Use --sandbox deno (or auto) and install Deno.');
  }
  if (preferred === 'isolate') {
    const r = new IsolateRunner();
    if (await r.available()) return r;
    return new UnavailableRunner('isolated-vm is not available on this platform (it ships prebuilt binaries for Node 24 and 26 on macOS arm64, Linux x64/arm64 and Windows x64); run with --sandbox deno instead');
  }
  const deno = new DenoRunner();
  if (preferred === 'deno' || opts.processIsolation) {
    if (await deno.available()) return deno;
    return new UnavailableRunner(opts.processIsolation
      ? 'Multi-user HTTP serving runs code only in the Deno sandbox, and Deno is not on PATH. Install Deno (https://deno.com). search_api and describe_schema still work.'
      : 'Deno is not available on PATH; install Deno or run with --sandbox isolate');
  }
  const iso = new IsolateRunner();
  for (const r of [iso, deno]) if (await r.available()) return r;
  return new UnavailableRunner('No sandbox runner available. Use Node 24/26 on a platform with isolated-vm prebuilds, or install Deno, to use the `execute` tool. search_api and describe_schema still work.');
}
