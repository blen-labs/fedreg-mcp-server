import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createMcpHandler, type AuthInfo, type McpRequestContext } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { buildMcpServer, MCP_PROTOCOL_VERSION } from './mcpServer.js';
import type { CatalogDeps } from './toolCatalog.js';
import { IpRateLimiter } from './ipRateLimiter.js';
import { SubjectQuota } from '../util/quotas.js';
import { buildVerifier, type AuthConfig } from './authz.js';
import type { JWTPayload } from 'jose';
import { oauthProtectedResource } from './wellKnown.js';
import { log } from '../util/logger.js';

export interface HttpOptions {
  port: number;
  host: string;
  rps: number;
  burst: number;
  subjectDailyQuota: number;
  auth: AuthConfig;
  insecure?: boolean;
  /** Allowed Host header values for DNS rebinding protection. Pass [] to disable. */
  allowedHosts?: string[];
  /** Public origin clients should use (for protected-resource metadata). */
  publicOrigin?: string;
}

export interface HttpHandle {
  close: () => Promise<void>;
  port: number;
}

const MCP_PATH = '/mcp';
const RESOURCE_METADATA_PATH = '/.well-known/oauth-protected-resource/mcp';

/** Key the tool-catalog context off the subject this request authenticated as. */
const SUBJECT_KEY = 'fedreg.subject';

/** Cap on echoed error text: handler rejections quote caller-supplied headers and body. */
const MAX_LOGGED_ERROR_CHARS = 300;

function truncate(message: string): string {
  return message.length > MAX_LOGGED_ERROR_CHARS
    ? `${message.slice(0, MAX_LOGGED_ERROR_CHARS)}…[truncated]`
    : message;
}

function subjectOf(ctx: McpRequestContext): string | undefined {
  const s = ctx.authInfo?.extra?.[SUBJECT_KEY];
  return typeof s === 'string' ? s : undefined;
}

/**
 * Scopes actually granted to the presented token, read from the standard OAuth claims
 * (`scope` as a space-delimited string, or `scp` as an array).
 *
 * Deliberately NOT `opts.auth.scopes` — that is the server's advertised
 * `scopes_supported` list, and copying it here would hand every caller an `AuthInfo`
 * claiming every configured scope regardless of what its token was granted.
 */
function grantedScopes(claims: JWTPayload): string[] {
  const raw = claims.scope ?? claims.scp;
  if (typeof raw === 'string') return raw.split(' ').filter(Boolean);
  if (Array.isArray(raw)) return raw.filter((s): s is string => typeof s === 'string');
  return [];
}

