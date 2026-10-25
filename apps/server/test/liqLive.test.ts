/**
 * Run: npx tsx --test test/liqLive.test.ts   (from apps/server)
 *
 * The live engine against a full recompute (LevelsBuilder over the same books),
 * and the indexer -> API feed over a real loopback socket.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Venue } from '../src/valuescan/types.js';
import { LiqLive, type LiveAccount } from '../src/valuescan/liquidations/live.js';
import { LevelsBuilder, eachLevel } from '../src/valuescan/liquidations/levels.js';
import { flatTiers } from '../src/valuescan/liquidations/math.js';
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
      eachLevel(v, [[a, { cash: b.cash, positions: b.positions }]], (s) => marks.get(`${v}|${s}`) ?? null, () => T, (coin, szi, liq) => lb.add(v, coin, szi, liq, null));
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
