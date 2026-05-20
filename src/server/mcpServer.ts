import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { buildCatalog, type CatalogDeps } from './toolCatalog.js';
import { log } from '../util/logger.js';

export function buildMcpServer(deps: CatalogDeps): Server {
  const server = new Server(
    { name: 'fedreg-mcp-server', version: '0.1.0-alpha.0' },
    { capabilities: { tools: {} } },
  );

  const catalog = buildCatalog(deps);
  const byName = new Map(catalog.map(t => [t.name, t]));

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: catalog.map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = byName.get(req.params.name);
    if (!tool) {
      return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${req.params.name}` }] };
    }
    try {
      const result = await tool.handler(req.params.arguments ?? {});
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      const e = err as Error;
      log.warn('tool.error', { tool: req.params.name, name: e.name, message: e.message });
      return {
        isError: true,
        content: [{ type: 'text', text: `${e.name}: ${e.message}` }],
      };
    }
  });

  return server;
}
