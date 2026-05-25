import { describe, it, expect } from 'vitest';
import { Bm25Index, tokenize } from '../src/search/bm25.js';
import { buildCorpus } from '../src/search/corpus.js';
import { getSources } from '../src/sdk/sources/index.js';
import { searchApi } from '../src/tools/searchApi.js';
import { describeSchema } from '../src/tools/describeSchema.js';

function corpus() {
  return buildCorpus(getSources({
    frBaseUrl: 'https://www.federalregister.gov/api/v1', ecfrBaseUrl: 'https://www.ecfr.gov/api',
    regsBaseUrl: 'https://api.regulations.gov', userAgent: 't', timeoutMs: 1, retries: 0, cacheTtlMs: 0, cacheMaxItems: 0,
  }));
}

describe('bm25', () => {
  it('tokenizes', () => {
    expect(tokenize('Hello, world! THE quick brown fox.')).toEqual(['hello', 'world', 'quick', 'brown', 'fox']);
  });

  it('scores relevant docs higher', () => {
    const idx = new Bm25Index();
    idx.add({ id: 'a', text: 'methane emissions rule from the EPA' });
    idx.add({ id: 'b', text: 'aviation safety notice' });
    idx.add({ id: 'c', text: 'methane reporting requirements' });
    const hits = idx.search('methane', 5);
    expect(hits[0]).toBeDefined();
    expect(['a', 'c']).toContain(hits[0]!.id);
  });
});

describe('corpus', () => {
  it('loads endpoints and fields from sources', () => {
    const { entries } = corpus();
    expect(entries.has('fr.documents.search')).toBe(true);
    expect(entries.has('ecfr.search.results')).toBe(true);
  });
});

describe('search_api tool', () => {
  it('finds the eCFR search endpoint', () => {
    const { hits } = searchApi({ query: 'search the code of federal regulations text', k: 5 }, corpus());
    expect(hits.some(h => h.id === 'ecfr.search.results')).toBe(true);
  });

  it('finds Federal Register document search for an agency query', () => {
    const { hits } = searchApi({ query: 'search federal register documents by agency', k: 5 }, corpus());
    expect(hits.some(h => h.id === 'fr.documents.search' || h.id.startsWith('fr.agencies'))).toBe(true);
  });
});

describe('describe_schema tool', () => {
  it('resolves an exact path', () => {
    const r = describeSchema({ path: 'fr.documents.search' }, corpus().entries);
    expect(r.found).toBe(true);
    if (r.found) expect(r.entries[0]?.binding).toBe('fr');
  });
  it('lists by prefix', () => {
    const r = describeSchema({ prefix: 'ecfr.' }, corpus().entries);
    expect(r.found).toBe(true);
  });
  it('returns not-found cleanly', () => {
    const r = describeSchema({ path: 'fr.nope' }, corpus().entries);
    expect(r.found).toBe(false);
  });
});
