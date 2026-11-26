type Outcome = 'granted' | 'busy' | 'settled';
interface Entry {
  running: number;
  queue: Array<(outcome: 'granted' | 'settled') => void>;
}

/**
 * A counting semaphore per key with direct handoff. A permit is taken at once only when one is free and nobody is
 * queued; otherwise the caller queues (bounded per key and overall) and is granted a permit strictly in arrival
 * order. `release` passes a freed permit straight to the oldest waiter. A terminal outcome (`settle`, or
 * `release(key, true)`) answers the whole queue 'settled' at once, so nothing is ever stranded, and returns every
 * queue credit; an entry is deleted as soon as it holds no permit and no waiter.
 */
export class DigestGate {
  private readonly entries = new Map<string, Entry>();
  private waiting = 0;
  constructor(
    /** Permits currently allowed for a key; read at every release, so it may rise while requests wait. */
    private readonly limit: (key: string) => number,
    private readonly maxWaiters: number,
    private readonly maxTotalWaiters: number,
  ) {}

  acquire(key: string): Promise<Outcome> {
    const entry = this.entries.get(key) ?? { running: 0, queue: [] };
    if (entry.running < this.limit(key) && entry.queue.length === 0) {
      entry.running++;
      this.entries.set(key, entry);
      return Promise.resolve('granted');
    }
    if (entry.queue.length >= this.maxWaiters || this.waiting >= this.maxTotalWaiters)
      return Promise.resolve('busy');
    this.waiting++;
    return new Promise((resolve) => entry.queue.push(resolve));
  }

  /** Returns a permit. With `settled`, the digest reached a terminal outcome: the queue is answered 'settled'. */
  release(key: string, settled = false) {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.running--;
    if (settled) this.drain(entry, 'settled');
    else
      while (entry.queue.length > 0 && entry.running < this.limit(key)) {
        entry.running++;
        this.waiting--;
        entry.queue.shift()!('granted');
      }
    this.prune(key, entry);
  }

  /** Answers every queued request 'settled' (permits already held stay with their holders). */
  settle(key: string) {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.drain(entry, 'settled');
    this.prune(key, entry);
  }

  get digests() {
    return this.entries.size;
  }
  get queued() {
    return this.waiting;
  }

  private drain(entry: Entry, outcome: 'settled') {
    this.waiting -= entry.queue.length;
    for (const waiter of entry.queue.splice(0)) waiter(outcome);
  }
  private prune(key: string, entry: Entry) {
    if (entry.running === 0 && entry.queue.length === 0) this.entries.delete(key);
  }
}
