import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { OAUTH_QUERY, mockServer, type PortalState } from './fixtures';

// WCAG 2.0, 2.1 and 2.2 A/AA: Section 508 incorporates WCAG 2.0 AA; 2.1 and 2.2 AA are the
// project's target. Automated rules cover part of the criteria; docs/accessibility.md lists the
// manual checks.
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];

/** Every page and state a person can reach. */
const PAGES: { name: string; path: string; state?: PortalState; heading: RegExp }[] = [
  { name: 'home (signed out)', path: '/', heading: /federal rules, regulations and public comments/i },
  { name: 'home (signed in)', path: '/', state: { signedIn: true }, heading: /federal rules, regulations and public comments/i },
  { name: 'sign-in', path: '/sign-in?next=%2Faccount', heading: /your account/i },
  { name: 'sign-in (connection)', path: `/sign-in?${OAUTH_QUERY}`, heading: /sign in to connect/i },
  { name: 'account', path: '/account', state: { signedIn: true }, heading: /your account/i },
  { name: 'account (no key)', path: '/account', state: { signedIn: true, keyConnected: false }, heading: /your account/i },
  { name: 'connect', path: `/connect?${OAUTH_QUERY}`, state: { signedIn: true }, heading: /connect claude/i },
  { name: 'consent', path: `/consent?${OAUTH_QUERY}`, state: { signedIn: true }, heading: /authorize claude/i },
  { name: 'consent (local app warning)', path: `/consent?${OAUTH_QUERY}`, state: { signedIn: true, localConnection: true }, heading: /authorize claude/i },
  { name: 'privacy policy', path: '/privacy-policy', heading: /privacy policy/i },
  { name: 'terms', path: '/terms', heading: /terms of service/i },
  { name: 'error', path: '/error?error=state_mismatch', heading: /something went wrong/i },
  { name: 'not found', path: '/no-such-page', heading: /page not found/i },
];

async function open(page: Page, path: string, state: PortalState | undefined, heading: RegExp) {
  await mockServer(page, state);
  await page.goto(path);
  await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
}

async function expectNoViolations(page: Page) {
  const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  expect(violations.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`)).toEqual([]);
}

for (const scheme of ['light', 'dark'] as const) {
  for (const viewport of [{ width: 1280, height: 800 }, { width: 320, height: 640 }]) {
    test.describe(`${scheme}, ${viewport.width}px`, () => {
      test.use({ colorScheme: scheme, viewport });
      for (const { name, path, state, heading } of PAGES) {
        test(`${name} has no axe violations and reflows without horizontal scrolling`, async ({ page }) => {
          await open(page, path, state, heading);
          await expectNoViolations(page);
          // 1.4.10 Reflow: at 320 CSS px nothing needs horizontal scrolling.
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
          expect(overflow).toBeLessThanOrEqual(0);
        });
      }
    });
  }
}

test.describe('structure', () => {
  for (const { name, path, state, heading } of PAGES) {
    test(`${name}: one h1, landmarks, a page title and a skip link`, async ({ page }) => {
      await open(page, path, state, heading);
      await expect(page.locator('h1')).toHaveCount(1);
      await expect(page.getByRole('banner')).toHaveCount(1);
      await expect(page.getByRole('main')).toHaveCount(1);
      await expect(page.getByRole('contentinfo')).toHaveCount(1);
      await expect(page).toHaveTitle(/Federal Regulations MCP/);
      // 2.4.1 Bypass blocks: the first Tab reaches the skip link, which moves to main.
      await page.keyboard.press('Tab');
      const skip = page.getByRole('link', { name: 'Skip to main content' });
      await expect(skip).toBeFocused();
      await skip.press('Enter');
      await expect(page.locator('#main')).toBeFocused();
    });
  }

  test('1.4.12 text spacing: increased spacing does not clip or overflow content', async ({ page }) => {
    for (const { path, state, heading } of PAGES) {
      await open(page, path, state, heading);
      await page.addStyleTag({
        content: '* { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; } p { margin-bottom: 2em !important; }',
      });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, path).toBeLessThanOrEqual(0);
    }
  });
});

test.describe('behaviour', () => {
  test('a failed key save is tied to its field and announced', async ({ page }) => {
    await open(page, '/account', { signedIn: true, saveKeyError: 'regulations.gov rejected this key.' }, /your account/i);
    const field = page.getByLabel('Replace key');
    await field.fill('a'.repeat(40));
    await page.getByRole('button', { name: 'Check and save' }).first().click();
    await expect(field).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByRole('alert').filter({ hasText: 'regulations.gov rejected this key.' })).toBeVisible();
    await expect(field).toHaveAccessibleDescription(/regulations.gov rejected this key/);
  });

  test('a saved key confirmation gets focus and is announced politely', async ({ page }) => {
    await open(page, '/account', { signedIn: true }, /your account/i);
    await page.getByLabel('Replace key').fill('a'.repeat(40));
    await page.getByRole('button', { name: 'Check and save' }).first().click();
    const status = page.getByRole('status').filter({ hasText: 'Key saved' });
    await expect(status).toBeVisible();
    await expect(page.locator(':focus')).toContainText('Key saved');
  });

  test('a failed Google sign-in comes back with an announced, fixed message', async ({ page }) => {
    await open(page, `/sign-in?${OAUTH_QUERY}&error=access_denied`, undefined, /sign in to connect/i);
    await expect(page.getByRole('alert')).toHaveText('Sign-in was cancelled.');
    // An unknown code never echoes the URL's text.
    for (const code of ['%3Cscript%3E', '__proto__', 'constructor']) {
      await open(page, `/sign-in?error=${code}`, undefined, /your account/i);
      await expect(page.getByRole('alert')).toHaveText('Something went wrong. Start again.');
    }
    await open(page, '/error?error=__proto__', undefined, /something went wrong/i);
  });

  test('copying a connector URL is announced', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await open(page, '/', undefined, /federal rules, regulations and public comments/i);
    await page.getByRole('button', { name: 'Copy the server URL' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'the server URL copied' })).toBeAttached();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('https://fedreg.example.test/mcp/account');
  });

  test('the header offers sign-in when signed out and the account when signed in', async ({ page }) => {
    await open(page, '/', undefined, /federal rules, regulations and public comments/i);
    await expect(page.getByRole('navigation', { name: 'Site' }).getByRole('link', { name: 'Sign in' })).toBeVisible();
    await open(page, '/', { signedIn: true }, /federal rules, regulations and public comments/i);
    await expect(page.getByRole('navigation', { name: 'Site' }).getByRole('link', { name: 'Account' })).toBeVisible();
  });
});
