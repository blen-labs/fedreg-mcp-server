import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MockAgent } from 'undici';
import { IpRateLimiter } from '../src/server/ipRateLimiter.js';
import { SubjectQuota } from '../src/util/quotas.js';
import { HttpClient } from '../src/util/httpClient.js';

describe('IpRateLimiter', () => {
  it('allows up to burst then denies', () => {
    const lim = new IpRateLimiter(1, 3);
    expect(lim.allow('1.2.3.4')).toBe(true);
    expect(lim.allow('1.2.3.4')).toBe(true);
    expect(lim.allow('1.2.3.4')).toBe(true);
    expect(lim.allow('1.2.3.4')).toBe(false);
  });
});

describe('SubjectQuota', () => {
  it('enforces a daily cap', () => {
    const q = new SubjectQuota(2);
    expect(q.consume('user').allowed).toBe(true);
    expect(q.consume('user').allowed).toBe(true);
    expect(q.consume('user').allowed).toBe(false);
  });
});

describe('HttpClient default headers + 429', () => {
  let agent: MockAgent;
  const ORIGIN = 'https://api.example.gov';
  beforeEach(() => { agent = new MockAgent(); agent.disableNetConnect(); });
  afterEach(async () => { await agent.close(); });

  function client(extra: Record<string, unknown> = {}) {
    return new HttpClient({ baseUrl: ORIGIN, dispatcher: agent, retries: 2, cacheTtlMs: 0, cacheMaxItems: 0, ...extra });
  }

  it('sends defaultHeaders and never exposes them via JSON.stringify', async () => {
    let seen: Record<string, unknown> = {};
    agent.get(ORIGIN).intercept({ path: '/v4/documents', method: 'GET' })
      .reply(200, (opts) => { seen = (opts.headers ?? {}) as Record<string, unknown>; return { data: [] }; });
    const c = client({ defaultHeaders: { 'X-Api-Key': 'SECRET-KEY' } });
    await c.call({ path: '/v4/documents' });
    const headerVal = Object.entries(seen).find(([k]) => k.toLowerCase() === 'x-api-key')?.[1];
    expect(headerVal).toBe('SECRET-KEY');
    expect(JSON.stringify(c)).not.toContain('SECRET-KEY');
  });

  it('per-call headers win over defaultHeaders', async () => {
    let seen: Record<string, unknown> = {};
    agent.get(ORIGIN).intercept({ path: '/x', method: 'GET' })
      .reply(200, (opts) => { seen = (opts.headers ?? {}) as Record<string, unknown>; return {}; });
    const c = client({ defaultHeaders: { 'X-Api-Key': 'A' } });
    await c.call({ path: '/x', headers: { 'X-Api-Key': 'B' } });
    const v = Object.entries(seen).find(([k]) => k.toLowerCase() === 'x-api-key')?.[1];
    expect(v).toBe('B');
  });

  it('with retry429=false a 429 throws RateLimited and is not retried', async () => {
    agent.get(ORIGIN).intercept({ path: '/lim', method: 'GET' })
      .reply(429, 'slow down', { headers: { 'retry-after': '7' } });
    const c = client({ retry429: false });
    await expect(c.call({ path: '/lim' })).rejects.toMatchObject({ name: 'RateLimited' });
  });

  it('does not serve a cached response across different per-call auth headers', async () => {
    agent.get(ORIGIN).intercept({ path: '/v4/x', method: 'GET' }).reply(200, { who: 'A' });
    agent.get(ORIGIN).intercept({ path: '/v4/x', method: 'GET' }).reply(200, { who: 'B' });
    const c = client({ cacheTtlMs: 60_000, cacheMaxItems: 100 }); // cache ON
    const a = await c.call({ path: '/v4/x', headers: { 'X-Api-Key': 'A' } });
    const b = await c.call({ path: '/v4/x', headers: { 'X-Api-Key': 'B' } });
    expect(a).toEqual({ who: 'A' });
    expect(b).toEqual({ who: 'B' }); // different key must NOT be served the cached 'A'
  });

  it('still serves a cached response for the same URL + same auth', async () => {
    agent.get(ORIGIN).intercept({ path: '/v4/y', method: 'GET' }).reply(200, { n: 1 }); // only ONE interceptor
    const c = client({ cacheTtlMs: 60_000, cacheMaxItems: 100 });
    const first = await c.call({ path: '/v4/y', headers: { 'X-Api-Key': 'A' } });
    const second = await c.call({ path: '/v4/y', headers: { 'X-Api-Key': 'A' } }); // from cache; no 2nd interceptor
    expect(first).toEqual({ n: 1 });
    expect(second).toEqual({ n: 1 });
  });
});
