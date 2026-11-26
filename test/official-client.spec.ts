import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MockAgent } from 'undici';
import {
  Client,
  StreamableHTTPClientTransport,
  type VersionNegotiationOptions,
} from '@modelcontextprotocol/client';
import { startHttp, type HttpHandle } from '../src/server/http.js';
import { MCP_PROTOCOL_VERSION, MAX_TOOL_INPUT_ELEMENTS } from '../src/server/mcpServer.js';
import { buildSdk } from '../src/sdk/bindings.js';
import { getSources } from '../src/sdk/sources/index.js';
import { buildCorpus } from '../src/search/corpus.js';
import { pickSandbox } from '../src/sandbox/index.js';
import type { SandboxRunner } from '../src/sandbox/types.js';
import type { CatalogDeps } from '../src/server/toolCatalog.js';
import { SubjectQuota } from '../src/util/quotas.js';
import { expectToolMetadata } from './tool-metadata.js';

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
let sandbox: SandboxRunner;

beforeAll(async () => {
  sandbox = await pickSandbox('auto');
  const deps: CatalogDeps = {
    sdk: buildSdk(SOURCE_URLS),
    sandbox,
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
      expectToolMetadata(listed.tools);
      expect(listed.tools.map(t => t.name).sort())
        .toEqual(['describe_schema', 'execute', 'search_api']);
      // Cache metadata the 2026-07-28 revision requires on list results.
      expect(listed.ttlMs).toBe(300_000);
      expect(listed.cacheScope).toBe('public');

      const called = await client.callTool({
        name: 'search_api',
        arguments: { query: 'federal register documents search', k: 2 },
      });
      // The client validates structuredContent against the advertised outputSchema before
      // returning, so a result that does not conform makes callTool throw.
      expect(called.isError).toBeFalsy();
      const text = (called.content as Array<{ text?: string }>)[0]?.text ?? '';
      const structured = called.structuredContent as { hits: unknown[] };
      expect(structured.hits.length).toBeGreaterThan(0);
      expect(JSON.parse(text)).toEqual(structured);
      expect(text).not.toContain('\n  '); // compact JSON

      const described = await client.callTool({ name: 'describe_schema', arguments: { path: 'fr.documents.search' } });
      expect(described.structuredContent).toMatchObject({ found: true, entries: [{ id: 'fr.documents.search' }] });
      const missing = await client.callTool({ name: 'describe_schema', arguments: { path: 'fr.no.such.thing' } });
      expect(missing.isError).toBeFalsy();
      expect(missing.structuredContent).toMatchObject({ found: false });
    } finally {
      await client.close();
    }
  });

  it('advertises an outputSchema for every tool', async () => {
    const client = await connect({ mode: 'auto' });
    try {
      const { tools } = await client.listTools();
      for (const tool of tools) expect(tool.outputSchema, tool.name).toMatchObject({ type: 'object' });
      expect(tools.find(t => t.name === 'execute')!.outputSchema).toMatchObject({ required: ['ok', 'logs', 'durationMs'] });
      expect(tools.find(t => t.name === 'search_api')!.outputSchema).toMatchObject({ required: ['hits', 'note'] });
      expect(tools.find(t => t.name === 'describe_schema')!.outputSchema).toMatchObject({ required: ['found'] });
    } finally {
      await client.close();
    }
  });

  it('returns a failed execution as isError with the full envelope, even without a sandbox', async () => {
    const client = await connect({ mode: 'auto' });
    try {
      await client.listTools(); // lets the client check structuredContent against the outputSchema
      // eval is rejected by the AST preflight, before any runner is involved.
      const failed = await client.callTool({ name: 'execute', arguments: { code: 'return eval("1")' } });
      expect(failed.isError).toBe(true);
      expect(failed.structuredContent).toMatchObject({ ok: false, logs: [], error: { name: 'PolicyError' } });
      const text = (failed.content as Array<{ text?: string }>)[0]?.text ?? '';
      expect(JSON.parse(text)).toEqual(failed.structuredContent);
    } finally {
      await client.close();
    }
  });

  it('returns structuredContent for a successful execute and for a thrown error', async ({ skip }) => {
    if (!(await sandbox.available())) return skip();
    const client = await connect({ mode: 'auto' });
    try {
      await client.listTools();
      const ok = await client.callTool({ name: 'execute', arguments: { code: 'return { a: 1 }' } });
      expect(ok.isError).toBeFalsy();
      expect(ok.structuredContent).toMatchObject({ ok: true, value: { a: 1 } });
      const failed = await client.callTool({ name: 'execute', arguments: { code: 'console.log("before"); throw new Error("boom")' } });
      expect(failed.isError).toBe(true);
      expect(failed.structuredContent).toMatchObject({ ok: false, logs: ['before'], error: { name: 'Error', message: 'boom' } });
    } finally {
      await client.close();
    }
  });

  it('works when the client pins the modern revision explicitly', async () => {
    const client = await connect({ mode: { pin: MCP_PROTOCOL_VERSION } });
    try {
      const listed = await client.listTools();
      expectToolMetadata(listed.tools);
      expect(listed.tools).toHaveLength(3);
      // Assert something only the modern leg produces, so a pin that silently degraded to
      // legacy negotiation fails here instead of passing on the tool count alone.
      expect(listed.ttlMs).toBe(300_000);
      expect(listed.cacheScope).toBe('public');
    } finally {
      await client.close();
    }
  });

  it('caps tool input elements, yet the largest legitimate calls pass', async () => {
    const client = await connect({ mode: 'auto' });
    try {
      await client.listTools();
      // The largest legitimate shapes: execute with every field, search_api with both.
      const execute = await client.callTool({ name: 'execute', arguments: { code: 'return eval("1")', timeoutMs: 15_000, memoryMb: 64 } });
      expect(execute.structuredContent).toMatchObject({ error: { name: 'PolicyError' } }); // reached the handler
      const search = await client.callTool({ name: 'search_api', arguments: { query: 'documents', k: 50 } });
      expect(search.isError).toBeFalsy();
      // A crowded argument object is refused before schema validation, whatever the tool.
      const crowded = Object.fromEntries(Array.from({ length: MAX_TOOL_INPUT_ELEMENTS + 1 }, (_, i) => [`k${i}`, i]));
      const refused = await client.callTool({ name: 'search_api', arguments: crowded });
      expect(refused.isError).toBe(true);
      expect(JSON.stringify(refused.content)).toMatch(/maximum of 16 elements/);
      const nested = { query: 'x', k: 1, pad: Array.from({ length: 400 }, () => 0) };
      const refusedNested = await client.callTool({ name: 'search_api', arguments: nested });
      expect(refusedNested.isError).toBe(true);
      expect(JSON.stringify(refusedNested.content)).toMatch(/maximum of 16 elements/);
    } finally {
      await client.close();
    }
  });
});
