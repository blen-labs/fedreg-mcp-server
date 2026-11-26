import { test } from 'vitest';
import { createHmac, hkdfSync } from 'node:crypto';
import assert from 'node:assert/strict';
import {
  AccessTokenFormat,
  ACCESS_TOKEN_LIFETIME_SECONDS as LIFETIME,
  ACCESS_TOKEN_SKEW_SECONDS as SKEW,
  Slots,
  TokenAdmission,
} from '../src/accounts/token-admission.js';

const SECRET = 'a'.repeat(40);
let clock = 1_800_000_000_000;
const now = () => clock;
const format = new AccessTokenFormat(SECRET, LIFETIME, SKEW, now);
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test('tokens round-trip and carry the issue time and the admission deadline', () => {
  const parsed = format.parse(format.generate());
  assert.equal(parsed?.iat, Math.floor(clock / 1000));
  assert.equal(parsed?.deadline, Math.floor(clock / 1000) + LIFETIME + SKEW);
  assert.notEqual(format.generate(), format.generate());
});

test('anything but an exact, canonical, authentic token is refused', () => {
  const good = format.generate();
  const [version, kid, iat, random, mac] = good.split('.') as [
    string,
    string,
    string,
    string,
    string,
  ];
  const other = new AccessTokenFormat('b'.repeat(40), LIFETIME, SKEW, now).generate();
  const flipped = (text: string) => (text.startsWith('A') ? 'B' : 'A') + text.slice(1);
  // The last MAC character carries two padding bits: a non-canonical spelling of the same bytes.
  const lastIndex = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'.indexOf(
    mac.at(-1)!,
  );
  const sibling =
    mac.slice(0, -1) +
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'[lastIndex ^ 1];
  const junk = [
    '',
    'at1',
    'made-up',
    good + '.x',
    good + 'A',
    good.slice(0, -1),
    [version, 'b', iat, random, mac].join('.'),
    ['at2', kid, iat, random, mac].join('.'),
    [version, kid, iat.toUpperCase(), random, mac].join('.'),
    [version, kid, '0' + iat, random, mac].join('.'),
    [version, kid, '', random, mac].join('.'),
    [version, kid, iat, flipped(random), mac].join('.'),
    [version, kid, iat, random, flipped(mac)].join('.'),
    [version, kid, iat, random + 'AAAA', mac].join('.'),
    [version, kid, iat, random.replace(/.$/, '='), mac].join('.'),
    [version, kid, iat, random, sibling].join('.'),
    [version, kid, iat, random, mac, mac].join('.'),
    `${version}.${kid}.${iat}.${random}.${mac}`.padEnd(5000, 'x'),
    other,
    // The MAC covers the issue time: a changed time is refused.
    [version, kid, (parseInt(iat, 36) + 1).toString(36), random, mac].join('.'),
  ];
  for (const value of junk) assert.equal(format.parse(value), undefined, value.slice(0, 60));
  // Sanity: the sibling differs only in padding bits, and the real token still parses.
  assert.notEqual(sibling, mac);
  assert.ok(format.parse(good));
});

test('the MAC key is specific to this server: a token keyed for another product with the same secret is refused', () => {
  const mint = (info: string) => {
    const key = Buffer.from(hkdfSync('sha256', SECRET, '', info, 32));
    const body = `at1.a.${Math.floor(clock / 1000).toString(36)}.${Buffer.alloc(24, 7).toString('base64url')}`;
    return `${body}.${createHmac('sha256', key).update(body).digest().subarray(0, 16).toString('base64url')}`;
  };
  assert.ok(format.parse(mint('fedreg-access-token-mac/a')));
  for (const info of ['datagov-access-token-mac/a', 'samgov-access-token-mac/a', 'uspto-access-token-mac/a', 'fedreg-access-token-mac/b'])
    assert.equal(format.parse(mint(info)), undefined, info);
});

test('tokens beyond the maximum age are refused with no lookup; the skew is the only slack', async () => {
  const admission = new TokenAdmission(format, { now });
  const token = format.generate();
  clock += (LIFETIME + SKEW) * 1000 - 1000;
  const inside = await admission.admit(token);
  assert.equal(inside.kind, 'lookup');
  if (inside.kind === 'lookup') inside.release();
  clock += 1000;
  assert.deepEqual(await admission.admit(token), { kind: 'invalid' });
});

