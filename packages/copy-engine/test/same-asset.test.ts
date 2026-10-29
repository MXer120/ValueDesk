/**
 * Same asset only: a Hyperliquid market is copied onto the SoDEX market of its name only
 * while the two venues price one coin alike (MarketBook.sameAsset). A different asset is
 * not opened or added to; a position already copied there always follows the leader's
 * reductions and closes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ASSET_PRICE_MAX_AGE_MS,
  CopyRuntime,
  HL_WS_URL,
  HyperliquidClient,
  MarketBook,
  MemoryStore,
  PaperSink,
  SKIP_REASONS,
  SodexClient,
  planLeaderEvent,
  regionPolicy,
  type EngineNotice,
  type FetchLike,
  type Logger,
  type MarketInfo,
  type PlanContext,
  type SubState,
  type WebSocketLike,
} from '../src/index.ts';
import { BTC, FOLLOWER, ev, marks, state, sub } from './helpers.ts';

const mkt = (name: string, over: Partial<MarketInfo> = {}): MarketInfo => ({ ...BTC, name, base: name.replace(/-USD$/, ''), ...over });
const GOLD = mkt('GOLD-USD', { id: 3, tickSize: '0.1', stepSize: '0.001', minQuantity: '0.001' });

/* ------------------------------------------------------------ 1. the check ----- */

test('a ticker two assets share: xyz:GOLD far from GOLD-USD is a different asset, and the same again once the prices meet', () => {
  const book = new MarketBook();
  book.load([GOLD]);
  const t = 1_000_000;
  book.setMark('GOLD-USD', 3_900, t);
  book.observeLeaderPrice('hyperliquid', 'xyz:GOLD', 2_450, t);
  const v = book.sameAsset('hyperliquid', 'xyz:GOLD', t);
  assert.equal(v?.same, false);
  assert.equal(v?.market, 'GOLD-USD');
  assert.equal(Number(v!.deviation.toFixed(3)), -0.372);

  // 4% apart: inside the band, the last verdict stands (no flip at the line).
  book.setMark('GOLD-USD', 2_550, t + 1_000);
  book.observeLeaderPrice('hyperliquid', 'xyz:GOLD', 2_450, t + 1_000);
  assert.equal(book.sameAsset('hyperliquid', 'xyz:GOLD', t + 1_000)?.same, false);
  // Under 3%: the same again.
  book.setMark('GOLD-USD', 2_500, t + 2_000);
  assert.equal(book.sameAsset('hyperliquid', 'xyz:GOLD', t + 2_000)?.same, true);
  // And 4% from there stays the same: the first look at 4% is the same too.
  book.setMark('GOLD-USD', 2_550, t + 3_000);
  assert.equal(book.sameAsset('hyperliquid', 'xyz:GOLD', t + 3_000)?.same, true);
  // A SoDEX leader trades SoDEX's own market: never checked.
  assert.equal(book.sameAsset('sodex', 'GOLD-USD', t), null);
});

test('kPEPE against 1000PEPE-USD is compared per coin (both are 1,000 PEPE); a KPEPE-USD quoted per one PEPE is 1000x off', () => {
  const book = new MarketBook();
  const t = 2_000_000;
  book.load([mkt('1000PEPE-USD', { id: 4 })]);
  book.setMark('1000PEPE-USD', 0.004886, t);
  book.observeLeaderPrice('hyperliquid', 'kPEPE', 0.004889, t);
  const v = book.sameAsset('hyperliquid', 'kPEPE', t);
  assert.equal(v?.same, true);
  assert.equal(v?.market, '1000PEPE-USD');
  assert.ok(Math.abs(v!.leaderPrice - 0.000004889) < 1e-12, 'the price of one PEPE');

  const k = new MarketBook();
  k.load([mkt('KPEPE-USD', { id: 5 })]);
  k.setMark('KPEPE-USD', 0.000004886, t);
  k.observeLeaderPrice('hyperliquid', 'kPEPE', 0.004889, t);
  assert.equal(k.sameAsset('hyperliquid', 'kPEPE', t)?.same, false);

  // KAS-USD is Kaspa, one coin per contract: a capital K is no thousand.
  const kas = new MarketBook();
  kas.load([mkt('KAS-USD', { id: 6 })]);
  kas.setMark('KAS-USD', 0.0512, t);
  kas.observeLeaderPrice('hyperliquid', 'KAS', 0.0511, t);
  assert.equal(kas.sameAsset('hyperliquid', 'KAS', t)?.same, true);
});

