import { request as httpRequest } from 'node:http';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MockAgent } from 'undici';
import type { Server } from 'node:http';
import type { Tool } from '@modelcontextprotocol/server';
import { expectToolMetadata } from './tool-metadata.js';
import { startHttp, type HttpHandle } from '../src/server/http.js';
import { buildSdk } from '../src/sdk/bindings.js';
import { getSources } from '../src/sdk/sources/index.js';
import { buildCorpus } from '../src/search/corpus.js';
import { pickSandbox } from '../src/sandbox/index.js';
import type { CatalogDeps } from '../src/server/toolCatalog.js';
import { SubjectQuota } from '../src/util/quotas.js';
import { ExecutionLimiter } from '../src/util/executionLimiter.js';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
type SigningKey = Parameters<SignJWT['sign']>[0];

let handle: HttpHandle;
let base: string;
let mockAgent: MockAgent;
let sandboxAvailable: boolean;
let deps: CatalogDeps;

beforeAll(async () => {
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  // Pre-stub one upstream so the sandbox→SDK path has a known response.
  mockAgent.get('https://www.federalregister.gov')
    .intercept({ path: '/api/v1/agencies', method: 'GET' })
    .reply(200, [{ slug: 'epa', short_name: 'EPA' }, { slug: 'doe', short_name: 'DOE' }])
    .persist();

  const sdk = buildSdk({
    frBaseUrl: 'https://www.federalregister.gov/api/v1',
    ecfrBaseUrl: 'https://www.ecfr.gov/api',
    regsBaseUrl: 'https://api.regulations.gov',
    userAgent: 'test/0.0',
    timeoutMs: 5000,
    retries: 0,
    cacheTtlMs: 60_000,
    cacheMaxItems: 10,
    dispatcher: mockAgent,
  });
  const sandbox = await pickSandbox('auto');
  sandboxAvailable = await sandbox.available();
  const corpus = buildCorpus(getSources({
    frBaseUrl: 'https://www.federalregister.gov/api/v1', ecfrBaseUrl: 'https://www.ecfr.gov/api',
    regsBaseUrl: 'https://api.regulations.gov', userAgent: 'test/0.0', timeoutMs: 5000, retries: 0, cacheTtlMs: 0, cacheMaxItems: 0,
  }));
  deps = { sdk, sandbox, corpus, regsMaxCallsPerExecute: 30, regsSubjectQuota: new SubjectQuota(1_000_000, 3_600_000) };
  handle = await startHttp(deps, {
    host: '127.0.0.1',
    port: 0,
    rps: 1000,
    burst: 1000,
    subjectDailyQuota: 1_000_000,
    insecure: true,
    auth: { provider: 'none' },
    publicOrigin: 'http://127.0.0.1',
  });
  base = `http://127.0.0.1:${handle.port}`;
});

afterAll(async () => {
  await handle.close();
  await mockAgent.close();
});

function parseSseOrJson(text: string, contentType: string): unknown {
  if (contentType.includes('text/event-stream')) {
    // Look for the first `data: ...` line and parse it.
    for (const line of text.split('\n')) {
      if (line.startsWith('data:')) {
        const payload = line.slice(5).trim();
        if (payload) return JSON.parse(payload);
      }
    }
    return undefined;
  }
  return JSON.parse(text);
}

const PROTOCOL_VERSION = '2026-07-28';

/** The `_meta` envelope 2026-07-28 requires on every request. */
function meta() {
  return {
    'io.modelcontextprotocol/protocolVersion': PROTOCOL_VERSION,
    'io.modelcontextprotocol/clientInfo': { name: 'it', version: '0' },
    'io.modelcontextprotocol/clientCapabilities': {},
  };
}

async function post(url: string, body: unknown, headers: Record<string, string> = {}, signal?: AbortSignal) {
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'accept': 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
  const text = await r.text();
  return {
    status: r.status,
    sessionId: r.headers.get('mcp-session-id') ?? undefined,
    contentType: r.headers.get('content-type') ?? '',
    body: text ? parseSseOrJson(text, r.headers.get('content-type') ?? '') : undefined,
    raw: text,
  };
}

