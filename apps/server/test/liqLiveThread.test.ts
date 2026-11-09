/**
 * Run: npx tsx --test test/liqLiveThread.test.ts   (from apps/server)
 *
 * The live heatmap on its own thread (indexer/liqLiveThread.ts) against the same engine inline: the same rows for a
 * scripted run of touches, prints and price moves; the same liquidation step as the code it replaced (a copy of that
 * code below); a killed thread started again and handed everything; and the feed still sending while this thread is
 * held for 5 s.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { inflateRawSync, deflateRawSync } from 'node:zlib';
import type { Venue } from '../src/valuedesk/types.js';
import { VENUES } from '../src/valuedesk/types.js';
import { _setMarkets, marketsNow } from '../src/valuedesk/liquidations/rules.js';
import { flatTiers, type Tiers } from '../src/valuedesk/liquidations/math.js';
import { fineBandWidth, fineBands, fineSnapOf, liqCoin, snapOfNow, type LiqNow } from '../src/valuedesk/liquidations/levels.js';
import type { LiqLive } from '../src/valuedesk/liquidations/live.js';
import { liqKnown } from '../src/indexer/cohortTracker.js';
import { liveLink, type LiveLink } from '../src/indexer/liqLiveThread.js';
import { AccountsEncoder, LIQ_LOG_MOVE, MirrorSource, USD_LOG_MOVE, logExtraOf, type BookLike, type StepAsk, type StepOut } from '../src/indexer/liqLiveCore.js';
import { LiqFeedState } from '../src/indexer/liqFeed.js';

type Pos = { szi: number; entry: number | null; iso?: number | null; lev?: number | null; fix?: number | null };
type Book = { equity: number | null; cash?: number | null; at: number; pos: Map<string, Pos> };

const PX: Record<string, number> = { BTC: 80_000, ETH: 2_000, SOL: 150 };
const T: Tiers = flatTiers(0.0125);
for (const v of ['hyperliquid', 'lighter'] as Venue[]) {
  _setMarkets(v, { tiers: new Map(Object.keys(PX).map((c) => [c, T])), oi: new Map(), at: Date.now() });
}

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

/** The indexer's side as the links see it: books, marks, coin prices, the coins kept. */
class World {
  books = new Map<string, Book>();
  marks = new Map<string, number>();
  coinPx = new Map<string, number>(Object.entries(PX));
  wanted: ReadonlySet<string> = new Set(['BTC', 'ETH', 'SOL']);
  links: LiveLink[] = [];
  constructor() {
    for (const v of ['hyperliquid', 'lighter']) for (const [c, p] of Object.entries(PX)) this.marks.set(`${v}|${c}`, v === 'lighter' ? p * 1.0002 : p);
  }

  link(threaded: boolean, port: number): LiveLink {
    const l = liveLink({
      source: {
        account: (v, a) => {
          const b = this.books.get(`${v}|${a}`);
          return b ? { cash: b.cash ?? null, priced: liqKnown(b), positions: [...b.pos].map(([symbol, p]) => ({ symbol, ...p })), equity: b.equity } : undefined;
        },
        priceOf: (v, s) => this.marks.get(`${v}|${s}`) ?? null,
        tiersOf: (v, s) => marketsNow(v)?.tiers.get(s) ?? null,
        priceOfCoin: (c) => this.coinPx.get(c) ?? null,
        wanted: (c) => this.wanted.has(c),
        extra: (v, a, coin) => this.extra(v, a, coin),
      },
      crossed: () => {},
      now: () => Date.now(),
      breathe: () => new Promise((r) => setImmediate(r)),
      book: (v, a) => this.books.get(`${v}|${a}`),
      allKeys: () => [...this.books.keys()],
      allMarks: () => this.marks,
      allCoinPx: () => this.coinPx,
      wanted: () => this.wanted,
      port,
    }, threaded);
    this.links.push(l);
    return l;
  }

