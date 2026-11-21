#!/usr/bin/env node
// Smoke-tests an unpacked MCPB bundle the way a desktop host runs it: plain `node dist/bin.js`
// over stdio from the bundle directory, with a minimal environment, then `execute('return 42')`.
//
//   node scripts/mcpb-smoke.mjs <unpacked-bundle-dir>
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const dir = resolve(process.argv[2] ?? 'mcpb-build');
const child = spawn(process.execPath, ['dist/bin.js'], {
  cwd: dir, stdio: ['pipe', 'pipe', 'inherit'],
  env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp' },
});
const send = m => child.stdin.write(JSON.stringify(m) + '\n');
let buf = '';
const timer = setTimeout(() => { console.error('mcpb smoke: timed out'); child.kill(); process.exit(1); }, 30_000);
child.stdout.on('data', chunk => {
  buf += chunk;
  for (let nl; (nl = buf.indexOf('\n')) >= 0;) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    const msg = JSON.parse(line);
    if (msg.id === 1) {
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'execute', arguments: { code: 'return 1 + 41' } } });
    } else if (msg.id === 2) {
      clearTimeout(timer);
      const ok = msg.result?.structuredContent?.ok === true && msg.result.structuredContent.value === 42;
      console.log(ok ? 'mcpb smoke: execute returned 42' : `mcpb smoke: unexpected ${line.slice(0, 500)}`);
      child.kill();
      process.exit(ok ? 0 : 1);
    }
  }
});
send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mcpb-smoke', version: '1' } } });
