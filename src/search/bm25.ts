/**
 * Tiny BM25 implementation. No external deps.
 */
export interface Doc {
  id: string;
  text: string;
}

export interface ScoredDoc {
  id: string;
  score: number;
}

const STOP = new Set([
  'a','an','and','are','as','at','be','by','for','from','has','have','i','in','is','it','its','of','on','or','that',
  'the','to','was','were','will','with','this','these','those','if','then','than','so','do','does','can','should'
]);

export function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9_\s-]/g, ' ')
    .split(/\s+/)
    .filter(t => t && t.length > 1 && !STOP.has(t));
}

export class Bm25Index {
  private readonly docs: Map<string, Doc> = new Map();
  private readonly tokens: Map<string, string[]> = new Map(); // doc id -> tokens
  private readonly df: Map<string, number> = new Map();       // term -> doc freq
  private avgdl = 0;
  private N = 0;
  private k1 = 1.5;
  private b = 0.75;

  add(doc: Doc): void {
    const toks = tokenize(doc.text);
    this.docs.set(doc.id, doc);
    this.tokens.set(doc.id, toks);
    const seen = new Set<string>();
    for (const t of toks) {
      if (seen.has(t)) continue;
      seen.add(t);
      this.df.set(t, (this.df.get(t) ?? 0) + 1);
    }
    this.N = this.docs.size;
    let total = 0;
    for (const v of this.tokens.values()) total += v.length;
    this.avgdl = total / Math.max(this.N, 1);
  }

  search(query: string, k = 10): ScoredDoc[] {
    const qt = tokenize(query);
    if (qt.length === 0) return [];
    const results: ScoredDoc[] = [];
    for (const [id, toks] of this.tokens) {
      let score = 0;
      const dl = toks.length;
      const tf: Map<string, number> = new Map();
      for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const term of qt) {
        const f = tf.get(term);
        if (!f) continue;
        const n = this.df.get(term) ?? 0;
        const idf = Math.log((this.N - n + 0.5) / (n + 0.5) + 1);
        const denom = f + this.k1 * (1 - this.b + this.b * (dl / Math.max(this.avgdl, 1)));
        score += idf * ((f * (this.k1 + 1)) / denom);
      }
      if (score > 0) results.push({ id, score });
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, k);
  }

  get(id: string): Doc | undefined {
    return this.docs.get(id);
  }
}
