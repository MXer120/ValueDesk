/**
 * Run: npx tsx --test test/liqCrossed.test.ts   (from apps/server)
 *
 * Audit 2026-10-30: the live map priced $29.7M of BTC longs on Hyperliquid ABOVE the price (up to
 * $226,960) and $4.5M of shorts below it - books whose figures are stale. The web hid them; now the
 * engine reports each such account (LiqLive `crossed`) and the tracker reads it again first.
 * And "% priced" mixed "no liquidation price exists" (a 1x long) with "not known": the engine now
 * counts the first apart (coverage c[6] / c[7]).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Venue } from '../src/valuedesk/types.js';
import { LiqLive, type LiveAccount } from '../src/valuedesk/liquidations/live.js';
import { accountLiqs, flatTiers } from '../src/valuedesk/liquidations/math.js';
import { CROSSED_MIN_AGE_MS, crossedDue, crossedPrio, liqBacklogPrio } from '../src/indexer/cohortTracker.js';

const T = flatTiers(0.0125);

function engine(books: Map<string, LiveAccount>, px: number) {
  const seen: Array<[Venue, string, number]> = [];
  const live = new LiqLive({
    account: (v, a) => books.get(`${v}|${a}`),
    priceOf: () => px,
    tiersOf: () => T,
    priceOfCoin: () => px,
    crossed: (v, a, usd) => seen.push([v, a, usd]),
  });
  return { live, seen };
}

test('an account priced with a crossed level is reported, with the crossed notional; a sound one is not', () => {
  const books = new Map<string, LiveAccount>([
    // A long whose cash went (a stale book): liquidation price above the price.
    ['hyperliquid|0xstale', { cash: -85_000, priced: true, positions: [{ symbol: 'BTC', szi: 1 }] }],
    // A short far below its liquidation price: sound.
    ['hyperliquid|0xok', { cash: 90_000, priced: true, positions: [{ symbol: 'BTC', szi: -1 }] }],
    // A short whose level sits below the price.
    ['lighter|0xshort', { cash: 70_000, priced: true, positions: [{ symbol: 'BTC', szi: -1 }] }],
    // Not priced: nothing to say.
    ['hyperliquid|0xunpriced', { cash: null, priced: false, positions: [{ symbol: 'BTC', szi: 1 }] }],
  ]);
  const { live, seen } = engine(books, 77_000);
  for (const k of books.keys()) { const [v, a] = k.split('|') as [Venue, string]; live.touch(v, a); }
  live.work();
  const by = new Map(seen.map(([v, a, usd]) => [`${v}|${a}`, usd]));
  assert.deepEqual([...by.keys()].sort(), ['hyperliquid|0xstale', 'lighter|0xshort']);
  const [stale] = accountLiqs(-85_000, [{ symbol: 'BTC', szi: 1 }], () => 77_000, () => T);
  assert.ok(stale! > 77_000, `the stale long's level ${stale} is above the price`);
  assert.ok(Math.abs(by.get('hyperliquid|0xstale')! - stale!) < 1e-6, 'its notional at its level');
});

test('crossed books are read again first (above every other queue), but not within minutes of their last read', () => {
  const now = 1_000_000_000;
  assert.equal(crossedDue(now - CROSSED_MIN_AGE_MS + 1, now), false, 'just read: the venue itself may be liquidating it');
  assert.equal(crossedDue(now - CROSSED_MIN_AGE_MS, now), true);
  assert.equal(crossedDue(undefined, now), true);
  assert.ok(crossedPrio(100) > liqBacklogPrio(1e9, 1), 'above the largest book still missing liquidation data');
  assert.ok(crossedPrio(1_000_000) > crossedPrio(10_000), 'the most notional first');
});

test('coverage keeps "no liquidation price exists" apart from "not known"', () => {
  const books = new Map<string, LiveAccount>([
    // A 1x long: the account carries it to zero - no liquidation price, known.
    ['hyperliquid|0xone', { cash: 0, priced: true, positions: [{ symbol: 'BTC', szi: 2 }] }],
    // The venue said "none" (kept as read).
    ['hyperliquid|0xfix', { cash: null, priced: true, positions: [{ symbol: 'BTC', szi: -3, fix: 0 }] }],
    // Not read for liquidation data yet: not known.
    ['hyperliquid|0xnew', { cash: null, priced: false, positions: [{ symbol: 'BTC', szi: 5 }] }],
    // A leveraged long: priced.
    ['hyperliquid|0xlev', { cash: -60_000, priced: true, positions: [{ symbol: 'BTC', szi: 1 }] }],
  ]);
  const { live } = engine(books, 77_000);
  for (const k of books.keys()) { const [v, a] = k.split('|') as [Venue, string]; live.touch(v, a); }
  live.work();
  const c = live.rows().get('BTC')!.v.hyperliquid!.c;
  // [long, short, long priced, short priced, positions, past, long none, short none]
  assert.deepEqual(c, [8, 3, 1, 0, 4, 0, 2, 3]);
  const none: boolean[] = [];
  accountLiqs(0, [{ symbol: 'BTC', szi: 2 }, { symbol: 'ETH', szi: 1 }], (s) => (s === 'BTC' ? 77_000 : null), () => T, none);
  assert.deepEqual(none, [false, false], 'a missing price makes the account unknown, not "none"');
});
