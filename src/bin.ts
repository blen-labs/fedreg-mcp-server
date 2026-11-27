#!/usr/bin/env node
import { startStdio } from './server/stdio.js';
import { startHttp, type HttpHandle } from './server/http.js';
import { readBuildInfo } from './server/buildInfo.js';
import { buildSupervisor, EXECUTION_DEFAULTS, UPSTREAM_DEFAULTS, type SupervisorConfig } from './supervisor/index.js';
import { PUBLIC_MAX_CALLS_PER_EXECUTE } from './tools/execute.js';
import type { SandboxKind } from './sandbox/types.js';
import { log } from './util/logger.js';
import type { AuthProvider } from './server/authz.js';

interface CliArgs {
  http: boolean;
  port: number;
  host: string;
  /** True when HOST or --host chose the bind address explicitly. */
  hostExplicit: boolean;
  sandbox: SandboxKind;
  insecure: boolean;
  /** Re-encrypt every stored account credential under ENCRYPTION_ACTIVE_KEY_ID, then exit. */
  rotateKeys: boolean;
  portExplicit: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    http: false,
    port: Number(process.env.PORT ?? 8080),
    host: process.env.HOST ?? '0.0.0.0',
    hostExplicit: Boolean(process.env.HOST),
    sandbox: (process.env.FEDREG_SANDBOX as SandboxKind | undefined) ?? 'auto',
    insecure: false,
    rotateKeys: false,
    portExplicit: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--http') args.http = true;
    else if (a === '--insecure') args.insecure = true;
    else if (a === '--rotate-keys') args.rotateKeys = true;
    else if (a === '--port') { args.port = Number(argv[++i]); args.portExplicit = true; }
    else if (a === '--host') { args.host = String(argv[++i]); args.hostExplicit = true; }
    else if (a === '--sandbox') args.sandbox = argv[++i] as SandboxKind;
    else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    }
  }
  // An unauthenticated server runs anyone's code: keep it on this machine unless told otherwise.
  if (args.insecure && !args.hostExplicit) args.host = '127.0.0.1';
  return args;
}

function printHelp(): void {
  process.stdout.write(`fedreg-mcp-server [options]

  --http                 Run Streamable HTTP transport (default: stdio)
  --port N               HTTP port (default 8080, env PORT)
  --host H               HTTP bind host (default 0.0.0.0; 127.0.0.1 with --insecure; env HOST)
  --sandbox auto|isolate|deno
                         Sandbox runner (default auto, env FEDREG_SANDBOX)
  --insecure             HTTP without authentication (local development; binds loopback by default)
  --rotate-keys          Account mode: re-encrypt stored keys under ENCRYPTION_ACTIVE_KEY_ID, then exit
  -h, --help             Show this help
`);
}

/** A positive number (and at least `min`) from the environment, or `fallback` when unset or invalid. */
function positive(value: string | undefined, fallback: number, min = 0): number {
  const n = Number(value ?? fallback);
  return Number.isFinite(n) && n > 0 && n >= min ? n : fallback;
}

/** A number >= 1 from the environment, or `fallback` when unset or invalid. */
function atLeastOne(value: string | undefined, fallback: number): number {
  return positive(value, fallback, 1);
}

