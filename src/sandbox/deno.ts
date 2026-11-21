import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TEARDOWN, type ExecuteOptions, type ExecuteResult, type RpcBridge, type SandboxRunner } from './types.js';
import { log } from '../util/logger.js';
import { preflight } from './policy.js';
import { DEFAULT_LIMITS, LOG_LINE_OVERHEAD, LOG_TRUNCATED, LogSink, MAX_ERROR_MESSAGE, boundMessage, checkRpcArgs, finishValue, memoryLimitExceeded, policyMessage, resultTooLarge, type SandboxLimits } from './limits.js';

/** What V8 prints when --max-old-space-size ends the process ("Fatal JavaScript out of memory: Reached heap limit"). */
const V8_OUT_OF_MEMORY = /Fatal (?:JavaScript|process) out of memory/;
/** The supervisor exits with this code when the sandbox process outgrows its memory limit. */
const MEMORY_EXIT_CODE = 97;
/**
 * How far the resident size of the sandbox process may grow during one execution: twice `memoryMb`
 * plus this allowance. Twice, because the process has two V8 isolates (the supervisor, which
 * relays every SDK result, and the worker) and the heap flag lets each one reach `memoryMb` before
 * it must collect garbage. The allowance covers the runtime's own buffers for those messages.
 */
const MEMORY_HEADROOM_MB = 96;

/**
 * Deno sandbox.
 *
 * Boundary: Node host (owns the deadline, byte budgets, and the child's lifetime)
 *   → `deno run` of a fixed supervisor script with NO --allow-* flags (deny-by-default: no net, fs,
 *     env, ffi, subprocess), a minimal environment, and no user code on disk
 *   → a module Worker that receives the user code by message. Before user code runs, the worker
 *     deletes every global that is not part of the language (`Deno`, `fetch`, `Worker`, `process`,
 *     `postMessage`, ...), keeps a `console` that posts log messages, and refuses to run if a global
 *     stays. V8 does not build code from strings in this process (`eval`, `Function`), so the user
 *     code is loaded as a module, and a module cannot be loaded by name without the `import()`
 *     syntax that the preflight rejects.
 *
 * Memory: V8's heap flag does not count buffers (ArrayBuffer and typed arrays live outside the
 * JavaScript heap). The supervisor therefore watches the resident size of its whole process and
 * exits with MEMORY_EXIT_CODE when the growth since the start frame passes the limit. The heap
 * flag stays as a second guard.
 *
 * Protocol: the supervisor talks to the host over stdin/stdout with one JSON frame per line,
 * prefixed by a random token the supervisor generates and announces before the worker exists.
 * The worker never sees the token, so it cannot forge frames; any other stdout bytes are treated
 * as untrusted log text. All child output is untrusted: frames are size-bounded and validated, the
 * execution settles exactly once, and the process group is killed on every exit path. A frame can
 * never cancel the host's deadline or its cleanup.
 */
export class DenoRunner implements SandboxRunner {
  kind = 'deno' as const;
  private static supervisorPath?: string;
  private static supervisorDir?: string;

  constructor(private readonly limits: SandboxLimits = DEFAULT_LIMITS) {}

  async available(): Promise<boolean> {
    return await new Promise(resolve => {
      const p = spawn('deno', ['--version'], { stdio: 'ignore', env: childEnv() });
      p.on('error', () => resolve(false));
      p.on('exit', code => resolve(code === 0));
    });
  }

