#!/usr/bin/env node
import { startStdio } from './server/stdio.js';
import { startHttp, type HttpHandle } from './server/http.js';
import { buildSupervisor, UPSTREAM_DEFAULTS, type SupervisorConfig } from './supervisor/index.js';
import { PUBLIC_MAX_CALLS_PER_EXECUTE } from './tools/execute.js';
import type { SandboxKind } from './sandbox/types.js';
import { log } from './util/logger.js';

interface CliArgs {
  http: boolean;
  port: number;
  host: string;
  sandbox: SandboxKind;
  insecure: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    http: false,
    port: Number(process.env.PORT ?? 8080),
    host: process.env.HOST ?? '0.0.0.0',
    sandbox: (process.env.FEDREG_SANDBOX as SandboxKind | undefined) ?? 'auto',
    insecure: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--http') args.http = true;
    else if (a === '--insecure') args.insecure = true;
    else if (a === '--port') args.port = Number(argv[++i]);
    else if (a === '--host') args.host = String(argv[++i]);
    else if (a === '--sandbox') args.sandbox = argv[++i] as SandboxKind;
    else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    }
  }
  return args;
}

function printHelp(): void {
  process.stdout.write(`fedreg-mcp-server [options]

  --http                 Run Streamable HTTP transport (default: stdio)
  --port N               HTTP port (default 8080, env PORT)
  --host H               HTTP bind host (default 0.0.0.0, env HOST)
  --sandbox auto|isolate|deno
                         Sandbox runner (default auto, env FEDREG_SANDBOX)
  --insecure             HTTP without auth (DEV ONLY)
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const accounts = args.http && process.env.FEDREG_AUTH_PROVIDER === 'accounts';
  if (accounts && args.insecure) throw new Error('Account authentication cannot be combined with --insecure');
  const cfg: SupervisorConfig = {
    frBaseUrl: process.env.FEDREG_FR_BASE_URL ?? 'https://www.federalregister.gov/api/v1',
    ecfrBaseUrl: process.env.FEDREG_ECFR_BASE_URL ?? 'https://www.ecfr.gov/api',
    regsBaseUrl: process.env.FEDREG_REGS_BASE_URL ?? 'https://api.regulations.gov',
    regsApiKey: accounts ? undefined : process.env.FEDREG_REGS_API_KEY,
    userAgent: process.env.FEDREG_USER_AGENT ?? 'fedreg-mcp-server/2.0 (+https://github.com/blen-labs/fedreg-mcp-server)',
    upstreamTimeoutMs: Number(process.env.FEDREG_UPSTREAM_TIMEOUT_MS ?? 20_000),
    upstreamRetries: Number(process.env.FEDREG_UPSTREAM_RETRIES ?? 3),
    cacheTtlMs: Number(process.env.FEDREG_CACHE_TTL_MS ?? 300_000),
    cacheMaxItems: Number(process.env.FEDREG_CACHE_MAX_ITEMS ?? 2000),
    sandbox: args.sandbox,
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
    handle = await startAccountHttp(deps, cfg, loadAccountConfig(process.env), args.port, args.host);
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
      auth: {
        provider: (process.env.FEDREG_AUTH_PROVIDER as AuthConfigProvider) ?? 'none',
        issuer: process.env.FEDREG_AUTH_ISSUER,
        audience: process.env.FEDREG_AUTH_AUDIENCE,
        jwksUrl: process.env.FEDREG_AUTH_JWKS_URL,
        resource: process.env.FEDREG_AUTH_RESOURCE,
        scopes: process.env.FEDREG_AUTH_SCOPES?.split(',').map(s => s.trim()).filter(Boolean),
      },
    });
  } else {
    await startStdio(deps);
  }

  // Graceful shutdown (Railway sends SIGTERM, K8s sends SIGTERM, Ctrl-C sends SIGINT)
  const shutdown = async (signal: string) => {
    log.info('shutdown.start', { signal });
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

type AuthConfigProvider = 'none' | 'embedded' | 'generic-oidc' | 'clerk' | 'workos' | 'auth0';

main().catch(err => {
  log.error('bin.fatal', { error: (err as Error).message, stack: (err as Error).stack });
  process.exit(1);
});
