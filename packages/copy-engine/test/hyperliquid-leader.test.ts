/**
 * Following a Hyperliquid leader: trade.xyz (HIP-3) positions through the reconcile, the
 * firehose coin list, the leader's equity for proportional sizing, `startPosition` and
 * the seed time on Hyperliquid's clock.
 */
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CopyRuntime,
  HL_COINS_REFRESH_MS,
  HL_COINS_RETRY_MS,
  HL_MODE_RECHECK_MS,
  HL_WS_URL,
  HyperliquidClient,
  HyperliquidFeed,
  LeaderBook,
  MemoryStore,
  PaperSink,
  SodexClient,
  hlSpotCollateral,
  regionPolicy,
  type FetchLike,
  type LeaderEvent,
  type Logger,
  type WebSocketLike,
} from '../src/index.ts';
import { FOLLOWER, sub } from './helpers.ts';

const HL = '0x3333333333333333333333333333333333333333';
const ref = { venue: 'hyperliquid' as const, address: HL };
const quiet: Logger = { debug() {}, info() {}, warn() {}, error() {} };

class FakeWs implements WebSocketLike {
  static all: FakeWs[] = [];
  readyState = 0;
  sent: unknown[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(readonly url: string) {
    FakeWs.all.push(this);
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.({});
    }, 1);
  }
  send(d: string): void {
    this.sent.push(JSON.parse(d));
  }
  close(): void {
    this.readyState = 3;
  }
  push(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}
const hlWs = () => FakeWs.all.filter((x) => x.url === HL_WS_URL).at(-1);

/* ------------------------------------------------- a fake Hyperliquid info API ----- */

type Answer<T> = T | number; // a number: the HTTP status it answers with
interface HlWorld {
  /** dex ('' = main) -> its clearinghouseState: positions [coin, szi, mark]. */
  states: Record<string, Answer<{ positions?: Array<[string, number, number]>; accountValue: string; time?: number }>>;
  spot: Answer<{ balances: Array<{ coin: string; total: string }>; unified?: boolean }>;
  spotPx?: Answer<Record<string, number>>;
  dexes?: Answer<string[]>;
  metas?: Record<string, Answer<string[]>>;
  calls: Array<{ type: string; dex?: string }>;
}

const world = (o: Partial<HlWorld> = {}): HlWorld => ({
  states: { '': { accountValue: '100000' }, xyz: { accountValue: '0' } },
  spot: { balances: [] },
  calls: [],
  ...o,
});

const ok = (data: unknown) => ({ status: 200, ok: true, text: async () => JSON.stringify(data) });
const fail = (status: number) => ({ status, ok: false, text: async () => 'refused' });

function hlAnswer(w: HlWorld, body: { type: string; dex?: string }) {
  w.calls.push({ type: body.type, ...(body.dex ? { dex: body.dex } : {}) });
  const dex = body.dex ?? '';
  if (body.type === 'clearinghouseState') {
    const st = w.states[dex];
    if (st === undefined) return ok({ marginSummary: { accountValue: '0' }, assetPositions: [], time: Date.now() });
    if (typeof st === 'number') return fail(st);
    return ok({
      marginSummary: { accountValue: st.accountValue },
      assetPositions: (st.positions ?? []).map(([coin, szi, px]) => ({ position: { coin, szi: String(szi), positionValue: String(Math.abs(szi * px)) } })),
      time: st.time ?? Date.now(),
    });
  }
  if (body.type === 'spotClearinghouseState') {
    if (typeof w.spot === 'number') return fail(w.spot);
    return ok({ balances: w.spot.balances, ...(w.spot.unified ? { tokenToAvailableAfterMaintenance: [[0, '1.0']] } : {}) });
  }
  if (body.type === 'spotMetaAndAssetCtxs') {
    const px = w.spotPx ?? {};
    if (typeof px === 'number') return fail(px);
    const names = Object.keys(px);
    return ok([
      { tokens: [{ name: 'USDC', index: 0 }, ...names.map((name, i) => ({ name, index: i + 1 }))], universe: names.map((_, i) => ({ tokens: [i + 1, 0], index: i })) },
      names.map((n) => ({ markPx: String(px[n]) })),
    ]);
  }
  if (body.type === 'perpDexs') {
    const d = w.dexes ?? ['xyz'];
    return typeof d === 'number' ? fail(d) : ok([null, ...d.map((name) => ({ name }))]);
  }
  if (body.type === 'meta') {
    const m = w.metas?.[dex] ?? [];
    return typeof m === 'number' ? fail(m) : ok({ universe: m.map((name) => ({ name })) });
  }
  return fail(404);
}

