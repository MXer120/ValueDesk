/**
 * SoDEX in maintenance (owner 2026-11-11), the copy side: a live copy of a Hyperliquid leader is held as under the
 * brake (RuntimeHost.venue) - the leader's position in its books does not move, nothing is sent - and caught up once
 * SoDEX is back: what the leader opened at most 5 min before (SHORT_BRAKE_MS), every close and reduction. One activity
 * line at the start, one at the end. Closes are neither sent into the maintenance nor marked detached.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CopyRuntime,
  HL_WS_URL,
  HyperliquidClient,
  MemoryStore,
  SodexClient,
  regionPolicy,
  type FetchLike,
  type Intent,
  type Logger,
  type OrderSink,
  type SendResult,
  type VenueHold,
  type WebSocketLike,
} from '../src/index.ts';
import { FOLLOWER, sub } from './helpers.ts';

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

/** The leader's positions on Hyperliquid (what a reconcile reads) and SoDEX's one market. */
interface World {
  leader: Record<string, number>;
}

function fakeFetch(w: World): FetchLike {
  const ok = (data: unknown) => ({ status: 200, ok: true, text: async () => JSON.stringify(data) });
  const env = (data: unknown) => ok({ code: 0, timestamp: Date.now(), data });
  return async (url, init) => {
    if (url === 'https://api.hyperliquid.xyz/info') {
      const body = JSON.parse(init?.body ?? '{}') as { type: string; dex?: string };
      if (body.type === 'clearinghouseState') {
        const positions = body.dex ? [] : Object.entries(w.leader).filter(([, v]) => v !== 0);
        return ok({ marginSummary: { accountValue: body.dex ? '0' : '100000' }, assetPositions: positions.map(([coin, szi]) => ({ position: { coin, szi: String(szi), positionValue: String(Math.abs(szi * 80_000)) } })), time: Date.now() });
      }
      if (body.type === 'spotClearinghouseState') return ok({ balances: [] });
      if (body.type === 'perpDexs') return ok([null, { name: 'xyz' }]);
      if (body.type === 'meta') return ok({ universe: [] });
      return { status: 404, ok: false, text: async () => '' };
    }
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    if (path === '/api/v1/perps/markets/symbols') {
      return env([{ id: 1, name: 'BTC-USD', baseCoin: 'BTC', tickSize: '1', stepSize: '0.00001', minQuantity: '0.00001', maxQuantity: '100000', minNotional: '10', maxNotional: '5000000', maxLeverage: 20, buyLimitUpRatio: '0.05', sellLimitDownRatio: '0.05', takerFee: '0.0004', status: 'TRADING' }]);
    }
    if (path === '/api/v1/perps/markets/mark-prices') return env([{ symbol: 'BTC-USD', markPrice: '80000' }]);
    if (path === `/api/v1/perps/accounts/${FOLLOWER}/state`) return env({ aid: 42, av: '5000', am: '5000', P: [] });
    return { status: 404, ok: false, text: async () => '' };
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

const HOLD: VenueHold = { reason: 'SoDEX is in maintenance. Nothing is sent until it is back.', since: Date.now(), expectedEnd: null };

function runtime(w: World) {
  const fetch = fakeFetch(w);
  const store = new MemoryStore();
  const sent: Intent[][] = [];
  let venue: VenueHold | null = null;
  const sink: OrderSink = {
    paper: false,
    async place(_a, _m, intents): Promise<SendResult[]> {
      sent.push(intents);
      return intents.map((i) => ({ clOrdID: i.clOrdID, ok: true, orderId: '1', error: null, outcomeUnknown: false }));
    },
    async setLeverage() {},
    async placeStop(_a, _m, st) {
      return { clOrdID: st.clOrdID, ok: true, orderId: null, error: null, outcomeUnknown: false };
    },
    async cancel() {},
  };
  const rt = new CopyRuntime({
    confirmGapMs: 0,
    leverageTrustMs: 0,
    store,
    sodex: new SodexClient({ network: 'mainnet', fetch }),
    hyperliquid: new HyperliquidClient(fetch),
    factory: (url) => new FakeWs(url),
    network: 'mainnet',
    hlMode: 'user',
    sinkFor: () => sink,
    builderFor: async () => null,
    policyFor: (s) => regionPolicy(s.country, s.observedCountry),
    venue: () => venue,
    log: quiet,
  });
  const reconcile = async () => {
    await until(() => !(rt as unknown as { reconciling: boolean }).reconciling);
    await rt.reconcileAll();
  };
  return { rt, store, sent, reconcile, setVenue: (v: VenueHold | null) => (venue = v) };
}

type Internals = { states: Map<string, { leaderPos: Record<string, number>; detached: Record<string, string> }>; heldFirstPrint: Map<string, number> };
let tid = 0;
const userFills = (coin: string, side: 'B' | 'A', sz: number, start: number) => ({
  channel: 'userFills',
  data: { user: HL, isSnapshot: false, fills: [{ coin, side, sz: String(sz), px: '80000', startPosition: String(start), time: Date.now(), tid: ++tid, oid: tid }] },
});

test('a Hyperliquid leader opens during the maintenance: held (its position in the books stays), one line, caught up once SoDEX is back', async () => {
  const w: World = { leader: {} };
  const { rt, store, sent, reconcile, setVenue } = runtime(w);
  await rt.start();
  const s = await rt.add(sub({ leader: ref }, { id: 'm1' }));
  await until(() => hlWs()?.readyState === 1);
  await wait(100);
  setVenue(HOLD);
  w.leader = { BTC: 1 };
  hlWs()!.push(userFills('BTC', 'B', 1, 0));
  await until(() => rt.view(s.id)!.leader.positions.BTC === 1);
  w.leader = { BTC: 2 };
  hlWs()!.push(userFills('BTC', 'B', 1, 1));
  await reconcile();
  await wait(300);
  assert.equal(sent.length, 0, 'nothing sent into the maintenance');
  const st = (rt as unknown as Internals).states.get(s.id)!;
  assert.equal(st.leaderPos.BTC ?? 0, 0, "the copy's view of the leader did not move");
  let log = await store.activity({ subId: s.id });
  assert.equal(log.filter((e) => e.reason === 'maintenance').length, 1, 'one line for the whole maintenance');
  assert.match(log.find((e) => e.reason === 'maintenance')!.detail ?? '', /SoDEX is in maintenance/);
  // Back: the open is caught up in full (both prints, the leader's 2 BTC), and the end is said once.
  setVenue(null);
  await until(() => sent.length === 1, 5_000);
  assert.ok(sent[0]!.every((i) => !i.reduceOnly && i.side === 'buy'), JSON.stringify(sent[0]));
  await until(() => st.leaderPos.BTC === 2);
  log = await store.activity({ subId: s.id });
  assert.ok(log.some((e) => e.reason === 'maintenance' && /back from maintenance/.test(e.detail ?? '')));
  await rt.stop();
});

test('an open older than 5 min by the end of the maintenance is not made late; a close made during it is followed', async () => {
  const w: World = { leader: {} };
  const { rt, sent, setVenue } = runtime(w);
  await rt.start();
  const s = await rt.add(sub({ leader: ref }, { id: 'm2' }));
  await until(() => hlWs()?.readyState === 1);
  await wait(100);
  // Before the maintenance: the leader opens BTC, copied at once.
  w.leader = { BTC: 1 };
  hlWs()!.push(userFills('BTC', 'B', 1, 0));
  await until(() => sent.length === 1);
  setVenue(HOLD);
  // During it: the leader adds to BTC (long ago by the lift) and then closes it all.
  w.leader = { BTC: 2 };
  hlWs()!.push(userFills('BTC', 'B', 1, 1));
  await wait(200);
  const firsts = (rt as unknown as Internals).heldFirstPrint;
  for (const k of firsts.keys()) firsts.set(k, Date.now() - 6 * 60_000);
  w.leader = {};
  hlWs()!.push(userFills('BTC', 'A', 2, 2));
  await wait(200);
  assert.equal(sent.length, 1, 'held');
  setVenue(null);
  await until(() => sent.length === 2, 5_000);
  assert.ok(sent[1]!.every((i) => i.reduceOnly && i.side === 'sell'), `the close is followed: ${JSON.stringify(sent[1])}`);
  const st = (rt as unknown as Internals).states.get(s.id)!;
  await until(() => !st.leaderPos.BTC);
  await rt.stop();
});

test('an add older than 5 min by the lift is not made late (the books move on, nothing is sent)', async () => {
  const w: World = { leader: {} };
  const { rt, sent, setVenue } = runtime(w);
  await rt.start();
  const s = await rt.add(sub({ leader: ref }, { id: 'm3' }));
  await until(() => hlWs()?.readyState === 1);
  await wait(100);
  w.leader = { BTC: 1 };
  hlWs()!.push(userFills('BTC', 'B', 1, 0));
  await until(() => sent.length === 1);
  setVenue(HOLD);
  w.leader = { BTC: 2 };
  hlWs()!.push(userFills('BTC', 'B', 1, 1));
  await wait(200);
  const firsts = (rt as unknown as Internals).heldFirstPrint;
  for (const k of firsts.keys()) firsts.set(k, Date.now() - 6 * 60_000);
  setVenue(null);
  const st = (rt as unknown as Internals).states.get(s.id)!;
  await until(() => st.leaderPos.BTC === 2, 5_000);
  await wait(300);
  assert.equal(sent.length, 1, 'no late add');
  await rt.stop();
});

test('stop and close during the maintenance sends nothing and says the positions are still open on SoDEX', async () => {
  const w: World = { leader: {} };
  const { rt, sent, setVenue } = runtime(w);
  await rt.start();
  const s = await rt.add(sub({ leader: ref }, { id: 'm4' }));
  await until(() => hlWs()?.readyState === 1);
  await wait(100);
  w.leader = { BTC: 1 };
  hlWs()!.push(userFills('BTC', 'B', 1, 0));
  await until(() => sent.length === 1);
  // The fill the stream would show: the copy holds BTC in its books.
  (rt as unknown as { fillBooks(...a: unknown[]): void }).fillBooks(rt.get(s.id), 'BTC-USD', 'buy', Number(sent[0]![0]!.quantity), 80_000, 0, false);
  setVenue(HOLD);
  const done = await rt.stopCopy(s.id, { close: true });
  assert.equal(sent.length, 1, 'no close sent into the maintenance');
  assert.equal(done.status, 'stopped');
  assert.match(done.statusReason ?? '', /SoDEX is in maintenance.*BTC-USD is still open on SoDEX/);
  await rt.stop();
});
