import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createMcpHandler, type AuthInfo, type McpRequestContext } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { buildMcpServer, MCP_PROTOCOL_VERSION } from './mcpServer.js';
import type { CatalogDeps } from './toolCatalog.js';
import { IpRateLimiter, clientIp } from './ipRateLimiter.js';
import { SubjectQuota } from '../util/quotas.js';
import { buildVerifier, AuthConfigError, InsufficientScopeError, type AuthConfig } from './authz.js';
import { oauthProtectedResource } from './wellKnown.js';
import { log } from '../util/logger.js';

export interface HttpOptions {
  port: number;
  host: string;
  rps: number;
  burst: number;
  /**
   * Header a reverse proxy in front of this server overwrites with the client address
   * (Railway: `x-real-ip`). Unset keys the per-IP limit on the TCP peer, which behind a
   * proxy is the proxy, not the client.
   */
  clientIpHeader?: string;
  subjectDailyQuota: number;
  auth: AuthConfig;
  insecure?: boolean;
  /**
   * Extra Host header values accepted (DNS-rebinding protection). The public origin's host and
   * loopback hosts on the listening port are always accepted. `['*']` disables the check
   * (unsafe; only behind a proxy that validates Host itself).
   */
  allowedHosts?: string[];
  /**
   * Extra Origin header values allowed on the MCP endpoint (exact origin strings,
   * e.g. "https://app.example.com"). The server's own origin and loopback origins
   * are always allowed; requests without an Origin header (non-browser clients)
   * always pass. Anything else is rejected with 403 — the MCP spec requires
   * Origin validation to block DNS-rebinding / cross-site browser access.
   */
  allowedOrigins?: string[];
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

/** Largest MCP request body accepted: an `execute` program plus the JSON-RPC envelope is far smaller. */
export const MAX_REQUEST_BODY_BYTES = 1024 * 1024;

/** Cap on echoed error text: handler rejections quote caller-supplied headers and body. */
const MAX_LOGGED_ERROR_CHARS = 300;

function truncate(message: string): string {
  return message.length > MAX_LOGGED_ERROR_CHARS
    ? `${message.slice(0, MAX_LOGGED_ERROR_CHARS)}…[truncated]`
    : message;
}

/** Hostnames whose origins are always acceptable: local web tooling and dev UIs. */
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function originAllowed(originHeader: string, ownOrigin: string, allowlist: string[]): boolean {
  const value = originHeader.toLowerCase();
  if (value === ownOrigin.toLowerCase()) return true;
  if (allowlist.some(allowed => allowed.toLowerCase() === value)) return true;
  try {
    return LOOPBACK_HOSTNAMES.has(new URL(value).hostname);
  } catch {
    return false; // unparseable Origin (including "null") is not allowed
  }
}

/** The token of an `Authorization: Bearer <token>` header; the scheme is case-insensitive (RFC 9110). */
export function bearerToken(header: string | undefined): string | undefined {
  return /^bearer +(\S+)$/i.exec(header ?? '')?.[1];
}

function subjectOf(ctx: McpRequestContext): string | undefined {
  const s = ctx.authInfo?.extra?.[SUBJECT_KEY];
  return typeof s === 'string' ? s : undefined;
}

const isLoopbackHost = (host: string) => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(host.toLowerCase());

export async function startHttp(deps: CatalogDeps, opts: HttpOptions): Promise<HttpHandle> {
  const verifier = buildVerifier(opts.auth);
  if (!verifier && !opts.insecure) {
    throw new AuthConfigError('--http needs authentication: set FEDREG_AUTH_PROVIDER (generic-oidc, clerk, workos, auth0) with FEDREG_AUTH_ISSUER, FEDREG_AUTH_AUDIENCE and FEDREG_AUTH_JWKS_URL, use FEDREG_AUTH_PROVIDER=accounts, or pass --insecure for an unauthenticated local server.');
  }
  const disableHostCheck = opts.allowedHosts?.length === 1 && opts.allowedHosts[0] === '*';
  const explicitHosts = (opts.allowedHosts ?? []).filter(h => h !== '*').map(h => h.toLowerCase());
  const publicUrl = opts.publicOrigin ? new URL(opts.publicOrigin) : undefined;
  if (!isLoopbackHost(opts.host) && !publicUrl && !explicitHosts.length && !disableHostCheck) {
    throw new AuthConfigError(`Listening on ${opts.host} needs the hostnames clients use: set FEDREG_PUBLIC_ORIGIN (e.g. https://mcp.example.com) or FEDREG_ALLOWED_HOSTS. Requests are checked against them to block DNS rebinding.`);
  }
  // With authentication, clients find the authorization server through the protected-resource
  // metadata, whose `resource` must be the URL they connect to (RFC 9728). Beyond loopback only
  // the configured public origin can say what that is; allowed hosts alone cannot.
  if (verifier && !opts.insecure && !isLoopbackHost(opts.host) && !publicUrl) {
    throw new AuthConfigError(`Authenticated serving on ${opts.host} needs FEDREG_PUBLIC_ORIGIN (e.g. https://mcp.example.com): OAuth metadata must name the URL clients connect to.`);
  }
  const limiter = new IpRateLimiter(opts.rps, opts.burst);
  const quota = new SubjectQuota(opts.subjectDailyQuota);

  // Stateless: the factory runs once per request, so the subject a tool sees is always the
  // one this request's own bearer token verified as. There is no session to bind, reuse, or
  // outlive a token — per-tenant quota attribution follows from re-authenticating every call.
  const mcpHandler = createMcpHandler(
    (ctx) => buildMcpServer(deps, { subject: subjectOf(ctx) }),
    {
      legacy: 'stateless',
      maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
      // This server declares only `tools`, but the SDK routes `subscriptions/listen`
      // regardless and would otherwise hold up to 1024 long-lived SSE streams per handler
      // — unbounded long-lived state of exactly the kind `FEDREG_MAX_SESSIONS` used to cap.
      // `0` refuses every listen request (the limit check is `open.size >= max`).
      maxSubscriptions: 0,
      // Rejections carry attacker-supplied header/body fragments, so cap what reaches stderr.
      onerror: (err) => log.warn('mcp.handler.error', { error: truncate(err.message) }),
    },
  );
  const nodeHandler = toNodeHandler(mcpHandler, {
    onerror: (err) => log.warn('mcp.adapter.error', { error: truncate(err.message) }),
  });

  // Never rejects: every failure is answered inside (500 at worst), so the request is never left hanging.
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const ip = clientIp(req, opts.clientIpHeader);
      if (!limiter.allow(ip)) return reply(res, 429, { error: 'rate_limited' });

      // DNS rebinding protection: the Host header must be one we were configured with. The
      // trusted origin is never derived from the request itself.
      // /health is exempt, as in account mode: platform health checks (Railway sends
      // `Host: healthcheck.railway.app`) cannot be given a trusted Host, and the endpoint serves no
      // user data and holds no session for a rebinding page to ride on.
      const host = String(req.headers.host ?? '').toLowerCase();
      const isHealth = req.method === 'GET' && (req.url ?? '').split('?')[0] === '/health';
      if (!disableHostCheck && !isHealth && !trustedHosts.has(host)) {
        return reply(res, 421, { error: 'host_not_allowed' });
      }

      const origin = ownOrigin;
      const url = new URL(req.url ?? '/', origin);

      if (url.pathname === RESOURCE_METADATA_PATH && req.method === 'GET') {
        return reply(res, 200, oauthProtectedResource(opts.auth, `${origin}${MCP_PATH}`));
      }

      if (url.pathname === '/health' && req.method === 'GET') {
        return reply(res, 200, { ok: true, sandbox: deps.sandbox.kind, protocolVersion: MCP_PROTOCOL_VERSION });
      }

      if (url.pathname === MCP_PATH) {
        // Origin validation (MCP spec MUST): a browser-originated cross-site request
        // must not reach the transport. Non-browser clients send no Origin and pass.
        const originHeader = req.headers.origin;
        if (typeof originHeader === 'string' && !originAllowed(originHeader, origin, [...(opts.allowedOrigins ?? []), ...(publicUrl ? [publicUrl.origin] : [])])) {
          return reply(res, 403, { error: 'origin_not_allowed', origin: originHeader });
        }

        // Auth (unless --insecure). Runs on every request: with no protocol session there
        // is no other point at which a caller's identity could have been established.
        let subject = 'anonymous';
        let token = '';
        let scopes: string[] = [];
        if (verifier && !opts.insecure) {
          const bearer = bearerToken(req.headers.authorization);
          if (!bearer) {
            res.writeHead(401, {
              'content-type': 'application/json',
              'www-authenticate': `Bearer resource_metadata="${origin}${RESOURCE_METADATA_PATH}"`,
            });
            return res.end(JSON.stringify({ error: 'unauthorized' }));
          }
          token = bearer;
          try {
            const ctx = await verifier.verify(token);
            subject = ctx.subject;
            scopes = ctx.scopes;
          } catch (err) {
            if (err instanceof InsufficientScopeError) {
              res.writeHead(403, {
                'content-type': 'application/json',
                'www-authenticate': `Bearer resource_metadata="${origin}${RESOURCE_METADATA_PATH}", error="insufficient_scope", scope="${err.required.join(' ')}"`,
              });
              return res.end(JSON.stringify({ error: 'insufficient_scope' }));
            }
            res.writeHead(401, {
              'content-type': 'application/json',
              'www-authenticate': `Bearer resource_metadata="${origin}${RESOURCE_METADATA_PATH}", error="invalid_token"`,
            });
            return res.end(JSON.stringify({ error: 'invalid_token' })); // verifier details stay server-side
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
      log.error('http.unhandled', { error: (err as Error).message, stack: (err as Error).stack });
      if (!res.headersSent) reply(res, 500, { error: 'internal' });
    }
  };
  const server = createServer((req, res) => { void handle(req, res); });

  let ownOrigin = '';
  let trustedHosts = new Set<string>();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(opts.port, opts.host, () => resolve()); });
  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : opts.port;
  ownOrigin = publicUrl?.origin ?? `http://127.0.0.1:${actualPort}`;
  trustedHosts = new Set([
    ...explicitHosts,
    ...(publicUrl ? [publicUrl.host.toLowerCase()] : []),
    // Local clients and the container health check always reach us on loopback.
    ...['localhost', '127.0.0.1', '[::1]'].map(h => `${h}:${actualPort}`),
  ]);
  if (opts.insecure && !isLoopbackHost(opts.host)) {
    log.warn('http.insecure_public', { host: opts.host, note: 'unauthenticated server reachable beyond this machine' });
  }
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
