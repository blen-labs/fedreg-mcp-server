// Pure logic for the continuous-release pipeline (scripts/release.mjs).
// Policy: a push to main releases when the commits since the last tag can change what users
// install (releaseReason); a range that cannot (dev tooling, CI, docs, tests) waits for the next
// release. Conventional-commit types map to SemVer — breaking (bang or BREAKING CHANGE footer) =
// major, feat = minor, everything else = patch.

const BANG_SUBJECT = /^[a-z]+(\([^)]*\))?!:/;
const FEAT_SUBJECT = /^feat(\([^)]*\))?!?:/;
// Conventional Commits: a footer line `BREAKING CHANGE: ...` (or `BREAKING-CHANGE:`), not any mention.
const BREAKING_FOOTER = /^BREAKING[ -]CHANGE(\([^)]*\))?: /m;
const FIX_SUBJECT = /^fix(\([^)]*\))?!?:/;
const TYPE = /^([a-z]+)(\([^)]*\))?!?: /;

/**
 * Types that cannot, by themselves, change the published npm package or the release's MCPB
 * bundle. Everything else releases: feat, fix, perf, revert, refactor (a refactor rewrites
 * shipped code; "no behavior change" is a claim, not something the pipeline can check), and any
 * subject that is not conventional at all. Dependabot uses `fix(deps)` for runtime dependencies
 * and `build`/`ci` for dev tooling, site/, actions and base images (.github/dependabot.yml).
 */
export const NO_RELEASE_TYPES = Object.freeze(['build', 'chore', 'ci', 'docs', 'style', 'test']);

/**
 * Paths whose contents reach users, so a change to them releases whatever the commit type:
 * dist/ is compiled from src/ (tsconfig*.json) and web/ (which bundles legal/), schema/ ships
 * as is, LICENSE and NOTICE are the package's terms, and .pnpmfile.cjs and mcpb-prepare.mjs
 * shape the MCPB bundle's production install and manifest. Directories end in '/'.
 * Deliberately absent: README.md, SECURITY.md and CHANGELOG.md (documentation, refreshed by
 * the next release); pnpm-lock.yaml and pnpm-workspace.yaml, which change with every dev-tooling
 * bump: they decide the MCPB bundle's production install, so release.mjs compares that tree
 * itself (changedPackages) instead of releasing on any edit; deploy/ (the Docker image is built
 * from the repository, not by the release), site/, docs/, test/ and .github/.
 */
export const SHIPPED_PATHS = Object.freeze([
  'src/', 'web/', 'legal/', 'schema/',
  'tsconfig.json', 'tsconfig.build.json',
  'LICENSE', 'NOTICE',
  '.pnpmfile.cjs', 'scripts/mcpb-prepare.mjs',
]);

/**
 * devDependencies that still reach users: the portal (web/) is built into dist/web, which the npm
 * package and the MCPB bundle ship, so its runtime libraries and the tools that generate its
 * output count as shipped. A change to their version, or to anything they pull in, releases.
 * test/release.spec.ts fails when web/ imports a package missing from this list.
 */
export const BUNDLED_DEV_DEPENDENCIES = Object.freeze([
  'react', 'react-dom', 'react-router', 'react-markdown', 'radix-ui', 'lucide-react',
  'class-variance-authority', 'clsx', 'tailwind-merge', 'tw-animate-css',
  'tailwindcss', '@tailwindcss/vite', 'vite', '@vitejs/plugin-react',
]);

/** package.json fields that never reach an install of the published package. */
const UNSHIPPED_MANIFEST_FIELDS = new Set(['version', 'devDependencies', 'packageManager']);
/**
 * Scripts that only serve development. Every other script counts as shipped: npm runs the install
 * hooks for users, and build, build:web, prepack and mcpb:* decide what dist/ and the bundle hold
 * (`npm pack` runs prepack in the release job). A new script counts until it is listed here.
 */
export const DEV_ONLY_SCRIPTS = Object.freeze(['dev', 'dev:web', 'test', 'test:watch', 'test:live', 'lint', 'typecheck']);

const isBreaking = ({ subject, body = '' }) => BANG_SUBJECT.test(subject) || BREAKING_FOOTER.test(body);

