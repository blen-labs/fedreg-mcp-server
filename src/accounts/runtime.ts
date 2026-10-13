import { createServer } from 'node:http';
import { Pool } from 'pg';
import type { CatalogDeps } from '../server/toolCatalog.js';
import type { SupervisorConfig } from '../supervisor/index.js';
import type { HttpHandle } from '../server/http.js';
import { createRegsSource } from '../sdk/sources/regs.js';
import { createAccountApp } from './app.js';
import { Store, personalOwner } from './store.js';
import type { AccountConfig } from './config.js';

/** Keep public-source caches shared; each execution gets fresh, account-scoped regs bindings. */
export function accountDependencies(deps: CatalogDeps, cfg: SupervisorConfig, store: Store): CatalogDeps {
  // Even if the process has a legacy key, never put it in the hosted account catalog.
  const clients = Object.fromEntries(Object.entries(deps.sdk.clients).filter(([name]) => name !== 'regs'));
  const methods = Object.fromEntries(Object.entries(deps.sdk.methods).filter(([name]) => name !== 'regs'));
  const meta = deps.sdk.meta.map(m => m.name === 'regs' ? {
    ...m, enabled: false, disabledReason: 'Save a regulations.gov API key in your account at /account.',
  } : m);
  const sdk = { ...deps.sdk, clients, methods: Object.freeze(methods), meta };
  return {
    ...deps, sdk,
    sdkForSubject: async subject => {
      if (!subject || subject === 'anonymous') throw new Error('An authenticated account is required');
      const owner = personalOwner(subject);
      const key = await store.getKey(owner);
      if (!key) return sdk;
      const regs = createRegsSource({
        frBaseUrl: cfg.frBaseUrl, ecfrBaseUrl: cfg.ecfrBaseUrl,
        // Account credentials can never be redirected by an operator's legacy upstream override.
        regsBaseUrl: 'https://api.regulations.gov', regsApiKey: key,
        userAgent: cfg.userAgent, timeoutMs: cfg.upstreamTimeoutMs, retries: 0,
        cacheTtlMs: cfg.cacheTtlMs, cacheMaxItems: cfg.cacheMaxItems,
      });
      const accountMethods = Object.fromEntries(Object.entries(regs.methods).map(([name, method]) => [name, async (...args: unknown[]) => {
        if (!await store.allow(`regs:${owner}`, cfg.regsRatePerHour, 3600)) throw new Error('Regulations.gov hourly account limit reached');
        try {
          const value = await method(...args);
          // Defensive redaction if an upstream ever echoes a credential, including object keys.
          const json = JSON.stringify(value);
          return json === undefined ? value : JSON.parse(json.split(key).join('[REDACTED]'));
        } catch (err) {
          const status = (err as { status?: number }).status;
          throw new Error(`Regulations.gov request failed${typeof status === 'number' ? ` (${status})` : ''}. Check your saved key or try again later.`);
        }
      }]));
      return { ...sdk, methods: Object.freeze({ ...sdk.methods, regs: Object.freeze(accountMethods) }),
        meta: sdk.meta.map(m => m.name === 'regs' ? { ...m, enabled: true, disabledReason: undefined } : m) };
    },
  };
}

export async function startAccountHttp(deps: CatalogDeps, cfg: SupervisorConfig, config: AccountConfig, port: number, host: string): Promise<HttpHandle> {
  const pool = new Pool({ connectionString: config.databaseUrl, max: 10 });
  pool.on('error', () => console.error('account_database_error'));
  const store = new Store(pool, config.keyring);
  let service: Awaited<ReturnType<typeof createAccountApp>> | undefined;
  try {
    await store.initialize();
    service = await createAccountApp(config, store, accountDependencies(deps, cfg, store));
    const server = createServer(service.app);
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
    const cleanup = setInterval(() => { void store.cleanup().catch(() => console.error('account_cleanup_failed')); }, 60_000);
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