/** SoDEX (two markets: BTC-USD and TSLA-USD) and Hyperliquid's info endpoint. */
function fakeFetch(w: HlWorld): FetchLike {
  const env = (data: unknown) => ok({ code: 0, timestamp: Date.now(), data });
  return async (url, init) => {
    if (url === 'https://api.hyperliquid.xyz/info') return hlAnswer(w, JSON.parse(init?.body ?? '{}'));
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    const market = (id: number, name: string, base: string, tick: string, step: string) => ({
      id, name, baseCoin: base, tickSize: tick, stepSize: step, minQuantity: step, maxQuantity: '100000', minNotional: '10', maxNotional: '5000000',
      maxLeverage: 20, buyLimitUpRatio: '0.05', sellLimitDownRatio: '0.05', takerFee: '0.0004', status: 'TRADING',
    });
    if (path === '/api/v1/perps/markets/symbols') return env([market(1, 'BTC-USD', 'BTC', '1', '0.00001'), market(2, 'TSLA-USD', 'TSLA', '0.01', '0.001')]);
    if (path === '/api/v1/perps/markets/mark-prices') return env([{ symbol: 'BTC-USD', markPrice: '80000' }, { symbol: 'TSLA-USD', markPrice: '400' }]);
    if (path === `/api/v1/perps/accounts/${FOLLOWER}/state`) return env({ aid: 42, av: '5000', am: '5000', P: [] });
    return fail(404);
  };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await wait(10);
  }
}

function runtime(w: HlWorld, o: { hlMode?: 'user' | 'firehose'; log?: Logger } = {}) {
  const fetch = fakeFetch(w);
  const store = new MemoryStore();
  const paper = new PaperSink();
  const rt = new CopyRuntime({
    confirmGapMs: 0,
    store,
    sodex: new SodexClient({ network: 'mainnet', fetch }),
    hyperliquid: new HyperliquidClient(fetch),
    factory: (url) => new FakeWs(url),
    network: 'mainnet',
    hlMode: o.hlMode ?? 'user',
    sinkFor: () => paper,
    builderFor: async () => null,
    policyFor: (s) => regionPolicy(s.country, s.observedCountry),
    log: o.log ?? quiet,
  });
  /** One reconcile that really runs (not one skipped because a background one is under way). */
  const reconcile = async () => {
    await until(() => !(rt as unknown as { reconciling: boolean }).reconciling);
    await rt.reconcileAll();
  };
  return { rt, store, reconcile };
}

let tid = 0;
const fill = (coin: string, side: 'B' | 'A', sz: number, px: number, start: number, time = Date.now()) => ({
  coin, side, sz: String(sz), px: String(px), startPosition: String(start), time, tid: ++tid, oid: tid,
});
const userFills = (...fills: unknown[]) => ({ channel: 'userFills', data: { user: HL, isSnapshot: false, fills } });

/* ----------------------------------------------------- 1. the leader's read ----- */

