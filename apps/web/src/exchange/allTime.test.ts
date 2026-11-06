/**
 * All-time stats in the browser (allTime.ts): the server's answer from the
 * user's own reads, walked as the lowest-priority traffic there is - one page
 * per WALK_GAP_MS over every tab, `/trades` only with drip headroom left for
 * the fill panels, a shared pause after a rate limit - and one tab per scope.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normaliseTrade, type NormalRow } from '@sign/historyRows.js';
import type { ScopeState } from '@sign/historySync.js';
import { createAllTime, WALK_GAP_MS, WALK_PAUSE_MS, type AllTime, type AllTimeDeps } from './allTime';
import type { HistoryPersistence } from './historyDb';
import { GatewayClient, HISTORY_DRIP } from './sodexGateway';
import type { KeyValueStore, LedgerDeps, LockManagerLike } from './ledger';

const A = '0x48d98beb9dfce0a24f284e7653f05609b058ad96';
const ORIGIN = 'https://gw.test';
const TOP = 1_790_000_000_000;

function memStore(): KeyValueStore {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
}

/** Web Locks in one process: callbacks for one name run one after another. */
function fakeLocks(): LockManagerLike {
  const tails = new Map<string, Promise<unknown>>();
  return {
    request<T>(name: string, cb: () => Promise<T> | T): Promise<T> {
      const run = (tails.get(name) ?? Promise.resolve()).then(() => cb());
      tails.set(name, run.catch(() => undefined));
      return run;
    },
  };
}

/**
 * Virtual time: `sleep` parks on a timer, and `until(p)` runs everything that
 * can run, then jumps the clock to the next timer - so waits of minutes take no
 * real time, and every clock reading is the moment it would have happened.
 */
function virtualTime(start: number) {
  const timers: Array<{ at: number; fire: () => void }> = [];
  const clock = { t: start };
  const sleep = (ms: number) => new Promise<void>((fire) => void timers.push({ at: clock.t + Math.max(0, ms), fire }));
  async function until<T>(p: Promise<T>): Promise<T> {
    let settled = false;
    const out = p.finally(() => void (settled = true));
    out.catch(() => undefined);
    for (let guard = 0; !settled; guard++) {
      if (guard > 200_000) throw new Error('virtual time: runaway');
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      if (settled || timers.length === 0) continue;
      timers.sort((a, b) => a.at - b.at);
      const next = timers.shift()!;
      clock.t = Math.max(clock.t, next.at);
      next.fire();
    }
    return out;
  }
  return { clock, sleep, until };
}

/** IndexedDB stand-in, shared by the "tabs" of one test. */
class MemPersistence implements HistoryPersistence {
  states = new Map<string, ScopeState>();
  chunks = new Map<string, NormalRow[][]>();
  wallets = new Map<string, number>();
  status() {
    return { path: 'memory', ok: true, error: null };
  }
  async readState(scope: string) {
    return this.states.get(scope) ?? null;
  }
  async readScope(scope: string) {
    return { state: this.states.get(scope) ?? null, rows: (this.chunks.get(scope) ?? []).flat() };
  }
  async appendRows(scope: string, rows: NormalRow[]) {
    this.chunks.set(scope, [...(this.chunks.get(scope) ?? []), rows]);
  }
  async putState(scope: string, state: ScopeState) {
    this.states.set(scope, { ...state });
  }
  async dropScope(scope: string) {
    this.states.delete(scope);
    this.chunks.delete(scope);
  }
  async touchWallet(address: string) {
    this.wallets.set(address, this.wallets.size);
    return [];
  }
  async forgetWallet(address: string) {
    this.wallets.delete(address);
  }
  async compact() {}
}

/** One wallet's history on the fake venue, newest first. */
function history(n: number) {
  const fill = (engine: 'spot' | 'perps', i: number) => ({
    symbol: engine === 'spot' ? 'vBTC_vUSDC' : 'BTC-USD', tradeID: i, orderID: i, side: i % 2 ? 'SELL' : 'BUY',
    price: '2', quantity: '1.5', fee: '0.01', feeCoin: 'vUSDC', time: TOP - i * 1000, isMaker: i % 2 === 0,
  });
  return {
    spot: Array.from({ length: n }, (_, i) => fill('spot', i)),
    perps: Array.from({ length: n }, (_, i) => fill('perps', i)),
    fundings: Array.from({ length: n }, (_, i) => ({ symbol: 'BTC-USD', positionID: 1, positionSide: 'LONG', fundingFee: '-0.1', feeCoin: 'vUSDC', timestamp: TOP - i * 3_600_000 })),
  };
}

