import { LRUCache } from 'lru-cache';

const DAY_MS = 24 * 60 * 60 * 1000;

export class SubjectQuota {
  private readonly counts: LRUCache<string, { count: number; resetAt: number }>;
  constructor(private readonly limit: number, private readonly windowMs: number = DAY_MS) {
    this.counts = new LRUCache({ max: 10_000, ttl: windowMs });
  }

  /** Returns whether the subject may make one more request in the current window. */
  consume(subject: string): { allowed: boolean; remaining: number; resetAt: number } {
    const now = Date.now();
    const rec = this.counts.get(subject);
    if (!rec || rec.resetAt < now) {
      const resetAt = now + this.windowMs;
      this.counts.set(subject, { count: 1, resetAt });
      return { allowed: true, remaining: this.limit - 1, resetAt };
    }
    if (rec.count >= this.limit) {
      return { allowed: false, remaining: 0, resetAt: rec.resetAt };
    }
    rec.count++;
    this.counts.set(subject, rec);
    return { allowed: true, remaining: this.limit - rec.count, resetAt: rec.resetAt };
  }
}
