import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  BUNDLED_DEV_DEPENDENCIES,
  changedManifestFields,
  changedPackages,
  productionPackages,
  isShippedPath,
  releaseReason,
  computeBump,
  bumpVersion,
  renderChangelogSection,
  insertChangelogSection,
  updateVersionMarkers,
} from '../scripts/release-lib.mjs';

const c = (subject: string, body = '', files: string[] = []) => ({ subject, body, files });

describe('releaseReason', () => {
  // What Dependabot and everyday maintenance produce (.github/dependabot.yml prefixes), with the
  // files each one really touches. None of it can change what an npm or MCPB user installs.
  const skipped = [
    c('build(deps-dev): bump the dev-tooling group with 4 updates', '', ['package.json', 'pnpm-lock.yaml']),
    c('build(deps): bump astro from 6.1.0 to 6.2.0 in /site in the site group', '', ['site/package.json', 'site/pnpm-lock.yaml']),
    // Docker base image: deploy/ is built from the repository (Railway), never by release.yml.
    c('build(deps): bump node from 26.1.0-trixie-slim to 26.2.0-trixie-slim in /deploy', '', ['deploy/Dockerfile']),
    c('ci(deps): bump actions/checkout from 7.0.1 to 7.0.2 in the actions group', '', ['.github/workflows/ci.yml', '.github/workflows/release.yml']),
    c('docs: clarify account setup', '', ['docs/accounts.md', 'README.md', 'site/src/content/docs/index.mdx']),
    c('test(http): cover a disconnect race', '', ['test/http.spec.ts']),
    c('chore: tidy the release script', '', ['scripts/release.mjs', 'pnpm-workspace.yaml']),
    c('style: reformat the docs site config', '', ['site/astro.config.mjs']),
  ];

  it.each(skipped.map(x => [x.subject, x]))('nothing to release for %s', (_s, commit) => {
    expect(releaseReason([commit])).toBeNull();
  });
  it('nothing to release for a whole range of them', () => {
    expect(releaseReason(skipped)).toBeNull();
  });

  it.each([
    ['fix(deps): bump undici from 8.12.4 to 8.13.0', 'fix commit'],
    ['feat(sdk): add a method', 'feat commit'],
    ['perf(search): cache the index', 'perf commit'],
    ['revert: "feat(sdk): add a method"', 'revert commit'],
    // A refactor rewrites shipped code; "no behavior change" is a claim the pipeline cannot check.
    ['refactor(sdk): split the client', 'refactor commit'],
  ])('releases for %s', (subject, why) => {
    expect(releaseReason([...skipped, c(subject)])).toContain(why);
  });

  it('a refactor releases even when it touches no shipped path', () => {
    expect(releaseReason([c('refactor(test): share fixtures', '', ['test/helpers.ts'])])).toContain('refactor commit');
  });

  it('releases for a non-conventional subject (fail safe)', () => {
    expect(releaseReason([c('Update README.md', '', ['README.md'])])).toContain('non-conventional');
  });

  it('releases for a breaking change whatever its type', () => {
    expect(releaseReason([c('build!: require Node 26')])).toContain('breaking change');
    expect(releaseReason([c('chore: drop Node 24', 'BREAKING CHANGE: Node 26 is required')])).toContain('breaking change');
  });

  it.each([
    ['chore(sdk): rename a helper', 'src/sdk/sources/regs.ts'],
    ['style: reformat the server', 'src/server/http.ts'],
    ['docs(corpus): reword an endpoint description', 'schema/fr.json'],
    ['build(deps-dev): bump react in the portal', 'web/src/main.tsx'],
    ['docs: update the privacy policy', 'legal/privacy-policy.md'],
    ['build: target es2025', 'tsconfig.build.json'],
    ['chore: update NOTICE', 'NOTICE'],
    ['build: adjust the bundle manifest', 'scripts/mcpb-prepare.mjs'],
    ['build: drop another optional peer', '.pnpmfile.cjs'],
  ])('a %s commit touching %s releases', (subject, file) => {
    expect(releaseReason([c(subject, '', ['docs/x.md', file])])).toBe(`${file} changed by: ${subject}`);
  });

  // Dependabot prefixes runtime bumps `fix(deps)`; this catches one that arrives as `build`.
  it('releases when package.json changed in a shipped field, whatever the types', () => {
    const commits = [c('build(deps): bump undici', '', ['package.json', 'pnpm-lock.yaml'])];
    expect(releaseReason(commits)).toBeNull();
    expect(releaseReason(commits, { manifestFields: ['dependencies'] })).toBe('package.json changed: dependencies');
  });

  // The MCPB bundle installs the lockfile's production tree; a transitive fix or an `overrides:`
  // entry can change it without touching package.json.
  it('releases when the production tree changed, whatever the types', () => {
    const commits = [c('build(deps): pin a patched transitive dependency', '', ['pnpm-lock.yaml', 'pnpm-workspace.yaml'])];
    expect(releaseReason(commits, { productionChanges: [] })).toBeNull();
    expect(releaseReason(commits, { productionChanges: ['-ms@2.1.3', '+ms@2.1.2'] })).toBe('production dependencies changed: -ms@2.1.3, +ms@2.1.2');
    const many = Array.from({ length: 8 }, (_, i) => `+p${i}@1.0.0`);
    expect(releaseReason(commits, { productionChanges: many })).toMatch(/\+p5@1\.0\.0, and 2 more$/);
  });
});

