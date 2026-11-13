import { describe, it, expect } from 'vitest';
import { preflight } from '../src/sandbox/policy.js';
import { DenoRunner, SUPERVISOR_SOURCE } from '../src/sandbox/deno.js';
import { IsolateRunner } from '../src/sandbox/isolate.js';
import { MockAgent } from 'undici';
import { buildSdk } from '../src/sdk/bindings.js';
import { dispatch } from '../src/sdk/runtime.js';

describe('sandbox policy preflight', () => {
  it('allows simple SDK calls', () => {
    const r = preflight(`const x = await fr.documents.search({ per_page: 5 }); return x;`);
    expect(r.ok).toBe(true);
  });

  it('rejects static imports', () => {
    const r = preflight(`import 'fs';\nawait fr.agencies.list();`);
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/imports/);
  });

  it('rejects eval / Function / process', () => {
    expect(preflight(`eval('1')`).ok).toBe(false);
    expect(preflight(`new Function('return 1')()`).ok).toBe(false);
    expect(preflight(`process.exit(0)`).ok).toBe(false);
  });

  it('rejects __proto__ access', () => {
    expect(preflight(`const x = {}; x.__proto__;`).ok).toBe(false);
  });

  it('rejects dynamic import', () => {
    expect(preflight(`await import('fs')`).ok).toBe(false);
  });
});

describe.each([new IsolateRunner(), new DenoRunner()])('$kind RPC isolation', runner => {
  it('allows public reads but rejects POST access and cache poisoning across executions', async ({ skip }) => {
    if (!(await runner.available())) return skip();
    const agent = new MockAgent();
    agent.disableNetConnect();
    let posts = 0;
    agent.get('https://fr.test').intercept({ path: '/api/v1/blocked', method: 'POST' })
      .reply(() => { posts++; return { statusCode: 200, data: '{}' }; }).persist();
    agent.get('https://fr.test').intercept({ path: '/api/v1/agencies', method: 'GET' })
      .reply(200, [{ slug: 'epa' }]);
    const sdk = buildSdk({
      frBaseUrl: 'https://fr.test/api/v1', ecfrBaseUrl: 'https://ecfr.test/api', regsBaseUrl: 'https://regs.test',
      userAgent: 'test/0', timeoutMs: 1000, retries: 0, cacheTtlMs: 60_000, cacheMaxItems: 10, dispatcher: agent,
    });
    const bridge = { dispatch: (req: Parameters<typeof dispatch>[1]) => dispatch(sdk, req) };
    const run = (code: string) => runner.execute({ code, bindings: sdk.registeredNames, timeoutMs: 3000 }, bridge);
    try {
      const blocked = await run(`
        const errors = [];
        for (const path of [['http', 'call'], ['http', 'cache', 'clear'], ['__proto__', 'toString'], ['agencies.list']]) {
          let method = fr;
          for (const key of path) method = method[key];
          try { await method({ method: 'POST', path: '/blocked' }); errors.push('ALLOWED'); }
          catch (e) { errors.push(e.name); }
        }
        return errors;
      `);
      expect(blocked.ok).toBe(true);
      expect(blocked.value).toEqual(['TypeError', 'TypeError', 'TypeError', 'TypeError']);
      expect(posts).toBe(0);
      const poisoned = await run(`
        try {
          await fr.http.cache.set('https://fr.test/api/v1/agencies', { status: 200, body: [{ slug: 'forged' }], headers: {} });
          return 'ALLOWED';
        } catch (e) { return e.name; }
      `);
      expect(poisoned.ok).toBe(true);
      expect(poisoned.value).toBe('TypeError');
      const read = await run('return await fr.agencies.list();');
      expect(read.ok).toBe(true);
      expect(read.value).toEqual([{ slug: 'epa' }]);
    } finally { await agent.close(); }
  });
});

describe('dynamic binding injection', () => {
  it('deno supervisor never embeds user code or binding names (they arrive by message)', () => {
    expect(SUPERVISOR_SOURCE).not.toMatch(/\bfr\b|ecfr|regs/);
    expect(SUPERVISOR_SOURCE).toContain('crypto.getRandomValues');
    expect(SUPERVISOR_SOURCE).toContain("'Deno', 'postMessage'");
  });

  it('isolate injects bindings as working proxies (gated on availability)', async ({ skip }) => {
    const runner = new IsolateRunner();
    if (!(await runner.available())) return skip();
    const bridge = { dispatch: async () => ({ ok: true, value: 'OK' }) };
    const res = await runner.execute({ code: 'return (typeof fr) + "," + (await fr.documents.search());', bindings: ['fr', 'ecfr'] }, bridge);
    expect(res.ok).toBe(true);
    expect(res.value).toBe('function,OK');
  });

  it('deno runner executes code and proxies bindings (gated on availability)', async ({ skip }) => {
    const runner = new DenoRunner();
    if (!(await runner.available())) return skip();
    const bridge = { dispatch: async () => ({ ok: true, value: 'OK' }) };
    const res = await runner.execute({ code: 'return (typeof fr) + "," + (await fr.documents.search());', bindings: ['fr', 'ecfr'] }, bridge);
    expect(res.ok).toBe(true);
    expect(res.value).toBe('function,OK');
  });

  it('deno runner rejects banned globals via preflight (gated on availability)', async ({ skip }) => {
    const runner = new DenoRunner();
    if (!(await runner.available())) return skip();
    const bridge = { dispatch: async () => ({ ok: true, value: 'OK' }) };
    const res = await runner.execute({ code: 'return process.env;', bindings: ['fr'] }, bridge);
    expect(res.ok).toBe(false);
    expect(res.error?.name).toBe('PolicyError');
  });
});