  extra(v: Venue, a: string, coin: string) {
    const b = this.books.get(`${v}|${a}`);
    if (!b) return {};
    return logExtraOf({ equity: b.equity, cash: b.cash ?? null, at: b.at }, b.pos, liqCoin, coin, (s) => this.marks.get(`${v}|${s}`) ?? null);
  }

  set(key: string, b: Book | null): void {
    if (b) this.books.set(key, b); else this.books.delete(key);
    const i = key.indexOf('|');
    for (const l of this.links) l.touch(key.slice(0, i) as Venue, key.slice(i + 1));
  }

  mark(v: Venue, sym: string, px: number): void {
    this.marks.set(`${v}|${sym}`, px);
    for (const l of this.links) l.mark(v, sym, px);
  }

  setCoinPx(c: string, px: number): void {
    this.coinPx.set(c, px);
    for (const l of this.links) l.coinPx(c, px);
  }
}

/** A random book: one to three positions, cross with cash or not known, isolated ones (known or not), a venue figure. */
function randomBook(r: () => number, at: number): Book {
  const pos = new Map<string, Pos>();
  const coins = Object.keys(PX);
  const n = 1 + Math.floor(r() * 3);
  for (let i = 0; i < n; i++) {
    const c = coins[Math.floor(r() * coins.length)]!;
    const usd = 1_000 + r() ** 2 * 2_000_000;
    const p: Pos = { szi: +((r() < 0.5 ? -1 : 1) * usd / PX[c]!).toPrecision(6), entry: r() < 0.1 ? null : PX[c]! * (0.95 + r() * 0.1) };
    const k = r();
    if (k < 0.1) { p.iso = usd * (0.05 + r() * 0.2); p.lev = 5 + Math.floor(r() * 15); } else if (k < 0.13) { p.iso = null; p.lev = null; } else if (k < 0.15) p.fix = r() < 0.5 ? 0 : PX[c]! * (r() < 0.5 ? 0.7 : 1.3);
    pos.set(c, p);
  }
  const notional = [...pos].reduce((s, [c, p]) => s + Math.abs(p.szi) * PX[c]!, 0);
  const cash = r() < 0.1 ? null : notional * (0.08 + r() * 0.5) - [...pos].reduce((s, [c, p]) => s + p.szi * PX[c]!, 0);
  return { equity: r() < 0.05 ? null : notional * 0.2, cash, at, pos };
}

const port = () => 19_000 + Math.floor(Math.random() * 20_000);
const open: LiveLink[] = [];
after(async () => { for (const l of open) await l.stop(); });

test('the accounts encoding round-trips every field the engine and the change log read', () => {
  const books = new Map<string, Book>([
    ['hyperliquid|0xa', { equity: null, cash: null, at: 5, pos: new Map<string, Pos>([['BTC', { szi: 1.5, entry: null, iso: null, lev: null }], ['ETH', { szi: -2, entry: 2001, fix: 0 }]]) }],
    ['lighter|0xb', { equity: 10, cash: -3.25, at: 6, pos: new Map<string, Pos>([['SOL', { szi: 7, entry: 150, iso: 12.5, lev: 10, fix: null }]]) }],
  ]);
  const enc = new AccountsEncoder();
  for (const [k, b] of books) enc.add(k, b);
  enc.add('lighter|0xgone', undefined);
  const m = new MirrorSource(liqCoin);
  const touched: string[] = [];
  m.marks.set('hyperliquid|BTC', 80_000);
  m.applyAccounts(enc.take(), (k) => touched.push(k));
  assert.deepEqual(touched, ['hyperliquid|0xa', 'lighter|0xb', 'lighter|0xgone']);
  for (const [k, b] of books) {
    const [v, a] = k.split('|') as [Venue, string];
    const want = { cash: b.cash ?? null, priced: liqKnown(b), positions: [...b.pos].map(([symbol, p]) => { const { entry: _e, ...rest } = p; return { symbol, ...rest }; }), equity: b.equity };
    assert.deepEqual(m.account(v, a, k), want);
    assert.deepEqual(m.extra(v, a, 'BTC'), logExtraOf({ equity: b.equity, cash: b.cash ?? null, at: b.at }, b.pos, liqCoin, 'BTC', (s) => m.marks.get(`${v}|${s}`) ?? null));
  }
  assert.equal(m.account('lighter', '0xgone', 'lighter|0xgone'), undefined);
});

