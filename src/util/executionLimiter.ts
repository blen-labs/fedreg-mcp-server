/**
 * Caps simultaneous executions, globally and per subject. Over the cap a caller fails fast with
 * a clear error instead of queueing: an execution can run for up to two minutes, and a queue would
 * only hide overload until clients time out.
 */
export class ExecutionLimiter {
  private active = 0;
  private readonly perSubject = new Map<string, number>();

  constructor(private readonly maxGlobal: number, private readonly maxPerSubject: number) {}

  /** A release function, or an error message when over a cap. */
  tryAcquire(subject?: string): { release: () => void } | { error: string } {
    if (this.active >= this.maxGlobal) return { error: `This server is running its maximum of ${this.maxGlobal} executions. Retry shortly.` };
    const key = subject ?? '';
    const mine = this.perSubject.get(key) ?? 0;
    if (subject && mine >= this.maxPerSubject) return { error: `You already have ${this.maxPerSubject} executions running. Wait for one to finish.` };
    this.active++;
    this.perSubject.set(key, mine + 1);
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.active--;
        const n = (this.perSubject.get(key) ?? 1) - 1;
        if (n <= 0) this.perSubject.delete(key); else this.perSubject.set(key, n);
      },
    };
  }
}
