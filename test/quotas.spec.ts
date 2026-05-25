import { describe, it, expect } from 'vitest';
import { SubjectQuota } from '../src/util/quotas.js';

describe('SubjectQuota', () => {
  it('allows up to the limit then blocks within the window', () => {
    const q = new SubjectQuota(2, 60_000);
    expect(q.consume('s1').allowed).toBe(true);
    expect(q.consume('s1').allowed).toBe(true);
    expect(q.consume('s1').allowed).toBe(false);
  });
  it('tracks subjects independently', () => {
    const q = new SubjectQuota(1, 60_000);
    expect(q.consume('a').allowed).toBe(true);
    expect(q.consume('b').allowed).toBe(true);
    expect(q.consume('a').allowed).toBe(false);
  });
});
