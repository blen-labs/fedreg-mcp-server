import { getSources, type SourceConfig } from './sources/index.js';
import type { SourceMeta } from './sources/source.js';

export interface Sdk {
  clients: Record<string, object>;   // enabled sources only
  meta: SourceMeta[];                // all registered sources (redacted)
  registeredNames: string[];         // all names (drives global injection)
  version: () => string;
}

export function buildSdk(cfg: SourceConfig): Sdk {
  const sources = getSources(cfg);
  const clients: Record<string, object> = {};
  for (const s of sources) if (s.enabled) clients[s.name] = s.client;
  return {
    clients,
    meta: sources.map(({ name, label, enabled, disabledReason }) => ({ name, label, enabled, disabledReason })),
    registeredNames: sources.map(s => s.name),
    version: () => '2.0.2', // x-release-version
  };
}
