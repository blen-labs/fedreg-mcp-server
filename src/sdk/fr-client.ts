import { HttpClient } from '../util/httpClient.js';

export interface DocumentSearchConditions {
  term?: string;
  agencies?: string[];
  publication_date?: { is?: string; gte?: string; lte?: string; year?: number };
  effective_date?: { is?: string; gte?: string; lte?: string; year?: number };
  type?: Array<'RULE' | 'PRORULE' | 'NOTICE' | 'PRESDOCU'>;
  topics?: string[];
  significant?: 0 | 1;
  cfr?: { title?: number; part?: number };
  docket_id?: string;
  president?: string;
  presidential_document_type?: string[];
}

export interface DocumentSearchParams {
  conditions?: DocumentSearchConditions;
  fields?: string[];
  per_page?: number;        // max 1000
  page?: number;            // pagination is capped at first 2000 results
  order?: 'relevance' | 'newest' | 'oldest' | 'executive_order_number';
}

export interface FacetsParams {
  conditions?: DocumentSearchConditions;
  facet: 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'yearly' | 'agency' | 'topic' | 'section' | 'subject' | 'type';
}

export interface PIDocumentSearchParams {
  conditions?: {
    available_on?: string;
    agencies?: string[];
    type?: string[];
    special_filing?: 0 | 1;
    docket_id?: string;
  };
  fields?: string[];
  per_page?: number;
  page?: number;
}

export class FederalRegisterClient {
  constructor(private readonly http: HttpClient) {}

  documents = {
    search: (params: DocumentSearchParams = {}) =>
      this.http.call({ path: '/documents.json', query: flattenConditions(params as Record<string, unknown>) }),

    get: (documentNumber: string, fields?: string[]) =>
      this.http.call({
        path: `/documents/${encodeURIComponent(documentNumber)}.json`,
        query: fields ? { 'fields[]': fields } : undefined,
      }),

    getMany: (documentNumbers: string[], fields?: string[]) =>
      this.http.call({
        path: `/documents/${documentNumbers.map(encodeURIComponent).join(',')}.json`,
        query: fields ? { 'fields[]': fields } : undefined,
      }),

    facets: (params: FacetsParams) =>
      this.http.call({
        path: `/documents/facets/${params.facet}`,
        query: flattenConditions({ conditions: params.conditions } as Record<string, unknown>),
      }),
  };

  publicInspection = {
    current: (fields?: string[]) =>
      this.http.call({
        path: '/public-inspection-documents/current.json',
        query: fields ? { 'fields[]': fields } : undefined,
      }),

    search: (params: PIDocumentSearchParams = {}) =>
      this.http.call({ path: '/public-inspection-documents.json', query: flattenConditions(params as Record<string, unknown>) }),

    get: (documentNumber: string, fields?: string[]) =>
      this.http.call({
        path: `/public-inspection-documents/${encodeURIComponent(documentNumber)}.json`,
        query: fields ? { 'fields[]': fields } : undefined,
      }),

    getMany: (documentNumbers: string[], fields?: string[]) =>
      this.http.call({
        path: `/public-inspection-documents/${documentNumbers.map(encodeURIComponent).join(',')}.json`,
        query: fields ? { 'fields[]': fields } : undefined,
      }),
  };

  agencies = {
    list: () => this.http.call({ path: '/agencies' }),
    get: (slug: string) => this.http.call({ path: `/agencies/${encodeURIComponent(slug)}` }),
  };

  issues = {
    get: (publicationDate: string) =>
      this.http.call({ path: `/issues/${encodeURIComponent(publicationDate)}.json` }),
  };

  suggestedSearches = {
    list: (sections?: string) =>
      this.http.call({ path: '/suggested_searches', query: sections ? { sections } : undefined }),
    get: (section: string) =>
      this.http.call({ path: `/suggested_searches/${encodeURIComponent(section)}` }),
  };

  images = {
    get: (identifier: string) =>
      this.http.call({ path: `/images/${encodeURIComponent(identifier)}` }),
  };
}

function flattenConditions(input: Record<string, unknown>): Record<string, string | number | boolean | string[] | undefined> {
  const out: Record<string, string | number | boolean | string[] | undefined> = {};
  function walk(obj: Record<string, unknown>, prefix: string) {
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined || v === null) continue;
      const key = prefix ? `${prefix}[${k}]` : k;
      if (Array.isArray(v)) {
        out[`${key}[]`] = v.map(String);
      } else if (typeof v === 'object') {
        walk(v as Record<string, unknown>, key);
      } else {
        out[key] = v as string | number | boolean;
      }
    }
  }
  walk(input, '');
  // fields[] convention
  if ('fields' in out && Array.isArray(out.fields)) {
    out['fields[]'] = out.fields as string[];
    delete out.fields;
  }
  return out;
}
