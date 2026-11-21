import type { Page, Route } from '@playwright/test';

/** What the mocked server answers. Each test picks a state. */
export interface PortalState {
  signedIn?: boolean;
  /** Whether the person has saved a regulations.gov key. */
  keyConnected?: boolean;
  /** Answer for saving a key: an error message, or success. */
  saveKeyError?: string;
  /** A failure that is not about the key (an expired connection request, a failed removal). */
  requestError?: string;
  localConnection?: boolean;
}

export const EMAIL = 'ada@example.test';
export const ORIGIN = 'https://fedreg.example.test';
/** A signed Better Auth connection query, as the OAuth flow hands to /connect and /consent. */
export const OAUTH_QUERY = 'client_id=c1&redirect_uri=https%3A%2F%2Fclaude.ai%2Fcb&sig=abc&ba_param=client_id&ba_param=redirect_uri';

const json = (route: Route, status: number, body: unknown) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

/** Mocks the auth and portal APIs the pages call, from `state`. */
export async function mockServer(page: Page, state: PortalState = {}) {
  const signedIn = state.signedIn ?? false;
  const connected = state.keyConnected ?? true;
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const path = url.pathname;
    if (path === '/api/auth/get-session') return json(route, 200, signedIn ? { user: { email: EMAIL }, session: {} } : null);
    if (path === '/api/portal/config')
      return json(route, 200, { google: true, email: false, mcpUrl: `${ORIGIN}/mcp/account`, publicMcpUrl: `${ORIGIN}/mcp` });
    if (!signedIn) return json(route, 401, { error: 'Sign in first.' });
    if (path === '/api/portal/account')
      return json(route, 200, { email: EMAIL, personal: { connected } });
    if (path === '/api/portal/connect' && method === 'GET')
      return json(route, 200, {
        client: 'Claude', destination: 'claude.ai', local: false, email: EMAIL,
        personal: { connected },
      });
    if (path === '/api/portal/consent' && method === 'GET')
      return json(route, 200, {
        client: 'Claude', destination: 'claude.ai', local: state.localConnection ?? false, email: EMAIL,
        key: { personal: connected },
      });
    if (path === '/api/portal/connect' && method === 'POST')
      return state.requestError
        ? json(route, 400, { error: state.requestError })
        : state.saveKeyError
          ? json(route, 400, { error: state.saveKeyError, field: 'apiKey' })
          : json(route, 200, { url: `/consent?${OAUTH_QUERY}` });
    if (path === '/api/portal/keys' && method === 'POST')
      return state.saveKeyError ? json(route, 400, { error: state.saveKeyError, field: 'apiKey' }) : json(route, 200, {});
    if (path === '/api/portal/keys/delete' && method === 'POST')
      return state.requestError ? json(route, 500, { error: state.requestError }) : json(route, 200, {});
    return json(route, 404, { error: 'Not mocked.' });
  });
}
