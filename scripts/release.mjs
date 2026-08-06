#!/usr/bin/env node
// Continuous release: called by .github/workflows/release.yml on every push
// to main. Computes the next version from conventional commits since the last
// tag (every commit type releases — see scripts/release-lib.mjs), stamps
// package.json + the x-release-version source markers, prepends a CHANGELOG
// section, and writes step outputs for the workflow to commit/tag/publish.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { computeBump, bumpVersion, renderChangelogSection, insertChangelogSection, updateVersionMarkers } from './release-lib.mjs';

const MARKER_FILES = ['src/server/mcpServer.ts', 'src/sdk/bindings.ts'];

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function setOutput(key, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  console.log(`release: ${key}=${value}`);
}

const lastTag = git('describe', '--tags', '--abbrev=0');
// ASCII record/field separators, emitted by git via %x1e/%x1f so no raw
// control characters live in this file.
const RECORD = '\x1e';
const FIELD = '\x1f';
const raw = git('log', `${lastTag}..HEAD`, '--no-merges', '--format=%s%x1f%b%x1e');
const commits = raw
  .split(RECORD)
  .map(r => r.trim())
  .filter(Boolean)
  .map(r => {
    const [subject, body = ''] = r.split(FIELD);
    return { subject: subject.trim(), body };
  })
  // Never let a prior release commit feed the next bump.
  .filter(c => !c.subject.startsWith('chore(release):'));

if (commits.length === 0) {
  console.log(`release: no commits since ${lastTag} - nothing to release`);
  setOutput('released', 'false');
  process.exit(0);
}

const current = JSON.parse(readFileSync('package.json', 'utf8')).version;
const bump = computeBump(commits);
const version = bumpVersion(current, bump);
const date = process.env.RELEASE_DATE ?? new Date().toISOString().slice(0, 10);

const pkg = readFileSync('package.json', 'utf8');
writeFileSync('package.json', pkg.replace(`"version": "${current}"`, `"version": "${version}"`));
for (const file of MARKER_FILES) {
  writeFileSync(file, updateVersionMarkers(readFileSync(file, 'utf8'), version));
}

const section = renderChangelogSection(version, date, commits);
writeFileSync('CHANGELOG.md', insertChangelogSection(readFileSync('CHANGELOG.md', 'utf8'), section, version));

const notesFile = 'release-notes.generated.md';
writeFileSync(notesFile, `${section.split('\n').slice(2).join('\n').trim()}\n`);

setOutput('released', 'true');
setOutput('version', version);
setOutput('bump', bump);
setOutput('notes_file', notesFile);