/**
 * A single self-contained 2026-07-28 request: no handshake, no session id, routing
 * headers mirrored from the body as the transport requires.
 */
async function rpc(
  method: string,
  params: Record<string, unknown> = {},
  opts: { id?: number; name?: string; headers?: Record<string, string>; target?: string; signal?: AbortSignal } = {},
) {
  const name = opts.name ?? (params.name as string | undefined);
  return post(
    `${opts.target ?? base}/mcp`,
    { jsonrpc: '2.0', id: opts.id ?? 1, method, params: { ...params, _meta: meta() } },
    {
      'mcp-protocol-version': PROTOCOL_VERSION,
      'mcp-method': method,
      ...(name ? { 'mcp-name': name } : {}),
      ...opts.headers,
    },
    opts.signal,
  );
}

describe('Streamable HTTP transport', () => {
  it('blocks internal methods and cross-request cache poisoning over MCP', async ({ skip }) => {
    if (!sandboxAvailable) return skip();
    const call = async (code: string) => {
      const response = await rpc('tools/call', { name: 'execute', arguments: { code, timeoutMs: 3000 } });
      expect(response.status).toBe(200);
      const body = response.body as { result: { content: Array<{ text: string }> } };
      return JSON.parse(body.result.content[0]!.text) as { ok: boolean; value?: unknown };
    };
    const attack = await call(`
      const errors = [];
      try { await fr.http.call({ method: 'POST', path: '/blocked' }); errors.push('ALLOWED'); }
      catch (e) { errors.push(e.name); }
      try { await fr.http.cache.set('https://www.federalregister.gov/api/v1/agencies', { status: 200, body: [{ slug: 'forged' }], headers: {} }); errors.push('ALLOWED'); }
      catch (e) { errors.push(e.name); }
      return errors;
    `);
    expect(attack.ok).toBe(true);
    expect(attack.value).toEqual(['TypeError', 'TypeError']);
    const read = await call('return await fr.agencies.list();');
    expect(read.ok).toBe(true);
    expect(read.value).toEqual([{ slug: 'epa', short_name: 'EPA' }, { slug: 'doe', short_name: 'DOE' }]);
  });

  it('serves OAuth 2.0 Protected Resource Metadata', async () => {
    const r = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`);
    expect(r.status).toBe(200);
    const meta = await r.json() as Record<string, unknown>;
    expect(meta.resource).toBe('http://127.0.0.1/mcp');
    expect(meta.resource_name).toBe('Federal Regulations MCP Server');
    expect(Array.isArray(meta.bearer_methods_supported)).toBe(true);
  });

  it('serves /health reporting the modern protocol revision', async () => {
    const r = await fetch(`${base}/health`);
    expect(r.status).toBe(200);
    const j = await r.json() as { ok: boolean; protocolVersion: string };
    expect(j.ok).toBe(true);
    // Guards against reintroducing the SDK's LATEST_PROTOCOL_VERSION here, which is
    // the legacy-era constant ('2025-11-25'), not the revision this server speaks.
    expect(j.protocolVersion).toBe(PROTOCOL_VERSION);
  });

  it('lists tools from a single stateless request and mints no session', async () => {
    const list = await rpc('tools/list');
    expect(list.status).toBe(200);
    // The protocol-level session is gone: nothing to steal, reuse, or bind a subject to.
    expect(list.sessionId).toBeUndefined();
    const listBody = list.body as { result?: { tools?: Tool[] } };
    expectToolMetadata(listBody.result?.tools ?? []);
    const names = (listBody?.result?.tools ?? []).map(t => t.name).sort();
    expect(names).toEqual(['describe_schema', 'execute', 'search_api']);
  });

  it('advertises capabilities and supported versions via server/discover', async () => {
    const r = await rpc('server/discover');
    expect(r.status).toBe(200);
    const body = r.body as {
      result?: {
        capabilities?: Record<string, unknown>;
        supportedVersions?: string[];
        resultType?: string;
        _meta?: Record<string, { name?: string }>;
      };
    };
    expect(body.result?.capabilities?.tools).toBeDefined();
    expect(body.result?.supportedVersions ?? []).toContain(PROTOCOL_VERSION);
    expect(body.result?.resultType).toBe('complete');
    expect(body.result?._meta?.['io.modelcontextprotocol/serverInfo']?.name).toBe('fedreg-mcp-server');
  });

  it('tags list results with cache metadata', async () => {
    const list = await rpc('tools/list');
    const body = list.body as { result?: { ttlMs?: number; cacheScope?: string } };
    expect(typeof body.result?.ttlMs).toBe('number');
    expect(['public', 'private']).toContain(body.result?.cacheScope);
  });

  // Both of these shapes changed with the v2 SDK and are easy to regress silently,
  // since neither is what the v1 hand-written CallTool handler produced.
  it('reports an unknown tool as a JSON-RPC error, not an isError result', async () => {
    const r = await rpc('tools/call', { name: 'no_such_tool', arguments: {} });
    expect(r.status).toBe(200);
    const body = r.body as { result?: unknown; error?: { code?: number; message?: string } };
    expect(body.result).toBeUndefined();
    expect(body.error?.code).toBe(-32602);
    expect(body.error?.message).toMatch(/not found/i);
  });

  it('rejects unknown argument keys (schemas are additionalProperties:false)', async () => {
    const r = await rpc('tools/call', {
      name: 'search_api',
      arguments: { query: 'agencies', k: 1, unexpected: 'x' },
    });
    expect(r.status).toBe(200);
    const body = r.body as { result?: { isError?: boolean; content?: Array<{ text: string }> } };
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content?.[0]?.text ?? '').toMatch(/must NOT have additional properties/);
  });

  it('rejects a request whose Mcp-Name header disagrees with the body (-32020)', async () => {
    const r = await rpc(
      'tools/call',
      { name: 'search_api', arguments: { query: 'test', k: 1 } },
      { headers: { 'mcp-name': 'describe_schema' } },
    );
    expect(r.status).toBe(400);
    const body = r.body as { error?: { code?: number } };
    expect(body.error?.code).toBe(-32020);
  });

  it('rejects a modern request that omits the required Mcp-Method header', async () => {
    const r = await post(`${base}/mcp`, {
      jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: meta() },
    }, { 'mcp-protocol-version': PROTOCOL_VERSION });
    expect(r.status).toBe(400);
    const body = r.body as { error?: { code?: number } };
    expect(body.error?.code).toBe(-32020);
  });

  it('calls search_api and returns hits', async () => {
    const search = await rpc('tools/call', {
      name: 'search_api',
      arguments: { query: 'electronic code of federal regulations search', k: 3 },
    });
    expect(search.status).toBe(200);
    const sb = search.body as { result?: { content?: Array<{ type: string; text: string }>; structuredContent?: unknown } };
    const text = sb?.result?.content?.[0]?.text ?? '';
    const parsed = JSON.parse(text) as { hits: Array<{ id: string }> };
    // The same object is delivered as structuredContent (the tool declares an outputSchema).
    expect(sb.result?.structuredContent).toEqual(parsed);
    expect(parsed.hits.length).toBeGreaterThan(0);
    expect(parsed.hits.some(h => h.id.startsWith('ecfr.'))).toBe(true);
  });

  it('runs execute in the sandbox', async () => {
    // Returns either a value or a clear SandboxUnavailable error, depending on
    // whether isolated-vm/deno is installed locally.
    const exec = await rpc('tools/call', {
      name: 'execute',
      arguments: { code: 'return 1 + 2', timeoutMs: 3000 },
    });
    expect(exec.status).toBe(200);
    const eb = exec.body as { result?: { content?: Array<{ text: string }>; structuredContent?: unknown } };
    const execText = eb?.result?.content?.[0]?.text ?? '';
    const execResult = JSON.parse(execText) as { ok: boolean; value?: unknown; error?: { name: string } };
    expect(eb.result?.structuredContent).toEqual(execResult);
    if (execResult.ok) {
      expect(execResult.value).toBe(3);
    } else {
      expect(['SandboxUnavailable', 'PolicyError']).toContain(execResult.error?.name);
    }
  });

  it('returns a failed execution as isError with the full envelope in structuredContent', async () => {
    // eval is rejected by the AST preflight, so no sandbox runner is needed.
    const exec = await rpc('tools/call', { name: 'execute', arguments: { code: 'return eval("1")' } });
    expect(exec.status).toBe(200);
    const body = exec.body as { result?: { isError?: boolean; content?: Array<{ text: string }>; structuredContent?: { ok: boolean; error?: { name: string }; logs: string[] } } };
    expect(body.result?.isError).toBe(true);
    expect(body.result?.structuredContent).toMatchObject({ ok: false, logs: [], error: { name: 'PolicyError' } });
    expect(JSON.parse(body.result!.content![0]!.text)).toEqual(body.result?.structuredContent);
  });

  it('execute can call into fr.* SDK and receive mocked HTTP response', async () => {
    const exec = await rpc('tools/call', {
      name: 'execute',
      arguments: {
        code: 'const r = await fr.agencies.list(); return { count: Array.isArray(r) ? r.length : 0, first: Array.isArray(r) ? r[0] : null };',
        timeoutMs: 5000,
      },
    });

    const eb = exec.body as { result?: { content?: Array<{ text: string }> } };
    const execText = eb?.result?.content?.[0]?.text ?? '';
    const execResult = JSON.parse(execText) as { ok: boolean; value?: { count: number; first?: { slug: string } }; error?: { name: string } };
    if (execResult.ok) {
      expect(execResult.value?.count).toBe(2);
      expect(execResult.value?.first?.slug).toBe('epa');
    } else {
      // Skip cleanly if no sandbox is available in this environment.
      expect(['SandboxUnavailable']).toContain(execResult.error?.name);
    }
  });
});

describe('Legacy 2025-era compatibility', () => {
  it('still serves an initialize handshake and a tool call for pre-2026 clients', async () => {
    const init = await post(`${base}/mcp`, {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'legacy', version: '0' } },
    });
    expect(init.status).toBe(200);
    const initBody = init.body as { result?: { protocolVersion?: string } };
    expect(initBody?.result?.protocolVersion).toBeDefined();

    // Legacy serving is per-request and stateless, so no session id is issued to pin to.
    const list = await post(`${base}/mcp`, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    expect(list.status).toBe(200);
    const listBody = list.body as { result?: { tools?: Tool[] } };
    expectToolMetadata(listBody.result?.tools ?? []);
    expect((listBody?.result?.tools ?? []).map(t => t.name).sort())
      .toEqual(['describe_schema', 'execute', 'search_api']);
  });

  it('answers 2025 session operations (GET/DELETE) with 405', async () => {
    for (const method of ['GET', 'DELETE']) {
      const r = await fetch(`${base}/mcp`, { method });
      expect(r.status).toBe(405);
    }
  });
});

describe('Auth enforcement (OIDC, signed tokens from a local issuer)', () => {
  let secured: HttpHandle;
  let secBase: string;
  let jwks: Server;
  let issuerKey: SigningKey;
  let otherKey: SigningKey;
  const ISSUER = 'https://issuer.test';
  const AUDIENCE = 'https://fedreg-mcp.test/mcp';
  let jwksUrl: string;
  const cfg = {
    frBaseUrl: 'https://www.federalregister.gov/api/v1', ecfrBaseUrl: 'https://www.ecfr.gov/api',
    regsBaseUrl: 'https://api.regulations.gov', userAgent: 'test/0.0', timeoutMs: 5000, retries: 0, cacheTtlMs: 0, cacheMaxItems: 0,
  };
  const deps = async (): Promise<CatalogDeps> => ({
    sdk: buildSdk(cfg), sandbox: await pickSandbox('auto'), corpus: buildCorpus(getSources(cfg)),
    regsMaxCallsPerExecute: 30, regsSubjectQuota: new SubjectQuota(1_000_000, 3_600_000),
  });

  const sign = async (claims: Record<string, unknown>, opts: { key?: SigningKey; exp?: string | number | null } = {}) => {
    const jwt = new SignJWT({ scope: 'fedreg:read', ...claims }).setProtectedHeader({ alg: 'ES256', kid: 'k1' }).setIssuedAt();
    if (opts.exp !== null) jwt.setExpirationTime(opts.exp ?? '5m');
    return jwt.sign(opts.key ?? issuerKey);
  };
  const list = (token?: string) => rpc('tools/list', {}, { target: secBase, headers: token ? { authorization: `Bearer ${token}` } : {} });

  beforeAll(async () => {
    const pair = await generateKeyPair('ES256');
    issuerKey = pair.privateKey;
    otherKey = (await generateKeyPair('ES256')).privateKey;
    const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'ES256', use: 'sig' };
    const { createServer } = await import('node:http');
    jwks = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ keys: [jwk] })); });
    await new Promise<void>(r => jwks.listen(0, '127.0.0.1', r));
    jwksUrl = `http://127.0.0.1:${(jwks.address() as { port: number }).port}/jwks.json`;
    secured = await startHttp(await deps(), {
      host: '127.0.0.1', port: 0, rps: 1000, burst: 1000, subjectDailyQuota: 1_000_000,
      auth: { provider: 'generic-oidc', issuer: ISSUER, audience: AUDIENCE, jwksUrl, scopes: ['fedreg:read'] },
    });
    secBase = `http://127.0.0.1:${secured.port}`;
  });

  afterAll(async () => {
    await secured.close();
    await new Promise<void>(r => jwks.close(() => r()));
  });

  it('rejects requests without a bearer token with 401 and resource metadata', async () => {
    const r = await list();
    expect(r.status).toBe(401);
  });

  // Every request re-authenticates; there is no session id a second caller could reuse.
  it('accepts a valid token, on every request (no session)', async () => {
    const token = await sign({ sub: 'user-1', iss: ISSUER, aud: AUDIENCE });
    const ok = await list(token);
    expect(ok.status).toBe(200);
    expect(ok.sessionId).toBeUndefined();
    expect((await list()).status).toBe(401);
  });

  it.each([
    ['arbitrary text', async () => 'not-a-jwt'],
    ['wrong signing key', async () => sign({ sub: 'u', iss: ISSUER, aud: AUDIENCE }, { key: otherKey })],
    ['another service\'s audience', async () => sign({ sub: 'u', iss: ISSUER, aud: 'unrelated-service' })],
    ['wrong issuer', async () => sign({ sub: 'u', iss: 'https://evil.test', aud: AUDIENCE })],
    ['no expiration', async () => sign({ sub: 'u', iss: ISSUER, aud: AUDIENCE }, { exp: null })],
    ['expired', async () => sign({ sub: 'u', iss: ISSUER, aud: AUDIENCE }, { exp: Math.floor(Date.now() / 1000) - 60 })],
    ['no subject', async () => sign({ iss: ISSUER, aud: AUDIENCE })],
  ])('rejects a token with %s (401)', async (_label, make) => {
    expect((await list(await make())).status).toBe(401);
  });

  it('rejects a valid token without the required scope (403 insufficient_scope)', async () => {
    const r = await list(await sign({ sub: 'u', iss: ISSUER, aud: AUDIENCE, scope: 'other' }));
    expect(r.status).toBe(403);
  });

  it('refuses to start without real authentication or with an unknown/incomplete provider', async () => {
    const base = { host: '127.0.0.1', port: 0, rps: 10, burst: 10, subjectDailyQuota: 10 };
    await expect(startHttp(await deps(), { ...base, auth: { provider: 'none' } })).rejects.toThrow(/needs authentication/);
    await expect(startHttp(await deps(), { ...base, auth: { provider: 'embedded' as 'none' } })).rejects.toThrow(/Unknown FEDREG_AUTH_PROVIDER/);
    await expect(startHttp(await deps(), { ...base, auth: { provider: 'generic-oidc', issuer: ISSUER, jwksUrl } })).rejects.toThrow(/AUDIENCE/);
    await expect(startHttp(await deps(), { ...base, auth: { provider: 'generic-oidc', audience: AUDIENCE, jwksUrl } })).rejects.toThrow(/ISSUER/);
    await expect(startHttp(await deps(), { ...base, host: '0.0.0.0', insecure: true, auth: { provider: 'none' } })).rejects.toThrow(/FEDREG_PUBLIC_ORIGIN/);
    // Authenticated beyond loopback: allowed hosts alone cannot name the URL OAuth metadata advertises.
    const oidc = { provider: 'generic-oidc' as const, issuer: ISSUER, audience: AUDIENCE, jwksUrl };
    await expect(startHttp(await deps(), { ...base, host: '0.0.0.0', allowedHosts: ['mcp.example.com'], auth: oidc })).rejects.toThrow(/needs FEDREG_PUBLIC_ORIGIN/);
  });
});