  /**
   * The supervisor holds no user data; it is written once per process, readable only by us, and
   * written again if a temporary-file cleaner (or an operator) removed it while the server runs.
   */
  private static supervisor(): string {
    if (DenoRunner.supervisorPath && existsSync(DenoRunner.supervisorPath)) return DenoRunner.supervisorPath;
    // Reuse the private directory when only the file went missing: a new one would leak the old
    // directory and stack another exit hook.
    if (!DenoRunner.supervisorDir || !existsSync(DenoRunner.supervisorDir)) {
      const dir = mkdtempSync(join(tmpdir(), 'fedreg-deno-'));
      chmodSync(dir, 0o700);
      DenoRunner.supervisorDir = dir;
      process.once('exit', () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });
    }
    const path = join(DenoRunner.supervisorDir, 'supervisor.js');
    writeFileSync(path, SUPERVISOR_SOURCE, { mode: 0o600 });
    DenoRunner.supervisorPath = path;
    return path;
  }

  async execute(opts: ExecuteOptions, rpc: RpcBridge): Promise<ExecuteResult> {
    const started = Date.now();
    const limits = { ...this.limits, ...(opts.limits ?? {}) };
    const timeoutMs = opts.timeoutMs ?? 15_000;
    const fail = (name: string, message: string, logs: string[] = []): ExecuteResult =>
      ({ ok: false, logs, error: { name, message }, durationMs: Date.now() - started });

    const policy = preflight(opts.code);
    if (!policy.ok) return fail('PolicyError', policyMessage(policy.errors));
    if (Buffer.byteLength(opts.code, 'utf8') > limits.maxCodeBytes) return fail('CodeTooLarge', `Code exceeds ${limits.maxCodeBytes} bytes.`);

    const memoryMb = Math.max(16, opts.memoryMb ?? 64);
    const memoryLimitMb = 2 * memoryMb + MEMORY_HEADROOM_MB;
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn('deno', [
        'run', '--no-prompt', '--no-config', '--no-lock', '--no-remote', '--no-npm', '--quiet',
        `--v8-flags=--max-old-space-size=${memoryMb},--disallow-code-generation-from-strings`,
        DenoRunner.supervisor(),
      ], { stdio: ['pipe', 'pipe', 'pipe'], env: childEnv(), detached: process.platform !== 'win32' });
    } catch (err) {
      return fail('SpawnError', (err as Error).message);
    }

    const logs = new LogSink(limits.maxLogBytes, limits.maxLogLines);
    const signal = opts.signal;
    return await new Promise<ExecuteResult>(resolve => {
      let settled = false;
      let token: string | undefined;
      let buffered = '';
      let bufferedBytes = 0;
      let pendingRpc = 0;
      let stderrTail = '';
      let heapExhausted = false;

      // Choosing the outcome and tearing down are separate: the first terminal event fixes the
      // result, and the promise resolves only once the child has exited (bounded wait), so the
      // execution slot is never released while its process is still alive.
      let exited = false;
      const exitWaiters: Array<() => void> = [];
      child.once('close', () => { exited = true; for (const w of exitWaiters.splice(0)) w(); });
      const settle = (result: Omit<ExecuteResult, 'durationMs' | 'logs'>) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        signal?.removeEventListener('abort', onAbort);
        const outcome = { ...result, logs: logs.lines(), durationMs: Date.now() - started };
        killTree(child);
        if (exited) return resolve(outcome);
        // Normally the child exits within milliseconds of the kill. If it has not after 2 s, return
        // the result anyway, but keep its capacity quarantined (TEARDOWN) until exit is confirmed.
        const gone = new Promise<void>(r => exitWaiters.push(r));
        const giveUp = setTimeout(() => {
          log.error('sandbox.teardown_pending', { pid: child.pid, note: 'execution slot held until the sandbox process exits' });
          killTree(child);
          resolve(Object.defineProperty(outcome, TEARDOWN, { value: gone, enumerable: false }));
        }, 2000);
        void gone.then(() => { clearTimeout(giveUp); resolve(outcome); });
      };
      const onAbort = () => settle({ ok: false, error: { name: 'AbortError', message: 'Execution was cancelled.' } });
      const deadline = setTimeout(
        () => settle({ ok: false, error: { name: 'TimeoutError', message: `Execution exceeded ${timeoutMs}ms` } }),
        timeoutMs,
      );
      child.on('error', err => settle({ ok: false, error: { name: 'SpawnError', message: err.message } }));
      // The exit code carries the reason: a last frame on stdout could arrive after this event.
      child.on('exit', (code, killedBy) => {
        // What Deno and V8 wrote about the exit is for the operator, not for the caller.
        const finish = () => {
          const outOfMemory = code === MEMORY_EXIT_CODE || heapExhausted;
          if (!settled && !outOfMemory) log.warn('sandbox.exited', { code, signal: killedBy, stderr: stderrTail });
          settle({ ok: false, error: outOfMemory
            ? memoryLimitExceeded(memoryMb)
            : { name: 'ExitError', message: killedBy
              ? `The sandbox process ended abnormally (${killedBy}). The usual cause is a program that fills the JavaScript heap (memoryMb: ${memoryMb}).`
              : `The sandbox exited unexpectedly (code ${code}).` } });
        };
        // V8 says why it aborted on stderr, and the exit event can come before that text is read.
        // 'close' and not 'end': a stream that fails still closes, so the result is never held back.
        if (!settled && code !== MEMORY_EXIT_CODE && !child.stderr.closed) child.stderr.once('close', finish);
        else finish();
      });
      if (signal?.aborted) return onAbort();
      signal?.addEventListener('abort', onAbort, { once: true });

      const send = (frame: unknown) => {
        if (settled || !token) return;
        try { child.stdin.write(`${token}${JSON.stringify(frame)}\n`); } catch { /* child gone; exit handler settles */ }
      };

      const onFrame = async (raw: string) => {
        let msg: Record<string, unknown>;
        try { msg = JSON.parse(raw) as Record<string, unknown>; }
        catch { return settle({ ok: false, error: { name: 'SandboxProtocolError', message: 'The sandbox sent a malformed frame.' } }); }
        if (msg.t === 'log' && typeof msg.text === 'string') return logs.push(msg.text);
        if (msg.t === 'rpc' && Number.isSafeInteger(msg.id) && typeof msg.binding === 'string'
            && Array.isArray(msg.path) && Array.isArray(msg.args)) {
          if (pendingRpc >= limits.maxPendingRpc) {
            return send({ t: 'rpc-result', id: msg.id, ok: false, error: { name: 'TooManyPendingCalls', message: `At most ${limits.maxPendingRpc} SDK calls may be pending at once.` } });
          }
          const tooBig = checkRpcArgs(msg.args, limits);
          if (tooBig) return send({ t: 'rpc-result', id: msg.id, ok: false, error: tooBig });
          pendingRpc++;
          try {
            const res = await rpc.dispatch({ binding: msg.binding, path: msg.path as string[], args: msg.args }, { signal });
            send({ t: 'rpc-result', id: msg.id, ok: res.ok, value: res.value, error: res.error });
          } catch {
            // The bridge reports a failed call as a result. If it rejects instead, the program gets
            // an error; a rejection that left this function would end the server process.
            send({ t: 'rpc-result', id: msg.id, ok: false, error: { name: 'Error', message: 'The SDK call failed.' } });
          } finally {
            pendingRpc--;
          }
          return;
        }
        if (msg.t === 'done') {
          if (msg.ok === true && typeof msg.json === 'string') return settle(finishValue(msg.json, limits));
          if (msg.tooLarge === true && typeof msg.size === 'number') return settle({ ok: false, error: resultTooLarge(msg.size, limits) });
          const e = (msg.error ?? {}) as Record<string, unknown>;
          return settle({
            ok: false,
            error: {
              name: typeof e.name === 'string' ? e.name.slice(0, 100) : 'Error',
              message: typeof e.message === 'string' ? boundMessage(e.message) : 'Execution failed',
              ...(typeof e.status === 'number' ? { status: e.status } : {}),
            },
          });
        }
        return settle({ ok: false, error: { name: 'SandboxProtocolError', message: 'The sandbox sent an unexpected frame.' } });
      };

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        if (settled) return;
        bufferedBytes += Buffer.byteLength(chunk, 'utf8');
        if (bufferedBytes > limits.maxStdoutBytes) {
          return settle({ ok: false, error: { name: 'OutputTooLarge', message: `The sandbox produced more than ${limits.maxStdoutBytes} bytes of output.` } });
        }
        buffered += chunk;
        let nl: number;
        while (!settled && (nl = buffered.indexOf('\n')) >= 0) {
          const line = buffered.slice(0, nl);
          buffered = buffered.slice(nl + 1);
          if (!token) {
            // The supervisor's first line announces the frame token; nothing else may precede it.
            const m = /^FEDREG-SANDBOX ([0-9a-f]{64})$/.exec(line);
            if (!m) return settle({ ok: false, error: { name: 'SandboxProtocolError', message: 'The sandbox did not start correctly.' } });
            token = m[1]!;
            send({ t: 'start', code: opts.code, bindings: opts.bindings ?? [], memoryBytes: memoryLimitMb * 1024 * 1024, limits: {
              maxLogBytes: limits.maxLogBytes, maxLogLines: limits.maxLogLines, logLineOverhead: LOG_LINE_OVERHEAD,
              logTruncated: LOG_TRUNCATED, maxRpcArgBytes: limits.maxRpcArgBytes, maxResultBytes: limits.maxResultBytes,
              maxError: MAX_ERROR_MESSAGE,
            } });
            continue;
          }
          if (line.startsWith(token)) void onFrame(line.slice(token.length));
          else if (line.length) logs.push(line);
        }
        if (buffered.length > limits.maxFrameBytes) {
          settle({ ok: false, error: { name: 'OutputTooLarge', message: `A sandbox message exceeded ${limits.maxFrameBytes} bytes.` } });
        }
      });
      child.stderr.setEncoding('utf8');
      // Never into `logs`: a fatal error dump from V8 names addresses and the process id.
      child.stderr.on('data', (chunk: string) => {
        const text = stderrTail + chunk;
        // V8 names a heap-limit abort before its stack trace, which can push that line out of the tail.
        if (!heapExhausted && V8_OUT_OF_MEMORY.test(text)) heapExhausted = true;
        stderrTail = text.slice(-2000);
      });
      child.stdin.on('error', () => { /* child exited; exit handler settles */ });
    });
  }
}