test('leaderPositions reads the main dex and trade.xyz and merges them; a standard account counts both account values', async () => {
  const t0 = Date.now() - 2_000;
  const w = world({
    states: {
      '': { positions: [['BTC', 1, 80_000]], accountValue: '60000', time: t0 + 5 },
      xyz: { positions: [['xyz:TSLA', -10, 400]], accountValue: '40000', time: t0 },
    },
  });
  const r = await new HyperliquidClient(fakeFetch(w)).leaderPositions(HL);
  assert.deepEqual(r.positions, { BTC: 1, 'xyz:TSLA': -10 });
  assert.deepEqual(r.marks, { BTC: 80_000, 'xyz:TSLA': 400 });
  assert.equal(r.equity, 100_000);
  assert.deepEqual(r.dexes, ['', 'xyz']);
  assert.equal(r.partial, false);
  assert.equal(r.asOf, t0 + 5, "the latest of the dexes' answers, on Hyperliquid's clock");
  assert.ok(w.calls.some((c) => c.type === 'clearinghouseState' && c.dex === 'xyz'));
});

test('a dex that cannot be read is left out (partial, no equity); the main dex failing throws', async () => {
  const w = world({ states: { '': { positions: [['BTC', 1, 80_000]], accountValue: '60000' }, xyz: 400 } });
  const r = await new HyperliquidClient(fakeFetch(w)).leaderPositions(HL);
  assert.deepEqual(r.positions, { BTC: 1 });
  assert.deepEqual(r.dexes, ['']);
  assert.equal(r.partial, true);
  assert.equal(r.equity, null, 'the main dex alone would count the equity short and size copies too large');

  w.states[''] = 400;
  await assert.rejects(new HyperliquidClient(fakeFetch(w)).leaderPositions(HL));
});

test("a unified account's equity is its spot collateral, not the margin in use on each dex", async () => {
  const w = world({
    states: { '': { positions: [['BTC', 1, 80_000]], accountValue: '8000' }, xyz: { accountValue: '1500' } },
    spot: { unified: true, balances: [{ coin: 'USDC', total: '90000' }, { coin: 'HYPE', total: '250' }] },
    spotPx: { HYPE: 40 },
  });
  const hl = new HyperliquidClient(fakeFetch(w));
  assert.equal((await hl.leaderPositions(HL)).equity, 100_000);
  assert.equal((await hl.leaderPositions(HL)).equity, 100_000);
  assert.equal(w.calls.filter((c) => c.type === 'spotClearinghouseState').length, 2, "a unified account's spot is read every time");
  assert.equal(w.calls.filter((c) => c.type === 'spotMetaAndAssetCtxs').length, 1, 'spot prices are kept a while');

  // Without prices the HYPE cannot be valued: no equity rather than one counted short.
  const w2 = world({ ...w, calls: [], spotPx: 400 });
  assert.equal((await new HyperliquidClient(fakeFetch(w2)).leaderPositions(HL)).equity, null);
  // Nor when the spot state cannot be read and the account's mode is not known.
  const w3 = world({ ...w, calls: [], spot: 400 });
  assert.equal((await new HyperliquidClient(fakeFetch(w3)).leaderPositions(HL)).equity, null);
});

test("a standard account's spot state is read once per HL_MODE_RECHECK_MS", async () => {
  const w = world({ spot: { balances: [{ coin: 'USDC', total: '50000' }] } });
  const hl = new HyperliquidClient(fakeFetch(w));
  const now = Date.now();
  assert.equal((await hl.leaderPositions(HL, undefined, now)).equity, 100_000, 'its spot is not perps margin');
  await hl.leaderPositions(HL, undefined, now + 60_000);
  assert.equal(w.calls.filter((c) => c.type === 'spotClearinghouseState').length, 1);
  await hl.leaderPositions(HL, undefined, now + HL_MODE_RECHECK_MS);
  assert.equal(w.calls.filter((c) => c.type === 'spotClearinghouseState').length, 2);
});