test('a stale price is no divergence: without fresh prices the last verdict stands, and there is none before', () => {
  const book = new MarketBook();
  book.load([GOLD]);
  const t = 3_000_000;
  // Hyperliquid priced it far away, but long ago.
  book.observeLeaderPrice('hyperliquid', 'xyz:GOLD', 1_000, t - ASSET_PRICE_MAX_AGE_MS - 1);
  book.setMark('GOLD-USD', 2_450, t);
  assert.equal(book.sameAsset('hyperliquid', 'xyz:GOLD', t), null);

  // Fresh and alike: the same asset.
  book.observeLeaderPrice('hyperliquid', 'xyz:GOLD', 2_449, t);
  assert.equal(book.sameAsset('hyperliquid', 'xyz:GOLD', t)?.same, true);
  // An older print arriving late does not replace the newer one.
  book.observeLeaderPrice('hyperliquid', 'xyz:GOLD', 1_000, t - 10);
  assert.equal(book.sameAsset('hyperliquid', 'xyz:GOLD', t)?.same, true);
  // Later, SoDEX's mark moved far but Hyperliquid's price is stale by then: the verdict stands.
  const later = t + ASSET_PRICE_MAX_AGE_MS + 1;
  book.setMark('GOLD-USD', 4_000, later);
  assert.equal(book.sameAsset('hyperliquid', 'xyz:GOLD', later)?.same, true);
  // As it does with Hyperliquid fresh and SoDEX's mark stale.
  const b2 = new MarketBook();
  b2.load([GOLD]);
  b2.setMark('GOLD-USD', 4_000, t - ASSET_PRICE_MAX_AGE_MS - 1);
  b2.observeLeaderPrice('hyperliquid', 'xyz:GOLD', 2_450, t);
  assert.equal(b2.sameAsset('hyperliquid', 'xyz:GOLD', t), null);
});

/* ---------------------------------------------------------- 2. the planner ----- */

const ctx = (o: Partial<PlanContext> & Pick<PlanContext, 'event'>): PlanContext => ({
  sub: sub({ leader: { venue: 'hyperliquid', address: '0x1111111111111111111111111111111111111111' } }),
  state: state(),
  market: GOLD,
  markOf: marks({ 'GOLD-USD': 3_900 }),
  policy: { maxLeverage: null },
  heldBy: 'nobody',
  follower: null,
  ...o,
});
const held = (size: number) => state({ owned: { 'GOLD-USD': { size, entry: 2_450, openedAt: 1 } }, ratios: { 'xyz:GOLD': Math.abs(size) / 10 } });

test('a different asset is never opened or added to; reductions, closes and the close of a flip go through', () => {
  const open = planLeaderEvent(ctx({ event: ev('xyz:GOLD', 0, 10, 2_450, 'hyperliquid'), sameAsset: false }));
  assert.deepEqual([open.intents.length, open.skip], [0, 'different-asset']);
  assert.equal(open.leaderAfter, 10, "the leader's position is still followed");

  const add = planLeaderEvent(ctx({ state: held(0.1), event: ev('xyz:GOLD', 10, 20, 2_450, 'hyperliquid'), sameAsset: false }));
  assert.deepEqual([add.intents.length, add.skip], [0, 'different-asset']);

  const cut = planLeaderEvent(ctx({ state: held(0.1), event: ev('xyz:GOLD', 10, 5, 2_450, 'hyperliquid'), sameAsset: false }));
  assert.deepEqual(cut.intents.map((i) => [i.side, i.quantity, i.reduceOnly, i.leg]), [['sell', '0.05', true, 'decrease']]);

  const close = planLeaderEvent(ctx({ state: held(0.1), event: ev('xyz:GOLD', 10, 0, 2_450, 'hyperliquid'), sameAsset: false }));
  assert.deepEqual(close.intents.map((i) => [i.side, i.quantity, i.reduceOnly, i.leg]), [['sell', '0.1', true, 'close']]);

  const flip = planLeaderEvent(ctx({ state: held(0.1), event: ev('xyz:GOLD', 10, -10, 2_450, 'hyperliquid'), sameAsset: false }));
  assert.deepEqual(flip.intents.map((i) => [i.leg, i.reduceOnly]), [['flip-close', true]]);
  assert.equal(flip.skip, 'different-asset');

  // Not checked yet (no fresh prices): nothing new either, closes still go.
  const unknown = planLeaderEvent(ctx({ event: ev('xyz:GOLD', 0, 10, 2_450, 'hyperliquid'), sameAsset: null }));
  assert.deepEqual([unknown.intents.length, unknown.skip], [0, 'no-price']);
  const closeUnknown = planLeaderEvent(ctx({ state: held(0.1), event: ev('xyz:GOLD', 10, 0, 2_450, 'hyperliquid'), sameAsset: null }));
  assert.equal(closeUnknown.intents[0]?.leg, 'close');

  // The same asset opens as before.
  const same = planLeaderEvent(ctx({ markOf: marks({ 'GOLD-USD': 2_450 }), event: ev('xyz:GOLD', 0, 10, 2_450, 'hyperliquid'), sameAsset: true }));
  assert.equal(same.intents[0]?.leg, 'open');
  assert.ok(SKIP_REASONS['different-asset'].length > 0);
});

