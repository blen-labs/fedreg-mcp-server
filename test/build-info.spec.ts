import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { readBuildInfo } from '../src/server/buildInfo.js';
import { SERVER_VERSION } from '../src/server/mcpServer.js';

describe('readBuildInfo', () => {
  const sha = '0123456789abcdef0123456789abcdef01234567';

  it('reports the package version and the commit Railway built', () => {
    expect(readBuildInfo({ RAILWAY_GIT_COMMIT_SHA: sha })).toEqual({ version: SERVER_VERSION, commit: sha });
  });

  it('reports a null commit when the platform gives none (local, npm, MCPB, docker run)', () => {
    expect(readBuildInfo({})).toEqual({ version: SERVER_VERSION, commit: null });
    expect(readBuildInfo({ RAILWAY_GIT_COMMIT_SHA: '' })).toEqual({ version: SERVER_VERSION, commit: null });
  });

  it('normalises case and whitespace, and never reports a value that is not a full SHA', () => {
    expect(readBuildInfo({ RAILWAY_GIT_COMMIT_SHA: ` ${sha.toUpperCase()}\n` }).commit).toBe(sha);
    for (const bad of ['abc123', 'main', `${sha}0`, `${sha.slice(0, 39)}g`])
      expect(readBuildInfo({ RAILWAY_GIT_COMMIT_SHA: bad }).commit, bad).toBeNull();
  });

  it('matches the version in package.json', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(SERVER_VERSION).toBe(pkg.version);
  });
});
