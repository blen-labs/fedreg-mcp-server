import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { digest } from './crypto.js';
import { DigestGate } from './digest-gate.js';

/** Lifetime of an access token; Better Auth's `accessTokenExpiresIn` and the admission bound both use it. */
export const ACCESS_TOKEN_LIFETIME_SECONDS = 900;
/** Tolerated clock difference between replicas. It widens only the cheap rejection bound, never authorization. */
export const ACCESS_TOKEN_SKEW_SECONDS = 60;
/** Marks tokens that carry an issuer MAC; anything else is a legacy token (release 1 only). */
export const ACCESS_TOKEN_PREFIX = 'at1.';

const VERSION = 'at1';
/** Waiters per unknown digest: a cold replica refuses the excess of a larger first-use burst with 429. */
const MAX_WAITERS_PER_DIGEST = 256;
/** Concurrent database checks for a digest that recently validated; an unknown digest has one. */
const MAX_CONCURRENT_VALIDATED = 16;
const KEY_ID = 'a';
const RANDOM_BYTES = 24;
const MAC_BYTES = 16;
const MAX_LENGTH = 128;
const BASE36 = /^(?:0|[1-9a-z][0-9a-z]*)$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export interface ParsedAccessToken {
  /** Issue time, seconds since the epoch. */
  iat: number;
  /** Last second (epoch) at which the token is worth a database lookup: iat + lifetime + skew. */
  deadline: number;
}

/**
 * `at1.<kid>.<iat base36>.<24 random bytes>.<16-byte MAC>` (base64url). The MAC proves this server issued the
 * token, so a made-up value is rejected without a database round trip. It authenticates only issuance: the
 * database row stays the sole authority for expiry, revocation, client, user and key access.
 */
export class AccessTokenFormat {
  private readonly keys = new Map<string, Buffer>();
  constructor(
    secret: string,
    private readonly lifetimeSeconds = ACCESS_TOKEN_LIFETIME_SECONDS,
    private readonly skewSeconds = ACCESS_TOKEN_SKEW_SECONDS,
    private readonly now = () => Date.now(),
  ) {
    // One MAC key per kid; a later key ring adds entries here and verifies old and new side by side.
    this.keys.set(
      KEY_ID,
      Buffer.from(hkdfSync('sha256', secret, '', `fedreg-access-token-mac/${KEY_ID}`, 32)),
    );
  }

  generate(): string {
    const iat = Math.floor(this.now() / 1000).toString(36);
    const body = `${VERSION}.${KEY_ID}.${iat}.${randomBytes(RANDOM_BYTES).toString('base64url')}`;
    return `${body}.${this.mac(KEY_ID, body)!.toString('base64url')}`;
  }

  /** The parsed token, or undefined when the shape, key id or MAC is wrong. Strict and constant-time on the MAC. */
  parse(value: string): ParsedAccessToken | undefined {
    if (value.length > MAX_LENGTH) return undefined;
    const parts = value.split('.');
    if (parts.length !== 5) return undefined;
    const [version, kid, iatText, random, tag] = parts as [string, string, string, string, string];
    if (version !== VERSION || !this.keys.has(kid) || !BASE36.test(iatText) || iatText.length > 9)
      return undefined;
    if (!canonical(random, RANDOM_BYTES) || !canonical(tag, MAC_BYTES)) return undefined;
    const expected = this.mac(kid, parts.slice(0, 4).join('.'));
    const actual = Buffer.from(tag, 'base64url');
    if (!expected || !timingSafeEqual(expected, actual)) return undefined;
    const iat = parseInt(iatText, 36);
    return { iat, deadline: iat + this.lifetimeSeconds + this.skewSeconds };
  }

  private mac(kid: string, body: string) {
    const key = this.keys.get(kid);
    return key && createHmac('sha256', key).update(body).digest().subarray(0, MAC_BYTES);
  }
}

/** Base64url text that decodes to exactly `bytes` bytes and re-encodes to the same text. */
function canonical(text: string, bytes: number) {
  return BASE64URL.test(text) && Buffer.from(text, 'base64url').length === bytes && reencodes(text);
}
const reencodes = (text: string) => Buffer.from(text, 'base64url').toString('base64url') === text;

/** In-flight counters per key, capped; `take` refuses at the cap and every successful take is paired with a release. */
export class Slots {
  private readonly held = new Map<string, number>();
  constructor(private readonly cap: number) {}
  take(key: string): boolean {
    const held = this.held.get(key) ?? 0;
    if (held >= this.cap) return false;
    this.held.set(key, held + 1);
    return true;
  }
  release(key: string): void {
    const left = (this.held.get(key) ?? 1) - 1;
    if (left > 0) this.held.set(key, left);
    else this.held.delete(key);
  }
  get size() {
    return this.held.size;
  }
}

export type Admission =
  | { kind: 'invalid' }
  | { kind: 'busy' }
  /**
   * The request runs its own database check, then calls `release` in a `finally`: `reject()` when the check
   * completed and refused the token, `validated()` when it authorized it.
   */
  | { kind: 'lookup'; reject(): void; validated(): void; release(): void };

