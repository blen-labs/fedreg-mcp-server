import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MockAgent } from 'undici';
import { RegulationsClient, toJsonApiQuery } from '../src/sdk/regs-client.js';
import { HttpClient } from '../src/util/httpClient.js';

const ORIGIN = 'https://api.regulations.gov';
let agent: MockAgent;
function client() {
  return new RegulationsClient(new HttpClient({ baseUrl: ORIGIN, userAgent: 'test/0.0', timeoutMs: 5000, retries: 0, cacheTtlMs: 0, cacheMaxItems: 0, dispatcher: agent }));
}

describe('toJsonApiQuery', () => {
  it('flattens filters, ranges, sort and page', () => {
    const q = toJsonApiQuery({ filter: { searchTerm: 'methane', postedDate: { ge: '2024-01-01', le: '2024-12-31' } }, sort: '-postedDate', page: { number: 1, size: 250 } });
    expect(q['filter[searchTerm]']).toBe('methane');
    expect(q['filter[postedDate][ge]']).toBe('2024-01-01');
    expect(q['filter[postedDate][le]']).toBe('2024-12-31');
    expect(q['sort']).toBe('-postedDate');
    expect(q['page[number]']).toBe(1);
    expect(q['page[size]']).toBe(250);
  });
});

describe('RegulationsClient', () => {
  beforeEach(() => { agent = new MockAgent(); agent.disableNetConnect(); });
  afterEach(async () => { await agent.close(); });

  it('searches comments by commentOnId and passes filters through raw', async () => {
    agent.get(ORIGIN).intercept({
      path: (p) => p.startsWith('/v4/comments') && p.includes('filter%5BcommentOnId%5D=0900-XYZ') && p.includes('page%5Bsize%5D=250'),
      method: 'GET',
    }).reply(200, { data: [{ id: 'c1', type: 'comments' }], meta: { totalElements: 1 } });
    const out = await client().comments.search({ filter: { commentOnId: '0900-XYZ' }, page: { size: 250 } }) as { data: unknown[]; meta: { totalElements: number } };
    expect(out.data).toHaveLength(1);
    expect(out.meta.totalElements).toBe(1);
  });

  it('fetches a document with include=attachments', async () => {
    agent.get(ORIGIN).intercept({ path: '/v4/documents/EPA-HQ-2024-0001-0001?include=attachments', method: 'GET' })
      .reply(200, { data: { id: 'EPA-HQ-2024-0001-0001', type: 'documents' } });
    const out = await client().documents.get('EPA-HQ-2024-0001-0001', { include: 'attachments' }) as { data: { id: string } };
    expect(out.data.id).toBe('EPA-HQ-2024-0001-0001');
  });
});