/** The API's copy of the heatmap: every coin whole from a feed reader. */
function heldOf(s: LiqFeedState) {
  const out: Record<string, unknown> = {};
  for (const [coin, c] of s.coins) {
    out[coin] = Object.fromEntries([...c.v].filter(([, x]) => x.c[4]! > 0).map(([v, x]) => [v, { b: [...x.b].map(([i, y]) => [i, ...y]).sort((p, q) => p[0]! - q[0]!), c: x.c, o: x.o }]));
  }
  return out;
}
const rowsOf = (rows: Map<string, LiqNow>) => Object.fromEntries([...rows].map(([c, r]) => [c, Object.fromEntries(Object.entries(r.v).map(([v, x]) => [v, { b: x!.b, c: x!.c, o: x!.o }]))]));

/** Equal as data, whatever order the coins arrived in. */
function same(a: unknown, b: unknown): boolean {
  try { assert.deepStrictEqual(a, b); return true; } catch { return false; }
}

async function until(ok: () => boolean, ms = 10_000, what = 'condition'): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

test('the thread prices a scripted run of books, prints and price moves to the same rows as inline, and the API copy follows', async () => {
  const w = new World();
  const r = rng(7);
  const now = Date.now();
  for (let i = 0; i < 600; i++) w.books.set(`${i % 3 ? 'hyperliquid' : 'lighter'}|0x${i.toString(16).padStart(4, '0')}`, randomBook(r, now));
  const inline = w.link(false, port());
  const pt = port();
  const thread = w.link(true, pt);
  open.push(inline, thread);
  for (const k of w.books.keys()) w.set(k, w.books.get(k)!);
  inline.start();
  thread.start();
  const reader = new LiqFeedState(pt);
  reader.start();
  try {
    assert.deepEqual(rowsOf(await thread.drain()), rowsOf(await inline.drain()), 'the start');
    const keys = [...w.books.keys()];
    for (let round = 0; round < 6; round++) {
      for (let j = 0; j < 80; j++) {
        const k = keys[Math.floor(r() * keys.length)]!;
        const b = w.books.get(k);
        const x = r();
        if (!b || x < 0.15) w.set(k, randomBook(r, now + round));
        else if (x < 0.25) w.set(k, null);
        else {
          // A print: one position grows or shrinks, the cash moves by its fee.
          const [sym, p] = [...b.pos][0]!;
          b.pos.set(sym, { ...p, szi: +(p.szi * (0.5 + r())).toPrecision(6) });
          if (b.cash != null) b.cash -= 1.5;
          w.set(k, b);
        }
      }
      // Prices: ETH a bucket's width and more (cross accounts holding it beside another re-priced), BTC a little.
      w.mark('hyperliquid', 'ETH', w.marks.get('hyperliquid|ETH')! * (1 + (r() - 0.5) * 0.01));
      w.mark('lighter', 'BTC', w.marks.get('lighter|BTC')! * (1 + (r() - 0.5) * 0.002));
      if (round === 3) w.setCoinPx('SOL', PX.SOL! * 1.15);
      assert.deepEqual(rowsOf(await thread.drain()), rowsOf(await inline.drain()), `round ${round}`);
    }
    // The API's copy, once every coin has gone out whole (a reader that connects gets that; so does the minute's refresh).
    await until(() => reader.connected && reader.coins.size > 0, 10_000, 'the feed reader');
    const want = rowsOf(await inline.drain());
    await until(() => same(heldOf(reader), want), 10_000, 'the API copy to match');
  } finally {
    reader.stop();
  }
});