/** Only what Deno needs to start; never the server's secrets. */
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NO_COLOR: '1', DENO_NO_UPDATE_CHECK: '1', DENO_NO_PROMPT: '1' };
  for (const k of ['PATH', 'HOME', 'DENO_DIR', 'TMPDIR', 'SystemRoot', 'USERPROFILE', 'LOCALAPPDATA']) {
    if (process.env[k]) env[k] = process.env[k];
  }
  return env;
}

/** Kill the child and anything it started. POSIX: the whole process group. */
function killTree(child: ChildProcessWithoutNullStreams): void {
  try { child.stdin.destroy(); } catch { /* ignore */ }
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform !== 'win32' && child.pid) {
    try { process.kill(-child.pid, 'SIGKILL'); return; } catch { /* fall through */ }
  }
  try { child.kill('SIGKILL'); } catch { /* ignore */ }
}

/**
 * Runs in Deno with no permissions. Holds no user data until the start frame arrives over stdin.
 * Binding names come from the host (pre-validated identifiers) and are only used as object keys.
 */
export const SUPERVISOR_SOURCE = String.raw`
const enc = new TextEncoder();
const bytes = new Uint8Array(32);
crypto.getRandomValues(bytes);
const TOKEN = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
const writeLine = (s) => { const b = enc.encode(s + '\n'); let o = 0; while (o < b.length) o += Deno.stdout.writeSync(b.subarray(o)); };
const frame = (obj) => writeLine(TOKEN + JSON.stringify(obj));
writeLine('FEDREG-SANDBOX ' + TOKEN);

const WORKER_SOURCE = ${'`'}
// Trusted primitives, captured before user code exists: budgets below use these, so user code that
// replaces JSON.stringify, TextEncoder or Promise.prototype.then cannot push oversized data out.
const G = globalThis;
const post = G.postMessage.bind(G);
const listen = G.addEventListener.bind(G);
const S = JSON.stringify, P = JSON.parse, Str = String, apply = Reflect.apply, then = Promise.prototype.then;
const ownKeys = Reflect.ownKeys, deleteProperty = Reflect.deleteProperty, defineProperty = Object.defineProperty;
const BlobOf = Blob, urlFor = URL.createObjectURL.bind(URL), forgetUrl = URL.revokeObjectURL.bind(URL);
// The language's own globals. A program gets these, console and the SDK bindings.
const LANGUAGE = new Set(['globalThis', 'Infinity', 'NaN', 'undefined', 'eval', 'isFinite', 'isNaN', 'parseFloat', 'parseInt',
  'decodeURI', 'decodeURIComponent', 'encodeURI', 'encodeURIComponent', 'escape', 'unescape',
  'AggregateError', 'Array', 'ArrayBuffer', 'AsyncDisposableStack', 'BigInt', 'BigInt64Array', 'BigUint64Array', 'Boolean',
  'DataView', 'Date', 'DisposableStack', 'Error', 'EvalError', 'FinalizationRegistry', 'Float16Array', 'Float32Array',
  'Float64Array', 'Function', 'Int8Array', 'Int16Array', 'Int32Array', 'Iterator', 'Map', 'Number', 'Object', 'Promise',
  'Proxy', 'RangeError', 'ReferenceError', 'RegExp', 'Set', 'SharedArrayBuffer', 'String', 'SuppressedError', 'Symbol',
  'SyntaxError', 'TypeError', 'Uint8Array', 'Uint8ClampedArray', 'Uint16Array', 'Uint32Array', 'URIError', 'WeakMap',
  'WeakRef', 'WeakSet', 'Atomics', 'Intl', 'JSON', 'Math', 'Reflect', 'Temporal']);
