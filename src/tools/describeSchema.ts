import { z } from 'zod';
import { lookupByPathOrPrefix, type CorpusEntry } from '../search/corpus.js';

export const DescribeSchemaInput = z.object({
  path: z.string().optional().describe("Exact dotted id, e.g. 'fr.documents.search' or 'regs.comments.search'"),
  prefix: z.string().optional().describe("Prefix to enumerate, e.g. 'fr.documents' or 'regs.'"),
}).refine(v => Boolean(v.path) !== Boolean(v.prefix), { message: 'Provide exactly one of `path` or `prefix`' });
export type DescribeSchemaInputT = z.infer<typeof DescribeSchemaInput>;

export type DescribeSchemaResult =
  | { found: false; message: string }
  | { found: true; entries: Array<{ id: string; kind: 'endpoint' | 'field'; binding: string; description: string; signature?: string; example?: string }> };

export function describeSchema(input: DescribeSchemaInputT, entries: Map<string, CorpusEntry>): DescribeSchemaResult {
  const hits = lookupByPathOrPrefix(entries, input);
  if (hits.length === 0) {
    return { found: false, message: `No entries matched ${input.path ? `path '${input.path}'` : `prefix '${input.prefix}'`}.` };
  }
  return { found: true, entries: hits.map(e => ({ id: e.id, kind: e.kind, binding: e.binding, description: e.description, signature: e.signature, example: e.example })) };
}
