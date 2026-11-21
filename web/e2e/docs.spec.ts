import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { pages } from '../../site/src/lib/pages.mjs';

// The documentation site served at /docs (site/, Astro Starlight), against the same WCAG tags as
// the portal. Starlight follows the system color scheme until a reader picks a theme.
const DOCS = 'http://127.0.0.1:4174/docs';
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];
const paths = [...pages.map(({ slug }) => (slug === 'index' ? '/' : `/${slug}/`)), '/no-such-page/'];

for (const scheme of ['light', 'dark'] as const) {
  for (const viewport of [{ width: 1280, height: 800 }, { width: 320, height: 640 }]) {
    test.describe(`docs, ${scheme}, ${viewport.width}px`, () => {
      test.use({ colorScheme: scheme, viewport });
      for (const path of paths) {
        test(`${path} has no axe violations and no horizontal scrolling`, async ({ page }) => {
          await page.goto(`${DOCS}${path}`);
          await expect(page.locator('h1').first()).toBeVisible();
          const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
          expect(violations.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`)).toEqual([]);
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
          expect(overflow).toBeLessThanOrEqual(0);
        });
      }
    });
  }
}
