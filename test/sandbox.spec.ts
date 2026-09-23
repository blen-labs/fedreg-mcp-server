import { describe, it, expect } from 'vitest';
import { preflight } from '../src/sandbox/policy.js';
import { buildDenoRunner, DenoRunner } from '../src/sandbox/deno.js';
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
  it('deno runner injects exactly the given bindings via JSON.stringify', () => {
    const runner = buildDenoRunner('return 1;', 1000, ['fr', 'ecfr', 'regs']);
    expect(runner).toContain('["fr","ecfr","regs"]');
    expect(runner).toContain('globalThis[name] = makeProxy(name)');
    expect(runner).not.toContain('globalThis.fr =');
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