describe('Host validation (DNS rebinding)', () => {
  // fetch() cannot set Host (a forbidden header), so use node:http to send exactly what an
  // attacker's DNS-rebound page would.
  const raw = async (path: string, headers: Record<string, string>, body?: string) => {
    const { request } = await import('node:http');
    const url = new URL(base);
    return await new Promise<number>((resolve, reject) => {
      const req = request({ host: url.hostname, port: url.port, path, method: body ? 'POST' : 'GET', headers }, res => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on('error', reject);
      req.end(body);
    });
  };
  it('rejects a foreign Host even when Origin matches it, and accepts loopback', async () => {
    expect(await raw('/health', { host: 'attacker.example' })).toBe(200); // platform health checks carry their own Host
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: meta() } });
    expect(await raw('/mcp', { host: 'attacker.example', origin: 'http://attacker.example', 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body)).toBe(421);
    expect(await raw('/health', { host: `127.0.0.1:${new URL(base).port}` })).toBe(200);
  });
});

describe('Origin validation (MCP spec MUST — DNS rebinding / CSRF)', () => {
  it('rejects a cross-origin browser request on /mcp with 403', async () => {
    const r = await rpc('tools/list', {}, { headers: { origin: 'https://evil.example.com' } });
    expect(r.status).toBe(403);
    expect((r.body as { error?: string }).error).toBe('origin_not_allowed');
  });

  it('allows loopback origins by default (local web tooling)', async () => {
    const r = await rpc('tools/list', {}, { headers: { origin: 'http://localhost:5173' } });
    expect(r.status).toBe(200);
  });

  it('non-browser requests (no Origin header) are unaffected', async () => {
    const r = await rpc('tools/list', {});
    expect(r.status).toBe(200);
  });

  describe('with an explicit allowlist', () => {
    let originHandle: HttpHandle;
    let originBase: string;

    beforeAll(async () => {
      const sdk = buildSdk({
        frBaseUrl: 'https://www.federalregister.gov/api/v1',
        ecfrBaseUrl: 'https://www.ecfr.gov/api',
        regsBaseUrl: 'https://api.regulations.gov',
        userAgent: 'test/0.0', timeoutMs: 5000, retries: 0, cacheTtlMs: 0, cacheMaxItems: 0,
      });
      const sandbox = await pickSandbox('auto');
      const corpus = buildCorpus(getSources({
        frBaseUrl: 'https://www.federalregister.gov/api/v1', ecfrBaseUrl: 'https://www.ecfr.gov/api',
        regsBaseUrl: 'https://api.regulations.gov', userAgent: 'test/0.0', timeoutMs: 5000, retries: 0, cacheTtlMs: 0, cacheMaxItems: 0,
      }));
      originHandle = await startHttp({ sdk, sandbox, corpus, regsMaxCallsPerExecute: 30, regsSubjectQuota: new SubjectQuota(1_000_000, 3_600_000) }, {
        host: '127.0.0.1', port: 0,
        rps: 1000, burst: 1000, subjectDailyQuota: 1_000_000,
        insecure: true,
        auth: { provider: 'none' },
        publicOrigin: 'http://127.0.0.1',
        allowedOrigins: ['https://app.example.com'],
      });
      originBase = `http://127.0.0.1:${originHandle.port}`;
    });

    afterAll(async () => { await originHandle.close(); });

    it('allows an allowlisted origin', async () => {
      const r = await rpc('tools/list', {}, { target: originBase, headers: { origin: 'https://app.example.com' } });
      expect(r.status).toBe(200);
    });

    it('still rejects origins outside the allowlist', async () => {
      const r = await rpc('tools/list', {}, { target: originBase, headers: { origin: 'https://other.example.com' } });
      expect(r.status).toBe(403);
      expect((r.body as { error?: string }).error).toBe('origin_not_allowed');
    });
  });
});