const encoder = new TextEncoder(), encode = TextEncoder.prototype.encode, sl = String.prototype.slice;
// The intrinsic %TypedArray%.prototype.byteLength getter, captured: user code may redefine
// Uint8Array.prototype.length, but cannot change a getter we already hold.
const byteLength = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength').get;
const bytes = (s) => apply(byteLength, apply(encode, encoder, [s]), []);
const cut = (s, n) => s.length > n ? apply(sl, s, [0, n]) : s;
let started = false;
const pending = new Map();
let nextId = 1;
listen('message', (ev) => {
  const m = ev.data;
  if (m && m.t === 'rpc-result') {
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.ok) p.resolve(m.value);
    else { const e = new Error(String(m.error?.message ?? 'SDK call failed')); e.name = String(m.error?.name ?? 'Error'); if (typeof m.error?.status === 'number') e.status = m.error.status; p.reject(e); }
    return;
  }
  if (!m || m.t !== 'start' || started) return;
  started = true;
  run(String(m.code), Array.isArray(m.bindings) ? m.bindings.map(String) : [], m.limits || {});
});
let L = {};
function call(binding, path, args) {
  return new Promise((resolve, reject) => {
    let json;
    try { json = S(args ?? []); } catch (e) { reject(new TypeError('SDK arguments must be JSON-serializable')); return; }
    if (typeof json !== 'string' || bytes(json) > L.maxRpcArgBytes) { const e = new Error('SDK call arguments exceed ' + L.maxRpcArgBytes + ' bytes.'); e.name = 'ArgumentsTooLarge'; reject(e); return; }
    const id = nextId++;
    pending.set(id, { resolve, reject });
    post({ t: 'rpc', id, binding, path, args: P(json) });
  });
}
function makeProxy(binding) {
  const handler = (path) => new Proxy(function () {}, {
    get(_, key) { return typeof key === 'symbol' ? undefined : handler([...path, String(key)]); },
    apply(_, __, args) { return call(binding, path, args); },
  });
  return handler([]);
}
function run(code, bindings, limits) {
  L = limits;
  const show = (v) => { if (typeof v === 'string') return v; try { const j = S(v); return j === undefined ? Str(v) : j; } catch { return Str(v); } };
  let logBytes = 0, logLines = 0, logDone = false;
  const log = (...a) => {
    if (logDone) return;
    let text = '';
    for (let i = 0; i < a.length; i++) text += (i ? ' ' : '') + show(a[i]);
    text = cut(text, L.maxLogBytes);
    logBytes += bytes(text) + L.logLineOverhead; logLines++;
    if (logBytes > L.maxLogBytes - L.logTruncated.length - L.logLineOverhead || logLines >= L.maxLogLines) { logDone = true; text = L.logTruncated; }
    post({ t: 'log', text });
  };
  // Deno puts its whole runtime on the global object (Deno, fetch, Worker, process, Buffer, ...).
  // Delete every name that is not the language's own, and do not run the program if one stays:
  // a name on a deny list would miss whatever a later Deno version adds.
  const stayed = [];
  for (const key of ownKeys(G)) {
    if (typeof key === 'string' && !LANGUAGE.has(key) && !deleteProperty(G, key)) stayed[stayed.length] = key;
  }
  if (stayed.length) { post({ t: 'done', ok: false, error: { name: 'SandboxSetupError', message: 'The sandbox could not remove a runtime global.' } }); return; }
  // The global object still inherits the event methods of a worker (addEventListener,
  // dispatchEvent). Deno itself calls them there to report an unhandled rejection, so they stay;
  // they act only on this worker's own events.
  defineProperty(G, 'console', { value: { log, info: log, warn: log, error: log, debug: log }, writable: true, configurable: true });
  for (const name of bindings) defineProperty(G, name, { value: makeProxy(name), writable: false, configurable: false });
  const fail = (e) => {
    let name = 'Error', message = '', status;
    try { name = cut(Str(e?.name ?? 'Error'), 100); message = cut(Str(e?.message !== undefined ? e.message : e), L.maxError); status = typeof e?.status === 'number' ? e.status : undefined; } catch {}
    post({ t: 'done', ok: false, error: { name, message, ...(status === undefined ? {} : { status }) } });
  };
  const done = (value) => {
    let json;
    try { json = S(value === undefined ? null : value); } catch (e) { fail({ name: 'TypeError', message: 'The returned value is not JSON-serializable' }); return; }
    if (typeof json !== 'string') json = 'null';
    const size = bytes(json);
    if (size > L.maxResultBytes) post({ t: 'done', ok: false, tooLarge: true, size });
    else post({ t: 'done', ok: true, json });
  };
  // V8 builds no code from strings here, so the program is loaded as a module. The wrapper is the
  // one the preflight checked: the program is the body of one async function.
  const url = urlFor(new BlobOf(['export const result = (async () => {\\n' + code + '\\n})();'], { type: 'application/javascript' }));
  apply(then, import(url), [(loaded) => { forgetUrl(url); apply(then, loaded.result, [done, fail]); }, fail]);
}
${'`'};

