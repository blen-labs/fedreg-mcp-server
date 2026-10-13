import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MockAgent } from 'undici';
import { gzipSync } from 'node:zlib';
import type { IncomingMessage } from 'node:http';
import { IpRateLimiter, clientIp } from '../src/server/ipRateLimiter.js';
import { SubjectQuota } from '../src/util/quotas.js';
import { HttpClient } from '../src/util/httpClient.js';
import { UpstreamGate } from '../src/util/upstreamGate.js';

describe('IpRateLimiter', () => {
  it('allows up to burst then denies', () => {
    const lim = new IpRateLimiter(1, 3);
    expect(lim.allow('1.2.3.4')).toBe(true);
    expect(lim.allow('1.2.3.4')).toBe(true);
    expect(lim.allow('1.2.3.4')).toBe(true);
    expect(lim.allow('1.2.3.4')).toBe(false);
  });
  it('accepts a zero or extreme refill rate without an invalid cache ttl', () => {
    const lim = new IpRateLimiter(0, 1);
    expect(lim.allow('1.2.3.4')).toBe(true);
    expect(lim.allow('1.2.3.4')).toBe(false);
    expect(() => new IpRateLimiter(1e-300, 1e10)).not.toThrow();
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

  it('throws RegsRateLimited when the preflight limiter is exhausted', async () => {
    const limiter = { tryTake: () => false, secondsUntilNext: () => 5 };
    const c = client({ preflightLimiter: limiter });
    await expect(c.call({ path: '/v4/z' })).rejects.toMatchObject({ name: 'RegsRateLimited' });
  });

  it('does not consume the preflight limiter on a cache hit', async () => {
    let takes = 0;
    const limiter = { tryTake: () => { takes++; return true; }, secondsUntilNext: () => 0 };
    agent.get(ORIGIN).intercept({ path: '/v4/c', method: 'GET' }).reply(200, { n: 1 }); // ONE interceptor
    const c = client({ cacheTtlMs: 60_000, cacheMaxItems: 100, preflightLimiter: limiter });
    await c.call({ path: '/v4/c' }); // miss -> takes 1
    await c.call({ path: '/v4/c' }); // hit -> no take
    expect(takes).toBe(1);
  });

  it('caches decoded gzip XML, not compressed bytes', async () => {
    const xml = '<SECTION><P>§ 273.24 — café</P></SECTION>';
    agent.get(ORIGIN).intercept({ path: '/full.xml', method: 'GET' })
      .reply(200, gzipSync(xml), { headers: { 'content-encoding': 'gzip' } });
    const c = client({ cacheTtlMs: 60_000, cacheMaxItems: 100 });
    const opts = { path: '/full.xml', accept: 'xml' as const, headers: { 'accept-encoding': 'gzip' } };
    expect(await c.call(opts)).toBe(xml);
    expect(await c.call(opts)).toBe(xml);
  });

  it('parses gzip JSON after decompression', async () => {
    agent.get(ORIGIN).intercept({ path: '/compressed.json', method: 'GET' })
      .reply(200, gzipSync(JSON.stringify({ title: '§ 273.24' })), { headers: { 'content-encoding': 'gzip' } });
    expect(await client().call({ path: '/compressed.json' })).toEqual({ title: '§ 273.24' });
  });

  it('preserves decoded compressed upstream errors and retry-after', async () => {
    agent.get(ORIGIN).intercept({ path: '/compressed-error', method: 'GET' })
      .reply(429, gzipSync('slow down'), { headers: { 'content-encoding': 'gzip', 'retry-after': '7' } });
    await expect(client({ retry429: false }).call({ path: '/compressed-error' })).rejects.toMatchObject({
      name: 'RateLimited', status: 429, bodySnippet: 'slow down',
      message: expect.stringContaining('retry-after 7'),
    });
  });

  it('rejects corrupt gzip without caching it', async () => {
    agent.get(ORIGIN).intercept({ path: '/corrupt.xml', method: 'GET' })
      .reply(200, 'not gzip', { headers: { 'content-encoding': 'gzip' } });
    agent.get(ORIGIN).intercept({ path: '/corrupt.xml', method: 'GET' })
      .reply(200, gzipSync('<TITLE/>'), { headers: { 'content-encoding': 'gzip' } });
    const c = client({ retries: 0, cacheTtlMs: 60_000, cacheMaxItems: 100 });
    await expect(c.call({ path: '/corrupt.xml', accept: 'xml' })).rejects.toThrow();
    expect(await c.call({ path: '/corrupt.xml', accept: 'xml' })).toBe('<TITLE/>');
  });
});

describe('clientIp', () => {
  const req = (remoteAddress: string, headers: Record<string, string | string[]> = {}) =>
    ({ socket: { remoteAddress }, headers }) as unknown as IncomingMessage;
  it('uses the TCP peer when no header is trusted, even if forwarding headers are sent', () => {
    expect(clientIp(req('::ffff:100.64.0.2', { 'x-real-ip': '1.2.3.4', 'x-forwarded-for': '1.2.3.4' }))).toBe('100.64.0.2');
  });
  it('reads the trusted header (Railway: x-real-ip), case-insensitively', () => {
    expect(clientIp(req('100.64.0.2', { 'x-real-ip': '71.178.42.139' }), 'X-Real-IP')).toBe('71.178.42.139');
  });
  it('takes the rightmost entry of a list-valued header, the one the proxy added', () => {
    expect(clientIp(req('10.0.0.5', { 'x-forwarded-for': '6.6.6.6, 1.2.3.4' }), 'x-forwarded-for')).toBe('1.2.3.4');
  });
  it('falls back to the peer when the trusted header is missing', () => {
    expect(clientIp(req('100.64.0.2'), 'x-real-ip')).toBe('100.64.0.2');
  });
});

describe('HttpClient upstream protection (429 retry, gate, in-flight sharing)', () => {
  let agent: MockAgent;
  const ORIGIN = 'https://api.example.gov';
  beforeEach(() => { agent = new MockAgent(); agent.disableNetConnect(); });
  afterEach(async () => { await agent.close(); });
  const client = (extra: Record<string, unknown> = {}) =>
    new HttpClient({ baseUrl: ORIGIN, dispatcher: agent, retries: 2, cacheTtlMs: 0, cacheMaxItems: 0, label: 'Test API', maxRetryAfterMs: 20, ...extra });

  it('retries a 429 once after Retry-After, then succeeds', async () => {
    let requests = 0;
    const pool = agent.get(ORIGIN);
    pool.intercept({ path: '/once', method: 'GET' }).reply(() => { requests++; return { statusCode: 429, data: 'slow', responseOptions: { headers: { 'retry-after': '0' } } }; });
    pool.intercept({ path: '/once', method: 'GET' }).reply(() => { requests++; return { statusCode: 200, data: { ok: 1 } }; });
    expect(await client().call({ path: '/once' })).toEqual({ ok: 1 });
    expect(requests).toBe(2);
  });

  it('gives up after a second 429 and names the API in the error', async () => {
    const pool = agent.get(ORIGIN);
    pool.intercept({ path: '/twice', method: 'GET' }).reply(429, 'slow');
    pool.intercept({ path: '/twice', method: 'GET' }).reply(429, 'slow');
    pool.intercept({ path: '/twice', method: 'GET' }).reply(200, { never: true });
    await expect(client().call({ path: '/twice' })).rejects.toMatchObject({
      name: 'RateLimited', status: 429, message: expect.stringContaining('Test API is rate limiting this server'),
    });
    // The old behaviour retried 429s three times; the third reply must be left unused.
    expect(agent.pendingInterceptors()).toHaveLength(1);
  });

  it('shares one upstream request between identical concurrent GETs', async () => {
    agent.get(ORIGIN).intercept({ path: '/shared', method: 'GET' }).reply(200, { n: 1 }).delay(30); // only ONE reply
    const c = client({ cacheTtlMs: 60_000, cacheMaxItems: 100 });
    const [a, b] = await Promise.all([c.call({ path: '/shared' }), c.call({ path: '/shared' })]);
    expect(a).toEqual({ n: 1 });
    expect(b).toEqual({ n: 1 });
  });

  it('shares identical concurrent GETs even with the response cache disabled', async () => {
    agent.get(ORIGIN).intercept({ path: '/nocache', method: 'GET' }).reply(200, { n: 1 }).delay(30); // only ONE reply
    const c = client(); // cacheTtlMs: 0, cacheMaxItems: 0
    const [a, b] = await Promise.all([c.call({ path: '/nocache' }), c.call({ path: '/nocache' })]);
    expect(a).toEqual({ n: 1 });
    expect(b).toEqual({ n: 1 });
  });

  it('reads a decimal Retry-After as seconds, not as a date', async () => {
    agent.get(ORIGIN).intercept({ path: '/decimal', method: 'GET' }).reply(429, 'slow', { headers: { 'retry-after': '0.05' } });
    const gate = new UpstreamGate({ concurrency: 4, ratePerSec: 1000, burst: 1000, maxWaitMs: 5000 });
    await expect(client({ gate, retry429: false, maxRetryAfterMs: 5000 }).call({ path: '/decimal' })).rejects.toMatchObject({ status: 429 });
    const started = Date.now();
    (await gate.acquire())();
    expect(Date.now() - started).toBeGreaterThanOrEqual(35);
  });

  it('does not keep a failed shared request: the next call goes upstream again', async () => {
    const pool = agent.get(ORIGIN);
    pool.intercept({ path: '/flaky', method: 'GET' }).reply(404, 'nope');
    pool.intercept({ path: '/flaky', method: 'GET' }).reply(200, { n: 2 });
    const c = client({ cacheTtlMs: 60_000, cacheMaxItems: 100 });
    await expect(c.call({ path: '/flaky' })).rejects.toMatchObject({ status: 404 });
    expect(await c.call({ path: '/flaky' })).toEqual({ n: 2 });
  });

  it('fails fast with RateLimited when no gate slot frees up, without calling upstream', async () => {
    agent.get(ORIGIN).intercept({ path: '/gated', method: 'GET' }).reply(200, {});
    const gate = new UpstreamGate({ concurrency: 1, ratePerSec: 1000, burst: 1000, maxWaitMs: 20 });
    const held = await gate.acquire();
    await expect(client({ gate }).call({ path: '/gated' })).rejects.toMatchObject({
      name: 'RateLimited', message: expect.stringContaining('Test API is busy'),
    });
    expect(agent.pendingInterceptors()).toHaveLength(1);
    held();
  });

  it('pauses the shared gate when upstream returns 429', async () => {
    agent.get(ORIGIN).intercept({ path: '/pause', method: 'GET' }).reply(429, 'slow', { headers: { 'retry-after': '1' } });
    const gate = new UpstreamGate({ concurrency: 4, ratePerSec: 1000, burst: 1000, maxWaitMs: 5000 });
    await expect(client({ gate, retry429: false, maxRetryAfterMs: 60 }).call({ path: '/pause' })).rejects.toMatchObject({ status: 429 });
    const started = Date.now();
    (await gate.acquire())();
    expect(Date.now() - started).toBeGreaterThanOrEqual(45); // paused for the capped Retry-After
  });
});

describe('UpstreamGate', () => {
  it('admits at most `concurrency` holders and hands a slot to the next waiter on release', async () => {
    const gate = new UpstreamGate({ concurrency: 2, ratePerSec: 1000, burst: 1000, maxWaitMs: 1000 });
    const a = await gate.acquire();
    await gate.acquire();
    let third = false;
    const pending = gate.acquire().then(release => { third = true; return release; });
    await new Promise(r => setTimeout(r, 10));
    expect(third).toBe(false);
    a();
    (await pending)();
    expect(third).toBe(true);
  });

  it('resumes at the steady rate after a pause instead of releasing a burst', async () => {
    const gate = new UpstreamGate({ concurrency: 10, ratePerSec: 50, burst: 10, maxWaitMs: 1000 });
    gate.pause(20);
    const started = Date.now();
    for (let i = 0; i < 3; i++) (await gate.acquire())();
    // 20ms pause, then 1 immediately and 2 more at 50/s: at least ~60ms, not ~20ms.
    expect(Date.now() - started).toBeGreaterThanOrEqual(55);
  });

  it('paces starts to ratePerSec once the burst is spent', async () => {
    const gate = new UpstreamGate({ concurrency: 10, ratePerSec: 50, burst: 1, maxWaitMs: 1000 });
    const started = Date.now();
    for (let i = 0; i < 3; i++) (await gate.acquire())();
    // 1 from the burst, then 2 more at 50/s: at least ~40ms.
    expect(Date.now() - started).toBeGreaterThanOrEqual(35);
  });
});
