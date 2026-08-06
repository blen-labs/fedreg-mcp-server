import { HttpClient } from '../../util/httpClient.js';
import { EcfrClient } from '../ecfr-client.js';
import { loadSourceCorpus } from './corpus-loader.js';
import type { Source, SourceConfig } from './source.js';

export function createEcfrSource(cfg: SourceConfig): Source {
  const http = new HttpClient({
    baseUrl: cfg.ecfrBaseUrl, userAgent: cfg.userAgent, timeoutMs: cfg.timeoutMs,
    retries: cfg.retries, cacheTtlMs: cfg.cacheTtlMs, cacheMaxItems: cfg.cacheMaxItems,
    ...(cfg.dispatcher ? { dispatcher: cfg.dispatcher } : {}),
  });
  return { name: 'ecfr', label: 'eCFR', enabled: true, client: new EcfrClient(http), corpus: loadSourceCorpus('ecfr') };
}
