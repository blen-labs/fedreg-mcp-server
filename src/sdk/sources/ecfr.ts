import { HttpClient } from '../../util/httpClient.js';
import { EcfrClient } from '../ecfr-client.js';
import { loadSourceCorpus } from './corpus-loader.js';
import type { Source, SourceConfig } from './source.js';

/**
 * eCFR full-text XML is large: Title 40 is about 157 MB decompressed (25 MB gzipped) as of
 * 2026-11, and the other titles are smaller. The limit leaves headroom above the largest title so
 * a legitimate whole-title request works; anything bigger fails with ResponseTooLarge, never truncated.
 */
export const ECFR_MAX_RESPONSE_BYTES = 192 * 1024 * 1024;

export function createEcfrSource(cfg: SourceConfig): Source {
  const http = new HttpClient({
    baseUrl: cfg.ecfrBaseUrl, userAgent: cfg.userAgent, timeoutMs: cfg.timeoutMs,
    retries: cfg.retries, cacheTtlMs: cfg.cacheTtlMs, cacheMaxItems: cfg.cacheMaxItems,
    label: 'eCFR API', maxResponseBytes: ECFR_MAX_RESPONSE_BYTES,
    ...(cfg.ecfrGate ? { gate: cfg.ecfrGate } : {}),
    ...(cfg.dispatcher ? { dispatcher: cfg.dispatcher } : {}),
  });
  const client = new EcfrClient(http);
  return {
    name: 'ecfr', label: 'eCFR', enabled: true, client, corpus: loadSourceCorpus('ecfr'),
    methods: Object.freeze({
      'admin.agencies': client.admin.agencies,
      'admin.corrections': client.admin.corrections,
      'admin.corrections_for_title': client.admin.corrections_for_title,
      'titles.list': client.titles.list,
      structure: client.structure,
      ancestry: client.ancestry,
      versions: client.versions,
      full: client.full,
      'search.results': client.search.results,
      'search.counts_daily': client.search.counts_daily,
      'search.counts_titles': client.search.counts_titles,
      'search.counts_hierarchy': client.search.counts_hierarchy,
      'search.suggestions': client.search.suggestions,
    }),
  };
}
