import { Bm25Index } from './bm25.js';

export interface CorpusEntry {
  id: string;
  kind: 'endpoint' | 'field';
  binding: string;
  description: string;
  example?: string;
  signature?: string;
}

export interface Corpus {
  index: Bm25Index;
  entries: Map<string, CorpusEntry>;
}

export function buildCorpus(sources: Array<{ corpus: { endpoints: CorpusEntry[]; fields: CorpusEntry[] } }>): Corpus {
  const index = new Bm25Index();
  const entries = new Map<string, CorpusEntry>();
  for (const s of sources) {
    for (const e of [...s.corpus.endpoints, ...s.corpus.fields]) {
      entries.set(e.id, e);
      index.add({ id: e.id, text: [e.id, e.description, e.signature ?? '', e.example ?? ''].join(' ') });
    }
  }
  return { index, entries };
}

export function lookupByPathOrPrefix(entries: Map<string, CorpusEntry>, target: { path?: string; prefix?: string }): CorpusEntry[] {
  const all = [...entries.values()];
  if (target.path) {
    const hit = entries.get(target.path);
    return hit ? [hit] : [];
  }
  if (target.prefix) return all.filter(e => e.id.startsWith(target.prefix!));
  return [];
}
