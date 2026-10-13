/**
 * Shared admission control for one upstream API: at most `concurrency` requests in flight,
 * started no faster than `ratePerSec` (bursting to `burst`). Every user's calls leave from
 * the same server IP, so this is the server's whole footprint on that API. Callers wait
 * for a slot instead of failing, but never longer than `maxWaitMs`; a 429 pauses new
 * starts so concurrent callers back off together.
 */
export class UpstreamGate {
  private active = 0;
  private tokens: number;
  private updatedAt = Date.now();
  private pausedUntil = 0;
  private readonly queue: Array<{ resolve: (release: () => void) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }> = [];
  private wake?: NodeJS.Timeout;

  constructor(
    private readonly opts: { concurrency: number; ratePerSec: number; burst: number; maxWaitMs: number },
  ) {
    this.tokens = opts.burst;
  }

  /** Resolves with a release function once the request may start. */
  acquire(): Promise<() => void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.queue.findIndex(w => w.timer === timer);
        if (i >= 0) this.queue.splice(i, 1);
        reject(new Error(`waited ${this.opts.maxWaitMs}ms for an upstream slot`));
      }, this.opts.maxWaitMs);
      timer.unref?.();
      this.queue.push({ resolve, reject, timer });
      this.drain();
    });
  }

  /** Stop starting requests for `ms` (an upstream 429 asked us to slow down). */
  pause(ms: number): void {
    this.pausedUntil = Math.max(this.pausedUntil, Date.now() + ms);
    // Resume at the steady rate: no burst accrues while paused, so the pause does not
    // end with `concurrency` requests hitting the API that just throttled us.
    this.tokens = Math.min(this.tokens, 1);
    this.updatedAt = Math.max(this.updatedAt, this.pausedUntil);
    this.drain();
  }

  private drain(): void {
    while (this.queue.length && this.active < this.opts.concurrency) {
      const now = Date.now();
      // updatedAt sits in the future during a pause; accrue nothing until it passes.
      if (now > this.updatedAt) {
        this.tokens = Math.min(this.opts.burst, this.tokens + ((now - this.updatedAt) / 1000) * this.opts.ratePerSec);
        this.updatedAt = now;
      }
      const waitMs = Math.max(
        this.pausedUntil - now,
        this.tokens >= 1 ? 0 : ((1 - this.tokens) / this.opts.ratePerSec) * 1000,
      );
      if (waitMs > 0) {
        if (!this.wake) {
          this.wake = setTimeout(() => { this.wake = undefined; this.drain(); }, Math.ceil(waitMs));
          this.wake.unref?.();
        }
        return;
      }
      this.tokens -= 1;
      this.active++;
      const waiter = this.queue.shift()!;
      clearTimeout(waiter.timer);
      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
        this.active--;
        this.drain();
      });
    }
  }
}
