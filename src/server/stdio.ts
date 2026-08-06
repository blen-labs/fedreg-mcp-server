import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { buildMcpServer } from './mcpServer.js';
import type { CatalogDeps } from './toolCatalog.js';
import { log } from '../util/logger.js';

export async function startStdio(deps: CatalogDeps): Promise<void> {
  // stdio is unauthenticated and single-tenant, so there is no subject to scope quotas by.
  //
  // `serveStdio` reports every out-of-band failure (transport start, a throwing factory,
  // message-pump errors) through `onerror` and swallows it otherwise. Without this the
  // process would log `stdio.ready` and then answer every request with -32603 in silence;
  // the v1 `await server.connect(transport)` at least rejected into `bin.fatal`.
  serveStdio(() => buildMcpServer(deps), {
    onerror: (err) => log.error('stdio.error', { name: err.name, message: err.message }),
  });
  log.info('stdio.ready', { sandbox: deps.sandbox.kind });
}
