import { describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { docFiles, fences, unlabelledFences } from '../scripts/check-docs.mjs';

// The documentation source, as opposed to the built site (web/e2e checks that in a browser).
const read = (file: string) => readFileSync(file, 'utf8');

describe('code fences', () => {
  it('finds opening fences only, however they are closed or indented', () => {
    const source = ['```', 'bare', '```', '', '```js title="x"', 'code', '```', '  ```text', '  a', '  ```', '````md', '```', 'nested', '```', '````', '~~~', 'tilde', '~~~'].join('\n');
    expect(fences(source).map(({ line, lang }) => [line, lang])).toEqual([[1, ''], [5, 'js'], [8, 'text'], [11, 'md'], [16, '']]);
  });

  it('are labelled in the root Markdown files, deploy/, docs/, and the authored pages of the site', () => {
    expect(docFiles()).toEqual(expect.arrayContaining(['README.md', 'CLAUDE.md', 'CONTRIBUTING.md', 'deploy/RAILWAY.md', 'docs/architecture.md', 'site/src/content/docs/self-host.mdx']));
    expect(unlabelledFences()).toEqual([]);
  });
});

// Every shell block in the docs is run with stub commands, so a placeholder the shell would parse
// (such as <tenant>) or an unknown command fails here, before a reader hits it.
describe.each(['/bin/bash', '/bin/zsh'].filter(existsSync))('documented shell templates (%s)', (shell) => {
  const blocks = docFiles().flatMap((file) =>
    fences(read(file)).filter((fence) => /^(bash|sh|shell|zsh)$/.test(fence.lang)).map((fence) => [`${file}:${fence.line}`, fence.body] as const),
  );

  it('documents the start commands, the rotation command and the deploy checks', () => {
    expect(blocks.length).toBeGreaterThanOrEqual(8);
  });

  it.each(blocks)('%s runs to the server invocation', (_where, body) => {
    const dir = mkdtempSync(join(tmpdir(), 'docs-shell-'));
    const log = join(dir, 'calls.log');
    // The only commands on PATH: each records its arguments and its environment.
    mkdirSync(join(dir, 'site'));
    for (const name of ['npx', 'node', 'pnpm', 'docker', 'curl', 'jq']) {
      const stub = join(dir, name);
      writeFileSync(stub, `#!/bin/sh\n{ echo "CALL ${name} $*"; /usr/bin/env; } >> "${log}"\n`);
      chmodSync(stub, 0o755);
    }
    const run = spawnSync(shell, ['-c', body], { cwd: dir, env: { PATH: dir }, encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(0);
    const calls = existsSync(log) ? read(log).split('CALL ').slice(1) : [];
    expect(calls.length, 'the block never reached a command').toBeGreaterThan(0);
    for (const call of calls) {
      const [first = '', ...environment] = call.trim().split('\n');
      if (first.startsWith('npx ')) expect(first).toMatch(/^npx @blen\/fedreg-mcp-server --http/);
      // Whatever the reader replaces, what is written must already be a well-formed URL.
      for (const line of environment.filter((v) => /^FEDREG_(AUTH_ISSUER|AUTH_JWKS_URL|AUTH_AUDIENCE|PUBLIC_ORIGIN)=/.test(v))) {
        expect(() => new URL(line.slice(line.indexOf('=') + 1)), line).not.toThrow();
      }
    }
  });
});

describe('README example', () => {
  const blocks = (lang: string) => fences(read('README.md')).filter((fence) => fence.lang === lang).map((fence) => fence.body);

  // The README cannot include a file, so its copy of the tested example must not drift from it.
  it('is the tested examples/ecfr-section.js, verbatim', () => {
    expect(blocks('js')).toContain(read('examples/ecfr-section.js'));
  });

  it('shows the captured output of that example', () => {
    const { value, synthetic } = JSON.parse(read('examples/outputs/ecfr-section.json'));
    expect(synthetic).toBe(false);
    expect(blocks('json')).toContain(`${JSON.stringify(value, null, 2)}\n`);
  });
});
