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
  const client = new FederalRegisterClient(http);
  return {
    name: 'fr', label: 'Federal Register', enabled: true, client, corpus: loadSourceCorpus('fr'),
    methods: Object.freeze({
      'documents.search': client.documents.search,
      'documents.get': client.documents.get,
      'documents.getMany': client.documents.getMany,
      'documents.facets': client.documents.facets,
      'publicInspection.current': client.publicInspection.current,
      'publicInspection.search': client.publicInspection.search,
      'publicInspection.get': client.publicInspection.get,
      'publicInspection.getMany': client.publicInspection.getMany,
      'agencies.list': client.agencies.list,
      'agencies.get': client.agencies.get,
      'issues.get': client.issues.get,
      'suggestedSearches.list': client.suggestedSearches.list,
      'suggestedSearches.get': client.suggestedSearches.get,
      'images.get': client.images.get,
    }),
  };
}
