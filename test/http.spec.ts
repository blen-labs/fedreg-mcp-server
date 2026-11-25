import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MockAgent } from 'undici';
import { gzipSync } from 'node:zlib';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { IpRateLimiter, clientIp, bucketKey } from '../src/server/ipRateLimiter.js';
import { SubjectQuota } from '../src/util/quotas.js';
import { HttpClient, type HttpError, ResponseTooLargeError, DEFAULT_MAX_RESPONSE_BYTES } from '../src/util/httpClient.js';
import { ECFR_MAX_RESPONSE_BYTES, createEcfrSource } from '../src/sdk/sources/ecfr.js';
import { createFrSource } from '../src/sdk/sources/fr.js';
import { UpstreamGate } from '../src/util/upstreamGate.js';
import { ExecutionLimiter } from '../src/util/executionLimiter.js';
import { runWithSignal } from '../src/util/executionContext.js';

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

  it('awaits an async preflight limiter: a denial blocks the request, cache hits skip it', async () => {
    let takes = 0;
    let allow = true;
    const limiter = { tryTake: async () => { takes++; return allow; } };
    agent.get(ORIGIN).intercept({ path: '/v4/a', method: 'GET' }).reply(200, { n: 1 }); // ONE interceptor
    const c = client({ cacheTtlMs: 60_000, cacheMaxItems: 100, preflightLimiter: limiter });
    await expect(c.call({ path: '/v4/a' })).resolves.toEqual({ n: 1 });
    await expect(c.call({ path: '/v4/a' })).resolves.toEqual({ n: 1 }); // cache hit, no take
    allow = false;
    await expect(c.call({ path: '/v4/other' })).rejects.toMatchObject({ name: 'RegsRateLimited', status: 429 });
    expect(takes).toBe(2);
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
  it('uses only a literal address from the trusted header, and unwraps IPv4-mapped IPv6', () => {
    expect(clientIp(req('100.64.0.2', { 'x-real-ip': 'not-an-ip' }), 'x-real-ip')).toBe('100.64.0.2');
    expect(clientIp(req('100.64.0.2', { 'x-real-ip': '::ffff:192.0.2.9' }), 'x-real-ip')).toBe('192.0.2.9');
    expect(clientIp(req('100.64.0.2', { 'x-real-ip': '::ffff:c000:209' }), 'x-real-ip')).toBe('192.0.2.9');
    expect(clientIp(req('100.64.0.2', { 'x-real-ip': '2001:db8::1' }), 'x-real-ip')).toBe('2001:db8::1');
  });
});