/* ---------------------------------------------------------- 3. the runtime ----- */

const HL = '0x3333333333333333333333333333333333333333';
const ref = { venue: 'hyperliquid' as const, address: HL };
const quiet: Logger = { debug() {}, info() {}, warn() {}, error() {} };

class FakeWs implements WebSocketLike {
  static all: FakeWs[] = [];
  readyState = 0;
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
  send(): void {}
  close(): void {
    this.readyState = 3;
  }
  push(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}
const hlWs = () => FakeWs.all.filter((x) => x.url === HL_WS_URL).at(-1);

const ok = (data: unknown) => ({ status: 200, ok: true, text: async () => JSON.stringify(data) });
const fail = (status: number) => ({ status, ok: false, text: async () => 'refused' });

/** dex ('' = main) -> the leader's positions there: [coin, szi, Hyperliquid's mark]. */
type HlPositions = Record<string, Array<[string, number, number]>>;

/** SoDEX (GOLD-USD and TSLA-USD, marks as given) and Hyperliquid's info endpoint (a standard account of 100,000). */
function fakeFetch(hl: HlPositions, sodexMarks: Record<string, number>): FetchLike {
  const env = (data: unknown) => ok({ code: 0, timestamp: Date.now(), data });
  return async (url, init) => {
    if (url === 'https://api.hyperliquid.xyz/info') {
      const body = JSON.parse(init?.body ?? '{}') as { type: string; dex?: string };
      if (body.type === 'clearinghouseState') {
        const dex = body.dex ?? '';
        return ok({
          marginSummary: { accountValue: dex === '' ? '100000' : '0' },
          assetPositions: (hl[dex] ?? []).map(([coin, szi, px]) => ({ position: { coin, szi: String(szi), positionValue: String(Math.abs(szi * px)) } })),
          time: Date.now(),
        });
      }
      if (body.type === 'spotClearinghouseState') return ok({ balances: [] });
      return fail(404);
    }
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    const market = (id: number, name: string, tick: string, step: string) => ({
      id, name, baseCoin: name.replace(/-USD$/, ''), tickSize: tick, stepSize: step, minQuantity: step, maxQuantity: '100000', minNotional: '10',
      maxNotional: '5000000', maxLeverage: 20, buyLimitUpRatio: '0.05', sellLimitDownRatio: '0.05', takerFee: '0.0004', status: 'TRADING',
    });
    if (path === '/api/v1/perps/markets/symbols') return env([market(3, 'GOLD-USD', '0.1', '0.001'), market(2, 'TSLA-USD', '0.01', '0.001')]);
    if (path === '/api/v1/perps/markets/mark-prices') return env(Object.entries(sodexMarks).map(([symbol, p]) => ({ symbol, markPrice: String(p) })));
    if (path === `/api/v1/perps/accounts/${FOLLOWER}/state`) return env({ aid: 42, av: '5000', am: '5000', P: [] });
    return fail(404);
  };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean | Promise<boolean>, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!(await cond())) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await wait(10);
  }
}

function runtime(hl: HlPositions, sodexMarks: Record<string, number>) {
  const fetch = fakeFetch(hl, sodexMarks);
  const store = new MemoryStore();
  const notices: EngineNotice[] = [];
  const rt = new CopyRuntime({
    store,
    sodex: new SodexClient({ network: 'mainnet', fetch }),
    hyperliquid: new HyperliquidClient(fetch),
    factory: (url) => new FakeWs(url),
    network: 'mainnet',
    hlMode: 'user',
    sinkFor: () => new PaperSink(),
    builderFor: async () => null,
    policyFor: (s) => regionPolicy(s.country, s.observedCountry),
    log: quiet,
    onNotice: (n) => notices.push(n),
  });
  const reconcile = async () => {
    await until(() => !(rt as unknown as { reconciling: boolean }).reconciling);
    await rt.reconcileAll();
  };
  return { rt, store, notices, reconcile };
}

let tid = 0;
const fill = (coin: string, side: 'B' | 'A', sz: number, px: number, start: number) => ({
  coin, side, sz: String(sz), px: String(px), startPosition: String(start), time: Date.now(), tid: ++tid, oid: tid,
});
const userFills = (...fills: unknown[]) => ({ channel: 'userFills', data: { user: HL, isSnapshot: false, fills } });

