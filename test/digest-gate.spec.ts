import { test } from 'vitest';
import assert from 'node:assert/strict';
import { DigestGate } from '../src/accounts/digest-gate.js';

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test('permits are granted at once only while free and nobody is queued', async () => {
  let limit = 2;
  const gate = new DigestGate(() => limit, 10, 100);
  assert.equal(await gate.acquire('k'), 'granted');
  assert.equal(await gate.acquire('k'), 'granted');
  const third = gate.acquire('k');
  assert.equal(gate.queued, 1);
  // A new arrival never bypasses a non-empty queue, even when a permit is free.
  gate.release('k');
  limit = 3;
  assert.equal(await third, 'granted');
  assert.equal(await gate.acquire('k'), 'granted');
});

test('simultaneous releases hand permits over in strict arrival order, never over-granting', async () => {
  const gate = new DigestGate(() => 2, 10, 100);
  await gate.acquire('k');
  await gate.acquire('k');
  const order: number[] = [];
  const waiters = [1, 2, 3, 4, 5].map((n) =>
    gate.acquire('k').then((outcome) => {
      order.push(n);
      return outcome;
    }),
  );
  assert.equal(gate.queued, 5);
  // Both holders release in the same turn: exactly two waiters (the oldest) are granted.
  gate.release('k');
  gate.release('k');
  await flush();
  assert.deepEqual(order, [1, 2]);
  assert.equal(gate.queued, 3);
  // A new arrival queues behind the rest; a release grants the oldest, not the newcomer.
  const late = gate.acquire('k').then(() => order.push(6));
  gate.release('k');
  await flush();
  assert.deepEqual(order, [1, 2, 3]);
  for (let i = 0; i < 3; i++) {
    gate.release('k');
    await flush();
  }
  assert.deepEqual(order, [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(await Promise.all(waiters), Array(5).fill('granted'));
  await late;
});

test('the queue is bounded per key and overall, and credits come back', async () => {
  const gate = new DigestGate(() => 1, 2, 3);
  await gate.acquire('a');
  await gate.acquire('b');
  const queued = [gate.acquire('a'), gate.acquire('a'), gate.acquire('b')];
  assert.equal(await gate.acquire('a'), 'busy', 'per-key cap');
  assert.equal(await gate.acquire('b'), 'busy', 'global cap');
  gate.settle('a');
  assert.deepEqual(await Promise.all(queued.slice(0, 2)), ['settled', 'settled']);
  assert.equal(gate.queued, 1);
  gate.release('b');
  assert.equal(await queued[2], 'granted');
  gate.release('b');
  gate.release('a');
  assert.equal(gate.queued, 0);
  assert.equal(gate.digests, 0);
});

test('a terminal release settles the whole queue, strands nothing and deletes the entry', async () => {
  const gate = new DigestGate(() => 1, 100, 100);
  await gate.acquire('k');
  const waiting = Array.from({ length: 50 }, () => gate.acquire('k'));
  gate.release('k', true);
  assert.deepEqual([...new Set(await Promise.all(waiting))], ['settled']);
  assert.equal(gate.digests, 0);
  assert.equal(gate.queued, 0);
  // The whole capacity is reusable.
  assert.equal(await gate.acquire('k'), 'granted');
});

test('settle leaves permits held, so the entry lives until they are released', async () => {
  const gate = new DigestGate(() => 2, 10, 10);
  await gate.acquire('k');
  await gate.acquire('k');
  const waiting = gate.acquire('k');
  gate.settle('k');
  assert.equal(await waiting, 'settled');
  assert.equal(gate.digests, 1);
  gate.release('k');
  gate.release('k');
  assert.equal(gate.digests, 0);
});