describe('IPv6 bucketing', () => {
  it('maps every address of a /64 to one key, in any notation', () => {
    const key = '2001:db8:1:2::/64';
    for (const ip of ['2001:db8:1:2::1', '2001:DB8:1:2:ffff:ffff:ffff:ffff', '2001:0db8:0001:0002:0:0:0:5', '2001:db8:1:2::', '2001:db8:1:2:3::9', '2001:db8:1:2::1%eth0'])
      expect(bucketKey(ip), ip).toBe(key);
    expect(bucketKey('2001:db8:1:3::1')).not.toBe(key);
    expect(bucketKey('::1')).toBe('0:0:0:0::/64');
  });
  it('leaves IPv4, and IPv4-mapped IPv6, as the IPv4 address', () => {
    expect(bucketKey('192.0.2.9')).toBe('192.0.2.9');
    expect(bucketKey('::ffff:192.0.2.9')).toBe('192.0.2.9');
    expect(bucketKey('::ffff:c000:209')).toBe('192.0.2.9');
    expect(bucketKey('unknown')).toBe('unknown');
  });
  it('shares one limiter bucket across a /64 and counts available/spend without spending on a check', () => {
    const lim = new IpRateLimiter(0.001, 3);
    expect(lim.allow('2001:db8:9:9::1')).toBe(true);
    expect(lim.allow('2001:db8:9:9:aaaa::2')).toBe(true);
    expect(lim.available('2001:db8:9:9::3')).toBe(true);
    expect(lim.available('2001:db8:9:9::3')).toBe(true); // a check spends nothing
    lim.spend('2001:db8:9:9::4');
    expect(lim.available('2001:db8:9:9::5')).toBe(false);
    expect(lim.allow('2001:db8:9:9::6')).toBe(false);
    expect(lim.allow('2001:db8:9:8::1')).toBe(true); // another /64
    lim.spend('198.51.100.1'); lim.spend('198.51.100.1'); lim.spend('198.51.100.1'); lim.spend('198.51.100.1');
    expect(lim.available('198.51.100.1')).toBe(false);
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

describe('HttpClient cancellation', () => {
  let agent: MockAgent;
  const ORIGIN = 'https://api.example.gov';
  beforeEach(() => { agent = new MockAgent(); agent.disableNetConnect(); });
  afterEach(async () => { await agent.close(); });
  const client = (extra: Record<string, unknown> = {}) => new HttpClient({ baseUrl: ORIGIN, dispatcher: agent, retries: 0, cacheTtlMs: 0, cacheMaxItems: 0, ...extra });

  // undici 6's MockAgent ignores an abort during a mocked delay, so these use a real loopback
  // server that never answers /slow and records when its connection is torn down.
  async function hangingServer() {
    let dropped = 0;
    const server = createServer((req, res) => {
      if (req.url === '/slow') { res.on('close', () => { dropped++; }); return; }
      res.setHeader('content-type', 'application/json').end('{"next":true}');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return {
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      /** Resolves once `n` connections have been torn down by the client, or fails after 2 s. */
      async dropped(n: number) { for (let i = 0; i < 40 && dropped < n; i++) await new Promise(r => setTimeout(r, 50)); return dropped; },
      close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }),
    };
  }

  it('aborts the upstream request and frees the gate slot when the caller aborts', async () => {
    const up = await hangingServer();
    try {
      const gate = new UpstreamGate({ concurrency: 1, ratePerSec: 1000, burst: 1, maxWaitMs: 5000 });
      const c = new HttpClient({ baseUrl: up.baseUrl, retries: 0, cacheTtlMs: 0, cacheMaxItems: 0, gate });
      const controller = new AbortController();
      const slow = c.call({ path: '/slow', signal: controller.signal });
      setTimeout(() => controller.abort(), 50);
      await expect(slow).rejects.toMatchObject({ name: 'AbortError' });
      expect(await c.call({ path: '/next' })).toEqual({ next: true });
      expect(await up.dropped(1)).toBe(1);
    } finally { await up.close(); }
  });

  it('uses the execution signal from AsyncLocalStorage, and refuses to start when it is already aborted', async () => {
    const up = await hangingServer();
    try {
      const c = new HttpClient({ baseUrl: up.baseUrl, retries: 0, cacheTtlMs: 0, cacheMaxItems: 0 });
      const controller = new AbortController();
      const slow = runWithSignal(controller.signal, () => c.call({ path: '/slow' }));
      setTimeout(() => controller.abort(), 50);
      await expect(slow).rejects.toMatchObject({ name: 'AbortError' });
      expect(await up.dropped(1)).toBe(1);
      await expect(runWithSignal(controller.signal, () => c.call({ path: '/next' }))).rejects.toMatchObject({ name: 'AbortError' });
    } finally { await up.close(); }
  });

  it('stops a call that is queued behind the gate', async () => {
    // A gate that never admits: the call must hand it the abort signal so the queued wait ends.
    let received: AbortSignal | undefined;
    const gate = {
      acquire: (signal?: AbortSignal) => new Promise<() => void>((_, reject) => {
        received = signal;
        signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
      }),
      pause: () => {},
    };
    const c = client({ gate });
    const controller = new AbortController();
    const queued = c.call({ path: '/queued', signal: controller.signal });
    setTimeout(() => controller.abort(), 30);
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    expect(received?.aborted).toBe(true);
  });

  it('removes an aborted waiter from the real gate queue', async () => {
    const gate = new UpstreamGate({ concurrency: 1, ratePerSec: 1000, burst: 1000, maxWaitMs: 5000 });
    const held = await gate.acquire();
    const controller = new AbortController();
    const waiting = gate.acquire(controller.signal);
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    held();
    // The aborted waiter is gone, so it does not take the freed slot.
    let second = false;
    const next = gate.acquire().then(r => { second = true; return r; });
    await new Promise(r => setTimeout(r, 10));
    expect(second).toBe(true);
    (await next)();
  });

  it('stops waiting out a retry backoff', async () => {
    agent.get(ORIGIN).intercept({ path: '/flaky', method: 'GET' }).reply(503, '').times(3);
    const c = client({ retries: 2 });
    const controller = new AbortController();
    const t0 = Date.now();
    const call = c.call({ path: '/flaky', signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await expect(call).rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - t0).toBeLessThan(200);
  });

  it('keeps a shared in-flight request alive while another caller still waits on it', async () => {
    agent.get(ORIGIN).intercept({ path: '/shared', method: 'GET' }).reply(200, { shared: true }).delay(100);
    const c = client({ cacheTtlMs: 60_000, cacheMaxItems: 10 });
    const controller = new AbortController();
    const first = c.call({ path: '/shared', signal: controller.signal });
    const second = c.call({ path: '/shared' });
    controller.abort();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    expect(await second).toEqual({ shared: true });
  });
});

describe('ExecutionLimiter', () => {
  it('caps executions globally and per subject, and releases once', () => {
    const lim = new ExecutionLimiter(3, 2);
    const a1 = lim.tryAcquire('a'), a2 = lim.tryAcquire('a');
    expect('release' in a1 && 'release' in a2).toBe(true);
    expect(lim.tryAcquire('a')).toMatchObject({ error: expect.stringMatching(/already have 2/) });
    lim.tryAcquire('b');
    expect(lim.tryAcquire('c')).toMatchObject({ error: expect.stringMatching(/maximum of 3/) });
    if ('release' in a1) { a1.release(); a1.release(); }
    expect('release' in lim.tryAcquire('c')).toBe(true);
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

describe('HttpClient upstream I/O budgets', () => {
  let agent: MockAgent;
  const ORIGIN = 'https://api.example.gov';
  const MB = 1024 * 1024;
  beforeEach(() => { agent = new MockAgent(); agent.disableNetConnect(); });
  afterEach(async () => { await agent.close(); });
  const fail = (p: Promise<unknown>) => p.then(() => { throw new Error('expected a rejection'); }, (e: unknown) => e as HttpError);
  const client = (extra: Record<string, unknown> = {}) =>
    new HttpClient({ baseUrl: ORIGIN, dispatcher: agent, retries: 2, cacheTtlMs: 0, cacheMaxItems: 0, ...extra });

  it('fails explicitly, without retrying, when a plain body exceeds the budget', async () => {
    agent.get(ORIGIN).intercept({ path: '/big', method: 'GET' }).reply(200, 'x'.repeat(2 * MB));
    const err = await fail(client({ maxResponseBytes: MB }).call({ path: '/big' }));
    expect(err).toBeInstanceOf(ResponseTooLargeError);
    expect(err).toMatchObject({ name: 'ResponseTooLarge' });
    expect(err.message).toMatch(/more than 1 MB/);
    // A retry would have hit MockAgent's "no interceptor" error instead.
    expect(err.message).not.toMatch(/Mock/i);
  });

  it('bounds gzip expansion, not just the compressed size (a small body that inflates past the budget)', async () => {
    const bomb = gzipSync(Buffer.alloc(50 * MB, 0x78));
    expect(bomb.length).toBeLessThan(MB);
    agent.get(ORIGIN).intercept({ path: '/bomb.xml', method: 'GET' }).reply(200, bomb, { headers: { 'content-encoding': 'gzip' } });
    await expect(client({ maxResponseBytes: 4 * MB }).call({ path: '/bomb.xml', accept: 'xml' })).rejects.toBeInstanceOf(ResponseTooLargeError);
  });

  it('bounds the compressed size on the wire too', async () => {
    agent.get(ORIGIN).intercept({ path: '/wire.xml', method: 'GET' })
      .reply(200, Buffer.from('z'.repeat(3 * MB)), { headers: { 'content-encoding': 'gzip' } });
    await expect(client({ maxResponseBytes: MB }).call({ path: '/wire.xml', accept: 'xml' })).rejects.toBeInstanceOf(ResponseTooLargeError);
  });

  it('never truncates a body within the budget, byte for byte', async () => {
    const xml = '<P>' + 'é§—'.repeat(2 * MB) + '</P>';
    agent.get(ORIGIN).intercept({ path: '/ok.xml', method: 'GET' }).reply(200, gzipSync(xml), { headers: { 'content-encoding': 'gzip' } });
    const out = await client({ maxResponseBytes: 16 * MB }).call<string>({ path: '/ok.xml', accept: 'xml' });
    expect(out.length).toBe(xml.length);
    expect(out === xml).toBe(true);
  });

  it('keeps legitimate large eCFR documents working through the real source, while the Federal Register source refuses the same size', async () => {
    // Title 40 is about 157 MB decompressed; a 20 MB slice (over the 16 MiB default) stands in for it.
    const xml = '<DIV>' + 'a'.repeat(20 * MB) + '</DIV>';
    expect(ECFR_MAX_RESPONSE_BYTES).toBeGreaterThan(160 * MB);
    expect(20 * MB).toBeGreaterThan(DEFAULT_MAX_RESPONSE_BYTES);
    const cfg = { frBaseUrl: `${ORIGIN}/fr`, ecfrBaseUrl: `${ORIGIN}/ecfr`, regsBaseUrl: ORIGIN, userAgent: 't', timeoutMs: 20_000, retries: 0, cacheTtlMs: 0, cacheMaxItems: 0, dispatcher: agent };
    const up = agent.get(ORIGIN);
    up.intercept({ path: '/ecfr/versioner/v1/full/2026-10-01/title-40.xml', method: 'GET' }).reply(200, gzipSync(xml), { headers: { 'content-encoding': 'gzip' } });
    const full = createEcfrSource(cfg).methods.full as (date: string, title: number) => Promise<string>;
    expect((await full('2026-10-01', 40)) === xml).toBe(true);
    up.intercept({ path: p => p.startsWith('/fr/documents.json'), method: 'GET' }).reply(200, gzipSync(JSON.stringify({ pad: 'a'.repeat(20 * MB) })), { headers: { 'content-encoding': 'gzip' } });
    const search = createFrSource(cfg).methods['documents.search'] as (params: object) => Promise<unknown>;
    await expect(search({})).rejects.toBeInstanceOf(ResponseTooLargeError);
  });

  it('caches within a byte budget: small responses are served from cache, one larger than the cache is not cached', async () => {
    const up = agent.get(ORIGIN);
    up.intercept({ path: '/small', method: 'GET' }).reply(200, { n: 1 });
    up.intercept({ path: '/huge', method: 'GET' }).reply(200, 'h'.repeat(3000)).times(2);
    const c = client({ cacheTtlMs: 60_000, cacheMaxItems: 100, cacheMaxBytes: 4096, retries: 0 });
    expect(await c.call({ path: '/small' })).toEqual({ n: 1 });
    expect(await c.call({ path: '/small' })).toEqual({ n: 1 }); // second intercept absent: cache hit
    // 3000 chars is ~6000 bytes of memory: over the whole budget, so every call goes upstream.
    expect(await c.call<string>({ path: '/huge', accept: 'text' })).toHaveLength(3000);
    expect(await c.call<string>({ path: '/huge', accept: 'text' })).toHaveLength(3000);
  });

  it('evicts older entries to stay within the total cache bytes', async () => {
    const up = agent.get(ORIGIN);
    for (const p of ['/a', '/b', '/a']) up.intercept({ path: p, method: 'GET' }).reply(200, 'q'.repeat(1500));
    const c = client({ cacheTtlMs: 60_000, cacheMaxItems: 100, cacheMaxBytes: 4096, retries: 0 });
    await c.call({ path: '/a', accept: 'text' });
    await c.call({ path: '/b', accept: 'text' }); // 2 x 3000 estimated bytes > 4096: /a is evicted
    await c.call({ path: '/a', accept: 'text' }); // needs its own upstream call again
    await agent.assertNoPendingInterceptors();
  });

  it('redacts configured credentials from error bodies, messages and decoded JSON, keys included', async () => {
    const SECRET = 'sk-live-0123456789abcdef';
    const up = agent.get(ORIGIN);
    up.intercept({ path: '/err', method: 'GET' }).reply(403, `denied for ${SECRET}`);
    up.intercept({ path: '/err-gz', method: 'GET' }).reply(500, gzipSync(`boom ${SECRET}`), { headers: { 'content-encoding': 'gzip' } });
    up.intercept({ path: '/rl', method: 'GET' }).reply(429, 'slow', { headers: { 'retry-after': `${SECRET}` } });
    up.intercept({ path: '/ok', method: 'GET' }).reply(200, { echo: SECRET, nested: [{ [SECRET]: `k=${SECRET}` }], escaped: SECRET.replace('-', '\u002d') });
    const c = client({ defaultHeaders: { 'X-Api-Key': SECRET }, retries: 0, retry429: false });
    const e1 = await fail(c.call({ path: '/err' }));
    expect(e1.bodySnippet).toBe('denied for [REDACTED]');
    const e2 = await fail(c.call({ path: '/err-gz' }));
    expect(e2.bodySnippet).toBe('boom [REDACTED]');
    const e3 = await fail(c.call({ path: '/rl' }));
    expect(JSON.stringify([e1.message, e2.message, e3.message, e3.bodySnippet])).not.toContain(SECRET);
    const ok = await c.call({ path: '/ok' });
    expect(JSON.stringify(ok)).not.toContain(SECRET);
    expect(ok).toMatchObject({ echo: '[REDACTED]', nested: [{ '[REDACTED]': 'k=[REDACTED]' }] });
  });

  it('truncates only error bodies, and survives a gzip error body it cannot decode', async () => {
    const up = agent.get(ORIGIN);
    up.intercept({ path: '/e1', method: 'GET' }).reply(500, 'e'.repeat(300_000));
    up.intercept({ path: '/e2', method: 'GET' }).reply(502, 'not gzip at all', { headers: { 'content-encoding': 'gzip' } });
    const c = client({ retries: 0 });
    const e1 = await fail(c.call({ path: '/e1' }));
    expect(e1).toMatchObject({ status: 500 });
    expect(e1.bodySnippet.length).toBeLessThanOrEqual(64 * 1024);
    const e2 = await fail(c.call({ path: '/e2' }));
    expect(e2).toMatchObject({ name: 'HttpError', status: 502, bodySnippet: '' });
  });
});
