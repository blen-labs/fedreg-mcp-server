import { HttpClient } from '../util/httpClient.js';

export type RegsRange = { ge?: string; le?: string };
export interface RegsListParams {
  filter?: Record<string, string | number | boolean | RegsRange | undefined>;
  sort?: string;
  page?: { number?: number; size?: number };
}
export interface RegsGetOptions { include?: 'attachments'; }

export function toJsonApiQuery(params: RegsListParams): Record<string, string | number | boolean | undefined> {
  const out: Record<string, string | number | boolean | undefined> = {};
  if (params.filter) {
    for (const [k, v] of Object.entries(params.filter)) {
      if (v === undefined || v === null) continue;
      if (typeof v === 'object') {
        if (v.ge !== undefined) out[`filter[${k}][ge]`] = v.ge;
        if (v.le !== undefined) out[`filter[${k}][le]`] = v.le;
      } else {
        out[`filter[${k}]`] = v;
      }
    }
  }
  if (params.sort) out['sort'] = params.sort;
  if (params.page?.number !== undefined) out['page[number]'] = params.page.number;
  if (params.page?.size !== undefined) out['page[size]'] = params.page.size;
  return out;
}

export class RegulationsClient {
  constructor(private readonly http: HttpClient) {}

  documents = {
    search: (params: RegsListParams = {}) => this.http.call({ path: '/v4/documents', query: toJsonApiQuery(params) }),
    get: (id: string, opts?: RegsGetOptions) =>
      this.http.call({ path: `/v4/documents/${encodeURIComponent(id)}`, query: opts?.include ? { include: opts.include } : undefined }),
  };

  comments = {
    search: (params: RegsListParams = {}) => this.http.call({ path: '/v4/comments', query: toJsonApiQuery(params) }),
    get: (id: string, opts?: RegsGetOptions) =>
      this.http.call({ path: `/v4/comments/${encodeURIComponent(id)}`, query: opts?.include ? { include: opts.include } : undefined }),
  };

  dockets = {
    search: (params: RegsListParams = {}) => this.http.call({ path: '/v4/dockets', query: toJsonApiQuery(params) }),
    get: (id: string) => this.http.call({ path: `/v4/dockets/${encodeURIComponent(id)}` }),
  };
}
