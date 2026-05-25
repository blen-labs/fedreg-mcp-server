import { Bm25Index } from './bm25.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface CorpusEntry {
  id: string;          // e.g. 'fr.documents.search' or 'fr.documents.publication_date'
  kind: 'endpoint' | 'field';
  binding: string;     // source name: 'fr' | 'ecfr' | 'regs' | …
  description: string;
  example?: string;
  signature?: string;
}

export interface FieldDictionary {
  endpoints: CorpusEntry[];
  fields: CorpusEntry[];
}

let cached: { index: Bm25Index; entries: Map<string, CorpusEntry> } | null = null;

export function getCorpus(): { index: Bm25Index; entries: Map<string, CorpusEntry> } {
  if (cached) return cached;
  const index = new Bm25Index();
  const entries = new Map<string, CorpusEntry>();
  const sourceFiles = ['fr', 'ecfr'];
  const merged: CorpusEntry[] = [];
  for (const name of sourceFiles) {
    const path = resolve(__dirname, `../../schema/${name}.json`);
    const raw = JSON.parse(readFileSync(path, 'utf8')) as FieldDictionary;
    merged.push(...raw.endpoints, ...raw.fields);
  }
  for (const e of merged) {
    entries.set(e.id, e);
    index.add({
      id: e.id,
      text: [e.id, e.description, e.signature ?? '', e.example ?? ''].join(' '),
    });
  }
  cached = { index, entries };
  return cached;
}

export function lookupByPathOrPrefix(target: { path?: string; prefix?: string }): CorpusEntry[] {
  const { entries } = getCorpus();
  const all = [...entries.values()];
  if (target.path) {
    const hit = entries.get(target.path);
    return hit ? [hit] : [];
  }
  if (target.prefix) {
    return all.filter(e => e.id.startsWith(target.prefix!));
  }
  return [];
}
