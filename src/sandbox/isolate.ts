import type { ExecuteOptions, ExecuteResult, RpcBridge, SandboxRunner } from './types.js';
import { preflight } from './policy.js';

type IvmModule = {
  Isolate: new (opts?: { memoryLimit?: number }) => {
    createContext(): Promise<unknown>;
    compileScript(s: string): Promise<{ run(ctx: unknown, opts: unknown): Promise<unknown> }>;
    dispose(): void;
  };
  ExternalCopy: new (v: unknown) => { copyInto(): unknown };
  Reference: new (v: unknown) => unknown;
};

async function loadIvm(): Promise<IvmModule> {
  const mod = await import('isolated-vm') as Record<string, unknown> & { default?: Record<string, unknown> };
  const candidate = (typeof mod.Isolate === 'function' ? mod : mod.default ?? {}) as Record<string, unknown>;
  if (typeof candidate.Isolate !== 'function') throw new Error('isolated-vm native binding unavailable');
  return candidate as unknown as IvmModule;
}

export class IsolateRunner implements SandboxRunner {
  kind = 'isolate' as const;

  async available(): Promise<boolean> {
    try {
      const ivm = await loadIvm();
      // Confirm the native binding actually loaded by exercising it.
      const iso = new ivm.Isolate({ memoryLimit: 16 });
      iso.dispose();
      return true;
    } catch {
      return false;
    }
  }

  async execute(opts: ExecuteOptions, rpc: RpcBridge): Promise<ExecuteResult> {
    const started = Date.now();
    const policy = preflight(opts.code);
    if (!policy.ok) {
      return {
        ok: false,
        logs: [],
        error: { name: 'PolicyError', message: policy.errors.join('; ') },
        durationMs: Date.now() - started,
      };
    }

    // dynamic import — keeps the optional dep optional at runtime.
    const ivm = await loadIvm() as any;
    const isolate = new ivm.Isolate({ memoryLimit: opts.memoryMb ?? 64 });
    const context = await isolate.createContext();
    const jail = context.global;
    await jail.set('global', jail.derefInto());

    const logs: string[] = [];

    // host-side log sink
    await context.evalClosure(
      `globalThis.console = { log: (...a) => $0.applyIgnored(undefined, [a.map(String).join(' ')]),
                              error: (...a) => $0.applyIgnored(undefined, [a.map(String).join(' ')]),
                              warn: (...a) => $0.applyIgnored(undefined, [a.map(String).join(' ')]),
                              info: (...a) => $0.applyIgnored(undefined, [a.map(String).join(' ')]) };`,
      [(line: string) => logs.push(String(line))],
      { arguments: { reference: true } },
    );

    // RPC bridge — pass the host function directly; `arguments: { reference: true }`
    // auto-wraps each argument as a Reference inside the isolate.
    const hostRpc = async (binding: string, path: string[], args: unknown[]) => {
      const result = await rpc.dispatch({ binding: binding as 'fr' | 'ecfr', path, args });
      return new ivm.ExternalCopy(result).copyInto();
    };

    await context.evalClosure(
      `function makeProxy(binding, rpc) {
         const handler = (path) => new Proxy(function(){}, {
           get(_, key) { return handler([...path, String(key)]); },
           apply(_, __, args) {
             return rpc.apply(
               undefined,
               [binding, path, args],
               { arguments: { copy: true }, result: { promise: true, copy: true } },
             ).then(r => {
               if (!r.ok) { const e = new Error(r.error.message); e.name = r.error.name; throw e; }
               return r.value;
             });
           },
         });
         return handler([]);
       }
       globalThis.fr = makeProxy('fr', $0);
       globalThis.ecfr = makeProxy('ecfr', $0);`,
      [hostRpc],
      { arguments: { reference: true } },
    );

    try {
      const wrapped = `(async () => { ${opts.code}\n })()`;
      const script = await isolate.compileScript(wrapped);
      const result = await script.run(context, {
        timeout: opts.timeoutMs ?? 15_000,
        promise: true,
        copy: true,
      });
      return { ok: true, value: result, logs, durationMs: Date.now() - started };
    } catch (err) {
      const e = err as Error & { stack?: string };
      return {
        ok: false,
        logs,
        error: { name: e.name ?? 'Error', message: e.message ?? String(err), stack: e.stack },
        durationMs: Date.now() - started,
      };
    } finally {
      try { context.release(); isolate.dispose(); } catch { /* ignore */ }
    }
  }
}