describe('productionPackages / changedPackages', () => {
  it('collects every name@version, including dependencies pnpm prints once and marks deduped later', () => {
    const tree = [{
      dependencies: {
        express: { version: '5.3.0', dependencies: { debug: { version: '4.4.3' } } },
        'body-parser': { version: '2.4.0', dependencies: { debug: { version: '4.4.3', dedupedDependenciesCount: 1 } } },
      },
      optionalDependencies: { 'isolated-vm': { version: '7.0.2', dependencies: { 'node-gyp-build': { version: '4.8.4' } } } },
    }];
    expect(productionPackages(tree)).toEqual(['body-parser@2.4.0', 'debug@4.4.3', 'express@5.3.0', 'isolated-vm@7.0.2', 'node-gyp-build@4.8.4']);
    expect(productionPackages([{}])).toEqual([]);
  });
  it('with roots, keeps only those top-level packages (dev ones too) and what they pull in', () => {
    const tree = [{
      devDependencies: {
        react: { version: '19.3.1', dependencies: { scheduler: { version: '0.27.0' } } },
        vitest: { version: '5.1.1', dependencies: { tinypool: { version: '2.0.0' } } },
      },
    }];
    expect(productionPackages(tree, { roots: ['react'] })).toEqual(['react@19.3.1', 'scheduler@0.27.0']);
  });
  it('lists what left and what joined', () => {
    expect(changedPackages(['a@1.0.0', 'ms@2.1.3'], ['a@1.0.0', 'ms@2.1.2'])).toEqual(['-ms@2.1.3', '+ms@2.1.2']);
    expect(changedPackages(['a@1.0.0'], ['a@1.0.0'])).toEqual([]);
  });
});

describe('isShippedPath', () => {
  it('matches directories by prefix and files exactly', () => {
    expect(isShippedPath('src/bin.ts')).toBe(true);
    expect(isShippedPath('schema/regs.json')).toBe(true);
    expect(isShippedPath('LICENSE')).toBe(true);
    expect(isShippedPath('srcx/a.ts')).toBe(false);
    expect(isShippedPath('LICENSE.old')).toBe(false);
    expect(isShippedPath('scripts/release.mjs')).toBe(false);
    expect(isShippedPath('site/src/index.ts')).toBe(false);
    expect(isShippedPath('README.md')).toBe(false);
  });
});

