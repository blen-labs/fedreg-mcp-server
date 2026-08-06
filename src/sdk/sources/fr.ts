import { HttpClient } from '../../util/httpClient.js';
import { FederalRegisterClient } from '../fr-client.js';
import { loadSourceCorpus } from './corpus-loader.js';
import type { Source, SourceConfig } from './source.js';

export function createFrSource(cfg: SourceConfig): Source {
  const http = new HttpClient({
    baseUrl: cfg.frBaseUrl, userAgent: cfg.userAgent, timeoutMs: cfg.timeoutMs,
    retries: cfg.retries, cacheTtlMs: cfg.cacheTtlMs, cacheMaxItems: cfg.cacheMaxItems,
    ...(cfg.dispatcher ? { dispatcher: cfg.dispatcher } : {}),
  });
  return { name: 'fr', label: 'Federal Register', enabled: true, client: new FederalRegisterClient(http), corpus: loadSourceCorpus('fr') };
}