test('runtime: a leader opening a different asset is skipped and the follower told; copied again once the prices agree', async () => {
  const hl: HlPositions = {};
  const { rt, store, notices, reconcile } = runtime(hl, { 'GOLD-USD': 3_900, 'TSLA-USD': 400 });
  await rt.start();
  const s = await rt.add(sub({ paper: true, leader: ref }, { id: 'g1' }));
  await until(() => hlWs()?.readyState === 1);

  hl.xyz = [['xyz:GOLD', 10, 2_450], ['xyz:TSLA', 10, 400]];
  hlWs()!.push(userFills(fill('xyz:GOLD', 'B', 10, 2_450, 0), fill('xyz:TSLA', 'B', 10, 400, 0)));
  await until(() => (rt.view(s.id)?.positions.length ?? 0) === 1);
  assert.deepEqual(rt.view(s.id)!.positions.map((p) => p.symbol), ['TSLA-USD'], 'TSLA is the same asset: copied');
  const skip = async () => (await store.activity({ subId: s.id })).find((e) => e.kind === 'skip' && e.reason === 'different-asset');
  await until(async () => !!(await skip()));
  assert.equal((await skip())!.symbol, 'GOLD-USD');
  assert.match((await skip())!.detail ?? '', /xyz:GOLD 2450, SoDEX GOLD-USD 3900: 37\.2% apart/);
  assert.deepEqual(notices.map((n) => [n.kind, n.grade, n.title]), [['different-asset', 'warn', `xyz:GOLD is not copied in the copy of 0x3333…3333`]]);

  // The prices meet: the next read finds it the same, the follower is told, and the next add is copied.
  rt.markets.setMark('GOLD-USD', 2_452);
  await reconcile();
  assert.deepEqual(notices.map((n) => [n.kind, n.grade]), [['different-asset', 'warn'], ['same-asset', 'info']]);
  const st = (rt as unknown as { states: Map<string, SubState> }).states.get(s.id)!;
  assert.deepEqual(st.differentAssets, {}, 'what the copy was told is cleared');
  hl.xyz = [['xyz:GOLD', 15, 2_450], ['xyz:TSLA', 10, 400]];
  hlWs()!.push(userFills(fill('xyz:GOLD', 'B', 5, 2_450, 10)));
  await until(() => rt.view(s.id)!.positions.some((p) => p.symbol === 'GOLD-USD'));
  await rt.stop();
});

test('runtime: a copied position whose prices part is not added to, and its reductions and close still go', async () => {
  const hl: HlPositions = {};
  const { rt, store, notices, reconcile } = runtime(hl, { 'GOLD-USD': 2_450, 'TSLA-USD': 400 });
  await rt.start();
  const s = await rt.add(sub({ paper: true, leader: ref }, { id: 'g2' }));
  await until(() => hlWs()?.readyState === 1);
  const gold = () => rt.view(s.id)!.positions.find((p) => p.symbol === 'GOLD-USD')?.size ?? 0;

  hl.xyz = [['xyz:GOLD', 10, 2_450]];
  hlWs()!.push(userFills(fill('xyz:GOLD', 'B', 10, 2_450, 0)));
  // 24,500 of a 100,000 leader on a 1,000 copy: 245 USD, 0.1 GOLD.
  await until(() => gold() === 0.1);

  // SoDEX's GOLD-USD now prices another asset: told at the next read, as the copy holds it.
  rt.markets.setMark('GOLD-USD', 3_900);
  await reconcile();
  assert.deepEqual(notices.map((n) => n.kind), ['different-asset']);
  assert.match(notices[0]!.body, /still follows the leader's reductions and closes/);

  hl.xyz = [['xyz:GOLD', 20, 2_450]];
  hlWs()!.push(userFills(fill('xyz:GOLD', 'B', 10, 2_450, 10)));
  await until(async () => (await store.activity({ subId: s.id })).some((e) => e.kind === 'skip' && e.reason === 'different-asset'));
  assert.equal(gold(), 0.1, 'not added to');
  assert.equal(notices.length, 1, 'told once');

  hl.xyz = [['xyz:GOLD', 5, 2_450]];
  hlWs()!.push(userFills(fill('xyz:GOLD', 'A', 15, 2_450, 20)));
  await until(() => gold() === 0.05);
  hl.xyz = [];
  hlWs()!.push(userFills(fill('xyz:GOLD', 'A', 5, 2_450, 5)));
  await until(() => gold() === 0);
  await rt.stop();
});
