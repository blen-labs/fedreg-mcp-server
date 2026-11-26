import { request, type Dispatcher } from 'undici';
import { LRUCache } from 'lru-cache';
import { createHash } from 'node:crypto';
import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { log } from './logger.js';
import { abortError, currentSignal, sleep } from './executionContext.js';

const decompressGzip = promisify(gunzip) as (buf: Buffer, opts: { maxOutputLength: number }) => Promise<Buffer>;

/**
 * Largest upstream response body kept in memory (after decompression), by default. Federal
 * Register and regulations.gov responses are JSON pages of a few MB at most; eCFR full-text
 * XML can be much larger and its source raises this (see ECFR_MAX_RESPONSE_BYTES).
 */
export const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
/** Default cap on the summed size of cached response bodies, per client. */
export const DEFAULT_CACHE_MAX_BYTES = 64 * 1024 * 1024;
/** Error bodies are only used for a short message; never buffer more than this of one. */
const ERROR_BODY_BYTES = 64 * 1024;

export interface HttpClientOptions {
  baseUrl: string;
  userAgent?: string;
  timeoutMs?: number;
  retries?: number;
  cacheTtlMs?: number;
  cacheMaxItems?: number;
  /** Upper bound on the summed estimated memory of cached response bodies. Default 64 MiB; a response bigger than this is not cached. */
  cacheMaxBytes?: number;
  /**
   * Largest response body accepted, measured on the wire (compressed) and again after gzip
   * decompression. Bigger bodies fail with ResponseTooLarge; they are never truncated. Default 16 MiB.
   */
  maxResponseBytes?: number;
  dispatcher?: Dispatcher;
  defaultHeaders?: Record<string, string>;
  /** Retry an upstream 429 once, after its Retry-After (capped by maxRetryAfterMs). Default true. */
  retry429?: boolean;
  /** Longest a 429's Retry-After may delay a retry or pause the gate. Default 5000. */
  maxRetryAfterMs?: number;
  preflightLimiter?: PreflightLimiter;
  /** Shared per-upstream admission control (see UpstreamGate). */
  gate?: UpstreamGateLike;
  /** Human name of the upstream, used in error messages and logs, e.g. 'Federal Register API'. */
  label?: string;
}

/**
 * Admission check run after the cache and in-flight dedupe, once per upstream request (not per
 * retry). May be async, e.g. account mode's per-account limit kept in PostgreSQL.
 */
export interface PreflightLimiter { tryTake(): boolean | Promise<boolean>; secondsUntilNext?(): number }

/** What HttpClient needs from an UpstreamGate; injectable for tests. */
export interface UpstreamGateLike { acquire(signal?: AbortSignal): Promise<() => void>; pause(ms: number): void }

export interface CallOptions {
  method?: 'GET' | 'POST';
  path: string;
  query?: Record<string, string | number | boolean | string[] | undefined>;
  headers?: Record<string, string>;
  accept?: 'json' | 'xml' | 'text';
  body?: unknown;
  /** Abort the request (and any wait for a slot). Defaults to the current execution's signal. */
  signal?: AbortSignal;
}

interface InflightEntry { promise: Promise<unknown>; controller: AbortController; waiters: number; forget?: () => void }

export class HttpClient {
  #defaultHeaders: Record<string, string>;
  private readonly cache: LRUCache<string, { status: number; body: unknown; headers: Record<string, string>; size: number }>;
  private readonly cacheEnabled: boolean;
  private readonly baseUrl: string;
  private readonly userAgent: string;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly retry429: boolean;
  private readonly maxRetryAfterMs: number;
  private readonly maxResponseBytes: number;
  /** Credential values from defaultHeaders, scrubbed from every upstream body and error. */
  readonly #secrets: string[];
  private readonly dispatcher?: Dispatcher;
  private readonly preflightLimiter?: PreflightLimiter;
  private readonly gate?: UpstreamGateLike;
  private readonly label: string;
  /** Identical GETs already on the wire; later callers share the first one's result. */
  private readonly inflight = new Map<string, InflightEntry>();

  constructor(opts: HttpClientOptions) {
    this.#defaultHeaders = opts.defaultHeaders ?? {};
    this.#secrets = Object.values(this.#defaultHeaders).filter(v => typeof v === 'string' && v.length >= 8);
    this.baseUrl = opts.baseUrl;
    this.userAgent = opts.userAgent ?? 'fedreg-mcp-server/2.0 (+https://github.com/blen-labs/fedreg-mcp-server)';
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.retries = opts.retries ?? 3;
    this.retry429 = opts.retry429 ?? true;
    this.maxRetryAfterMs = opts.maxRetryAfterMs ?? 5000;
    this.maxResponseBytes = Math.max(opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES, 1024);
    this.dispatcher = opts.dispatcher;
    this.preflightLimiter = opts.preflightLimiter;
    this.gate = opts.gate;
    this.label = opts.label ?? new URL(opts.baseUrl).host;
    const max = opts.cacheMaxItems ?? 2000;
    const ttl = opts.cacheTtlMs ?? 300_000;
    this.cacheEnabled = max > 0 && ttl > 0;
    const maxBytes = Math.max(opts.cacheMaxBytes ?? DEFAULT_CACHE_MAX_BYTES, 1024);
    this.cache = new LRUCache({
      max: Math.max(max, 1), ttl: Math.max(ttl, 1),
      // A response bigger than the whole cache is simply not cached.
      maxSize: maxBytes, maxEntrySize: maxBytes, sizeCalculation: v => Math.max(1, v.size),
    });
  }

