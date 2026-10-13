import { buildSdk } from '../sdk/bindings.js';
import { getSources } from '../sdk/sources/index.js';
import { buildCorpus } from '../search/corpus.js';
import { pickSandbox } from '../sandbox/index.js';
import { TokenBucket } from '../util/tokenBucket.js';
import { UpstreamGate } from '../util/upstreamGate.js';
import { SubjectQuota } from '../util/quotas.js';
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
  regsRatePerHour: number;
  regsSubjectRatePerHour: number;
  /** Per public upstream (fr, ecfr), shared by every user: requests in flight and started per second. */
  upstreamConcurrency?: number;
  upstreamRatePerSec?: number;
  /** Longest a call waits for an upstream slot before failing with RateLimited. */
  upstreamMaxWaitMs?: number;
  publicMaxCallsPerExecute?: number;
}

export const UPSTREAM_DEFAULTS = { concurrency: 8, ratePerSec: 10, maxWaitMs: 15_000 } as const;

export async function buildSupervisor(cfg: SupervisorConfig): Promise<CatalogDeps> {
  const regsLimiter = new TokenBucket(cfg.regsRatePerHour / 3600, cfg.regsRatePerHour);
  const sourceCfg = {
    frBaseUrl: cfg.frBaseUrl, ecfrBaseUrl: cfg.ecfrBaseUrl, regsBaseUrl: cfg.regsBaseUrl,
    regsApiKey: cfg.regsApiKey, userAgent: cfg.userAgent, timeoutMs: cfg.upstreamTimeoutMs,
    retries: cfg.upstreamRetries, cacheTtlMs: cfg.cacheTtlMs, cacheMaxItems: cfg.cacheMaxItems,
    regsPreflightLimiter: regsLimiter,
    // One gate per upstream, shared by both source sets buildSupervisor creates.
    frGate: publicGate(cfg), ecfrGate: publicGate(cfg),
  };
  const sources = getSources(sourceCfg);
  const sdk = buildSdk(sourceCfg);
  const corpus = buildCorpus(sources);
  const sandbox = await pickSandbox(cfg.sandbox);
  const regsSubjectQuota = new SubjectQuota(cfg.regsSubjectRatePerHour, 60 * 60 * 1000);
  return {
    sdk, sandbox, corpus, regsMaxCallsPerExecute: cfg.regsMaxCallsPerExecute, regsSubjectQuota,
    publicMaxCallsPerExecute: cfg.publicMaxCallsPerExecute,
  };
}

function publicGate(cfg: SupervisorConfig): UpstreamGate {
  const ratePerSec = cfg.upstreamRatePerSec ?? UPSTREAM_DEFAULTS.ratePerSec;
  return new UpstreamGate({
    concurrency: cfg.upstreamConcurrency ?? UPSTREAM_DEFAULTS.concurrency,
    ratePerSec, burst: Math.max(1, Math.ceil(ratePerSec)),
    maxWaitMs: cfg.upstreamMaxWaitMs ?? UPSTREAM_DEFAULTS.maxWaitMs,
  });
}
