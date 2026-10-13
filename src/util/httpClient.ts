import { request, type Dispatcher } from 'undici';
import { LRUCache } from 'lru-cache';
import { createHash } from 'node:crypto';
import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { log } from './logger.js';

const decompressGzip = promisify(gunzip);

export interface HttpClientOptions {
  baseUrl: string;
  userAgent?: string;
  timeoutMs?: number;
  retries?: number;
  cacheTtlMs?: number;
  cacheMaxItems?: number;
  dispatcher?: Dispatcher;
  defaultHeaders?: Record<string, string>;
  /** Retry an upstream 429 once, after its Retry-After (capped by maxRetryAfterMs). Default true. */
  retry429?: boolean;
  /** Longest a 429's Retry-After may delay a retry or pause the gate. Default 5000. */
  maxRetryAfterMs?: number;
  preflightLimiter?: { tryTake(): boolean; secondsUntilNext?(): number };
  /** Shared per-upstream admission control (see UpstreamGate). */
  gate?: UpstreamGateLike;
  /** Human name of the upstream, used in error messages and logs, e.g. 'Federal Register API'. */
  label?: string;
}

/** What HttpClient needs from an UpstreamGate; injectable for tests. */
export interface UpstreamGateLike { acquire(): Promise<() => void>; pause(ms: number): void }

export interface CallOptions {
  method?: 'GET' | 'POST';
  path: string;
  query?: Record<string, string | number | boolean | string[] | undefined>;
  headers?: Record<string, string>;
  accept?: 'json' | 'xml' | 'text';
  body?: unknown;
}

export class HttpClient {
  #defaultHeaders: Record<string, string>;
  private readonly cache: LRUCache<string, { status: number; body: unknown; headers: Record<string, string> }>;
  private readonly cacheEnabled: boolean;
  private readonly baseUrl: string;
  private readonly userAgent: string;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly retry429: boolean;
  private readonly maxRetryAfterMs: number;
  private readonly dispatcher?: Dispatcher;
  private readonly preflightLimiter?: { tryTake(): boolean; secondsUntilNext?(): number };
  private readonly gate?: UpstreamGateLike;
  private readonly label: string;
  /** Identical GETs already on the wire; later callers share the first one's result. */
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(opts: HttpClientOptions) {
    this.#defaultHeaders = opts.defaultHeaders ?? {};
    this.baseUrl = opts.baseUrl;
    this.userAgent = opts.userAgent ?? 'fedreg-mcp-server/2.0 (+https://github.com/blen-labs/fedreg-mcp-server)';
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.retries = opts.retries ?? 3;
    this.retry429 = opts.retry429 ?? true;
    this.maxRetryAfterMs = opts.maxRetryAfterMs ?? 5000;
    this.dispatcher = opts.dispatcher;
    this.preflightLimiter = opts.preflightLimiter;
    this.gate = opts.gate;
    this.label = opts.label ?? new URL(opts.baseUrl).host;
    const max = opts.cacheMaxItems ?? 2000;
    const ttl = opts.cacheTtlMs ?? 300_000;
    this.cacheEnabled = max > 0 && ttl > 0;
    this.cache = new LRUCache({ max: Math.max(max, 1), ttl: Math.max(ttl, 1) });
  }

  async call<T = unknown>(o: CallOptions): Promise<T> {
    const url = this.buildUrl(o.path, o.query);
    const method = o.method ?? 'GET';
    const key = method === 'GET' ? this.cacheKey(url, o.headers) : '';
    if (key && this.cacheEnabled && this.cache.has(key)) {
      log.debug('http.cache_hit', { url });
      return this.cache.get(key)!.body as T;
    }
    // Join an identical request already on the wire rather than queueing a second one.
    const pending = key ? this.inflight.get(key) : undefined;
    if (pending) return pending as Promise<T>;
    const run = this.fetchWithRetry<T>(url, method, o, key);
    if (key) {
      this.inflight.set(key, run);
      run.then(() => this.inflight.delete(key), () => this.inflight.delete(key));
    }
    return run;
  }

  private async fetchWithRetry<T>(url: string, method: 'GET' | 'POST', o: CallOptions, key: string): Promise<T> {
    const accept =
      o.accept === 'xml' ? 'application/xml,text/xml'
      : o.accept === 'text' ? 'text/plain'
      : 'application/json';

    if (this.preflightLimiter && !this.preflightLimiter.tryTake()) {
      const wait = this.preflightLimiter.secondsUntilNext?.() ?? 0;
      const err = new HttpError(`${method} ${url} -> upstream rate limit reached${Number.isFinite(wait) && wait > 0 ? ` (retry in ~${wait}s)` : ''}`, 429, '');
      err.name = 'RegsRateLimited';
      throw err;
    }

    let attempt = 0;
    let retried429 = false;
    for (;;) {
      try {
        return await this.attempt<T>(url, method, o, accept, key);
      } catch (err) {
        if (err instanceof GateTimeoutError) throw err;
        const status = err instanceof HttpError ? err.status : 0;
        if (status === 429) {
          const pauseMs = Math.min((err as HttpError).retryAfterMs ?? 1000, this.maxRetryAfterMs);
          // Back off every caller of this upstream, not just this one.
          this.gate?.pause(pauseMs);
          if (!this.retry429 || retried429) throw err;
          retried429 = true;
          await new Promise(r => setTimeout(r, pauseMs));
          continue;
        }
        const retryable = status === 0 || status >= 500;
        if (!retryable || attempt === this.retries) throw err;
        const delay = Math.min(2 ** attempt * 250, 4000);
        await new Promise(r => setTimeout(r, delay));
        attempt++;
      }
    }
  }