test('a rejected digest is remembered for a fixed time that hits never extend', async () => {
  const admission = new TokenAdmission(format, { now, ttlMs: 60_000 });
  const token = format.generate();
  const first = await admission.admit(token);
  assert.equal(first.kind, 'lookup');
  if (first.kind !== 'lookup') return;
  first.reject();
  first.release();
  for (const step of [20_000, 20_000, 19_000]) {
    assert.deepEqual(await admission.admit(token), { kind: 'invalid' });
    clock += step;
  }
  // 59 s after insertion: still remembered; 60 s: gone, even though it was hit every 20 s.
  assert.deepEqual(await admission.admit(token), { kind: 'invalid' });
  clock += 1000;
  const again = await admission.admit(token);
  assert.equal(again.kind, 'lookup');
  if (again.kind === 'lookup') again.release();
});

test('the entry expires at the admission deadline, never earlier than the token is admissible', async () => {
  const admission = new TokenAdmission(format, { now, ttlMs: 600_000 });
  const token = format.generate();
  clock += (LIFETIME + SKEW - 5) * 1000;
  const ticket = await admission.admit(token);
  assert.equal(ticket.kind, 'lookup');
  if (ticket.kind !== 'lookup') return;
  // DB expiry passed 55 s ago but the token is inside the skew window: the entry still lives 5 s.
  ticket.reject();
  ticket.release();
  assert.equal(admission.rejectedSize, 1);
  clock += 4000;
  assert.deepEqual(await admission.admit(token), { kind: 'invalid' });
  assert.equal(admission.rejectedSize, 1);
  clock += 1000;
  assert.deepEqual(await admission.admit(token), { kind: 'invalid' });
  // Rejected past the deadline: nothing to remember.
  const late = new TokenAdmission(format, { now });
  const stale = format.generate();
  const ticket2 = await late.admit(stale);
  assert.equal(ticket2.kind, 'lookup');
  if (ticket2.kind !== 'lookup') return;
  clock += (LIFETIME + SKEW) * 1000;
  ticket2.reject();
  ticket2.release();
  assert.equal(late.rejectedSize, 0);
});

test('the negative cache is bounded and evicts the least recently used digest', async () => {
  const admission = new TokenAdmission(format, { now, maxEntries: 3 });
  const tokens = Array.from({ length: 4 }, () => format.generate());
  const reject = async (token: string) => {
    const ticket = await admission.admit(token);
    assert.equal(ticket.kind, 'lookup');
    if (ticket.kind !== 'lookup') return;
    ticket.reject();
    ticket.release();
  };
  await reject(tokens[0]!);
  await reject(tokens[1]!);
  await reject(tokens[2]!);
  // Touch the first so the second is least recently used.
  assert.deepEqual(await admission.admit(tokens[0]!), { kind: 'invalid' });
  await reject(tokens[3]!);
  assert.equal(admission.rejectedSize, 3);
  assert.deepEqual(await admission.admit(tokens[0]!), { kind: 'invalid' });
  assert.deepEqual(await admission.admit(tokens[3]!), { kind: 'invalid' });
  const evicted = await admission.admit(tokens[1]!);
  assert.equal(evicted.kind, 'lookup');
  if (evicted.kind === 'lookup') evicted.release();
});

test('300 concurrent requests for one rejected digest cost exactly one lookup', async () => {
  const admission = new TokenAdmission(format, { now });
  const token = format.generate();
  let lookups = 0;
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  const outcomes: string[] = [];
  const request = async () => {
    const ticket = await admission.admit(token);
    if (ticket.kind !== 'lookup') return void outcomes.push(ticket.kind);
    try {
      lookups++;
      await gate;
      ticket.reject();
      outcomes.push('lookup');
    } finally {
      ticket.release();
    }
  };
  const all = Array.from({ length: 300 }, request);
  await flush();
  // One owner, 256 waiters, the rest refused at once.
  assert.equal(outcomes.filter((o) => o === 'busy').length, 43);
  open();
  await Promise.all(all);
  assert.equal(lookups, 1);
  assert.equal(outcomes.filter((o) => o === 'invalid').length, 256);
  assert.equal(outcomes.filter((o) => o === 'lookup').length, 1);
});

