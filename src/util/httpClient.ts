import { request, type Dispatcher } from 'undici';
import { LRUCache } from 'lru-cache';
import { createHash } from 'node:crypto';
import { log } from './logger.js';

export interface HttpClientOptions {
  baseUrl: string;
  userAgent?: string;
  timeoutMs?: number;
  retries?: number;
  cacheTtlMs?: number;
  cacheMaxItems?: number;
  dispatcher?: Dispatcher;
  defaultHeaders?: Record<string, string>;
  retry429?: boolean;
}

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
  private readonly dispatcher?: Dispatcher;

  constructor(opts: HttpClientOptions) {
    this.#defaultHeaders = opts.defaultHeaders ?? {};
    this.baseUrl = opts.baseUrl;
    this.userAgent = opts.userAgent ?? 'fedreg-mcp-server/1.0 (+https://github.com/blen-labs/fedreg-mcp-server)';
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.retries = opts.retries ?? 3;
    this.retry429 = opts.retry429 ?? true;
    this.dispatcher = opts.dispatcher;
    const max = opts.cacheMaxItems ?? 2000;
    const ttl = opts.cacheTtlMs ?? 300_000;
    this.cacheEnabled = max > 0 && ttl > 0;
    this.cache = new LRUCache({ max: Math.max(max, 1), ttl: Math.max(ttl, 1) });
  }

  async call<T = unknown>(o: CallOptions): Promise<T> {
    const url = this.buildUrl(o.path, o.query);
    const method = o.method ?? 'GET';
    const key = method === 'GET' && this.cacheEnabled ? this.cacheKey(url, o.headers) : '';
    if (key && this.cache.has(key)) {
      log.debug('http.cache_hit', { url });
      return this.cache.get(key)!.body as T;
    }

    const accept =
      o.accept === 'xml' ? 'application/xml,text/xml'
      : o.accept === 'text' ? 'text/plain'
      : 'application/json';

    let attempt = 0;
    let lastErr: unknown;
    while (attempt <= this.retries) {
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

        if (res.statusCode >= 400) {
          const text = await res.body.text();
          const err = new HttpError(`${method} ${url} -> ${res.statusCode}`, res.statusCode, text);
          if (res.statusCode === 429) {
            const retryAfter = Array.isArray(res.headers['retry-after']) ? res.headers['retry-after'][0] : res.headers['retry-after'];
            err.name = 'RateLimited';
            err.message = `${method} ${url} -> 429 Too Many Requests${retryAfter ? ` (retry-after ${retryAfter})` : ''}`;
          }
          throw err;
        }

        let body: unknown;
        if (accept.startsWith('application/json')) body = await res.body.json();
        else body = await res.body.text();
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) headers[k] = Array.isArray(v) ? v.join(',') : String(v ?? '');
        if (key) this.cache.set(key, { status: res.statusCode, body, headers });
        return body as T;
      } catch (err) {
        lastErr = err;
        const status = err instanceof HttpError ? err.status : 0;
        const retryable = status === 0 || (status === 429 && this.retry429) || status >= 500;
        if (!retryable || attempt === this.retries) break;
        const delay = Math.min(2 ** attempt * 250, 4000);
        await new Promise(r => setTimeout(r, delay));
        attempt++;
      }
    }
    throw lastErr;
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

export class HttpError extends Error {
  constructor(message: string, public readonly status: number, public readonly bodySnippet: string) {
    super(message);
    this.name = 'HttpError';
  }
}
