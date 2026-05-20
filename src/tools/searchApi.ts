import { z } from 'zod';
import { getCorpus } from '../search/corpus.js';

export const SearchApiInput = z.object({
  query: z.string().min(1).describe('Free-text query over endpoint and field documentation for fr.* and ecfr.*'),
  k: z.number().int().min(1).max(50).default(10).describe('Max number of results to return'),
});

export type SearchApiInputT = z.infer<typeof SearchApiInput>;

export interface SearchHit {
  id: string;
  kind: 'endpoint' | 'field';
  binding: 'fr' | 'ecfr';
  description: string;
  signature?: string;
  example?: string;
  score: number;
}

export function searchApi(input: SearchApiInputT): { hits: SearchHit[]; note: string } {
  const { index, entries } = getCorpus();
  const scored = index.search(input.query, input.k);
  const hits: SearchHit[] = scored.map(s => {
    const e = entries.get(s.id)!;
    return {
      id: e.id,
      kind: e.kind,
      binding: e.binding,
      description: e.description,
      signature: e.signature,
      example: e.example,
      score: Math.round(s.score * 1000) / 1000,
    };
  });
  return {
    hits,
    note: 'Use describe_schema with `path` for exact lookup or `prefix` to explore a namespace. Use execute to run TypeScript against the fr.* and ecfr.* bindings.',
  };
}
