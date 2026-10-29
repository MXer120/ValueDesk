/**
 * A coin SoDEX does not list is never traded or copied there, and the follower is told
 * (owner, 2026-10-29: "It shouldn't be possible to trade, or copy, etc. a coin not listed on
 * SoDEX. And for copies not being able to do that, obviously tell users."):
 *
 *   1. the planner places nothing for it, whatever the leader does, copy or counter-trade, and
 *      in any copy status; a different asset is never opened against either, and a position
 *      already copied there still follows the leader's reductions and closes;
 *   2. the runtime skips each such trade in the copy's activity, in words, and tells the copy
 *      once per coin (a 'not-copied' notice), kept across a restart;
 *   3. before a copy starts, `uncopyable` names the leader's markets a copy cannot follow;
 *   4. an algo on a market SoDEX does not list - its own, a basket leg's, the one a conditional
 *      would start - does not start, and says so.
 *
 * A copied position on a market SoDEX has since delisted is edge-copy.test.ts's.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AlgoRuntime,
  CopyRuntime,
  HL_WS_URL,
  HyperliquidClient,
  MarketBook,
  MemoryAlgoStore,
  MemoryStore,
  PaperSink,
  SKIP_REASONS,
  SodexClient,
  copyDelistedNotice,
  copyNotCopiedNotice,
  notListedLine,
  planLeaderEvent,
  regionPolicy,
  silentLogger,
  uncopyable,
  type AlgoMarket,
  type EngineNotice,
  type FetchLike,
  type MarketInfo,
  type PlanContext,
  type SodexClient as SodexClientType,
  type SubState,
  type WebSocketLike,
} from '../src/index.ts';
import { BTC, ETH, FOLLOWER, ev, marks, state, sub } from './helpers.ts';

const HL = '0x3333333333333333333333333333333333333333';
const hlLeader = { venue: 'hyperliquid' as const, address: HL };
const mkt = (name: string, over: Partial<MarketInfo> = {}): MarketInfo => ({ ...BTC, name, base: name.replace(/-USD$/, ''), ...over });

/* ----------------------------------------------------------- 1. the planner ----- */

const ctx = (o: Partial<PlanContext> & Pick<PlanContext, 'event'>): PlanContext => ({
  sub: sub({ leader: hlLeader }),
  state: state(),
  market: null,
  markOf: marks({ 'BTC-USD': 80_000 }),
  policy: { maxLeverage: null },
  heldBy: 'nobody',
  follower: null,
  ...o,
});

