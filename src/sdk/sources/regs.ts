import { HttpClient } from '../../util/httpClient.js';
import { RegulationsClient } from '../regs-client.js';
import { loadSourceCorpus } from './corpus-loader.js';
import type { Source, SourceConfig } from './source.js';

export function createRegsSource(cfg: SourceConfig): Source {
  const key = cfg.regsApiKey?.trim();
  const enabled = Boolean(key);
  const http = new HttpClient({
    baseUrl: cfg.regsBaseUrl, userAgent: cfg.userAgent, timeoutMs: cfg.timeoutMs,
    retries: cfg.retries, cacheTtlMs: cfg.cacheTtlMs, cacheMaxItems: cfg.cacheMaxItems,
    retry429: false,
    ...(enabled ? { defaultHeaders: { 'X-Api-Key': key! } } : {}),
    ...(cfg.regsPreflightLimiter ? { preflightLimiter: cfg.regsPreflightLimiter } : {}),
    ...(cfg.dispatcher ? { dispatcher: cfg.dispatcher } : {}),
  });
  const client = new RegulationsClient(http);
  return {
    name: 'regs',
    label: 'Regulations.gov',
    enabled,
    disabledReason: enabled ? undefined : 'regulations.gov requires an API key. Set FEDREG_REGS_API_KEY (free at https://open.gsa.gov/api/regulationsgov/).',
    client,
    methods: Object.freeze({
      'documents.search': client.documents.search,
      'documents.get': client.documents.get,
      'comments.search': client.comments.search,
      'comments.get': client.comments.get,
      'dockets.search': client.dockets.search,
      'dockets.get': client.dockets.get,
    }),
    corpus: loadSourceCorpus('regs'),
  };
}
