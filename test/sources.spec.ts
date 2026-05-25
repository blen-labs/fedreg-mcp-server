import { describe, it, expect } from 'vitest';
import { getSources } from '../src/sdk/sources/index.js';

function cfg(extra = {}) {
  return {
    frBaseUrl: 'https://www.federalregister.gov/api/v1',
    ecfrBaseUrl: 'https://www.ecfr.gov/api',
    regsBaseUrl: 'https://api.regulations.gov',
    userAgent: 'test/0.0', timeoutMs: 5000, retries: 0, cacheTtlMs: 0, cacheMaxItems: 0,
    ...extra,
  };
}

describe('source registry', () => {
  it('builds fr and ecfr as enabled sources with corpus', () => {
    const sources = getSources(cfg());
    const fr = sources.find(s => s.name === 'fr');
    const ecfr = sources.find(s => s.name === 'ecfr');
    expect(fr?.enabled).toBe(true);
    expect(ecfr?.enabled).toBe(true);
    expect(fr!.corpus.endpoints.length).toBeGreaterThan(0);
    expect(fr!.label).toBe('Federal Register');
  });

  it('never exposes secrets on the source object', () => {
    const sources = getSources(cfg());
    for (const s of sources) {
      expect(JSON.stringify(s)).not.toContain('X-Api-Key');
    }
  });
});