describe('changedManifestFields', () => {
  const base = {
    name: '@blen/fedreg-mcp-server',
    version: '1.0.0',
    dependencies: { undici: '^8.12.4' },
    optionalDependencies: { 'isolated-vm': '^7.0.2' },
    devDependencies: { vitest: '^4.0.0' },
    engines: { node: '^24.11.0 || ^26.0.0' },
    packageManager: 'pnpm@12.21.0',
    scripts: { build: 'tsc', test: 'vitest run' },
  };
  const edit = (f: (p: Record<string, any>) => void) => { const p = structuredClone(base) as Record<string, any>; f(p); return p; };

  it('ignores what never reaches an install: version, devDependencies, packageManager, non-install scripts', () => {
    expect(changedManifestFields(base, edit(p => {
      p.version = '1.0.1';
      p.devDependencies.vitest = '^4.1.0';
      p.packageManager = 'pnpm@12.22.0';
      p.scripts.test = 'vitest run --reporter dot';
      p.scripts.lint = 'eslint .';
      p.scripts['test:live'] = 'vitest run test/live.spec.ts --bail 1';
    }))).toEqual([]);
  });

  it('reports shipped fields that changed, appeared or disappeared', () => {
    expect(changedManifestFields(base, edit(p => { p.dependencies.undici = '^8.13.0'; }))).toEqual(['dependencies']);
    expect(changedManifestFields(base, edit(p => { p.optionalDependencies['isolated-vm'] = '^7.1.0'; }))).toEqual(['optionalDependencies']);
    expect(changedManifestFields(base, edit(p => { p.engines.node = '^26.0.0'; }))).toEqual(['engines']);
    expect(changedManifestFields(base, edit(p => { p.bin = { x: 'dist/x.js' }; }))).toEqual(['bin']);
    expect(changedManifestFields(base, edit(p => { delete p.optionalDependencies; }))).toEqual(['optionalDependencies']);
    // npm runs a dependency's install hooks, so those scripts ship.
    expect(changedManifestFields(base, edit(p => { p.scripts.postinstall = 'node x.js'; }))).toEqual(['scripts']);
    // build, build:web and prepack decide dist/ (`npm pack` runs prepack in the release job).
    expect(changedManifestFields(base, edit(p => { p.scripts.build = 'tsc --removeComments'; }))).toEqual(['scripts']);
    expect(changedManifestFields(base, edit(p => { p.scripts.prepack = 'pnpm run build'; }))).toEqual(['scripts']);
    // A script nobody has classified yet counts (fail safe).
    expect(changedManifestFields(base, edit(p => { p.scripts['bundle:extra'] = 'node x.js'; }))).toEqual(['scripts']);
  });

  it('counts the portal\'s bundled devDependencies: they are compiled into dist/web', () => {
    expect(changedManifestFields(base, edit(p => { p.devDependencies.react = '19.3.1'; }))).toEqual(['bundledDevDependencies']);
    const withReact = edit(p => { p.devDependencies.react = '19.3.0'; });
    expect(changedManifestFields(withReact, edit(p => { p.devDependencies.react = '19.3.1'; }))).toEqual(['bundledDevDependencies']);
    expect(changedManifestFields(withReact, edit(p => { p.devDependencies.react = '19.3.0'; p.devDependencies.vitest = '^5.0.0'; }))).toEqual([]);
  });

  it('lists every package the portal imports (web/) as bundled', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(e =>
      e.isDirectory() ? (e.name === 'e2e' ? [] : files(join(dir, e.name))) : /\.(tsx?|css)$/.test(e.name) ? [join(dir, e.name)] : []);
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    const imported = new Set<string>();
    for (const file of files('web')) {
      for (const [, spec] of readFileSync(file, 'utf8').matchAll(/(?:from|@import)\s+'([^'.][^']*)'/g)) {
        if (spec!.startsWith('@/') || spec!.startsWith('node:')) continue;
        imported.add(spec!.startsWith('@') ? spec!.split('/').slice(0, 2).join('/') : spec!.split('/')[0]!);
      }
    }
    // Production dependencies ship anyway; every other import must be a listed bundled devDependency.
    const missing = [...imported].filter(name => !pkg.dependencies?.[name] && !BUNDLED_DEV_DEPENDENCIES.includes(name));
    expect(missing).toEqual([]);
  });
});

describe('computeBump', () => {
  it('major on a bang subject', () => {
    expect(computeBump([c('feat(protocol)!: drop sessions')])).toBe('major');
  });
  it('major on a BREAKING CHANGE footer', () => {
    expect(computeBump([c('fix: x', 'BREAKING CHANGE: y')])).toBe('major');
  });
  it('minor when any feat is present', () => {
    expect(computeBump([c('fix: a'), c('feat: b')])).toBe('minor');
  });
  it('patch for fixes', () => {
    expect(computeBump([c('fix: a')])).toBe('patch');
  });
  it('patch for a released range whose other commits are chore/ci/docs', () => {
    expect(computeBump([c('ci: tweak workflow'), c('docs: readme'), c('refactor: x')])).toBe('patch');
  });
});

