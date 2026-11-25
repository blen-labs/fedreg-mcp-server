import type { IncomingMessage } from 'node:http';
import { isIP, isIPv6 } from 'node:net';
import { LRUCache } from 'lru-cache';

/**
 * Token-bucket IP rate limiter. In-memory; one process.
 */
export class IpRateLimiter {
  private readonly buckets: LRUCache<string, { tokens: number; updatedAt: number }>;
  constructor(private readonly rps: number, private readonly burst: number) {
    // An idle bucket refills to `burst` within burst/rps seconds; after that it is
    // indistinguishable from a new one, so it can be dropped. Bounded so a flood of
    // distinct addresses cannot grow memory without limit.
    // Clamped to a finite integer: lru-cache throws on a non-integer or infinite ttl, which
    // rps = 0 or an extreme burst/rps ratio would otherwise produce.
    const refillMs = Math.ceil((burst / rps) * 1000);
    const ttl = Number.isFinite(refillMs) ? Math.min(Math.max(refillMs, 1000), Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER;
    this.buckets = new LRUCache({ max: 50_000, ttl });
  }

  /** Spends a token; false when the address is out of them. */
  allow(ip: string): boolean {
    const key = bucketKey(ip);
    const b = this.refilled(key);
    const allowed = b.tokens >= 1;
    if (allowed) b.tokens -= 1;
    this.buckets.set(key, b);
    return allowed;
  }

  /** True when the address has a token left; spends nothing. */
  available(ip: string): boolean {
    return this.refilled(bucketKey(ip)).tokens >= 1;
  }

  /** Spends a token even when none is left (the balance floors at zero). */
  spend(ip: string): void {
    const key = bucketKey(ip);
    const b = this.refilled(key);
    b.tokens = Math.max(0, b.tokens - 1);
    this.buckets.set(key, b);
  }

  private refilled(key: string) {
    const now = Date.now();
    const b = this.buckets.get(key) ?? { tokens: this.burst, updatedAt: now };
    b.tokens = Math.min(this.burst, b.tokens + ((now - b.updatedAt) / 1000) * this.rps);
    b.updatedAt = now;
    return b;
  }
}

/**
 * The caller's address. Without `trustedHeader` it is the TCP peer. Behind a reverse proxy
 * the peer is the proxy (on Railway, a different internal 100.64.x.x address per
 * connection), so name the header the proxy sets to the client address and that header is
 * used instead. Only name a header the proxy always overwrites: a client could otherwise
 * forge it. Railway overwrites `x-real-ip` (verified 2026-10-13; it also rebuilds
 * X-Forwarded-For as "<client>, <edge>", so that header's rightmost entry is NOT the client).
 * For a list-valued header the rightmost entry, the one the nearest proxy added, is used.
 */
export function clientIp(req: IncomingMessage & { ip?: string }, trustedHeader?: string): string {
  const peer = normalize(req.ip ?? req.socket.remoteAddress ?? 'unknown');
  if (!trustedHeader) return peer;
  const value = req.headers[trustedHeader.toLowerCase()];
  const entries = (Array.isArray(value) ? value.join(',') : value ?? '')
    .split(',').map(s => s.trim()).filter(Boolean);
  const candidate = entries[entries.length - 1];
  // Only a literal address becomes a bucket key; anything else is not a client address.
  return candidate && isIP(normalize(candidate)) ? normalize(candidate) : peer;
}

/** The 8 groups of an IPv6 address (a dotted IPv4 tail counts as two), or undefined if it is not one. */
function ipv6Groups(ip: string): number[] | undefined {
  ip = ip.replace(/%.*$/, '');
  if (!isIPv6(ip)) return undefined;
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number) as [number, number, number, number];
    ip = `${ip.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = '', tail] = ip.split('::');
  const first = head ? head.split(':') : [];
  const rest = tail === undefined ? [] : tail ? tail.split(':') : [];
  const missing = 8 - first.length - rest.length;
  if (tail === undefined ? missing !== 0 : missing < 1) return undefined;
  const groups = [...first, ...Array<string>(tail === undefined ? 0 : missing).fill('0'), ...rest].map(g => parseInt(g, 16));
  return groups.length === 8 && groups.every(g => g >= 0 && g <= 0xffff) ? groups : undefined;
}

/** An IPv4-mapped address (::ffff:0:0/96, in any spelling) is the IPv4 client; anything else is returned as is. */
function normalize(ip: string): string {
  const g = ipv6Groups(ip);
  if (g && g.slice(0, 5).every(x => x === 0) && g[5] === 0xffff)
    return `${g[6]! >> 8}.${g[6]! & 255}.${g[7]! >> 8}.${g[7]! & 255}`;
  return ip;
}

/**
 * The bucket an address is counted in. An IPv6 customer controls a whole /64 (usually far
 * more), so counting single addresses would let one host mint endless fresh buckets. IPv4 (and
 * IPv4-mapped IPv6, in any spelling) is counted per address.
 */
export function bucketKey(ip: string): string {
  ip = normalize(ip);
  const g = ipv6Groups(ip);
  if (!g) return ip;
  return `${g.slice(0, 4).map(x => x.toString(16)).join(':')}::/64`;
}
