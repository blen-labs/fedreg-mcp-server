import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { CorpusEntry } from '../../search/corpus.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function loadSourceCorpus(name: string): { endpoints: CorpusEntry[]; fields: CorpusEntry[] } {
  const path = resolve(__dirname, `../../../schema/${name}.json`);
  return JSON.parse(readFileSync(path, 'utf8')) as { endpoints: CorpusEntry[]; fields: CorpusEntry[] };
}
