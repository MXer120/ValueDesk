/**
 * The chart failsafes: retry schedule, load-with-retry, staleness, the
 * watchdog's recovery pacing and health, and the merge of refetched bars.
 *   npx tsx --test src/chart/feedHealth.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ERROR_AFTER_FAILURES,
  FeedWatchdog,
  HIDDEN_REFETCH_MS,
  LOAD_TIMEOUT_MS,
  LoadCancelled,
  RECOVER_COOLDOWN_MS,
  STREAM_DOWN_POLL_MS,
  gapFillLimit,
  intervalMs,
  isFatalStatus,
  loadWithRetry,
  mergeBars,
  planMerge,
  retryDelayMs,
  staleReason,
  type BarLike,
  type FeedHealth,
  type LoadStatus,
  type RecoverReason,
  type RecoverResult,
} from './feedHealth';

/** A manual clock + timer queue, so retries and cooldowns run instantly. */
function fakeClock(start = 1_000_000) {
  let t = start;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => t,
    setTimer: (fn: () => void, ms: number) => {
      const id = ++seq;
      timers.set(id, { at: t + ms, fn });
      return id;
    },
    clearTimer: (id: unknown) => {
      timers.delete(id as number);
    },
    /** Advance, firing due timers in order, letting promises settle between. */
    async advance(ms: number) {
      const end = t + ms;
      for (;;) {
        await flush();
        let next: [number, { at: number; fn: () => void }] | undefined;
        for (const e of timers) if (e[1].at <= end && (!next || e[1].at < next[1].at)) next = e;
        if (!next) break;
        timers.delete(next[0]);
        t = next[1].at;
        next[1].fn();
      }
      t = end;
      await flush();
    },
    pending: () => timers.size,
  };
}

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

// --- schedule ------------------------------------------------------------------

test('retry schedule: 1s, 2s, 5s, 10s, then every 15s', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 50].map(retryDelayMs), [1000, 2000, 5000, 10000, 15000, 15000, 15000]);
  assert.equal(retryDelayMs(0), 0);
  assert.equal(LOAD_TIMEOUT_MS, 8000);
  assert.equal(ERROR_AFTER_FAILURES, 3);
});

test('interval lengths come from the one interval table', () => {
  assert.equal(intervalMs('1m'), 60_000);
  assert.equal(intervalMs('4h'), 4 * 3_600_000);
  assert.equal(intervalMs('1D'), 86_400_000);
  assert.equal(intervalMs('1W'), 7 * 86_400_000);
  assert.equal(intervalMs('7m'), undefined);
});

test('4xx is fatal except the try-again-later ones', () => {
  assert.equal(isFatalStatus({ status: 400 }), true);
  assert.equal(isFatalStatus({ status: 404 }), true);
  assert.equal(isFatalStatus({ status: 429 }), false);
  assert.equal(isFatalStatus({ status: 503 }), false);
  assert.equal(isFatalStatus(new Error('x')), false);
});

// --- load with retry -------------------------------------------------------------

test('a load that times out retries on the schedule, errors after 3, then succeeds', async () => {
  const clock = fakeClock();
  const statuses: LoadStatus[] = [];
  let calls = 0;
  const aborted: boolean[] = [];
  const h = loadWithRetry<string>({
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onStatus: (s) => statuses.push(s),
    attempt: (signal) => {
      calls += 1;
      const n = calls;
      if (n <= 4) {
        // never answers - only the timeout ends it
        return new Promise<string>((_, reject) => {
          signal.addEventListener('abort', () => {
            aborted.push(true);
            reject(new Error('aborted'));
          });
        });
      }
      return Promise.resolve('bars');
    },
  });
  let result: string | undefined;
  void h.promise.then((v) => (result = v));

  await clock.advance(LOAD_TIMEOUT_MS); // 1st times out
  assert.equal(statuses.at(-1)?.phase, 'retrying');
  assert.equal(statuses.at(-1)?.failures, 1);
  assert.equal(statuses.at(-1)?.nextRetryAt, clock.now() + 1000);
  assert.equal(aborted.length, 1, 'the timed-out request is aborted, not left running');

  await clock.advance(1000 + LOAD_TIMEOUT_MS); // 2nd
  assert.equal(statuses.at(-1)?.phase, 'retrying');
  await clock.advance(2000 + LOAD_TIMEOUT_MS); // 3rd
  assert.equal(statuses.at(-1)?.phase, 'error');
  assert.equal(statuses.at(-1)?.failures, 3);
  assert.match(statuses.at(-1)?.error ?? '', /no bars within 8s/);
  await clock.advance(5000 + LOAD_TIMEOUT_MS); // 4th
  assert.equal(statuses.at(-1)?.failures, 4);
  assert.equal(result, undefined);
  await clock.advance(10_000); // 5th answers
  assert.equal(result, 'bars');
  assert.equal(calls, 5);
});

