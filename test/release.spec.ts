import { describe, it, expect } from 'vitest';
import {
  computeBump,
  bumpVersion,
  renderChangelogSection,
  insertChangelogSection,
  updateVersionMarkers,
} from '../scripts/release-lib.mjs';

const c = (subject: string, body = '') => ({ subject, body });

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
  it('patch for chore/ci/docs-only pushes — every merge releases', () => {
    expect(computeBump([c('ci: tweak workflow'), c('docs: readme')])).toBe('patch');
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
      c('feat(sdk): add ecfr diffs'),
      c('fix(http): correct 403 body'),
      c('ci: speed up install'),
    ]);
    expect(s).toContain('## [2.1.0] - 2026-08-07');
    expect(s).toMatch(/### Added[\s\S]*add ecfr diffs/);
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
