import { getSources, type SourceConfig } from './sources/index.js';
import type { RpcMethods, SourceMeta } from './sources/source.js';

export interface Sdk {
  clients: Record<string, object>;   // enabled sources only
  methods: Readonly<Record<string, RpcMethods>>; // the only sandbox-callable surface
  meta: SourceMeta[];                // all registered sources (redacted)
  registeredNames: string[];         // all names (drives global injection)
  version: () => string;
}

export function buildSdk(cfg: SourceConfig): Sdk {
  const sources = getSources(cfg);
  const clients: Record<string, object> = {};
  const methods: Record<string, RpcMethods> = Object.create(null);
  for (const s of sources) if (s.enabled) {
    clients[s.name] = s.client;
    methods[s.name] = s.methods;
  }
  return {
    clients,
    methods: Object.freeze(methods),
    meta: sources.map(({ name, label, enabled, disabledReason }) => ({ name, label, enabled, disabledReason })),
    registeredNames: sources.map(s => s.name),
    version: () => '2.0.5', // x-release-version
  };
}
