import express from 'express';
import { Pool } from 'pg';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { buildMcpServer, MCP_PROTOCOL_VERSION } from '../server/mcpServer.js';
import type { CatalogDeps } from '../server/toolCatalog.js';
import type { AccountConfig } from './config.js';
import { type Store } from './store.js';
import { createAuth, initializeAuth, type Auth } from './provider.js';
import { installPortal } from './portal.js';
import { digest } from './crypto.js';
import { log } from '../util/logger.js';
import { IpRateLimiter, clientIp } from '../server/ipRateLimiter.js';
import { originAllowed, MAX_REQUEST_BODY_BYTES } from '../server/http.js';
import { ACCOUNT_MCP_PATH, PUBLIC_MCP_PATH } from './paths.js';
import { DOCS_PATH, docsHandler } from './docs.js';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const CROSS_ORIGIN_PATHS =
  /^\/(?:mcp(?:\/account)?|\.well-known\/(?:oauth-protected-resource|oauth-authorization-server|openid-configuration)(?:\/[\w-]+)*|api\/auth\/(?:oauth2\/(?:register|token|revoke)|\.well-known\/(?:oauth-authorization-server|openid-configuration)))$/;
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Expose-Headers': 'WWW-Authenticate, Mcp-Session-Id, Mcp-Protocol-Version',
  'Access-Control-Max-Age': '600',
};
// Newer MCP clients add per-request headers (Mcp-Method, Mcp-Name, Mcp-Param-*), so preflights
// echo what was asked for; no credentials are allowed, so this grants nothing beyond the bearer.
const CORS_ALLOW_HEADERS =
  'Authorization, Content-Type, Accept, Mcp-Protocol-Version, Mcp-Session-Id, Mcp-Method, Mcp-Name, Last-Event-ID';

/** Longest a token or revoke request waits for a lock connection, and then for the lock. */
const LOCK_WAIT_MS = 10_000;

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
/** Redirect URIs in a registration body; malformed JSON is left for Better Auth to reject. */
function registeredRedirects(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString('utf8'))?.redirect_uris ?? [];
  } catch {
    return [];
  }
}
/** Client-side routes of the portal (web/src/main.tsx), served as index.html. */
const PORTAL_ROUTES = ['/', '/sign-in', '/connect', '/consent', '/account', '/privacy-policy', '/terms', '/error'];
const PORTAL_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

/** A top-level page load in a browser (not fetch, not an API client). */
function isNavigation(req: express.Request): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const mode = req.get('sec-fetch-mode');
  if (mode) return mode === 'navigate';
  return req.accepts(['json', 'html']) === 'html';
}

