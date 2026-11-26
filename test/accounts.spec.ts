import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, get as httpGet, type Server } from 'node:http';
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
  async function register() {
    const response = await send(fetch, '/api/auth/oauth2/register', {
      client_name: 'Test assistant', redirect_uris: ['https://client.example/callback'],
      token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
    });
    expect(response.status, await response.clone().text()).toBe(201);
    return await response.json() as any;
  }
  async function beginAuthorization(clientBrowser = browser) {
    const client = await register();
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
  async function authorize(clientBrowser = browser, accept = true) {
    const { client, verifier, state, oauth_query: connectQuery } = await beginAuthorization(clientBrowser);
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
    expect(await bucket('mcp-ip:203.0.113.5')).toBe(2);
    expect(await bucket('mcp-ip:198.51.100.7')).toBe(1);
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
    expect(failed).toContain('rot:a');
    expect(failed).toContain('rot:d');
    expect(rotated).toBe(2);
    for (const owner of ['rot:b', 'rot:c']) expect(await after.getKey(owner)).toBe(`key-${owner}`);
    const kids = await pool.query(`SELECT owner, ciphertext->>'kid' AS kid FROM credentials WHERE owner LIKE 'rot:%' ORDER BY owner`);
    expect(kids.rows).toEqual([{ owner: 'rot:a', kid: 'gone' }, { owner: 'rot:b', kid: 'k2' }, { owner: 'rot:c', kid: 'k2' }, { owner: 'rot:d', kid: null }]);
    const audit = await pool.query(`SELECT action FROM audit_events WHERE tenant='rot:a' AND action='credential.reencrypt_failed'`);
    expect(audit.rowCount).toBe(1);
    // A second run has nothing left to migrate; the unopenable rows are reported again.
    expect((await after.rotateAllKeys(1)).rotated).toBe(0);
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
      const run = () => spawnSync(process.execPath, ['--import', 'tsx', 'src/bin.ts', '--rotate-keys'], { cwd: join(fileURLToPath(import.meta.url), '../..'), env, encoding: 'utf8' });
      const ok = run();
      expect(ok.status, ok.stderr).toBe(0);
      expect(ok.stderr + ok.stdout).toContain('accounts.keys_rotated');
      expect(await new Store(cliPool, new Keyring('k2', { k2 })).getKey('cli:a')).toBe('key-cli:a');
      await cliPool.query(`UPDATE credentials SET ciphertext=jsonb_set(ciphertext,'{kid}','"gone"') WHERE owner='cli:a'`);
      const bad = run();
      expect(bad.status).toBe(1);
      expect(bad.stderr + bad.stdout).toContain('accounts.key_rotation_failed');
      expect(bad.stderr + bad.stdout).not.toContain('key-cli:a');
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
    const where = [{ field: 'token', value: digest(a.access_token) }];
    const row = await adapter.findOne<any>({ model: 'oauthAccessToken', where });
    for (const [update, status] of [
      [{ expiresAt: new Date(0) }, 401],
      [{ resources: ['https://other.example/mcp'] }, 401],
      [{ scopes: ['offline_access'] }, 403],
    ] as const) {
      await adapter.update({ model: 'oauthAccessToken', where, update });
      expect((await mcp(a.access_token)).status).toBe(status);
      await adapter.update({ model: 'oauthAccessToken', where, update: { expiresAt: row.expiresAt, resources: row.resources, scopes: row.scopes } });
    }
    await adapter.update({ model: 'oauthClient', where: [{ field: 'clientId', value: a.clientId }], update: { disabled: true } });
    expect((await mcp(a.access_token)).status).toBe(401);
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
    expect(await bucketCount('mcp-ip:203.0.113.55')).toBe(2);
    expect(await bucketCount('mcp-ip:198.51.100.77')).toBe(1);
    expect(await bucketCount('mcp-ip:1.1.1.1')).toBeUndefined();
    expect(await bucketCount('mcp-ip:3.3.3.3')).toBeUndefined();
    // Addresses of one IPv6 /64 (and an IPv4-mapped form) share a bucket.
    for (const ip of ['2001:db8:1:2::1', '2001:db8:1:2:ffff::9', '2001:0DB8:1:2:0:0:0:3']) await mcpPost('nope', { 'x-real-ip': ip });
    expect(await bucketCount('mcp-ip:2001:db8:1:2::/64')).toBe(3);
    await mcpPost('nope', { 'x-real-ip': '::ffff:192.0.2.9' });
    await mcpPost('nope', { 'x-real-ip': '0:0:0:0:0:FFFF:c000:209' });
    expect(await bucketCount('mcp-ip:192.0.2.9')).toBe(2);
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
  it('refuses forged bearer tokens per IP before any database lookup, while valid tokens and database errors cost nothing', async () => {
    const valid = (await token()).access_token;
    const forged = (ip: string) => mcpPost('made-up', { 'x-real-ip': ip }).then(r => r.status);
    // A failure is counted once the token is proven invalid, so send them in small waves.
    const statuses: number[] = [];
    for (let wave = 0; wave < 26; wave++) statuses.push(...await Promise.all(Array.from({ length: 5 }, () => forged('192.0.2.44'))));
    expect(statuses.filter(s => s === 401).length).toBeGreaterThanOrEqual(120);
    expect(statuses.filter(s => s === 429).length).toBeGreaterThan(0);
    // Past the limit a made-up token never reaches the flood guard's upsert (so no token lookup either).
    const counted = (await bucketCount('mcp-ip:192.0.2.44'))!;
    const more = await Promise.all(Array.from({ length: 10 }, () => forged('192.0.2.44')));
    expect(await bucketCount('mcp-ip:192.0.2.44')).toBe(counted + more.filter(s => s === 401).length);
    expect(await forged('192.0.2.45')).toBe(401);
    // A valid token spends nothing: far more than the burst of 120 from one address all pass.
    const ok = new Set<number>();
    for (let i = 0; i < 130; i++) ok.add((await mcpPost(valid, { 'x-real-ip': '192.0.2.46' })).status);
    expect([...ok].every(status => status !== 429 && status !== 401), [...ok].join()).toBe(true);
    // Neither does a database error: a broken replica answers 500 each time without spending the budget.
    const brokenPool = new Pool({ ...pool.options });
    const brokenStore = new Store(brokenPool, new Keyring('v1', { v1: randomBytes(32) }));
    const replica = await build({}, undefined, brokenStore);
    await brokenPool.end();
    await onReplica(replica, async () => {
      const failed: number[] = [];
      for (let wave = 0; wave < 30; wave++) failed.push(...await Promise.all(Array.from({ length: 10 }, () => forged('192.0.2.47'))));
      expect(new Set(failed)).toEqual(new Set([500]));
    });
  });
  it('spends no failed-token budget on early 429s: the in-flight cap and the flood guard', async () => {
    const forged = (ip: string) => mcpPost('made-up', { 'x-real-ip': ip }).then(r => r.status);
    const replica = await build({}, { failedTokenLimit: { rps: 0.001, burst: 3 }, maxTokenChecksInFlight: 1 });
    await onReplica(replica, async () => {
      // The in-flight cap: one check stalls on a held table lock, the next three are refused at once.
      const hold = await pool.connect();
      let first: Promise<number>;
      let refused: number[];
      try {
        await hold.query('BEGIN');
        await hold.query('LOCK TABLE request_limits IN ACCESS EXCLUSIVE MODE');
        first = forged('192.0.2.150');
        await new Promise(resolve => setTimeout(resolve, 300));
        refused = await Promise.all([forged('192.0.2.150'), forged('192.0.2.150'), forged('192.0.2.150')]);
        await hold.query('ROLLBACK');
      } finally { await hold.query('ROLLBACK').catch(() => undefined); hold.release(); }
      expect(refused).toEqual([429, 429, 429]);
      expect(await first).toBe(401); // spent one of three
      // The budget has exactly two left: three early 429s did not drain it.
      expect([await forged('192.0.2.150'), await forged('192.0.2.150'), await forged('192.0.2.150')]).toEqual([401, 401, 429]);
      // The flood guard: with the persistent per-IP count over its limit, a forged token is a 429 that costs nothing.
      await pool.query('INSERT INTO request_limits(bucket,count,expires_at) VALUES($1,6000,now()+interval \'60 seconds\') ON CONFLICT(bucket) DO UPDATE SET count=6000', [digest('mcp-ip:192.0.2.151')]);
      expect([await forged('192.0.2.151'), await forged('192.0.2.151'), await forged('192.0.2.151'), await forged('192.0.2.151')]).toEqual([429, 429, 429, 429]);
      await pool.query('DELETE FROM request_limits WHERE bucket=$1', [digest('mcp-ip:192.0.2.151')]);
      expect([await forged('192.0.2.151'), await forged('192.0.2.151'), await forged('192.0.2.151')]).toEqual([401, 401, 401]);
    });
  });
  it('caps in-flight bearer checks per IPv6 /64 in aggregate and releases the counters', async () => {
    const valid = (await token()).access_token;
    const CAP = 20;
    const post = (bearer: string, ip: string) => mcpPost(bearer, { 'x-real-ip': ip }).then(r => r.status);
    const settledWhileBlocked = async (bearer: string, prefix: string, total: number) => {
      // A held table lock stalls every bearer check inside the counted section.
      const hold = await pool.connect();
      try {
        await hold.query('BEGIN');
        await hold.query('LOCK TABLE request_limits IN ACCESS EXCLUSIVE MODE');
        let immediate = 0;
        const all = Array.from({ length: total }, (_, i) => post(bearer, `${prefix}::${(i % 6) + 1}`).then(status => { immediate++; return status; }));
        await new Promise(resolve => setTimeout(resolve, 600));
        const refused = immediate;
        await hold.query('ROLLBACK');
        const statuses = await Promise.all(all);
        await pool.query('DELETE FROM request_limits');
        return { refused, statuses };
      } finally { await hold.query('ROLLBACK').catch(() => undefined); hold.release(); }
    };
    await onReplica(await build({}, { maxTokenChecksInFlight: CAP }), async () => {
      // 60 checks over six addresses of one /64: 20 admitted in aggregate, 40 refused at once.
      expect((await settledWhileBlocked(valid, '2001:db8:aaaa:1', 60)).refused).toBe(40);
      // After success the counters are back to zero: the same cap applies again, not a smaller one.
      expect((await settledWhileBlocked(valid, '2001:db8:aaaa:1', 60)).refused).toBe(40);
      // After rejections too.
      const forged = await settledWhileBlocked('made-up', '2001:db8:aaaa:2', 15);
      expect(forged.refused).toBe(0);
      expect(forged.statuses.every(s => s === 401)).toBe(true);
      expect((await settledWhileBlocked(valid, '2001:db8:aaaa:2', 60)).refused).toBe(40);
    });
    // After exceptions: a replica whose database is gone answers 500 and must not leak counts.
    const brokenPool = new Pool({ ...pool.options });
    const replica = await build({}, { maxTokenChecksInFlight: CAP }, new Store(brokenPool, new Keyring('v1', { v1: randomBytes(32) })));
    await brokenPool.end();
    await onReplica(replica, async () => {
      const statuses: number[] = [];
      for (let wave = 0; wave < 8; wave++) statuses.push(...await Promise.all(Array.from({ length: 10 }, (_, i) => post(valid, `2001:db8:aaaa:3::${i + 1}`))));
      expect(new Set(statuses)).toEqual(new Set([500]));
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
});