// --- the liquidation step ------------------------------------------------------------------------

/** The step as cohortTracker.ts computed it before the thread (v0.2.198 recordLiq + logLevels), on one engine. */
function stepBefore(live: LiqLive, w: World, ask: StepAsk, state: Map<string, { side: number; liq: number; usd: number }>, addr: Map<string, number>) {
  const rows = live.rows();
  const now = [...rows].map(([coin, row]): [string, Uint8Array] => [coin, deflateRawSync(JSON.stringify(row))]);
  const byCoin = live.positionsByCoin(0, new Set());
  const hist: Array<[string, string]> = [];
  const fine: Array<[string, number, number, Uint8Array]> = [];
  const keep = new Set(ask.coins);
  for (const coin of keep) {
    const row = rows.get(coin);
    if (!row) continue;
    const snap = snapOfNow(row);
    hist.push([coin, JSON.stringify(snap)]);
    const f = fineSnapOf(row.p, snap.st, byCoin.get(coin) ?? [], ask.ticks.get(coin) ?? 0);
    if (f) for (const b of fineBands(f, fineBandWidth(row.p))) fine.push([coin, b.lo, b.hi, deflateRawSync(JSON.stringify(b.f))]);
  }
  const cur = new Map<string, { aid: number | string; coin: string; venue: number; side: number; liq: number; usd: number; address: string; v: Venue }>();
  const fresh = new Set<string>();
  for (const coin of keep) {
    for (const x of byCoin.get(coin) ?? []) {
      const vi = VENUES.indexOf(x.venue);
      let id: number | string | undefined = addr.get(x.address);
      if (id === undefined) { fresh.add(x.address); id = x.address; }
      const key = `${id}|${coin}|${vi}`;
      const usd = Math.round(x.usd);
      const prev = cur.get(key);
      if (prev && prev.usd >= usd) continue;
      cur.set(key, { aid: id, coin, venue: vi, side: x.long ? 1 : -1, liq: +x.liq.toPrecision(8), usd, address: x.address, v: x.venue });
    }
  }
  const changed: object[] = [];
  for (const [key, x] of cur) {
    const was = state.get(key);
    if (!ask.full && was && was.side === x.side && Math.abs(x.liq - was.liq) <= LIQ_LOG_MOVE * was.liq && Math.abs(x.usd - was.usd) <= USD_LOG_MOVE * Math.max(1, was.usd)) continue;
    changed.push(Object.assign(x, w.extra(x.v, x.address, x.coin)));
  }
  const closed: object[] = [];
  for (const key of state.keys()) {
    if (cur.has(key)) continue;
    const [aid, coin, venue] = key.split('|');
    if (!keep.has(coin!)) continue;
    closed.push({ aid: Number(aid), coin: coin!, venue: Number(venue), mark: w.coinPx.get(coin!) ?? null });
  }
  return { now, hist, fine, log: changed.length || closed.length ? { fresh: [...fresh], changed, closed } : null };
}

/** A step's output with the bytes inflated (compared as data) and the timings left out. */
function plain(o: { now?: Array<[string, Uint8Array]>; hist?: Array<[string, string]>; fine?: Array<[string, number, number, Uint8Array]>; log?: unknown }) {
  return {
    now: new Map((o.now ?? []).map(([c, b]) => [c, JSON.parse(inflateRawSync(b).toString())])),
    hist: o.hist,
    fine: (o.fine ?? []).map(([c, lo, hi, b]) => [c, lo, hi, JSON.parse(inflateRawSync(b).toString())]),
    log: o.log,
  };
}
const stepPart = (o: StepOut) => plain({ now: o.now, hist: o.step?.hist, fine: o.step?.fine, log: o.step?.log });

