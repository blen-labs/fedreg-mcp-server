import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecuteOptions, ExecuteResult, RpcBridge, SandboxRunner } from './types.js';
import { preflight } from './policy.js';

/**
 * Deno fallback sandbox. We launch `deno run` with --no-net --no-read --no-write --no-env --no-ffi --no-prompt
 * and bridge RPC over stdin/stdout using a length-prefixed JSON protocol.
 */
export class DenoRunner implements SandboxRunner {
  kind = 'deno' as const;

  async available(): Promise<boolean> {
    return await new Promise(resolve => {
      const p = spawn('deno', ['--version'], { stdio: 'ignore' });
      p.on('error', () => resolve(false));
      p.on('exit', code => resolve(code === 0));
    });
  }

  async execute(opts: ExecuteOptions, rpc: RpcBridge): Promise<ExecuteResult> {
    const started = Date.now();
    const policy = preflight(opts.code);
    if (!policy.ok) {
      return { ok: false, logs: [], error: { name: 'PolicyError', message: policy.errors.join('; ') }, durationMs: Date.now() - started };
    }

    const runner = buildDenoRunner(opts.code, opts.timeoutMs ?? 15_000);
    // Write the runner to a temp file rather than piping it on stdin: `deno run -`
    // reads the program from stdin until EOF, but we keep stdin open as the RPC
    // channel, so it would never start. A file path leaves stdin free for RPC.
    const tmpDir = mkdtempSync(join(tmpdir(), 'fedreg-deno-'));
    const runnerPath = join(tmpDir, 'runner.ts');
    writeFileSync(runnerPath, runner);
    const cleanup = (): void => { try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } };
    const child = spawn('deno', [
      'run',
      '--no-prompt',
      runnerPath,
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    const logs: string[] = [];
    let stdoutBuf = Buffer.alloc(0);

    return await new Promise<ExecuteResult>((resolve) => {
      const timeout = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
        cleanup();
        resolve({
          ok: false, logs,
          error: { name: 'TimeoutError', message: `Execution exceeded ${opts.timeoutMs ?? 15_000}ms` },
          durationMs: Date.now() - started,
        });
      }, (opts.timeoutMs ?? 15_000) + 1_000);

      child.stdout.on('data', async (chunk: Buffer) => {
        stdoutBuf = Buffer.concat([stdoutBuf, chunk]);
        // length-prefixed JSON frames: 8-byte ascii hex length + payload
        while (stdoutBuf.length >= 9) {
          const lenHex = stdoutBuf.subarray(0, 8).toString('ascii');
          if (stdoutBuf[8] !== 0x0a) {
            logs.push(stdoutBuf.toString('utf8'));
            stdoutBuf = Buffer.alloc(0);
            break;
          }
          const len = parseInt(lenHex, 16);
          if (Number.isNaN(len)) break;
          if (stdoutBuf.length < 9 + len) break;
          const payload = stdoutBuf.subarray(9, 9 + len).toString('utf8');
          stdoutBuf = stdoutBuf.subarray(9 + len);
          const msg = JSON.parse(payload) as
            | { kind: 'log'; text: string }
            | { kind: 'rpc'; id: number; binding: 'fr' | 'ecfr'; path: string[]; args: unknown[] }
            | { kind: 'result'; ok: boolean; value?: unknown; error?: { name: string; message: string } };
          if (msg.kind === 'log') {
            logs.push(msg.text);
          } else if (msg.kind === 'rpc') {
            const res = await rpc.dispatch({ binding: msg.binding, path: msg.path, args: msg.args });
            writeFrame(child.stdin, { kind: 'rpc-result', id: msg.id, ok: res.ok, value: res.value, error: res.error });
          } else if (msg.kind === 'result') {
            clearTimeout(timeout);
            try { child.stdin.end(); } catch { /* ignore */ }
            resolve({
              ok: msg.ok,
              logs,
              value: msg.value,
              error: msg.error,
              durationMs: Date.now() - started,
            });
          }
        }
      });

      child.stderr.on('data', (b: Buffer) => logs.push(b.toString('utf8')));
      child.on('error', err => {
        clearTimeout(timeout);
        cleanup();
        resolve({ ok: false, logs, error: { name: 'SpawnError', message: err.message }, durationMs: Date.now() - started });
      });
      child.on('exit', code => {
        cleanup();
        if (code !== 0 && code !== null) {
          clearTimeout(timeout);
          resolve({ ok: false, logs, error: { name: 'ExitError', message: `deno exited with ${code}` }, durationMs: Date.now() - started });
        }
      });
    });
  }
}

function writeFrame(stream: NodeJS.WritableStream, obj: unknown): void {
  const payload = JSON.stringify(obj);
  const len = Buffer.byteLength(payload, 'utf8').toString(16).padStart(8, '0');
  stream.write(len + '\n' + payload);
}

function buildDenoRunner(userCode: string, timeoutMs: number): string {
  // Runs inside deno. Talks to host over stdin/stdout with the same framing.
  return `
const enc = new TextEncoder();
const dec = new TextDecoder();

function writeFrame(obj) {
  const s = JSON.stringify(obj);
  const len = (new TextEncoder().encode(s)).byteLength.toString(16).padStart(8, '0');
  Deno.stdout.writeSync(enc.encode(len + '\\n' + s));
}

let inbuf = new Uint8Array(0);
const pending = new Map();
let nextId = 1;

async function readLoop() {
  const reader = Deno.stdin.readable.getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) return;
    const merged = new Uint8Array(inbuf.length + value.length);
    merged.set(inbuf); merged.set(value, inbuf.length);
    inbuf = merged;
    while (inbuf.length >= 9) {
      const lenHex = dec.decode(inbuf.subarray(0, 8));
      const len = parseInt(lenHex, 16);
      if (isNaN(len)) { inbuf = new Uint8Array(0); break; }
      if (inbuf.length < 9 + len) break;
      const payload = dec.decode(inbuf.subarray(9, 9 + len));
      inbuf = inbuf.subarray(9 + len);
      const msg = JSON.parse(payload);
      if (msg.kind === 'rpc-result') {
        const cb = pending.get(msg.id);
        if (cb) { pending.delete(msg.id); cb(msg); }
      }
    }
  }
}
readLoop();

function call(binding, path, args) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, (r) => {
      if (!r.ok) { const e = new Error(r.error.message); e.name = r.error.name; reject(e); }
      else resolve(r.value);
    });
    writeFrame({ kind: 'rpc', id, binding, path, args });
  });
}

function makeProxy(binding) {
  const handler = (path) => new Proxy(function(){}, {
    get(_, key) { return handler([...path, String(key)]); },
    apply(_, __, args) { return call(binding, path, args); },
  });
  return handler([]);
}

globalThis.fr = makeProxy('fr');
globalThis.ecfr = makeProxy('ecfr');

const origLog = console.log;
console.log = (...a) => writeFrame({ kind: 'log', text: a.map(String).join(' ') });
console.info = console.log; console.warn = console.log; console.error = console.log;

const userFn = async () => {
${userCode}
};

const timer = setTimeout(() => {
  writeFrame({ kind: 'result', ok: false, error: { name: 'TimeoutError', message: 'Execution exceeded ${timeoutMs}ms' }});
  Deno.exit(0);
}, ${timeoutMs});

userFn()
  .then(value => { clearTimeout(timer); writeFrame({ kind: 'result', ok: true, value }); Deno.exit(0); })
  .catch(err => { clearTimeout(timer); writeFrame({ kind: 'result', ok: false, error: { name: err.name || 'Error', message: err.message || String(err) }}); Deno.exit(0); });
`;
}
