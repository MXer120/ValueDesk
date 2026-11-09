/**
 * Run: node --import tsx --test apps/server/test/liveHub.test.ts
 *
 * The live channels on /ws/liq (routes/liveHub.ts) and their patches (live/jsonPatch.ts): a patch is lossless (apply(a,
 * diff(a, b)) equals b, also for reordered and replaced rows); a subscriber gets the route's answer whole, then only patches,
 * in seq order; a forming window is built again when its slots' print count moves, at most every THROTTLE_MS, and not when
 * nothing moved; a final window is never built again; the cohorts go out again when the load changes; bad and unpushed
 * paths are refused (the page then polls); viewers of one read share one build; a closed socket leaves nothing behind.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apply, diff } from '../src/live/jsonPatch.js';
import { LiveHub, MAX_SUBS, THROTTLE_MS, LIVE_REFRESH_MS, type LiveClient, type LiveSources } from '../src/routes/liveHub.js';
import type { FlowAsk, FlowWindow } from '../src/flow/read.js';

function rng(seed: number): () => number {
  let x = seed >>> 0;
  return () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 2 ** 32; };
}

// --- the patch -----------------------------------------------------------------------------------

test('a patch is lossless: random values, reordered keyed rows, rows gone and new, type changes', () => {
  const r = rng(3);
  const row = (i: number) => ({ venue: r() < 0.5 ? 'sodex' : 'hyperliquid', key: `k${i}`, address: null, vol: Math.round(r() * 1e6) / 100, fills: Math.floor(r() * 50), lean: r() < 0.5 ? 'long' : 'short' });
  for (let n = 0; n < 200; n++) {
    const a = { ok: true, final: false, summary: { total: r() * 1e6, wallets: 3 }, rows: Array.from({ length: Math.floor(r() * 30) }, (_, i) => row(i)), gaps: [[1, 2]], since: r() < 0.5 ? null : 5 };
    const rows = a.rows.map((x) => (r() < 0.3 ? { ...x, vol: x.vol + 1 } : x)).filter(() => r() > 0.1);
    for (let k = 0; k < 3; k++) rows.splice(Math.floor(r() * (rows.length + 1)), 0, row(100 + n * 10 + k));
    rows.sort(() => r() - 0.5);
    const b: Record<string, unknown> = { ...a, rows, summary: { ...a.summary, total: a.summary.total + 1 }, gaps: r() < 0.5 ? [] : [[1, 3]], since: r() < 0.5 ? 'x' : null };
    if (r() < 0.3) delete b.final;
    if (r() < 0.3) b.extra = { deep: [1, { two: 2 }] };
    assert.deepEqual(apply(structuredClone(a), diff(a, b)), b);
    assert.deepEqual(apply(a, diff(a, a)), a);
  }
  // Arrays without identity go by position; a primitive array that slid is sent whole when that is shorter.
  assert.deepEqual(apply([1, 2, 3], diff([1, 2, 3], [2, 3, 4])), [2, 3, 4]);
  assert.deepEqual(diff([1, 2, 3], [2, 3, 4]), { $: [2, 3, 4] });
  assert.equal(diff({ a: [1, { b: null }] }, { a: [1, { b: null }] }), undefined);
});

test('a reordered table costs one small number per unchanged row', () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({ venue: 'hyperliquid', key: `0x${i.toString(16).padStart(40, '0')}`, address: `0x${i.toString(16).padStart(40, '0')}`, vol: 1000 + i, share: i / 100, fills: i, buyVol: i, sellVol: i, lean: 'long' }));
  const moved = [...rows];
  const [x] = moved.splice(50, 1);
  moved.unshift({ ...x!, vol: 99_999 });
  const p = diff({ rows }, { rows: moved })!;
  const size = JSON.stringify(p).length;
  assert.ok(size < 600, `patch ${size} B for one row moved to the top of 100 (the table is ${JSON.stringify(moved).length} B)`);
  assert.deepEqual(apply({ rows }, p), { rows: moved });
});

// --- the hub -------------------------------------------------------------------------------------

class FakeWs implements LiveClient {
  readyState: 0 | 1 | 2 | 3 = 1;
  bufferedAmount = 0;
  got: Array<Record<string, unknown>> = [];
  send(text: string): void { this.got.push(JSON.parse(text)); }
}

const ASK: FlowAsk = { coin: 'BTC', venues: ['hyperliquid'], kind: 'perp', from: 1_000_000, to: 1_060_000, role: 'all', side: 'all', sort: 'volume', limit: 100 };

function windowOf(rows: Array<{ key: string; vol: number }>, final = false): FlowWindow {
  return {
    coin: 'BTC', from: ASK.from, to: ASK.to, final,
    summary: { total: rows.reduce((s, x) => s + x.vol, 0), wallets: rows.length } as FlowWindow['summary'],
    rows: rows.map((x) => ({ venue: 'hyperliquid', address: x.key, key: x.key, vol: x.vol }) as unknown as FlowWindow['rows'][number]),
    markets: [], gaps: [], down: [], coverage: null, checks: [], since: 0,
  };
}

function rig() {
  const s = {
    now: 1_030_000,
    stamp: 0,
    rows: [{ key: 'a', vol: 1 }],
    final: false,
    builds: 0,
    cohortBuilds: 0,
    loadAt: 1 as number | null,
    cohort: { ok: true, cohorts: [{ id: 'whale', long: 1 }] } as Record<string, unknown>,
  };
  const src: LiveSources = {
    parse: (path, q) => {
      if (path === '/api/vs/flow') {
        if (!q.coin) throw Object.assign(new Error('coin= is required'), { statusCode: 400 });
        return { kind: 'flow', ask: { ...ASK, coin: q.coin, limit: Number(q.limit) || 100 } };
      }
      if (path === '/api/vs/cohorts') return { kind: 'cohort', job: { op: 'cohorts', venues: ['hyperliquid'], f: {} } };
      return null;
    },
    flowWindow: async () => { s.builds++; return windowOf(s.rows, s.final); },
    flowStamp: () => s.stamp,
    cohortJob: async () => { s.cohortBuilds++; return JSON.stringify(s.cohort); },
    cohortLoadAt: async () => s.loadAt,
    now: () => s.now,
  };
  const hub = new LiveHub(src, { timer: false });
  return { s, hub };
}

const settle = () => new Promise((r) => setImmediate(r));

test('subscribe: the whole answer once, then patches in seq order when a print lands, throttled', async () => {
  const { s, hub } = rig();
  const ws = new FakeWs();
  assert.equal(hub.message(ws, { op: 'live', id: 'f1', path: '/api/vs/flow?coin=BTC' }), true);
  await settle();
  assert.equal(ws.got.length, 1);
  assert.equal(ws.got[0]!.t, 'ls');
  assert.equal(ws.got[0]!.seq, 1);
  let held = ws.got[0]!.body;
  assert.deepEqual(held, { ok: true, ...windowOf(s.rows) });

  // Nothing landed: the stamp is read, nothing is built or sent.
  s.now += THROTTLE_MS;
  await hub.tick();
  assert.equal(s.builds, 1);
  assert.equal(ws.got.length, 1);

  // A print lands: built again and patched.
  s.stamp = 1;
  s.rows = [{ key: 'b', vol: 5 }, { key: 'a', vol: 1 }];
  s.now += THROTTLE_MS;
  await hub.tick();
  assert.equal(s.builds, 2);
  const p = ws.got[1]!;
  assert.equal(p.t, 'lp');
  assert.equal(p.seq, 2);
  held = apply(held, p.p as never);
  assert.deepEqual(held, { ok: true, ...windowOf(s.rows) });

  // Another print 100 ms later waits for the throttle.
  s.stamp = 2;
  s.rows = [{ key: 'b', vol: 6 }, { key: 'a', vol: 1 }];
  s.now += 100;
  await hub.tick();
  assert.equal(s.builds, 2, 'within THROTTLE_MS of the last check nothing is read');
  s.now += THROTTLE_MS;
  await hub.tick();
  assert.equal(s.builds, 3);
  held = apply(held, ws.got[2]!.p as never);
  assert.deepEqual(held, { ok: true, ...windowOf(s.rows) });
  assert.equal(ws.got[2]!.seq, 3);

  // No print for LIVE_REFRESH_MS: built anyway (an address resolved), but an equal answer sends nothing.
  s.now += LIVE_REFRESH_MS;
  await hub.tick();
  assert.equal(s.builds, 4);
  assert.equal(ws.got.length, 3);
});

test('viewers of one read share one build; a newcomer gets the whole answer at the current seq; leave cleans up', async () => {
  const { s, hub } = rig();
  const a = new FakeWs();
  const b = new FakeWs();
  hub.message(a, { op: 'live', id: 'x', path: '/api/vs/flow?coin=BTC' });
  await settle();
  s.stamp = 1;
  s.rows = [{ key: 'z', vol: 9 }];
  s.now += THROTTLE_MS;
  await hub.tick();
  hub.message(b, { op: 'live', id: 'y', path: '/api/vs/flow?coin=BTC' });
  assert.equal(s.builds, 2, 'the newcomer is answered from what is held');
  assert.deepEqual(b.got[0], { t: 'ls', id: 'y', seq: 2, body: { ok: true, ...windowOf(s.rows) } });
  s.stamp = 2;
  s.rows = [{ key: 'z', vol: 10 }];
  s.now += THROTTLE_MS;
  await hub.tick();
  assert.equal(s.builds, 3);
  assert.equal(a.got.at(-1)!.seq, 3);
  assert.equal(b.got.at(-1)!.seq, 3);
  assert.deepEqual(hub.size, { groups: 1, clients: 2 });
  hub.leave(a);
  hub.message(b, { op: 'live.off', id: 'y' });
  assert.deepEqual(hub.size, { groups: 0, clients: 0 });
});

test('a final window is never built again; cohorts go out again when the load changes', async () => {
  const { s, hub } = rig();
  const ws = new FakeWs();
  s.final = true;
  hub.message(ws, { op: 'live', id: 'f', path: '/api/vs/flow?coin=BTC' });
  hub.message(ws, { op: 'live', id: 'c', path: '/api/vs/cohorts' });
  await settle();
  assert.equal(s.builds, 1);
  assert.equal(s.cohortBuilds, 1);
  for (let i = 0; i < 5; i++) { s.stamp++; s.now += THROTTLE_MS; await hub.tick(); }
  assert.equal(s.builds, 1, 'final: nothing more is read');
  assert.equal(s.cohortBuilds, 1, 'the load did not change');
  s.loadAt = 2;
  s.cohort = { ok: true, cohorts: [{ id: 'whale', long: 2 }] };
  await hub.tick();
  assert.equal(s.cohortBuilds, 2);
  const p = ws.got.find((m) => m.t === 'lp' && m.id === 'c')!;
  assert.deepEqual(apply({ ok: true, cohorts: [{ id: 'whale', long: 1 }] }, p.p as never), s.cohort);
});

test('refused: a path that is not pushed, a bad query, too many subscriptions; a slow socket is skipped', async () => {
  const { s, hub } = rig();
  const ws = new FakeWs();
  hub.message(ws, { op: 'live', id: 'n', path: '/api/vs/leaderboard?x=1' });
  hub.message(ws, { op: 'live', id: 'b', path: '/api/vs/flow' });
  assert.deepEqual(ws.got.map((m) => [m.t, m.id]), [['le', 'n'], ['le', 'b']]);
  assert.equal(hub.message(ws, { op: 'sub', coin: 'BTC' }), false, 'the heatmap op is left to liqWs');
  for (let i = 0; i < MAX_SUBS; i++) hub.message(ws, { op: 'live', id: `s${i}`, path: `/api/vs/flow?coin=BTC&limit=${i + 1}` });
  hub.message(ws, { op: 'live', id: 'over', path: '/api/vs/flow?coin=ETH' });
  assert.equal(ws.got.at(-1)!.t, 'le');
  assert.equal(ws.got.at(-1)!.id, 'over');
  await settle();
  // A socket holding 4 MB unsent gets nothing more; its next patch shows it a gap and it asks again.
  const slow = new FakeWs();
  hub.message(slow, { op: 'live', id: 'q', path: '/api/vs/flow?coin=BTC' });
  await settle();
  assert.equal(slow.got.length, 1);
  slow.bufferedAmount = 5 * 1024 * 1024;
  s.stamp = 9;
  s.rows = [{ key: 'q', vol: 3 }];
  s.now += THROTTLE_MS;
  await hub.tick();
  assert.equal(slow.got.length, 1);
  // Drained, it asks again (the same id and path): the whole answer at the current seq.
  slow.bufferedAmount = 0;
  hub.message(slow, { op: 'live', id: 'q', path: '/api/vs/flow?coin=BTC' });
  assert.equal(slow.got.length, 2);
  assert.equal(slow.got[1]!.t, 'ls');
  assert.equal(slow.got[1]!.seq, 2);
});