interface World {
  vt: ReturnType<typeof virtualTime>;
  clock: { t: number };
  store: KeyValueStore;
  locks: LockManagerLike;
  persistence: MemPersistence;
  venue: ReturnType<typeof history>;
  /** Paths that fail the way Cloudflare's 1015 does in a browser (no readable answer). */
  blocked: RegExp | null;
}

interface Tab {
  at: AllTime;
  client: GatewayClient;
  calls: Array<{ path: string; t: number }>;
}

function world(n = 5): World {
  const vt = virtualTime(TOP + 60_000);
  return { vt, clock: vt.clock, store: memStore(), locks: fakeLocks(), persistence: new MemPersistence(), venue: history(n), blocked: null };
}

const page = (rows: Array<Record<string, unknown>>, q: URLSearchParams, timeKey: string) => {
  const end = q.get('endTime') ? Number(q.get('endTime')) : Infinity;
  const start = q.get('startTime') ? Number(q.get('startTime')) : -Infinity;
  return rows.filter((r) => (r[timeKey] as number) <= end && (r[timeKey] as number) >= start).slice(0, Number(q.get('limit') ?? 100));
};

function tab(w: World, seed?: AllTimeDeps['seed']): Tab {
  const ledger: LedgerDeps = { store: w.store, locks: null, now: () => w.clock.t, sleep: w.vt.sleep };
  const calls: Tab['calls'] = [];
  const fetchImpl = (async (input: string | URL) => {
    const url = new URL(String(input));
    const path = url.pathname + url.search;
    calls.push({ path, t: w.clock.t });
    if (w.blocked?.test(path)) throw new TypeError('Failed to fetch');
    const ok = (data: unknown) => new Response(JSON.stringify({ code: 0, data }), { status: 200 });
    let m: RegExpMatchArray | null;
    if ((m = url.pathname.match(/\/api\/v1\/(spot|perps)\/accounts\/0x[0-9a-f]+\/trades$/i))) return ok(page(w.venue[m[1] as 'spot' | 'perps'], url.searchParams, 'time'));
    if (/\/fundings$/.test(url.pathname)) return ok(page(w.venue.fundings, url.searchParams, 'timestamp'));
    if (/\/state$/.test(url.pathname)) return ok({ aid: 7 });
    return new Response(JSON.stringify({ code: 404, message: 'not found' }), { status: 404 });
  }) as typeof fetch;
  const client = new GatewayClient({ deps: ledger, fetchImpl, origin: () => ORIGIN, now: () => w.clock.t });
  const at = createAllTime({
    gateway: client,
    dataGet: async <T>(path: string): Promise<T> => {
      if (path.includes('overview')) return { ts_ms: TOP, cumulative_pnl: '42.5', unrealized_pnl: '1', cumulative_quote_volume: '900' } as T;
      return { items: [{ ts_ms: TOP - 86_400_000, pnl: '40' }, { ts_ms: TOP, pnl: '42.5' }] } as T;
    },
    symbols: async (e) => (e === 'spot' ? [{ name: 'vBTC_vUSDC', quoteCoin: 'vUSDC' }] : [{ name: 'BTC-USD', quoteCoin: 'vUSDC' }]),
    persistence: w.persistence,
    locks: w.locks,
    ledger,
    seed,
  });
  return { at, client, calls };
}

const walkCalls = (t: Tab) => t.calls.filter((c) => /\/(trades|fundings)\?/.test(c.path));

/** Let a tab's walks run to their end (in virtual time). */
async function settle(w: World, at: AllTime) {
  await w.vt.until((async () => {
    for (const k of ['trades-spot', 'trades-perps', 'funding'] as const) await at.sync.settled(k, A);
    // Trades show after one short page; the read that confirms it comes with the next look. A look may also find a
    // scope past its freshness in virtual time, and catch up.
    for (let i = 0; i < 6 && (await at.stats(A)).sync.running; i++) {
      for (const k of ['trades-spot', 'trades-perps', 'funding'] as const) await at.sync.settled(k, A);
    }
    await at.flush();
  })());
}

