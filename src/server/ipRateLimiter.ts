import type { IncomingMessage } from 'node:http';
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

/**
 * The caller's address. Without `trustedHeader` it is the TCP peer. Behind a reverse proxy
 * the peer is the proxy (on Railway, a different internal 100.64.x.x address per
 * connection), so name the header the proxy sets to the client address and that header is
 * used instead. Only name a header the proxy always overwrites: a client could otherwise
 * forge it. Railway overwrites `x-real-ip` (verified 2026-10-13; it also rebuilds
 * X-Forwarded-For as "<client>, <edge>", so that header's rightmost entry is NOT the client).
 * For a list-valued header the rightmost entry, the one the nearest proxy added, is used.
 */
export function clientIp(req: IncomingMessage, trustedHeader?: string): string {
  const peer = normalize(req.socket.remoteAddress ?? 'unknown');
  if (!trustedHeader) return peer;
  const value = req.headers[trustedHeader.toLowerCase()];
  const entries = (Array.isArray(value) ? value.join(',') : value ?? '')
    .split(',').map(s => s.trim()).filter(Boolean);
  const candidate = entries[entries.length - 1];
  return candidate ? normalize(candidate) : peer;
}

function normalize(ip: string): string {
  return ip.replace(/^::ffff:/, '');
}