test('hlSpotCollateral: stablecoins at $1, tokens at their price, null for a standard account or without prices', () => {
  const unified = { tokenToAvailableAfterMaintenance: [[0, '1']] as Array<[number, string]> };
  const balances = [{ coin: 'USDC', total: '1000' }, { coin: 'USDT0', total: '500' }, { coin: 'HYPE', total: '10' }, { coin: 'DUST', total: '3' }];
  assert.equal(hlSpotCollateral({ balances }, new Map([['HYPE', 40]])), null);
  assert.equal(hlSpotCollateral({ ...unified, balances }, new Map([['HYPE', 40]])), 1_900, 'a token without a USDC pair counts 0');
  assert.equal(hlSpotCollateral({ ...unified, balances }, null), null);
  assert.equal(hlSpotCollateral({ ...unified, balances: balances.slice(0, 2) }, null), 1_500);
});

/* ------------------------------------------------------------ 2. the book ----- */

test('a reconcile never zeroes a market on a dex it did not read; one that read the dex does', () => {
  const book = new LeaderBook();
  const at = Date.now();
  book.resync(ref, { positions: {}, equity: 1_000, marks: {}, dexes: ['', 'xyz'], partial: false }, at, () => 400);
  book.applyTotal(ref, 'xyz:TSLA', 0, 10, 400, at, 'hl:xyz:TSLA:1');
  book.applyTotal(ref, 'flx:FOO', 0, 5, 1, at, 'hl:flx:FOO:2');
  // trade.xyz did not answer; flx was never asked for.
  let events = book.resync(ref, { positions: {}, equity: null, marks: {}, dexes: [''], partial: true }, at + 60_000, () => 400, at + 59_000);
  assert.deepEqual(events, []);
  assert.equal(book.position(ref, 'xyz:TSLA'), 10);
  assert.equal(book.position(ref, 'flx:FOO'), 5);
  assert.equal(book.equity(ref)?.value, 1_000, 'the last known equity is kept');
  // trade.xyz read, the leader flat there (a close the stream missed): reconciled.
  events = book.resync(ref, { positions: {}, equity: 1_000, marks: {}, dexes: ['', 'xyz'], partial: false }, at + 120_000, () => 400, at + 119_000);
  assert.deepEqual(events?.map((e) => [e.symbol, e.before, e.after, e.source]), [['xyz:TSLA', 10, 0, 'reconcile']]);
  assert.equal(book.position(ref, 'flx:FOO'), 5);
});

test("a read that missed a dex does not seed; the seed takes the venue's clock", () => {
  const book = new LeaderBook();
  const now = Date.now();
  assert.equal(book.resync(ref, { positions: { BTC: 1 }, equity: null, marks: {}, dexes: [''], partial: true }, now, () => null), null);
  assert.equal(book.seeded(ref), false);
  assert.deepEqual(book.resync(ref, { positions: { BTC: 1 }, equity: 5, marks: {}, dexes: ['', 'xyz'], partial: false, asOf: now - 3_000 }, now, () => null), []);
  assert.equal(book.seedTime(ref), now - 3_000 + 1, 'just after the answer: a print at its time is in it');
  const other = { venue: 'hyperliquid' as const, address: '0x4444444444444444444444444444444444444444' };
  book.resync(other, { positions: {}, equity: 5, marks: {}, asOf: now - 3_600_000 }, now, () => null);
  assert.equal(book.seedTime(other), now, 'a venue time far off the local clock is not taken');
});

test("applyTotal: the source's own position before the change is the event's; a change the book already has is none", () => {
  const book = new LeaderBook();
  book.resync(ref, { positions: {}, equity: 5, marks: {} }, Date.now(), () => null);
  // The book missed an open of 5: the leader went 5 -> 3 (a reduction), not 0 -> 3 (an open).
  const e = book.applyTotal(ref, 'BTC', 5, 3, 80_000, Date.now(), 'f1');
  assert.deepEqual([e?.before, e?.after], [5, 3]);
  assert.equal(book.applyTotal(ref, 'BTC', 2, 3, 80_000, Date.now(), 'f2'), null);
});