export async function startHttp(deps: CatalogDeps, opts: HttpOptions): Promise<HttpHandle> {
  const verifier = buildVerifier(opts.auth);
  const limiter = new IpRateLimiter(opts.rps, opts.burst);
  const quota = new SubjectQuota(opts.subjectDailyQuota);

  // Stateless: the factory runs once per request, so the subject a tool sees is always the
  // one this request's own bearer token verified as. There is no session to bind, reuse, or
  // outlive a token — per-tenant quota attribution follows from re-authenticating every call.
  const mcpHandler = createMcpHandler(
    (ctx) => buildMcpServer(deps, { subject: subjectOf(ctx) }),
    {
      legacy: 'stateless',
      // This server declares only `tools`, but the SDK routes `subscriptions/listen`
      // regardless and would otherwise hold up to 1024 long-lived SSE streams per handler
      // — unbounded long-lived state of exactly the kind `FEDREG_MAX_SESSIONS` used to cap.
      // `0` refuses every listen request (the limit check is `open.size >= max`).
      maxSubscriptions: 0,
      // Rejections carry attacker-supplied header/body fragments, so cap what reaches stderr.
      onerror: (err) => log.warn('mcp.handler.error', { message: truncate(err.message) }),
    },
  );
  const nodeHandler = toNodeHandler(mcpHandler, {
    onerror: (err) => log.warn('mcp.adapter.error', { message: truncate(err.message) }),
  });

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const ip = (req.socket.remoteAddress ?? 'unknown').replace('::ffff:', '');
      if (!limiter.allow(ip)) return reply(res, 429, { error: 'rate_limited' });

      // DNS rebinding protection: validate Host header against allowlist when provided.
      if (opts.allowedHosts && opts.allowedHosts.length > 0) {
        const host = String(req.headers.host ?? '').toLowerCase();
        if (!opts.allowedHosts.includes(host)) {
          return reply(res, 421, { error: 'host_not_allowed', host });
        }
      }

      const origin = opts.publicOrigin ?? `http://${req.headers.host ?? `${opts.host}:${opts.port}`}`;
      const url = new URL(req.url ?? '/', origin);

      if (url.pathname === RESOURCE_METADATA_PATH && req.method === 'GET') {
        return reply(res, 200, oauthProtectedResource(opts.auth, `${origin}${MCP_PATH}`));
      }

      if (url.pathname === '/health' && req.method === 'GET') {
        return reply(res, 200, { ok: true, sandbox: deps.sandbox.kind, protocolVersion: MCP_PROTOCOL_VERSION });
      }

      if (url.pathname === MCP_PATH) {
        // Auth (unless --insecure). Runs on every request: with no protocol session there
        // is no other point at which a caller's identity could have been established.
        let subject = 'anonymous';
        let token = '';
        let scopes: string[] = [];
        if (!opts.insecure) {
          const auth = req.headers.authorization;
          if (!auth?.startsWith('Bearer ')) {
            res.writeHead(401, {
              'content-type': 'application/json',
              'www-authenticate': `Bearer resource_metadata="${origin}${RESOURCE_METADATA_PATH}"`,
            });
            return res.end(JSON.stringify({ error: 'unauthorized' }));
          }
          token = auth.slice(7);
          try {
            const ctx = await verifier.verify(token);
            subject = ctx.subject;
            scopes = grantedScopes(ctx.claims);
          } catch (err) {
            res.writeHead(401, {
              'content-type': 'application/json',
              'www-authenticate': `Bearer resource_metadata="${origin}${RESOURCE_METADATA_PATH}", error="invalid_token"`,
            });
            return res.end(JSON.stringify({ error: 'invalid_token', detail: (err as Error).message }));
          }
          const q = quota.consume(subject);
          if (!q.allowed) {
            return reply(res, 429, { error: 'quota_exceeded', resetAt: new Date(q.resetAt).toISOString() });
          }
        }

        // toNodeHandler forwards `req.auth` to the factory as pass-through authInfo.
        const authInfo: AuthInfo = {
          token,
          clientId: subject,
          scopes,
          extra: { [SUBJECT_KEY]: subject },
        };
        (req as IncomingMessage & { auth?: AuthInfo }).auth = authInfo;

        await nodeHandler(req, res);
        return;
      }

      reply(res, 404, { error: 'not_found' });
    } catch (err) {
      log.error('http.unhandled', { message: (err as Error).message, stack: (err as Error).stack });
      if (!res.headersSent) reply(res, 500, { error: 'internal' });
    }
  });

  await new Promise<void>((resolve) => server.listen(opts.port, opts.host, () => resolve()));
  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : opts.port;
  log.info('http.listening', {
    host: opts.host, port: actualPort,
    insecure: opts.insecure ?? false,
    sandbox: deps.sandbox.kind,
    auth: opts.auth.provider,
    protocolVersion: MCP_PROTOCOL_VERSION,
  });

  return {
    port: actualPort,
    close: async () => {
      // Handler first: `server.close()` only stops new connections and resolves once every
      // existing one is idle, so an open SSE exchange (kept warm by keepalive frames) would
      // block it forever. Closing the handler aborts in-flight exchanges and releases those
      // sockets, after which the listener can actually drain.
      await mcpHandler.close();
      await new Promise<void>(r => server.close(() => r()));
    },
  };
}

function reply(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