test('"Retry now" skips the wait; cancel stops for good and aborts the request', async () => {
  const clock = fakeClock();
  let calls = 0;
  const h = loadWithRetry({
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    attempt: () => {
      calls += 1;
      return Promise.reject(new Error('HTTP 502'));
    },
  });
  await clock.advance(0);
  assert.equal(calls, 1);
  h.retryNow();
  await clock.advance(0);
  assert.equal(calls, 2, 'retried without waiting the 1s');

  let rejected: unknown;
  h.promise.catch((e) => (rejected = e));
  h.cancel();
  await clock.advance(60_000);
  assert.ok(rejected instanceof LoadCancelled);
  assert.equal(calls, 2, 'no attempt after cancel');
});

test('a late answer from a cancelled load is never delivered', async () => {
  const clock = fakeClock();
  let answer!: (v: string) => void;
  const h = loadWithRetry<string>({
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    attempt: () => new Promise<string>((r) => (answer = r)),
  });
  let got: string | undefined;
  let cancelled = false;
  h.promise.then((v) => (got = v), () => (cancelled = true));
  h.cancel();
  answer('old market bars');
  await clock.advance(0);
  assert.equal(got, undefined);
  assert.equal(cancelled, true);
});

test('a fatal 4xx goes straight to the error state and keeps retrying slowly', async () => {
  const clock = fakeClock();
  const statuses: LoadStatus[] = [];
  const h = loadWithRetry({
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    isFatal: isFatalStatus,
    onStatus: (s) => statuses.push(s),
    attempt: () => Promise.reject(Object.assign(new Error('unknown symbol'), { status: 404 })),
  });
  await clock.advance(0);
  assert.equal(statuses.at(-1)?.phase, 'error');
  assert.equal(statuses.at(-1)?.nextRetryAt, clock.now() + 5000);
  h.cancel();
});

// --- staleness --------------------------------------------------------------------

const base = { now: 10_000_000, intervalMs: 60_000, streamOpen: true, tickerMovedAt: null };

test('fresh bars and a talking stream are not stale', () => {
  assert.equal(staleReason({ ...base, lastBarTime: base.now - 30_000, lastTickAt: base.now - 2_000 }), null);
});

test('a newest bar older than 2 bars + margin is stale while the stream is open', () => {
  assert.equal(staleReason({ ...base, lastBarTime: base.now - 136_000, lastTickAt: base.now - 1_000 }), 'stale-bars');
  assert.equal(staleReason({ ...base, lastBarTime: base.now - 134_000, lastTickAt: base.now - 1_000 }), null);
});

test('stream silence counts after max(2 bars, 30s)', () => {
  const one = { ...base, lastBarTime: base.now - 10_000 };
  assert.equal(staleReason({ ...one, lastTickAt: base.now - 119_000 }), null);
  assert.equal(staleReason({ ...one, lastTickAt: base.now - 121_000 }), 'stream-silent');
  // 1m floor is 2 bars; for a sub-15s interval the 30s floor would win
  assert.equal(staleReason({ ...one, intervalMs: 5_000, lastTickAt: base.now - 31_000 }), 'stream-silent');
});

test('a moving ticker with a silent candle is stale on ANY interval, even 1D', () => {
  const d = { ...base, intervalMs: 86_400_000, lastBarTime: base.now - 3_600_000 };
  assert.equal(staleReason({ ...d, lastTickAt: base.now - 31_000, tickerMovedAt: base.now - 5_000 }), 'ticker-moving');
  // ticker moved BEFORE the last candle arrived: nothing is missing
  assert.equal(staleReason({ ...d, lastTickAt: base.now - 31_000, tickerMovedAt: base.now - 40_000 }), null);
  // not silent long enough yet
  assert.equal(staleReason({ ...d, lastTickAt: base.now - 20_000, tickerMovedAt: base.now - 5_000 }), null);
});

