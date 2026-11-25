import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';
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

/**
 * The bucket an address is counted in. An IPv6 customer controls a whole /64 (and usually far
 * more), so counting single addresses would let one host mint endless fresh buckets. IPv4-mapped
 * IPv6 addresses count as the IPv4 address.
 */
export function bucketKey(ip: string): string {
  ip = normalize(ip);
  if (!ip.includes(':')) return ip;
  const [head = '', tail, extra] = ip.split('::');
  if (extra !== undefined) return ip;
  const groups = head ? head.split(':') : [];
  if (tail !== undefined) {
    const rest = tail ? tail.split(':') : [];
    while (groups.length + rest.length < 8) groups.push('0');
    groups.push(...rest);
  }
  if (groups.length !== 8) return ip;
  return `${groups.slice(0, 4).map(g => g.toLowerCase().replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

/** Drops a zone id and unwraps IPv4-mapped IPv6 (`::ffff:1.2.3.4` and `::ffff:102:304`). */
function normalize(ip: string): string {
  ip = ip.replace(/%.*$/, '');
  const dotted = /^(?:0{0,4}:){0,5}ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (dotted) return dotted[1]!;
  const hex = /^(?:0{0,4}:){0,5}ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(ip);
  if (hex) {
    const hi = parseInt(hex[1]!, 16), lo = parseInt(hex[2]!, 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return ip;
}
