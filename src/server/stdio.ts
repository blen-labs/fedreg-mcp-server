import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildMcpServer } from './mcpServer.js';
import type { CatalogDeps } from './toolCatalog.js';
import { log } from '../util/logger.js';

export async function startStdio(deps: CatalogDeps): Promise<void> {
  const server = buildMcpServer(deps);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info('stdio.ready', { sandbox: deps.sandbox.kind });
}