test('a market SoDEX does not list: no order for any change of the leader, copy or counter-trade, in any status - and the leader is still followed', () => {
  const changes: Array<[string, number, number]> = [['open', 0, 10], ['add', 10, 20], ['cut', 20, 5], ['close', 5, 0], ['flip', 5, -5], ['short', 0, -3]];
  for (const direction of ['copy', 'counter'] as const) {
    for (const status of ['active', 'blocked', 'halted', 'paused'] as const) {
      for (const [what, before, after] of changes) {
        const p = planLeaderEvent(ctx({ sub: sub({ leader: hlLeader, direction }, { status }), event: ev('PURR', before, after, 0.2, 'hyperliquid') }));
        assert.deepEqual(p.intents, [], `${direction} ${status} ${what}: nothing is sent`);
        assert.equal(p.skip, 'not-on-sodex', `${direction} ${status} ${what}: and the skip says why`);
        assert.equal(p.leaderAfter, after, `${direction} ${status} ${what}: the leader's position is kept in the books`);
      }
    }
  }
  // Never onto another market of a similar name: the planner has no market, so it has nothing to send to.
  const k = planLeaderEvent(ctx({ event: ev('kPURR', 0, 1_000, 0.0002, 'hyperliquid') }));
  assert.deepEqual([k.intents.length, k.skip], [0, 'not-on-sodex']);
  assert.match(SKIP_REASONS['not-on-sodex'], /^Not copied: SoDEX doesn't list this coin/);
});

test('a counter-trade of a different asset: nothing is opened against it; its reductions and close still go, reduce-only', () => {
  const GOLD = mkt('GOLD-USD', { id: 3, tickSize: '0.1', stepSize: '0.001', minQuantity: '0.001' });
  const counter = sub({ leader: hlLeader, direction: 'counter' });
  const c = (o: Partial<PlanContext> & Pick<PlanContext, 'event'>) => ctx({ sub: counter, market: GOLD, markOf: marks({ 'GOLD-USD': 3_900 }), sameAsset: false, ...o });
  const open = planLeaderEvent(c({ event: ev('xyz:GOLD', 0, 10, 2_450, 'hyperliquid') }));
  assert.deepEqual([open.intents.length, open.skip], [0, 'different-asset']);
  // The counter-trade holds a short against the leader's long (copied before the prices parted).
  const short = state({ owned: { 'GOLD-USD': { size: -0.1, entry: 2_450, openedAt: 1 } }, ratios: { 'xyz:GOLD': 0.01 } });
  const add = planLeaderEvent(c({ state: short, event: ev('xyz:GOLD', 10, 20, 2_450, 'hyperliquid') }));
  assert.deepEqual([add.intents.length, add.skip], [0, 'different-asset']);
  const cut = planLeaderEvent(c({ state: short, event: ev('xyz:GOLD', 10, 5, 2_450, 'hyperliquid') }));
  assert.deepEqual(cut.intents.map((i) => [i.leg, i.side, i.quantity, i.reduceOnly]), [['decrease', 'buy', '0.05', true]]);
  const close = planLeaderEvent(c({ state: short, event: ev('xyz:GOLD', 10, 0, 2_450, 'hyperliquid') }));
  assert.deepEqual(close.intents.map((i) => [i.leg, i.side, i.quantity, i.reduceOnly]), [['close', 'buy', '0.1', true]]);
  const flip = planLeaderEvent(c({ state: short, event: ev('xyz:GOLD', 10, -10, 2_450, 'hyperliquid') }));
  assert.deepEqual(flip.intents.map((i) => [i.leg, i.reduceOnly]), [['flip-close', true]], 'the flip closes, and opens nothing on the other asset');
});

/* ------------------------------------------------------------ 2. the runtime ----- */

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

/** SoDEX lists TSLA-USD only; Hyperliquid's leader (a standard account of 100,000) holds `hl` on the main dex. */
function fakeFetch(hl: Array<[string, number, number]>): FetchLike {
  const env = (data: unknown) => ok({ code: 0, timestamp: Date.now(), data });
  return async (url, init) => {
    if (url === 'https://api.hyperliquid.xyz/info') {
      const body = JSON.parse(init?.body ?? '{}') as { type: string; dex?: string };
      if (body.type === 'clearinghouseState') {
        const main = (body.dex ?? '') === '';
        return ok({
          marginSummary: { accountValue: main ? '100000' : '0' },
          assetPositions: (main ? hl : []).map(([coin, szi, px]) => ({ position: { coin, szi: String(szi), positionValue: String(Math.abs(szi * px)) } })),
          time: Date.now(),
        });
      }
      if (body.type === 'spotClearinghouseState') return ok({ balances: [] });
      return fail(404);
    }
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    if (path === '/api/v1/perps/markets/symbols') {
      return env([{ id: 2, name: 'TSLA-USD', baseCoin: 'TSLA', tickSize: '0.01', stepSize: '0.001', minQuantity: '0.001', maxQuantity: '100000', minNotional: '10', maxNotional: '5000000', maxLeverage: 20, buyLimitUpRatio: '0.05', sellLimitDownRatio: '0.05', takerFee: '0.0004', status: 'TRADING' }]);
    }
    if (path === '/api/v1/perps/markets/mark-prices') return env([{ symbol: 'TSLA-USD', markPrice: '400' }]);
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

function runtime(store: MemoryStore, hl: Array<[string, number, number]>, notices: EngineNotice[]) {
  const fetch = fakeFetch(hl);
  return new CopyRuntime({
    confirmGapMs: 0,
    store,
    sodex: new SodexClient({ network: 'mainnet', fetch }),
    hyperliquid: new HyperliquidClient(fetch),
    factory: (url) => new FakeWs(url),
    network: 'mainnet',
    hlMode: 'user',
    sinkFor: () => new PaperSink(),
    builderFor: async () => null,
    policyFor: (s) => regionPolicy(s.country, s.observedCountry),
    log: silentLogger,
    onNotice: (n) => notices.push(n),
  });
}

let tid = 0;
const fill = (coin: string, side: 'B' | 'A', sz: number, px: number, start: number) => ({
  coin, side, sz: String(sz), px: String(px), startPosition: String(start), time: Date.now(), tid: ++tid, oid: tid,
});
const userFills = (...fills: unknown[]) => ({ channel: 'userFills', data: { user: HL, isSnapshot: false, fills } });

test('runtime: a leader trading coins SoDEX does not list - every trade a "Not copied" line, one notice per copy and coin, nothing sent; kept across a restart', async () => {
  const store = new MemoryStore();
  const notices: EngineNotice[] = [];
  const hl: Array<[string, number, number]> = [];
  let rt = runtime(store, hl, notices);
  await rt.start();
  const s = await rt.add(sub({ paper: true, leader: hlLeader }, { id: 'n1' }));
  await until(() => hlWs()?.readyState === 1);
  const skips = async () => (await store.activity({ subId: s.id })).filter((e) => e.kind === 'skip' && e.reason === 'not-on-sodex');

  hl.push(['PURR', 1_000, 0.2], ['TSLA', 10, 400]);
  hlWs()!.push(userFills(fill('PURR', 'B', 1_000, 0.2, 0), fill('TSLA', 'B', 10, 400, 0)));
  await until(() => (rt.view(s.id)?.positions.length ?? 0) === 1);
  assert.deepEqual(rt.view(s.id)!.positions.map((p) => p.symbol), ['TSLA-USD'], 'TSLA is listed: copied');
  await until(async () => (await skips()).length === 1);

  // A busy leader: more PURR, and HYPE.
  hl.splice(0, hl.length, ['PURR', 3_000, 0.2], ['HYPE', 50, 40], ['TSLA', 10, 400]);
  hlWs()!.push(userFills(fill('PURR', 'B', 1_000, 0.2, 1_000), fill('PURR', 'B', 1_000, 0.2, 2_000), fill('HYPE', 'B', 50, 40, 0)));
  await until(async () => (await skips()).length === 4);
  const rows = await skips();
  assert.deepEqual(rows.map((r) => r.symbol).sort(), ['HYPE', 'PURR', 'PURR', 'PURR'], 'each skipped trade has its line, under the leader\'s coin');
  assert.ok(rows.every((r) => r.leader !== null), 'with the leader change it answers');
  assert.deepEqual(rt.view(s.id)!.positions.map((p) => p.symbol), ['TSLA-USD'], 'nothing was opened for them');

  const told = notices.filter((n) => n.kind === 'not-copied');
  assert.deepEqual(told.map((n) => [n.ref, n.grade, n.title]), [
    ['n1:PURR', 'info', 'PURR is not copied in the copy of 0x3333…3333'],
    ['n1:HYPE', 'info', 'HYPE is not copied in the copy of 0x3333…3333'],
  ], 'one notice per copy and coin, however often the leader trades it');
  assert.equal(told[0]!.body, "Not copied: PURR isn't listed on SoDEX - the leader's trades on it are skipped.");
  assert.ok(told.every((n) => n.paper && n.owner === s.owner && n.source === 'copy'));
  await rt.stop();

  // A restart: what the copy was told is kept, so the next PURR trade adds a line and no notice.
  const st = await store.state(s.id);
  assert.deepEqual(Object.keys((st as SubState).notCopied ?? {}).sort(), ['HYPE', 'PURR']);
  rt = runtime(store, hl, notices);
  await rt.start();
  await until(() => hlWs()?.readyState === 1);
  hl.splice(0, hl.length, ['PURR', 4_000, 0.2], ['HYPE', 50, 40], ['TSLA', 10, 400]);
  hlWs()!.push(userFills(fill('PURR', 'B', 1_000, 0.2, 3_000)));
  await until(async () => (await skips()).length === 5);
  await wait(50);
  assert.equal(notices.filter((n) => n.kind === 'not-copied').length, 2, 'not told again');
  await rt.stop();
});

/* ---------------------------------------------------- 3. before a copy starts ----- */

test('uncopyable: the leader\'s markets a copy cannot follow - not listed, or another asset on fresh prices; spot, listed coins and repeats left out', () => {
  const book = new MarketBook();
  const t = 5_000_000;
  book.load([BTC, mkt('1000PEPE-USD', { id: 4 }), mkt('GOLD-USD', { id: 3 })]);
  book.setMark('BTC-USD', 80_000, t);
  book.setMark('GOLD-USD', 3_900, t);
  book.setMark('1000PEPE-USD', 0.0049, t);
  book.observeLeaderPrice('hyperliquid', 'xyz:GOLD', 2_450, t);
  book.observeLeaderPrice('hyperliquid', 'kPEPE', 0.0049, t);
  const out = uncopyable('hyperliquid', ['BTC', 'PURR', 'kPEPE', 'xyz:GOLD', '@107', 'HYPE', 'PURR', 'PURR/USDC'], book, t);
  assert.deepEqual(out.map((x) => [x.symbol, x.reason]), [['PURR', 'not-on-sodex'], ['xyz:GOLD', 'different-asset'], ['HYPE', 'not-on-sodex']]);
  assert.equal(out[1]!.verdict?.market, 'GOLD-USD');

  // Without fresh prices nothing is claimed about the asset; the list still decides what is listed.
  const stale = new MarketBook();
  stale.load([mkt('GOLD-USD', { id: 3 })]);
  stale.setMark('GOLD-USD', 3_900, t);
  assert.deepEqual(uncopyable('hyperliquid', ['xyz:GOLD', 'PURR'], stale, t).map((x) => x.reason), ['not-on-sodex']);
  // A list that could not be read says nothing.
  assert.deepEqual(uncopyable('hyperliquid', ['PURR'], new MarketBook(), t), []);
  // A SoDEX leader: its markets are SoDEX's own, so only one SoDEX no longer lists is named.
  assert.deepEqual(uncopyable('sodex', ['BTC-USD', 'OLD-USD', 'vBTC_vUSDC'], book, t).map((x) => [x.symbol, x.reason]), [['OLD-USD', 'not-on-sodex']]);
});

test('the notices: not copied (info) and delisted (warn), in words, within what the inbox keeps', () => {
  const s = sub({ leader: hlLeader, paper: false }, { id: 'c7' });
  const n = copyNotCopiedNotice(s, 'kPEPE', 1_800_000_000_000);
  assert.deepEqual([n.kind, n.grade, n.ref, n.paper, n.id], ['not-copied', 'info', 'c7:kPEPE', false, 'copy:c7:kPEPE:not-copied:1800000000000']);
  assert.equal(n.body, "Not copied: kPEPE isn't listed on SoDEX - the leader's trades on it are skipped.");
  const d = copyDelistedNotice(s, 'BTC-USD', -0.25, 1_800_000_000_000);
  assert.deepEqual([d.kind, d.grade, d.ref], ['delisted', 'warn', 'c7:BTC-USD']);
  assert.equal(d.title, 'BTC-USD is no longer listed on SoDEX (copy of 0x3333…3333)');
  assert.match(d.body, /^BTC-USD is no longer listed on SoDEX\. The copy still holds a short position of 0\.25 there, and ValueDesk will not trade it any more/);
  // The wallet's inbox (server ops/inbox.ts) keeps a kind of 24, a ref of 120, a title of 200 and a body of 1,000 characters at most.
  const long = 'x'.repeat(40);
  for (const x of [n, d, copyNotCopiedNotice(s, `${long}:${long}`), copyDelistedNotice(s, `${long}-USD`, 1)]) {
    assert.ok(x.kind.length <= 24 && x.ref.length <= 120 && x.title.length <= 200 && x.body.length <= 1_000, x.kind);
  }
});

/* -------------------------------------------------------------- 4. algos ----- */

function algoRuntime(markets: MarketInfo[]): AlgoRuntime {
  const quiet = { onOrder() {}, onPrint() {}, onState() {} } as unknown as AlgoMarket;
  return new AlgoRuntime({
    confirmGapMs: 0,
    store: new MemoryAlgoStore(),
    sodex: { markets: async () => markets } as unknown as SodexClientType,
    network: 'mainnet',
    market: quiet,
    sinkFor: () => null,
    log: silentLogger,
    autoTick: false,
  });
}
const start = (rt: AlgoRuntime, spec: Record<string, unknown>) => rt.add({ owner: FOLLOWER, accountId: 42, mode: 'hosted', spec, seed: 1 });
const twap = (symbol: string) => ({ kind: 'twap', symbol, side: 'buy', quantity: '1', durationMs: 600_000, slices: 4, exec: { style: 'taker' } });

test('an algo on a market SoDEX does not list does not start - its own, a basket leg, a conditional\'s market or the algo it would start - in one plain line', async () => {
  const rt = algoRuntime([BTC, ETH]);
  const refused = (spec: Record<string, unknown>, coin: string) => assert.rejects(start(rt, spec), (e: unknown) => e instanceof Error && e.message === notListedLine(coin), coin);
  await refused(twap('PURR-USD'), 'PURR-USD');
  await refused({ kind: 'basket', symbol: 'BTC-USD', legs: [{ symbol: 'BTC-USD', side: 'buy', usd: 40 }, { symbol: 'HYPE-USD', side: 'buy', usd: 30 }], style: 'swarm', clips: 5, inFlight: 1, waveMs: 0, slippageBps: 20 }, 'HYPE-USD');
  await refused({ kind: 'conditional', symbol: 'BTC-USD', side: 'buy', conditions: [{ type: 'price', symbol: 'PURR-USD', source: 'mark', op: 'below', value: 0.1 }], then: { type: 'market', quantity: '0.001', slippageBps: 20 } }, 'PURR-USD');
  await refused({ kind: 'conditional', symbol: 'BTC-USD', side: 'buy', conditions: [{ type: 'price', symbol: 'BTC-USD', source: 'mark', op: 'below', value: 59_000 }], then: { type: 'algo', algo: twap('PURR-USD') } }, 'PURR-USD');
  assert.equal(rt.list().length, 0, 'nothing was started');
  assert.equal(notListedLine('PURR'), "PURR is not listed on SoDEX, so it can't be traded here.");

  // A market list that could not be read is said as that - never as "not listed".
  await assert.rejects(start(algoRuntime([]), twap('BTC-USD')), /market list could not be read/);
});
