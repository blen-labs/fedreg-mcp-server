#!/usr/bin/env node
import { mkdirSync, cpSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

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

const manifest = {
  manifest_version: '0.1',
  name: 'fedreg-mcp-server',
  display_name: 'Federal Register & eCFR (Code Mode)',
  version: JSON.parse(await import('node:fs').then(fs => fs.promises.readFile(resolve(root, 'package.json'), 'utf8'))).version,
  description: 'Code-mode MCP server exposing FederalRegister.gov and eCFR APIs via fr.* and ecfr.* SDK bindings.',
  entry_point: 'dist/bin.js',
  runtime: 'node',
  transport: 'stdio',
};
writeFileSync(resolve(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log('mcpb-build/ prepared at', out);
