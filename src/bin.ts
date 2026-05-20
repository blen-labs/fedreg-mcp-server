#!/usr/bin/env node
import { startStdio } from './server/stdio.js';
import { startHttp, type HttpHandle } from './server/http.js';
import { buildSupervisor } from './supervisor/index.js';
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const deps = await buildSupervisor({
    frBaseUrl: process.env.FEDREG_FR_BASE_URL ?? 'https://www.federalregister.gov/api/v1',
    ecfrBaseUrl: process.env.FEDREG_ECFR_BASE_URL ?? 'https://www.ecfr.gov/api',
    userAgent: process.env.FEDREG_USER_AGENT ?? 'fedreg-mcp-server/0.1 (+https://modelcontextprotocol.io)',
    upstreamTimeoutMs: Number(process.env.FEDREG_UPSTREAM_TIMEOUT_MS ?? 20_000),
    upstreamRetries: Number(process.env.FEDREG_UPSTREAM_RETRIES ?? 3),
    cacheTtlMs: Number(process.env.FEDREG_CACHE_TTL_MS ?? 300_000),
    cacheMaxItems: Number(process.env.FEDREG_CACHE_MAX_ITEMS ?? 2000),
    sandbox: args.sandbox,
  });

  let handle: HttpHandle | undefined;

  if (args.http) {
    const allowedHosts = process.env.FEDREG_ALLOWED_HOSTS
      ? process.env.FEDREG_ALLOWED_HOSTS.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
      : undefined;

    handle = await startHttp(deps, {
      port: args.port,
      host: args.host,
      rps: Number(process.env.FEDREG_IP_RPS ?? 5),
      burst: Number(process.env.FEDREG_IP_BURST ?? 20),
      maxSessions: Number(process.env.FEDREG_MAX_SESSIONS ?? 500),
      subjectDailyQuota: Number(process.env.FEDREG_SUBJECT_DAILY_QUOTA ?? 10_000),
      insecure: args.insecure,
      allowedHosts,
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
      log.warn('shutdown.error', { message: (err as Error).message });
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

type AuthConfigProvider = 'none' | 'embedded' | 'generic-oidc' | 'clerk' | 'workos' | 'auth0';

main().catch(err => {
  log.error('bin.fatal', { message: (err as Error).message, stack: (err as Error).stack });
  process.exit(1);
});
