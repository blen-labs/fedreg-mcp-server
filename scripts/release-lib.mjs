// Pure logic for the continuous-release pipeline (scripts/release.mjs).
// Policy: EVERY push to main releases. Conventional-commit types map to
// SemVer — breaking (bang or BREAKING CHANGE footer) = major, feat = minor,
// everything else (fix/docs/chore/ci/refactor/test/...) = at least a patch.

const BANG_SUBJECT = /^[a-z]+(\([^)]*\))?!:/;
const FEAT_SUBJECT = /^feat(\([^)]*\))?!?:/;
const FIX_SUBJECT = /^fix(\([^)]*\))?!?:/;

/** @param {{subject: string, body?: string}[]} commits */
export function computeBump(commits) {
  let bump = 'patch';
  for (const { subject, body = '' } of commits) {
    if (BANG_SUBJECT.test(subject) || /BREAKING CHANGE/.test(body)) return 'major';
    if (FEAT_SUBJECT.test(subject)) bump = 'minor';
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
    const { subject, body = '' } = commit;
    const isBreaking = BANG_SUBJECT.test(subject) || /BREAKING CHANGE/.test(body);
    if (isBreaking) breaking.push(subjectText(subject));
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

  let out = changelog.replace(/^## \[Unreleased\]\s*$/m, match => `${match}\n\n${sectionText.trimEnd()}`);
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