test('waiters after an inconclusive owner (limit, error) take ownership one at a time', async () => {
  const admission = new TokenAdmission(format, { now });
  const token = format.generate();
  let running = 0;
  let peak = 0;
  let lookups = 0;
  const gates: Array<() => void> = [];
  const request = async () => {
    const ticket = await admission.admit(token);
    if (ticket.kind !== 'lookup') return ticket.kind;
    try {
      lookups++;
      peak = Math.max(peak, ++running);
      await new Promise<void>((resolve) => gates.push(resolve));
      running--;
      return 'ok';
    } finally {
      ticket.release();
    }
  };
  const all = Array.from({ length: 5 }, request);
  for (let i = 0; i < 5; i++) {
    await flush();
    assert.equal(gates.length, i + 1, 'exactly one check runs at a time');
    gates[i]!();
  }
  assert.deepEqual(await Promise.all(all), ['ok', 'ok', 'ok', 'ok', 'ok']);
  assert.equal(lookups, 5);
  assert.equal(peak, 1);
  assert.equal(admission.rejectedSize, 0);
});

test('ownership is released when the check throws or is limited, and nothing is cached', async () => {
  const admission = new TokenAdmission(format, { now });
  const token = format.generate();
  const first = await admission.admit(token);
  assert.equal(first.kind, 'lookup');
  const waiter = admission.admit(token);
  if (first.kind === 'lookup') {
    first.release();
    first.release(); // releasing twice is harmless, even after the waiter took over
  }
  const second = await waiter;
  assert.equal(second.kind, 'lookup');
  assert.equal(admission.rejectedSize, 0);
  if (second.kind === 'lookup') second.release();
  const third = await admission.admit(token);
  assert.equal(third.kind, 'lookup');
  if (third.kind === 'lookup') third.release();
});

test('Slots cap per key and release back to zero', () => {
  const slots = new Slots(2);
  assert.deepEqual(
    [slots.take('a'), slots.take('a'), slots.take('a'), slots.take('b')],
    [true, true, false, true],
  );
  slots.release('a');
  assert.equal(slots.take('a'), true);
  for (const key of ['a', 'a', 'b']) slots.release(key);
  assert.equal(slots.size, 0);
});

test('after the owner succeeds, queued requests run their own checks, at most 16 at a time', async () => {
  const admission = new TokenAdmission(format, { now });
  const token = format.generate();
  const gates: Array<() => void> = [];
  let running = 0;
  let peak = 0;
  let lookups = 0;
  const request = async () => {
    const ticket = await admission.admit(token);
    if (ticket.kind !== 'lookup') return ticket.kind;
    try {
      lookups++;
      peak = Math.max(peak, ++running);
      await new Promise<void>((resolve) => gates.push(resolve));
      running--;
      ticket.validated();
      return 'ok';
    } finally {
      ticket.release();
    }
  };
  // Opens every pending check, round after round, until nothing is pending.
  const drain = async () => {
    for (;;) {
      await flush();
      const open = gates.splice(0);
      if (!open.length) return;
      open.forEach((gate) => gate());
    }
  };
  // 300 at once with a brand-new token: one owner, 256 queued, 43 refused by the queue bound.
  const all = Array.from({ length: 300 }, request);
  await flush();
  assert.equal(gates.length, 1);
  gates.splice(0)[0]!();
  await flush();
  // The owner validated: its queue now runs 16 at a time, each with its own check.
  assert.equal(gates.length, 16);
  await drain();
  const results = await Promise.all(all);
  assert.equal(results.filter((r) => r === 'ok').length, 257);
  assert.equal(results.filter((r) => r === 'busy').length, 43);
  assert.equal(lookups, 257);
  assert.equal(peak, 16);
  // Marked: later requests also run their own checks, 16 at a time, and none is refused.
  peak = 0;
  const later = Array.from({ length: 200 }, request);
  await flush();
  assert.equal(gates.length, 16);
  await drain();
  assert.equal((await Promise.all(later)).filter((r) => r === 'ok').length, 200);
  assert.equal(peak, 16);
});

