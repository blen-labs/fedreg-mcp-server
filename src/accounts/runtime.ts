import { createServer } from 'node:http';
import { Pool } from 'pg';
import type { CatalogDeps } from '../server/toolCatalog.js';
import type { SupervisorConfig } from '../supervisor/index.js';
import type { HttpHandle } from '../server/http.js';
import type { Dispatcher } from 'undici';
import { log } from '../util/logger.js';
import { createRegsSource } from '../sdk/sources/regs.js';
import { LRUCache } from 'lru-cache';
import { createAccountApp } from './app.js';
import { ACCOUNT_MCP_PATH } from './paths.js';
import { digest } from './crypto.js';
import { Store, personalOwner } from './store.js';
import type { AccountConfig } from './config.js';

/** Account-scoped regs clients, reused across executes so their response caches survive. */
const ACCOUNT_CLIENT_MAX = 500;
const ACCOUNT_CLIENT_TTL_MS = 60 * 60 * 1000;
/** Per-account response cache cap: up to ACCOUNT_CLIENT_MAX of these caches live at once. */
const ACCOUNT_CACHE_MAX_ITEMS = 200;

const unavailable = (message: string) => Object.assign(new Error(message), { name: 'SourceUnavailable' });

/**
 * Keep public-source caches shared. The regs table is always present in account mode;
 * each method loads the caller's key on first use, so fr/ecfr-only code never touches
 * the database. Clients are cached by a digest of owner + key: the key is read on every
 * execute that uses regs, so a saved, rotated or deleted key takes effect on the next call
 * on every replica, while identical queries still hit the client's response cache.
 */
export function accountDependencies(deps: CatalogDeps, cfg: SupervisorConfig, store: Store, dispatcher?: Dispatcher): CatalogDeps {
  // Even if the process has a legacy key, never put it in the hosted account catalog.
  const clients = Object.fromEntries(Object.entries(deps.sdk.clients).filter(([name]) => name !== 'regs'));
  const methods = Object.fromEntries(Object.entries(deps.sdk.methods).filter(([name]) => name !== 'regs'));
  // A keyless source still registers every method; only the names are needed here.
  const regsNames = Object.keys(createRegsSource({
    frBaseUrl: cfg.frBaseUrl, ecfrBaseUrl: cfg.ecfrBaseUrl, regsBaseUrl: 'https://api.regulations.gov',
    userAgent: cfg.userAgent, timeoutMs: cfg.upstreamTimeoutMs, retries: 0,
    cacheTtlMs: cfg.cacheTtlMs, cacheMaxItems: cfg.cacheMaxItems,
  }).methods);
  const sdk = { ...deps.sdk, clients, methods: Object.freeze(methods) };
  const sources = new LRUCache<string, ReturnType<typeof createRegsSource>>({ max: ACCOUNT_CLIENT_MAX, ttl: ACCOUNT_CLIENT_TTL_MS });
  const sourceFor = (owner: string, key: string) => {
    const id = digest(`${owner}\0${key}`);
    let regs = sources.get(id);
    if (!regs) {
      regs = createRegsSource({
        frBaseUrl: cfg.frBaseUrl, ecfrBaseUrl: cfg.ecfrBaseUrl,
        // Account credentials can never be redirected by an operator's legacy upstream override.
        regsBaseUrl: 'https://api.regulations.gov', regsApiKey: key,
        userAgent: cfg.userAgent, timeoutMs: cfg.upstreamTimeoutMs, retries: 0,
        cacheTtlMs: cfg.cacheTtlMs, cacheMaxItems: Math.min(cfg.cacheMaxItems, ACCOUNT_CACHE_MAX_ITEMS),
        // The hourly account limit runs after the client's cache and in-flight dedupe, like the
        // process-wide bucket in key mode, so repeated identical calls do not spend the quota.
        regsPreflightLimiter: { tryTake: () => store.allow(`regs:${owner}`, cfg.regsRatePerHour, 3600) },
        ...(dispatcher ? { dispatcher } : {}),
      });
      sources.set(id, regs);
    }
    return regs;
  };
  return {
    ...deps, sdk,
    // Account mode limits regs per account in PostgreSQL; the in-memory per-subject quota would
    // cap accounts below that, and inconsistently across replicas.
    regsSubjectQuota: undefined,
    sdkForSubject: async subject => {
      if (!subject || subject === 'anonymous') throw new Error('An authenticated account is required');
      const owner = personalOwner(subject);
      // Loaded at most once per execute, and only if the code calls regs.
      let loaded: Promise<string | undefined> | undefined;
      const loadKey = () => loaded ??= store.getKey(owner).catch(err => {
        // A transient database error or a retired encryption key must not break fr/ecfr calls.
        log.warn('account.key_unavailable', { name: (err as Error).name });
        throw unavailable('Your saved regulations.gov API key could not be loaded. Try again, or save it again at /account.');
      });
      const accountMethods = Object.fromEntries(regsNames.map(name => [name, async (...args: unknown[]) => {
        const key = await loadKey();
        if (!key) throw unavailable('Save a regulations.gov API key in your account at /account.');
        const method = sourceFor(owner, key).methods[name]!;
        const redact = (text: string) => text.split(key).join('[REDACTED]');
        let value: unknown;
        try {
          value = await method(...args);
        } catch (err) {
          // Keep the error's name and status (404 for a bad id, RateLimited for 429) so callers can
          // react; scrub the key from the message and never forward the upstream body.
          const e = err as { name?: unknown; message?: unknown; status?: unknown };
          const status = typeof e.status === 'number' ? e.status : undefined;
          throw Object.assign(
            new Error(redact(typeof e.message === 'string' && e.message ? e.message : 'Regulations.gov request failed')),
            { name: typeof e.name === 'string' ? e.name : 'Error', ...(status === undefined ? {} : { status }) },
          );
        }
        // Defensive redaction if an upstream ever echoes a credential, including object keys.
        const json = JSON.stringify(value);
        return json?.includes(key) ? JSON.parse(redact(json)) : value;
      }]));
      return { ...sdk, methods: Object.freeze({ ...sdk.methods, regs: Object.freeze(accountMethods) }) };
    },
  };
}

