#!/usr/bin/env node
// Source-level checks on the authored documentation, run by test/docs-source.spec.ts and
// available as `pnpm docs:check`. The rendered site is checked in a browser (web/e2e); this
// catches what only the Markdown source shows, such as a code fence with no language.
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** The authored documentation: the root Markdown files, deploy/RAILWAY.md, docs/ and the site's pages (reference/sdk.md is generated from docs/sdk-reference.md). */
export function docFiles(root = '.') {
  const walk = (dir) =>
    readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return walk(path);
      return /\.mdx?$/.test(entry.name) ? [path] : [];
    });
  const rootFiles = readdirSync(root).filter((name) => /\.md$/.test(name) && name !== 'release-notes.generated.md');
  return [...rootFiles, 'examples/README.md', 'deploy/RAILWAY.md', ...walk('docs'), ...walk('site/src/content/docs')].filter(
    (file) => file !== 'site/src/content/docs/reference/sdk.md',
  );
}

/**
 * The code fences of a Markdown or MDX source: `{ line, lang, body }` for each opening fence,
 * where `lang` is the first word of its info string ('' when there is none). A closing fence is
 * bare by definition, so only fences in the "outside a fence" state are opening ones.
 */
export function fences(source) {
  const found = [];
  let open;
  source.split('\n').forEach((text, index) => {
    const match = /^\s*(`{3,}|~{3,})(.*)$/.exec(text);
    if (open) {
      const closes = match && match[1][0] === open.char && match[1].length >= open.length && match[2].trim() === '';
      if (closes) open = undefined;
      else open.fence.body += `${text}\n`;
      return;
    }
    if (!match) return;
    const fence = { line: index + 1, lang: /^[A-Za-z][\w+#.-]*/.exec(match[2].trim())?.[0] ?? '', body: '' };
    found.push(fence);
    open = { char: match[1][0], length: match[1].length, fence };
  });
  return found;
}

/** `file:line` for every opening code fence that names no language. Text diagrams are labelled `text`. */
export function unlabelledFences(root = '.') {
  return docFiles(root).flatMap((file) =>
    fences(readFileSync(join(root, file), 'utf8'))
      .filter((fence) => !fence.lang)
      .map((fence) => `${file}:${fence.line}`),
  );
}

if (resolve(process.argv[1] ?? '') === import.meta.filename) {
  const problems = unlabelledFences();
  if (problems.length) {
    console.error(`Code fences without a language (use \`text\` for a diagram or output):\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`docs: ${docFiles().length} files, every code fence is labelled`);
}
