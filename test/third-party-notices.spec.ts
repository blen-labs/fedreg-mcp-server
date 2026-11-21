import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BUNDLED_DEV_DEPENDENCIES } from '../scripts/release-lib.mjs';

// dist/web/THIRD_PARTY_NOTICES.txt ships in the npm package, the MCPB bundle and the image. It
// must name every package whose code is in the portal: the runtime libraries in the JavaScript
// and the CSS packages Tailwind compiles in. Build tools (Vite and its plugins) generate the
// bundle but put none of their own code in it.
const notices = new URL('../dist/web/THIRD_PARTY_NOTICES.txt', import.meta.url);
const BUILD_TOOLS = ['vite', '@vitejs/plugin-react', '@tailwindcss/vite'];

describe.skipIf(!existsSync(notices))('third-party notices (needs pnpm build)', () => {
  it('lists every bundled runtime package with its license text', () => {
    const text = readFileSync(notices, 'utf8');
    const listed = new Set([...text.matchAll(/^(@?[^@\s]+)@\S+ — /gm)].map((m) => m[1]));
    const expected = BUNDLED_DEV_DEPENDENCIES.filter((name) => !BUILD_TOOLS.includes(name));
    expect(expected.filter((name) => !listed.has(name))).toEqual([]);
    expect(text).toMatch(/Permission is hereby granted|Apache License|ISC License/);
  });
});
