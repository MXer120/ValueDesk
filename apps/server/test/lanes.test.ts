/**
 * Task lanes (indexer/lanes.ts): one task at a time by default, several with
 * `concurrency`, and the same spend cap either way.
 *
 *   npx tsx --test test/lanes.test.ts   (from apps/server)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Lane } from '../src/indexer/lanes.js';

const turn = () => new Promise<void>((r) => setImmediate(r));

/** A task that runs until released, recording how many ran at once. */
function gated(state: { now: number; peak: number; done: number }, cost: number) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  return {
    release: () => release(),
    run: async () => {
      state.now++;
      state.peak = Math.max(state.peak, state.now);
      await gate;
      state.now--;
      state.done++;
      return cost;
    },
  };
}

test('concurrency: up to n tasks run at once, the next waits for a free slot', async () => {
  const state = { now: 0, peak: 0, done: 0 };
  const rests: number[] = [];
  const lane = new Lane({ name: 't', perMin: 450, concurrency: 3, sleep: (ms) => { rests.push(ms); return turn(); } });
  const tasks = Array.from({ length: 5 }, () => gated(state, 2));
  tasks.forEach((t, i) => lane.add({ key: `k:${i}`, prio: 10 - i, run: t.run }));
  lane.start();
  for (let i = 0; i < 20; i++) await turn();
  assert.equal(state.now, 3, 'three in flight');
  assert.equal(lane.size, 2, 'two still queued');
  assert.equal(lane.countPrefix('k:'), 5, 'running and queued both count');
  assert.ok(lane.has('k:0') && lane.current?.key.startsWith('k:'));
  tasks[0]!.release();
  for (let i = 0; i < 20; i++) await turn();
  assert.equal(state.now, 3, 'a finished task frees one slot');
  for (const t of tasks) t.release();
  for (let i = 0; i < 50 && state.done < 5; i++) await turn();
  for (let i = 0; i < 10; i++) await turn();
  lane.stop();
  assert.equal(state.peak, 3);
  assert.equal(state.done, 5);
  // Every finished task's spend is rested off: 5 x 2 weight at 450 a minute = 1.33 s in all.
  const rested = rests.filter((ms) => ms !== 1_000).reduce((a, b) => a + b, 0);
  assert.equal(Math.round(rested), 1_333);
  assert.equal(lane.spent, 10);
});

test('concurrency keeps a share: running tasks count at their prefix\'s average cost', async () => {
  const ran: string[] = [];
  const slow = () => new Promise((r) => setTimeout(r, 1));
  const lane = new Lane({ name: 't', perMin: 1e9, concurrency: 8, shares: [{ prefix: 'cohpnl:', share: 0.4 }], sleep: turn });
  for (let i = 0; i < 400; i++) lane.add({ key: `coh:${i}`, prio: 2_000, run: async () => { await slow(); ran.push('pos'); return 2; } });
  for (let i = 0; i < 40; i++) lane.add({ key: `cohpnl:${i}`, prio: 1, run: async () => { await slow(); ran.push('pnl'); return 20; } });
  lane.start();
  for (let i = 0; i < 400 && ran.length < 160; i++) await new Promise((r) => setTimeout(r, 2));
  lane.stop();
  const first = ran.slice(0, 160);
  const pnl = first.filter((x) => x === 'pnl').length;
  const share = (pnl * 20) / (pnl * 20 + (first.length - pnl) * 2);
  // Without counting the running ones, parallel slots all went to the share: 64%.
  assert.ok(share > 0.3 && share < 0.55, `portfolio reads took ${Math.round(share * 100)}% of the spend`);
});

test('one at a time by default: each task is followed by its own rest', async () => {
  const order: string[] = [];
  const lane = new Lane({ name: 't', perMin: 30, sleep: (ms) => { order.push(`rest ${ms}`); return turn(); } });
  for (let i = 0; i < 3; i++) lane.add({ key: `k:${i}`, prio: 3 - i, run: async () => { order.push(`run ${i}`); return 1; } });
  lane.start();
  for (let i = 0; i < 50 && order.filter((o) => o.startsWith('run')).length < 3; i++) await turn();
  for (let i = 0; i < 5; i++) await turn();
  lane.stop();
  assert.deepEqual(order.filter((o) => o !== 'rest 1000').slice(0, 6), ['run 0', 'rest 2000', 'run 1', 'rest 2000', 'run 2', 'rest 2000']);
});

test('a rate limit pauses the lane before its next task', async () => {
  const sleeps: number[] = [];
  let runs = 0;
  const lane = new Lane({ name: 't', perMin: 1e9, rateLimitPauseMs: 42_000, sleep: (ms) => { sleeps.push(ms); return turn(); } });
  lane.add({ key: 'a', prio: 2, run: async () => { runs++; throw Object.assign(new Error('HTTP 429 Too Many Requests'), { status: 429 }); } });
  lane.add({ key: 'b', prio: 1, run: async () => { runs++; return 0; } });
  lane.start();
  for (let i = 0; i < 50 && runs < 2; i++) await turn();
  lane.stop();
  assert.equal(lane.failed, 1);
  assert.ok(sleeps.includes(42_000), `paused: ${sleeps.join(',')}`);
  assert.equal(runs, 2);
});