const TOO_MANY_PAGE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Too many requests · Federal Regulations MCP</title></head>
<body><main><h1>Too many requests</h1><p>This address sent too many requests. Wait a minute, then <a href="/">try again</a>.</p></main></body>
</html>
`;

/** MCP's rule for redirect URIs: HTTPS, or plain HTTP only to this computer. */
export function allowedRedirect(value: unknown) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return !url.username && !url.password && !url.hash && (url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname)));
  } catch {
    return false;
  }
}

/** The columns of a Better Auth `oauthAccessToken` row that bearer checks read. */
type AccessTokenRow = {
  userId?: string | null;
  clientId: string;
  revoked?: boolean | Date | null;
  expiresAt: Date | string;
  resources?: string[] | null;
  scopes?: string[] | string | null;
};

export async function createAccountApp(
  config: AccountConfig,
  store: Store,
  deps: CatalogDeps,
  fetcher: typeof fetch = fetch,
  /** Catalog for the anonymous endpoint (see publicDependencies): no subject, regs only via a shared key. */
  publicDeps: CatalogDeps,
): Promise<{ app: express.Express; auth: Auth; mcp: ReturnType<typeof createMcpHandler>; close: () => Promise<void> }> {
  const app = express();
  app.disable('x-powered-by');
  // Railway terminates TLS at one trusted proxy hop.
  if (config.production) app.set('trust proxy', 1);
  // With `trust proxy` 1, req.ip is the rightmost X-Forwarded-For entry. Railway rebuilds that
  // header as "<client>, <edge>", so req.ip is its edge, shared by many users. The header the
  // proxy overwrites with the client address (Railway: x-real-ip) is used instead when set.
  const ipOf = (req: express.Request) => config.clientIpHeader ? clientIp(req, config.clientIpHeader) : req.ip;
  const auth = createAuth(config, store);
  await initializeAuth(auth, config, store);
  // Each waiting token request holds a connection, so size this for concurrent token requests.
  const locks = new Pool({ ...store.pool.options, max: 10, connectionTimeoutMillis: LOCK_WAIT_MS });
  locks.on('error', () => log.error('account.auth_lock_connection_error'));
  /**
   * The advisory lock for a /oauth2/token or /oauth2/revoke body: the owner of the presented
   * refresh or access token, else the presented code or token itself (an unknown token
   * changes nothing, and a code is single-use). Tokens are stored as digests of their value.
   */
  const tokenLockId = async (body: Buffer | undefined) => {
    let fields: Record<string, unknown> = {};
    const text = body?.toString('utf8').trim() ?? '';
    try { fields = text.startsWith('{') ? JSON.parse(text) : Object.fromEntries(new URLSearchParams(text)); }
    catch { /* Better Auth rejects the malformed body; any lock id will do. */ }
    const value = (name: string) => typeof fields[name] === 'string' ? fields[name] as string : undefined;
    const token = value('refresh_token') ?? value('token');
    let key = `code:${value('code') ?? ''}`;
    if (token) {
      const { adapter } = await auth.$context;
      const where = [{ field: 'token', value: digest(token) }];
      const row = await adapter.findOne<{ userId?: string }>({ model: 'oauthRefreshToken', where })
        ?? await adapter.findOne<{ userId?: string }>({ model: 'oauthAccessToken', where });
      key = row?.userId ? `user:${row.userId}` : `token:${digest(token)}`;
    }
    // pg_advisory_lock takes a signed 64-bit key.
    return BigInt.asIntN(64, BigInt(`0x${digest(key).slice(0, 16)}`)).toString();
  };
  const mcp = createMcpHandler(
    ctx => buildMcpServer(deps, { subject: ctx.authInfo?.extra?.userId as string | undefined }),
    { legacy: 'stateless', maxSubscriptions: 0, maxRequestBodySize: MAX_REQUEST_BODY_BYTES, onerror: () => log.warn('account.mcp_handler_error') },
  );
  // Anonymous endpoint: the same tools, no token read or required. Each client address is its
  // own subject, so the per-subject execution cap stops one anonymous client from taking every
  // execution slot from everyone else.
  const publicMcp = createMcpHandler(
    ctx => buildMcpServer(publicDeps, { subject: ctx.authInfo?.extra?.anonymousSubject as string | undefined }),
    { legacy: 'stateless', maxSubscriptions: 0, maxRequestBodySize: MAX_REQUEST_BODY_BYTES, onerror: () => log.warn('account.public_mcp_handler_error') },
  );
  const resource = `${config.origin}${ACCOUNT_MCP_PATH}`;
  const foreignOrigin = (req: express.Request) =>
    !!req.headers.origin && req.headers.origin !== config.origin;
  const metadataUrl = `${config.origin}/.well-known/oauth-protected-resource${ACCOUNT_MCP_PATH}`;
  const originHost = new URL(config.origin).host;
  app.use((req, res, next) => {
    res.set({
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'strict-origin',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy':
        "default-src 'none'; style-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    });
    if (config.production) res.set('Strict-Transport-Security', 'max-age=31536000');
    if (req.path !== '/health' && req.headers.host !== originHost)
      return res.status(421).send('Invalid host');
    // MCP clients, including browser-based ones and hosted connectors such as Claude, call
    // discovery, registration, token and /mcp from other origins. These use bearer tokens or
    // client credentials, never cookies, and the Host check above prevents DNS rebinding.
    if (CROSS_ORIGIN_PATHS.test(req.path)) {
      res.set(CORS_HEADERS);
      if (req.method === 'OPTIONS')
        return res
          .status(204)
          .set({
            'Access-Control-Allow-Headers':
              req.headers['access-control-request-headers']?.slice(0, 1024) || CORS_ALLOW_HEADERS,
            Vary: 'Access-Control-Request-Headers',
          })
          .end();
      return next();
    }
    // Everything else is a cookie-authenticated browser surface and stays same-origin.
    if (foreignOrigin(req)) {
      log.warn('account.origin_rejected');
      return res.status(403).send('Invalid origin');
    }
    next();
  });
  app.get('/health', async (_req, res) => {
    try {
      await store.pool.query('SELECT 1');
      res.json({
        status: 'ok',
        protocolVersion: MCP_PROTOCOL_VERSION, sandbox: deps.sandbox.kind,
      });
    } catch {
      res.status(503).json({ status: 'unavailable' });
    }
  });
  const webRoot = fileURLToPath(new URL('../../dist/web/', import.meta.url));
  app.use('/assets', express.static(resolve(webRoot, 'assets'), { immutable: true, maxAge: '1y', index: false }));
  // The documentation site, when the image carries it (deploy/Dockerfile builds site/ into
  // docs-site/, a sibling of dist/ that the npm package does not ship). Static and public, so it
  // sits before the per-IP limiter like /assets, with its own CSP (see docs.ts).
  const docs = docsHandler(config.docsRoot ?? fileURLToPath(new URL('../../docs-site/', import.meta.url)));
  if (docs) {
    // `/docs` without the slash would serve the index at the wrong base; send it to `/docs/`.
    app.use(DOCS_PATH, (req, res, next) => {
      const [path = '', query] = req.originalUrl.split('?');
      if (path !== DOCS_PATH) return docs(req, res, next);
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      res.redirect(301, `${DOCS_PATH}/${query === undefined ? '' : `?${query}`}`);
    });
  }
  // Production reads the built page once; development rereads it so `pnpm dev:web` rebuilds show.
  const loadIndex = () => readFile(resolve(webRoot, 'index.html'), 'utf8').catch(() => undefined);
  let indexHtml: string | undefined;
  const sendPortal = async (res: express.Response, status = 200) => {
    const html = config.production ? (indexHtml ??= await loadIndex()) : await loadIndex();
    if (!html) return res.status(503).send('The web interface is not built. Run pnpm build.');
    res.status(status).set('Content-Security-Policy', PORTAL_CSP).type('html').send(html);
  };
  app.get(PORTAL_ROUTES, async (_req, res) => {
    await sendPortal(res);
  });
  const tooMany = (res: express.Response) => {
    res.status(429).set('Retry-After', '60');
    // A person in a browser gets a page; API clients get the short text they always did.
    if (isNavigation(res.req)) {
      return res.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'").type('html').send(TOO_MANY_PAGE);
    }
    return res.send('Too many requests');
  };
  app.use(async (req, res, next) => {
    // Hosted connectors (ChatGPT, Claude) send every user's OAuth and MCP traffic from a few
    // shared egress IPs, so those endpoints are limited elsewhere: Better Auth limits each OAuth
    // endpoint, and the signed-in MCP endpoint is limited per user after the token is checked
    // (see below). The anonymous endpoint has its own per-IP bucket (FEDREG_IP_RPS/BURST) below.
    const platform =
      CROSS_ORIGIN_PATHS.test(req.path) &&
      (req.path !== ACCOUNT_MCP_PATH || !!req.headers.authorization?.startsWith('Bearer '));
    if (!platform && !(await store.allow(`http:${ipOf(req)}`, 600, 60))) return tooMany(res);
    next();
  });
  const mcpNode = toNodeHandler(mcp, {
    onerror: () => log.warn('account.mcp_http_error'),
  });
  const publicNode = toNodeHandler(publicMcp, {
    onerror: () => log.warn('account.public_mcp_http_error'),
  });
  // In memory per replica, like the base transport's limiter it mirrors.
  const publicLimiter = new IpRateLimiter(config.ipRps ?? 5, config.ipBurst ?? 20);
  // Federal Register and eCFR need no sign-in. A bearer token sent here is ignored: signed-in
  // access, and regulations.gov with the user's own key, live at ACCOUNT_MCP_PATH.
  app.all(PUBLIC_MCP_PATH, async (req, res) => {
    if (!publicLimiter.allow(ipOf(req) ?? 'unknown')) return tooMany(res);
    // MCP's Origin rule: with no token to check, another site's page must not drive this endpoint
    // (it runs code). Non-browser clients send no Origin and pass. The signed-in endpoint accepts
    // any Origin: hosted connectors (claude.ai, chatgpt.com) send theirs, every request carries a
    // bearer token (never a cookie), and the Host check above already blocks DNS rebinding.
    const origin = req.headers.origin;
    if (typeof origin === 'string' && !originAllowed(origin, config.origin, config.allowedOrigins ?? []))
      return res.status(403).json({ error: 'origin_not_allowed' });
    // toNodeHandler forwards req.auth to the factory; no token is involved.
    Object.assign(req, { auth: { token: '', clientId: 'anonymous', scopes: [], extra: { anonymousSubject: `anon:${ipOf(req) ?? 'unknown'}` } } });
    await publicNode(req, res);
  });
  // No body parser: the SDK reads the body itself (capped by maxRequestBodySize, as in the base
  // HTTP transport) and only after the token checks below pass.
  app.all(ACCOUNT_MCP_PATH, async (req, res) => {
    const challenge = (status: number, error: string) =>
      res
        .status(status)
        .set(
          'WWW-Authenticate',
          `Bearer resource_metadata="${metadataUrl}", error="${error}", scope="fedreg:read"`,
        )
        .json({ error });
    const authorization = req.headers.authorization;
    if (!authorization?.startsWith('Bearer ') || authorization.length > 4096)
      return challenge(401, 'invalid_token');
    // A flood guard sized for a connector's shared IP; the per-user limit below does the real work.
    if (!(await store.allow(`mcp-ip:${ipOf(req)}`, 6000, 60))) return tooMany(res);
    const value = authorization.slice(7);
    // Opaque tokens are checked against their hashed database row on every request, so
    // revocation, client disabling, user deletion and loss of email verification apply immediately.
    const context = await auth.$context;
    const token = await context.adapter.findOne<AccessTokenRow>({
      model: 'oauthAccessToken',
      where: [{ field: 'token', value: digest(value) }],
    });
    if (
      !token?.userId ||
      token.revoked ||
      !(new Date(token.expiresAt).getTime() > Date.now()) ||
      !(token.resources ?? []).includes(resource)
    )
      return challenge(401, 'invalid_token');
    const [client, user] = await Promise.all([
      context.adapter.findOne<{ disabled?: boolean | null }>({
        model: 'oauthClient',
        where: [{ field: 'clientId', value: token.clientId }],
      }),
      context.adapter.findOne<{ id: string; emailVerified?: boolean | null }>({
        model: 'user',
        where: [{ field: 'id', value: token.userId }],
      }),
    ]);
    if (!client || client.disabled || !user?.emailVerified) return challenge(401, 'invalid_token');
    if (!(token.scopes ?? []).includes('fedreg:read')) return challenge(403, 'insufficient_scope');
    if (!(await store.allow(`mcp-user:${user.id}`, 600, 60))) return tooMany(res);
    const day = new Date().toISOString().slice(0, 10);
    if (!await store.allow(`mcp-day:${user.id}:${day}`, config.subjectDailyQuota ?? 10000, 86400)) return tooMany(res);
    Object.assign(req, {
      auth: {
        token: value,
        clientId: token.clientId,
        scopes: token.scopes,
        extra: { userId: user.id },
      },
    });
    await mcpNode(req, res);
  });
  // Clients look for authorization-server metadata in different places: RFC 8414 path
  // insertion for the /api/auth issuer (canonical, served by Better Auth), the issuer path with
  // /.well-known appended, or the origin root when a client skips protected-resource discovery.
  // Serve the same document at each. The openid-configuration URLs stay 404: this is not an
  // OpenID provider, and clients parse documents found there with the stricter OIDC schema.
  app.get(
    ['/.well-known/oauth-authorization-server', '/api/auth/.well-known/oauth-authorization-server'],
    async (_req, res) =>
      forwardResponse(
        await auth.handler(
          new Request(`${config.origin}/.well-known/oauth-authorization-server/api/auth`),
        ),
        res,
      ),
  );
  app.use(
    ['/api/auth', '/.well-known'],
    express.raw({ type: () => true, limit: '64kb' }),
    async (req, res) => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers))
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
      const ip = ipOf(req);
      if (ip) headers.set('x-forwarded-for', ip);
      else headers.delete('x-forwarded-for');
      const authUrl = new URL(req.originalUrl, config.origin);
      // WHATWG Request normalizes dot segments and backslashes. Reject aliases
      // before forwarding so Express guards and Better Auth see the same path.
      if (authUrl.origin !== config.origin || authUrl.pathname !== req.originalUrl.split('?')[0]) {
        return res.status(404).send('Not found');
      }
      let body = ['GET', 'HEAD'].includes(req.method) ? undefined : req.body;
      // MCP requires every redirect URI to be HTTPS or localhost. Check registrations here, and
      // authorization requests too, since Client ID Metadata Documents skip registration.
      const redirects =
        req.path === '/oauth2/register' && Buffer.isBuffer(body)
          ? registeredRedirects(body)
          : req.path === '/oauth2/authorize'
            ? [
                (req.method === 'POST' && Buffer.isBuffer(body)
                  ? new URLSearchParams(body.toString('utf8'))
                  : authUrl.searchParams
                ).get('redirect_uri'),
              ].filter(Boolean)
            : [];
      if (!Array.isArray(redirects) || !redirects.every(allowedRedirect))
        return res.status(400).json({
          error: req.path === '/oauth2/register' ? 'invalid_redirect_uri' : 'invalid_request',
          error_description: 'Redirect URIs must use HTTPS or a localhost address.',
        });
      // Clients that omit RFC 8707 `resource` (Gemini Enterprise may) would get tokens this
      // server cannot accept. It protects one resource, so default to it; the code keeps it.
      if (req.path === '/oauth2/authorize') {
        if (req.method === 'GET' && !authUrl.searchParams.get('resource'))
          authUrl.searchParams.set('resource', resource);
        if (
          req.method === 'POST' &&
          req.is('application/x-www-form-urlencoded') &&
          Buffer.isBuffer(body)
        ) {
          const form = new URLSearchParams(body.toString('utf8'));
          if (!form.get('resource')) form.set('resource', resource);
          body = Buffer.from(form.toString());
          headers.delete('content-length');
        }
      }
      const request = new Request(authUrl, {
        method: req.method,
        headers,
        body,
      });
      const execute = async () => {
        const response = await auth.handler(request);
        // Registration failures are otherwise invisible; log the outcome only, no request data.
        if (req.path === '/oauth2/register')
          log.info('client_registration', { status: response.status, crossOrigin: foreignOrigin(req) });
        return forwardResponse(response, res);
      };
      if (req.path !== '/oauth2/token' && req.path !== '/oauth2/revoke') return execute();
      // Serialize token-family rotation and invalidation across replicas. Better Auth's
      // current adapter performs those writes separately; overlapping requests must not
      // interleave. A family is every refresh token of one (client, user), so refresh and revoke
      // lock per user and a code exchange locks per code: unrelated users never queue together.
      // A code exchange can still overlap a family wipe for the same user; at worst that new
      // authorization is revoked and the user authorizes again.
      const lockId = await tokenLockId(Buffer.isBuffer(body) ? body : undefined);
      const lock = await locks.connect();
      // A transaction-scoped lock is released by COMMIT or ROLLBACK, and a bounded wait keeps one
      // stuck request from holding every lock connection and queueing all users' token requests.
      let broken = false;
      try {
        await lock.query('BEGIN');
        await lock.query(`SET LOCAL lock_timeout = '${LOCK_WAIT_MS}ms'`);
        await lock.query('SELECT pg_advisory_xact_lock($1)', [lockId]);
        await execute();
        await lock.query('COMMIT');
      } catch (error) {
        // A connection that cannot roll back may still hold the lock; discard it.
        await lock.query('ROLLBACK').catch(() => { broken = true; });
        throw error;
      } finally {
        lock.release(broken);
      }
    },
  );
  installPortal(app, config, store, auth, fetcher, ipOf);
  // Unknown paths: a person in a browser gets the portal's own not-found page (status 404);
  // API clients get the short text they always did.
  app.use(async (req, res) => {
    if (isNavigation(req)) return sendPortal(res, 404);
    res.status(404).send('Not found');
  });
  app.use(
    (error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      if (
        error &&
        typeof error === 'object' &&
        'type' in error &&
        ['entity.too.large', 'parameters.too.many'].includes(String(error.type))
      ) {
        if (!res.headersSent) res.status(413).send('Request too large');
        return;
      }
      log.error('account.request_failed');
      if (!res.headersSent)
        res
          .status(500)
          .json({ error: 'Unable to complete this request. Please try again.' });
    },
  );
  return {
    app,
    auth,
    mcp,
    close: async () => {
      await mcp.close();
      await publicMcp.close();
      await locks.end();
    },
  };
}
export async function forwardResponse(response: Response, res: express.Response) {
  res.status(response.status);
  for (const [name, value] of response.headers)
    if (name.toLowerCase() !== 'set-cookie') res.setHeader(name, value);
  const cookies = response.headers.getSetCookie();
  if (cookies.length) res.setHeader('Set-Cookie', cookies);
  res.send(Buffer.from(await response.arrayBuffer()));
}
