/**
 * Run: npx tsx --test test/liqLive.test.ts   (from apps/server)
 *
 * The live engine against a full recompute (LevelsBuilder over the same books),
 * and the indexer -> API feed over a real loopback socket.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Venue } from '../src/valuedesk/types.js';
import { LiqLive, type LiveAccount } from '../src/valuedesk/liquidations/live.js';
import { LevelsBuilder, eachLevel } from '../src/valuedesk/liquidations/levels.js';
import { flatTiers } from '../src/valuedesk/liquidations/math.js';
import { LiqFeedServer, LiqFeedState } from '../src/indexer/liqFeed.js';

const T = flatTiers(0.0125);

function world() {
  const books = new Map<string, LiveAccount>();
  const marks = new Map<string, number>([['hyperliquid|BTC', 80_000], ['hyperliquid|ETH', 2_000], ['lighter|BTC', 80_010]]);
  const live = new LiqLive({
    account: (v, a) => books.get(`${v}|${a}`),
    priceOf: (v, s) => marks.get(`${v}|${s}`) ?? null,
    tiersOf: () => T,
    priceOfCoin: (c) => (c === 'BTC' ? marks.get('hyperliquid|BTC')! : c === 'ETH' ? marks.get('hyperliquid|ETH')! : null),
  });
  /** The same books priced from scratch. */
  const full = () => {
    const lb = new LevelsBuilder((c) => (c === 'BTC' ? 80_000 : c === 'ETH' ? 2_000 : null));
    for (const [k, b] of books) {
      const [v, a] = k.split('|') as [Venue, string];
      if (!b.priced) { for (const p of b.positions) lb.add(v, 'BTC', p.szi, null, null); continue; }
      eachLevel(v, [[a, { cash: b.cash, positions: b.positions, equity: b.equity }]], (s) => marks.get(`${v}|${s}`) ?? null, () => T, (coin, szi, liq, _px, lev) => lb.add(v, coin, szi, liq, null, lev));
    }
    return lb.rows();
  };
  return { books, marks, live, full };
}

const strip = (rows: Map<string, { v: Record<string, { b: unknown; c: number[]; o: unknown }> }>) => {
  const out: Record<string, unknown> = {};
  for (const [coin, r] of rows) {
    out[coin] = Object.fromEntries(Object.entries(r.v).map(([v, x]) => [v, { b: x.b, c: x.c.slice(0, 5), o: x.o }]));
  }
  return out;
};

test('the engine equals a full recompute through adds, prints, price moves and a book that empties', () => {
  const { books, marks, live, full } = world();
  books.set('hyperliquid|0xa', { cash: 90_000, priced: true, positions: [{ symbol: 'BTC', szi: -1 }] });
  books.set('hyperliquid|0xb', { cash: 50_000, priced: true, positions: [{ symbol: 'BTC', szi: 2 }, { symbol: 'ETH', szi: -20 }] });
  books.set('lighter|0xc', { cash: -60_000, priced: true, positions: [{ symbol: 'BTC', szi: 1 }] });
  books.set('hyperliquid|0xd', { cash: null, priced: false, positions: [{ symbol: 'BTC', szi: 3 }] });
  for (const k of books.keys()) { const [v, a] = k.split('|') as [Venue, string]; live.touch(v, a); }
  live.work();
  const first = live.flush();
  assert.ok(first.every((d) => d.whole), 'new coins go out whole');
  assert.deepEqual(strip(live.rows() as never), strip(full() as never));

  // A print grows 0xa's short; ETH moves 1% (0xb holds BTC beside it: re-priced), BTC moves 1% (no one-position account changes).
  books.get('hyperliquid|0xa')!.positions = [{ symbol: 'BTC', szi: -1.5 }];
  live.touch('hyperliquid', '0xa');
  marks.set('hyperliquid|ETH', 2_020);
  live.mark('hyperliquid', 'ETH', 2_020);
  live.work();
  assert.deepEqual(strip(live.rows() as never), strip(full() as never));
  const d = live.flush();
  assert.ok(d.length && d.every((x) => !x.whole));
  assert.equal(live.flush().length, 0, 'nothing changed since');

  // A move under a bucket's width re-prices nobody.
  live.mark('hyperliquid', 'ETH', 2_020.1);
  assert.equal(live.pending, 0);

  // The book empties: everything it added is gone.
  books.set('lighter|0xc', { cash: -60_000, priced: true, positions: [] });
  live.touch('lighter', '0xc');
  live.work();
  assert.deepEqual(strip(live.rows() as never), strip(full() as never));
  const bt = live.rows().get('BTC')!;
  assert.equal(bt.v.lighter?.b.length ?? 0, 0);
});

