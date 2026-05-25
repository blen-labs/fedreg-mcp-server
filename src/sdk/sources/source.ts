import type { Dispatcher } from 'undici';
import type { CorpusEntry } from '../../search/corpus.js';

export interface SourceMeta {
  name: string;          // sandbox global + RPC binding id
  label: string;         // human label, e.g. 'Federal Register'
  enabled: boolean;      // false when a required secret is missing
  disabledReason?: string;
}

export interface Source extends SourceMeta {
  client: object;        // host-side client reachable as <name>.* in the sandbox
  corpus: { endpoints: CorpusEntry[]; fields: CorpusEntry[] };
}

export interface SourceConfig {
  frBaseUrl: string;
  ecfrBaseUrl: string;
  regsBaseUrl: string;
  regsApiKey?: string;
  userAgent: string;
  timeoutMs: number;
  retries: number;
  cacheTtlMs: number;
  cacheMaxItems: number;
  dispatcher?: Dispatcher;
  regsPreflightLimiter?: { tryTake(): boolean; secondsUntilNext?(): number };
}
