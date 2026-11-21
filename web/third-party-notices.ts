import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import type { Plugin } from 'vite';

/**
 * Vite plugin: records every npm package whose code ends up in the browser bundle and writes
 * their license texts to THIRD_PARTY_NOTICES.txt next to the assets, so redistributing the
 * bundle (npm, Docker, MCPB) carries the notices the licenses require.
 */
export function thirdPartyNotices(fileName = 'THIRD_PARTY_NOTICES.txt'): Plugin {
  return {
    name: 'third-party-notices',
    apply: 'build',
    generateBundle(_opts, bundle) {
      const roots = new Map<string, string>();
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk') continue;
        for (const id of Object.keys(chunk.modules)) {
          const i = id.lastIndexOf(`${sep}node_modules${sep}`);
          if (i < 0) continue;
          const rest = id.slice(i + 14).split(sep);
          const name = rest[0]!.startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0]!;
          roots.set(name, id.slice(0, i + 14) + name.split('/').join(sep));
        }
      }
      const out: string[] = ['Third-party software included in the web portal bundle.', ''];
      for (const [name, dir] of [...roots].sort(([a], [b]) => a.localeCompare(b))) {
        const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version?: string; license?: string };
        const file = existsSync(dir) ? readdirSync(dir).find(f => /^(licen[cs]e|copying|notice)(\.|$)/i.test(f)) : undefined;
        out.push('='.repeat(78), `${name}@${pkg.version ?? '?'} — ${pkg.license ?? 'see package'}`, '='.repeat(78));
        out.push(file ? readFileSync(join(dir, file), 'utf8').trim() : `License: ${pkg.license ?? 'UNKNOWN'} (no license file shipped by the package)`, '');
      }
      this.emitFile({ type: 'asset', fileName, source: out.join('\n') });
    },
  };
}