describe('bumpVersion', () => {
  it('bumps each part and resets the lower ones', () => {
    expect(bumpVersion('2.0.1', 'major')).toBe('3.0.0');
    expect(bumpVersion('2.0.1', 'minor')).toBe('2.1.0');
    expect(bumpVersion('2.0.1', 'patch')).toBe('2.0.2');
  });
});

describe('renderChangelogSection', () => {
  it('groups commits under Keep-a-Changelog headings', () => {
    const s = renderChangelogSection('2.1.0', '2026-08-07', [
      c('feat(sdk): add ptab rss feed'),
      c('fix(http): correct 403 body'),
      c('ci: speed up install'),
    ]);
    expect(s).toContain('## [2.1.0] - 2026-08-07');
    expect(s).toMatch(/### Added[\s\S]*add ptab rss feed/);
    expect(s).toMatch(/### Fixed[\s\S]*correct 403 body/);
    expect(s).toMatch(/### Changed[\s\S]*speed up install/);
  });
  it('surfaces breaking changes in their own section', () => {
    const s = renderChangelogSection('3.0.0', '2026-08-07', [c('feat!: remove legacy leg')]);
    expect(s).toMatch(/### Breaking[\s\S]*remove legacy leg/);
  });
});

describe('insertChangelogSection', () => {
  const changelog = [
    '# Changelog', '',
    '## [Unreleased]', '',
    '## [2.0.0] - 2026-08-06', '', 'old content', '',
    '[Unreleased]: https://github.com/o/r/compare/v2.0.0...HEAD',
    '[2.0.0]: https://github.com/o/r/compare/v1.0.0...v2.0.0', '',
  ].join('\n');

  it('inserts the section after Unreleased and rewrites link refs', () => {
    const out = insertChangelogSection(changelog, '## [2.0.1] - 2026-08-07\n\n### Fixed\n- x\n', '2.0.1');
    expect(out.indexOf('## [Unreleased]')).toBeLessThan(out.indexOf('## [2.0.1]'));
    expect(out.indexOf('## [2.0.1]')).toBeLessThan(out.indexOf('## [2.0.0]'));
    expect(out).toContain('[Unreleased]: https://github.com/o/r/compare/v2.0.1...HEAD');
    expect(out).toContain('[2.0.1]: https://github.com/o/r/compare/v2.0.0...v2.0.1');
    expect(out).toContain('[2.0.0]: https://github.com/o/r/compare/v1.0.0...v2.0.0');
  });

  it('keeps one blank line around the new section, release after release', () => {
    let out = insertChangelogSection(changelog, '## [2.0.1] - 2026-08-07\n\n### Fixed\n- x\n', '2.0.1');
    out = insertChangelogSection(out, '## [2.0.2] - 2026-08-08\n\n### Fixed\n- y\n', '2.0.2');
    expect(out).toContain('## [Unreleased]\n\n## [2.0.2] - 2026-08-08\n\n### Fixed\n- y\n\n## [2.0.1]');
    expect(out).toContain('- x\n\n## [2.0.0]');
    expect(out).not.toMatch(/\n\n\n/);
  });

  it('keeps `$` sequences in the section literal and handles CRLF changelogs', () => {
    const section = '## [2.0.1] - 2026-08-07\n\n### Fixed\n- costs $& and $$5 and $`\n';
    expect(insertChangelogSection(changelog, section, '2.0.1')).toContain('- costs $& and $$5 and $`\n');
    const crlf = insertChangelogSection(changelog.replace(/\n/g, '\r\n'), section, '2.0.1');
    expect(crlf).toContain('## [2.0.1] - 2026-08-07');
  });
});

describe('updateVersionMarkers', () => {
  it('rewrites the version only on marker lines', () => {
    const src = [
      "const other = '1.2.3';",
      "    { name: 'fedreg-mcp-server', version: '2.0.0' }, // x-release-version",
    ].join('\n');
    const out = updateVersionMarkers(src, '2.0.1');
    expect(out).toContain("version: '2.0.1' }, // x-release-version");
    expect(out).toContain("const other = '1.2.3';");
  });
});

type NextCommit = {
  subject: string;
  /** path -> content to write (directories are created); defaults to a scratch file. */
  files?: Record<string, string>;
  /** edits package.json in place before the commit. */
  pkg?: (pkg: Record<string, any>) => void;
  /** `git mv` these [from, to] paths in the commit. */
  mv?: [string, string];
  /** rewrites pnpm-lock.yaml (needs `lockfile: true`). */
  lock?: (text: string) => string;
};

describe('release.mjs against disposable repositories', () => {
  // `lockfile` adds the real install files, so release.mjs compares production trees with pnpm.
  const run = async (tagged: boolean, next: string | NextCommit | NextCommit[] = 'feat(sdk): add something', env: Record<string, string> = {}, { lockfile = false } = {}) => {
    const { mkdtempSync, mkdirSync, cpSync, writeFileSync, readFileSync, existsSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join, resolve, dirname } = await import('node:path');
    const { execFileSync } = await import('node:child_process');
    const root = resolve(__dirname, '..');
    // The disposable repository gets the real package.json, so its tag must name that version.
    const declared = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version as string;
    const dir = mkdtempSync(join(tmpdir(), 'fedreg-release-'));
    for (const f of ['package.json', 'CHANGELOG.md', ...(lockfile ? ['pnpm-lock.yaml', 'pnpm-workspace.yaml', '.pnpmfile.cjs'] : [])]) cpSync(join(root, f), join(dir, f));
    mkdirSync(join(dir, 'scripts'));
    for (const f of ['release.mjs', 'release-lib.mjs']) cpSync(join(root, 'scripts', f), join(dir, 'scripts', f));
    for (const f of ['src/server/mcpServer.ts', 'src/sdk/bindings.ts']) { mkdirSync(join(dir, f, '..'), { recursive: true }); cpSync(join(root, f), join(dir, f)); }
    const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
    // A shipped file the release itself never rewrites (the marker files above it does).
    mkdirSync(join(dir, 'schema')); writeFileSync(join(dir, 'schema/fr.json'), '{"entries": []}\n');
    git('init', '-q', '-b', 'main'); git('add', '.'); git('commit', '-qm', 'feat: initial');
    if (tagged) {
      git('tag', `v${declared}`);
      const commits = (Array.isArray(next) ? next : [next]).map(n => (typeof n === 'string' ? { subject: n } : n));
      commits.forEach((n, i) => {
        if (n.mv) { mkdirSync(dirname(join(dir, n.mv[1])), { recursive: true }); git('mv', ...n.mv); }
        for (const [path, content] of Object.entries(n.files ?? (n.mv ? {} : { [`x${i}.txt`]: 'x' }))) {
          mkdirSync(dirname(join(dir, path)), { recursive: true });
          writeFileSync(join(dir, path), content);
        }
        if (n.lock) writeFileSync(join(dir, 'pnpm-lock.yaml'), n.lock(readFileSync(join(dir, 'pnpm-lock.yaml'), 'utf8')));
        if (n.pkg) {
          const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
          n.pkg(pkg);
          writeFileSync(join(dir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
        }
        git('add', '.'); git('commit', '-qm', n.subject);
      });
    }
    const before = { pkg: readFileSync(join(dir, 'package.json'), 'utf8'), changelog: readFileSync(join(dir, 'CHANGELOG.md'), 'utf8') };
    const out = join(dir, 'gh-output');
    writeFileSync(out, '');
    const parentEnv = { ...process.env };
    delete parentEnv.RELEASE_FORCE;
    const log = execFileSync(process.execPath, ['scripts/release.mjs'], { cwd: dir, encoding: 'utf8', env: { ...parentEnv, GITHUB_OUTPUT: out, RELEASE_DATE: '2026-11-12', ...env } });
    const outputs = Object.fromEntries(readFileSync(out, 'utf8').trim().split('\n').map(l => l.split('=') as [string, string]));
    const after = { pkg: readFileSync(join(dir, 'package.json'), 'utf8'), changelog: readFileSync(join(dir, 'CHANGELOG.md'), 'utf8') };
    return { declared, outputs, log, untouched: before.pkg === after.pkg && before.changelog === after.changelog, notes: existsSync(join(dir, 'release-notes.generated.md')) ? readFileSync(join(dir, 'release-notes.generated.md'), 'utf8') : '', pkg: JSON.parse(after.pkg), changelog: after.changelog };
  };
  const patchOf = (v: string) => { const [a, b, p] = v.split('.').map(Number); return `${a}.${b}.${p! + 1}`; };

  it('a fresh repository (no tags) releases the declared version with its hand-written notes', async () => {
    const { outputs, notes, pkg, changelog } = await run(false);
    expect(outputs).toMatchObject({ released: 'true', version: pkg.version, bump: 'initial' });
    // The notes are the CHANGELOG's own section for the declared version (whatever it says today).
    const section = changelog.split(/^## /m).find((s) => s.startsWith(`[${pkg.version}]`));
    expect(section).toBeDefined();
    expect(notes.trim()).not.toBe('');
    expect(notes.trim()).toBe(section!.split('\n').slice(1).join('\n').trim());
    expect(notes).not.toContain("[Unreleased]");
  });

  it('a tagged repository bumps from the last tag', async () => {
    const { declared, outputs, pkg } = await run(true);
    const [major, minor] = declared.split('.').map(Number);
    const next = `${major}.${minor! + 1}.0`;
    expect(outputs).toMatchObject({ released: 'true', bump: 'minor', version: next });
    expect(pkg.version).toBe(next);
  });

  // The release commit is pushed with an app token, which (unlike GITHUB_TOKEN) triggers workflows.
  // Normally its tag makes tag..HEAD empty; this pins the second guard for when it doesn't (e.g. a
  // release commit that landed without its tag): chore(release) commits never cause a release, even
  // though a real one touches src/ (the version markers) and package.json.
  it('a release commit or a merge message alone releases nothing', async () => {
    const release: NextCommit = {
      subject: 'chore(release): v9.9.9',
      files: { 'src/server/mcpServer.ts': "export const x = '9.9.9'; // x-release-version\n", 'CHANGELOG.md': 'changed\n' },
      pkg: p => { p.version = '9.9.9'; },
    };
    for (const next of [release, { subject: 'Merge pull request #5 from blen-labs/some-branch', files: { 'src/x.ts': 'x' } }]) {
      const { outputs, untouched } = await run(true, next);
      expect(outputs, next.subject).toEqual({ released: 'false' });
      expect(untouched, next.subject).toBe(true);
    }
  });

  it('a range that cannot change the package releases nothing and stamps nothing', async () => {
    const { outputs, untouched, log } = await run(true, [
      // A real lockfile that changed without changing the production tree (pnpm 12 refuses to
      // read a malformed one, which would count as a change).
      { subject: 'build(deps-dev): bump vitest in the dev-tooling group', lock: text => `${text}# dev-tooling bump\n`, pkg: p => { p.devDependencies.vitest = '^99.0.0'; } },
      { subject: 'build(deps): bump node in /deploy', files: { 'deploy/Dockerfile': 'FROM node:99\n' } },
      { subject: 'ci(deps): bump actions/checkout in the actions group', files: { '.github/workflows/ci.yml': 'on: push\n' } },
      { subject: 'build(deps): bump astro in /site in the site group', files: { 'site/package.json': '{}\n' } },
      { subject: 'docs: readme', files: { 'README.md': 'readme\n' } },
      { subject: 'test: add a case', files: { 'test/a.spec.ts': 'x\n' } },
    ], {}, { lockfile: true });
    expect(outputs).toEqual({ released: 'false' });
    expect(untouched).toBe(true);
    expect(log).toContain('nothing to release');
  });

  it('RELEASE_FORCE releases such a range as a patch', async () => {
    const { declared, outputs } = await run(true, { subject: 'build(deps-dev): bump typescript', files: { 'pnpm-lock.yaml': 'lock\n' } }, { RELEASE_FORCE: '1' });
    expect(outputs).toMatchObject({ released: 'true', bump: 'patch', version: patchOf(declared) });
  });

  it('a runtime dependency bump releases even under a build subject (package.json check)', async () => {
    const { declared, outputs, log } = await run(true, { subject: 'build(deps): bump undici', pkg: p => { p.dependencies.undici = '^99.0.0'; } });
    expect(outputs).toMatchObject({ released: 'true', bump: 'patch', version: patchOf(declared) });
    expect(log).toContain('package.json changed: dependencies');
  });

  it('a refactor, or a chore that touches src/, releases a patch', async () => {
    for (const next of <NextCommit[]>[{ subject: 'refactor(sdk): split the client', files: { 'test/x.ts': 'x' } }, { subject: 'chore: rename a helper', files: { 'src/sdk/x.ts': 'x' } }]) {
      const { declared, outputs } = await run(true, next);
      expect(outputs, next.subject).toMatchObject({ released: 'true', bump: 'patch', version: patchOf(declared) });
    }
  });

  it('a script that shapes the build releases; a dev-only one does not', async () => {
    const build = await run(true, { subject: 'build: strip comments from dist', pkg: p => { p.scripts.build = `${p.scripts.build} # changed`; } });
    expect(build.outputs).toMatchObject({ released: 'true', bump: 'patch' });
    expect(build.log).toContain('package.json changed: scripts');
    const lint = await run(true, { subject: 'chore: lint quietly', pkg: p => { p.scripts.lint = 'eslint . --quiet'; } });
    expect(lint.outputs).toEqual({ released: 'false' });
  });

  // Against the real lockfile. Each edit renames one locked version everywhere it appears, which is
  // what pnpm reads: a dev-only package (vitest), then a transitive production one (ms, via debug).
  // The versions come from today's lockfile, and an edit that changes nothing fails the test.
  const bumpPatch = (v: string) => v.replace(/\d+$/, p => String(Number(p) + 1));
  const relock = (name: string) => (text: string) => {
    const from = text.match(new RegExp(`\\n  ${name}@(\\d+\\.\\d+\\.\\d+):\\n`))?.[1];
    expect(from, `${name} in pnpm-lock.yaml`).toBeDefined();
    const to = bumpPatch(from!);
    const out = text
      .replaceAll(`${name}@${from}`, `${name}@${to}`)
      .replaceAll(`\n      ${name}: ${from}\n`, `\n      ${name}: ${to}\n`)
      .replace(new RegExp(`(\\n {6}${name}:\\n {8}specifier: [^\\n]*\\n {8}version: )${from!.replaceAll('.', '\\.')}`), `$1${to}`);
    expect(out).not.toBe(text);
    return out;
  };
  const lockedVersion = (name: string) => readFileSync(resolve(__dirname, '..', 'pnpm-lock.yaml'), 'utf8').match(new RegExp(`\\n  ${name}@(\\d+\\.\\d+\\.\\d+):\\n`))![1]!;

  it('a lockfile change that leaves the production tree alone releases nothing', async () => {
    const { outputs, untouched } = await run(true, { subject: 'build(deps-dev): bump vitest', lock: relock('vitest') }, {}, { lockfile: true });
    expect(outputs).toEqual({ released: 'false' });
    expect(untouched).toBe(true);
  });

  it('a lockfile change to a production package releases (the MCPB bundle installs it)', async () => {
    const { declared, outputs, log } = await run(true, { subject: 'build(deps): pin a patched transitive dependency', lock: relock('ms') }, {}, { lockfile: true });
    expect(outputs).toMatchObject({ released: 'true', bump: 'patch', version: patchOf(declared) });
    const ms = lockedVersion('ms');
    expect(log).toContain(`production dependencies changed: -ms@${ms}, +ms@${bumpPatch(ms)}`);
  });

  // git log's rename detection would list only the destination (test/), hiding the shipped source.
  it('moving a shipped file to an unshipped path releases', async () => {
    const { declared, outputs, log } = await run(true, { subject: 'test: reuse the corpus as a fixture', mv: ['schema/fr.json', 'test/fixtures/fr.json'] });
    expect(outputs).toMatchObject({ released: 'true', bump: 'patch', version: patchOf(declared) });
    expect(log).toContain('schema/fr.json changed by');
  });

  it('skipped commits ship with the next release and appear in its CHANGELOG section', async () => {
    const { declared, outputs, changelog } = await run(true, [
      { subject: 'build(deps-dev): bump vitest', files: { 'pnpm-lock.yaml': 'lock\n' } },
      { subject: 'fix(http): correct a status code', files: { 'src/server/http.ts': 'x' } },
    ]);
    expect(outputs).toMatchObject({ released: 'true', bump: 'patch', version: patchOf(declared) });
    const section = changelog.split(/^## /m).find(s => s.startsWith(`[${patchOf(declared)}]`))!;
    expect(section).toMatch(/### Fixed[\s\S]*correct a status code/);
    expect(section).toMatch(/### Changed[\s\S]*bump vitest/);
  });
});
