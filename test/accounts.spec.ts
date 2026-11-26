import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Agent, createServer, get as httpGet, request as httpRequest, type Server } from 'node:http';
import { createServer as createNetServer, type AddressInfo, type Socket } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { testUtils } from 'better-auth/plugins';
import fetchCookie from 'fetch-cookie';
import { CookieJar } from 'tough-cookie';
import { MockAgent } from 'undici';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Keyring, randomToken, digest } from '../src/accounts/crypto.js';
import { AccessTokenFormat } from '../src/accounts/token-admission.js';
import { Store, personalOwner } from '../src/accounts/store.js';
import { createAccountApp, allowedRedirect, advisoryId, userLockKey } from '../src/accounts/app.js';
import { accountDependencies, publicDependencies } from '../src/accounts/runtime.js';
import { loadAccountConfig, type AccountConfig } from '../src/accounts/config.js';
import { checkKey } from '../src/accounts/portal.js';
import { buildSupervisor, type SupervisorConfig } from '../src/supervisor/index.js';

it('encrypts keys with random nonces and binds ciphertext to its account and purpose', () => {
  const keys = { old: randomBytes(32), next: randomBytes(32) };
  const ring = new Keyring('old', keys);
  const sealed = ring.seal('secret', 'regulations.gov:user:a');
  expect(ring.seal('secret', 'regulations.gov:user:a')).not.toEqual(sealed);
  expect(JSON.stringify(sealed)).not.toContain('secret');
  expect(ring.open(sealed, 'regulations.gov:user:a')).toBe('secret');
  expect(() => ring.open(sealed, 'regulations.gov:user:b')).toThrow();
  expect(() => ring.open(sealed, 'oauth:user:a')).toThrow();
  expect(() => ring.open({ ...sealed, data: 'AAAA' }, 'regulations.gov:user:a')).toThrow();
  // A truncated (still valid-prefix) tag must not be accepted.
  const shortTag = Buffer.from(sealed.tag, 'base64').subarray(0, 4).toString('base64');
  expect(() => ring.open({ ...sealed, tag: shortTag }, 'regulations.gov:user:a')).toThrow();
  expect(new Keyring('next', keys).open(sealed, 'regulations.gov:user:a')).toBe('secret');
});

it('sizes the OAuth token-lock pool from configuration', () => {
  const env = { FEDREG_PUBLIC_ORIGIN: 'https://example.com', BETTER_AUTH_SECRET: 's'.repeat(32), DATABASE_URL: 'postgres://x', GOOGLE_CLIENT_ID: 'g', GOOGLE_CLIENT_SECRET: 's',
    ENCRYPTION_ACTIVE_KEY_ID: 'k', ENCRYPTION_KEYS_JSON: JSON.stringify({ k: randomBytes(32).toString('base64') }) };
  expect(loadAccountConfig({ ...env, FEDREG_AUTH_LOCK_POOL_SIZE: '25' }).authLockPoolSize).toBe(25);
  expect(loadAccountConfig(env).authLockPoolSize).toBeUndefined();
  for (const bad of ['1', '201', 'ten', '2.5']) expect(() => loadAccountConfig({ ...env, FEDREG_AUTH_LOCK_POOL_SIZE: bad })).toThrow(/FEDREG_AUTH_LOCK_POOL_SIZE/);
});

it('rejects unsafe origins, missing secrets, and unsafe OAuth redirects', () => {
  expect(() => loadAccountConfig({})).toThrow();
  const invalid = { FEDREG_PUBLIC_ORIGIN: 'https://example.com', BETTER_AUTH_SECRET: 's'.repeat(32), ENCRYPTION_KEYS_JSON: '{"key":"sensitive-key-material"' };
  try { loadAccountConfig(invalid); throw new Error('Expected invalid JSON to fail'); }
  catch (error) { expect(String(error)).not.toContain('sensitive-key-material'); expect(String(error)).toContain('must be valid JSON'); }
  // eslint-disable-next-line no-script-url -- asserting that a javascript: redirect is refused
  for (const url of ['http://evil.example/cb', 'javascript:alert(1)', 'https://user:pass@example.com', 'https://example.com/#fragment']) expect(allowedRedirect(url)).toBe(false);
  expect(allowedRedirect('https://claude.ai/api/mcp/auth_callback')).toBe(true);
  expect(allowedRedirect('http://127.0.0.1:1234/cb')).toBe(true);
});

it('validates keys only at regulations.gov and preserves safe errors', async () => {
  const key = 'k'.repeat(40);
  expect(await checkKey('bad')).toMatch(/40-character/);
  expect(await checkKey(key, async (url, init) => {
    expect(String(url)).toBe('https://api.regulations.gov/v4/documents?page[size]=5');
    expect(new Headers(init?.headers).get('X-Api-Key')).toBe(key);
    expect(init?.redirect).toBe('error');
    return new Response(null, { status: 200 });
  })).toBeUndefined();
  expect(await checkKey(key, async () => new Response(key, { status: 403 }))).toMatch(/rejected this key.*preserved/);
  expect(await checkKey(key, async () => new Response(key, { status: 400 }))).toMatch(/connection check failed.*preserved/);
  expect(await checkKey(key, async () => { throw new Error(key); })).not.toContain(key);
});

it('keeps the shared regs key on the anonymous endpoint when one is configured, else points to sign-in', () => {
  const meta = [{ name: 'regs', label: 'Regulations.gov', enabled: false }];
  const base = { sdk: { methods: {}, meta, clients: {}, registeredNames: ['regs'], version: () => '0' } } as unknown as Parameters<typeof publicDependencies>[0];
  expect(publicDependencies(base, 'https://x.example').sdk.meta[0]).toMatchObject({ enabled: false, disabledReason: expect.stringContaining('https://x.example/mcp/account') });
  const keyed = { ...base, sdk: { ...base.sdk, methods: { regs: {} } } } as typeof base;
  expect(publicDependencies(keyed, 'https://x.example')).toBe(keyed);
});

it('never lets the shared regs key reach the signed-in catalog', async () => {
  const cfg: SupervisorConfig = {
    frBaseUrl: 'https://www.federalregister.gov/api/v1', ecfrBaseUrl: 'https://www.ecfr.gov/api',
    regsBaseUrl: 'https://api.regulations.gov', regsApiKey: 'shared-operator-key', userAgent: 'test',
    upstreamTimeoutMs: 2000, upstreamRetries: 0, cacheTtlMs: 60000, cacheMaxItems: 10,
    sandbox: 'deno', regsMaxCallsPerExecute: 30, regsRatePerHour: 1000, regsSubjectRatePerHour: 500,
  };
  const deps = await buildSupervisor(cfg);
  expect(deps.sdk.methods.regs).toBeDefined();
  // A user with no saved key: regs must ask for one, never fall back to the shared key.
  const noKey = { getKey: async () => undefined } as unknown as Store;
  const account = accountDependencies(deps, cfg, noKey);
  expect(account.sdk.methods.regs).toBeUndefined();
  expect(account.sdk.clients.regs).toBeUndefined();
  const sdk = await account.sdkForSubject!('user-1');
  await expect(sdk.methods.regs!['documents.search']!()).rejects.toMatchObject({ name: 'SourceUnavailable' });
  expect(publicDependencies(deps, 'https://x.example')).toBe(deps);
});

/** Counts key reads, to check that fr/ecfr-only executions never touch the credential store. */
class CountingStore extends Store {
  keyReads = 0;
  override async getKey(owner: string) {
    this.keyReads++;
    return super.getKey(owner);
  }
}