describe('per-IP rate limit behind a reverse proxy', () => {
  async function server(clientIpHeader?: string) {
    const h = await startHttp(deps, {
      host: '127.0.0.1', port: 0, rps: 0.001, burst: 2, subjectDailyQuota: 1_000_000,
      ...(clientIpHeader ? { clientIpHeader } : {}),
      insecure: true, auth: { provider: 'none' }, publicOrigin: 'http://127.0.0.1',
    });
    const status = async (realIp?: string) =>
      (await fetch(`http://127.0.0.1:${h.port}/health`, realIp ? { headers: { 'x-real-ip': realIp } } : {})).status;
    return { h, status };
  }

  it('limits each client separately by the header the proxy sets', async () => {
    const { h, status } = await server('x-real-ip');
    try {
      expect([await status('203.0.113.7'), await status('203.0.113.7'), await status('203.0.113.7')]).toEqual([200, 200, 429]);
      // Another client behind the same proxy has its own bucket.
      expect(await status('198.51.100.9')).toBe(200);
    } finally { await h.close(); }
  });

  it('ignores the header when none is trusted', async () => {
    const { h, status } = await server();
    try {
      expect([await status('203.0.113.1'), await status('203.0.113.2'), await status('203.0.113.3')]).toEqual([200, 200, 429]);
    } finally { await h.close(); }
  });
});