const statsOf = (w: World, t: Tab) => w.vt.until(t.at.stats(A));

test('all-time: the server\'s answer, walked from the browser one page per gap over every scope', async () => {
  const w = world(5);
  const t = tab(w);
  const first = await statsOf(w, t);
  assert.equal(first.sync.running, true, 'the walks start at once and the panel polls');
  await settle(w, t.at);
  const s = await statsOf(w, t);

  assert.equal(s.sync.running, false);
  for (const k of ['trades-spot', 'trades-perps', 'funding']) {
    assert.equal(s.sync.scopes[k]!.status, 'done', k);
    assert.equal(s.sync.scopes[k]!.complete, true, k);
  }
  assert.equal(s.trades.perps.count, 5);
  assert.deepEqual(s.trades.perps.fees, [{ coin: 'vUSDC', amount: '0.05', count: 5 }], 'fees per coin, exact');
  assert.deepEqual(s.trades.spot.volume, [{ coin: 'vUSDC', amount: '15', count: 5 }], '2 x 1.5 each, in the quote coin');
  assert.deepEqual(s.funding.totals, [{ coin: 'vUSDC', amount: '-0.5', count: 5 }], 'the venue\'s sign, unmodified');
  assert.equal(s.headline.available, true);
  assert.equal(s.headline.accountId, 7);
  assert.equal(s.headline.cumulativePnl, '42.5');
  assert.equal(s.headline.curve.length, 2);
  assert.match(s.headline.provenance, /PERPS ONLY/);
  assert.equal(s.spotRealizedPnl.value, null);

  const walked = walkCalls(t);
  assert.equal(walked.filter((c) => !c.path.includes('startTime=')).length, 6, 'each scope: one page, then the read that confirms the end');
  for (let i = 1; i < walked.length; i++) {
    assert.ok(walked[i]!.t - walked[i - 1]!.t >= WALK_GAP_MS, `walk pages ${WALK_GAP_MS} ms apart (${walked[i]!.t - walked[i - 1]!.t})`);
  }
  assert.equal(t.client.lastGood(walked[0]!.path), null, 'walk pages are not kept as last-good copies');

  // Stored, so the next tab (or the next visit) answers without walking.
  assert.equal(w.persistence.chunks.get(`trades-perps|${A.toLowerCase()}`)?.flat().length, 5);
  const later = tab(w);
  const again = await statsOf(w, later);
  assert.equal(again.trades.perps.count, 5);
  assert.equal(again.sync.running, false);
  assert.equal(walkCalls(later).length, 0, 'a fresh, complete history is not walked again');
});

test('summary: a wallet the server already read has its figures at once, and only newer rows are read after', async () => {
  const w = world(5);
  const rows = (w.venue.perps as Array<Record<string, unknown>>).map((r) => normaliseTrade(r));
  const newest = Math.max(...rows.map((r) => r.time));
  const seeded = (age: number): AllTimeDeps['seed'] => async (kind) => ({
    state: { oldest: 1, newest: kind === 'trades-perps' ? newest : null, complete: true, pages: 1, updatedAt: w.clock.t - age, lastError: null, syncedAt: w.clock.t - age },
    rows: kind === 'trades-perps' ? rows : [],
  });
  const t = tab(w, seeded(0));
  const a = await w.vt.until(t.at.activity(A, 'perps', 1));
  assert.equal(a.tradesCover.state, 'final');
  assert.equal(a.trades?.trades, 5);
  assert.equal(walkCalls(t).length, 0, 'nothing to read: the server read it just now');
  await w.vt.until(t.at.flush());
  assert.equal(w.persistence.chunks.get(`trades-perps|${A.toLowerCase()}`)?.flat().length, 5, 'kept for the next visit');

  const w2 = world(5);
  const t2 = tab(w2, async (kind) => ({
    state: { oldest: 1, newest: kind === 'trades-perps' ? newest : null, complete: true, pages: 1, updatedAt: w2.clock.t - 3 * 3_600_000, lastError: null, syncedAt: w2.clock.t - 3 * 3_600_000 },
    rows: kind === 'trades-perps' ? rows : [],
  }));
  const stale = await w2.vt.until(t2.at.activity(A, 'perps', 1));
  assert.equal(stale.trades, null, 'hours old: no figure until the newest rows are in');
  await settle(w2, t2.at);
  const fresh = await w2.vt.until(t2.at.activity(A, 'perps', 1));
  assert.equal(fresh.trades?.trades, 5);
  const perpsReads = walkCalls(t2).filter((c) => c.path.includes('/perps/') && c.path.includes('/trades'));
  assert.ok(perpsReads.every((c) => c.path.includes('startTime=')), 'only what is newer');
});

