import { describe, it, expect } from 'vitest';
import { buildSdk } from '../src/sdk/bindings.js';
import { dispatch } from '../src/sdk/runtime.js';

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
    expect(sdk.registeredNames).toEqual(['fr', 'ecfr']);
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
