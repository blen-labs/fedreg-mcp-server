import { describe, it, expect } from 'vitest';
import { TokenBucket } from '../src/util/tokenBucket.js';

describe('TokenBucket', () => {
  it('allows up to burst then blocks', () => {
    const b = new TokenBucket(0, 2); // no refill, burst 2
    expect(b.tryTake()).toBe(true);
    expect(b.tryTake()).toBe(true);
    expect(b.tryTake()).toBe(false);
  });
  it('reports seconds until next token when empty', () => {
    const b = new TokenBucket(1, 1); // 1 token/sec
    expect(b.tryTake()).toBe(true);
    expect(b.tryTake()).toBe(false);
    expect(b.secondsUntilNext()).toBeGreaterThan(0);
  });
});
