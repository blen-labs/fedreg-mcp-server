import express, { type Express, type Request, type Response } from 'express';
import { fromNodeHeaders } from 'better-auth/node';
import { verifyOAuthQueryParams } from '@better-auth/oauth-provider';
import type { AccountConfig } from './config.js';
import { personalOwner, type Store } from './store.js';
import type { Auth } from './provider.js';

/** Keys go only to this fixed upstream; no URL, owner or user ID comes from the form. */
export async function checkKey(key: unknown, fetcher: typeof fetch = fetch): Promise<string | undefined> {
  if (typeof key !== 'string' || !/^[a-zA-Z0-9]{40}$/.test(key)) return 'Enter your 40-character regulations.gov API key.';
  try {
    const result = await fetcher('https://api.regulations.gov/v4/documents?page[size]=1', {
      headers: { 'X-Api-Key': key, Accept: 'application/vnd.api+json' },
      redirect: 'error', signal: AbortSignal.timeout(10_000),
    });
    // Key validation needs status only. Never log, echo, or persist the upstream body.
    await result.body?.cancel();
    if (!result.ok) return 'The regulations.gov connection check failed. Your existing key was preserved.';
  } catch {
    return 'The regulations.gov connection check failed. Your existing key was preserved.';
  }
}

export function installPortal(
  app: Express, config: AccountConfig, store: Store, auth: Auth, fetcher: typeof fetch,
  ipOf: (req: Request) => string | undefined,
) {
  const api = express.Router();
  api.use(express.json({ limit: '8kb' }));
  api.use((req, res, next) => {
    if (req.method !== 'GET' && (req.headers.origin !== config.origin || !req.is('application/json'))) {
      return res.status(403).json({ error: 'Invalid request origin.' });
    }
    next();
  });
  async function verified(req: Request) {
    const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
    return session?.user.emailVerified ? session : undefined;
  }
  async function validQuery(value: unknown) {
    return typeof value === 'string' && value.length < 16384 &&
      await verifyOAuthQueryParams(value, config.authSecret) ? value : undefined;
  }
  const error = (res: Response, status: number, message: string) => res.status(status).json({ error: message });
  async function account(user: { id: string; email: string }) {
    const key = await store.keyStatus(personalOwner(user.id));
    return { email: user.email, personal: { connected: key.connected }, key, mcpUrl: `${config.origin}/mcp` };
  }
  async function connection(query: string) {
    const params = new URLSearchParams(query);
    const client = await (await auth.$context).adapter.findOne<{ name?: string }>({
      model: 'oauthClient', where: [{ field: 'clientId', value: params.get('client_id')! }],
    });
    const redirect = new URL(params.get('redirect_uri')!);
    return { client: client?.name || 'This application', destination: redirect.host,
      local: ['localhost', '127.0.0.1', '[::1]'].includes(redirect.hostname) };
  }
  async function continueWith(req: Request, res: Response, path: string, body: object) {
    const headers = fromNodeHeaders(req.headers);
    headers.delete('content-length');
    headers.set('content-type', 'application/json');
    headers.set('accept', 'application/json');
    // Forward only the client address trusted by Express, not a caller's spoofed chain.
    const ip = ipOf(req);
    if (ip) headers.set('x-forwarded-for', ip);
    else headers.delete('x-forwarded-for');
    const response = await auth.handler(new globalThis.Request(`${config.origin}/api/auth${path}`, {
      method: 'POST', headers, body: JSON.stringify(body),
    }));
    const cookies = response.headers.getSetCookie();
    if (cookies.length) res.setHeader('Set-Cookie', cookies);
    const result = await response.json().catch(() => ({})) as { url?: unknown; redirect_uri?: unknown };
    const url = response.status >= 300 && response.status < 400 ? response.headers.get('location') : result.url ?? result.redirect_uri;
    if (typeof url !== 'string' || response.status >= 400) return error(res, 400, 'Connection authorization failed.');
    res.json({ url: new URL(url, config.origin).toString() });
  }
  api.get('/config', (_req, res) => res.json({ google: true, email: false, mcpUrl: `${config.origin}/mcp` }));
  api.get('/connect', async (req, res) => {
    const logged = await verified(req);
    if (!logged) return error(res, 401, 'Sign in to continue.');
    const query = await validQuery(req.query.oauth_query);
    if (!query) return error(res, 400, 'This connection request expired. Start again from your AI assistant.');
    res.json({ ...await connection(query), ...await account(logged.user) });
  });
  api.post('/connect', async (req, res) => {
    const logged = await verified(req);
    if (!logged) return error(res, 401, 'Sign in to continue.');
    const query = await validQuery(req.body?.oauth_query);
    if (!query || !['continue', 'deny'].includes(req.body?.decision) ||
        Object.keys(req.body ?? {}).some(key => !['oauth_query', 'decision', 'apiKey'].includes(key))) {
      return error(res, 400, 'Connection authorization failed.');
    }
    if (req.body.decision === 'deny') {
      await store.clearConnectionStep(logged.session.id);
      return continueWith(req, res, '/oauth2/consent', { oauth_query: query, accept: false });
    }
    if (req.body.apiKey) {
      const owner = personalOwner(logged.user.id);
      if (!await store.allow(`key:${owner}`, 5, 60)) return error(res, 429, 'Too many key checks. Try again in one minute.');
      const problem = await checkKey(req.body.apiKey, fetcher);
      if (problem) return error(res, 400, problem);
      await store.saveKey(owner, req.body.apiKey, logged.user.id);
    }
    await store.markConnectionReady(logged.session.id, logged.user.id);
    try {
      return await continueWith(req, res, '/oauth2/continue', { oauth_query: query, postLogin: true });
    } finally {
      // Better Auth signs the completed step into the consent query. New flows
      // must visit Connect again; keep no reusable browser-wide selection.
      await store.clearConnectionStep(logged.session.id);
    }
  });
  api.get('/account', async (req, res) => {
    const logged = await verified(req);
    if (!logged) return error(res, 401, 'Sign in to continue.');
    res.json(await account(logged.user));
  });
  api.post('/keys', async (req, res) => {
    const logged = await verified(req);
    if (!logged) return error(res, 401, 'Sign in to continue.');
    if (Object.keys(req.body ?? {}).some(key => key !== 'apiKey')) return error(res, 400, 'Only apiKey is accepted.');
    const owner = personalOwner(logged.user.id);
    if (!await store.allow(`key:${owner}`, 5, 60)) return error(res, 429, 'Too many key checks. Try again in one minute.');
    const problem = await checkKey(req.body?.apiKey, fetcher);
    if (problem) return error(res, 400, problem);
    await store.saveKey(owner, req.body.apiKey, logged.user.id);
    res.json({ saved: true });
  });
  api.post('/keys/delete', async (req, res) => {
    const logged = await verified(req);
    if (!logged) return error(res, 401, 'Sign in to continue.');
    if (Object.keys(req.body ?? {}).length) return error(res, 400, 'No parameters are accepted.');
    await store.deleteKey(personalOwner(logged.user.id), logged.user.id);
    res.json({ deleted: true });
  });
  api.get('/consent', async (req, res) => {
    const logged = await verified(req);
    if (!logged) return error(res, 401, 'Sign in to continue.');
    const query = await validQuery(req.query.oauth_query);
    if (!query) return error(res, 400, 'This connection request expired. Start again from your AI assistant.');
    const key = await store.keyStatus(personalOwner(logged.user.id));
    res.json({ ...await connection(query), email: logged.user.email, key: { personal: key.connected } });
  });
  api.post('/consent', async (req, res) => {
    const logged = await verified(req);
    if (!logged) return error(res, 401, 'Sign in to continue.');
    const query = await validQuery(req.body?.oauth_query);
    if (!query || typeof req.body?.accept !== 'boolean') return error(res, 400, 'Connection authorization failed.');
    return continueWith(req, res, '/oauth2/consent', { oauth_query: query, accept: req.body.accept });
  });
  app.use('/api/portal', api);
}
