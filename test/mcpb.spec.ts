import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildManifest } from '../scripts/mcpb-prepare.mjs';

// The MCPB manifest must satisfy @anthropic-ai/mcpb's v0.1 schema — the old
// DXT-shaped manifest (top-level entry_point/runtime/transport, no author or
// server) was rejected by `mcpb validate` and made packing impossible.
describe('mcpb manifest', () => {
  const pkg = { version: '9.9.9' };

  it('builds a v0.1 manifest with the required author and server blocks', () => {
    const m = buildManifest(pkg);
    expect(m.author.name).toBeTruthy();
    expect(m.server.type).toBe('node');
    expect(m.server.entry_point).toBe('dist/bin.js');
    expect(m.server.mcp_config.command).toBe('node');
    expect(m.server.mcp_config.args.join(' ')).toContain('dist/bin.js');
    expect(m.version).toBe('9.9.9');
    // Legacy DXT keys must not reappear at the top level.
    expect('entry_point' in m).toBe(false);
    expect('runtime' in m).toBe(false);
    expect('transport' in m).toBe(false);
  });

  it('passes the official mcpb validator', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcpb-manifest-test-'));
    const manifestPath = join(dir, 'manifest.json');
    writeFileSync(manifestPath, JSON.stringify(buildManifest(pkg), null, 2));
    const r = spawnSync(
      process.execPath,
      ['node_modules/@anthropic-ai/mcpb/dist/cli/cli.js', 'validate', manifestPath],
      { encoding: 'utf8' },
    );
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });
});
