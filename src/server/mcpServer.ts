import { McpServer, fromJsonSchema, type JsonSchemaType } from '@modelcontextprotocol/server';
import { buildCatalog, type CatalogDeps } from './toolCatalog.js';
import type { RequestCtx } from '../tools/execute.js';
import { log } from '../util/logger.js';

/**
 * The MCP revision this server speaks.
 *
 * Declared here rather than imported: the SDK's exported `LATEST_PROTOCOL_VERSION` and
 * `SUPPORTED_PROTOCOL_VERSIONS` describe only the legacy `initialize` era (`2025-11-25`
 * and older) kept for the backward-compatibility leg. The SDK does hold the modern value
 * as `FIRST_MODERN_PROTOCOL_VERSION`, but that lives in its `core-internal` package — not
 * exported at runtime and absent from every published `.d.mts` — so it is not importable.
 */
export const MCP_PROTOCOL_VERSION = '2026-07-28';

// The catalog is derived from process configuration (which sources are bound), not from
// the caller, so every tenant sees byte-identical results and a shared cache is safe.
const LIST_CACHE_HINT = { ttlMs: 300_000, cacheScope: 'public' as const };

/**
 * Converted tool input schemas, cached for the process lifetime.
 *
 * `fromJsonSchema` compiles an Ajv validator, and the SDK's default validator is a module
 * singleton that caches every compiled schema in a plain `Map` keyed by schema *identity*,
 * with no eviction. Since `buildMcpServer` runs per request and `buildCatalog` mints fresh
 * schema literals each time, converting inline would retain ~4 KB per call forever —
 * roughly 12 KB per HTTP request, unbounded. The three tool inputs derive only from
 * module-level Zod constants, so each is converted exactly once here.
 */
const inputSchemaCache = new Map<string, ReturnType<typeof fromJsonSchema>>();

function cachedInputSchema(name: string, jsonSchema: unknown): ReturnType<typeof fromJsonSchema> {
  let converted = inputSchemaCache.get(name);
  if (!converted) {
    converted = fromJsonSchema(jsonSchema as JsonSchemaType);
    inputSchemaCache.set(name, converted);
  }
  return converted;
}

export function buildMcpServer(deps: CatalogDeps, requestCtx?: RequestCtx): McpServer {
  const server = new McpServer(
    { name: 'fedreg-mcp-server', version: '2.0.0' }, // x-release-please-version
    {
      capabilities: { tools: {} },
      cacheHints: { 'tools/list': LIST_CACHE_HINT, 'server/discover': LIST_CACHE_HINT },
    },
  );

  for (const tool of buildCatalog(deps, requestCtx)) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        // The catalog emits JSON Schema; `fromJsonSchema` attaches the SDK's default Ajv
        // validator, so arguments are checked here BEFORE the handler re-parses with Zod.
        // Note `zodToJsonSchema` emits `additionalProperties: false`, so unknown argument
        // keys are now rejected rather than silently stripped by Zod (see CHANGELOG).
        inputSchema: cachedInputSchema(tool.name, tool.inputSchema),
      },
      async (args: unknown) => {
        try {
          const result = await tool.handler(args ?? {});
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        } catch (err) {
          const e = err as Error;
          log.warn('tool.error', { tool: tool.name, name: e.name, message: e.message });
          return {
            isError: true,
            content: [{ type: 'text' as const, text: `${e.name}: ${e.message}` }],
          };
        }
      },
    );
  }

  return server;
}
