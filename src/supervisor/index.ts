import { buildSdk } from '../sdk/bindings.js';
import { getSources } from '../sdk/sources/index.js';
import { buildCorpus } from '../search/corpus.js';
import { pickSandbox } from '../sandbox/index.js';
import type { CatalogDeps } from '../server/toolCatalog.js';
import type { SandboxKind } from '../sandbox/types.js';

export interface SupervisorConfig {
  frBaseUrl: string;
  ecfrBaseUrl: string;
  regsBaseUrl: string;
  regsApiKey?: string;
  userAgent: string;
  upstreamTimeoutMs: number;
  upstreamRetries: number;
  cacheTtlMs: number;
  cacheMaxItems: number;
  sandbox: SandboxKind;
  regsMaxCallsPerExecute: number;
}

export async function buildSupervisor(cfg: SupervisorConfig): Promise<CatalogDeps> {
  const sourceCfg = {
    frBaseUrl: cfg.frBaseUrl, ecfrBaseUrl: cfg.ecfrBaseUrl, regsBaseUrl: cfg.regsBaseUrl,
    regsApiKey: cfg.regsApiKey, userAgent: cfg.userAgent, timeoutMs: cfg.upstreamTimeoutMs,
    retries: cfg.upstreamRetries, cacheTtlMs: cfg.cacheTtlMs, cacheMaxItems: cfg.cacheMaxItems,
  };
  const sources = getSources(sourceCfg);
  const sdk = buildSdk(sourceCfg);
  const corpus = buildCorpus(sources);
  const sandbox = await pickSandbox(cfg.sandbox);
  return { sdk, sandbox, corpus, regsMaxCallsPerExecute: cfg.regsMaxCallsPerExecute };
}
