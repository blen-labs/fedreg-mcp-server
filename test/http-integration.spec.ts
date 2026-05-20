import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MockAgent } from 'undici';
import { startHttp, type HttpHandle } from '../src/server/http.js';
import { buildSdk } from '../src/sdk/bindings.js';
import { pickSandbox } from '../src/sandbox/index.js';
import type { CatalogDeps } from '../src/server/toolCatalog.js';

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
    userAgent: 'test/0.0',
    timeoutMs: 5000,
    retries: 0,
    cacheTtlMs: 0,
    cacheMaxItems: 0,
    dispatcher: mockAgent,
  });
  const sandbox = await pickSandbox('auto');
  const deps: CatalogDeps = { sdk, sandbox };
  handle = await startHttp(deps, {
    host: '127.0.0.1',
    port: 0,
    rps: 1000,
    burst: 1000,
    maxSessions: 100,
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

async function rpc(body: unknown, headers: Record<string, string> = {}, sessionId?: string) {
  const r = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'accept': 'application/json, text/event-stream',
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
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

describe('Streamable HTTP transport', () => {
  it('serves OAuth 2.0 Protected Resource Metadata', async () => {
    const r = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`);
    expect(r.status).toBe(200);
    const meta = await r.json() as Record<string, unknown>;
    expect(meta.resource).toBe('http://127.0.0.1/mcp');
    expect(Array.isArray(meta.bearer_methods_supported)).toBe(true);
  });

  it('serves /health', async () => {
    const r = await fetch(`${base}/health`);
    expect(r.status).toBe(200);
    const j = await r.json() as { ok: boolean };
    expect(j.ok).toBe(true);
  });

  it('rejects POST /mcp without initialize when no session', async () => {
    const r = await rpc({
      jsonrpc: '2.0', id: 1, method: 'tools/list',
    });
    expect(r.status).toBe(400);
  });

  it('initializes a session and lists tools via session id', async () => {
    const init = await rpc({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'it', version: '0' } },
    });
    expect(init.status).toBe(200);
    expect(init.sessionId).toBeDefined();
    const initBody = init.body as { result?: { protocolVersion?: string } };
    expect(initBody?.result?.protocolVersion).toBeDefined();

    // initialized notification
    await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, {}, init.sessionId);

    // tools/list against the same session
    const list = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, {}, init.sessionId);
    expect(list.status).toBe(200);
    const listBody = list.body as { result?: { tools?: Array<{ name: string }> } };
    const names = (listBody?.result?.tools ?? []).map(t => t.name).sort();
    expect(names).toEqual(['describe_schema', 'execute', 'search_api']);

    // search_api call returns hits
    const search = await rpc({
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'search_api', arguments: { query: 'electronic code of federal regulations search', k: 3 } },
    }, {}, init.sessionId);
    expect(search.status).toBe(200);
    const sb = search.body as { result?: { content?: Array<{ type: string; text: string }> } };
    const text = sb?.result?.content?.[0]?.text ?? '';
    const parsed = JSON.parse(text) as { hits: Array<{ id: string }> };
    expect(parsed.hits.length).toBeGreaterThan(0);
    expect(parsed.hits.some(h => h.id.startsWith('ecfr.'))).toBe(true);

    // execute tool returns either a value or a clear SandboxUnavailable error,
    // depending on whether isolated-vm/deno is installed locally.
    const exec = await rpc({
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'execute', arguments: { code: 'return 1 + 2', timeoutMs: 3000 } },
    }, {}, init.sessionId);
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
    const init = await rpc({
      jsonrpc: '2.0', id: 10, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'it', version: '0' } },
    });
    expect(init.sessionId).toBeDefined();
    await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, {}, init.sessionId);

    const exec = await rpc({
      jsonrpc: '2.0', id: 11, method: 'tools/call',
      params: {
        name: 'execute',
        arguments: {
          code: 'const r = await fr.agencies.list(); return { count: Array.isArray(r) ? r.length : 0, first: Array.isArray(r) ? r[0] : null };',
          timeoutMs: 5000,
        },
      },
    }, {}, init.sessionId);

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

describe('Auth enforcement', () => {
  let secured: HttpHandle;
  let secBase: string;

  beforeAll(async () => {
    const sdk = buildSdk({
      frBaseUrl: 'https://www.federalregister.gov/api/v1',
      ecfrBaseUrl: 'https://www.ecfr.gov/api',
      userAgent: 'test/0.0', timeoutMs: 5000, retries: 0, cacheTtlMs: 0, cacheMaxItems: 0,
    });
    const sandbox = await pickSandbox('auto');
    secured = await startHttp({ sdk, sandbox }, {
      host: '127.0.0.1', port: 0,
      rps: 1000, burst: 1000, maxSessions: 100, subjectDailyQuota: 1_000_000,
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
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    });
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate') ?? '').toMatch(/resource_metadata=/);
  });
});
