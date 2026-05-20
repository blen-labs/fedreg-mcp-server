import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MockAgent } from 'undici';
import { buildSdk } from '../src/sdk/bindings.js';

const FR_ORIGIN = 'https://www.federalregister.gov';
const ECFR_ORIGIN = 'https://www.ecfr.gov';

let agent: MockAgent;

function sdk() {
  return buildSdk({
    frBaseUrl: `${FR_ORIGIN}/api/v1`,
    ecfrBaseUrl: `${ECFR_ORIGIN}/api`,
    userAgent: 'test/0.0',
    timeoutMs: 5000,
    retries: 0,
    cacheTtlMs: 0,
    cacheMaxItems: 0,
    dispatcher: agent,
  });
}

describe('FederalRegisterClient', () => {
  beforeEach(() => {
    agent = new MockAgent();
    agent.disableNetConnect();
  });
  afterEach(async () => { await agent.close(); });

  it('builds documents.search with flattened conditions', async () => {
    agent.get(FR_ORIGIN).intercept({
      path: (p) =>
        p.startsWith('/api/v1/documents.json')
        && p.includes('conditions%5Bterm%5D=methane')
        && p.includes('conditions%5Bagencies%5D%5B%5D=environmental-protection-agency')
        && p.includes('conditions%5Bpublication_date%5D%5Bgte%5D=2024-01-01')
        && p.includes('per_page=50')
        && p.includes('order=newest'),
      method: 'GET',
    }).reply(200, { results: [] });

    const out = await sdk().fr.documents.search({
      conditions: {
        term: 'methane',
        agencies: ['environmental-protection-agency'],
        publication_date: { gte: '2024-01-01' },
      },
      per_page: 50,
      order: 'newest',
    }) as { results: unknown[] };
    expect(out.results).toEqual([]);
  });

  it('fetches a single document by number', async () => {
    agent.get(FR_ORIGIN)
      .intercept({ path: '/api/v1/documents/2024-12345.json', method: 'GET' })
      .reply(200, { document_number: '2024-12345' });

    const out = await sdk().fr.documents.get('2024-12345') as { document_number: string };
    expect(out.document_number).toBe('2024-12345');
  });

  it('lists agencies', async () => {
    agent.get(FR_ORIGIN)
      .intercept({ path: '/api/v1/agencies', method: 'GET' })
      .reply(200, [{ slug: 'epa' }]);

    const out = await sdk().fr.agencies.list() as Array<{ slug: string }>;
    expect(out[0]?.slug).toBe('epa');
  });
});

describe('EcfrClient', () => {
  beforeEach(() => {
    agent = new MockAgent();
    agent.disableNetConnect();
  });
  afterEach(async () => { await agent.close(); });

  it('runs a search.results call', async () => {
    agent.get(ECFR_ORIGIN).intercept({
      path: (p) =>
        p.startsWith('/api/search/v1/results')
        && p.includes('query=methane')
        && p.includes('agency_slugs%5B%5D=environmental-protection-agency'),
      method: 'GET',
    }).reply(200, { results: [] });

    const out = await sdk().ecfr.search.results({
      query: 'methane',
      agency_slugs: ['environmental-protection-agency'],
    }) as { results: unknown[] };
    expect(out.results).toEqual([]);
  });

  it('fetches structure for a title on a date', async () => {
    agent.get(ECFR_ORIGIN)
      .intercept({ path: '/api/versioner/v1/structure/2024-01-01/title-40.json', method: 'GET' })
      .reply(200, { type: 'title' });

    const out = await sdk().ecfr.structure('2024-01-01', 40) as { type: string };
    expect(out.type).toBe('title');
  });

  it('returns full title XML as string', async () => {
    agent.get(ECFR_ORIGIN)
      .intercept({ path: '/api/versioner/v1/full/2024-01-01/title-40.xml', method: 'GET' })
      .reply(200, '<TITLE/>', { headers: { 'content-type': 'application/xml' } });

    const out = await sdk().ecfr.full('2024-01-01', 40);
    expect(typeof out).toBe('string');
    expect(out).toContain('<TITLE');
  });
});