/* ---------------------------------------------------- 3. the userFills stream ----- */

test("userFills: fills count from the seed on Hyperliquid's clock, with startPosition as the position before", async () => {
  const book = new LeaderBook();
  const events: LeaderEvent[] = [];
  const warned: string[] = [];
  const hlNow = Date.now() - 5_000; // Hyperliquid's clock 5 s behind this one
  book.resync(ref, { positions: { BTC: 2 }, equity: 5, marks: {}, dexes: ['', 'xyz'], partial: false, asOf: hlNow }, Date.now(), () => null);
  const feed = new HyperliquidFeed({
    factory: (url) => new FakeWs(url),
    book,
    mode: 'user',
    sink: { leader: (e) => events.push(e) },
    log: { ...quiet, warn: (m) => warned.push(m) },
  });
  feed.setLeaders([ref]);
  feed.start();
  await until(() => hlWs()?.readyState === 1);
  assert.ok(hlWs()!.sent.some((m) => JSON.stringify(m).includes('"userFills"')));
  hlWs()!.push(userFills(fill('BTC', 'B', 1, 80_000, 1, hlNow - 1))); // in the seed already
  hlWs()!.push(userFills(fill('BTC', 'B', 1, 80_000, 2, hlNow + 1_000))); // after it by HL's clock, before it by ours
  hlWs()!.push(userFills(fill('xyz:TSLA', 'A', 4, 400, 0, hlNow + 2_000)));
  assert.deepEqual(events.map((e) => [e.symbol, e.before, e.after]), [['BTC', 2, 3], ['xyz:TSLA', 0, -4]]);
  hlWs()!.push({ channel: 'error', data: 'Cannot track more than 10 total users.' });
  assert.equal(warned.filter((m) => m.includes('refused')).length, 1);
  feed.stop();
});

/* ------------------------------------------------------------ 4. the runtime ----- */

test('a trade.xyz position the stream copied stays open across reconciles (and one dex failing); closed when the leader is flat there', async () => {
  const w = world();
  const { rt, reconcile } = runtime(w);
  await rt.start();
  const s = await rt.add(sub({ paper: true, leader: ref }, { id: 'x1' }));
  await until(() => hlWs()?.readyState === 1);
  w.states.xyz = { positions: [['xyz:TSLA', 10, 400]], accountValue: '0' };
  hlWs()!.push(userFills(fill('xyz:TSLA', 'B', 10, 400, 0)));
  await until(() => (rt.view(s.id)?.positions.length ?? 0) === 1);
  // 4,000 of a 100,000 leader on a 1,000 copy: 40 USD, 0.1 TSLA.
  assert.deepEqual(rt.view(s.id)!.positions.map((p) => [p.symbol, p.size]), [['TSLA-USD', 0.1]]);

  await reconcile();
  w.states.xyz = 400;
  await reconcile();
  await wait(100);
  assert.deepEqual(rt.view(s.id)!.positions.map((p) => [p.symbol, p.size]), [['TSLA-USD', 0.1]]);
  assert.deepEqual(rt.view(s.id)!.leader.positions, { 'xyz:TSLA': 10 });

  w.states.xyz = { positions: [], accountValue: '0' };
  await reconcile();
  await until(() => rt.view(s.id)!.positions.length === 0);
  await rt.stop();
});