test('the step from the thread equals the step inline and the code it replaced, through a commit and a second step', async () => {
  const w = new World();
  const r = rng(11);
  const now = Date.now();
  for (let i = 0; i < 400; i++) w.books.set(`${i % 4 ? 'hyperliquid' : 'lighter'}|0x${(i + 0x1000).toString(16)}`, randomBook(r, now - i));
  const inline = w.link(false, port());
  const thread = w.link(true, port());
  open.push(inline, thread);
  for (const k of w.books.keys()) w.set(k, w.books.get(k)!);
  inline.start();
  thread.start();
  await inline.drain();
  await thread.drain();
  const live = (inline as unknown as { core: { live: LiqLive } }).core.live;
  // The store's state: a few addresses known already, one position logged before (closed since: never held now).
  const addrs = new Map<string, number>([['0x1001', 1], ['0x1002', 2], ['0x1003', 3]]);
  const cur = [{ aid: 3, coin: 'BTC', venue: VENUES.indexOf('hyperliquid'), side: 1, liq: 1, usd: 5 }];
  const state = new Map(cur.map((c) => [`${c.aid}|${c.coin}|${c.venue}`, { side: c.side, liq: c.liq, usd: c.usd }]));
  const refAddr = new Map(addrs);
  const ask: StepAsk = { now, t: Math.floor(now / 900_000) * 900_000, coins: ['BTC', 'ETH', 'SOL'], ticks: new Map([['BTC', 0.1], ['ETH', 0.01]]), full: false };
  // `cur` row 3|BTC|hyperliquid may be held by 0x1003 now: the reference starts from the same state either way.
  const before = stepBefore(live, w, ask, state, refAddr);
  const a = await inline.step({ ...ask, init: { cur, addrs: new Map(addrs) } });
  const b = await thread.step({ ...ask, init: { cur, addrs: new Map(addrs) } });
  assert.ok(a.ready && b.ready && a.step?.log && b.step?.log);
  assert.deepEqual(stepPart(b), stepPart(a), 'thread = inline');
  assert.deepEqual(stepPart(a), plain(before), 'inline = before the thread');
  assert.ok(a.step.log.changed.length > 300 && a.step.fine.length > 0 && a.step.hist.length === 3);
  // The store gives the new addresses ids; both engines and the reference move their state.
  const ids = new Map(a.step.log.fresh.map((x, i) => [x, 100 + i]));
  inline.commit(ids);
  thread.commit(ids);
  for (const [x, id] of ids) refAddr.set(x, id);
  for (const x of before.log!.changed as Array<{ aid: number | string; coin: string; venue: number; side: number; liq: number; usd: number }>) {
    state.set(`${typeof x.aid === 'number' ? x.aid : ids.get(x.aid)!}|${x.coin}|${x.venue}`, { side: x.side, liq: x.liq, usd: x.usd });
  }
  for (const x of before.log!.closed as Array<{ aid: number; coin: string; venue: number }>) state.delete(`${x.aid}|${x.coin}|${x.venue}`);
  // Some books close, some move, a price moves; the second step logs only those.
  const keys = [...w.books.keys()];
  for (let j = 0; j < 60; j++) {
    const k = keys[Math.floor(r() * keys.length)]!;
    if (j % 3 === 0) w.set(k, null); else w.set(k, randomBook(r, now + 1));
  }
  w.mark('hyperliquid', 'ETH', 2_050);
  await inline.drain();
  await thread.drain();
  const ask2 = { ...ask, now: now + 900_000, t: ask.t! + 900_000 };
  const before2 = stepBefore(live, w, ask2, state, refAddr);
  const a2 = await inline.step(ask2);
  const b2 = await thread.step(ask2);
  assert.deepEqual(stepPart(b2), stepPart(a2), 'second step: thread = inline');
  assert.deepEqual(stepPart(a2), plain(before2), 'second step: inline = before the thread');
  assert.ok(a2.step?.log && a2.step.log.closed.length > 0 && a2.step.log.changed.length < a.step.log.changed.length);
});

