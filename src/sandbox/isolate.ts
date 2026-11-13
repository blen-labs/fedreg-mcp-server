import type { ExecuteOptions, ExecuteResult, RpcBridge, SandboxRunner } from './types.js';
import { preflight } from './policy.js';
import { DEFAULT_LIMITS, LOG_LINE_OVERHEAD, LOG_TRUNCATED, LogSink, MAX_ERROR_MESSAGE, boundMessage, finishValue, policyMessage, resultTooLarge, type SandboxLimits } from './limits.js';

type Ivm = any; // isolated-vm ships its own types, but it is an optional native dependency.

async function loadIvm(): Promise<Ivm> {
  const mod = await import('isolated-vm') as Record<string, unknown> & { default?: Record<string, unknown> };
  const candidate = (typeof mod.Isolate === 'function' ? mod : mod.default ?? {}) as Record<string, unknown>;
  if (typeof candidate.Isolate !== 'function') throw new Error('isolated-vm native binding unavailable');
  return candidate;
}

/**
 * isolated-vm sandbox: a fresh V8 isolate per execution with a heap cap. The host owns a
 * wall-clock deadline that starts before setup: when it fires the isolate
 * is disposed, which stops running code and rejects anything it awaits, and the execution settles
 * once. V8's own `timeout` stays as a second guard for synchronous loops. This runs in the server
 * process, so for hosted multi-user execution prefer the Deno runner (separate process).
 */
export class IsolateRunner implements SandboxRunner {
  kind = 'isolate' as const;

  constructor(private readonly limits: SandboxLimits = DEFAULT_LIMITS) {}

  async available(): Promise<boolean> {
    try {
      const ivm = await loadIvm();
      const iso = new ivm.Isolate({ memoryLimit: 16 });
      iso.dispose();
      return true;
    } catch {
      return false;
    }
  }

