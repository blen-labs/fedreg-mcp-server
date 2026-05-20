import { HttpClient } from '../util/httpClient.js';

export interface EcfrSearchParams {
  query: string;
  agency_slugs?: string[];
  date?: string;            // YYYY-MM-DD
  last_modified_after?: string;
  last_modified_before?: string;
  last_modified_on_or_after?: string;
  last_modified_on_or_before?: string;
  hierarchy?: {
    title?: string;
    subtitle?: string;
    chapter?: string;
    subchapter?: string;
    part?: string;
    subpart?: string;
    section?: string;
    appendix?: string;
  };
  per_page?: number;        // default 20, max 1000
  page?: number;
  order?: 'relevance' | 'hierarchy' | 'newest' | 'oldest';
}

export class EcfrClient {
  constructor(private readonly http: HttpClient) {}

  admin = {
    agencies: () => this.http.call({ path: '/admin/v1/agencies.json' }),
    corrections: (query?: { date?: string; title?: number; error_corrected_date?: string }) =>
      this.http.call({ path: '/admin/v1/corrections.json', query: flatten(query ?? {}) }),
    corrections_for_title: (title: number, query?: { date?: string }) =>
      this.http.call({ path: `/admin/v1/corrections/title/${title}.json`, query: flatten(query ?? {}) }),
  };

  titles = {
    list: () => this.http.call({ path: '/versioner/v1/titles.json' }),
  };

  structure = (date: string, title: number) =>
    this.http.call({ path: `/versioner/v1/structure/${date}/title-${title}.json` });

  ancestry = (date: string, title: number, query?: Record<string, string | number>) =>
    this.http.call({ path: `/versioner/v1/ancestry/${date}/title-${title}.json`, query });

  versions = (title: number, query?: { issue_date?: { on?: string; lte?: string; gte?: string }; identifier?: string }) =>
    this.http.call({ path: `/versioner/v1/versions/title-${title}.json`, query: flatten(query ?? {}) });

  /** Returns XML as a string. Large for whole titles; prefer structure/ancestry first. */
  full = (date: string, title: number, query?: Record<string, string | number>) =>
    this.http.call<string>({ path: `/versioner/v1/full/${date}/title-${title}.xml`, query, accept: 'xml' });

  search = {
    results: (params: EcfrSearchParams) =>
      this.http.call({ path: '/search/v1/results', query: flatten(params as unknown as Record<string, unknown>) }),
    counts_daily: (params: Pick<EcfrSearchParams, 'query' | 'agency_slugs' | 'hierarchy'>) =>
      this.http.call({ path: '/search/v1/counts/daily', query: flatten(params) }),
    counts_titles: (params: Pick<EcfrSearchParams, 'query' | 'agency_slugs' | 'hierarchy'>) =>
      this.http.call({ path: '/search/v1/counts/titles', query: flatten(params) }),
    counts_hierarchy: (params: Pick<EcfrSearchParams, 'query' | 'agency_slugs' | 'hierarchy'>) =>
      this.http.call({ path: '/search/v1/counts/hierarchy', query: flatten(params) }),
    suggestions: (params: Pick<EcfrSearchParams, 'query'>) =>
      this.http.call({ path: '/search/v1/suggestions', query: flatten(params) }),
  };
}

function flatten(input: Record<string, unknown>): Record<string, string | number | boolean | string[] | undefined> {
  const out: Record<string, string | number | boolean | string[] | undefined> = {};
  function walk(obj: Record<string, unknown>, prefix: string) {
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined || v === null) continue;
      const key = prefix ? `${prefix}[${k}]` : k;
      if (Array.isArray(v)) out[`${key}[]`] = v.map(String);
      else if (typeof v === 'object') walk(v as Record<string, unknown>, key);
      else out[key] = v as string | number | boolean;
    }
  }
  walk(input, '');
  return out;
}