test('a closed stream is not a stale verdict (the watchdog polls instead)', () => {
  assert.equal(
    staleReason({ ...base, streamOpen: false, lastBarTime: base.now - 999_000, lastTickAt: base.now - 999_000 }),
    null,
  );
});

// --- watchdog ------------------------------------------------------------------------

function watchdog(result: RecoverResult | ((r: RecoverReason) => RecoverResult) = 'current') {
  const clock = fakeClock(50_000_000);
  const calls: RecoverReason[] = [];
  const health: [FeedHealth, string][] = [];
  const w = new FeedWatchdog({
    intervalMs: 60_000,
    now: clock.now,
    recover: async (r) => {
      calls.push(r);
      return typeof result === 'function' ? result(r) : result;
    },
    onHealth: (h, why) => health.push([h, why]),
  });
  return { w, clock, calls, health };
}

test('a stalled candle stream on a trading market recovers, and says Delayed meanwhile', async () => {
  const { w, clock, calls, health } = watchdog('caught-up');
  w.noteStream(true);
  w.noteHistory(clock.now() - 20_000);
  w.noteTicker('100');
  await clock.advance(10_000);
  w.noteTicker('101'); // a trade...
  await clock.advance(25_000);
  w.check(); // ...and 35s without a candle
  await flush();
  assert.deepEqual(calls, ['ticker-moving']);
  assert.equal(health.at(-1)?.[0], 'delayed');
  w.noteTick(clock.now() - 1000); // the stream proves itself again
  assert.equal(health.at(-1)?.[0], 'live');
});

test('a quiet market backs off: 15s, 30s, 60s, then every 2 min - and stays Live', async () => {
  const { w, clock, calls, health } = watchdog('current');
  w.noteStream(true);
  w.noteHistory(clock.now() - 30 * 60_000); // last trade half an hour ago
  const at: number[] = [];
  const start = clock.now();
  for (let i = 0; i < 400; i++) {
    w.check();
    await flush();
    if (calls.length > at.length) at.push(clock.now() - start);
    await clock.advance(1_000);
  }
  const gaps = at.slice(1).map((t, i) => t - at[i]!);
  assert.deepEqual(gaps.slice(0, 4), [RECOVER_COOLDOWN_MS[0], RECOVER_COOLDOWN_MS[1], RECOVER_COOLDOWN_MS[2], RECOVER_COOLDOWN_MS[3]]);
  assert.ok(calls.every((r) => r === 'stale-bars'));
  assert.ok(health.every(([h]) => h === 'live'), 'no data is missing, so it is not "Delayed"');
});

test('reconnect after a drop gap-fills at once; the first open does not', async () => {
  const { w, clock, calls, health } = watchdog('current');
  w.noteHistory(clock.now());
  w.noteStream(true);
  await flush();
  assert.deepEqual(calls, []);
  w.noteStream(false);
  assert.equal(health.at(-1)?.[0], 'delayed');
  await clock.advance(2_000);
  w.noteStream(true);
  await flush();
  assert.deepEqual(calls, ['reconnect']);
  assert.equal(health.at(-1)?.[0], 'live');
});

test('with the stream down, the chart is refreshed from REST every 15s', async () => {
  const { w, clock, calls } = watchdog('caught-up');
  w.noteHistory(clock.now());
  w.noteStream(true);
  w.noteStream(false);
  for (let i = 0; i < 50; i++) {
    w.check();
    await clock.advance(1_000);
  }
  assert.ok(calls.length >= 3 && calls.length <= 4, `expected ~3 polls in 50s, got ${calls.length}`);
  assert.ok(calls.every((r) => r === 'stream-down'));
  void STREAM_DOWN_POLL_MS;
});

test('the tab coming back after a while gap-fills; a flicker does not', async () => {
  const { w, clock, calls } = watchdog('current');
  w.noteStream(true);
  w.noteHistory(clock.now());
  w.noteVisible(false);
  await clock.advance(1_000);
  w.noteVisible(true);
  await flush();
  assert.deepEqual(calls, []);
  w.noteVisible(false);
  await clock.advance(HIDDEN_REFETCH_MS + 1);
  w.noteVisible(true);
  await flush();
  assert.deepEqual(calls, ['visible']);
});