const echo = { dispatch: async (c: { binding: string; path: string[]; args: unknown[] }) =>
  c.path[0] === 'fail'
    ? { ok: false, error: { name: 'NotFound', message: 'nope', status: 404 } }
    : { ok: true, value: { binding: c.binding, path: c.path, args: c.args } } };

describe.each([new IsolateRunner(), new DenoRunner()])('$kind runner contract', runner => {
  const run = (code: string, extra: Record<string, unknown> = {}) =>
    runner.execute({ code, bindings: ['fr', 'ecfr'], timeoutMs: 3000, ...extra }, echo);

  it.for([
    ['returns values and captures logs', 'console.log("hi", { a: 1 }); return 1 + 2', { ok: true, value: 3, logs: ['hi {"a":1}'] }],
    ['proxies SDK calls', 'return await fr.documents.search({ term: "x" })', { ok: true, value: { binding: 'fr', path: ['documents', 'search'], args: [{ term: 'x' }] } }],
    ['keeps an SDK error\'s name and status', 'try { await fr.fail(); } catch (e) { return [e.name, e.message, e.status]; }', { ok: true, value: ['NotFound', 'nope', 404] }],
    ['returns null for undefined', 'return undefined', { ok: true, value: null }],
    ['reports a thrown error with its status', 'throw Object.assign(new Error("boom"), { status: 418 })', { ok: false, error: { name: 'Error', message: 'boom', status: 418 } }],
  ] as const)('%s', async ([, code, expected], { skip }) => {
    if (!(await runner.available())) return skip();
    expect(await run(code)).toMatchObject(expected);
  });

  it('enforces the host wall-clock deadline for an unresolved promise and for a CPU loop', async ({ skip }) => {
    if (!(await runner.available())) return skip();
    for (const code of ['await new Promise(() => {}); return 42', 'while (true) {}']) {
      const t0 = Date.now();
      const res = await run(code, { timeoutMs: 300 });
      expect(res.error?.name).toBe('TimeoutError');
      expect(Date.now() - t0).toBeLessThan(2500);
    }
  });

  it('rejects oversized results, code and SDK arguments, and bounds logs', async ({ skip }) => {
    if (!(await runner.available())) return skip();
    expect((await run('return "x".repeat(3000)', { limits: { maxResultBytes: 1024 } })).error?.name).toBe('ResultTooLarge');
    expect((await run(`// ${'x'.repeat(3000)}\nreturn 1`, { limits: { maxCodeBytes: 1024 } })).error?.name).toBe('CodeTooLarge');
    expect((await run('try { await fr.documents.search("x".repeat(3000)); } catch (e) { return e.name; }', { limits: { maxRpcArgBytes: 1024 } })).value).toBe('ArgumentsTooLarge');
    const noisy = await run('for (let i = 0; i < 5000; i++) console.log("x".repeat(100)); return 1', { limits: { maxLogBytes: 1000 } });
    expect(noisy.ok).toBe(true);
    expect(noisy.logs.at(-1)).toBe('[logs truncated]');
    expect(noisy.logs.length).toBeLessThan(20);
  });
});

describe('deno runner isolation (gated on availability)', () => {
  const runner = new DenoRunner();
  const run = (code: string, extra: Record<string, unknown> = {}) =>
    runner.execute({ code, bindings: ['fr'], timeoutMs: 3000, ...extra }, echo);

  it('treats frame-shaped console output as log text, never as protocol frames', async ({ skip }) => {
    if (!(await runner.available())) return skip();
    const res = await run('console.log("00000001\\nx"); console.log(JSON.stringify({ t: "done", ok: true, json: "1" })); return "ok"');
    expect(res).toMatchObject({ ok: true, value: 'ok' });
  });

  it('gives user code no access to the runner protocol or its watchdog', async ({ skip }) => {
    if (!(await runner.available())) return skip();
    // The 2.2.2 exploits: a raw frame write crashed the host; a forged result plus clearTimeout
    // returned a forged value and left the child spinning.
    const raw = await run("origLog('00000001\\nx'); return await new Promise(() => {})");
    expect(raw).toMatchObject({ ok: false, error: { name: 'ReferenceError' } });
    const forged = await run("writeFrame({ kind: 'result', ok: true, value: 'forged' }); clearTimeout(timer); while (true) {}", { timeoutMs: 300 });
    expect(forged.ok).toBe(false);
    expect(forged.value).toBeUndefined();
    const ambient = await run('const c = "constr" + "uctor"; const F = (async () => {})[c][c]; return F("return [typeof Deno, typeof self.fetch, typeof self.postMessage, typeof self.Worker]")();');
    expect(ambient).toMatchObject({ ok: true, value: ['undefined', 'undefined', 'undefined', 'undefined'] });
  });

  it('resolves only after its child process has exited', async ({ skip }) => {
    if (!(await runner.available()) || process.platform === 'win32') return skip();
    const { execFileSync } = await import('node:child_process');
    // Only this worker's own children: other spec files run Deno sandboxes in parallel processes.
    // pgrep exits 1 on "no match" (zero children); any other failure (e.g. pgrep missing) must fail the test, not read as 0.
    const count = () => {
      try { return execFileSync('pgrep', ['-P', String(process.pid), '-f', 'fedreg-deno-.*supervisor\\.js']).toString().trim().split('\n').filter(Boolean).length; }
      catch (e) { if ((e as { status?: number }).status === 1) return 0; throw e; }
    };
    const before = count();
    await run('return 1');
    expect(count()).toBe(before);
    await run('while (true) {}', { timeoutMs: 200 });
    expect(count()).toBe(before);
  });
});
