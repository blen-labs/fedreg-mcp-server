/**
 * Supervisor: builds the SDK, picks a sandbox, and wires the catalog deps.
 */
import { buildSdk } from '../sdk/bindings.js';
import { pickSandbox } from '../sandbox/index.js';
import type { CatalogDeps } from '../server/toolCatalog.js';
import type { SandboxKind } from '../sandbox/types.js';

export interface SupervisorConfig {
  frBaseUrl: string;
  ecfrBaseUrl: string;
  userAgent: string;
  upstreamTimeoutMs: number;
  upstreamRetries: number;
  cacheTtlMs: number;
  cacheMaxItems: number;
  sandbox: SandboxKind;
}

export async function buildSupervisor(cfg: SupervisorConfig): Promise<CatalogDeps> {
  const sdk = buildSdk({
    frBaseUrl: cfg.frBaseUrl,
    ecfrBaseUrl: cfg.ecfrBaseUrl,
    userAgent: cfg.userAgent,
    timeoutMs: cfg.upstreamTimeoutMs,
    retries: cfg.upstreamRetries,
    cacheTtlMs: cfg.cacheTtlMs,
    cacheMaxItems: cfg.cacheMaxItems,
  });
  const sandbox = await pickSandbox(cfg.sandbox);
  return { sdk, sandbox };
}
