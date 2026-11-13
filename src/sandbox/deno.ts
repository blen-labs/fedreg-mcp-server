import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecuteOptions, ExecuteResult, RpcBridge, SandboxRunner } from './types.js';
import { log } from '../util/logger.js';
import { preflight } from './policy.js';
import { DEFAULT_LIMITS, LOG_LINE_OVERHEAD, LOG_TRUNCATED, LogSink, MAX_ERROR_MESSAGE, boundMessage, checkRpcArgs, finishValue, policyMessage, resultTooLarge, type SandboxLimits } from './limits.js';

/**
 * Deno sandbox.
 *
 * Boundary: Node host (owns the deadline, byte budgets, and the child's lifetime)
 *   → `deno run` of a fixed supervisor script with NO --allow-* flags (deny-by-default: no net, fs,
 *     env, ffi, subprocess), a minimal environment, and no user code on disk
 *   → a module Worker that receives the user code by message. Before user code runs, the worker's
 *     ambient globals that could reach the process or the protocol (`Deno`, `postMessage`, `fetch`,
 *     `Worker`, ...) are replaced with `undefined` and `console` is redirected to log messages.
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

  constructor(private readonly limits: SandboxLimits = DEFAULT_LIMITS) {}

  async available(): Promise<boolean> {
    return await new Promise(resolve => {
      const p = spawn('deno', ['--version'], { stdio: 'ignore', env: childEnv() });
      p.on('error', () => resolve(false));
      p.on('exit', code => resolve(code === 0));
    });
  }

  /** The supervisor holds no user data; it is written once per process, readable only by us. */
  private static supervisor(): string {
    // Re-check on disk: a long-lived server's temp dir may be reaped by a tmp cleaner.
    if (!DenoRunner.supervisorPath || !existsSync(DenoRunner.supervisorPath)) {
      const dir = mkdtempSync(join(tmpdir(), 'fedreg-deno-'));
      chmodSync(dir, 0o700);
      const path = join(dir, 'supervisor.js');
      writeFileSync(path, SUPERVISOR_SOURCE, { mode: 0o600 });
      DenoRunner.supervisorPath = path;
      process.once('exit', () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });
    }
    return DenoRunner.supervisorPath;
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

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn('deno', [
        'run', '--no-prompt', '--no-config', '--no-lock', '--no-remote', '--no-npm', '--quiet',
        `--v8-flags=--max-old-space-size=${Math.max(16, opts.memoryMb ?? 64)}`,
        DenoRunner.supervisor(),
      ], { stdio: ['pipe', 'pipe', 'pipe'], env: childEnv(), detached: process.platform !== 'win32' });
    } catch (err) {
      return fail('SpawnError', (err as Error).message);
    }

    const logs = new LogSink(limits.maxLogBytes, limits.maxLogLines);
    return await new Promise<ExecuteResult>(resolve => {
      let settled = false;
      let token: string | undefined;
      let partial: string[] = [];
      let partialLen = 0;
      let bufferedBytes = 0;
      let pendingRpc = 0;

      // Choosing the outcome and tearing down are separate: the first terminal event fixes the
      // result, and the promise resolves once the child has exited (bounded wait).
      let exited = false;
      const exitWaiters: Array<() => void> = [];
      child.once('close', () => { exited = true; for (const w of exitWaiters.splice(0)) w(); });
      const settle = (result: Omit<ExecuteResult, 'durationMs' | 'logs'>) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        const outcome = { ...result, logs: logs.lines(), durationMs: Date.now() - started };
        killTree(child);
        if (exited) return resolve(outcome);
        // Normally the child exits within milliseconds of the kill. If it has not after 2 s, kill
        // again, log it, and return the result anyway.
        const giveUp = setTimeout(() => {
          log.error('sandbox.teardown_pending', { pid: child.pid });
          killTree(child);
          resolve(outcome);
        }, 2000);
        exitWaiters.push(() => { clearTimeout(giveUp); resolve(outcome); });
      };
      const deadline = setTimeout(
        () => settle({ ok: false, error: { name: 'TimeoutError', message: `Execution exceeded ${timeoutMs}ms` } }),
        timeoutMs,
      );
      child.on('error', err => settle({ ok: false, error: { name: 'SpawnError', message: err.message } }));
      // 'close', not 'exit': stdout may still hold the final frame when the process exits.
      child.on('close', code => settle({ ok: false, error: { name: 'ExitError', message: `The sandbox exited unexpectedly (code ${code}).` } }));

      const send = (frame: unknown) => {
        if (settled || !token) return;
        let line: string;
        try { line = `${token}${JSON.stringify(frame)}\n`; }
        catch {
          // An SDK result that cannot be serialized must still answer the call, or the sandbox waits for the deadline.
          const f = frame as { t?: string; id?: unknown };
          if (f.t !== 'rpc-result') return;
          line = `${token}${JSON.stringify({ t: 'rpc-result', id: f.id, ok: false, error: { name: 'TypeError', message: 'The SDK result is not JSON-serializable.' } })}\n`;
        }
        try { child.stdin.write(line); } catch { /* child gone; exit handler settles */ }
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
            const res = await rpc.dispatch({ binding: msg.binding, path: msg.path as string[], args: msg.args });
            send({ t: 'rpc-result', id: msg.id, ok: res.ok, value: res.value, error: res.error });
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
        // Split only the new chunk, so a long unterminated frame is never rescanned or re-flattened.
        const segments = chunk.split('\n');
        const tail = segments.pop()!;
        for (const seg of segments) {
          if (settled) return;
          const line = partial.length ? partial.join('') + seg : seg;
          partial = [];
          partialLen = 0;
          if (!token) {
            // The supervisor's first line announces the frame token; nothing else may precede it.
            const m = /^FEDREG-SANDBOX ([0-9a-f]{64})$/.exec(line);
            if (!m) return settle({ ok: false, error: { name: 'SandboxProtocolError', message: 'The sandbox did not start correctly.' } });
            token = m[1]!;
            send({ t: 'start', code: opts.code, bindings: opts.bindings ?? [], limits: {
              maxLogBytes: limits.maxLogBytes, maxLogLines: limits.maxLogLines, logLineOverhead: LOG_LINE_OVERHEAD,
              logTruncated: LOG_TRUNCATED, maxRpcArgBytes: limits.maxRpcArgBytes, maxResultBytes: limits.maxResultBytes,
              maxError: MAX_ERROR_MESSAGE,
            } });
            continue;
          }
          if (line.startsWith(token)) {
            onFrame(line.slice(token.length)).catch(err => settle({ ok: false, error: { name: 'SandboxProtocolError', message: boundMessage(String((err as Error)?.message ?? err)) } }));
          }
          else if (line.length) logs.push(line);
        }
        if (settled) return;
        partial.push(tail);
        partialLen += tail.length;
        if (partialLen > limits.maxFrameBytes) {
          settle({ ok: false, error: { name: 'OutputTooLarge', message: `A sandbox message exceeded ${limits.maxFrameBytes} bytes.` } });
        }
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => { if (!settled) logs.push(chunk.trimEnd()); });
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
const post = self.postMessage.bind(self);
const listen = self.addEventListener.bind(self);
const S = JSON.stringify, P = JSON.parse, Str = String, apply = Reflect.apply, then = Promise.prototype.then;
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
  self.console = { log, info: log, warn: log, error: log, debug: log };
  for (const k of ['Deno', 'postMessage', 'close', 'fetch', 'WebSocket', 'WebSocketStream', 'Worker', 'EventSource',
                   'navigator', 'caches', 'localStorage', 'sessionStorage', 'importScripts', 'BroadcastChannel']) {
    try { Object.defineProperty(self, k, { value: undefined, writable: false, configurable: false }); } catch {}
  }
  for (const name of bindings) {
    try { Object.defineProperty(self, name, { value: makeProxy(name), writable: false, configurable: false }); } catch {}
  }
  let fn;
  try { fn = new Function('"use strict"; return (async () => {\\n' + code + '\\n})();'); }
  catch (e) { post({ t: 'done', ok: false, error: { name: Str(e?.name ?? 'SyntaxError'), message: cut(Str(e?.message ?? e), L.maxError) } }); return; }
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
  let started;
  try { started = fn(); } catch (e) { fail(e); return; }
  apply(then, started, [done, fail]);
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
    if (msg.t === 'start') worker.postMessage({ t: 'start', code: msg.code, bindings: msg.bindings, limits: msg.limits });
    else if (msg.t === 'rpc-result') worker.postMessage(msg);
  }
}
// The host went away (stdin closed): do not leave a possibly busy Worker running as an orphan.
Deno.exit(0);
`;