/** @param {string} path */
export function isShippedPath(path) {
  return SHIPPED_PATHS.some(p => (p.endsWith('/') ? path.startsWith(p) : path === p));
}

/**
 * Top-level package.json fields that differ in a way the published package can show: everything
 * except the version (the release stamps it), devDependencies, packageManager and the
 * DEV_ONLY_SCRIPTS. Fail-safe: any other field or script counts, known or not.
 * @param {Record<string, unknown>} before @param {Record<string, unknown>} after
 */
export function changedManifestFields(before, after) {
  const shipped = (manifest) => {
    const out = {};
    for (const [key, value] of Object.entries(manifest)) {
      if (key === 'devDependencies' && value && typeof value === 'object') {
        const bundled = Object.entries(value).filter(([name]) => BUNDLED_DEV_DEPENDENCIES.includes(name));
        if (bundled.length) out.bundledDevDependencies = Object.fromEntries(bundled);
        continue;
      }
      if (UNSHIPPED_MANIFEST_FIELDS.has(key)) continue;
      if (key === 'scripts' && value && typeof value === 'object') {
        const shipped = Object.entries(value).filter(([name]) => !DEV_ONLY_SCRIPTS.includes(name));
        if (shipped.length) out[key] = Object.fromEntries(shipped);
        continue;
      }
      out[key] = value;
    }
    return out;
  };
  const a = shipped(before);
  const b = shipped(after);
  return [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter(key => JSON.stringify(a[key]) !== JSON.stringify(b[key]))
    .sort();
}

/**
 * Every `name@version` in a `pnpm ls --depth Infinity --json` tree. pnpm prints a package's
 * dependencies once and marks later occurrences deduped, so every node is visited. With `roots`,
 * only those top-level packages (production, optional or dev) and what they pull in.
 * @param {Array<{dependencies?: object, optionalDependencies?: object, devDependencies?: object}>} tree
 * @param {{ roots?: readonly string[] }} [options]
 */
export function productionPackages(tree, { roots } = {}) {
  const found = new Set();
  const walk = (deps) => {
    for (const [name, node] of Object.entries(deps ?? {})) {
      found.add(`${name}@${node.version}`);
      walk(node.dependencies);
      walk(node.optionalDependencies);
    }
  };
  const only = (deps) => (roots ? Object.fromEntries(Object.entries(deps ?? {}).filter(([name]) => roots.includes(name))) : deps);
  for (const importer of tree) {
    walk(only(importer.dependencies));
    walk(only(importer.optionalDependencies));
    // With `roots`, also the matching devDependencies (and everything they pull in).
    if (roots) walk(only(importer.devDependencies));
  }
  return [...found].sort();
}

/** `-name@old` / `+name@new` for packages that left or joined a production tree. */
export function changedPackages(before, after) {
  const a = new Set(before);
  const b = new Set(after);
  return [...before.filter(p => !b.has(p)).map(p => `-${p}`), ...after.filter(p => !a.has(p)).map(p => `+${p}`)];
}

/**
 * Why these commits need a release, or null when none of them can change what users install.
 * A commit releases when it is breaking, when its type is not in NO_RELEASE_TYPES, or when it
 * touches a SHIPPED_PATHS entry; the range also releases when package.json changed in a shipped
 * field (changedManifestFields), whatever the commit types — e.g. a runtime dependency bumped
 * under a `build(deps)` subject — or when the lockfile's production tree, which the MCPB bundle
 * installs, gained or lost a package (changedPackages: a transitive fix in the lockfile or an
 * `overrides:` entry).
 * @param {{subject: string, body?: string, files?: string[]}[]} commits
 * @param {{manifestFields?: string[], productionChanges?: string[]}} [options]
 */
export function releaseReason(commits, { manifestFields = [], productionChanges = [] } = {}) {
  for (const commit of commits) {
    if (isBreaking(commit)) return `breaking change: ${commit.subject}`;
    const type = commit.subject.match(TYPE)?.[1];
    if (!type || !NO_RELEASE_TYPES.includes(type)) return `${type ?? 'non-conventional'} commit: ${commit.subject}`;
    const shipped = (commit.files ?? []).find(isShippedPath);
    if (shipped) return `${shipped} changed by: ${commit.subject}`;
  }
  if (manifestFields.length) return `package.json changed: ${manifestFields.join(', ')}`;
  if (productionChanges.length) {
    const shown = productionChanges.slice(0, 6).join(', ');
    const more = productionChanges.length > 6 ? `, and ${productionChanges.length - 6} more` : '';
    return `production dependencies changed: ${shown}${more}`;
  }
  return null;
}

/** @param {{subject: string, body?: string}[]} commits */
export function computeBump(commits) {
  let bump = 'patch';
  for (const commit of commits) {
    if (isBreaking(commit)) return 'major';
    if (FEAT_SUBJECT.test(commit.subject)) bump = 'minor';
  }
  return bump;
}

/** @param {string} version @param {'major'|'minor'|'patch'} bump */
export function bumpVersion(version, bump) {
  const [major, minor, patch] = version.split('.').map(Number);
  if (bump === 'major') return `${major + 1}.0.0`;
  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

function subjectText(subject) {
  // Drop the conventional prefix for display: "feat(sdk): add x" -> "add x (sdk)"
  const m = subject.match(/^([a-z]+)(\(([^)]*)\))?!?:\s*(.*)$/);
  if (!m) return subject;
  const scope = m[3] ? ` (${m[3]})` : '';
  return `${m[4]}${scope}`;
}

/** Keep-a-Changelog section for one release. */
export function renderChangelogSection(version, date, commits) {
  const breaking = [];
  const added = [];
  const fixed = [];
  const changed = [];
  for (const commit of commits) {
    const { subject } = commit;
    if (isBreaking(commit)) breaking.push(subjectText(subject));
    if (FEAT_SUBJECT.test(subject)) added.push(subjectText(subject));
    else if (FIX_SUBJECT.test(subject)) fixed.push(subjectText(subject));
    else changed.push(subjectText(subject));
  }
  const lines = [`## [${version}] - ${date}`, ''];
  const section = (title, items) => {
    if (!items.length) return;
    lines.push(`### ${title}`, ...items.map(i => `- ${i}`), '');
  };
  section('Breaking', breaking);
  section('Added', added);
  section('Fixed', fixed);
  section('Changed', changed);
  return lines.join('\n');
}

/**
 * Insert a release section directly under "## [Unreleased]" and rewrite the
 * comparison links at the bottom: [Unreleased] now compares from the new tag,
 * and the new tag gets its own compare line against the previous one.
 */
export function insertChangelogSection(changelog, sectionText, version) {
  const unreleasedLink = changelog.match(/^\[Unreleased\]: (\S+)\/compare\/v([0-9.]+)\.\.\.HEAD$/m);
  if (!unreleasedLink) throw new Error('CHANGELOG.md: could not find the [Unreleased] compare link');
  const repoUrl = unreleasedLink[1];
  const previous = unreleasedLink[2];

  // The heading and the blank lines under it become exactly: heading, blank, section, blank. A
  // `\s*$` here would swallow those blank lines into the match and keep them, so the run grew by
  // one line per release and the next heading lost its separating blank line.
  // A function replacer, so `$&`, `$'` or `$$` in the section text stay literal. Line endings
  // (\r\n too) are matched, not assumed.
  let out = changelog.replace(
    /^## \[Unreleased\][ \t]*\r?\n(?:[ \t]*\r?\n)*/m,
    () => `## [Unreleased]\n\n${sectionText.trim()}\n\n`,
  );
  out = out.replace(
    unreleasedLink[0],
    [
      `[Unreleased]: ${repoUrl}/compare/v${version}...HEAD`,
      `[${version}]: ${repoUrl}/compare/v${previous}...v${version}`,
    ].join('\n'),
  );
  return out;
}

/** Rewrite the semver literal on every line carrying the x-release-version marker. */
export function updateVersionMarkers(source, version) {
  return source
    .split('\n')
    .map(line =>
      line.includes('x-release-version') ? line.replace(/(['"])\d+\.\d+\.\d+\1/, `'${version}'`) : line,
    )
    .join('\n');
}