/**
 * The anonymous endpoint's catalog: Federal Register and eCFR, plus regulations.gov through the
 * operator's shared key (FEDREG_REGS_API_KEY) when one is set. Without it, regs calls explain
 * how to connect the signed-in endpoint instead.
 */
export function publicDependencies(deps: CatalogDeps, origin: string): CatalogDeps {
  if (deps.sdk.methods.regs) return deps;
  const disabledReason = `regulations.gov needs your own API key. Connect ${origin}${ACCOUNT_MCP_PATH} instead: sign in with Google and add your key.`;
  return { ...deps, sdk: { ...deps.sdk, meta: deps.sdk.meta.map(m => m.name === 'regs' ? { ...m, enabled: false, disabledReason } : m) } };
}

export async function startAccountHttp(deps: CatalogDeps, cfg: SupervisorConfig, config: AccountConfig, port: number, host: string): Promise<HttpHandle> {
  const pool = new Pool({ connectionString: config.databaseUrl, max: 10 });
  pool.on('error', () => log.error('account.database_error'));
  const store = new Store(pool, config.keyring);
  let service: Awaited<ReturnType<typeof createAccountApp>> | undefined;
  try {
    await store.initialize();
    service = await createAccountApp(config, store, accountDependencies(deps, cfg, store), fetch, publicDependencies(deps, config.origin));
    const server = createServer(service.app);
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
    const cleanup = setInterval(() => { void store.cleanup().catch(() => log.error('account.cleanup_failed')); }, 60_000);
    cleanup.unref();
    return {
      port: (server.address() as { port: number }).port,
      close: async () => {
        clearInterval(cleanup);
        await service!.close();
        await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
        await pool.end();
      },
    };
  } catch (error) {
    await service?.close();
    await pool.end();
    throw error;
  }
}
