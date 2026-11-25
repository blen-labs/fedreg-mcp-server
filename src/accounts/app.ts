import express from 'express';
import { Pool, type PoolClient } from 'pg';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { stripAccessTokenAuthorizationScheme } from 'better-auth/oauth2';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { buildMcpServer, MCP_PROTOCOL_VERSION } from '../server/mcpServer.js';
import type { CatalogDeps } from '../server/toolCatalog.js';
import type { AccountConfig } from './config.js';
import { type Store } from './store.js';
import { createAuth, initializeAuth, type Auth } from './provider.js';
import { installPortal } from './portal.js';
import { digest } from './crypto.js';
import { log } from '../util/logger.js';
import { IpRateLimiter, bucketKey, clientIp } from '../server/ipRateLimiter.js';
import { originAllowed, bearerToken, MAX_REQUEST_BODY_BYTES } from '../server/http.js';
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
const FORM = 'application/x-www-form-urlencoded';
/** PostgreSQL's lock_not_available (lock_timeout) or the pool's connection wait running out. */
const isLockWaitTimeout = (error: unknown) =>
  (error as { code?: string })?.code === '55P03' ||
  /timeout exceeded when trying to connect/i.test(String((error as Error)?.message));
/** The lock key of a refresh family, which is every refresh token of one (client, user). */
export const familyLockKey = (clientId: string, userId: string) => `family:${clientId}:${userId}`;
/** pg_advisory_xact_lock takes a signed 64-bit key. */
export const advisoryId = (key: string) => BigInt.asIntN(64, BigInt(`0x${digest(key).slice(0, 16)}`)).toString();
/** Failed bearer checks per address: 2 each second, bursts of 120, far below the flood guard. */
const FAILED_TOKEN_RPS = 2;
const FAILED_TOKEN_BURST = 120;
/** Most /mcp/account token checks in flight per address, so the budget cannot be dodged by concurrency. */
const MAX_TOKEN_CHECKS_IN_FLIGHT = 256;
/** Token and revoke requests per address: 20 each second, bursts of 600. */
const TOKEN_REQUEST_RPS = 20;
const TOKEN_REQUEST_BURST = 600;

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
/** Redirect URIs in a registration body; malformed JSON is left for Better Auth to reject. */
function registeredRedirects(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString('utf8'))?.redirect_uris ?? [];
  } catch {
    return [];
  }
}
/** Fields of a POST body, whether form-encoded or JSON (either may reach Better Auth). */
function jsonOrForm(body: Buffer): { get(name: string): string | null } {
  const text = body.toString('utf8').trim();
  if (text.startsWith('{')) {
    try {
      const fields = JSON.parse(text) as Record<string, unknown>;
      return { get: name => { const v = fields[name]; return v === undefined || v === null ? null : String(v); } };
    } catch {
      // Not parseable: a value no redirect check accepts, so the request is refused here.
      return { get: () => 'invalid' };
    }
  }
  return new URLSearchParams(text);
}
/** Client-side routes of the portal (web/src/main.tsx), served as index.html. */
const PORTAL_ROUTES = ['/', '/sign-in', '/connect', '/consent', '/account', '/error'];
/** Portal routes with their own prerendered page in dist/web (web/vite.config.ts). */
const PRERENDERED_ROUTES: Record<string, string> = { '/privacy-policy': 'privacy-policy.html', '/terms': 'terms.html' };
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
  /** Test seams: shorten the token-lock wait, shrink the per-IP budgets. */
  limits: {
    lockWaitMs?: number;
    maxTokenChecksInFlight?: number;
    tokenRequestLimit?: { rps: number; burst: number };
    failedTokenLimit?: { rps: number; burst: number };
  } = {},
): Promise<{ app: express.Express; auth: Auth; mcp: ReturnType<typeof createMcpHandler>; close: () => Promise<void> }> {
  const app = express();
  app.disable('x-powered-by');
  // Railway terminates TLS at one trusted proxy hop.
  if (config.production) app.set('trust proxy', 1);
  // With `trust proxy` 1, req.ip is the rightmost X-Forwarded-For entry. Railway rebuilds that
  // header as "<client>, <edge>", so req.ip is its edge, shared by many users. The header the
  // proxy overwrites with the client address (Railway: x-real-ip) is used instead when set.
  const ipOf = (req: express.Request) => clientIp(req, config.clientIpHeader);
  const auth = createAuth(config, store);
  await initializeAuth(auth, config, store);
  // Each waiting token request holds a connection, so size this for concurrent token requests.
  const lockWaitMs = limits.lockWaitMs ?? LOCK_WAIT_MS;
  const locks = new Pool({ ...store.pool.options, max: config.authLockPoolSize ?? 10, connectionTimeoutMillis: lockWaitMs });
  locks.on('error', () => log.error('account.auth_lock_connection_error'));
  /**
   * The advisory lock for the operation Better Auth will execute for a /oauth2/token or
   * /oauth2/revoke request, chosen the way Better Auth reads the request: only a
   * form-urlencoded body is accepted (anything else is a 415 that changes nothing), a repeated
   * field takes its last value, and the grant decides which field matters. Revoke acts on
   * `token` (after any access-token scheme prefix is stripped), a refresh_token grant on
   * `refresh_token`, an authorization_code grant on `code`; other fields are ignored, as Better
   * Auth ignores them. Conflicting repeats of the grant or of the chosen field are refused
   * rather than guessed at.
   *
   * A refresh family is every refresh token of one (client, user), so a presented refresh or
   * access token locks on that pair: the same user's requests queue, other users and other
   * clients never do. An unknown token locks on itself and a code (single-use) on itself. With
   * nothing to serialize (client_credentials, unsupported grants, missing fields, other media
   * types) there is no lock. Tokens are stored as digests of their value.
   */
  const tokenLockId = async (
    path: string,
    contentType: string | undefined,
    body: Buffer | undefined,
  ): Promise<{ id?: string; reject?: true }> => {
    if (!body || contentType?.toLowerCase().split(';')[0]?.trim() !== FORM) return {};
    // Better Auth reads the body with URLSearchParams after dropping a leading BOM.
    const form = new URLSearchParams(body.toString('utf8').replace(/^\uFEFF/, ''));
    const field = (name: string) => {
      const values = form.getAll(name);
      return values.length > 1 && new Set(values).size > 1 ? null : (values.at(-1) ?? '');
    };
    // Better Auth takes the last of a repeated field, so a conflicting repeat of the grant
    // would otherwise run a different operation than the one locked for.
    const requested = field('grant_type');
    if (path !== '/oauth2/revoke' && requested === null) return { reject: true };
    const grant = path === '/oauth2/revoke' ? 'revoke' : requested?.trim();
    const name = grant === 'revoke' ? 'token'
      : grant === 'refresh_token' ? 'refresh_token'
      : grant === 'authorization_code' ? 'code'
      : undefined;
    if (!name) return {};
    let value = field(name);
    if (value === null) return { reject: true };
    if (name === 'token') value = stripAccessTokenAuthorizationScheme(value);
    if (!value) return {};
    if (name === 'code') return { id: advisoryId(`code:${value}`) };
    const { adapter } = await auth.$context;
    const where = [{ field: 'token', value: digest(value) }];
    const row = await adapter.findOne<{ userId?: string; clientId?: string }>({ model: 'oauthRefreshToken', where })
      ?? await adapter.findOne<{ userId?: string; clientId?: string }>({ model: 'oauthAccessToken', where });
    return { id: advisoryId(row?.userId && row.clientId ? familyLockKey(row.clientId, row.userId) : `token:${digest(value)}`) };
  };
  // Looking up the presented token costs database queries before any lock, and these routes
  // skip the page limiter, so each address gets a bounded budget sized for refresh traffic from
  // a connector's shared egress IP (Better Auth's own token limit is 1200 a minute).
  const tokenRequests = new IpRateLimiter(
    limits.tokenRequestLimit?.rps ?? TOKEN_REQUEST_RPS,
    limits.tokenRequestLimit?.burst ?? TOKEN_REQUEST_BURST,
  );
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
    // Hashed bundles under /assets set their own immutable Cache-Control; serve-static leaves an
    // existing header alone, so no-store here would defeat it.
    if (!req.path.startsWith('/assets/')) res.set('Cache-Control', 'no-store');
    res.set({
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
  // A missing bundle falls through here: the immutable header is only set on a file that exists.
  app.use('/assets', (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
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
  // Production reads each built page once; development rereads them so `pnpm dev:web` rebuilds show.
  const pages = new Map<string, string>();
  const loadPage = (file: string) => readFile(resolve(webRoot, file), 'utf8').catch(() => undefined);
  const sendPortal = async (res: express.Response, status = 200, file = 'index.html') => {
    const html = config.production ? (pages.get(file) ?? (await loadPage(file))) : await loadPage(file);
    if (!html) return res.status(503).send('The web interface is not built. Run pnpm build.');
    if (config.production) pages.set(file, html);
    res.status(status).set('Content-Security-Policy', PORTAL_CSP).type('html').send(html);
  };
  // The policy pages are prerendered at build time (web/prerender.ts), so their text is in the
  // HTML for clients that do not run JavaScript: crawlers, link checkers, directory reviewers.
  app.get(Object.keys(PRERENDERED_ROUTES), async (req, res) => {
    await sendPortal(res, 200, PRERENDERED_ROUTES[req.path.replace(/(?<=.)\/$/, '')]);
  });
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
      (req.path !== ACCOUNT_MCP_PATH || !!bearerToken(req.headers.authorization));
    if (!platform && !(await store.allow(`http:${bucketKey(ipOf(req))}`, 600, 60))) return tooMany(res);
    next();
  });
  const mcpNode = toNodeHandler(mcp, {
    maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
    onerror: () => log.warn('account.mcp_http_error'),
  });
  const publicNode = toNodeHandler(publicMcp, {
    maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
    onerror: () => log.warn('account.public_mcp_http_error'),
  });
  // In memory per replica, like the base transport's limiter it mirrors.
  const publicLimiter = new IpRateLimiter(config.ipRps ?? 5, config.ipBurst ?? 20);
  // Federal Register and eCFR need no sign-in. A bearer token sent here is ignored: signed-in
  // access, and regulations.gov with the user's own key, live at ACCOUNT_MCP_PATH.
  app.all(PUBLIC_MCP_PATH, async (req, res) => {
    if (!publicLimiter.allow(ipOf(req))) return tooMany(res);
    // MCP's Origin rule: with no token to check, another site's page must not drive this endpoint
    // (it runs code). Non-browser clients send no Origin and pass. The signed-in endpoint accepts
    // any Origin: hosted connectors (claude.ai, chatgpt.com) send theirs, every request carries a
    // bearer token (never a cookie), and the Host check above already blocks DNS rebinding.
    const origin = req.headers.origin;
    if (typeof origin === 'string' && !originAllowed(origin, config.origin, config.allowedOrigins ?? []))
      return res.status(403).json({ error: 'origin_not_allowed' });
    // toNodeHandler forwards req.auth to the factory; no token is involved.
    Object.assign(req, { auth: { token: '', clientId: 'anonymous', scopes: [], extra: { anonymousSubject: `anon:${bucketKey(ipOf(req))}` } } });
    await publicNode(req, res);
  });
  // No body parser: the SDK reads the body itself (capped by maxRequestBodySize, as in the base
  // HTTP transport) and only after the token checks below pass.
  const failedTokens = new IpRateLimiter(limits.failedTokenLimit?.rps ?? FAILED_TOKEN_RPS, limits.failedTokenLimit?.burst ?? FAILED_TOKEN_BURST);
  const tokenChecks = new Map<string, number>();
  const maxTokenChecks = limits.maxTokenChecksInFlight ?? MAX_TOKEN_CHECKS_IN_FLIGHT;
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
    const value = bearerToken(authorization);
    if (!value || authorization!.length > 4096) return challenge(401, 'invalid_token');
    const ip = ipOf(req);
    // Counted like the failed-token budget: an IPv6 /64 is one client, however many addresses.
    const checkKey = bucketKey(ip);
    // Any bearer value skips the per-IP limit in the middleware above, so tokens that fail the
    // checks below are limited here, in memory: past the limit a made-up token costs no database
    // round trip. Only a token proven invalid spends the budget (a valid one, a database error or
    // another limit does not), and a cap on checks in flight bounds what concurrent requests can
    // do before their failures are counted.
    if (!failedTokens.available(ip) || (tokenChecks.get(checkKey) ?? 0) >= maxTokenChecks) return tooMany(res);
    const rejected = () => {
      failedTokens.spend(ip);
      return challenge(401, 'invalid_token');
    };
    tokenChecks.set(checkKey, (tokenChecks.get(checkKey) ?? 0) + 1);
    const checked = await (async () => {
      // A flood guard sized for a connector's shared IP; the per-user limit below does the real work.
      if (!(await store.allow(`mcp-ip:${checkKey}`, 6000, 60))) return void tooMany(res);
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
        return void rejected();
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
      if (!client || client.disabled || !user?.emailVerified) return void rejected();
      return { token, user };
    })().finally(() => {
      const left = (tokenChecks.get(checkKey) ?? 1) - 1;
      if (left > 0) tokenChecks.set(checkKey, left);
      else tokenChecks.delete(checkKey);
    });
    if (!checked) return;
    const { token, user } = checked;
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
      // Forward only the client address chosen above, never a caller-supplied chain.
      const ip = ipOf(req);
      headers.set('x-forwarded-for', ip);
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
                  ? jsonOrForm(body)
                  : authUrl.searchParams
                ).get('redirect_uri'),
              ].filter(Boolean)
            : [];
      if (!Array.isArray(redirects) || !redirects.every(allowedRedirect))
        return res.status(400).json({
          error: req.path === '/oauth2/register' ? 'invalid_redirect_uri' : 'invalid_request',
          error_description: 'Redirect URIs must use HTTPS or a localhost address.',
        });
      // Desktop MCP clients register loopback redirects (http://127.0.0.1:<port>/callback, RFC 8252)
      // and often omit `application_type`, which OpenID DCR defaults to "web" (HTTPS only), so the
      // registration would fail. All-loopback-HTTP registrations are native apps: say so.
      if (
        req.path === '/oauth2/register' &&
        Buffer.isBuffer(body) &&
        redirects.length > 0 &&
        (redirects as string[]).every(uri => new URL(uri).protocol === 'http:')
      ) {
        try {
          const parsed = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
          if (parsed && typeof parsed === 'object' && parsed.application_type === undefined) {
            body = Buffer.from(JSON.stringify({ ...parsed, application_type: 'native' }));
            headers.delete('content-length');
          }
        } catch {
          // Malformed JSON: Better Auth rejects it.
        }
      }
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
        if (req.method === 'POST' && req.is('application/json') && Buffer.isBuffer(body)) {
          try {
            const parsed = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && !parsed.resource) {
              body = Buffer.from(JSON.stringify({ ...parsed, resource }));
              headers.delete('content-length');
            }
          } catch {
            // Malformed JSON: Better Auth rejects it.
          }
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
      // interleave. A refresh and a revoke lock per (client, user) and a code exchange per code,
      // so unrelated users never queue together. A code exchange can still overlap a family wipe
      // for the same user; at worst that new authorization is revoked and the user authorizes again.
      if (!tokenRequests.allow(ip)) return tooMany(res);
      const selected = await tokenLockId(req.path, req.get('content-type'), Buffer.isBuffer(body) ? body : undefined);
      if (selected.reject)
        return res.status(400).json({ error: 'invalid_request', error_description: 'Conflicting values for a repeated parameter.' });
      if (selected.id === undefined) return execute();
      // Too busy to take the lock in time: the client should retry, not see a server fault.
      const busy = () => res.status(503).set('Retry-After', '1').json({ error: 'temporarily_unavailable' });
      let lock: PoolClient;
      try {
        lock = await locks.connect();
      } catch (error) {
        if (isLockWaitTimeout(error)) return busy();
        throw error;
      }
      // A transaction-scoped lock is released by COMMIT or ROLLBACK, and a bounded wait keeps one
      // stuck request from holding every lock connection and queueing all users' token requests.
      let broken = false;
      try {
        await lock.query('BEGIN');
        await lock.query(`SET LOCAL lock_timeout = '${lockWaitMs}ms'`);
        try {
          await lock.query('SELECT pg_advisory_xact_lock($1)', [selected.id]);
        } catch (error) {
          if (!isLockWaitTimeout(error)) throw error;
          await lock.query('ROLLBACK').catch(() => { broken = true; });
          return busy();
        }
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