describe('Client disconnect cancels the execution', () => {
  it('frees the execution slot when the HTTP client goes away', async ({ skip }) => {
    if (!sandboxAvailable) return skip();
    const h = await startHttp({ ...deps, executionLimiter: new ExecutionLimiter(1, 1) }, {
      host: '127.0.0.1', port: 0, rps: 1000, burst: 1000, subjectDailyQuota: 1_000_000, insecure: true, auth: { provider: 'none' }, publicOrigin: 'http://127.0.0.1',
    });
    const target = `http://127.0.0.1:${h.port}`;
    const run = (code: string, timeoutMs: number, signal?: AbortSignal) =>
      rpc('tools/call', { name: 'execute', arguments: { code, timeoutMs } }, { target, ...(signal ? { signal } : {}) });
    try {
      const controller = new AbortController();
      const hanging = run('await new Promise(() => {})', 60_000, controller.signal).catch(() => 'aborted');
      await new Promise(r => setTimeout(r, 400));
      // The only slot is taken while the client is connected.
      const busy = await run('return 1', 5000);
      expect(JSON.parse((busy.body as { result: { content: Array<{ text: string }> } }).result.content[0]!.text)).toMatchObject({ ok: false, error: { name: 'Busy' } });
      controller.abort();
      await hanging;
      // The slot is free again well before the 60 s execution timeout.
      let next: { ok?: boolean; value?: unknown } | undefined;
      for (let i = 0; i < 30 && !next?.ok; i++) {
        await new Promise(r => setTimeout(r, 100));
        const r = await run('return 7', 5000);
        next = JSON.parse((r.body as { result: { content: Array<{ text: string }> } }).result.content[0]!.text);
      }
      expect(next).toMatchObject({ ok: true, value: 7 });
    } finally {
      await h.close();
    }
  });
});

describe('request body cap', () => {
  it('refuses an oversized body while it is still arriving', async () => {
    // Announce 2 MiB but send only a little and never finish: a server that buffers the whole body
    // before checking would wait forever; the cap must answer 413 from the length alone.
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(`${base}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'content-length': String(2 * 1024 * 1024) },
      }, (res) => { res.resume(); resolve(res.statusCode ?? 0); req.destroy(); });
      req.on('error', (err) => { if (!(err as NodeJS.ErrnoException).code?.startsWith('ECONNRESET')) reject(err); });
      req.write('{"jsonrpc":"2.0"');
      setTimeout(() => reject(new Error('no response before the body finished')), 5000).unref();
    });
    expect(status).toBe(413);
  });
});