  async call<T = unknown>(o: CallOptions): Promise<T> {
    const url = this.buildUrl(o.path, o.query);
    const method = o.method ?? 'GET';
    const key = method === 'GET' ? this.cacheKey(url, o.headers) : '';
    if (key && this.cacheEnabled && this.cache.has(key)) {
      log.debug('http.cache_hit', { url });
      return this.cache.get(key)!.body as T;
    }
    const signal = o.signal ?? currentSignal();
    if (signal?.aborted) throw abortError();
    if (!key) return this.fetchWithRetry<T>(url, method, o, key, signal);
    // Join an identical request already on the wire rather than queueing a second one.
    let entry = this.inflight.get(key);
    if (!entry) {
      const controller = new AbortController();
      const promise = this.fetchWithRetry<T>(url, method, o, key, controller.signal);
      const created: InflightEntry = { promise, controller, waiters: 0 };
      const forget = () => { if (this.inflight.get(key) === created) this.inflight.delete(key); };
      created.forget = forget;
      entry = created;
      promise.then(forget, forget);
      promise.catch(() => { /* each waiter observes the rejection itself */ });
      this.inflight.set(key, created);
    }
    return this.wait<T>(entry, signal);
  }

  /** One caller's view of a shared request: it may abort its own wait without failing others. */
  private wait<T>(entry: InflightEntry, signal?: AbortSignal): Promise<T> {
    entry.waiters++;
    if (!signal) return entry.promise.finally(() => { entry.waiters--; }) as Promise<T>;
    return new Promise<T>((resolve, reject) => {
      let done = false;
      const finish = () => { if (done) return false; done = true; entry.waiters--; signal.removeEventListener('abort', onAbort); return true; };
      const onAbort = () => {
        if (!finish()) return;
        // Once nobody waits, the shared request is dying: later identical calls must start their own.
        if (entry.waiters === 0) { entry.forget?.(); entry.controller.abort(); }
        reject(abortError());
      };
      signal.addEventListener('abort', onAbort, { once: true });
      entry.promise.then(v => { if (finish()) resolve(v as T); }, e => { if (finish()) reject(e); });
    });
  }

  private async fetchWithRetry<T>(url: string, method: 'GET' | 'POST', o: CallOptions, key: string, signal?: AbortSignal): Promise<T> {
    const accept =
      o.accept === 'xml' ? 'application/xml,text/xml'
      : o.accept === 'text' ? 'text/plain'
      : 'application/json';

    if (signal?.aborted) throw abortError();
    if (this.preflightLimiter && !(await this.preflightLimiter.tryTake())) {
      const wait = this.preflightLimiter.secondsUntilNext?.() ?? 0;
      const err = new HttpError(`${method} ${url} -> upstream rate limit reached${Number.isFinite(wait) && wait > 0 ? ` (retry in ~${wait}s)` : ''}`, 429, '');
      err.name = 'RegsRateLimited';
      throw err;
    }

    let attempt = 0;
    let retried429 = false;
    for (;;) {
      try {
        return await this.attempt<T>(url, method, o, accept, key, signal);
      } catch (err) {
        if (err instanceof GateTimeoutError || err instanceof ResponseTooLargeError || (err as Error)?.name === 'AbortError') throw err;
        const status = err instanceof HttpError ? err.status : 0;
        if (status === 429) {
          const pauseMs = Math.min((err as HttpError).retryAfterMs ?? 1000, this.maxRetryAfterMs);
          // Back off every caller of this upstream, not just this one.
          this.gate?.pause(pauseMs);
          if (!this.retry429 || retried429) throw err;
          retried429 = true;
          await sleep(pauseMs, signal);
          continue;
        }
        const retryable = status === 0 || status >= 500;
        if (!retryable || attempt === this.retries) throw err;
        const delay = Math.min(2 ** attempt * 250, 4000);
        await sleep(delay, signal);
        attempt++;
      }
    }
  }

