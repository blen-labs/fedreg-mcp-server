import { describe, it, expect } from 'vitest';
import { buildSdk } from '../src/sdk/bindings.js';
import { dispatch } from '../src/sdk/runtime.js';
import { IsolateRunner } from '../src/sandbox/isolate.js';

function cfg() {
  return {
    frBaseUrl: 'https://www.federalregister.gov/api/v1',
    ecfrBaseUrl: 'https://www.ecfr.gov/api',
    regsBaseUrl: 'https://api.regulations.gov',
    userAgent: 'test/0.0', timeoutMs: 5000, retries: 0, cacheTtlMs: 0, cacheMaxItems: 0,
  };
}

describe('buildSdk + dispatch', () => {
  it('exposes enabled clients and registered names', () => {
    const sdk = buildSdk(cfg());
    expect(sdk.registeredNames).toEqual(['fr', 'ecfr', 'regs']);
    expect(Object.keys(sdk.clients).sort()).toEqual(['ecfr', 'fr']);
    expect(sdk.meta.find(m => m.name === 'fr')?.enabled).toBe(true);
  });

  it('dispatch returns TypeError for an unknown binding', async () => {
    const sdk = buildSdk(cfg());
    const res = await dispatch({ clients: sdk.clients, meta: sdk.meta }, { binding: 'nope', path: ['x'], args: [] });
    expect(res.ok).toBe(false);
    expect(res.error?.name).toBe('TypeError');
  });
});

describe('disabled source degradation', () => {
  it('dispatch returns SourceUnavailable for a registered-but-disabled binding', async () => {
    const sdk = buildSdk(cfg()); // no regsApiKey -> regs disabled
    expect(sdk.registeredNames).toContain('regs');
    expect(sdk.clients.regs).toBeUndefined();
    const res = await dispatch({ clients: sdk.clients, meta: sdk.meta }, { binding: 'regs', path: ['documents', 'search'], args: [{}] });
    expect(res.ok).toBe(false);
    expect(res.error?.name).toBe('SourceUnavailable');
    expect(res.error?.message).toMatch(/FEDREG_REGS_API_KEY/);
  });

  it('regs global is defined in the sandbox even when disabled (no ReferenceError)', async () => {
    const runner = new IsolateRunner();
    if (!(await runner.available())) return;
    const sdk = buildSdk(cfg());
    const bridge = { dispatch: (req: { binding: string; path: string[]; args: unknown[] }) => dispatch({ clients: sdk.clients, meta: sdk.meta }, req) };
    const res = await runner.execute({ code: 'try { await regs.documents.search(); return "no-throw"; } catch (e) { return e.name; }', bindings: sdk.registeredNames }, bridge);
    expect(res.ok).toBe(true);
    expect(res.value).toBe('SourceUnavailable');
  });
});
