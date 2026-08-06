#!/usr/bin/env node
// Stages an MCPB (MCP Bundle) directory for `mcpb pack mcpb-build`.
// Run from the repo root, after `pnpm build`:  pnpm build && pnpm mcpb:prepare
import { mkdirSync, cpSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

/**
 * The MCPB manifest, shaped for @anthropic-ai/mcpb's v0.1 schema
 * (required: name, version, description, author, server — the entry point
 * lives inside `server`, not at the top level).
 */
export function buildManifest(pkg) {
  return {
    manifest_version: '0.1',
    name: 'fedreg-mcp-server',
    display_name: 'Federal Register, eCFR & regulations.gov (Code Mode)',
    version: pkg.version,
    description:
      'Code-mode MCP server exposing FederalRegister.gov, eCFR, and regulations.gov APIs via fr.*, ecfr.*, and regs.* SDK bindings.',
    author: { name: 'BLEN, Inc.', url: 'https://blenlabs.com' },
    server: {
      type: 'node',
      entry_point: 'dist/bin.js',
      mcp_config: {
        command: 'node',
        // ${__dirname} is expanded by the MCPB host to the unpacked bundle dir.
        args: ['${__dirname}/dist/bin.js'],
      },
    },
  };
}

function main() {
  const root = resolve(process.cwd());
  const out = resolve(root, 'mcpb-build');
  if (existsSync(out)) rmSync(out, { recursive: true });
  mkdirSync(out, { recursive: true });

  cpSync(resolve(root, 'dist'), resolve(out, 'dist'), { recursive: true });
  cpSync(resolve(root, 'schema'), resolve(out, 'schema'), { recursive: true });
  cpSync(resolve(root, 'package.json'), resolve(out, 'package.json'));
  if (existsSync(resolve(root, 'README.md'))) {
    cpSync(resolve(root, 'README.md'), resolve(out, 'README.md'));
  }

  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  writeFileSync(resolve(out, 'manifest.json'), JSON.stringify(buildManifest(pkg), null, 2));

  // The bundle must carry its production node_modules — Claude Desktop runs it
  // with a plain `node`, with no install step. Hoisted layout: pnpm's default
  // symlink store does not survive zipping. --ignore-scripts skips the
  // isolated-vm native build (optional dep; execute falls back to Deno or
  // reports SandboxUnavailable on hosts where neither is available).
  // --ignore-workspace is load-bearing: without it, pnpm walks up to the repo's
  // pnpm-workspace.yaml and installs (and --prod-prunes!) the ROOT node_modules
  // instead of the bundle's.
  execFileSync(
    'pnpm',
    ['install', '--prod', '--ignore-scripts', '--ignore-workspace', '--config.node-linker=hoisted', '--no-lockfile'],
    { cwd: out, stdio: 'inherit' },
  );

  // Fail loudly here rather than at `mcpb pack` time.
  execFileSync(
    process.execPath,
    [resolve(root, 'node_modules/@anthropic-ai/mcpb/dist/cli/cli.js'), 'validate', resolve(out, 'manifest.json')],
    { stdio: 'inherit' },
  );

  console.log('mcpb-build/ prepared at', out);
  console.log('next: pnpm mcpb:pack   (packs mcpb-build/ into a .mcpb)');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