  /** One request, holding a gate slot only while it is on the wire. */
  private async attempt<T>(url: string, method: 'GET' | 'POST', o: CallOptions, accept: string, key: string, signal?: AbortSignal): Promise<T> {
    let release: (() => void) | undefined;
    if (this.gate) {
      try {
        release = await this.gate.acquire(signal);
      } catch (err) {
        if ((err as { name?: string })?.name === 'AbortError') throw abortError();
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
        ...(signal ? { signal } : {}),
        ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}),
      });

      // undici.request returns raw bytes, unlike fetch. Bound the body on the wire, then bound
      // its decompressed size, before parsing, reporting upstream errors, or caching it.
      const failed = res.statusCode >= 400;
      const limit = failed ? Math.min(this.maxResponseBytes, ERROR_BODY_BYTES) : this.maxResponseBytes;
      const what = `${method} ${url}`;
      const raw = await readCapped(res.body, res.headers['content-length'], limit, what, this.maxResponseBytes, failed);
      const encoding = res.headers['content-encoding'];
      let bytes = raw;
      let text: string;
      if (failed) {
        // An error body only feeds a short message: a truncated or undecodable one is just empty.
        try {
          if (typeof encoding === 'string' && encoding.trim().toLowerCase() === 'gzip') bytes = await decompressGzip(raw, { maxOutputLength: limit });
        } catch { bytes = Buffer.alloc(0); }
        text = this.redact(new TextDecoder().decode(bytes.length > limit ? bytes.subarray(0, limit) : bytes));
      } else {
        if (typeof encoding === 'string' && encoding.trim().toLowerCase() === 'gzip') {
          // Bound the expansion itself, not just the compressed size.
          try { bytes = await decompressGzip(raw, { maxOutputLength: limit + 1 }); }
          catch (err) {
            if ((err as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') throw new ResponseTooLargeError(what, this.maxResponseBytes);
            throw err;
          }
        }
        if (bytes.length > limit) throw new ResponseTooLargeError(what, this.maxResponseBytes);
        text = this.redact(new TextDecoder().decode(bytes));
      }

      if (failed) {
        const err = new HttpError(`${method} ${url} -> ${res.statusCode}`, res.statusCode, text);
        if (res.statusCode === 429) {
          const rawRetryAfter = Array.isArray(res.headers['retry-after']) ? res.headers['retry-after'][0] : res.headers['retry-after'];
          // Header text is upstream-controlled: scrub and bound it before it reaches logs or errors.
          const retryAfter = rawRetryAfter === undefined ? undefined : this.redact(String(rawRetryAfter)).slice(0, 64);
          err.name = 'RateLimited';
          err.retryAfterMs = parseRetryAfter(rawRetryAfter);
          err.message = `${this.label} is rate limiting this server: ${method} ${url} -> 429 Too Many Requests${retryAfter ? ` (retry-after ${retryAfter})` : ''}`;
          log.warn('upstream.rate_limited', { source: this.label, host: new URL(url).host, ...(retryAfter ? { retryAfter } : {}) });
        }
        err.message = this.redact(err.message);
        throw err;
      }

      let body: unknown;
      if (accept.startsWith('application/json')) {
        // Redact again after decoding: JSON escapes can spell a credential the raw scan missed.
        body = this.redactValue(JSON.parse(text));
      } else body = text;
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(res.headers)) headers[k] = Array.isArray(v) ? v.join(',') : String(v ?? '');
      // UTF-16 code units are two bytes each; the parsed value is charged at least as much.
      if (key && this.cacheEnabled) this.cache.set(key, { status: res.statusCode, body, headers, size: text.length * 2 });
      return body as T;
    } catch (err) {
      if (signal?.aborted) throw abortError();
      throw err;
    } finally {
      release?.();
    }
  }

  /** Deep redaction of a decoded JSON value, including object keys. */
  private redactValue(value: unknown): unknown {
    if (!this.#secrets.length) return value;
    if (typeof value === 'string') return this.redact(value);
    if (Array.isArray(value)) return value.map(v => this.redactValue(v));
    if (value && typeof value === 'object')
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [this.redact(k), this.redactValue(v)]));
    return value;
  }

  /** Replace any configured credential that an upstream echoes back. */
  private redact(text: string): string {
    let out = text;
    for (const secret of this.#secrets) if (out.includes(secret)) out = out.split(secret).join('[REDACTED]');
    return out;
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

/** Read a response body, failing fast once it exceeds `limit` bytes. */
async function readCapped(
  body: AsyncIterable<Uint8Array> & { destroy?: (err?: Error) => void },
  contentLength: string | string[] | undefined,
  limit: number,
  what: string,
  reportedMax: number,
  isError: boolean,
): Promise<Buffer> {
  const declared = Number(Array.isArray(contentLength) ? contentLength[0] : contentLength);
  if (!isError && Number.isFinite(declared) && declared > limit) {
    body.destroy?.();
    throw new ResponseTooLargeError(what, reportedMax);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of body) {
    size += chunk.length;
    if (size > limit) {
      body.destroy?.();
      // An oversized error body is cut off: it only feeds a short message.
      if (isError) break;
      throw new ResponseTooLargeError(what, reportedMax);
    }
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
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

/** The upstream body exceeded maxResponseBytes (on the wire or decompressed). Never retried, never truncated. */
export class ResponseTooLargeError extends HttpError {
  constructor(what: string, max: number) {
    super(`${what.split('?')[0]} returned more than ${Math.round(max / 1024 / 1024)} MB, which this server does not load. Request less (a smaller part or section, fewer results or fields) and paginate.`, 0, '');
    this.name = 'ResponseTooLarge';
  }
}
