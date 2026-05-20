/**
 * Sandbox-visible type surface for the `fr` and `ecfr` bindings.
 *
 * This file is intentionally minimal — full surface lives in src/sdk/{fr,ecfr}-client.ts.
 * The sandbox supervisor concatenates this with user code so editors/agents get hints.
 */

declare const fr: {
  documents: {
    search(params?: {
      conditions?: {
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
      };
      fields?: string[];
      per_page?: number;
      page?: number;
      order?: 'relevance' | 'newest' | 'oldest' | 'executive_order_number';
    }): Promise<unknown>;
    get(documentNumber: string, fields?: string[]): Promise<unknown>;
    getMany(documentNumbers: string[], fields?: string[]): Promise<unknown>;
    facets(params: {
      facet: 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'yearly' | 'agency' | 'topic' | 'section' | 'subject' | 'type';
      conditions?: Record<string, unknown>;
    }): Promise<unknown>;
  };
  publicInspection: {
    current(fields?: string[]): Promise<unknown>;
    search(params?: Record<string, unknown>): Promise<unknown>;
    get(documentNumber: string, fields?: string[]): Promise<unknown>;
    getMany(documentNumbers: string[], fields?: string[]): Promise<unknown>;
  };
  agencies: {
    list(): Promise<unknown>;
    get(slug: string): Promise<unknown>;
  };
  issues: { get(publicationDate: string): Promise<unknown> };
  suggestedSearches: {
    list(sections?: string): Promise<unknown>;
    get(section: string): Promise<unknown>;
  };
  images: { get(identifier: string): Promise<unknown> };
};

declare const ecfr: {
  admin: {
    agencies(): Promise<unknown>;
    corrections(query?: { date?: string; title?: number; error_corrected_date?: string }): Promise<unknown>;
    corrections_for_title(title: number, query?: { date?: string }): Promise<unknown>;
  };
  titles: { list(): Promise<unknown> };
  structure(date: string, title: number): Promise<unknown>;
  ancestry(date: string, title: number, query?: Record<string, string | number>): Promise<unknown>;
  versions(title: number, query?: Record<string, unknown>): Promise<unknown>;
  full(date: string, title: number, query?: Record<string, string | number>): Promise<string>;
  search: {
    results(params: {
      query: string;
      agency_slugs?: string[];
      date?: string;
      hierarchy?: Record<string, string>;
      per_page?: number;
      page?: number;
      order?: 'relevance' | 'hierarchy' | 'newest' | 'oldest';
    }): Promise<unknown>;
    counts_daily(params: { query: string } & Record<string, unknown>): Promise<unknown>;
    counts_titles(params: { query: string } & Record<string, unknown>): Promise<unknown>;
    counts_hierarchy(params: { query: string } & Record<string, unknown>): Promise<unknown>;
    suggestions(params: { query: string }): Promise<unknown>;
  };
};
