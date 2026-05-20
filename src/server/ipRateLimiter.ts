/**
 * Token-bucket IP rate limiter. In-memory; one process.
 */
export class IpRateLimiter {
  private readonly buckets = new Map<string, { tokens: number; updatedAt: number }>();
  constructor(private readonly rps: number, private readonly burst: number) {}

  allow(ip: string): boolean {
    const now = Date.now();
    const b = this.buckets.get(ip) ?? { tokens: this.burst, updatedAt: now };
    const elapsedSec = (now - b.updatedAt) / 1000;
    b.tokens = Math.min(this.burst, b.tokens + elapsedSec * this.rps);
    b.updatedAt = now;
    if (b.tokens < 1) {
      this.buckets.set(ip, b);
      return false;
    }
    b.tokens -= 1;
    this.buckets.set(ip, b);
    return true;
  }
}
