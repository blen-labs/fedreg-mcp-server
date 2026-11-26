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
 * Converted tool input and output schemas, cached for the process lifetime.
 *
 * `fromJsonSchema` compiles an Ajv validator, and the SDK's default validator is a module
 * singleton that caches every compiled schema in a plain `Map` keyed by schema *identity*,
 * with no eviction. Since `buildMcpServer` runs per request and `buildCatalog` mints fresh
 * schema literals each time, converting inline would retain ~4 KB per call forever —
 * roughly 12 KB per HTTP request, unbounded. The three tool inputs derive only from
 * module-level Zod constants and the output schemas are module-level literals, so each is
 * converted exactly once here.
 */
const schemaCache = new Map<string, ReturnType<typeof fromJsonSchema>>();

function cachedSchema(key: string, jsonSchema: unknown): ReturnType<typeof fromJsonSchema> {
  let converted = schemaCache.get(key);
  if (!converted) {
    converted = fromJsonSchema(jsonSchema as JsonSchemaType);
    schemaCache.set(key, converted);
  }
  return converted;
}

/**
 * Most array elements plus object members one `tools/call` `arguments` payload may contain (SDK
 * guard against validation-cost DoS, GHSA-46jr-4wx8-v453). The tools take flat scalar arguments:
 * the largest legitimate call is `execute` with all three of `code`, `timeoutMs` and `memoryMb`
 * (3 members), so 16 leaves room for new optional fields without admitting a crowded payload.
 */
export const MAX_TOOL_INPUT_ELEMENTS = 16;

export function buildMcpServer(deps: CatalogDeps, requestCtx?: RequestCtx): McpServer {
  const server = new McpServer(
    { name: 'fedreg-mcp-server', version: '4.1.1' }, // x-release-version
    {
      capabilities: { tools: {} },
      maxToolInputElements: MAX_TOOL_INPUT_ELEMENTS,
      cacheHints: { 'tools/list': LIST_CACHE_HINT, 'server/discover': LIST_CACHE_HINT },
    },
  );

  for (const tool of buildCatalog(deps, requestCtx)) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        annotations: tool.annotations,
        // The catalog emits JSON Schema; `fromJsonSchema` attaches the SDK's default Ajv
        // validator, so arguments are checked here BEFORE the handler re-parses with Zod.
        // Note `zodToJsonSchema` emits `additionalProperties: false`, so unknown argument
        // keys are now rejected rather than silently stripped by Zod (see CHANGELOG).
        inputSchema: cachedSchema(`in:${tool.name}`, tool.inputSchema),
        outputSchema: cachedSchema(`out:${tool.name}`, tool.outputSchema),
      },
      async (args: unknown, ctx: { mcpReq?: { signal?: AbortSignal } }) => {
        try {
          const result = await tool.handler(args ?? {}, { signal: ctx?.mcpReq?.signal });
          // Compact JSON for the model, the same object as structuredContent for clients, and
          // isError for a failed execution (MCP tool-error convention) with the full envelope.
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result) }],
            structuredContent: result as Record<string, unknown>,
            ...(tool.isFailure?.(result) ? { isError: true } : {}),
          };
        } catch (err) {
          const e = err as Error;
          log.warn('tool.error', { tool: tool.name, name: e.name, error: e.message });
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