test('a rejection answers every queued request 401 without further lookups', async () => {
  const admission = new TokenAdmission(format, { now });
  const token = format.generate();
  let lookups = 0;
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  const warm = await admission.admit(token);
  if (warm.kind === 'lookup') {
    warm.validated();
    warm.release();
  }
  const request = async () => {
    const ticket = await admission.admit(token);
    if (ticket.kind !== 'lookup') return ticket.kind;
    try {
      lookups++;
      await gate;
      ticket.reject();
      return 'lookup';
    } finally {
      ticket.release();
    }
  };
  const all = Array.from({ length: 100 }, request);
  await flush();
  assert.equal(lookups, 16);
  open();
  const results = await Promise.all(all);
  assert.equal(lookups, 16);
  assert.equal(results.filter((r) => r === 'invalid').length, 84);
});

test('overlapping rejections do not renew the fixed negative expiry', async () => {
  const admission = new TokenAdmission(format, { now });
  const token = format.generate();
  const warm = await admission.admit(token);
  if (warm.kind === 'lookup') {
    warm.validated();
    warm.release();
  }
  const first = await admission.admit(token);
  const second = await admission.admit(token);
  assert.deepEqual([first.kind, second.kind], ['lookup', 'lookup']);
  if (first.kind !== 'lookup' || second.kind !== 'lookup') return;
  first.reject();
  first.release();
  clock += 30_000;
  // A stale check that read the old state completes later: the first deadline stands.
  second.reject();
  second.release();
  clock += 31_000;
  const again = await admission.admit(token);
  assert.equal(again.kind, 'lookup');
  if (again.kind === 'lookup') again.release();
});

test('the global waiter cap bounds memory across digests', async () => {
  const admission = new TokenAdmission(format, { now, maxWaiters: 2, maxTotalWaiters: 3 });
  const a = format.generate();
  const b = format.generate();
  const ownerA = await admission.admit(a);
  const ownerB = await admission.admit(b);
  const waits = [a, a, b].map((t) => admission.admit(t));
  await flush();
  assert.deepEqual(await admission.admit(b), { kind: 'busy' });
  for (const owner of [ownerA, ownerB])
    if (owner.kind === 'lookup') {
      owner.validated();
      owner.release();
    }
  for (const w of await Promise.all(waits)) if (w.kind === 'lookup') w.release();
});

test('the validated marker has an expiry renewed by use, is bounded, capped at the deadline and dropped on rejection', async () => {
  const admission = new TokenAdmission(format, { now, ttlMs: 60_000, maxEntries: 2 });
  const mark = async (token: string) => {
    const ticket = await admission.admit(token);
    assert.equal(ticket.kind, 'lookup');
    if (ticket.kind !== 'lookup') return ticket;
    ticket.validated();
    ticket.release();
    return ticket;
  };
  const [t1, t2, t3] = [format.generate(), format.generate(), format.generate()] as [
    string,
    string,
    string,
  ];
  await mark(t1);
  await mark(t2);
  assert.equal(admission.validatedSize, 2);
  await mark(t3);
  assert.equal(admission.validatedSize, 2, 'bounded: the least recently used was evicted');
  // A marked digest is not deduplicated: two concurrent admissions both get their own check.
  const [x, y] = await Promise.all([admission.admit(t3), admission.admit(t3)]);
  assert.deepEqual([x.kind, y.kind], ['lookup', 'lookup']);
  // A success renews the marker: 60 s after the first insertion it is still there (renewed at +40 s).
  clock += 40_000;
  if (x.kind === 'lookup') x.validated();
  clock += 20_000;
  if (x.kind === 'lookup') x.release();
  if (y.kind === 'lookup') y.release();
  const again = await admission.admit(t3);
  assert.equal(again.kind, 'lookup');
  const alongside = await admission.admit(t3); // would queue forever if the marker had expired
  assert.equal(alongside.kind, 'lookup');
  if (alongside.kind === 'lookup') alongside.release();
  // A rejection drops the marker and enters the negative cache.
  if (again.kind === 'lookup') {
    again.validated();
    again.reject();
    again.release();
  }
  assert.deepEqual(await admission.admit(t3), { kind: 'invalid' });
  // Capped at the admission deadline.
  const late = new TokenAdmission(format, { now, ttlMs: 600_000 });
  const t4 = format.generate();
  clock += (LIFETIME + SKEW - 5) * 1000;
  const ticket = await late.admit(t4);
  if (ticket.kind === 'lookup') {
    ticket.validated();
    ticket.release();
  }
  clock += 6000;
  assert.deepEqual(await late.admit(t4), { kind: 'invalid' });
});