test('summary: when the server has nothing, the browser walks by itself', async () => {
  const w = world(5);
  const t = tab(w, async () => { throw new Error('offline'); });
  await w.vt.until(t.at.activity(A, 'perps', 1));
  await settle(w, t.at);
  const a = await w.vt.until(t.at.activity(A, 'perps', 1));
  assert.equal(a.trades?.trades, 5);
});

test('all-time: a /trades walk page waits until the fill panels have drip slots left', async () => {
  const w = world(3);
  const t = tab(w);
  const t0 = w.clock.t;
  // An interactive history read just went out.
  await t.client.historyDrip.charge(1);
  await statsOf(w, t);
  await settle(w, t.at);
  const firstTrades = walkCalls(t).find((c) => c.path.includes('/trades?'))!;
  assert.ok(firstTrades.t >= t0 + HISTORY_DRIP.windowMs, 'no walk page while the panels have read history this minute');
  assert.ok(walkCalls(t)[0]!.path.includes('/fundings?'), 'funding (not dripped) went first');
  assert.ok(t.client.historyDrip.spent() <= HISTORY_DRIP.max);
});

test('all-time: a walk page SoDEX refuses pauses every tab\'s walks, with no retry', async () => {
  const w = world(3);
  w.blocked = /\/trades\?/;
  const t = tab(w);
  await statsOf(w, t);
  await settle(w, t.at);
  const stored = (k: string) => w.persistence.states.get(`${k}|${A.toLowerCase()}`);
  for (const k of ['trades-spot', 'trades-perps']) {
    assert.match(stored(k)?.lastError ?? '', /rate|paused/i, k);
    assert.equal(stored(k)?.complete, false, `${k}: a refused page is never the end of history`);
  }
  const tradesTried = walkCalls(t).filter((c) => c.path.includes('/trades?')).length;
  assert.equal(tradesTried, 1, 'one refused page, never replayed');

  // Another tab (same browser): its walks do not even ask.
  w.blocked = null;
  w.clock.t += 60_000;
  const other = tab(w);
  await statsOf(w, other);
  await settle(w, other.at);
  assert.equal(walkCalls(other).filter((c) => c.path.includes('/trades?')).length, 0, 'paused for every tab');
  assert.match(stored('trades-perps')?.lastError ?? '', /paused/i);

  // After the pause, the walks resume.
  w.clock.t += WALK_PAUSE_MS;
  await statsOf(w, other);
  await settle(w, other.at);
  const done = await statsOf(w, other);
  assert.equal(done.trades.perps.count, 3);
  assert.equal(done.sync.scopes['trades-perps']!.complete, true);
});

test('all-time: two tabs, one walk - the other waits, shows it as running, then reads what was stored', async () => {
  const w = world(4);
  const one = tab(w);
  const two = tab(w);
  await statsOf(w, one);
  const waiting = await statsOf(w, two);
  assert.equal(waiting.sync.running, true, 'the second tab shows the walk as running');
  await settle(w, one.at);
  await settle(w, two.at);
  const s = await statsOf(w, two);
  assert.equal(s.trades.spot.count, 4);
  assert.equal(s.funding.count, 4);
  assert.equal(s.sync.running, false);
  assert.ok(walkCalls(two).filter((c) => !c.path.includes('startTime=')).length <= 2, 'the second tab did not walk the history again');
});

test('all-time: a bad address is refused before anything is read', async () => {
  const t = tab(world());
  await assert.rejects(t.at.stats('0x123'), (e: { status?: number }) => e.status === 400);
  assert.equal(t.calls.length, 0);
});
