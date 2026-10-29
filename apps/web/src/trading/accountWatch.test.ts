/**
 * The first-deposit watch (accountWatch.ts): backoff, focus, nudge, hidden tab,
 * and that it stops once the account is there.
 *   npx tsx --test src/trading/accountWatch.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WATCH_FIRST_MS, WATCH_MAX_MS, createAccountWatch } from './accountWatch';

/** A fake clock: timers fire only when `advance` passes them. */
function harness() {
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const checks: Array<{ owner: string; at: number }> = [];
  let hidden = false;
  /** What the next check answers: true = the account is there now. */
  let opens = false;
  const watch = createAccountWatch({
    check: async (owner) => {
      checks.push({ owner, at: now });
      if (opens) watch.follow(null);
    },
    setTimer: (fn, ms) => {
      timers.set(++seq, { at: now + ms, fn });
      return seq;
    },
    clearTimer: (t) => timers.delete(t as number),
    now: () => now,
    hidden: () => hidden,
  });
  const flush = () => new Promise<void>((r) => setImmediate(r));
  async function advance(ms: number) {
    const end = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].fn();
      await flush();
    }
    now = end;
  }
  return {
    watch,
    checks,
    advance,
    flush,
    pending: () => timers.size,
    setHidden: (v: boolean) => (hidden = v),
    setOpens: (v: boolean) => (opens = v),
  };
}

test('looks again after 5 s, doubling up to once a minute', async () => {
  const h = harness();
  h.watch.follow('0xabc');
  await h.advance(WATCH_FIRST_MS - 1);
  assert.equal(h.checks.length, 0);
  await h.advance(1);
  assert.equal(h.checks.length, 1);
  await h.advance(10 * 60_000);
  const gaps = h.checks.slice(1).map((c, i) => c.at - h.checks[i]!.at);
  assert.deepEqual(gaps.slice(0, 4), [10_000, 20_000, 40_000, 60_000]);
  assert.ok(gaps.every((g) => g <= WATCH_MAX_MS));
});

test('stops once the account is there, and when nobody is followed', async () => {
  const h = harness();
  h.watch.follow('0xabc');
  h.setOpens(true);
  await h.advance(WATCH_FIRST_MS);
  assert.equal(h.checks.length, 1);
  assert.equal(h.watch.owner, null);
  assert.equal(h.pending(), 0);
  await h.advance(10 * 60_000);
  assert.equal(h.checks.length, 1);
});

test('focus looks at once (at most once per 5 s) and starts the waits over', async () => {
  const h = harness();
  h.watch.follow('0xabc');
  await h.advance(5_000 + 10_000 + 20_000 + 6_000); // three looks, the next one 34 s out
  assert.equal(h.checks.length, 3);
  h.watch.shown();
  await h.flush();
  assert.equal(h.checks.length, 4, 'coming back to the window looks right away');
  h.watch.shown();
  await h.flush();
  assert.equal(h.checks.length, 4, 'a second focus right after does not');
  await h.advance(10_000);
  assert.equal(h.checks.length, 5, 'and the waits start over from the fast end');
});

test('a nudge (the Deposit sheet saw a deposit) looks now and resets the backoff', async () => {
  const h = harness();
  h.watch.follow('0xabc');
  await h.advance(5 * 60_000);
  const before = h.checks.length;
  h.watch.nudge(true);
  await h.flush();
  assert.equal(h.checks.length, before + 1);
  await h.advance(10_000);
  assert.equal(h.checks.length, before + 2);
});

test('nothing is read while the tab is hidden; the missed look runs when it is shown', async () => {
  const h = harness();
  h.watch.follow('0xabc');
  h.setHidden(true);
  await h.advance(10 * 60_000);
  assert.equal(h.checks.length, 0);
  assert.equal(h.pending(), 0, 'no timer keeps running in the background');
  h.setHidden(false);
  h.watch.shown();
  await h.flush();
  assert.equal(h.checks.length, 1);
});

test('another wallet restarts the watch for that wallet', async () => {
  const h = harness();
  h.watch.follow('0xabc');
  await h.advance(60_000);
  h.watch.follow('0xdef');
  const n = h.checks.length;
  await h.advance(WATCH_FIRST_MS);
  assert.equal(h.checks.length, n + 1);
  assert.equal(h.checks.at(-1)!.owner, '0xdef');
});