/** `--rotate-keys`: the entry point for docs/accounts.md "Encryption rotation". Exit 1 if any row failed. */
async function rotateKeys(): Promise<void> {
  const { loadAccountConfig } = await import('./accounts/config.js');
  const { Store } = await import('./accounts/store.js');
  const { Pool } = await import('pg');
  const config = loadAccountConfig(process.env);
  const pool = new Pool({ connectionString: config.databaseUrl, max: 2 });
  pool.on('error', () => log.error('account.database_error'));
  try {
    const store = new Store(pool, config.keyring);
    await store.initialize();
    const { rotated, failed } = await store.rotateAllKeys();
    // Owners only: never key material. Failed rows keep their old key ID; see the guide.
    log.info('accounts.keys_rotated', { activeKeyId: config.keyring.activeId, rotated, failed: failed.length });
    for (const { owner, reason } of failed) log.warn('accounts.key_rotation_failed', { owner, reason });
    if (failed.length) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.rotateKeys) {
    // It is a one-shot maintenance command: a server option next to it would be silently ignored.
    if (args.http || args.insecure || args.portExplicit) throw new Error('--rotate-keys runs alone: do not combine it with --http, --insecure or --port.');
    return rotateKeys();
  }

  const accounts = args.http && process.env.FEDREG_AUTH_PROVIDER?.trim() === 'accounts';
  if (accounts && args.insecure) throw new Error('Account authentication cannot be combined with --insecure');
  const shutdownController = new AbortController();
  const cfg: SupervisorConfig = {
    frBaseUrl: process.env.FEDREG_FR_BASE_URL ?? 'https://www.federalregister.gov/api/v1',
    ecfrBaseUrl: process.env.FEDREG_ECFR_BASE_URL ?? 'https://www.ecfr.gov/api',
    regsBaseUrl: process.env.FEDREG_REGS_BASE_URL ?? 'https://api.regulations.gov',
    // In account mode the shared key serves only the anonymous /mcp endpoint; signed-in users at
    // /mcp/account always use their own key (accountDependencies strips this one).
    regsApiKey: process.env.FEDREG_REGS_API_KEY,
    userAgent: process.env.FEDREG_USER_AGENT ?? 'fedreg-mcp-server/2.0 (+https://github.com/blen-labs/fedreg-mcp-server)',
    upstreamTimeoutMs: Number(process.env.FEDREG_UPSTREAM_TIMEOUT_MS ?? 20_000),
    upstreamRetries: Number(process.env.FEDREG_UPSTREAM_RETRIES ?? 3),
    cacheTtlMs: Number(process.env.FEDREG_CACHE_TTL_MS ?? 300_000),
    cacheMaxItems: Number(process.env.FEDREG_CACHE_MAX_ITEMS ?? 2000),
    sandbox: args.sandbox,
    // Authenticated HTTP serves many callers from one process: user code runs only in Deno.
    processIsolation: args.http && !args.insecure,
    maxConcurrentExecutions: atLeastOne(process.env.FEDREG_MAX_CONCURRENT_EXECUTIONS, EXECUTION_DEFAULTS.maxConcurrent),
    maxExecutionsPerSubject: atLeastOne(process.env.FEDREG_MAX_EXECUTIONS_PER_SUBJECT, EXECUTION_DEFAULTS.perSubject),
    shutdownSignal: shutdownController.signal,
    // Public upstreams (fr, ecfr) see one client: this server. Each must be >= 1.
    upstreamConcurrency: atLeastOne(process.env.FEDREG_UPSTREAM_CONCURRENCY, UPSTREAM_DEFAULTS.concurrency),
    upstreamRatePerSec: atLeastOne(process.env.FEDREG_UPSTREAM_RATE_PER_SEC, UPSTREAM_DEFAULTS.ratePerSec),
    upstreamMaxWaitMs: atLeastOne(process.env.FEDREG_UPSTREAM_MAX_WAIT_MS, UPSTREAM_DEFAULTS.maxWaitMs),
    publicMaxCallsPerExecute: atLeastOne(process.env.FEDREG_PUBLIC_MAX_CALLS_PER_EXECUTE, PUBLIC_MAX_CALLS_PER_EXECUTE),
    regsMaxCallsPerExecute: (() => {
      const n = Number(process.env.FEDREG_REGS_MAX_CALLS_PER_EXECUTE ?? 30);
      return Number.isFinite(n) && n >= 0 ? n : 30;
    })(),
    // Require >= 1: a rate of 0 would silently block ALL regs calls (it is NOT
    // "unlimited"). To disable regs, leave FEDREG_REGS_API_KEY unset instead.
    regsRatePerHour: atLeastOne(process.env.FEDREG_REGS_RATE_PER_HOUR, 1000),
    // Require >= 1; per-subject hourly cap, not "unlimited".
    regsSubjectRatePerHour: atLeastOne(process.env.FEDREG_REGS_SUBJECT_RATE_PER_HOUR, 500),
  };
  const deps = await buildSupervisor(cfg);

  let handle: HttpHandle | undefined;

  if (accounts) {
    const { loadAccountConfig } = await import('./accounts/config.js');
    const { startAccountHttp } = await import('./accounts/runtime.js');
    handle = await startAccountHttp(deps, cfg, loadAccountConfig(process.env), args.port, args.host, readBuildInfo(process.env));
  } else if (args.http) {
    const allowedOrigins = process.env.FEDREG_ALLOWED_ORIGINS
      ? process.env.FEDREG_ALLOWED_ORIGINS.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
      : undefined;
    const allowedHosts = process.env.FEDREG_ALLOWED_HOSTS
      ? process.env.FEDREG_ALLOWED_HOSTS.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
      : undefined;

    handle = await startHttp(deps, {
      port: args.port,
      host: args.host,
      // rps must be > 0 (a NaN or non-positive rate makes the bucket arithmetic meaningless);
      // burst must be >= 1, since a bucket that can never hold a whole token rejects everything.
      rps: positive(process.env.FEDREG_IP_RPS, 5),
      burst: positive(process.env.FEDREG_IP_BURST, 20, 1),
      clientIpHeader: (() => {
        const name = process.env.FEDREG_CLIENT_IP_HEADER?.trim().toLowerCase();
        if (!name) return undefined;
        if (/^[a-z0-9-]+$/.test(name)) return name;
        log.warn('config.invalid_client_ip_header', { header: name });
        return undefined;
      })(),
      subjectDailyQuota: Number(process.env.FEDREG_SUBJECT_DAILY_QUOTA ?? 10_000),
      insecure: args.insecure,
      allowedHosts,
      allowedOrigins,
      publicOrigin: process.env.FEDREG_PUBLIC_ORIGIN,
      buildInfo: readBuildInfo(process.env),
      auth: {
        provider: (process.env.FEDREG_AUTH_PROVIDER?.trim() as AuthConfigProvider) || 'none',
        issuer: process.env.FEDREG_AUTH_ISSUER,
        audience: process.env.FEDREG_AUTH_AUDIENCE,
        jwksUrl: process.env.FEDREG_AUTH_JWKS_URL,
        scopes: process.env.FEDREG_AUTH_SCOPES?.split(',').map(s => s.trim()).filter(Boolean),
      },
    });
  } else {
    await startStdio(deps);
  }

  // Graceful shutdown (Railway sends SIGTERM, K8s sends SIGTERM, Ctrl-C sends SIGINT)
  const shutdown = async (signal: string) => {
    log.info('shutdown.start', { signal });
    shutdownController.abort();
    try {
      if (handle) await handle.close();
    } catch (err) {
      log.warn('shutdown.error', { error: (err as Error).message });
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

type AuthConfigProvider = AuthProvider;

main().catch(err => {
  log.error('bin.fatal', { error: (err as Error).message, stack: (err as Error).stack });
  process.exit(1);
});
