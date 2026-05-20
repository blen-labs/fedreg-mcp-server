import { LRUCache } from 'lru-cache';

export class SubjectQuota {
  private readonly counts: LRUCache<string, { count: number; resetAt: number }>;
  constructor(private readonly perDay: number) {
    this.counts = new LRUCache({ max: 10_000, ttl: 24 * 60 * 60 * 1000 });
  }

  /** Returns true if the subject is allowed to make one more request. */
  consume(subject: string): { allowed: boolean; remaining: number; resetAt: number } {
    const now = Date.now();
    const rec = this.counts.get(subject);
    if (!rec || rec.resetAt < now) {
      const resetAt = now + 24 * 60 * 60 * 1000;
      this.counts.set(subject, { count: 1, resetAt });
      return { allowed: true, remaining: this.perDay - 1, resetAt };
    }
    if (rec.count >= this.perDay) {
      return { allowed: false, remaining: 0, resetAt: rec.resetAt };
    }
    rec.count++;
    this.counts.set(subject, rec);
    return { allowed: true, remaining: this.perDay - rec.count, resetAt: rec.resetAt };
  }
}