  async execute(opts: ExecuteOptions, rpc: RpcBridge): Promise<ExecuteResult> {
    const started = Date.now();
    const limits = { ...this.limits, ...(opts.limits ?? {}) };
    const timeoutMs = opts.timeoutMs ?? 15_000;
    const logs = new LogSink(limits.maxLogBytes, limits.maxLogLines);
    const done = (r: Omit<ExecuteResult, 'durationMs' | 'logs'>): ExecuteResult => ({ ...r, logs: logs.lines(), durationMs: Date.now() - started });

    const policy = preflight(opts.code);
    if (!policy.ok) return done({ ok: false, error: { name: 'PolicyError', message: policyMessage(policy.errors) } });
    if (Buffer.byteLength(opts.code, 'utf8') > limits.maxCodeBytes) {
      return done({ ok: false, error: { name: 'CodeTooLarge', message: `Code exceeds ${limits.maxCodeBytes} bytes.` } });
    }

    const ivm = await loadIvm();
    const isolate = new ivm.Isolate({ memoryLimit: Math.max(16, opts.memoryMb ?? 64) });
    let disposed = false;
    const dispose = () => { if (!disposed) { disposed = true; try { isolate.dispose(); } catch { /* ignore */ } } };

    let stop!: (r: Omit<ExecuteResult, 'durationMs' | 'logs'>) => void;
    const stopped = new Promise<Omit<ExecuteResult, 'durationMs' | 'logs'>>(resolve => { stop = resolve; });
    const deadline = setTimeout(() => stop({ ok: false, error: { name: 'TimeoutError', message: `Execution exceeded ${timeoutMs}ms` } }), timeoutMs);

    const run = async (): Promise<Omit<ExecuteResult, 'durationMs' | 'logs'>> => {
      const context = await isolate.createContext();
      const jail = context.global;
      await jail.set('global', jail.derefInto());
      // Trusted primitives are captured here, before any user code runs, and every budget (logs,
      // SDK arguments, result, error) is enforced with them inside the isolate, in UTF-8 bytes, so
      // replacing JSON.stringify, String.prototype methods or Promise.prototype.then cannot push an
      // oversized value into the host copy path. The host re-checks everything it receives.
      const L = {
        maxLogBytes: limits.maxLogBytes, maxLogLines: limits.maxLogLines, overhead: LOG_LINE_OVERHEAD, marker: LOG_TRUNCATED,
        maxRpcArgBytes: limits.maxRpcArgBytes, maxResultBytes: limits.maxResultBytes, maxError: MAX_ERROR_MESSAGE,
      };
      await context.evalClosure(
        `const L = ${JSON.stringify(L)};
         const S = JSON.stringify, Str = String, apply = Reflect.apply, then = Promise.prototype.then;
         const cca = String.prototype.charCodeAt, sl = String.prototype.slice, join = Array.prototype.join, map = Array.prototype.map;
         const freeze = Object.freeze, define = Object.defineProperty, isArray = Array.isArray, create = Object.create;
         const bytes = (s) => { let n = 0; const len = s.length; for (let i = 0; i < len; i++) { const c = apply(cca, s, [i]);
           n += c < 0x80 ? 1 : c < 0x800 ? 2 : (c >= 0xD800 && c <= 0xDBFF) ? (i++, 4) : 3; } return n; };
         const cut = (s, n) => s.length > n ? apply(sl, s, [0, n]) : s;
         const show = (v) => { if (typeof v === 'string') return v; try { const j = S(v); return j === undefined ? Str(v) : j; } catch { return Str(v); } };
         let used = 0, lines = 0, done = false;
         const log = (...a) => {
           if (done) return;
           let text = cut(apply(join, apply(map, a, [show]), [' ']), L.maxLogBytes);
           used += bytes(text) + L.overhead; lines++;
           if (used > L.maxLogBytes - L.marker.length - L.overhead || lines >= L.maxLogLines) { done = true; text = L.marker; }
           $0.applyIgnored(undefined, [text]);
         };
         define(globalThis, 'console', { value: freeze({ log, error: log, warn: log, info: log, debug: log }), writable: false, configurable: false });
         const argsJson = (args) => { const j = S(isArray(args) ? args : []); if (bytes(j) > L.maxRpcArgBytes) return undefined; return j; };
         const ok = (v) => { let j; try { j = S(v === undefined ? null : v); } catch (e) { return err({ name: 'TypeError', message: 'The returned value is not JSON-serializable' }); }
           if (typeof j !== 'string') j = 'null';
           const b = bytes(j); return b > L.maxResultBytes ? 'R' + b : 'V' + j; };
         const err = (e) => { let name = 'Error', message = '', status;
           try { name = cut(Str(e && e.name || 'Error'), 100); message = cut(Str(e && e.message !== undefined ? e.message : e), L.maxError); status = e && typeof e.status === 'number' ? e.status : undefined; } catch {}
           // Null-prototype record of primitives: no inherited toJSON or getters can reshape it.
           const rec = create(null); rec.name = name; rec.message = message; if (typeof status === 'number') rec.status = status;
           // name/message were cut before serializing, so the JSON is bounded (escaping at most 6x);
           // it is never sliced, which could break it and lose the name and status.
           let out; try { out = S(rec); } catch {
             const fb = create(null); fb.name = 'Error'; fb.message = 'The error could not be serialized.'; if (typeof status === 'number') fb.status = status;
             out = S(fb); }
           return 'E' + out; };
         define(globalThis, '__fedregInternal', { value: freeze({ argsJson,
           run: (fn) => apply(then, fn(), [ok, err]) }), writable: false, configurable: false, enumerable: false });`,
        [(line: string) => logs.push(String(line))],
        { arguments: { reference: true } },
      );
      let pending = 0;
      const hostRpc = async (binding: string, path: string[], argsJson: string) => {
        const fail = (name: string, message: string) => new ivm.ExternalCopy({ ok: false, error: { name, message } }).copyInto();
        if (disposed) return fail('AbortError', 'Execution has ended.');
        if (pending >= limits.maxPendingRpc) return fail('TooManyPendingCalls', `At most ${limits.maxPendingRpc} SDK calls may be pending at once.`);
        if (typeof argsJson !== 'string' || Buffer.byteLength(argsJson, 'utf8') > limits.maxRpcArgBytes) return fail('ArgumentsTooLarge', `SDK call arguments exceed ${limits.maxRpcArgBytes} bytes.`);
        let args: unknown[];
        try { args = JSON.parse(argsJson) as unknown[]; } catch { return fail('TypeError', 'SDK arguments must be JSON-serializable.'); }
        pending++;
        try {
          const result = await rpc.dispatch({ binding, path, args });
          return new ivm.ExternalCopy(result).copyInto();
        } finally {
          pending--;
        }
      };
      // Binding names are pre-validated JS identifiers (getSources); safe to embed as JSON.
      await context.evalClosure(
        `const internal = globalThis.__fedregInternal;
         function makeProxy(binding, rpc) {
           const handler = (path) => new Proxy(function(){}, {
             get(_, key) { return typeof key === 'symbol' ? undefined : handler([...path, String(key)]); },
             apply(_, __, args) {
               let json;
               try { json = internal.argsJson(args); } catch { return Promise.reject(new TypeError('SDK arguments must be JSON-serializable')); }
               if (json === undefined) { const e = new Error('SDK call arguments exceed ${limits.maxRpcArgBytes} bytes.'); e.name = 'ArgumentsTooLarge'; return Promise.reject(e); }
               return rpc.apply(undefined, [binding, path, json], { arguments: { copy: true }, result: { promise: true, copy: true } })
                 .then(r => {
                   if (!r.ok) { const e = new Error(r.error.message); e.name = r.error.name; if (typeof r.error.status === 'number') e.status = r.error.status; throw e; }
                   return r.value;
                 });
             },
           });
           return handler([]);
         }
         for (const name of ${JSON.stringify(opts.bindings ?? [])}) {
           Object.defineProperty(globalThis, name, { value: makeProxy(name, $0), writable: false, configurable: false });
         }`,
        [hostRpc],
        { arguments: { reference: true } },
      );
      // 'V' + JSON (value), 'R' + bytes (result over budget, never transferred), 'E' + JSON (bounded
      // error, so an SDK error's status survives the copy).
      const script = await isolate.compileScript(`__fedregInternal.run(async () => { ${opts.code}\n })`);
      const tagged = await script.run(context, { timeout: timeoutMs, promise: true, copy: true }) as string;
      if (typeof tagged === 'string' && tagged.startsWith('V')) return finishValue(tagged.slice(1), limits);
      if (typeof tagged === 'string' && tagged.startsWith('R')) return { ok: false, error: resultTooLarge(Number(tagged.slice(1)), limits) };
      if (typeof tagged !== 'string' || !tagged.startsWith('E')) return { ok: false, error: { name: 'SandboxProtocolError', message: 'The sandbox returned an invalid result.' } };
      let e: { name?: unknown; message?: unknown; status?: unknown };
      try { e = JSON.parse(tagged.slice(1)) as typeof e; } catch { e = { name: 'Error', message: 'The sandbox returned an unreadable error.' }; }
      return { ok: false, error: { name: String(e.name ?? 'Error').slice(0, 100), message: boundMessage(String(e.message ?? '')), ...(typeof e.status === 'number' ? { status: e.status } : {}) } };
    };

    try {
      const outcome = await Promise.race([
        run().catch((err: unknown) => {
          const e = err as { name?: string; message?: string; status?: unknown };
          if (disposed) return { ok: false, error: { name: 'TimeoutError', message: `Execution exceeded ${timeoutMs}ms` } };
          return { ok: false, error: { name: String(e?.name ?? 'Error').slice(0, 100), message: boundMessage(String(e?.message ?? err)), ...(typeof e?.status === 'number' ? { status: e.status } : {}) } };
        }),
        stopped,
      ]);
      return done(outcome);
    } finally {
      clearTimeout(deadline);
      dispose();
    }
  }
}
