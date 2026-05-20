import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { buildMcpServer } from './mcpServer.js';
import type { CatalogDeps } from './toolCatalog.js';
import { IpRateLimiter } from './ipRateLimiter.js';
import { SubjectQuota } from '../util/quotas.js';
import { buildVerifier, type AuthConfig } from './authz.js';
import { oauthProtectedResource } from './wellKnown.js';
import { log } from '../util/logger.js';

export interface HttpOptions {
  port: number;
  host: string;
  rps: number;
  burst: number;
  maxSessions: number;
  subjectDailyQuota: number;
  auth: AuthConfig;
  insecure?: boolean;
  /** Allowed Host header values for DNS rebinding protection. Pass [] to disable. */
  allowedHosts?: string[];
  /** Public origin clients should use (for protected-resource metadata). */
  publicOrigin?: string;
}

export interface HttpHandle {
  close: () => Promise<void>;
  port: number;
}

const MCP_PATH = '/mcp';
const RESOURCE_METADATA_PATH = '/.well-known/oauth-protected-resource/mcp';

export async function startHttp(deps: CatalogDeps, opts: HttpOptions): Promise<HttpHandle> {
  const verifier = buildVerifier(opts.auth);
  const limiter = new IpRateLimiter(opts.rps, opts.burst);
  const quota = new SubjectQuota(opts.subjectDailyQuota);

  // One transport per MCP session (initialize -> sessionId).
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const ip = (req.socket.remoteAddress ?? 'unknown').replace('::ffff:', '');
      if (!limiter.allow(ip)) return reply(res, 429, { error: 'rate_limited' });

      // DNS rebinding protection: validate Host header against allowlist when provided.
      if (opts.allowedHosts && opts.allowedHosts.length > 0) {
        const host = String(req.headers.host ?? '').toLowerCase();
        if (!opts.allowedHosts.includes(host)) {
          return reply(res, 421, { error: 'host_not_allowed', host });
        }
      }

      const origin = opts.publicOrigin ?? `http://${req.headers.host ?? `${opts.host}:${opts.port}`}`;
      const url = new URL(req.url ?? '/', origin);

      if (url.pathname === RESOURCE_METADATA_PATH && req.method === 'GET') {
        return reply(res, 200, oauthProtectedResource(opts.auth, `${origin}${MCP_PATH}`));
      }

      if (url.pathname === '/health' && req.method === 'GET') {
        return reply(res, 200, { ok: true, sandbox: deps.sandbox.kind, sessions: transports.size });
      }

      if (url.pathname === MCP_PATH) {
        // Auth (unless --insecure)
        let subject = 'anonymous';
        if (!opts.insecure) {
          const auth = req.headers.authorization;
          if (!auth?.startsWith('Bearer ')) {
            res.writeHead(401, {
              'content-type': 'application/json',
              'www-authenticate': `Bearer resource_metadata="${origin}${RESOURCE_METADATA_PATH}"`,
            });
            return res.end(JSON.stringify({ error: 'unauthorized' }));
          }
          try {
            const ctx = await verifier.verify(auth.slice(7));
            subject = ctx.subject;
          } catch (err) {
            res.writeHead(401, {
              'content-type': 'application/json',
              'www-authenticate': `Bearer resource_metadata="${origin}${RESOURCE_METADATA_PATH}", error="invalid_token"`,
            });
            return res.end(JSON.stringify({ error: 'invalid_token', detail: (err as Error).message }));
          }
          const q = quota.consume(subject);
          if (!q.allowed) {
            return reply(res, 429, { error: 'quota_exceeded', resetAt: new Date(q.resetAt).toISOString() });
          }
        }

        const sessionHeader = req.headers['mcp-session-id'];
        const sessionId = Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader;

        // Parse body for POST so we can inspect for initialize requests; the transport
        // accepts a pre-parsed body via the third argument.
        let parsedBody: unknown;
        if (req.method === 'POST') {
          parsedBody = await readJson(req);
        }

        let transport: StreamableHTTPServerTransport | undefined =
          sessionId ? transports.get(sessionId) : undefined;

        if (!transport) {
          // No session yet: must be an initialize POST.
          if (req.method !== 'POST' || !isInitializeRequest(parsedBody)) {
            return reply(res, 400, {
              error: 'session_required',
              message: 'Open a session by POSTing an initialize request first.',
            });
          }
          if (transports.size >= opts.maxSessions) {
            return reply(res, 503, { error: 'session_limit', limit: opts.maxSessions });
          }
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (id) => {
              transports.set(id, transport!);
              log.info('mcp.session.open', { sessionId: id, subject });
            },
            onsessionclosed: (id) => {
              transports.delete(id);
              log.info('mcp.session.close', { sessionId: id, subject });
            },
          });
          const mcp = buildMcpServer(deps);
          await mcp.connect(transport);
        }

        await transport.handleRequest(req, res, parsedBody);
        return;
      }

      reply(res, 404, { error: 'not_found' });
    } catch (err) {
      log.error('http.unhandled', { message: (err as Error).message, stack: (err as Error).stack });
      if (!res.headersSent) reply(res, 500, { error: 'internal' });
    }
  });

  await new Promise<void>((resolve) => server.listen(opts.port, opts.host, () => resolve()));
  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : opts.port;
  log.info('http.listening', {
    host: opts.host, port: actualPort,
    insecure: opts.insecure ?? false,
    sandbox: deps.sandbox.kind,
    auth: opts.auth.provider,
  });

  return {
    port: actualPort,
    close: async () => {
      await new Promise<void>(r => server.close(() => r()));
      for (const t of transports.values()) await t.close();
      transports.clear();
    },
  };
}

function reply(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return undefined;
  const text = Buffer.concat(chunks).toString('utf8');
  try { return JSON.parse(text); } catch { return undefined; }
}
