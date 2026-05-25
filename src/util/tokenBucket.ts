/** In-memory token bucket. One instance = one shared limit (e.g. process-wide regs quota). */
export class TokenBucket {
  private tokens: number;
  private updatedAt: number;
  constructor(private readonly ratePerSec: number, private readonly burst: number) {
    this.tokens = burst;
    this.updatedAt = Date.now();
  }
  tryTake(): boolean {
    const now = Date.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.updatedAt) / 1000) * this.ratePerSec);
    this.updatedAt = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
  secondsUntilNext(): number {
    if (this.tokens >= 1) return 0;
    if (this.ratePerSec <= 0) return Infinity;
    return Math.ceil((1 - this.tokens) / this.ratePerSec);
  }
}
