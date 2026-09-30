/** Request dedupe and short-lived answers (gate.ts). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RequestGate } from './gate';

test('gate: identical concurrent reads are ONE request', async () => {
  const g = new RequestGate();
  let calls = 0;
  let release!: (v: string) => void;
  const load = () => {
    calls++;
    return new Promise<string>((r) => (release = r));
  };
  const a = g.run('k', 0, load);
  const b = g.run('k', 0, load);
  const c = g.run('other', 0, () => Promise.resolve('x'));
  release('v');
  assert.deepEqual(await Promise.all([a, b, c]), ['v', 'v', 'x']);
  assert.equal(calls, 1);
});

test('gate: an answer is reused for its TTL, then read again', async () => {
  let now = 0;
  const g = new RequestGate(100, () => now);
  let calls = 0;
  const load = async () => ++calls;
  assert.equal(await g.run('k', 1_000, load), 1);
  now = 999;
  assert.equal(await g.run('k', 1_000, load), 1, 'fresh');
  now = 1_000;
  assert.equal(await g.run('k', 1_000, load), 2, 'expired');
  assert.equal(await g.run('k', 0, load), 3, 'ttl 0 only dedupes');
});

test('gate: a failure is never cached; the last good answer is kept for fallbacks', async () => {
  let now = 0;
  const g = new RequestGate(100, () => now);
  assert.equal(await g.run('k', 5_000, async () => 'good'), 'good');
  now = 10_000;
  await assert.rejects(g.run('k', 5_000, async () => { throw new Error('429'); }));
  assert.equal(await g.run('k', 5_000, async () => 'again'), 'again', 'the next caller tries again');
  now = 20_000;
  await assert.rejects(g.run('k', 5_000, async () => { throw new Error('down'); }));
  assert.deepEqual(g.lastGood('k'), { at: 10_000, value: 'again' });
  assert.equal(g.lastGood('never'), null);
});

test('gate: bounded - the oldest answers go first', async () => {
  const g = new RequestGate(3);
  for (let i = 0; i < 10; i++) await g.run(`k${i}`, 60_000, async () => i);
  assert.equal(g.size, 3);
  assert.equal(g.lastGood('k0'), null);
  assert.equal(g.lastGood<number>('k9')?.value, 9);
});

test('gate: a bulk read can stay out of the last-good copies', async () => {
  const g = new RequestGate();
  assert.equal(await g.run('page', 0, async () => 'rows', false), 'rows');
  assert.equal(g.lastGood('page'), null, 'a history walk page is not kept around');
});
