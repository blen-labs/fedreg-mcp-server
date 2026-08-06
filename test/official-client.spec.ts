import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MockAgent } from 'undici';
import {
  Client,
  StreamableHTTPClientTransport,
  type VersionNegotiationOptions,
} from '@modelcontextprotocol/client';
import { startHttp, type HttpHandle } from '../src/server/http.js';
import { MCP_PROTOCOL_VERSION } from '../src/server/mcpServer.js';
import { buildSdk } from '../src/sdk/bindings.js';
import { getSources } from '../src/sdk/sources/index.js';
import { buildCorpus } from '../src/search/corpus.js';
import { pickSandbox } from '../src/sandbox/index.js';
import type { CatalogDeps } from '../src/server/toolCatalog.js';
import { SubjectQuota } from '../src/util/quotas.js';

/**
 * Drives the server with the OFFICIAL MCP client SDK rather than hand-built requests.
 * The client constructs the `_meta` envelope and the Mcp-Method/Mcp-Name routing headers
 * itself, so this catches protocol mistakes that a hand-rolled request would encode
 * identically on both sides and therefore never surface.
 */

// No upstream call is expected here (search_api is corpus-local), so the dispatcher is
// wired purely to enforce that: `disableNetConnect` turns any accidental egress a future
// case adds into a MockAgent error instead of a silent real request to a .gov host.
const mockAgent = new MockAgent();
mockAgent.disableNetConnect();

const SOURCE_URLS = {
  frBaseUrl: 'https://www.federalregister.gov/api/v1',
  ecfrBaseUrl: 'https://www.ecfr.gov/api',
  regsBaseUrl: 'https://api.regulations.gov',
  userAgent: 'test/0.0',
  timeoutMs: 5000,
  retries: 0,
  cacheTtlMs: 0,
  cacheMaxItems: 0,
  dispatcher: mockAgent,
};

let handle: HttpHandle;
let url: URL;

beforeAll(async () => {
  const deps: CatalogDeps = {
    sdk: buildSdk(SOURCE_URLS),
    sandbox: await pickSandbox('auto'),
    corpus: buildCorpus(getSources(SOURCE_URLS)),
    regsMaxCallsPerExecute: 30,
    regsSubjectQuota: new SubjectQuota(1_000_000, 3_600_000),
  };
  handle = await startHttp(deps, {
    host: '127.0.0.1', port: 0, rps: 1000, burst: 1000,
    subjectDailyQuota: 1_000_000, insecure: true,
    auth: { provider: 'none' }, publicOrigin: 'http://127.0.0.1',
  });
  url = new URL(`http://127.0.0.1:${handle.port}/mcp`);
});

afterAll(async () => { await handle.close(); });

// Typed, NOT `as never`: `versionNegotiation` is a real `ClientOptions` field, and casting
// the options object away meant a malformed mode (e.g. `{ mode: 'pin', pin: '…' }`, which
// is not a `VersionNegotiationMode`) compiled fine and silently fell back to legacy
// negotiation — leaving the "pins the modern revision" test passing without pinning.
async function connect(versionNegotiation: VersionNegotiationOptions) {
  const client = new Client(
    { name: 'fedreg-conformance-probe', version: '1.0.0' },
    { versionNegotiation },
  );
  await client.connect(new StreamableHTTPClientTransport(url));
  return client;
}

describe('official MCP client SDK', () => {
  it('negotiates 2026-07-28 automatically and round-trips a tool call', async () => {
    const client = await connect({ mode: 'auto' });
    try {
      const listed = await client.listTools();
      expect(listed.tools.map(t => t.name).sort())
        .toEqual(['describe_schema', 'execute', 'search_api']);
      // Cache metadata the 2026-07-28 revision requires on list results.
      expect(listed.ttlMs).toBe(300_000);
      expect(listed.cacheScope).toBe('public');

      const called = await client.callTool({
        name: 'search_api',
        arguments: { query: 'federal register documents search', k: 2 },
      });
      const text = (called.content as Array<{ text?: string }>)[0]?.text ?? '';
      expect((JSON.parse(text) as { hits: unknown[] }).hits.length).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  });

  it('works when the client pins the modern revision explicitly', async () => {
    const client = await connect({ mode: { pin: MCP_PROTOCOL_VERSION } });
    try {
      const listed = await client.listTools();
      expect(listed.tools).toHaveLength(3);
      // Assert something only the modern leg produces, so a pin that silently degraded to
      // legacy negotiation fails here instead of passing on the tool count alone.
      expect(listed.ttlMs).toBe(300_000);
      expect(listed.cacheScope).toBe('public');
    } finally {
      await client.close();
    }
  });
});