test('a copy started while the leader could not be read treats what it holds as pre-existing once it can: only its add is copied', async () => {
  const w = world({ states: { '': 400, xyz: { accountValue: '0' } } });
  const { rt, store, reconcile } = runtime(w);
  await rt.start();
  const s = await rt.add(sub({ paper: true, leader: ref }, { id: 'x2' }));
  assert.equal(rt.leaders.seeded(ref), false);
  w.states[''] = { positions: [['BTC', 1, 80_000]], accountValue: '100000' };
  await reconcile();
  assert.equal(rt.leaders.seeded(ref), true);
  await until(() => hlWs()?.readyState === 1);
  hlWs()!.push(userFills(fill('BTC', 'B', 1, 80_000, 1)));
  await until(() => rt.view(s.id)!.leader.positions.BTC === 2);
  // The add is copied with its own share (owner 2026-11-18), the part held before is not joined.
  await until(() => rt.view(s.id)!.positions.length === 1);
  assert.equal(rt.view(s.id)!.positions.length, 1, 'the add to a position held before the copy started is copied');
  const skipped = (await store.activity({ subId: s.id })).some((e) => e.kind === 'skip' && e.reason === 'pre-existing-position');
  assert.equal(skipped, false);
  await rt.stop();
});

test("proportional copies of a unified leader are sized by its spot collateral", async () => {
  const w = world({
    states: { '': { accountValue: '8000' }, xyz: { accountValue: '0' } },
    spot: { unified: true, balances: [{ coin: 'USDC', total: '100000' }] },
  });
  const { rt } = runtime(w);
  await rt.start();
  const s = await rt.add(sub({ paper: true, leader: ref }, { id: 'x3' }));
  assert.equal(rt.view(s.id)!.leader.equity, 100_000);
  await until(() => hlWs()?.readyState === 1);
  hlWs()!.push(userFills(fill('BTC', 'B', 1, 80_000, 0)));
  await until(() => (rt.view(s.id)?.positions.length ?? 0) === 1);
  // 80,000 of a 100,000 leader on a 1,000 copy: 0.01 BTC (by the 8,000 in use, 0.03125 at the 2,500 cap).
  assert.equal(rt.view(s.id)!.positions[0]!.size, 0.01);
  await rt.stop();
});

test('firehose: trade.xyz and other HIP-3 coins are followed; a failed coin list is retried, and the list is read again', async () => {
  const w = world({ metas: { '': 400, xyz: 400 }, dexes: ['xyz', 'flx'] });
  const errors: string[] = [];
  const { rt } = runtime(w, { hlMode: 'firehose', log: { ...quiet, error: (m) => errors.push(m) } });
  await rt.start();
  const flush = async () => {
    for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
  };
  const traded = () => (hlWs()?.sent ?? []).flatMap((m) => {
    const sub = (m as { subscription?: { type?: string; coin?: string } }).subscription;
    return sub?.type === 'trades' && sub.coin ? [sub.coin] : [];
  });
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await rt.add(sub({ paper: true, leader: ref }, { id: 'x4' }));
    await flush();
    mock.timers.tick(1); // the socket opens
    await flush();
    assert.ok(errors.some((e) => e.includes('coin list is empty')));
    assert.deepEqual(traded(), []);

    w.metas = { '': ['BTC', 'DOGE'], xyz: ['xyz:TSLA'], flx: ['flx:GOLD'] };
    // The retry was planned when the copy started, 1 ms before the socket opened.
    mock.timers.tick(HL_COINS_RETRY_MS - 2);
    await flush();
    assert.deepEqual(traded(), []);
    mock.timers.tick(1);
    await flush();
    assert.deepEqual(traded().slice(0, 2).sort(), ['BTC', 'xyz:TSLA'], 'the coins SoDEX lists come first');
    assert.deepEqual(traded().sort(), ['BTC', 'DOGE', 'flx:GOLD', 'xyz:TSLA']);

    // A new listing is picked up at the next read.
    w.metas.xyz = ['xyz:TSLA', 'xyz:NVDA'];
    mock.timers.tick(HL_COINS_REFRESH_MS - 1);
    await flush();
    assert.ok(!traded().includes('xyz:NVDA'));
    mock.timers.tick(1);
    await flush();
    assert.ok(traded().includes('xyz:NVDA'));
    assert.equal(traded().filter((c) => c === 'BTC').length, 1, 'nothing is subscribed twice');
  } finally {
    mock.timers.reset();
    await rt.stop();
  }
});
