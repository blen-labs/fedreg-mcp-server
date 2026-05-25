import { BANNED_GLOBALS } from '../../sandbox/policy.js';
import { createFrSource } from './fr.js';
import { createEcfrSource } from './ecfr.js';
import type { Source, SourceConfig } from './source.js';

export type { Source, SourceMeta, SourceConfig } from './source.js';

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const NAME_DENYLIST = new Set<string>([...BANNED_GLOBALS, 'console', 'global', 'globalThis']);

export function getSources(cfg: SourceConfig): Source[] {
  const sources: Source[] = [createFrSource(cfg), createEcfrSource(cfg)];
  const seen = new Set<string>();
  for (const s of sources) {
    if (!IDENTIFIER.test(s.name)) throw new Error(`Invalid source name '${s.name}': must be a JS identifier`);
    if (NAME_DENYLIST.has(s.name)) throw new Error(`Source name '${s.name}' is not allowed (collides with a sandbox global)`);
    if (seen.has(s.name)) throw new Error(`Duplicate source name '${s.name}'`);
    seen.add(s.name);
  }
  return sources;
}