test('only the coins asked for are bucketed; the others still count toward the margin of the account', () => {
  const books = new Map<string, LiveAccount>([['hyperliquid|0xb', { cash: 50_000, priced: true, positions: [{ symbol: 'BTC', szi: 2 }, { symbol: 'ETH', szi: -20 }] }]]);
  const marks = new Map([['hyperliquid|BTC', 80_000], ['hyperliquid|ETH', 2_000]]);
  const mk = (wanted?: (c: string) => boolean) => new LiqLive({
    account: (v, a) => books.get(`${v}|${a}`), priceOf: (v, s) => marks.get(`${v}|${s}`) ?? null, tiersOf: () => T,
    priceOfCoin: (c) => (c === 'BTC' ? 80_000 : 2_000), wanted,
  });
  const all = mk();
  const btcOnly = mk((c) => c === 'BTC');
  for (const l of [all, btcOnly]) { l.touch('hyperliquid', '0xb'); l.work(); }
  assert.deepEqual([...btcOnly.rows().keys()], ['BTC']);
  assert.deepEqual(btcOnly.rows().get('BTC'), all.rows().get('BTC'), 'BTC priced the same: the ETH short still counts');
});

test('the feed: whole coins to a new reader, then changes; the API side holds them whole', async () => {
  const { books, live } = world();
  books.set('hyperliquid|0xa', { cash: 90_000, priced: true, positions: [{ symbol: 'BTC', szi: -1 }] });
  live.touch('hyperliquid', '0xa');
  live.work();
  live.flush();
  const port = 18_796 + Math.floor(Math.random() * 500);
  const server = new LiqFeedServer(() => live.resendAll(), port);
  server.start();
  const state = new LiqFeedState(port);
  const ticks: number[] = [];
  state.on('tick', (t: number) => ticks.push(t));
  state.start();
  try {
    for (let i = 0; i < 50 && !server.readers; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(server.readers, 1);
    server.send(live.flush(), { at: 1, ready: true });
    for (let i = 0; i < 50 && !ticks.length; i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(state.live);
    const c = state.coins.get('BTC')!;
    assert.equal(c.v.get('hyperliquid')!.c[4], 1);
    // A second short: one bucket changes, and the API's copy follows.
    books.set('hyperliquid|0xb', { cash: 45_000, priced: true, positions: [{ symbol: 'BTC', szi: -0.5 }] });
    live.touch('hyperliquid', '0xb');
    live.work();
    server.send(live.flush(), { at: 2, ready: true });
    for (let i = 0; i < 50 && ticks.length < 2; i++) await new Promise((r) => setTimeout(r, 20));
    const rows = live.rows().get('BTC')!.v.hyperliquid!;
    const mine = [...state.coins.get('BTC')!.v.get('hyperliquid')!.b].map(([i, y]) => [i, ...y]).sort((a, b) => a[0]! - b[0]!);
    assert.deepEqual(mine, rows.b);
  } finally {
    state.stop();
    server.stop();
  }
});

test('a beat stops at its time budget and the rest waits, oldest first, to the same result', () => {
  const { books, live, full } = world();
  for (let i = 0; i < 300; i++) books.set(`hyperliquid|0x${i}`, { cash: 50_000 + i * 100, priced: true, positions: [{ symbol: 'BTC', szi: i % 2 ? 1 : -1 }] });
  for (const k of books.keys()) live.touch('hyperliquid', k.slice('hyperliquid|'.length));
  assert.equal(live.work(5_000, 0), 300 - 64, 'a spent budget ends the beat at its next check');
  while (live.work(5_000, 0) > 0) { /* the next beats */ }
  live.flush();
  assert.deepEqual(strip(live.rows()), strip(full()));
});

test('the accounts waiting at one moment are the next ones priced, however busy the prints keep it', () => {
  const { books, live } = world();
  const add = (i: number) => books.set(`hyperliquid|0x${i}`, { cash: 50_000, priced: true, positions: [{ symbol: 'BTC', szi: 1 }] });
  for (let i = 0; i < 100; i++) { add(i); live.touch('hyperliquid', `0x${i}`); }
  // The indexer's readiness barrier (cohortTracker.ts liveTick): what waits now, counted from now.
  const barrier = live.processed + live.pending;
  let beats = 0;
  while (live.processed < barrier) {
    live.work(30);
    // Every beat, prints touch new books and books already waiting: the queue never runs dry...
    for (let j = 0; j < 40; j++) { const i = 100 + beats * 40 + j; add(i); live.touch('hyperliquid', `0x${i}`); }
    live.touch('hyperliquid', '0x99');
    beats++;
  }
  assert.ok(live.pending > 0, 'still busy');
  // ...yet the 100 books waiting at the start are priced after 100 / 30 beats, not never.
  assert.equal(beats, 4);
});

test('per coin, the positions worth the minimum - and every one of a watched wallet - with venue, address and level', () => {
  const { books, live } = world();
  books.set('hyperliquid|0xbig', { cash: -1_440_000, priced: true, positions: [{ symbol: 'BTC', szi: 20 }] }); // 10x: equity 160k
  books.set('hyperliquid|0xsmall', { cash: -7_200, priced: true, positions: [{ symbol: 'BTC', szi: 0.1 }] });
  books.set('hyperliquid|0xwatched', { cash: 8_800, priced: true, positions: [{ symbol: 'BTC', szi: -0.1 }] });
  for (const a of ['0xbig', '0xsmall', '0xwatched']) live.touch('hyperliquid', a);
  live.work();
  live.flush();
  const got = live.positionsByCoin(100_000, new Set(['0xwatched'])).get('BTC') ?? [];
  assert.deepEqual(got.map((x) => [x.address, x.long]).sort(), [['0xbig', true], ['0xwatched', false]]);
  for (const x of got) assert.ok(x.liq > 0 && x.usd > 0 && x.venue === 'hyperliquid');
});

test('the minute refresh goes a few coins at a time, each coin once a round, not every coin in one flush', () => {
  const { books, live } = world();
  books.set('hyperliquid|0xa', { cash: 90_000, priced: true, positions: [{ symbol: 'BTC', szi: -1 }] });
  books.set('hyperliquid|0xb', { cash: 50_000, priced: true, positions: [{ symbol: 'ETH', szi: -20 }] });
  books.set('lighter|0xc', { cash: -60_000, priced: true, positions: [{ symbol: 'BTC', szi: 1 }] });
  for (const k of books.keys()) { const [v, a] = k.split('|') as [Venue, string]; live.touch(v, a); }
  live.work();
  live.flush();
  assert.equal(live.coinCount, 2);
  const sent: string[] = [];
  for (let k = 0; k < 4; k++) {
    live.resendSome(1);
    const d = live.flush();
    assert.equal(d.length, 1, 'one coin a send');
    assert.ok(d[0]!.whole && d[0]!.f?.whole, 'whole, its fine layer too');
    sent.push(d[0]!.coin);
  }
  assert.deepEqual(sent.slice(0, 2).sort(), ['BTC', 'ETH']);
  assert.deepEqual(sent.slice(2).sort(), ['BTC', 'ETH'], 'each once per round');
  live.resendSome(5);
  assert.equal(live.flush().length, 2, 'more asked than coins: every coin once');
});
