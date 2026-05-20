import { request, type Dispatcher } from 'undici';
import { LRUCache } from 'lru-cache';
import { log } from './logger.js';

export interface HttpClientOptions {
  baseUrl: string;
  userAgent?: string;
  timeoutMs?: number;
  retries?: number;
  cacheTtlMs?: number;
  cacheMaxItems?: number;
  dispatcher?: Dispatcher;
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
  private readonly cache: LRUCache<string, { status: number; body: unknown; headers: Record<string, string> }>;
  private readonly cacheEnabled: boolean;
  constructor(private readonly opts: HttpClientOptions) {
    const max = opts.cacheMaxItems ?? 2000;
    const ttl = opts.cacheTtlMs ?? 300_000;
    this.cacheEnabled = max > 0 && ttl > 0;
    this.cache = new LRUCache({
      max: Math.max(max, 1),
      ttl: Math.max(ttl, 1),
    });
  }

  async call<T = unknown>(o: CallOptions): Promise<T> {
    const url = this.buildUrl(o.path, o.query);
    const method = o.method ?? 'GET';
    const key = method === 'GET' && this.cacheEnabled ? url : '';
    if (key && this.cache.has(key)) {
      log.debug('http.cache_hit', { url });
      return this.cache.get(key)!.body as T;
    }

    const accept =
      o.accept === 'xml' ? 'application/xml,text/xml'
      : o.accept === 'text' ? 'text/plain'
      : 'application/json';

    const retries = this.opts.retries ?? 3;
    let attempt = 0;
    let lastErr: unknown;
    while (attempt <= retries) {
      try {
        const res = await request(url, {
          method,
          headers: {
            'accept': accept,
            'user-agent': this.opts.userAgent ?? 'fedreg-mcp-server/0.1',
            ...(o.body ? { 'content-type': 'application/json' } : {}),
            ...(o.headers ?? {}),
          },
          body: o.body ? JSON.stringify(o.body) : undefined,
          bodyTimeout: this.opts.timeoutMs ?? 20_000,
          headersTimeout: this.opts.timeoutMs ?? 20_000,
          ...(this.opts.dispatcher ? { dispatcher: this.opts.dispatcher } : {}),
        });

        if (res.statusCode >= 500 || res.statusCode === 429) {
          const text = await res.body.text();
          throw new HttpError(`${method} ${url} -> ${res.statusCode}`, res.statusCode, text);
        }
        if (res.statusCode >= 400) {
          const text = await res.body.text();
          throw new HttpError(`${method} ${url} -> ${res.statusCode}`, res.statusCode, text);
        }

        let body: unknown;
        if (accept.startsWith('application/json')) {
          body = await res.body.json();
        } else {
          body = await res.body.text();
        }
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) headers[k] = Array.isArray(v) ? v.join(',') : String(v ?? '');
        if (key) this.cache.set(key, { status: res.statusCode, body, headers });
        return body as T;
      } catch (err) {
        lastErr = err;
        const status = err instanceof HttpError ? err.status : 0;
        const retryable = status === 0 || status === 429 || status >= 500;
        if (!retryable || attempt === retries) break;
        const delay = Math.min(2 ** attempt * 250, 4000);
        await new Promise(r => setTimeout(r, delay));
        attempt++;
      }
    }
    throw lastErr;
  }

  private buildUrl(path: string, query?: CallOptions['query']): string {
    const base = this.opts.baseUrl.replace(/\/$/, '');
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