/** Digest -> fixed expiry (ms), bounded and least-recently-used first. A hit refreshes recency, never the expiry. */
class ExpiringSet {
  private readonly entries = new Map<string, number>();
  constructor(private readonly maxEntries: number) {}
  has(key: string, now: number) {
    const expires = this.entries.get(key);
    if (expires === undefined) return false;
    this.entries.delete(key);
    if (expires <= now) return false;
    this.entries.set(key, expires);
    return true;
  }
  /** Adds an entry. An existing unexpired entry keeps its deadline (the expiry is fixed, never renewed). */
  add(key: string, expires: number, now: number) {
    const existing = this.entries.get(key);
    this.entries.delete(key);
    this.entries.set(key, existing !== undefined && existing > now ? existing : expires);
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= this.maxEntries) break;
      this.entries.delete(oldest);
    }
  }
  /** Sets an entry, replacing any expiry (for routing hints that are renewed by use). */
  set(key: string, expires: number) {
    this.entries.delete(key);
    this.add(key, expires, 0);
  }
  delete(key: string) {
    this.entries.delete(key);
  }
  get size() {
    return this.entries.size;
  }
}

/**
 * Admission of MAC-valid tokens before the database is touched. Parsing and the maximum-age bound cost nothing.
 * Two bounded caches, both capped at the admission deadline and neither extended by hits:
 * - negative: digests whose completed database check rejected them (answered 401 with no lookup), with a fixed
 *   expiry that nothing renews;
 * - recently validated: digests whose own database check succeeded; each such success renews the marker. Only a
 *   routing hint, never an authorization result: every request still runs its own database check.
 * Per digest and replica, one check runs at a time for an unknown digest and at most 16 for a recently validated
 * one, so a replayed token cannot take the shared in-flight allowance. Further requests queue FIFO (bounded per
 * digest and overall, holding no shared slot), then re-check from the top: a rejected digest answers 401 and a
 * validated one lets them through, each running its own check.
 */
export class TokenAdmission {
  private readonly rejected: ExpiringSet;
  private readonly validated: ExpiringSet;
  private readonly gate: DigestGate;
  constructor(
    private readonly format: AccessTokenFormat,
    private readonly options: {
      now?: () => number;
      maxEntries?: number;
      ttlMs?: number;
      maxWaiters?: number;
      maxTotalWaiters?: number;
      maxConcurrentValidated?: number;
    } = {},
  ) {
    this.rejected = new ExpiringSet(options.maxEntries ?? 10_000);
    this.validated = new ExpiringSet(options.maxEntries ?? 10_000);
    this.gate = new DigestGate(
      (key) =>
        this.validated.has(key, this.now())
          ? (options.maxConcurrentValidated ?? MAX_CONCURRENT_VALIDATED)
          : 1,
      options.maxWaiters ?? MAX_WAITERS_PER_DIGEST,
      options.maxTotalWaiters ?? 4096,
    );
  }

  private now() {
    return (this.options.now ?? Date.now)();
  }

  async admit(value: string): Promise<Admission> {
    const parsed = this.format.parse(value);
    if (!parsed || this.now() >= parsed.deadline * 1000) return { kind: 'invalid' };
    const key = digest(value);
    if (this.rejected.has(key, this.now())) return { kind: 'invalid' };
    const outcome = await this.gate.acquire(key);
    if (outcome === 'busy') return { kind: 'busy' };
    if (outcome === 'settled') return { kind: 'invalid' };
    // Holding a permit (possibly after waiting). A terminal state found now settles everyone still queued.
    if (this.now() >= parsed.deadline * 1000 || this.rejected.has(key, this.now())) {
      this.gate.release(key, true);
      return { kind: 'invalid' };
    }
    return this.ticket(key, parsed);
  }

  get rejectedSize() {
    return this.rejected.size;
  }
  get validatedSize() {
    return this.validated.size;
  }
  /** Digests with a check running or a request queued, and requests queued in all. */
  get activeDigests() {
    return this.gate.digests;
  }
  get queuedRequests() {
    return this.gate.queued;
  }

  private ticket(key: string, parsed: ParsedAccessToken): Admission {
    // Fixed expiry, measured against the admission deadline (never the database expiry), so it cannot
    // collapse to zero while the token is still admissible.
    const expiry = () =>
      Math.min(this.now() + (this.options.ttlMs ?? 60_000), parsed.deadline * 1000);
    let released = false;
    return {
      kind: 'lookup',
      reject: () => {
        this.validated.delete(key);
        const expires = expiry();
        if (expires > this.now()) this.rejected.add(key, expires, this.now());
        // A completed rejection is terminal for everything queued behind it.
        this.gate.settle(key);
      },
      validated: () => {
        const expires = expiry();
        // Each own successful check renews the marker (it only routes; the negative cache stays fixed). A stale
        // success after a rejection must not bring it back.
        if (expires > this.now() && !this.rejected.has(key, this.now()))
          this.validated.set(key, expires);
      },
      release: () => {
        if (released) return;
        released = true;
        // Past the admission deadline no queued request can be admitted either: settle them all.
        this.gate.release(key, this.now() >= parsed.deadline * 1000);
      },
    };
  }
}
