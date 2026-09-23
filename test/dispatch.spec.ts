import { describe, it, expect } from 'vitest';
import { MockAgent } from 'undici';
import { buildSdk } from '../src/sdk/bindings.js';
import { dispatch, type RpcRequest } from '../src/sdk/runtime.js';

const config = {
  frBaseUrl: 'https://fr.test/api/v1', ecfrBaseUrl: 'https://ecfr.test/api',
  regsBaseUrl: 'https://regs.test', regsApiKey: 'test-only-key',
  userAgent: 'test/0', timeoutMs: 1000, retries: 0, cacheTtlMs: 60_000, cacheMaxItems: 10,
};

// Exercise every supported SDK method through dispatch, not just the HTTP clients.
const reads: Array<[string, unknown[], string]> = [
  ['fr.documents.search', [], '/documents.json'],
  ['fr.documents.get', ['doc'], '/documents/doc.json'],
  ['fr.documents.getMany', [['a', 'b']], '/documents/a,b.json'],
  ['fr.documents.facets', [{ facet: 'daily' }], '/documents/facets/daily'],
  ['fr.publicInspection.current', [], '/public-inspection-documents/current.json'],
  ['fr.publicInspection.search', [], '/public-inspection-documents.json'],
  ['fr.publicInspection.get', ['doc'], '/public-inspection-documents/doc.json'],
  ['fr.publicInspection.getMany', [['a', 'b']], '/public-inspection-documents/a,b.json'],
  ['fr.agencies.list', [], '/agencies'],
  ['fr.agencies.get', ['epa'], '/agencies/epa'],
  ['fr.issues.get', ['2026-01-01'], '/issues/2026-01-01.json'],
  ['fr.suggestedSearches.list', [], '/suggested_searches'],
  ['fr.suggestedSearches.get', ['science'], '/suggested_searches/science'],
  ['fr.images.get', ['image'], '/images/image'],
  ['ecfr.admin.agencies', [], '/admin/v1/agencies.json'],
  ['ecfr.admin.corrections', [], '/admin/v1/corrections.json'],
  ['ecfr.admin.corrections_for_title', [40], '/admin/v1/corrections/title/40.json'],
  ['ecfr.titles.list', [], '/versioner/v1/titles.json'],
  ['ecfr.structure', ['2026-01-01', 40], '/versioner/v1/structure/2026-01-01/title-40.json'],
  ['ecfr.ancestry', ['2026-01-01', 40], '/versioner/v1/ancestry/2026-01-01/title-40.json'],
  ['ecfr.versions', [40], '/versioner/v1/versions/title-40.json'],
  ['ecfr.full', ['2026-01-01', 40], '/versioner/v1/full/2026-01-01/title-40.xml'],
  ['ecfr.search.results', [{ query: 'water' }], '/search/v1/results?query=water'],
  ['ecfr.search.counts_daily', [{ query: 'water' }], '/search/v1/counts/daily?query=water'],
  ['ecfr.search.counts_titles', [{ query: 'water' }], '/search/v1/counts/titles?query=water'],
  ['ecfr.search.counts_hierarchy', [{ query: 'water' }], '/search/v1/counts/hierarchy?query=water'],
  ['ecfr.search.suggestions', [{ query: 'water' }], '/search/v1/suggestions?query=water'],
  ['regs.documents.search', [], '/v4/documents'],
  ['regs.documents.get', ['doc'], '/v4/documents/doc'],
  ['regs.comments.search', [], '/v4/comments'],
  ['regs.comments.get', ['comment'], '/v4/comments/comment'],
  ['regs.dockets.search', [], '/v4/dockets'],
  ['regs.dockets.get', ['docket'], '/v4/dockets/docket'],
];

describe('RPC method boundary', () => {
  it.each(reads)('preserves the GET contract of %s', async (id, args, path) => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    try {
      const [binding, ...methodPath] = id.split('.') as [string, ...string[]];
      const base = new URL(config[`${binding}BaseUrl` as 'frBaseUrl']);
      const value = id === 'ecfr.full' ? '<TITLE/>' : { endpoint: id };
      agent.get(base.origin).intercept({
        path: base.pathname.replace(/\/$/, '') + path, method: 'GET',
        ...(binding === 'regs' ? { headers: { 'x-api-key': config.regsApiKey } } : {}),
      }).reply(200, value);
      const sdk = buildSdk({ ...config, dispatcher: agent });
      expect(await dispatch(sdk, { binding, path: methodPath, args })).toEqual({ ok: true, value });
      agent.assertNoPendingInterceptors();
    } finally { await agent.close(); }
  });

  it.each(['fr', 'ecfr', 'regs'])('rejects internal and inherited methods for %s before upstream access', async binding => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    try {
      const sdk = buildSdk({ ...config, dispatcher: agent });
      for (const path of [
        ['http', 'call'], ['http', 'cache', 'clear'], ['http', 'cache', 'set'],
        ['http', 'cacheKey'], ['http', 'preflightLimiter', 'tryTake'],
        ['constructor'], ['toString'], ['__proto__', 'toString'],
        ['documents', 'toString'], ['documents', '__proto__', 'toString'],
        ['documents', 'search', 'call'], ['documents.search'], [], ['missing'],
      ]) {
        const result = await dispatch(sdk, { binding, path, args: [{ method: 'POST', path: '/blocked' }] });
        expect(result.ok, path.join('.')).toBe(false);
        expect(result.error?.name, path.join('.')).toBe('TypeError');
      }
    } finally { await agent.close(); }
  });

  it.each(['__proto__', 'constructor', 'toString'])('rejects inherited binding %s', async binding => {
    const sdk = buildSdk(config);
    expect((await dispatch(sdk, { binding, path: ['toString'], args: [] })).error?.name).toBe('TypeError');
  });

  it('rejects malformed bridge messages without invoking a method', async () => {
    const sdk = buildSdk(config);
    for (const req of [
      null, {}, { binding: null, path: ['list'], args: [] },
      { binding: 'fr', path: 'agencies.list', args: [] },
      { binding: 'fr', path: ['agencies', null], args: [] },
      { binding: 'fr', path: ['agencies', 'list'], args: {} },
    ]) {
      expect(await dispatch(sdk, req as unknown as RpcRequest)).toMatchObject({ ok: false, error: { name: 'TypeError' } });
    }
  });

  it('does not call inherited or accessor entries in method registries', async () => {
    const trap = () => { throw new Error('Registry traversal invoked a getter or inherited method'); };
    const methods = Object.create({ inherited: trap });
    Object.defineProperty(methods, 'accessor', { get: trap });
    const registry = { methods: { test: methods }, meta: [] };
    for (const path of [['inherited'], ['accessor']]) {
      expect(await dispatch(registry, { binding: 'test', path, args: [] }))
        .toMatchObject({ ok: false, error: { name: 'TypeError' } });
    }
  });
});