const database = process.env.TEST_DATABASE_URL;
describe.skipIf(!database)('account HTTP / OAuth with PostgreSQL', () => {
  let pool: Pool, store: CountingStore, server: Server, config: AccountConfig, docsRoot: string;
  let service: Awaited<ReturnType<typeof createAccountApp>>;
  let build: (over?: Partial<AccountConfig>, limits?: Parameters<typeof createAccountApp>[5], onStore?: Store) => ReturnType<typeof createAccountApp>;
  let helper: ReturnType<ReturnType<typeof testUtils>['init']>['context']['test'];
  let alice: any, bob: any, browser: typeof fetch, other: typeof fetch;
  let validationStatus = 200;
  const schema = `fedreg_test_${randomBytes(8).toString('hex')}`;
  const key = 'a'.repeat(40), key2 = 'b'.repeat(40);
  let mock: MockAgent;
  const cfg: SupervisorConfig = {
    frBaseUrl: 'https://www.federalregister.gov/api/v1', ecfrBaseUrl: 'https://www.ecfr.gov/api',
    regsBaseUrl: 'https://evil.example', regsApiKey: 'legacy-shared-key', userAgent: 'test',
    upstreamTimeoutMs: 2000, upstreamRetries: 0, cacheTtlMs: 60000, cacheMaxItems: 10,
    sandbox: 'deno', regsMaxCallsPerExecute: 30, regsRatePerHour: 1000, regsSubjectRatePerHour: 500,
  };
  const send = (client: typeof fetch, path: string, body: object, origin?: string) => client(`${config.origin}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: origin ?? config.origin }, body: JSON.stringify(body),
  });
  async function login(userId: string) {
    const logged = await helper.login({ userId });
    const jar = new CookieJar();
    for (const cookie of logged.cookies) await jar.setCookie(`${cookie.name}=${cookie.value}; Path=/`, config.origin);
    return fetchCookie(fetch, jar) as typeof fetch;
  }
  function signedQuery(url: string) {
    const params = new URL(url, config.origin).searchParams;
    const names = new Set(params.getAll('ba_param'));
    const out = new URLSearchParams();
    for (const [k, v] of params) if (k === 'sig' || k === 'ba_param' || names.has(k)) out.append(k, v);
    return out.toString();
  }
  async function register(method = 'none') {
    const response = await send(fetch, '/api/auth/oauth2/register', {
      client_name: 'Test assistant', redirect_uris: ['https://client.example/callback'],
      token_endpoint_auth_method: method, grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
    });
    expect(response.status, await response.clone().text()).toBe(201);
    return await response.json() as any;
  }
  async function beginAuthorization(clientBrowser = browser, method = 'none') {
    const client = await register(method);
    const verifier = randomToken();
    const state = randomToken();
    const query = new URLSearchParams({
      client_id: client.client_id, redirect_uri: client.redirect_uris[0], response_type: 'code',
      scope: 'fedreg:read offline_access', resource: `${config.origin}/mcp/account`,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', state,
    });
    let response = await clientBrowser(`${config.origin}/api/auth/oauth2/authorize?${query}`, {
      headers: { Accept: 'text/html', 'Sec-Fetch-Mode': 'navigate' },
    });
    if (response.headers.get('content-type')?.includes('application/json')) {
      const result = await response.json() as any;
      expect(result.redirect, JSON.stringify(result)).toBe(true);
      response = await clientBrowser(new URL(result.url, config.origin));
    }
    expect(new URL(response.url).pathname).toBe('/connect');
    return { client, verifier, state, oauth_query: signedQuery(response.url) };
  }
  async function authorize(clientBrowser = browser, accept = true, method = 'none') {
    const { client, verifier, state, oauth_query: connectQuery } = await beginAuthorization(clientBrowser, method);
    const connect = await send(clientBrowser, '/api/portal/connect', { oauth_query: connectQuery, decision: 'continue' });
    expect(connect.status, await connect.clone().text()).toBe(200);
    const consentUrl = new URL((await connect.json() as any).url);
    expect(consentUrl.pathname).toBe('/consent');
    const oauth_query = signedQuery(consentUrl.toString());
    const info = await clientBrowser(`${config.origin}/api/portal/consent?oauth_query=${encodeURIComponent(oauth_query)}`);
    expect(info.status).toBe(200);
    const consent = await send(clientBrowser, '/api/portal/consent', { oauth_query, accept });
    expect(consent.status, await consent.clone().text()).toBe(200);
    const callback = new URL((await consent.json() as any).url);
    expect(callback.origin).toBe('https://client.example');
    expect(callback.searchParams.get('state')).toBe(state);
    return { client, verifier, code: callback.searchParams.get('code'), callback };
  }
  const exchange = (clientId: string, body: Record<string, string>) => fetch(`${config.origin}/api/auth/oauth2/token`, {
    method: 'POST', body: new URLSearchParams({ client_id: clientId, ...body }),
  });
  async function token(clientBrowser = browser) {
    const a = await authorize(clientBrowser);
    const response = await exchange(a.client.client_id, { grant_type: 'authorization_code', code: a.code!, code_verifier: a.verifier, redirect_uri: a.client.redirect_uris[0] });
    expect(response.status, await response.clone().text()).toBe(200);
    return { ...await response.json() as any, clientId: a.client.client_id };
  }
  async function mcp(token: string | undefined, code = 'return 42;', path = '/mcp/account', origin?: string, ip?: string) {
    const response = await fetch(`${config.origin}${path}`, {
      method: 'POST', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(origin ? { origin } : {}), ...(ip ? { 'x-real-ip': ip } : {}), 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'Mcp-Method': 'tools/call', 'Mcp-Name': 'execute', 'Mcp-Protocol-Version': '2026-07-28' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'execute', arguments: { code }, _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'auth-test', version: '1' }, 'io.modelcontextprotocol/clientCapabilities': {},
      } } }),
    });
    return { status: response.status, body: await response.text() };
  }
  /** Issues and verifies tokens like the server does (same secret), for forging MAC-valid ones. */
  let accessTokens: AccessTokenFormat;
  /** `count` further valid tokens for the same grant: each a distinct, MAC-valid value with its own database row. */
  async function validTokens(access: string, count: number, make: () => string = () => accessTokens.generate()) {
    const { adapter } = await service.auth.$context;
    const row = await adapter.findOne<Record<string, unknown>>({ model: 'oauthAccessToken', where: [{ field: 'token', value: digest(access) }] });
    expect(row).toBeTruthy();
    const { id: _id, ...data } = row!;
    const created = Array.from({ length: count }, make);
    for (const value of created) await adapter.create({ model: 'oauthAccessToken', data: { ...data, token: digest(value) } });
    return created;
  }
  /** At most 32 sockets at once: hundreds of simultaneous connects overflow the listen backlog on some systems. */
  const agent = new Agent({ keepAlive: true, maxSockets: 32 });
  const rawPost = (token: string, ip: string) => new Promise<number>((resolve, reject) => {
    const request = httpRequest(`${config.origin}/mcp/account`, { method: 'POST', agent, headers: { authorization: `Bearer ${token}`, 'x-real-ip': ip } }, response => {
      response.resume();
      response.on('end', () => resolve(response.statusCode!));
    });
    request.on('error', reject);
    request.end();
  });
  /** A token of a confidential client (it can introspect), with its secret. */
  async function confidentialToken() {
    const a = await authorize(browser, true, 'client_secret_post');
    const secret = a.client.client_secret as string;
    expect(secret).toBeTruthy();
    const response = await exchange(a.client.client_id, { grant_type: 'authorization_code', code: a.code!, code_verifier: a.verifier, redirect_uri: a.client.redirect_uris[0], client_secret: secret });
    expect(response.status, await response.clone().text()).toBe(200);
    return { ...await response.json() as any, clientId: a.client.client_id as string, secret };
  }
  beforeAll(async () => {
    const admin = new Pool({ connectionString: database });
    await admin.query(`CREATE SCHEMA ${schema}`); await admin.end();
    pool = new Pool({ connectionString: database, options: `-c search_path=${schema}` });
    store = new CountingStore(pool, new Keyring('v1', { v1: randomBytes(32) }));
    await store.initialize();
    // A minimal built docs site: /docs must be wired with its own CSP inside the account app.
    docsRoot = mkdtempSync(join(tmpdir(), 'fedreg-docs-'));
    writeFileSync(join(docsRoot, 'index.html'), '<html><script>window.docs=1</script><title>Docs</title></html>');
    server = createServer();
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    config = { origin: `http://127.0.0.1:${(server.address() as any).port}`, production: false,
      databaseUrl: database!, authSecret: randomToken(), googleClientId: 'fixture-google', googleClientSecret: 'fixture-secret', keyring: new Keyring('v1', { v1: randomBytes(32) }),
      clientIpHeader: 'x-real-ip', docsRoot };
    const deps = await buildSupervisor(cfg);
    expect(await deps.sandbox.available(), 'Deno is required for account integration tests').toBe(true);
    // Upstream regulations.gov calls go through an injected MockAgent, never the global dispatcher.
    mock = new MockAgent(); mock.disableNetConnect();
    // The anonymous endpoint gets no shared key here, so regs there must point to sign-in.
    const publicDeps = publicDependencies(await buildSupervisor({ ...cfg, regsApiKey: undefined }), config.origin);
    build = (over, limits, onStore = store) => createAccountApp({ ...config, ...over }, onStore, accountDependencies(deps, cfg, onStore, mock), async () => new Response(null, { status: validationStatus }), publicDeps, limits);
    service = await build();
    server.on('request', service.app);
    accessTokens = new AccessTokenFormat(config.authSecret);
    helper = testUtils().init((await service.auth.$context) as unknown as Parameters<ReturnType<typeof testUtils>['init']>[0]).context.test;
    alice = await helper.saveUser(helper.createUser({ email: 'alice@example.test', emailVerified: true }));
    bob = await helper.saveUser(helper.createUser({ email: 'bob@example.test', emailVerified: true }));
    browser = await login(alice.id); other = await login(bob.id);
  });
  afterAll(async () => {
    await mock?.close(); await service?.close();
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    if (docsRoot) rmSync(docsRoot, { recursive: true, force: true });
    if (pool) { await pool.query(`DROP SCHEMA ${schema} CASCADE`); await pool.end(); }
  });
  it('discovers OAuth, challenges anonymous callers, and offers Google sign-in', async () => {
    const metadata = await fetch(`${config.origin}/.well-known/oauth-protected-resource/mcp/account`);
    expect(metadata.status).toBe(200);
    expect(await metadata.json()).toMatchObject({ resource: `${config.origin}/mcp/account` });
    const challenge = await fetch(`${config.origin}/mcp/account`, { method: 'POST' });
    expect(challenge.status).toBe(401);
    expect(challenge.headers.get('www-authenticate')).toContain(`resource_metadata="${config.origin}/.well-known/oauth-protected-resource/mcp/account"`);
    const discovery = await fetch(`${config.origin}/.well-known/oauth-authorization-server`);
    expect(await discovery.json()).toMatchObject({ authorization_endpoint: `${config.origin}/api/auth/oauth2/authorize` });
    expect((await mcp('invalid')).status).toBe(401);
    const google = await send(fetch, '/api/auth/sign-in/social', { provider: 'google', callbackURL: '/account' });
    expect(google.status, await google.clone().text()).toBe(200);
    expect(new URL((await google.json() as any).url).hostname).toBe('accounts.google.com');
  });
  it('serves the documentation site at /docs with its own CSP, behind the Host check', async () => {
    const moved = await fetch(`${config.origin}/docs?q=1`, { redirect: 'manual' });
    expect(moved.status).toBe(301);
    expect(moved.headers.get('location')).toBe('/docs/?q=1');
    const page = await fetch(`${config.origin}/docs/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<title>Docs</title>');
    // The docs policy replaces the portal's, and allows the inline script only by its hash.
    expect(page.headers.get('content-security-policy')).toContain(`'sha256-${createHash('sha256').update('window.docs=1').digest('base64')}'`);
    expect(page.headers.get('cache-control')).toBe('public, max-age=300');
    // fetch cannot set Host (a forbidden header), so the rebinding check goes through node:http.
    const { port } = new URL(config.origin);
    const status = await new Promise<number | undefined>((resolve, reject) =>
      httpGet({ host: '127.0.0.1', port, path: '/docs/', headers: { host: 'evil.example' } }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject));
    expect(status).toBe(421);
  });
  // Needs the Vite bundle: `pnpm build` (CI builds before testing). Skipped, not failed, without it.
  const webBuilt = existsSync(new URL('../dist/web/index.html', import.meta.url));
  it.skipIf(!webBuilt)('serves the SAM.gov-style frontend and policies with same-origin assets (needs pnpm build)', async () => {
    for (const path of ['/', '/sign-in', '/account', '/connect', '/consent', '/privacy-policy', '/terms', '/error']) {
      const page = await fetch(`${config.origin}${path}`);
      expect(page.status).toBe(200);
      expect(page.headers.get('content-security-policy')).toContain("script-src 'self'");
      const html = await page.text();
      const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map(match => match[1]);
      expect(assets.length).toBeGreaterThanOrEqual(2);
      for (const asset of assets) {
        const response = await fetch(`${config.origin}${asset}`);
        expect(response.status).toBe(200);
        // Drain static bundles so Undici can close its pooled connections.
        await response.arrayBuffer();
      }
    }
    expect(await (await fetch(`${config.origin}/api/portal/config`)).json()).toMatchObject({ google: true, email: false });
    // An unknown path: a browser navigation gets the portal's not-found page with status 404;
    // an API client keeps the short text answer.
    // fetch() always sends `sec-fetch-mode: cors`, so send a browser navigation with node:http.
    const { port } = new URL(config.origin);
    const missing = await new Promise<{ status?: number; type?: string; body: string }>((resolve, reject) =>
      httpGet({ host: '127.0.0.1', port, path: '/no-such-page', headers: { host: new URL(config.origin).host, 'sec-fetch-mode': 'navigate', accept: 'text/html' } }, (res) => {
        let body = '';
        res.setEncoding('utf8').on('data', (chunk: string) => (body += chunk)).on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body }));
      }).on('error', reject));
    expect(missing.status).toBe(404);
    expect(missing.type).toContain('text/html');
    expect(missing.body).toContain('/assets/');
    const api = await fetch(`${config.origin}/no-such-page`, { headers: { accept: 'application/json' } });
    expect(api.status).toBe(404);
    expect(await api.text()).toBe('Not found');
  });
  // The policy URLs are registered as the connector's privacy policy, so their text must be in the
  // HTML itself (web/prerender.ts), not only rendered by the script. node:http: no JavaScript runs.
  it.skipIf(!webBuilt)('serves the policy pages with their text in the HTML, without running JavaScript (needs pnpm build)', async () => {
    const { port, host } = new URL(config.origin);
    const get = (path: string) => new Promise<{ status?: number; csp?: string | string[]; body: string }>((resolve, reject) =>
      httpGet({ host: '127.0.0.1', port, path, headers: { host } }, (res) => {
        let body = '';
        res.setEncoding('utf8').on('data', (chunk: string) => (body += chunk)).on('end', () => resolve({ status: res.statusCode, csp: res.headers['content-security-policy'], body }));
      }).on('error', reject));
    const pages = [
      { path: '/privacy-policy', title: 'Privacy policy', source: 'privacy-policy.md' },
      { path: '/terms', title: 'Terms of service', source: 'terms.md' },
    ];
    const plain = (html: string) => {
      // Strip tags until none are left: one pass can leave a tag assembled from the pieces around a removed one.
      let text = html;
      for (let prev = ''; prev !== text; ) { prev = text; text = text.replace(/<[^>]*>/g, ''); }
      return text.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&amp;/g, '&');
    };
    for (const { path, title, source } of pages) {
      const headings = [...readFileSync(new URL(`../legal/${source}`, import.meta.url), 'utf8').matchAll(/^## (.+)$/gm)].map((m) => m[1]!);
      expect(headings.length).toBeGreaterThan(3);
      for (const url of [path, `${path}/`]) {
        const page = await get(url);
        expect(page.status, url).toBe(200);
        expect(page.csp).toContain("script-src 'self'");
        expect(page.body).toMatch(new RegExp(`<title>${title} · `));
        expect(page.body).toMatch(new RegExp(`<h1[^>]*>${title}</h1>`));
        expect(page.body).toContain('<main id="main"');
        const text = plain(page.body);
        for (const heading of headings) expect(text, heading).toContain(heading);
        expect(page.body).toContain('<script type="module"');
        expect(page.body).not.toMatch(/<script(?![^>]*\bsrc=)/);
      }
    }
  });
  it('validates the separate connection step, preserves saved keys on failure, and allows cancellation', async () => {
    const { oauth_query, state } = await beginAuthorization();
    const payload = { oauth_query, decision: 'continue' };
    expect((await send(fetch, '/api/portal/connect', payload)).status).toBe(401);
    expect((await send(browser, '/api/portal/connect', payload, 'https://evil.example')).status).toBe(403);
    expect((await send(browser, '/api/portal/connect', { ...payload, oauth_query: `${oauth_query}&client_id=attacker` })).status).toBe(400);
    expect((await send(browser, '/api/portal/connect', { ...payload, owner: personalOwner(bob.id) })).status).toBe(400);
    // Not about a typed key: no field, so the page shows a notice instead of a field error.
    const expired = await send(browser, '/api/portal/connect', { ...payload, oauth_query: `${oauth_query}&client_id=attacker` });
    expect(await expired.json()).toEqual({ error: 'Connection authorization failed.' });
    const info = await browser(`${config.origin}/api/portal/connect?oauth_query=${encodeURIComponent(oauth_query)}`);
    expect(await info.json()).toMatchObject({ email: alice.email, client: 'Test assistant', personal: { connected: false } });
    expect((await send(browser, '/api/portal/connect', { ...payload, apiKey: key })).status).toBe(200);
    expect(await store.getKey(personalOwner(alice.id))).toBe(key);
    validationStatus = 403;
    const rejectedOnConnect = await send(browser, '/api/portal/connect', { ...payload, apiKey: 'z'.repeat(40) });
    expect(rejectedOnConnect.status).toBe(400);
    expect((await rejectedOnConnect.json() as any).field).toBe('apiKey');
    validationStatus = 200;
    expect(await store.getKey(personalOwner(alice.id))).toBe(key);
    const denied = await send(browser, '/api/portal/connect', { oauth_query, decision: 'deny' });
    expect(denied.status, await denied.clone().text()).toBe(200);
    const callback = new URL((await denied.json() as any).url);
    expect(callback.searchParams.get('error')).toBe('access_denied');
    expect(callback.searchParams.get('state')).toBe(state);
    await store.deleteKey(personalOwner(alice.id), alice.id);
    // Keep unrelated rate-limit tests independent of this flow's validation attempts.
    await pool.query('DELETE FROM request_limits');
  });
  it('isolates saved keys, rejects CSRF and owner injection, and preserves keys on failed replacement', async () => {
    expect((await send(fetch, '/api/portal/keys', { apiKey: key })).status).toBe(401);
    expect((await send(browser, '/api/portal/keys', { apiKey: key }, 'https://evil.example')).status).toBe(403);
    expect((await send(browser, '/api/portal/keys', { apiKey: key, owner: personalOwner(bob.id) })).status).toBe(400);
    expect((await send(browser, '/api/portal/keys', { apiKey: key })).status).toBe(200);
    expect((await send(other, '/api/portal/keys', { apiKey: key2 })).status).toBe(200);
    expect(await store.getKey(personalOwner(alice.id))).toBe(key);
    const rows = await pool.query('SELECT ciphertext FROM credentials');
    expect(JSON.stringify(rows.rows)).not.toContain(key);
    expect(await (await browser(`${config.origin}/api/portal/account`)).text()).not.toContain(key);
    validationStatus = 403;
    const rejected = await send(browser, '/api/portal/keys', { apiKey: 'z'.repeat(40) });
    expect(rejected.status).toBe(400);
    expect((await rejected.json() as any).field).toBe('apiKey');
    // A missing key is about the key field too.
    const missing = await send(browser, '/api/portal/keys', {});
    expect(missing.status).toBe(400);
    expect((await missing.json() as any).field).toBe('apiKey');
    validationStatus = 200;
    expect(await store.getKey(personalOwner(alice.id))).toBe(key);
  });
  it('keys per-IP limits on the trusted client header, not the proxy address', async () => {
    const bucket = async (key: string) => (await pool.query('SELECT count FROM request_limits WHERE bucket=$1', [digest(key)])).rows[0]?.count;
    for (const ip of ['203.0.113.5', '203.0.113.5', '198.51.100.7'])
      expect((await fetch(`${config.origin}/mcp/account`, { method: 'POST', headers: { authorization: 'Bearer nope', 'x-real-ip': ip } })).status).toBe(401);
    // On Railway, req.ip would be the shared edge address; each client gets its own bucket instead.
    // ('nope' is a legacy-shaped token, which has its own flood key in release 1.)
    expect(await bucket('mcp-ip-legacy:203.0.113.5')).toBe(2);
    expect(await bucket('mcp-ip-legacy:198.51.100.7')).toBe(1);
  });
  it('serves Federal Register and eCFR at /mcp without sign-in, and points regs to /mcp/account', async () => {
    const anonymous = await mcp(undefined, 'return 42;', '/mcp');
    expect(anonymous.status).toBe(200);
    expect(anonymous.body).toContain('42');
    // A bearer token is not required, and one sent here is ignored rather than checked.
    expect((await mcp('not-a-token', 'return 7;', '/mcp')).body).toContain('7');
    // MCP's Origin rule, as in the base transport: other sites' browsers are refused.
    expect((await fetch(`${config.origin}/mcp`, { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' })).status).toBe(403);
    // One anonymous client address is one subject: past the per-subject cap it gets Busy, while
    // another address still runs.
    const slow = 'const t = Date.now(); while (Date.now() - t < 1500) {} return "done";';
    const sameClient = await Promise.all([1, 2, 3].map(() => mcp(undefined, slow, '/mcp', undefined, '203.0.113.40')));
    expect(sameClient.filter(r => r.body.includes('Busy')).length).toBeGreaterThanOrEqual(1);
    expect((await mcp(undefined, 'return 9;', '/mcp', undefined, '203.0.113.41')).body).toContain('9');
    // The `${...}` is sandbox source (a template literal that runs inside execute), not a typo.
    // eslint-disable-next-line no-template-curly-in-string
    const regs = await mcp(undefined, 'try { await regs.documents.search(); } catch (e) { return `${e.name}: ${e.message}`; }', '/mcp');
    expect(regs.body).toContain('SourceUnavailable');
    expect(regs.body).toContain(`${config.origin}/mcp/account`);
    expect(await (await fetch(`${config.origin}/api/portal/config`)).json()).toMatchObject({
      mcpUrl: `${config.origin}/mcp/account`, publicMcpUrl: `${config.origin}/mcp`,
    });
  });
  it('signs out mid-connection the way the Sign out button does, ending that session only', async () => {
    const session = await login(alice.id);
    const { oauth_query: connectQuery } = await beginAuthorization(session);
    const connect = await send(session, '/api/portal/connect', { oauth_query: connectQuery, decision: 'continue' });
    expect(connect.status, await connect.clone().text()).toBe(200);
    const oauth_query = signedQuery((await connect.json() as any).url);
    const consent = `${config.origin}/api/portal/consent?oauth_query=${encodeURIComponent(oauth_query)}`;
    expect((await session(consent)).status).toBe(200);
    // The button posts '{}' to Better Auth directly, without the page's signed query.
    expect((await send(session, '/api/auth/sign-out', {})).status).toBe(200);
    expect((await session(consent)).status).toBe(401);
    // Other sessions of the same user stay signed in.
    expect((await browser(`${config.origin}/api/portal/account`)).status).toBe(200);
  });
  it('enforces consent denial, signed queries, and PKCE', async () => {
    expect((await send(browser, '/api/portal/consent', { oauth_query: 'client_id=attacker', accept: true })).status).toBe(400);
    const denied = await authorize(browser, false);
    expect(denied.code).toBeNull(); expect(denied.callback.searchParams.get('error')).toBe('access_denied');
    const a = await authorize();
    expect((await exchange(a.client.client_id, { grant_type: 'authorization_code', code: a.code!, code_verifier: randomToken(), redirect_uri: a.client.redirect_uris[0] })).status).toBe(400); // RFC 6749 §5.2 invalid_grant
  });
  it('routes each token to its owner, redacts upstream echoes, and applies rotation/removal on the next request', async () => {
    const a = await token(), b = await token(other);
    const upstream = mock.get('https://api.regulations.gov');
    upstream.intercept({ path: '/v4/documents', method: 'GET', headers: { 'x-api-key': key } }).reply(200, { data: 'Alice', echo: key });
    upstream.intercept({ path: '/v4/documents', method: 'GET', headers: { 'x-api-key': key2 } }).reply(200, { data: 'Bob' });
    const [ra, rb] = await Promise.all([mcp(a.access_token, 'return await regs.documents.search();'), mcp(b.access_token, 'return await regs.documents.search();')]);
    expect(ra.body).toContain('Alice'); expect(ra.body).not.toContain(key); expect(ra.body).toContain('REDACTED'); expect(rb.body).toContain('Bob');
    expect((await send(browser, '/api/portal/keys', { apiKey: 'c'.repeat(40) })).status).toBe(200);
    upstream.intercept({ path: '/v4/documents', method: 'GET', headers: { 'x-api-key': 'c'.repeat(40) } }).reply(200, { data: 'Rotated' });
    expect((await mcp(a.access_token, 'return await regs.documents.search();')).body).toContain('Rotated');
    expect((await send(browser, '/api/portal/keys/delete', {})).status).toBe(200);
    expect((await mcp(a.access_token, 'return await regs.documents.search();')).body).toContain('Save a regulations.gov API key');
    expect((await mcp(a.access_token)).body).toContain('42');
    expect(await store.getKey(personalOwner(bob.id))).toBe(key2);
  });
  it('rotates stored keys past a row it cannot open, batch by batch', async () => {
    const k1 = randomBytes(32), k2 = randomBytes(32);
    const before = new Store(pool, new Keyring('k1', { k1 }));
    for (const owner of ['rot:a', 'rot:b', 'rot:c', 'rot:d']) await before.saveKey(owner, `key-${owner}`, owner);
    // The first row in owner order points at a key that is no longer in the keyring; another lost its key ID.
    await pool.query(`UPDATE credentials SET ciphertext=jsonb_set(ciphertext,'{kid}','"gone"') WHERE owner='rot:a'`);
    await pool.query(`UPDATE credentials SET ciphertext=ciphertext - 'kid' WHERE owner='rot:d'`);
    const after = new Store(pool, new Keyring('k2', { k1, k2 }));
    // Batches of one exercise the cursor; rows other tests left under another key fail the same way.
    const { rotated, failed } = await after.rotateAllKeys(1);
    expect(failed).toContainEqual({ owner: 'rot:a', reason: 'unknown_key' });
    expect(failed).toContainEqual({ owner: 'rot:d', reason: 'unknown_key' });
    expect(rotated).toBe(2);
    expect(await after.getKey('rot:b')).toBe('key-rot:b');
    expect(await after.getKey('rot:c')).toBe('key-rot:c');
    const kids = await pool.query(`SELECT owner, ciphertext->>'kid' AS kid FROM credentials WHERE owner LIKE 'rot:%' ORDER BY owner`);
    expect(kids.rows).toEqual([{ owner: 'rot:a', kid: 'gone' }, { owner: 'rot:b', kid: 'k2' }, { owner: 'rot:c', kid: 'k2' }, { owner: 'rot:d', kid: null }]);
    // A damaged ciphertext under a known key fails authentication, not key lookup.
    await pool.query(`UPDATE credentials SET ciphertext=jsonb_set(ciphertext,'{kid}','"k1"') WHERE owner='rot:b'`);
    expect((await after.rotateAllKeys(1)).failed).toContainEqual({ owner: 'rot:b', reason: 'authentication' });
    const audit = await pool.query(`SELECT action FROM audit_events WHERE tenant='rot:a' AND action LIKE 'credential.reencrypt_failed%'`);
    expect(audit.rows).toEqual([{ action: 'credential.reencrypt_failed:unknown_key:gone' }]);
    // A rerun reports the unopenable rows again but adds no audit rows for them.
    const count = async () => Number((await pool.query(`SELECT count(*) FROM audit_events WHERE action LIKE 'credential.reencrypt_failed%'`)).rows[0].count);
    const before2 = await count();
    expect((await after.rotateAllKeys(1)).rotated).toBe(0);
    expect(await count()).toBe(before2);
    await expect(after.rotateKeys(0)).rejects.toThrow('Invalid rotation batch size');
  });
  it('runs `--rotate-keys` as an operator command that exits 1 while a row cannot be opened', async () => {
    const k1 = randomBytes(32), k2 = randomBytes(32);
    // Its own schema: the command rotates every row it finds, and other tests' rows use another key.
    const cliSchema = `${schema}_cli`;
    const cliPool = new Pool({ connectionString: database, options: `-c search_path=${cliSchema}` });
    await pool.query(`CREATE SCHEMA ${cliSchema}`);
    try {
      const before = new Store(cliPool, new Keyring('k1', { k1 }));
      await before.initialize();
      await before.saveKey('cli:a', 'key-cli:a', 'cli:a');
      const env = {
        ...process.env, NODE_ENV: 'test', PGOPTIONS: `-c search_path=${cliSchema}`, DATABASE_URL: database!,
        FEDREG_PUBLIC_ORIGIN: 'http://127.0.0.1:8080', BETTER_AUTH_SECRET: 's'.repeat(32), GOOGLE_CLIENT_ID: 'g', GOOGLE_CLIENT_SECRET: 's',
        ENCRYPTION_KEYS_JSON: JSON.stringify({ k1: k1.toString('base64'), k2: k2.toString('base64') }), ENCRYPTION_ACTIVE_KEY_ID: 'k2',
      };
      const run = (...extra: string[]) => spawnSync(process.execPath, ['--import', 'tsx', 'src/bin.ts', '--rotate-keys', ...extra], { cwd: join(fileURLToPath(import.meta.url), '../..'), env, encoding: 'utf8' });
      const ok = run();
      expect(ok.status, ok.stderr).toBe(0);
      expect(ok.stderr + ok.stdout).toContain('accounts.keys_rotated');
      expect(await new Store(cliPool, new Keyring('k2', { k2 })).getKey('cli:a')).toBe('key-cli:a');
      await cliPool.query(`UPDATE credentials SET ciphertext=jsonb_set(ciphertext,'{kid}','"gone"') WHERE owner='cli:a'`);
      const bad = run();
      expect(bad.status).toBe(1);
      expect(bad.stderr + bad.stdout).toContain('accounts.key_rotation_failed');
      expect(bad.stderr + bad.stdout).toContain('unknown_key');
      expect(bad.stderr + bad.stdout).not.toContain('key-cli:a');
      // A server option beside it would be silently ignored, so it is refused before any database work.
      for (const option of ['--http', '--insecure', '--port=1']) {
        const refused = run(...option.split('='));
        expect(refused.status, option).toBe(1);
        expect(refused.stderr + refused.stdout, option).toContain('--rotate-keys runs alone');
      }
    } finally {
      await cliPool.end();
      await pool.query(`DROP SCHEMA ${cliSchema} CASCADE`);
    }
  });
  it('keeps upstream error status without the key, and keeps public sources working when a saved key cannot be read', async () => {
    const a = await token();
    expect((await send(browser, '/api/portal/keys', { apiKey: key })).status).toBe(200);
    mock.get('https://api.regulations.gov')
      .intercept({ path: '/v4/documents/missing', method: 'GET', headers: { 'x-api-key': key } })
      .reply(404, { errors: [{ detail: key }] });
    // The `${...}` is sandbox source (a template literal that runs inside execute), not a typo.
    // eslint-disable-next-line no-template-curly-in-string
    const missing = await mcp(a.access_token, 'try { await regs.documents.get("missing"); } catch (e) { return `${e.name}: ${e.message}`; }');
    expect(missing.body).toContain('HttpError');
    expect(missing.body).toContain('404');
    expect(missing.body).not.toContain(key);
    // A ciphertext sealed under a retired key ID can no longer be opened.
    await pool.query(`UPDATE credentials SET ciphertext = jsonb_set(ciphertext, '{kid}', '"retired"') WHERE owner=$1`, [personalOwner(alice.id)]);
    expect((await mcp(a.access_token)).body).toContain('42');
    expect((await mcp(a.access_token, 'return await regs.documents.search();')).body).toContain('could not be loaded');
    await store.deleteKey(personalOwner(alice.id), alice.id);
  });
  it('reads the key only for regs calls, reuses regs response caches, and accepts large requests', async () => {
    const b = await token(other);
    const own = 'd'.repeat(40);
    expect((await send(other, '/api/portal/keys', { apiKey: own })).status).toBe(200);
    const before = store.keyReads;
    // Over the 64KB cap account mode used to apply; the base HTTP transport has none.
    const large = await mcp(b.access_token, `// ${'x'.repeat(100_000)}\nreturn 42;`);
    expect(large.status).toBe(200);
    expect(large.body).toContain('42');
    expect(store.keyReads).toBe(before);
    // One upstream reply serves both executions: the second comes from the cached client.
    mock.get('https://api.regulations.gov')
      .intercept({ path: '/v4/dockets/CACHE-1', method: 'GET', headers: { 'x-api-key': own } })
      .reply(200, { data: 'Cached docket' });
    for (let i = 0; i < 2; i++)
      expect((await mcp(b.access_token, 'return await regs.dockets.get("CACHE-1");')).body).toContain('Cached docket');
    expect(store.keyReads).toBe(before + 2);
    await store.deleteKey(personalOwner(bob.id), bob.id);
  });
  it('supports the official MCP client and rejects expired, wrong-resource, under-scoped and disabled-client tokens', async () => {
    const a = await token();
    const client = new Client({ name: 'official-auth-test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${config.origin}/mcp/account`), {
      requestInit: { headers: { Authorization: `Bearer ${a.access_token}` } },
    }));
    expect((await client.listTools()).tools.map(t => t.name)).toEqual(['search_api', 'describe_schema', 'execute']);
    await client.close();
    const adapter = (await service.auth.$context).adapter;
    // A rejection is remembered for a minute, so each case gets its own token (a copy of the grant's row).
    const [expired, otherResource, underScoped, ofDisabledClient] = await validTokens(a.access_token, 4) as [string, string, string, string];
    for (const [value, update, status] of [
      [expired, { expiresAt: new Date(0) }, 401],
      [otherResource, { resources: ['https://other.example/mcp'] }, 401],
      [underScoped, { scopes: ['offline_access'] }, 403],
    ] as const) {
      await adapter.update({ model: 'oauthAccessToken', where: [{ field: 'token', value: digest(value) }], update });
      expect((await mcp(value)).status).toBe(status);
    }
    await adapter.update({ model: 'oauthClient', where: [{ field: 'clientId', value: a.clientId }], update: { disabled: true } });
    expect((await mcp(ofDisabledClient)).status).toBe(401);
    const stored = await pool.query('SELECT token FROM "oauthAccessToken"');
    expect(JSON.stringify(stored.rows)).not.toContain(a.access_token);
  });
  it('rejects unverified accounts, foreign browser origins, oversized bodies and unsafe client redirects', async () => {
    const unverified = await helper.saveUser(helper.createUser({ email: 'unverified@example.test', emailVerified: false }));
    const unverifiedBrowser = await login(unverified.id);
    expect((await send(unverifiedBrowser, '/api/portal/keys', { apiKey: key })).status).toBe(401);
    const cross = await fetch(`${config.origin}/api/portal/account`, { headers: { origin: 'https://evil.example' } });
    expect(cross.status).toBe(403);
    expect((await send(browser, '/api/portal/keys', { apiKey: 'x'.repeat(9000) })).status).toBe(413);
    expect((await send(fetch, '/api/auth/oauth2/register', { redirect_uris: ['http://evil.example/cb'] })).status).toBe(400);
    const a = await token();
    await (await service.auth.$context).adapter.update({ model: 'user', where: [{ field: 'id', value: alice.id }], update: { emailVerified: false } });
    expect((await mcp(a.access_token)).status).toBe(401);
    await (await service.auth.$context).adapter.update({ model: 'user', where: [{ field: 'id', value: alice.id }], update: { emailVerified: true } });
  });
  it('serves hosted connectors\' Origin on /mcp/account, and refuses other sites on the anonymous /mcp', async () => {
    const a = await token();
    // Hosted connectors send their own Origin; a bearer token (never a cookie) authenticates them.
    for (const origin of ['https://claude.ai', 'https://chatgpt.com']) {
      const hosted = await mcp(a.access_token, 'return 42;', '/mcp/account', origin);
      expect(hosted.status, origin).toBe(200);
      expect(hosted.body).toContain('42');
    }
    // The anonymous endpoint runs code with no token to check: another site's page is refused.
    expect((await mcp(undefined, 'return 42;', '/mcp', 'https://evil.example')).status).toBe(403);
    // OAuth discovery stays open to every client.
    const discovery = await fetch(`${config.origin}/.well-known/oauth-protected-resource/mcp/account`, { headers: { origin: 'https://app.example' } });
    expect(discovery.headers.get('access-control-allow-origin')).toBe('*');
    expect((await mcp(a.access_token, 'return 42;', '/mcp/account', config.origin)).status).toBe(200);
    expect((await mcp(a.access_token)).status).toBe(200);
  });
  it('rotates refresh tokens and honors access token revocation', async () => {
    const a = await token();
    const response = await exchange(a.clientId, { grant_type: 'refresh_token', refresh_token: a.refresh_token });
    expect(response.status, await response.clone().text()).toBe(200);
    const refreshed = await response.json() as any;
    expect(refreshed.refresh_token).not.toBe(a.refresh_token);
    expect((await mcp(refreshed.access_token)).status).toBe(200);
    const revoke = await fetch(`${config.origin}/api/auth/oauth2/revoke`, { method: 'POST', body: new URLSearchParams({ client_id: a.clientId, token: refreshed.access_token, token_type_hint: 'access_token' }) });
    expect(revoke.status).toBe(200); expect((await mcp(refreshed.access_token)).status).toBe(401);
    expect((await exchange(a.clientId, { grant_type: 'refresh_token', refresh_token: a.refresh_token })).status).toBe(400);
  });

  /** Runs `fn` against a second app instance (own limiters and lock pool) on the same server. */
  async function onReplica<T>(replica: Awaited<ReturnType<typeof createAccountApp>>, fn: () => Promise<T>) {
    server.removeListener('request', service.app);
    server.on('request', replica.app);
    try { return await fn(); }
    finally { server.removeListener('request', replica.app); server.on('request', service.app); await replica.close(); }
  }
  const bucketCount = async (key: string) => (await pool.query('SELECT count FROM request_limits WHERE bucket=$1', [digest(key)])).rows[0]?.count as number | undefined;
  const mcpPost = (bearer: string, headers: Record<string, string> = {}, scheme = 'Bearer') =>
    fetch(`${config.origin}/mcp/account`, { method: 'POST', headers: { Authorization: `${scheme} ${bearer}`, ...headers } });
  const authPost = (path: string, body: string | URLSearchParams, type = 'application/x-www-form-urlencoded', headers: Record<string, string> = {}) =>
    fetch(`${config.origin}/api/auth/oauth2/${path}`, { method: 'POST', headers: { 'content-type': type, ...headers }, body });
  const raced = (promise: Promise<unknown>, ms = 400) => Promise.race([promise.then(() => false), new Promise<boolean>(resolve => setTimeout(resolve, ms, true))]);
  /** Holds `id` in a separate transaction while `run` executes; reports whether `run` waited for it. */
  async function holding(id: string, run: () => Promise<Response>) {
    const hold = await pool.connect();
    try {
      await hold.query('BEGIN');
      await hold.query('SELECT pg_advisory_xact_lock($1)', [id]);
      const pending = run();
      const waits = await raced(pending);
      await hold.query('COMMIT');
      return { waits, response: await pending };
    } finally { await hold.query('ROLLBACK').catch(() => undefined); hold.release(); }
  }
  it('keys per-IP limits on the trusted client header, ignoring a forged forwarded chain, and buckets IPv6 by /64', async () => {
    for (const [ip, forged] of [['203.0.113.55', '1.1.1.1'], ['203.0.113.55', '2.2.2.2, 3.3.3.3'], ['198.51.100.77', '1.1.1.1']] as const)
      expect((await mcpPost('nope', { 'x-real-ip': ip, 'x-forwarded-for': forged })).status).toBe(401);
    expect(await bucketCount('mcp-ip-legacy:203.0.113.55')).toBe(2);
    expect(await bucketCount('mcp-ip-legacy:198.51.100.77')).toBe(1);
    expect(await bucketCount('mcp-ip-legacy:1.1.1.1')).toBeUndefined();
    expect(await bucketCount('mcp-ip-legacy:3.3.3.3')).toBeUndefined();
    // Addresses of one IPv6 /64 (and an IPv4-mapped form) share a bucket.
    for (const ip of ['2001:db8:1:2::1', '2001:db8:1:2:ffff::9', '2001:0DB8:1:2:0:0:0:3']) await mcpPost('nope', { 'x-real-ip': ip });
    expect(await bucketCount('mcp-ip-legacy:2001:db8:1:2::/64')).toBe(3);
    await mcpPost('nope', { 'x-real-ip': '::ffff:192.0.2.9' });
    await mcpPost('nope', { 'x-real-ip': '0:0:0:0:0:FFFF:c000:209' });
    expect(await bucketCount('mcp-ip-legacy:192.0.2.9')).toBe(2);
  });
  it('accepts the Bearer scheme in any letter case (RFC 6750) and still refuses other schemes', async () => {
    const a = await token();
    expect((await mcp(undefined)).status).toBe(401);
    for (const scheme of ['bearer', 'BEARER', 'BeArEr']) {
      const response = await mcpPost(a.access_token, { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, scheme);
      expect(response.status, scheme).not.toBe(401);
    }
    expect((await mcpPost(a.access_token, {}, 'Basic')).status).toBe(401);
  });
  it('limits failed legacy-shaped token checks per IP before they reach the database', async () => {
    const bucket = bucketCount;
    const post = (ip: string) => fetch(`${config.origin}/mcp/account`, { method: 'POST', headers: { authorization: 'Bearer made-up', 'x-real-ip': ip } });
    // Failures are counted once a token is proven invalid, so send them in small concurrent waves.
    const statuses: number[] = [];
    for (let wave = 0; wave < 60; wave++) statuses.push(...await Promise.all(Array.from({ length: 5 }, () => post('192.0.2.44').then(r => r.status))));
    expect(statuses.filter(s => s === 401).length).toBeGreaterThanOrEqual(256);
    expect(statuses.filter(s => s === 429).length).toBeGreaterThan(0);
    // Refused before the flood guard's database upsert, so only requests the limiter let through
    // reach the bucket. (Counted this way, not by expecting a 429 at once: the bucket refills
    // 2 tokens a second, so on a slow runner the next request could legitimately pass.)
    const counted = (await bucket('mcp-ip-legacy:192.0.2.44'))!;
    const more = await Promise.all(Array.from({ length: 10 }, () => post('192.0.2.44').then(r => r.status)));
    expect(await bucket('mcp-ip-legacy:192.0.2.44')).toBe(counted + more.filter(s => s === 401).length);
    expect((await post('192.0.2.45')).status).toBe(401);
    // Legacy traffic never touches the shared flood key.
    expect(await bucket('mcp-ip:192.0.2.44')).toBeUndefined();
  });
  it('spends the legacy failed-token budget only on legacy-shaped tokens proven invalid', async () => {
    const [valid] = await validTokens((await token()).access_token, 1, () => randomToken()) as [string];
    await resetLimits(); // the per-user quota counts every admitted request of alice within the minute
    const post = rawPost;
    const forgedBurst = (ip: string, n = 270) => Promise.all(Array.from({ length: n }, () => post('made-up', ip)));
    const full = (statuses: number[]) => statuses.filter(s => s === 401).length >= 256;
    // Valid legacy tokens cost nothing, however many and however fast: the budget is still whole afterwards.
    const ok = new Set<number>();
    for (let i = 0; i < 270; i++) ok.add(await post(valid, '192.0.2.120'));
    expect(ok.has(429) || ok.has(401)).toBe(false);
    expect(full(await forgedBurst('192.0.2.120'))).toBe(true);
    // An early 429 (the flood guard) costs nothing either.
    await pool.query("INSERT INTO request_limits(bucket,count,expires_at) VALUES($1,6000,now()+interval '1 hour')", [digest('mcp-ip-legacy:192.0.2.121')]);
    expect(new Set(await forgedBurst('192.0.2.121', 280))).toEqual(new Set([429]));
    await pool.query('DELETE FROM request_limits WHERE bucket=$1', [digest('mcp-ip-legacy:192.0.2.121')]);
    expect(full(await forgedBurst('192.0.2.121'))).toBe(true);
    // As does a database error.
    class FlakyStore extends Store { fail = false; override async allow(bucket: string, max: number, seconds: number) { if (this.fail) throw new Error('database unavailable'); return super.allow(bucket, max, seconds); } }
    const flaky = new FlakyStore(pool, new Keyring('v1', { v1: randomBytes(32) }));
    await onReplica(await build({}, undefined, flaky), async () => {
      flaky.fail = true;
      expect(new Set(await forgedBurst('192.0.2.122', 280))).toEqual(new Set([500]));
      flaky.fail = false;
      expect(full(await forgedBurst('192.0.2.122'))).toBe(true);
    });
    // Counting is per /64 for IPv6, in the budget and in the legacy in-flight cap.
    let blocked = false;
    for (let wave = 0; wave < 60 && !blocked; wave++) {
      const statuses = await Promise.all(Array.from({ length: 10 }, (_, i) => post('made-up', `2001:db8:7:7:${(wave * 10 + i + 1).toString(16)}::1`)));
      blocked = statuses.includes(429);
    }
    expect(blocked, 'failures from many addresses of one /64 must exhaust one budget').toBe(true);
    expect(await post('made-up', '2001:db8:7:7:ffff:ffff::9')).toBe(429);
    expect(await post('made-up', '2001:db8:7:8::1')).toBe(401);
    await onReplica(await build({}, { maxLegacyChecksInFlight: 3 }), async () => {
      const mixed = await Promise.all(Array.from({ length: 30 }, (_, i) => post('made-up', `2001:db8:9:9:${(i + 1).toString(16)}::1`)));
      expect(mixed).toContain(429);
      expect(mixed).toContain(401);
      // Other /64s were never affected.
      const other = await Promise.all(Array.from({ length: 3 }, () => post('made-up', '2001:db8:9:a::1')));
      expect(other).toEqual([401, 401, 401]);
    });
  });
  it('limits token and revoke requests per IP before any lookup, and takes no lock when there is nothing to lock', async () => {
    const replica = await build({}, { tokenRequestLimit: { rps: 0.001, burst: 3 }, lockWaitMs: 300 });
    const post = (path: string, ip: string, body: Record<string, string>) =>
      authPost(path, new URLSearchParams({ client_id: 'nobody', ...body }), undefined, { 'x-real-ip': ip }).then(r => r.status);
    await onReplica(replica, async () => {
      // None of these shares a lock: one held under the old shared `code:` key stalls none of them.
      const hold = await pool.connect();
      try {
        await hold.query('BEGIN');
        await hold.query('SELECT pg_advisory_xact_lock($1)', [advisoryId('code:')]);
        for (const fields of [{ grant_type: 'client_credentials' }, { grant_type: 'authorization_code' }, { grant_type: 'refresh_token' }, {}] as Record<string, string>[]) {
          const started = Date.now();
          expect(await post('token', '192.0.2.133', fields)).not.toBe(503);
          expect(Date.now() - started).toBeLessThan(250);
        }
        await hold.query('COMMIT');
      } finally { await hold.query('ROLLBACK').catch(() => undefined); hold.release(); }
      const statuses: number[] = [];
      for (let i = 0; i < 6; i++) statuses.push(await post('token', '192.0.2.131', { grant_type: 'refresh_token', refresh_token: 'x' }));
      expect(statuses.slice(3)).toEqual([429, 429, 429]);
      expect(statuses.slice(0, 3).every(s => s !== 429)).toBe(true);
      expect(await post('revoke', '192.0.2.131', { token: 'x' })).toBe(429);
      expect(await post('revoke', '192.0.2.132', { token: 'x' })).not.toBe(429);
      // /64 neighbours share one budget.
      for (let i = 0; i < 3; i++) await post('revoke', `2001:db8:77:1::${i + 1}`, { token: 'x' });
      expect(await post('revoke', '2001:db8:77:1:ffff::1', { token: 'x' })).toBe(429);
    });
  });
  it('selects the token lock from the operation Better Auth runs, and waits rather than runs unlocked', async () => {
    const issued = await token();
    const family = advisoryId(userLockKey(alice.id));
    const form = (fields: Record<string, string>) => new URLSearchParams({ client_id: issued.clientId, ...fields }).toString();
    // Revoke acts on `token`, wherever decoy refresh_token fields appear.
    const revoke = await holding(family, () => authPost('revoke', `refresh_token=junk&${form({ token: issued.refresh_token })}&refresh_token=junk2`));
    expect(revoke.waits, 'revoke must wait for the grant it revokes').toBe(true);
    expect(revoke.response.status).toBe(200);
    // Revoke with an access token (even with its scheme prefix) locks the same family.
    const second = await token();
    const secondFamily = advisoryId(userLockKey(alice.id));
    const prefixed = await holding(secondFamily, () => authPost('revoke', form({ token: `Bearer ${second.access_token}`, token_type_hint: 'access_token' })));
    expect(prefixed.waits).toBe(true);
    expect(prefixed.response.status).toBe(200);
    // A refresh grant locks on refresh_token even when a `{}`-prefixed pair would confuse a JSON-first reader,
    // and with a padded grant_type or a leading BOM, which Better Auth's form parser also tolerates.
    for (const [name, build] of [
      ['json-looking prefix', (t: string) => `{}=1&${form({ grant_type: 'refresh_token', refresh_token: t })}`],
      ['padded grant_type', (t: string) => form({ grant_type: ' refresh_token ', refresh_token: t })],
      ['BOM', (t: string) => `\uFEFFgrant_type=refresh_token&refresh_token=${t}&client_id=${issued.clientId}`],
      ['last value wins', (t: string) => `${form({ grant_type: 'refresh_token', refresh_token: t })}&refresh_token=${t}`],
    ] as const) {
      const fresh = await token();
      const waited = await holding(advisoryId(userLockKey(alice.id)), () => authPost('token', build(fresh.refresh_token)));
      if (name === 'BOM') {
        // The selector reads the body with the runtime parser Better Auth uses, so whichever way this runtime
        // treats a BOM they agree: either the request waited for the lock, or Better Auth did not run a grant.
        expect(waited.waits || (await exchange(fresh.clientId, { grant_type: 'refresh_token', refresh_token: fresh.refresh_token })).status === 200, name).toBe(true);
        continue;
      }
      expect(waited.waits, name).toBe(true);
      // The unlocked outcome is not asserted for the odd shapes: only that the request was held.
      expect(waited.response.status, name).toBeLessThan(500);
    }
    // Bodies the runtime's form parser accepts differently from a naive one (a leading '?') still take their lock.
    const questioned = await token();
    const qFamily = advisoryId(userLockKey(alice.id));
    for (const [name, build] of [
      ['? refresh', (t: string) => `?${form({ grant_type: 'refresh_token', refresh_token: t })}`],
      ['? grant first', (t: string) => `?grant_type=refresh_token&refresh_token=${t}&client_id=${questioned.clientId}`],
    ] as const) {
      const fresh = await token();
      const waited = await holding(advisoryId(userLockKey(alice.id)), () => authPost('token', build(fresh.refresh_token)));
      expect(waited.waits, name).toBe(true);
      expect(waited.response.status, name).toBeLessThan(500);
    }
    const qRevoke = await holding(qFamily, () => authPost('revoke', `?token=Bearer%20${questioned.access_token}&client_id=${questioned.clientId}&token_type_hint=access_token`));
    expect(qRevoke.waits, '? revoke').toBe(true);
    expect(qRevoke.response.status).toBeLessThan(500);
    const qFlow = await authorize();
    const qCode = await holding(advisoryId(`code:${qFlow.code}`), () => authPost('token', `?${form({
      grant_type: 'authorization_code', code: qFlow.code!, code_verifier: qFlow.verifier, redirect_uri: qFlow.client.redirect_uris[0], client_id: qFlow.client.client_id,
    })}`));
    expect(qCode.waits, '? code').toBe(true);
    expect(qCode.response.status).toBeLessThan(500);
    // A code exchange locks on its code; a stray refresh_token does not change that.
    const flow = await authorize();
    const exchanged = await holding(advisoryId(`code:${flow.code}`), () => authPost('token', form({
      grant_type: 'authorization_code', code: flow.code!, code_verifier: flow.verifier, redirect_uri: flow.client.redirect_uris[0], refresh_token: 'junk', client_id: flow.client.client_id,
    })));
    expect(exchanged.waits).toBe(true);
    expect(exchanged.response.status, await exchanged.response.clone().text()).toBe(200);
    // The grant picks the field: a client_credentials request with a refresh_token takes no lock.
    const third = await token();
    const unrelated = await holding(advisoryId(userLockKey(alice.id)), () => authPost('token', form({ grant_type: 'client_credentials', refresh_token: third.refresh_token })));
    expect(unrelated.waits).toBe(false);
    // Other media types are refused by Better Auth and take no lock.
    const json = await holding(advisoryId(userLockKey(alice.id)), () => authPost('token', JSON.stringify({ grant_type: 'refresh_token', refresh_token: third.refresh_token, client_id: third.clientId }), 'application/json'));
    expect(json.waits).toBe(false);
    expect(json.response.status).toBe(415);
    // Revoke acts on `token` whatever grant_type or code fields ride along: a decoy grant never moves the lock.
    for (const [name, extra] of [
      ['refresh_token grant decoy', 'grant_type=refresh_token&refresh_token=decoy'],
      ['authorization_code grant decoy', 'grant_type=authorization_code&code=decoy'],
      ['conflicting grant_type repeats', 'grant_type=client_credentials&grant_type=refresh_token&refresh_token=decoy'],
    ] as const) {
      const victim = await token();
      const revoked = await holding(advisoryId(userLockKey(alice.id)), () => authPost('revoke', `${extra}&${form({ token: victim.refresh_token })}`));
      expect(revoked.waits, name).toBe(true);
      expect(revoked.response.status, name).toBe(200);
    }
    // A /token request with no grant_type takes no lock, even with a `token` field.
    const bare = await token();
    const noGrant = await holding(advisoryId(userLockKey(alice.id)), () => authPost('token', form({ token: bare.refresh_token })));
    expect(noGrant.waits).toBe(false);
    // A JSON revoke of a real refresh token is refused (Better Auth takes form bodies only), not run unlocked.
    const jsonRevoke = await holding(advisoryId(userLockKey(alice.id)), () => authPost('revoke', JSON.stringify({ token: bare.refresh_token, client_id: bare.clientId }), 'application/json'));
    expect(jsonRevoke.waits).toBe(false);
    expect(jsonRevoke.response.status).toBe(415);
    expect((await exchange(bare.clientId, { grant_type: 'refresh_token', refresh_token: bare.refresh_token })).status).toBe(200);
    // Conflicting repeats of the chosen field are refused outright.
    const conflict = await authPost('revoke', `${form({ token: 'a' })}&token=b`);
    expect(conflict.status).toBe(400);
    expect((await conflict.json() as any).error).toBe('invalid_request');
    // A revoke racing refreshes of one grant settles without a server error.
    const racing = await token();
    const results = await Promise.all([
      authPost('token', form({ grant_type: 'refresh_token', refresh_token: racing.refresh_token })),
      authPost('revoke', form({ token: racing.refresh_token })),
      authPost('token', form({ grant_type: 'refresh_token', refresh_token: racing.refresh_token })),
    ]);
    expect(results.map(r => r.status).every(status => status < 500), results.map(r => r.status).join()).toBe(true);
  });
  it('keeps the lock keys earlier releases used, so old and new instances share one lock during a rollout', async () => {
    // The base release's computation, written out independently of the app's helper.
    const base = (key: string) => BigInt.asIntN(64, BigInt(`0x${digest(key).slice(0, 16)}`)).toString();
    const issued = await token();
    expect(advisoryId(userLockKey(alice.id))).toBe(base(`user:${alice.id}`));
    expect(advisoryId(`code:abc`)).toBe(base('code:abc'));
    expect(advisoryId(`token:${digest('x')}`)).toBe(base(`token:${digest('x')}`));
    // And a refresh really waits on that key.
    const held = await holding(base(`user:${alice.id}`), () => authPost('token', new URLSearchParams({ client_id: issued.clientId, grant_type: 'refresh_token', refresh_token: issued.refresh_token })));
    expect(held.waits).toBe(true);
    expect(held.response.status).toBe(200);
  });
  it('answers a lock connection that cannot be established in time with 503, running no OAuth handler', async () => {
    const issued = await token();
    const sockets = new Set<Socket>();
    // Accepts, never completes the PostgreSQL handshake.
    const stalled = createNetServer(socket => { sockets.add(socket); socket.on('error', () => undefined); });
    await new Promise<void>(resolve => stalled.listen(0, '127.0.0.1', resolve));
    try {
      const replica = await build({}, { lockWaitMs: 300, lockPool: { connectionString: `postgresql://u:p@127.0.0.1:${(stalled.address() as AddressInfo).port}/db` } });
      await onReplica(replica, async () => {
        const response = await authPost('token', new URLSearchParams({ client_id: issued.clientId, grant_type: 'refresh_token', refresh_token: issued.refresh_token }));
        expect(response.status).toBe(503);
        expect(response.headers.get('retry-after')).toBe('1');
      });
    } finally { for (const socket of sockets) socket.destroy();
      await new Promise(resolve => stalled.close(resolve)); }
    // No handler ran: the refresh token was not rotated.
    expect((await exchange(issued.clientId, { grant_type: 'refresh_token', refresh_token: issued.refresh_token })).status).toBe(200);
  });
  it('refuses a conflicting repeated grant_type before it can run an unlocked grant', async () => {
    const issued = await token();
    const flow = await authorize();
    const hold = await pool.connect();
    try {
      await hold.query('BEGIN');
      await hold.query('SELECT pg_advisory_xact_lock($1)', [advisoryId(userLockKey(alice.id))]);
      await hold.query('SELECT pg_advisory_xact_lock($1)', [advisoryId(`code:${flow.code}`)]);
      const send = (client: string, fields: [string, string][]) => authPost('token', new URLSearchParams([['client_id', client], ...fields]));
      const refresh = await send(issued.clientId, [['grant_type', 'client_credentials'], ['grant_type', 'refresh_token'], ['refresh_token', issued.refresh_token]]);
      expect(refresh.status).toBe(400);
      expect((await refresh.json() as any).error).toBe('invalid_request');
      const code = await send(flow.client.client_id, [['grant_type', 'refresh_token'], ['grant_type', 'authorization_code'], ['code', flow.code!], ['code_verifier', flow.verifier], ['redirect_uri', flow.client.redirect_uris[0]]]);
      expect(code.status).toBe(400);
      await hold.query('COMMIT');
      // Neither request ran: the refresh token and the code are both still good.
      expect((await exchange(issued.clientId, { grant_type: 'refresh_token', refresh_token: issued.refresh_token })).status).toBe(200);
      expect((await exchange(flow.client.client_id, { grant_type: 'authorization_code', code: flow.code!, code_verifier: flow.verifier, redirect_uri: flow.client.redirect_uris[0] })).status).toBe(200);
    } finally { await hold.query('ROLLBACK').catch(() => undefined); hold.release(); }
  });
  it('answers a stuck token lock or an exhausted lock pool with a retryable 503, rolls back, and recovers', async () => {
    const issued = await token();
    const family = advisoryId(userLockKey(alice.id));
    const refresh = () => authPost('token', new URLSearchParams({ client_id: issued.clientId, grant_type: 'refresh_token', refresh_token: issued.refresh_token }));
    // Pool of two, short waits: two requests time out on the lock, the third on the connection.
    const replica = await build({ authLockPoolSize: 2 }, { lockWaitMs: 300 });
    await onReplica(replica, async () => {
      const hold = await pool.connect();
      try {
        await hold.query('BEGIN');
        await hold.query('SELECT pg_advisory_xact_lock($1)', [family]);
        const started = Date.now();
        const waiting = await Promise.all([refresh(), refresh(), refresh()]);
        expect(waiting.map(r => r.status)).toEqual([503, 503, 503]);
        for (const r of waiting) { expect(r.headers.get('retry-after')).toBe('1'); expect((await r.json() as any).error).toBe('temporarily_unavailable'); }
        expect(Date.now() - started).toBeLessThan(5000);
        await hold.query('COMMIT');
      } finally { await hold.query('ROLLBACK').catch(() => undefined); hold.release(); }
      // No lock connection kept a transaction open, and the refresh token was never consumed.
      const open = await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction'");
      expect(open.rows[0].n).toBe(0);
      expect((await refresh()).status).toBe(200);
    });
  });
  it('refuses redirect URIs with credentials or fragments, in JSON and form bodies too, and still accepts good ones', async () => {
    const bad = ['https://user:pass@client.example/cb', 'https://user@client.example/cb', 'https://client.example/cb#frag', 'http://127.0.0.1:1234/cb#frag'];
    const client = await register();
    const query = (redirect: string) => new URLSearchParams({
      client_id: client.client_id, redirect_uri: redirect, response_type: 'code', scope: 'fedreg:read',
      code_challenge: createHash('sha256').update('v').digest('base64url'), code_challenge_method: 'S256', state: 's',
    });
    for (const redirect of bad) {
      expect((await send(fetch, '/api/auth/oauth2/register', { client_name: 'Bad', redirect_uris: [redirect] })).status, redirect).toBe(400);
      expect((await fetch(`${config.origin}/api/auth/oauth2/authorize?${query(redirect)}`, { redirect: 'manual' })).status, redirect).toBe(400);
      for (const [type, body] of [['application/x-www-form-urlencoded', query(redirect).toString()], ['application/json', JSON.stringify(Object.fromEntries(query(redirect)))]] as const) {
        const post = await authPost('authorize', body, type, {});
        expect(post.status, `${type} ${redirect}`).toBe(400);
        expect((await post.json() as any).error).toBe('invalid_request');
      }
    }
    // A repeated redirect_uri is checked in full, not just its first value (Better Auth reads the last).
    const mixed = `${query(client.redirect_uris[0])}&redirect_uri=${encodeURIComponent('http://evil.example/cb')}`;
    expect((await authPost('authorize', mixed)).status).toBe(400);
    expect((await fetch(`${config.origin}/api/auth/oauth2/authorize?${mixed}`, { redirect: 'manual' })).status).toBe(400);
    // A JSON body that does not parse cannot slip past the check.
    expect((await authPost('authorize', '{"redirect_uri": ', 'application/json')).status).toBe(400);
    // The registered redirect, over a JSON POST, is not mistaken for a bad one.
    const good = await authPost('authorize', JSON.stringify(Object.fromEntries(query(client.redirect_uris[0]))), 'application/json');
    expect(good.status, await good.clone().text()).not.toBe(400);
  });
  it('registers loopback HTTP clients as native when application_type is omitted, and keeps explicit choices', async () => {
    for (const redirects of [['http://127.0.0.1:8765/callback'], ['http://localhost/cb', 'http://[::1]:9/cb']]) {
      const response = await send(fetch, '/api/auth/oauth2/register', { client_name: 'Desktop', redirect_uris: redirects, token_endpoint_auth_method: 'none' });
      const body = await response.json() as any;
      expect(response.status, JSON.stringify(body)).toBe(201);
      expect(body.application_type).toBe('native');
    }
    const web = await send(fetch, '/api/auth/oauth2/register', { client_name: 'Web', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], token_endpoint_auth_method: 'none' });
    expect(web.status).toBe(201);
    expect((await web.json() as any).application_type).not.toBe('native');
    // Mixed HTTPS and loopback is not all-loopback: left to Better Auth's default.
    const mixed = await send(fetch, '/api/auth/oauth2/register', { client_name: 'Mixed', redirect_uris: ['https://claude.ai/cb', 'http://127.0.0.1:1/cb'], token_endpoint_auth_method: 'none' });
    if (mixed.status === 201) expect((await mixed.json() as any).application_type).not.toBe('native');
  });
  it('caches fingerprinted assets immutably but keeps every other response no-store', async () => {
    const assets = fileURLToPath(new URL('../dist/web/assets/', import.meta.url));
    const made = !existsSync(assets);
    mkdirSync(assets, { recursive: true });
    const file = join(assets, 'cache-test-abc123.js');
    writeFileSync(file, 'console.log(1)');
    const header = async (path: string, init?: RequestInit) => {
      const response = await fetch(`${config.origin}${path}`, init);
      await response.arrayBuffer();
      return { status: response.status, cache: response.headers.get('cache-control') };
    };
    try {
      const asset = await header('/assets/cache-test-abc123.js');
      expect(asset.status).toBe(200);
      expect(asset.cache).toMatch(/immutable/);
      expect(asset.cache).toMatch(/max-age=31536000/);
      expect(asset.cache).not.toMatch(/no-store/);
    } finally { rmSync(made ? assets : file, { recursive: true, force: true }); }
    // A missing bundle must not be cached as if it existed.
    expect((await header('/assets/missing-abc123.js')).cache).toBe('no-store');
    for (const path of ['/health', '/sign-in', '/api/portal/account', '/nonexistent']) expect((await header(path)).cache, path).toBe('no-store');
    expect((await header('/mcp/account', { method: 'POST' })).cache).toBe('no-store');
    expect((await header('/mcp', { method: 'POST' })).cache).toBe('no-store');
    expect((await header('/api/auth/oauth2/register', { method: 'POST' })).cache).toBe('no-store');
  });
  // ---- Bearer token admission (release 1): tokens this server issues are `at1.…` and admitted by their MAC. ----
  /** What an empty POST gets once the token is admitted: the MCP transport refuses the missing content type. */
  const ADMITTED = 415;
  const revoke = (value: string, revoked: Date | null = new Date()) =>
    pool.query('UPDATE "oauthAccessToken" SET revoked=$2 WHERE token=$1', [digest(value), revoked]);
  const statusCounts = (statuses: number[]) =>
    Object.fromEntries([...new Set(statuses)].sort().map(s => [s, statuses.filter(x => x === s).length]));
  const settle = () => new Promise<void>(resolve => setImmediate(resolve));
  /** Per-user and per-address counters accumulate across tests within a minute; tests that send hundreds start clean. */
  const resetLimits = () => pool.query('DELETE FROM request_limits');
  /**
   * A replica (cold admission cache) answering the requests, whose real `oauthAccessToken` lookups are counted.
   * `gate` may hold a lookup until the test releases it. Everything else is the real handler and the real database.
   */
  async function countingReplica<T>(
    tuning: Parameters<typeof createAccountApp>[5],
    run: (lookups: { count: number; of: string[] }) => Promise<T>,
    gate?: (digestOfToken: string) => Promise<void> | undefined,
  ) {
    await resetLimits();
    const replica = await build({}, tuning);
    const lookups = { count: 0, of: [] as string[] };
    const { adapter } = await replica.auth.$context;
    const findOne = adapter.findOne.bind(adapter) as typeof adapter.findOne;
    adapter.findOne = (async (query: Parameters<typeof adapter.findOne>[0]) => {
      if (query.model === 'oauthAccessToken') {
        const value = String(query.where?.find(w => w.field === 'token')?.value);
        lookups.count++; lookups.of.push(value);
        // The result is read first and held afterwards, so a held check carries the state it saw.
        const result = await findOne(query);
        await gate?.(value);
        return result;
      }
      return findOne(query);
    }) as typeof adapter.findOne;
    return onReplica(replica, () => run(lookups));
  }
  /** A fresh, valid, MAC-valid token for alice. */
  const freshToken = async () => (await validTokens((await token()).access_token, 1))[0]!;

  it('issues tokens in the authenticated format, stored as a digest of the whole token', async () => {
    const issued = await token();
    expect(issued.access_token).toMatch(/^at1\.a\.[0-9a-z]+\.[\w-]{32}\.[\w-]{22}$/);
    expect(accessTokens.parse(issued.access_token)).toBeTruthy();
    // Both the signature key and the format are this server's own.
    expect(new AccessTokenFormat(config.authSecret).parse(issued.access_token)).toBeTruthy();
    expect(new AccessTokenFormat(randomToken()).parse(issued.access_token)).toBeUndefined();
    const rows = (await pool.query('SELECT "referenceId" FROM "oauthAccessToken" WHERE token=$1', [digest(issued.access_token)])).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].referenceId).toBe('personal');
  });

  it('junk in the authenticated format is refused before any database work, then a valid token passes', async () => {
    const good = accessTokens.generate();
    const [, , iat, random, mac] = good.split('.') as [string, string, string, string, string];
    const other = new AccessTokenFormat(randomToken()).generate();
    const junk = [
      () => `at1.a.${iat}.${randomToken().slice(0, 32)}.${randomToken().slice(0, 22)}`,
      () => `at1.a.${iat}.${random}.${randomToken().slice(0, 22)}`,
      () => `at1.b.${iat}.${random}.${mac}`,
      () => `at1.a.${iat}.${random}!.${mac}`,
      () => `at1.a.${iat}.${random}.${mac}.extra`,
      () => `at1.${'x'.repeat(3000)}`,
      () => `at1.${'x'.repeat(4000)}`,
      // Past the 4096-character header cap the request never reaches the admission at all.
      () => `at1.${'x'.repeat(5000)}`,
      () => other,
      () => accessTokens.generate().replace(/.$/, c => (c === 'A' ? 'B' : 'A')),
    ];
    const valid = await freshToken();
    await countingReplica({}, async lookups => {
      const before = await bucketCount('mcp-ip:192.0.2.150');
      const statuses: number[] = [];
      for (let wave = 0; wave < 100; wave++)
        statuses.push(...await Promise.all(Array.from({ length: 100 }, (_, i) => rawPost(junk[(wave + i) % junk.length]!(), '192.0.2.150'))));
      expect(statuses).toHaveLength(10_000);
      expect(statusCounts(statuses)).toEqual({ 401: 10_000 });
      expect(lookups.count, 'junk made no adapter call').toBe(0);
      expect(await bucketCount('mcp-ip:192.0.2.150'), 'and spent no flood allowance').toBe(before);
      expect((await mcpPost(valid, { 'x-real-ip': '192.0.2.150' })).status).toBe(ADMITTED);
      expect(lookups.count).toBe(1);
    });
  });

  it('a revoked real token replayed past the old burst costs one lookup, sequentially and 256-way', async () => {
    const [sequential, concurrent] = await validTokens((await token()).access_token, 2) as [string, string];
    const stranger = await freshToken();
    await revoke(sequential); await revoke(concurrent);
    await countingReplica({}, async lookups => {
      const ip = { 'x-real-ip': '192.0.2.151' };
      for (let i = 0; i < 150; i++) expect((await mcpPost(sequential, ip)).status).toBe(401);
      expect(lookups.of.filter(d => d === digest(sequential))).toHaveLength(1);
      expect((await mcpPost(stranger, ip)).status).toBe(ADMITTED);
    });
    // Cold cache, 256 at once. The first lookup is held until the first 32 requests (the agent's socket
    // limit) have been received.
    let received = 0;
    let enough!: () => void;
    const arrived = new Promise<void>(resolve => (enough = resolve));
    const count = () => { if (++received === 32) enough(); };
    server.on('request', count);
    try {
      await countingReplica({}, async lookups => {
        const statuses = await Promise.all(Array.from({ length: 256 }, () => rawPost(concurrent, '192.0.2.152')));
        expect(lookups.of.filter(d => d === digest(concurrent))).toHaveLength(1);
        // The owner and its waiters answer 401; requests that arrive later hit the remembered rejection.
        expect(statuses.every(s => s === 401 || s === 429), JSON.stringify(statusCounts(statuses))).toBe(true);
        expect(statuses.filter(s => s === 401).length).toBeGreaterThanOrEqual(9);
        // The shared address is not locked out: a different valid token is served, and the replay stays free.
        expect(await rawPost(stranger, '192.0.2.152')).toBe(ADMITTED);
        expect(await rawPost(concurrent, '192.0.2.152')).toBe(401);
        expect(lookups.of.filter(d => d === digest(concurrent))).toHaveLength(1);
      }, () => arrived.then(settle));
    } finally {
      server.removeListener('request', count);
    }
  });

  it('the maximum-age bound, fixed negative TTL and the skew window follow the admission deadline', async () => {
    const early = (await token()).access_token;
    // Issuance and admission share the injected clock, three hours ahead of the real one.
    const base = 3 * 3600_000;
    let offset = base;
    const ip = { 'x-real-ip': '192.0.2.153' };
    await countingReplica({ now: () => Date.now() + offset }, async lookups => {
      const value = (await token()).access_token;
      expect(Math.abs(accessTokens.parse(value)!.iat - (Date.now() + base) / 1000), 'the issue time comes from the injected clock').toBeLessThan(60);
      const count = () => lookups.of.filter(d => d === digest(value)).length;
      // The database says expired, but the token is still inside the 60 s skew window: one lookup, remembered.
      await pool.query('UPDATE "oauthAccessToken" SET "expiresAt"=$2 WHERE token=$1', [digest(value), new Date(0)]);
      offset = base + (900 + 30) * 1000;
      expect((await mcpPost(value, ip)).status).toBe(401);
      expect((await mcpPost(value, ip)).status).toBe(401);
      expect(count()).toBe(1);
      // Past iat + lifetime + skew nothing reaches the database, cached or not.
      offset = base + (900 + 61) * 1000;
      expect((await mcpPost(value, ip)).status).toBe(401);
      expect(count()).toBe(1);
    });
    // An expired real token on a cold cache: no adapter call at all.
    await countingReplica({ now: () => Date.now() + 2 * 3600_000 }, async lookups => {
      expect((await mcpPost(early, ip)).status).toBe(401);
      expect(lookups.count).toBe(0);
    });
  });

  it('revocation applies on the very next request; a restored client is accepted within 60 s', async () => {
    let offset = 0;
    const [revoked, enabled] = await validTokens((await token()).access_token, 2) as [string, string];
    const clientId = (await pool.query('SELECT "clientId" FROM "oauthAccessToken" WHERE token=$1', [digest(revoked)])).rows[0].clientId as string;
    const setDisabled = (disabled: boolean) => pool.query('UPDATE "oauthClient" SET disabled=$2 WHERE "clientId"=$1', [clientId, disabled]);
    const ip = { 'x-real-ip': '192.0.2.154' };
    await countingReplica({ now: () => Date.now() + offset }, async lookups => {
      expect((await mcpPost(revoked, ip)).status).toBe(ADMITTED);
      await revoke(revoked);
      expect((await mcpPost(revoked, ip)).status, 'revocation is not delayed').toBe(401);
      expect((await mcpPost(enabled, ip)).status).toBe(ADMITTED);
      await setDisabled(true);
      try { expect((await mcpPost(enabled, ip)).status).toBe(401); }
      finally { await setDisabled(false); }
      const seen = lookups.count;
      // Restored, but the rejection is remembered for its fixed 60 s: no lookup, still refused...
      expect((await mcpPost(enabled, ip)).status).toBe(401);
      expect(lookups.count).toBe(seen);
      offset = 59_000;
      expect((await mcpPost(enabled, ip)).status).toBe(401);
      // ...and accepted once it has expired, however often it was hit meanwhile.
      offset = 61_000;
      expect((await mcpPost(enabled, ip)).status).toBe(ADMITTED);
    });
  });

  it('a first-use burst of 64 with a brand-new valid token is fully served, each with its own check', async () => {
    const value = await freshToken();
    await countingReplica({}, async lookups => {
      const statuses = await Promise.all(Array.from({ length: 64 }, () => rawPost(value, '192.0.2.155')));
      expect(statusCounts(statuses)).toEqual({ [ADMITTED]: 64 });
      expect(lookups.of.filter(d => d === digest(value))).toHaveLength(64);
    });
  });

  it('a warmed, then revoked token cannot take the shared slots: 16 checks at most, others queue, and other users are served meanwhile', async () => {
    const value = await freshToken();
    const stranger = await freshToken();
    const ip = '192.0.2.156';
    let holding = false;
    let release!: () => void;
    const held = new Promise<void>(resolve => (release = resolve));
    try {
      await countingReplica({ maxTokenChecksInFlight: 20 }, async lookups => {
        try {
          const mine = () => lookups.of.filter(d => d === digest(value)).length;
          expect(await rawPost(value, ip)).toBe(ADMITTED);
          expect(mine()).toBe(1);
          await revoke(value);
          holding = true;
          const burst = Array.from({ length: 256 }, () => rawPost(value, ip));
          while (mine() < 1 + 16) await settle();
          // Sixteen checks are pending and hold slots; the other requests queue without holding any.
          // A different valid token on the same address is served while they are still pending.
          // (A separate connection pool: the burst's agent has all of its sockets busy.)
          expect((await mcpPost(stranger, { 'x-real-ip': ip })).status).toBe(ADMITTED);
          expect(mine()).toBe(1 + 16);
          holding = false;
          release();
          const statuses = await Promise.all(burst);
          expect(statuses.every(s => s === 401 || s === 429), JSON.stringify(statusCounts(statuses))).toBe(true);
          // The first rejection answers the queued requests; the replay stays free afterwards.
          expect(mine()).toBe(1 + 16);
          for (let i = 0; i < 20; i++) expect(await rawPost(value, ip)).toBe(401);
          expect(mine()).toBe(1 + 16);
          expect(await rawPost(stranger, ip)).toBe(ADMITTED);
        } finally {
          // Release before the replica is torn down: a held lookup must not outlive the test body.
          holding = false;
          release();
        }
      }, digestOfToken => (holding && digestOfToken === digest(value) ? held : undefined));
    } finally {
      holding = false;
      release();
    }
  });

  it('a stale overlapping rejection does not renew the negative entry: restored access is admitted 61 s after the first rejection', async () => {
    let offset = 0;
    const value = await freshToken();
    const ip = '192.0.2.157';
    const holds: Array<() => void> = [];
    let holding = false;
    try {
      await countingReplica({ now: () => Date.now() + offset }, async lookups => {
        const mine = () => lookups.of.filter(d => d === digest(value)).length;
        expect(await rawPost(value, ip)).toBe(ADMITTED);
        await revoke(value);
        try {
          // Two checks overlap; both read the revoked row (held after the read).
          holding = true;
          const first = rawPost(value, ip);
          const second = rawPost(value, ip);
          while (holds.length < 2) await settle();
          holding = false;
          // Either request may reach the database first, so release whichever is held first and wait for
          // whichever finishes first (a rejection), never for a particular one.
          holds[0]!();
          const [firstStatus, firstDone] = await Promise.race([
            first.then(status => [status, 'first'] as const),
            second.then(status => [status, 'second'] as const),
          ]);
          expect(firstStatus).toBe(401);
          await revoke(value, null);
          offset = 30_000;
          holds[1]!();
          expect(await (firstDone === 'first' ? second : first)).toBe(401);
          const seen = mine();
          offset = 61_000;
          expect(await rawPost(value, ip), 'admitted again 61 s after the first rejection').toBe(ADMITTED);
          expect(mine()).toBe(seen + 1);
        } finally {
          holding = false;
          for (const hold of holds) hold();
          await revoke(value, null);
        }
      }, digestOfToken => (holding && digestOfToken === digest(value) ? new Promise<void>(resolve => holds.push(resolve)) : undefined));
    } finally {
      holding = false;
      for (const hold of holds) hold();
    }
  });

  it('legacy-token users keep their concurrency: 200 simultaneous valid requests from one IP are all served', async () => {
    // One token is the harder case (no per-token suppression on this path).
    const [legacy] = await validTokens((await token()).access_token, 1, () => randomToken()) as [string];
    await resetLimits();
    const statuses = await Promise.all(Array.from({ length: 200 }, () => rawPost(legacy, '192.0.2.161')));
    expect(statusCounts(statuses)).toEqual({ [ADMITTED]: 200 });
  });

  it('release 1: legacy tokens keep working, and a legacy junk flood cannot touch at1 users', async () => {
    const [legacy] = await validTokens((await token()).access_token, 1, () => randomToken()) as [string];
    const at1 = await validTokens((await token()).access_token, 400);
    const ip = '192.0.2.160';
    let legacyJunk = new Set<string>();
    let release!: () => void;
    let held = new Promise<void>(resolve => (release = resolve));
    // The replica reads this clock for the failure budget's refill, so the test advances it instead of sleeping.
    let clock = Date.now();
    try {
      await countingReplica({ maxLegacyChecksInFlight: 24, now: () => clock }, async lookups => {
        try {
          let nextAt1 = 0;
          // Mixed issuers: both shapes are accepted from the same address.
          expect((await mcpPost(legacy, { 'x-real-ip': ip })).status).toBe(ADMITTED);
          expect((await mcpPost(at1[nextAt1++]!, { 'x-real-ip': ip })).status).toBe(ADMITTED);
          const shared = (await bucketCount(`mcp-ip:${ip}`))!;
          let at1Requests = 1;
          const startedAt = clock;
          const rounds = 12;
          for (let round = 0; round < rounds; round++) {
            legacyJunk = new Set();
            held = new Promise<void>(resolve => (release = resolve));
            const junk = Array.from({ length: 200 }, () => randomToken());
            for (const value of junk) legacyJunk.add(digest(value));
            let settled = 0;
            const burst = junk.map(value => rawPost(value, ip).finally(() => settled++));
            // Every request either holds a legacy lookup (held by the gate) or has been answered: at that
            // point the legacy slots are saturated or the failure budget is spent. Then serve at1 users.
            while (settled + lookups.of.filter(d => legacyJunk.has(d)).length < junk.length) await settle();
            for (let i = 0; i < 20; i++) {
              at1Requests++;
              expect((await mcpPost(at1[nextAt1++]!, { 'x-real-ip': ip })).status).toBe(ADMITTED);
            }
            release();
            const statuses = await Promise.all(burst);
            expect(statuses.every(s => s === 401 || s === 429)).toBe(true);
            clock += 6_000;
          }
          // Legacy lookups are bounded by the failure budget: the burst (the legacy cap, 24 here) + 2/s over the elapsed time, not by slots.
          const elapsed = (clock - startedAt) / 1000;
          expect(elapsed).toBeGreaterThanOrEqual(60);
          const legacyLookups = lookups.of.length - at1Requests;
          expect(legacyLookups, `${legacyLookups} legacy lookups in ${elapsed}s`).toBeLessThanOrEqual(24 + 2 * elapsed);
          // The budget, not the slot cap, was the binding limit.
          expect(legacyLookups, `${legacyLookups} legacy lookups`).toBeLessThan(rounds * 24);
          // The shared flood counter saw only the at1 requests; legacy traffic has its own key.
          expect((await bucketCount(`mcp-ip:${ip}`))! - shared).toBe(at1Requests - 1);
          expect((await bucketCount(`mcp-ip-legacy:${ip}`)) ?? 0).toBeGreaterThanOrEqual(legacyLookups);
        } finally {
          // Release before the replica is torn down: a held lookup must not outlive the test body.
          legacyJunk = new Set();
          release();
        }
      }, value => (legacyJunk.has(value) ? held : undefined));
    } finally {
      legacyJunk = new Set();
      release(); // never leave a held lookup behind
    }
  });

  it('in-flight bearer checks are capped per IPv6 /64 in aggregate and counters are cleaned up', async () => {
    const issued = (await token()).access_token;
    // Distinct digests: the per-token duplicate suppression is separate from the per-address cap.
    const valid = await validTokens(issued, 180);
    const forgedValid = Array.from({ length: 60 }, () => accessTokens.generate());
    const CAP = 20;
    const post = (value: string, ip: string) => mcpPost(value, { 'x-real-ip': ip }).then(r => r.status);
    const settledWhileBlocked = async (tokens: string[], prefix: string, total: number) => {
      // A held table lock stalls every bearer check inside the counted section.
      const hold = await pool.connect();
      try {
        await hold.query('BEGIN');
        await hold.query('LOCK TABLE request_limits IN ACCESS EXCLUSIVE MODE');
        let immediate = 0;
        const all = Array.from({ length: total }, (_, i) => post(tokens[i]!, `${prefix}::${(i % 6) + 1}`).then(status => { immediate++; return status; }));
        await new Promise(resolve => setTimeout(resolve, 600));
        const refused = immediate;
        await hold.query('ROLLBACK');
        const statuses = await Promise.all(all);
        // Admitted checks spent the per-user quota too; start each round fresh.
        await pool.query('DELETE FROM request_limits');
        return { refused, statuses };
      } finally {
        await hold.query('ROLLBACK').catch(() => undefined);
        hold.release();
      }
    };
    await onReplica(await build({}, { maxTokenChecksInFlight: CAP, maxLegacyChecksInFlight: 64 }), async () => {
      // 60 checks over six addresses of one /64: 20 are admitted in aggregate, 40 refused at once.
      expect((await settledWhileBlocked(valid.slice(0, 60), '2001:db8:aaaa:1', 60)).refused).toBe(40);
      // After success the counters are back to zero: the same cap applies again, not a smaller one.
      expect((await settledWhileBlocked(valid.slice(60, 120), '2001:db8:aaaa:1', 60)).refused).toBe(40);
      // After rejections too: 15 MAC-valid but unknown tokens are admitted, rejected and released.
      const forged = await settledWhileBlocked(forgedValid, '2001:db8:aaaa:2', 15);
      expect(forged.refused).toBe(0);
      expect(forged.statuses.every(s => s === 401)).toBe(true);
      expect((await settledWhileBlocked(valid.slice(120), '2001:db8:aaaa:2', 60)).refused).toBe(40);
      // Legacy-shaped tokens have their own cap (the shared one is untouched by them).
      expect((await settledWhileBlocked(Array.from({ length: 80 }, () => randomToken()), '2001:db8:aaaa:4', 80)).refused).toBe(16);
    });
    // After exceptions: a replica whose database is gone answers 500 and must not leak counts.
    const brokenPool = new Pool({ ...pool.options });
    const broken = await build({}, { maxTokenChecksInFlight: CAP }, new Store(brokenPool, new Keyring('v1', { v1: randomBytes(32) })));
    await brokenPool.end();
    await onReplica(broken, async () => {
      const statuses: number[] = [];
      for (let wave = 0; wave < 8; wave++)
        statuses.push(...await Promise.all(Array.from({ length: 10 }, (_, i) => post(accessTokens.generate(), `2001:db8:aaaa:3::${i + 1}`))));
      expect(new Set(statuses)).toEqual(new Set([500]));
    });
  });

  it('the real Better Auth handler issues, refreshes, introspects and revokes at1 tokens and keeps referenceId', async () => {
    const issued = await confidentialToken();
    const row = (await pool.query('SELECT * FROM "oauthAccessToken" WHERE token=$1', [digest(issued.access_token)])).rows[0];
    expect(row, 'the complete token is stored as its digest').toBeTruthy();
    expect(row.referenceId).toBe('personal');
    const introspect = async (value: string) => {
      const response = await fetch(`${config.origin}/api/auth/oauth2/introspect`, {
        method: 'POST', body: new URLSearchParams({ client_id: issued.clientId, client_secret: issued.secret, token: value, token_type_hint: 'access_token' }),
      });
      return { status: response.status, body: await response.json() as any };
    };
    const refreshed = await (await exchange(issued.clientId, { grant_type: 'refresh_token', refresh_token: issued.refresh_token, client_secret: issued.secret })).json() as any;
    expect(accessTokens.parse(refreshed.access_token)).toBeTruthy();
    expect((await mcpPost(refreshed.access_token)).status).toBe(ADMITTED);
    const refreshedRow = (await pool.query('SELECT "referenceId" FROM "oauthAccessToken" WHERE token=$1', [digest(refreshed.access_token)])).rows[0];
    expect(refreshedRow.referenceId).toBe('personal');
    expect(await introspect(refreshed.access_token)).toMatchObject({ body: { active: true } });
    const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();
    // A Bearer-prefixed revoke takes the user lock chosen from the at1 token, then revokes it.
    const { waits, response } = await holding(advisoryId(userLockKey(alice.id)), () => authPost('revoke', form({
      client_id: issued.clientId, client_secret: issued.secret, token: `Bearer ${refreshed.access_token}`, token_type_hint: 'access_token',
    })));
    expect(waits, 'the revoke queued on the user lock').toBe(true);
    expect(response.status).toBe(200);
    expect((await mcpPost(refreshed.access_token)).status).toBe(401);
    expect((await introspect(refreshed.access_token)).body).toMatchObject({ active: false });
  });

  it('the OIDC userinfo route, the only other route that takes an access token as a bearer, treats at1 and legacy tokens alike', async () => {
    const [at1] = await validTokens((await token()).access_token, 1) as [string];
    const [legacy] = await validTokens(at1, 1, () => randomToken()) as [string];
    const userinfo = async (value: string) => {
      const response = await fetch(`${config.origin}/api/auth/oauth2/userinfo`, { headers: { authorization: `Bearer ${value}` } });
      return { status: response.status, body: await response.json().catch(() => undefined) as any };
    };
    const forAt1 = await userinfo(at1);
    expect(forAt1.status, JSON.stringify(forAt1.body)).toBeLessThan(500);
    // Same answer for both shapes (the grant has no openid scope, so it is refused for the same reason),
    // and neither goes through the /mcp/account admission: no flood counter, no negative-cache entry.
    expect(await userinfo(legacy)).toEqual(forAt1);
    expect((await userinfo(accessTokens.generate())).status).toBeGreaterThanOrEqual(400);
    expect((await mcpPost(at1)).status).toBe(ADMITTED);
  });

  it('other bearer values are untouched by the at1 checks: the anonymous endpoint ignores them, with no lookup', async () => {
    const value = await freshToken();
    const post = (path: string, bearer: string) => fetch(`${config.origin}${path}`, {
      method: 'POST', headers: { authorization: `Bearer ${bearer}`, 'x-real-ip': '192.0.2.170', 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    }).then(r => r.status);
    await countingReplica({}, async lookups => {
      const before = await bucketCount('mcp-ip:192.0.2.170');
      // A valid at1 token, a made-up at1 value, a JWT-shaped value and a legacy-shaped one are all ignored at /mcp.
      for (const bearer of [value, accessTokens.generate(), `at1.${'x'.repeat(4000)}`, 'eyJhbGciOiJSUzI1NiJ9.e30.c2ln', randomToken()])
        expect(await post('/mcp', bearer), bearer.slice(0, 20)).toBe(200);
      expect(lookups.count).toBe(0);
      expect(await bucketCount('mcp-ip:192.0.2.170')).toBe(before);
      expect(await bucketCount('mcp-ip-legacy:192.0.2.170')).toBeUndefined();
    });
  });

});