test('the deadline crossing during a release settles every queued request and frees all capacity', async () => {
  const admission = new TokenAdmission(format, { now, maxTotalWaiters: 3 });
  const token = format.generate();
  const owner = await admission.admit(token);
  assert.equal(owner.kind, 'lookup');
  const queued = [1, 2, 3].map(() => admission.admit(token));
  await flush();
  assert.equal(admission.queuedRequests, 3);
  clock += (LIFETIME + SKEW) * 1000;
  // The owner finishes after the deadline: no rejection can be recorded, yet nobody is stranded.
  if (owner.kind === 'lookup') {
    owner.reject();
    owner.release();
  }
  assert.deepEqual(await Promise.all(queued), Array(3).fill({ kind: 'invalid' }));
  assert.equal(admission.queuedRequests, 0);
  assert.equal(admission.activeDigests, 0);
  // The global waiter capacity is fully reusable on another digest.
  const other = format.generate();
  const holder = await admission.admit(other);
  const again = [1, 2, 3].map(() => admission.admit(other));
  await flush();
  assert.equal(admission.queuedRequests, 3);
  assert.deepEqual(await admission.admit(other), { kind: 'busy' });
  if (holder.kind === 'lookup') {
    holder.validated();
    holder.release();
  }
  for (const next of await Promise.all(again)) if (next.kind === 'lookup') next.release();
  assert.equal(admission.activeDigests, 0);
});

test('the deadline crossing between handoff and resume settles the rest of the queue', async () => {
  const admission = new TokenAdmission(format, { now, maxTotalWaiters: 3 });
  const token = format.generate();
  clock += 1000;
  const owner = await admission.admit(token);
  const queued = [1, 2, 3].map(() => admission.admit(token));
  await flush();
  // The owner finishes just before the deadline and hands its permit to the first waiter...
  clock += (LIFETIME + SKEW - 2) * 1000;
  if (owner.kind === 'lookup') owner.release();
  // ...and the deadline passes before that waiter resumes.
  clock += 5000;
  assert.deepEqual(await Promise.all(queued), Array(3).fill({ kind: 'invalid' }));
  assert.equal(admission.queuedRequests, 0);
  assert.equal(admission.activeDigests, 0);
});

test('a hot token keeps its 16-check limit across more than 60 s of successful use', async () => {
  const admission = new TokenAdmission(format, { now });
  const token = format.generate();
  for (let i = 0; i < 9; i++) {
    const ticket = await admission.admit(token);
    assert.equal(ticket.kind, 'lookup');
    if (ticket.kind !== 'lookup') return;
    ticket.validated();
    ticket.release();
    clock += 10_000;
  }
  // 90 s after the first success, yet the marker was renewed 10 s ago: 16 checks run at once.
  const grants = await Promise.all(Array.from({ length: 16 }, () => admission.admit(token)));
  assert.equal(grants.filter((g) => g.kind === 'lookup').length, 16);
  for (const g of grants) if (g.kind === 'lookup') g.release();
  // A rejection is still fixed: renewal never touches the negative entry.
  const rejecting = await admission.admit(token);
  if (rejecting.kind === 'lookup') {
    rejecting.reject();
    rejecting.release();
  }
  clock += 59_000;
  assert.deepEqual(await admission.admit(token), { kind: 'invalid' });
  clock += 2000;
  const again = await admission.admit(token);
  assert.equal(again.kind, 'lookup');
  if (again.kind === 'lookup') again.release();
});