test('a reconnect during a running recovery is queued, not lost', async () => {
  const clock = fakeClock();
  const calls: RecoverReason[] = [];
  let release!: () => void;
  const w = new FeedWatchdog({
    intervalMs: 60_000,
    now: clock.now,
    recover: (r) => {
      calls.push(r);
      return r === 'visible' ? new Promise<RecoverResult>((res) => (release = () => res('current'))) : Promise.resolve('current');
    },
  });
  w.noteStream(true);
  w.noteHistory(clock.now());
  w.noteVisible(false);
  await clock.advance(HIDDEN_REFETCH_MS);
  w.noteVisible(true);
  w.noteStream(false);
  w.noteStream(true); // reconnect while 'visible' is still running
  await flush();
  assert.deepEqual(calls, ['visible']);
  release();
  await flush();
  assert.deepEqual(calls, ['visible', 'reconnect']);
});

test('a failed recovery shows Delayed', async () => {
  const { w, clock, health } = watchdog('failed');
  w.noteStream(true);
  w.noteHistory(clock.now() - 10 * 60_000);
  w.check();
  await flush();
  assert.equal(health.at(-1)?.[0], 'delayed');
});

// --- merge ------------------------------------------------------------------------------

const b = (time: number, close = 100, volume = 1): BarLike => ({ time, open: 100, high: 110, low: 90, close, volume });

test('new bars are appended; the live bar is replaced only by a newer reading', () => {
  const held = [b(1), b(2), b(3, 100, 5)];
  const plan = planMerge(held, [b(2), b(3, 104, 7), b(4), b(5)]);
  assert.equal(plan.kind, 'append');
  if (plan.kind !== 'append') return;
  assert.deepEqual(plan.bars.map((x) => x.time), [3, 4, 5]);
  assert.equal(plan.newBars, 2);

  // REST lags the stream on the live bar (less volume): leave the live bar alone
  const lag = planMerge(held, [b(2), b(3, 99, 4)]);
  assert.deepEqual(lag, { kind: 'none' });
});

test('nothing new -> none; empty page -> none', () => {
  assert.deepEqual(planMerge([b(1), b(2)], [b(1), b(2)]), { kind: 'none' });
  assert.deepEqual(planMerge([b(1)], []), { kind: 'none' });
});

test('a hole in the middle, or a bar the stream left incomplete, needs a reload', () => {
  // the stream skipped bar 3 and delivered 4
  assert.deepEqual(planMerge([b(1), b(2), b(4)], [b(2), b(3), b(4), b(5)]), { kind: 'reload', reason: 'gap' });
  // bar 2 was closed with more trades than the chart ever saw
  assert.deepEqual(planMerge([b(1), b(2, 100, 1), b(3)], [b(2, 101, 3), b(3)]), { kind: 'reload', reason: 'incomplete' });
});

test('a page that does not reach back to the chart, or an empty chart, reloads', () => {
  assert.deepEqual(planMerge([b(1), b(2)], [b(10), b(11)]), { kind: 'reload', reason: 'too-far' });
  assert.deepEqual(planMerge([], [b(1)]), { kind: 'reload', reason: 'empty' });
});

test('bars older than the chart are ignored, never a gap', () => {
  const plan = planMerge([b(5), b(6)], [b(1), b(2), b(5), b(6), b(7)]);
  assert.equal(plan.kind, 'append');
  if (plan.kind === 'append') assert.deepEqual(plan.bars.map((x) => x.time), [7]);
});

test('mergeBars keeps older history and lets the page own its range, no duplicates', () => {
  const out = mergeBars([b(1), b(2), b(3), b(4)], [b(3, 1), b(4, 2), b(5, 3)]);
  assert.deepEqual(out.map((x) => [x.time, x.close]), [[1, 100], [2, 100], [3, 1], [4, 2], [5, 3]]);
  assert.equal(new Set(out.map((x) => x.time)).size, out.length);
});

test('gap-fill page size covers the missing bars, within bounds', () => {
  const now = 1_000_000_000;
  assert.equal(gapFillLimit(now - 60_000, now, 60_000), 10);
  assert.equal(gapFillLimit(now - 30 * 60_000, now, 60_000), 33);
  assert.equal(gapFillLimit(now - 10_000 * 60_000, now, 60_000), 500);
  assert.equal(gapFillLimit(null, now, 60_000), 500);
});
