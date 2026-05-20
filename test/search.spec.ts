import { describe, it, expect } from 'vitest';
import { Bm25Index, tokenize } from '../src/search/bm25.js';
import { getCorpus } from '../src/search/corpus.js';
import { searchApi } from '../src/tools/searchApi.js';
import { describeSchema } from '../src/tools/describeSchema.js';

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
  it('loads endpoints and fields', () => {
    const { entries } = getCorpus();
    expect(entries.has('fr.documents.search')).toBe(true);
    expect(entries.has('ecfr.search.results')).toBe(true);
  });
});

describe('search_api tool', () => {
  it('finds the eCFR search endpoint for a regulation query', () => {
    const { hits } = searchApi({ query: 'search the code of federal regulations text', k: 5 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some(h => h.id === 'ecfr.search.results')).toBe(true);
  });

  it('finds Federal Register document search for an agency query', () => {
    const { hits } = searchApi({ query: 'search federal register documents by agency', k: 5 });
    expect(hits.some(h => h.id === 'fr.documents.search' || h.id.startsWith('fr.agencies'))).toBe(true);
  });
});

describe('describe_schema tool', () => {
  it('resolves an exact path', () => {
    const r = describeSchema({ path: 'fr.documents.search' });
    expect(r.found).toBe(true);
    if (r.found) {
      expect(r.entries[0]?.binding).toBe('fr');
    }
  });

  it('lists by prefix', () => {
    const r = describeSchema({ prefix: 'ecfr.' });
    expect(r.found).toBe(true);
    if (r.found) {
      expect(r.entries.length).toBeGreaterThan(3);
    }
  });

  it('returns not-found cleanly', () => {
    const r = describeSchema({ path: 'fr.nope' });
    expect(r.found).toBe(false);
  });
});