test('a killed thread is started again, handed every book, and the feed comes back whole', async () => {
  const w = new World();
  const r = rng(3);
  for (let i = 0; i < 300; i++) w.books.set(`hyperliquid|0x${(i + 0x2000).toString(16)}`, randomBook(r, Date.now()));
  const inline = w.link(false, port());
  const pt = port();
  const thread = w.link(true, pt);
  open.push(inline, thread);
  for (const k of w.books.keys()) w.set(k, w.books.get(k)!);
  inline.start();
  thread.start();
  const want = rowsOf(await inline.drain());
  assert.deepEqual(rowsOf(await thread.drain()), want);
  await until(() => thread.ready, 10_000, 'ready');
  const reader = new LiqFeedState(pt);
  reader.start();
  try {
    await until(() => same(heldOf(reader), want), 10_000, 'the first copy');
    // Gone: the indexer keeps going; what changes meanwhile waits for the new thread.
    await (thread as unknown as { w: { terminate(): Promise<number> } }).w.terminate();
    assert.equal(thread.ready, false);
    const k = [...w.books.keys()][5]!;
    w.set(k, randomBook(r, Date.now()));
    await until(() => thread.status().thread!.restarts === 1 && thread.ready, 15_000, 'the restart');
    const want2 = rowsOf(await inline.drain());
    assert.deepEqual(rowsOf(await thread.drain()), want2, 'the new thread holds every book');
    await until(() => same(heldOf(reader), want2), 20_000, 'the reader to reconnect');
  } finally {
    reader.stop();
  }
});

test('while this thread is held for 5 s, the heatmap thread keeps pricing and sending', async () => {
  const w = new World();
  const r = rng(5);
  const now = Date.now();
  for (let i = 0; i < 2_000; i++) w.books.set(`hyperliquid|0x${(i + 0x4000).toString(16)}`, randomBook(r, now));
  const pt = port();
  const thread = w.link(true, pt);
  open.push(thread);
  for (const k of w.books.keys()) w.set(k, w.books.get(k)!);
  thread.start();
  await thread.drain();
  await until(() => thread.ready && thread.status().readers === 0, 10_000, 'ready');
  // A raw reader: what it receives is read only after the hold, with the thread's own time in each tick frame.
  const lines: string[] = [];
  const sock = net.connect(pt, '127.0.0.1');
  let buf = '';
  sock.setEncoding('utf8');
  sock.on('data', (c: string) => { buf += c; let i; while ((i = buf.indexOf('\n')) >= 0) { lines.push(buf.slice(0, i)); buf = buf.slice(i + 1); } });
  await until(() => thread.status().readers === 1 && lines.length > 0, 10_000, 'the reader');
  // 60k more books handed over, then the hold: they are priced and sent during it.
  for (let i = 0; i < 60_000; i++) w.set(`hyperliquid|0x${(i + 0x10000).toString(16)}`, randomBook(r, now));
  await until(() => thread.status().thread!.queued === 0, 30_000, 'the hand-over');
  lines.length = 0;
  const holdFrom = Date.now();
  while (Date.now() - holdFrom < 5_000) { /* this thread held, as by a long SQLite write */ }
  const holdTo = Date.now();
  await new Promise((r) => setTimeout(r, 300));
  sock.destroy();
  const frames = lines.map((l) => JSON.parse(l) as { t: string; at?: number; coin?: string });
  const ticks = frames.filter((f) => f.t === 'tick' && f.at! >= holdFrom && f.at! <= holdTo);
  let deltasDuring = 0;
  let run = 0;
  for (const f of frames) {
    if (f.t === 'd') run++;
    else if (f.t === 'tick') { if (f.at! >= holdFrom && f.at! <= holdTo) deltasDuring += run; run = 0; }
  }
  assert.ok(ticks.length >= 4, `tick frames during the hold: ${ticks.length}`);
  assert.ok(deltasDuring > 0, 'coin deltas sent during the hold');
});
