import { readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

// The whole signed-in journey against the real server (web/e2e/journey-server.ts): save a key,
// connect an assistant through the OAuth connect and consent pages, run a program with the
// issued token, and sign out. Runs when TEST_DATABASE_URL is set (CI's accessibility job).
const ORIGIN = 'http://127.0.0.1:4175';
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const CALLBACK = 'https://assistant.example.test/callback';

test.skip(!process.env.TEST_DATABASE_URL || !process.env.JOURNEY_STATE, 'needs TEST_DATABASE_URL (PostgreSQL)');

test('save a key, connect an assistant, run a program, sign out', async ({ page, context }) => {
  const state = JSON.parse(readFileSync(process.env.JOURNEY_STATE!, 'utf8')) as {
    cookies: { name: string; value: string }[];
  };
  await context.addCookies(state.cookies.map((c) => ({ ...c, url: ORIGIN })));
  const axe = async () => {
    const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
    expect(violations.map((v) => `${v.id} on ${page.url()}`)).toEqual([]);
  };

  // 1. The account page: save a regulations.gov key.
  await page.goto(`${ORIGIN}/account`);
  await expect(page.getByRole('heading', { level: 1, name: 'Your account' })).toBeVisible();
  await axe();
  await page.getByLabel('regulations.gov API key').fill('k'.repeat(40));
  await page.getByRole('button', { name: 'Check and save' }).first().click();
  await expect(page.getByRole('status').filter({ hasText: 'Key saved' })).toBeVisible();
  await expect(page.getByText('Key saved', { exact: true })).toBeVisible();

  // 2. An assistant registers and sends the person to authorize, as a desktop client would.
  const registration = await (await fetch(`${ORIGIN}/api/auth/oauth2/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Journey assistant', redirect_uris: [CALLBACK], token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
    }),
  })).json() as { client_id: string };
  const verifier = randomBytes(32).toString('base64url');
  const authorize = new URL(`${ORIGIN}/api/auth/oauth2/authorize`);
  for (const [k, v] of Object.entries({
    client_id: registration.client_id, redirect_uri: CALLBACK, response_type: 'code',
    scope: 'fedreg:read offline_access', resource: `${ORIGIN}/mcp/account`, state: 'journey',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
  })) authorize.searchParams.set(k, v);
  // The assistant's callback is not a real site: capture where the browser is sent.
  let callback: URL | undefined;
  await page.route(`${CALLBACK}**`, async (route) => {
    callback = new URL(route.request().url());
    await route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Done</title><h1>Done</h1>' });
  });
  await page.goto(authorize.href);

  // The connect page: the key is already saved, so continue.
  await expect(page.getByRole('heading', { level: 1, name: 'Connect Journey assistant' })).toBeVisible();
  await axe();
  await page.getByRole('button', { name: 'Continue' }).click();

  // The consent page: allow.
  await expect(page.getByRole('heading', { level: 1, name: 'Authorize Journey assistant' })).toBeVisible();
  await axe();
  await page.getByRole('button', { name: 'Allow' }).click();
  await expect.poll(() => callback?.searchParams.get('code')).toBeTruthy();
  expect(callback!.searchParams.get('state')).toBe('journey');

  // 3. The assistant exchanges the code and runs a program with the person's regulations.gov key.
  const tokens = await (await fetch(`${ORIGIN}/api/auth/oauth2/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'authorization_code', client_id: registration.client_id, code: callback!.searchParams.get('code')!,
      code_verifier: verifier, redirect_uri: CALLBACK,
    }),
  })).json() as { access_token: string };
  const client = new Client({ name: 'journey', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp/account`), {
    requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } },
  }));
  const result = await client.callTool({
    name: 'execute',
    arguments: { code: 'const r = await regs.dockets.get("EPA-HQ-OAR-2021-0208"); return r.data.attributes.title;' },
  });
  expect(result.structuredContent).toMatchObject({ ok: true, value: 'Journey docket' });
  await client.close();

  // 4. Sign out from the account page; the header then offers sign-in again.
  await page.goto(`${ORIGIN}/account`);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(`${ORIGIN}/`);
  await expect(page.getByRole('navigation', { name: 'Site' }).getByRole('link', { name: 'Sign in' })).toBeVisible();
  await axe();
});
