#!/usr/bin/env node
// Stages an MCPB (MCP Bundle) directory for `mcpb pack mcpb-build`.
// Run from the repo root, after `pnpm build`:  pnpm build && pnpm mcpb:prepare
import { mkdirSync, cpSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

/**
 * The MCPB manifest, shaped for @anthropic-ai/mcpb's manifest schema (required: name, version,
 * description, author, server; the entry point lives inside `server`, not at the top level).
 */
export function buildManifest(pkg) {
  return {
    manifest_version: '0.4',
    name: 'fedreg-mcp-server',
    display_name: 'Federal Regulations MCP (Code Mode)',
    version: pkg.version,
    description:
      'Code-mode MCP server exposing FederalRegister.gov, eCFR, and regulations.gov APIs via fr.*, ecfr.*, and regs.* SDK bindings.',
    long_description:
      'Ask about Federal Register documents, the Code of Federal Regulations as currently in force or at any past date, and regulations.gov dockets, documents and public comments. ' +
      'The assistant writes small JavaScript programs that run in a sandbox (isolated-vm, or Deno) against the public APIs; ' +
      'the optional regulations.gov key stays on your computer. Independent open-source project; not affiliated with or endorsed by any government agency.',
    author: { name: 'BLEN, Inc.', url: 'https://blenlabs.com' },
    repository: { type: 'git', url: 'https://github.com/blen-labs/fedreg-mcp-server' },
    homepage: 'https://github.com/blen-labs/fedreg-mcp-server#readme',
    support: 'https://github.com/blen-labs/fedreg-mcp-server/issues',
    license: pkg.license,
    keywords: ['federal register', 'ecfr', 'regulations.gov', 'public comments', 'regulations', 'code mode'],
    tools: [
      { name: 'search_api', description: 'Find fr, ecfr and regs SDK methods and response fields' },
      { name: 'describe_schema', description: 'Exact signature and fields for a method or namespace' },
      { name: 'execute', description: 'Run JavaScript against the fr, ecfr and regs SDKs in a sandbox' },
    ],
    // Same range as package.json "engines": isolated-vm ships prebuilt binaries only for
    // those majors (darwin-arm64, linux-x64/arm64, win32-x64); elsewhere execute uses Deno.
    compatibility: { platforms: ['darwin', 'win32', 'linux'], runtimes: { node: pkg.engines.node } },
    server: {
      type: 'node',
      entry_point: 'dist/bin.js',
      mcp_config: {
        command: 'node',
        // ${__dirname} is expanded by the MCPB host to the unpacked bundle dir.
        args: ['${__dirname}/dist/bin.js'],
        // The regulations.gov key is personal; the host prompts for it and keeps it in its secure
        // store. Left empty, regs.* stays disabled and fr.* and ecfr.* work without any key.
        env: { FEDREG_REGS_API_KEY: '${user_config.regs_api_key}' },
      },
    },
    user_config: {
      regs_api_key: {
        type: 'string',
        title: 'regulations.gov API key (optional)',
        description: 'Free from open.gsa.gov/api/regulationsgov. Leave empty to disable regs.* (dockets, documents, comments); Federal Register and eCFR need no key.',
        sensitive: true,
        required: false,
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
  // Reproducible: the bundle installs exactly the tested lockfile.
  cpSync(resolve(root, 'pnpm-lock.yaml'), resolve(out, 'pnpm-lock.yaml'));
  // The bundle's own workspace root: carries the dependency overrides the lockfile was resolved
  // with (a frozen install refuses a mismatch), and stops pnpm from walking up to the repo root.
  cpSync(resolve(root, 'pnpm-workspace.yaml'), resolve(out, 'pnpm-workspace.yaml'));
  // Keeps better-auth's optional peers (vitest, react) out of the production graph.
  cpSync(resolve(root, '.pnpmfile.cjs'), resolve(out, '.pnpmfile.cjs'));
  for (const f of ['LICENSE', 'NOTICE']) cpSync(resolve(root, f), resolve(out, f));
  if (existsSync(resolve(root, 'README.md'))) {
    cpSync(resolve(root, 'README.md'), resolve(out, 'README.md'));
  }

  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  writeFileSync(resolve(out, 'manifest.json'), JSON.stringify(buildManifest(pkg), null, 2));

  // The bundle must carry its production node_modules — Claude Desktop runs it
  // with a plain `node`, with no install step. Hoisted layout: pnpm's default
  // symlink store does not survive zipping. --ignore-scripts skips native builds:
  // isolated-vm loads its shipped prebuilt binary at runtime (Node 24/26 on the
  // common platforms); elsewhere execute falls back to Deno or reports
  // SandboxUnavailable with instructions.
  // The copied pnpm-workspace.yaml makes mcpb-build/ its own workspace root, so this
  // installs (and --prod-prunes) the bundle's node_modules, never the repo root's.
  execFileSync(
    'pnpm',
    ['install', '--prod', '--frozen-lockfile', '--ignore-scripts', '--config.node-linker=hoisted'],
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
