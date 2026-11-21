#!/usr/bin/env node
// Publishes docs/sdk-reference.md as the site's SDK reference page, so the method list has one
// source: the repository file, which a test keeps in step with schema/*.json.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatSnippet } from '../src/lib/format.mjs';
import { repo } from '../product.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, '../../docs/sdk-reference.md');
const target = resolve(here, '../src/content/docs/reference/sdk.md');
const repoDocs = `${repo}/blob/main/docs/`;

const text = readFileSync(source, 'utf8');
const title = /^# (.+)\n/.exec(text);
if (!title) throw new Error(`${source} must start with a "# " heading: the site takes its page title from it`);

// The repository file lists each method in a table under its source's heading, so the body
// carries over as written. Fail if the sources go missing: the format changed.
let body = text
  .slice(title[0].length)
  // The other documents in docs/ are not on the site: point their links at the repository.
  .replaceAll('](./', `](${repoDocs}`);
for (const source of ['fr', 'ecfr', 'regs']) {
  if (!body.includes(`## \`${source}.*\``)) throw new Error(`${source}: no "## \`${source}.*\`" section in docs/sdk-reference.md; the SDK reference format changed`);
}

// A js example that is one long line in the repository file is laid out for reading.
const fence = /^```js\n([\s\S]*?)\n```$/gm;
const formatted = await Promise.all([...body.matchAll(fence)].map(([, code]) => formatSnippet(code)));
let next = 0;
body = body.replace(fence, () => `\`\`\`js\n${formatted[next++]}\n\`\`\``);

const frontmatter = [
  '---',
  `title: ${title[1]}`,
  'description: Every fr, ecfr, and regs method, the regs query shape, and the errors a program can see.',
  `editUrl: ${repo}/edit/main/docs/sdk-reference.md`,
  '---',
  '',
].join('\n');

mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, frontmatter + body);