  /** One request, holding a gate slot only while it is on the wire. */
  private async attempt<T>(url: string, method: 'GET' | 'POST', o: CallOptions, accept: string, key: string): Promise<T> {
    let release: (() => void) | undefined;
    if (this.gate) {
      try {
        release = await this.gate.acquire();
      } catch {
        throw new GateTimeoutError(`${this.label} is busy: too many requests from this server are waiting. Make fewer parallel calls or retry shortly.`);
      }
    }
    try {
      const res = await request(url, {
        method,
        headers: {
          'accept': accept,
          'user-agent': this.userAgent,
          ...this.#defaultHeaders,
          ...(o.body ? { 'content-type': 'application/json' } : {}),
          ...(o.headers ?? {}),
        },
        body: o.body ? JSON.stringify(o.body) : undefined,
        bodyTimeout: this.timeoutMs,
        headersTimeout: this.timeoutMs,
        ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}),
      });

      // undici.request returns raw bytes, unlike fetch. Decode before parsing,
      // reporting upstream errors, or caching the response.
      const encoding = res.headers['content-encoding'];
      const decoded = typeof encoding === 'string' && encoding.trim().toLowerCase() === 'gzip'
        ? new TextDecoder().decode(await decompressGzip(Buffer.from(await res.body.arrayBuffer())))
        : undefined;

      if (res.statusCode >= 400) {
        const text = decoded ?? await res.body.text();
        const err = new HttpError(`${method} ${url} -> ${res.statusCode}`, res.statusCode, text);
        if (res.statusCode === 429) {
          const retryAfter = Array.isArray(res.headers['retry-after']) ? res.headers['retry-after'][0] : res.headers['retry-after'];
          err.name = 'RateLimited';
          err.retryAfterMs = parseRetryAfter(retryAfter);
          err.message = `${this.label} is rate limiting this server: ${method} ${url} -> 429 Too Many Requests${retryAfter ? ` (retry-after ${retryAfter})` : ''}`;
          log.warn('upstream.rate_limited', { source: this.label, host: new URL(url).host, ...(retryAfter ? { retryAfter } : {}) });
        }
        throw err;
      }

      let body: unknown;
      if (accept.startsWith('application/json')) body = decoded === undefined ? await res.body.json() : JSON.parse(decoded);
      else body = decoded ?? await res.body.text();
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(res.headers)) headers[k] = Array.isArray(v) ? v.join(',') : String(v ?? '');
      if (key && this.cacheEnabled) this.cache.set(key, { status: res.statusCode, body, headers });
      return body as T;
    } finally {
      release?.();
    }
  }

  private cacheKey(url: string, perCallHeaders?: Record<string, string>): string {
    const merged = { ...this.#defaultHeaders, ...(perCallHeaders ?? {}) };
    const entries = Object.entries(merged);
    if (entries.length === 0) return url; // fr/ecfr: bare URL key, unchanged
    const normalized: Record<string, string> = {};
    for (const [k, v] of entries.sort(([a], [b]) => a.localeCompare(b))) normalized[k.toLowerCase()] = v;
    const hash = createHash('sha256').update(JSON.stringify(normalized)).digest('hex').slice(0, 16);
    return `${url}\n${hash}`;
  }

  private buildUrl(path: string, query?: CallOptions['query']): string {
    const base = this.baseUrl.replace(/\/$/, '');
    const p = path.startsWith('/') ? path : '/' + path;
    const url = new URL(base + p);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null) continue;
        if (Array.isArray(v)) for (const item of v) url.searchParams.append(k, String(item));
        else url.searchParams.append(k, String(v));
      }
    }
    return url.toString();
  }
}

/** Retry-After as milliseconds: delta-seconds or an HTTP date; undefined if absent or invalid. */
function parseRetryAfter(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const v = value.trim();
  // Check numerics first: Date.parse('1.5') is a valid date in V8 (2001), not 1.5 seconds.
  if (/^\d+(\.\d+)?$/.test(v)) return Number(v) * 1000;
  if (/^[\d.]+$/.test(v)) return undefined;
  const at = Date.parse(v);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

export class HttpError extends Error {
  retryAfterMs?: number;
  constructor(message: string, public readonly status: number, public readonly bodySnippet: string) {
    super(message);
    this.name = 'HttpError';
  }
}

/** No gate slot freed up within maxWaitMs. Never retried: the queue is already full. */
class GateTimeoutError extends HttpError {
  constructor(message: string) {
    super(message, 429, '');
    this.name = 'RateLimited';
  }
}
