import { describe, it, expect } from 'vitest';
import { preflight } from '../src/sandbox/policy.js';
import { buildDenoRunner, DenoRunner } from '../src/sandbox/deno.js';
import { IsolateRunner } from '../src/sandbox/isolate.js';

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

describe('dynamic binding injection', () => {
  it('deno runner injects exactly the given bindings via JSON.stringify', () => {
    const runner = buildDenoRunner('return 1;', 1000, ['fr', 'ecfr', 'regs']);
    expect(runner).toContain('["fr","ecfr","regs"]');
    expect(runner).toContain('globalThis[name] = makeProxy(name)');
    expect(runner).not.toContain('globalThis.fr =');
  });

  it('isolate injects bindings as working proxies (gated on availability)', async () => {
    const runner = new IsolateRunner();
    if (!(await runner.available())) return; // skip where isolated-vm cannot load
    const bridge = { dispatch: async () => ({ ok: true, value: 'OK' }) };
    const res = await runner.execute({ code: 'return (typeof fr) + "," + (await fr.documents.search());', bindings: ['fr', 'ecfr'] }, bridge);
    expect(res.ok).toBe(true);
    expect(res.value).toBe('function,OK');
  });

  it('deno runner executes code and proxies bindings (gated on availability)', async () => {
    const runner = new DenoRunner();
    if (!(await runner.available())) return; // skip where deno is not on PATH
    const bridge = { dispatch: async () => ({ ok: true, value: 'OK' }) };
    const res = await runner.execute({ code: 'return (typeof fr) + "," + (await fr.documents.search());', bindings: ['fr', 'ecfr'] }, bridge);
    expect(res.ok).toBe(true);
    expect(res.value).toBe('function,OK');
  });

  it('deno runner rejects banned globals via preflight (gated on availability)', async () => {
    const runner = new DenoRunner();
    if (!(await runner.available())) return; // skip where deno is not on PATH
    const bridge = { dispatch: async () => ({ ok: true, value: 'OK' }) };
    const res = await runner.execute({ code: 'return process.env;', bindings: ['fr'] }, bridge);
    expect(res.ok).toBe(false);
    expect(res.error?.name).toBe('PolicyError');
  });
});
