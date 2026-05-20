import { describe, it, expect } from 'vitest';
import { IpRateLimiter } from '../src/server/ipRateLimiter.js';
import { SubjectQuota } from '../src/util/quotas.js';

describe('IpRateLimiter', () => {
  it('allows up to burst then denies', () => {
    const lim = new IpRateLimiter(1, 3);
    expect(lim.allow('1.2.3.4')).toBe(true);
    expect(lim.allow('1.2.3.4')).toBe(true);
    expect(lim.allow('1.2.3.4')).toBe(true);
    expect(lim.allow('1.2.3.4')).toBe(false);
  });
});

describe('SubjectQuota', () => {
  it('enforces a daily cap', () => {
    const q = new SubjectQuota(2);
    expect(q.consume('user').allowed).toBe(true);
    expect(q.consume('user').allowed).toBe(true);
    expect(q.consume('user').allowed).toBe(false);
  });
});
