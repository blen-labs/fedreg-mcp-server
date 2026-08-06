import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MockAgent } from 'undici';
import { startHttp, type HttpHandle } from '../src/server/http.js';
import { buildSdk } from '../src/sdk/bindings.js';
import { getSources } from '../src/sdk/sources/index.js';
import { buildCorpus } from '../src/search/corpus.js';
import { pickSandbox } from '../src/sandbox/index.js';
import type { CatalogDeps } from '../src/server/toolCatalog.js';
import { SubjectQuota } from '../src/util/quotas.js';

let handle: HttpHandle;
let base: string;
let mockAgent: MockAgent;

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
    cacheTtlMs: 0,
    cacheMaxItems: 0,
    dispatcher: mockAgent,
  });
  const sandbox = await pickSandbox('auto');
  const corpus = buildCorpus(getSources({
    frBaseUrl: 'https://www.federalregister.gov/api/v1', ecfrBaseUrl: 'https://www.ecfr.gov/api',
    regsBaseUrl: 'https://api.regulations.gov', userAgent: 'test/0.0', timeoutMs: 5000, retries: 0, cacheTtlMs: 0, cacheMaxItems: 0,
  }));
  const deps: CatalogDeps = { sdk, sandbox, corpus, regsMaxCallsPerExecute: 30, regsSubjectQuota: new SubjectQuota(1_000_000, 3_600_000) };
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

async function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'accept': 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify(body),
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
  opts: { id?: number; name?: string; headers?: Record<string, string>; target?: string } = {},
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
  );
}

describe('Streamable HTTP transport', () => {
  it('serves OAuth 2.0 Protected Resource Metadata', async () => {
    const r = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`);
    expect(r.status).toBe(200);
    const meta = await r.json() as Record<string, unknown>;
    expect(meta.resource).toBe('http://127.0.0.1/mcp');
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
    const listBody = list.body as { result?: { tools?: Array<{ name: string }> } };
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
    const sb = search.body as { result?: { content?: Array<{ type: string; text: string }> } };
    const text = sb?.result?.content?.[0]?.text ?? '';
    const parsed = JSON.parse(text) as { hits: Array<{ id: string }> };
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
    const eb = exec.body as { result?: { content?: Array<{ text: string }> } };
    const execText = eb?.result?.content?.[0]?.text ?? '';
    const execResult = JSON.parse(execText) as { ok: boolean; value?: unknown; error?: { name: string } };
    if (execResult.ok) {
      expect(execResult.value).toBe(3);
    } else {
      expect(['SandboxUnavailable', 'PolicyError']).toContain(execResult.error?.name);
    }
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
    const listBody = list.body as { result?: { tools?: Array<{ name: string }> } };
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

describe('Auth enforcement', () => {
  let secured: HttpHandle;
  let secBase: string;

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
    secured = await startHttp({ sdk, sandbox, corpus, regsMaxCallsPerExecute: 30, regsSubjectQuota: new SubjectQuota(1_000_000, 3_600_000) }, {
      host: '127.0.0.1', port: 0,
      rps: 1000, burst: 1000, subjectDailyQuota: 1_000_000,
      insecure: false,
      auth: { provider: 'none' }, // verifier is noop but we still require a bearer header
      publicOrigin: 'http://127.0.0.1',
    });
    secBase = `http://127.0.0.1:${secured.port}`;
  });

  afterAll(async () => { await secured.close(); });

  it('rejects unauthenticated MCP requests with 401 and resource metadata header', async () => {
    const r = await fetch(`${secBase}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: meta() } }),
    });
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate') ?? '').toMatch(/resource_metadata=/);
  });

  // Every request re-authenticates: auth is checked before the request reaches the MCP
  // handler, and the subject the tool catalog is built with comes from that verification.
  // There is no session id, so the 2025-era attack this replaces — tenant B reusing tenant
  // A's session id to spend or pollute A's quota — has no carrier to travel on.
  it('requires a bearer token on every request, not just the first', async () => {
    const authed = await rpc('tools/list', {}, {
      target: secBase,
      headers: { authorization: 'Bearer test-token' },
    });
    expect(authed.status).toBe(200);
    expect(authed.sessionId).toBeUndefined();

    // A follow-up without credentials is rejected on its own merits.
    const second = await rpc('tools/list', { }, { target: secBase });
    expect(second.status).toBe(401);
  });
});