const url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'application/javascript' }));
const worker = new Worker(url, { type: 'module' });
worker.onmessage = (ev) => {
  const m = ev.data;
  if (!m || typeof m !== 'object') return;
  if (m.t === 'log') frame({ t: 'log', text: String(m.text).slice(0, 65536) });
  else if (m.t === 'rpc') frame({ t: 'rpc', id: m.id, binding: m.binding, path: m.path, args: m.args });
  else if (m.t === 'done') frame({ t: 'done', ok: m.ok === true, json: m.json, error: m.error, tooLarge: m.tooLarge === true, size: m.size });
};
worker.onerror = (e) => { e.preventDefault(); frame({ t: 'done', ok: false, error: { name: 'Error', message: String(e.message ?? 'Worker error') } }); };

// This thread, which user code cannot reach, ends the process when it has grown past the limit.
// It ends the process and not the worker: a worker cannot be stopped inside one native call that is
// still writing to a buffer.
const watchMemory = (limitBytes) => {
  const base = Deno.memoryUsage().rss;
  setInterval(() => { if (!(Deno.memoryUsage().rss - base <= limitBytes)) Deno.exit(${MEMORY_EXIT_CODE}); }, 5);
};

// Host → supervisor: token-prefixed JSON lines on stdin.
const dec = new TextDecoder();
let buf = '';
for await (const chunk of Deno.stdin.readable) {
  buf += dec.decode(chunk, { stream: true });
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.startsWith(TOKEN)) continue;
    let msg;
    try { msg = JSON.parse(line.slice(TOKEN.length)); } catch { continue; }
    if (msg.t === 'start') { watchMemory(msg.memoryBytes); worker.postMessage({ t: 'start', code: msg.code, bindings: msg.bindings, limits: msg.limits }); }
    else if (msg.t === 'rpc-result') worker.postMessage(msg);
  }
}
// The host went away (stdin closed): do not leave a possibly busy Worker (or the watchdog timer) running as an orphan.
Deno.exit(0);
`;
