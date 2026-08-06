import { describe, it, expect } from 'vitest';
import { getSources, validateSourceNames } from '../src/sdk/sources/index.js';

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

  // Forward-looking regression guard: only becomes meaningful once the regs source
  // injects an API key (Task 10); fr/ecfr carry no secret today.
  it('never exposes secrets on the source object', () => {
    const sources = getSources(cfg());
    for (const s of sources) {
      expect(JSON.stringify(s)).not.toContain('X-Api-Key');
    }
  });
});

describe('validateSourceNames', () => {
  it('throws for an invalid identifier', () => {
    expect(() => validateSourceNames([{ name: 'fr.docs' }])).toThrow(/must be a JS identifier/);
    expect(() => validateSourceNames([{ name: '9bad' }])).toThrow(/must be a JS identifier/);
  });

  it('throws for a denylisted name', () => {
    expect(() => validateSourceNames([{ name: 'console' }])).toThrow(/not allowed/);
    expect(() => validateSourceNames([{ name: 'process' }])).toThrow(/not allowed/);
  });

  it('throws for a duplicate name', () => {
    expect(() => validateSourceNames([{ name: 'fr' }, { name: 'fr' }])).toThrow(/Duplicate/);
  });

  it('does not throw for valid distinct first-party names', () => {
    expect(() => validateSourceNames([{ name: 'fr' }, { name: 'ecfr' }, { name: 'regs' }])).not.toThrow();
  });
});

describe('regs source enable/disable', () => {
  it('is disabled without an API key, with an actionable reason', () => {
    const regs = getSources(cfg()).find(s => s.name === 'regs')!;
    expect(regs.enabled).toBe(false);
    expect(regs.disabledReason).toMatch(/FEDREG_REGS_API_KEY/);
  });
  it('is enabled when a key is provided, and never leaks it', () => {
    const regs = getSources(cfg({ regsApiKey: 'SECRET-KEY' })).find(s => s.name === 'regs')!;
    expect(regs.enabled).toBe(true);
    expect(JSON.stringify(regs)).not.toContain('SECRET-KEY');
  });
});
