/**
 * Manipulation protection: the reference price and its two checks.
 * Run: npx tsx --test test/priceGuard.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_REFERENCE, HyperliquidClient, fetchQuotes, marketOrderAllowed, referencePrice, triggerHit, venueSymbol,
  type FetchLike, type ReferenceConfig, type SourceQuote,
} from '../src/index.ts';

const NOW = 1_000_000;
const q = (source: SourceQuote['source'], price: number, age = 0): SourceQuote => ({ source, price, at: NOW - age });
const cfg = (o: Partial<ReferenceConfig> = {}): ReferenceConfig => ({
  weights: { sodex: 1, hyperliquid: 1, aster: 1, binance: 1 }, method: 'mean', maxAgeMs: 10_000, maxDeviationBps: null, minSources: 1, ...o,
});

test('weighted mean and weighted median', () => {
  const quotes = [q('binance', 100), q('hyperliquid', 101), q('sodex', 104)];
  const mean = referencePrice(quotes, cfg({ weights: { binance: 2, hyperliquid: 1, sodex: 1 } }), NOW)!;
  assert.equal(mean.price, (200 + 101 + 104) / 4);
  const med = referencePrice(quotes, cfg({ method: 'median', weights: { binance: 2, hyperliquid: 1, sodex: 1 } }), NOW)!;
  // Half the weight (2 of 4) sits at 100: the midpoint of 100 and the next price.
  assert.equal(med.price, 100.5);
  assert.ok(Math.abs(mean.spreadBps - (4 / mean.price) * 10_000) < 1e-9);
});

test('stale, unweighted, invalid and missing sources are dropped and named', () => {
  const r = referencePrice([q('binance', 100), q('hyperliquid', 0), q('sodex', 99, 60_000)], cfg({ weights: { binance: 1, hyperliquid: 1, sodex: 1, aster: 1 } }), NOW)!;
  assert.equal(r.price, 100);
  assert.deepEqual(r.dropped.map((d) => `${d.source}:${d.reason}`).sort(), ['aster:missing', 'hyperliquid:invalid', 'sodex:stale']);
  const off = referencePrice([q('binance', 100)], cfg({ weights: { binance: 0, sodex: 1 } }), NOW);
  assert.equal(off, null, 'nothing usable: no reference');
});

test('one venue pumped far from the others is an outlier and does not move the price', () => {
  const quotes = [q('binance', 100), q('hyperliquid', 100.1), q('aster', 99.95), q('sodex', 112)];
  const r = referencePrice(quotes, cfg({ maxDeviationBps: 100 }), NOW)!;
  assert.deepEqual(r.dropped, [{ source: 'sodex', reason: 'outlier' }]);
  assert.ok(Math.abs(r.price - (100 + 100.1 + 99.95) / 3) < 1e-9);
  // With fewer than three quotes nobody can tell which one is off: both are kept.
  const two = referencePrice([q('binance', 100), q('sodex', 112)], cfg({ maxDeviationBps: 100 }), NOW)!;
  assert.equal(two.used.length, 2);
});

test('minSources: too few usable venues is no price, and a trigger never fires blind', () => {
  const r = referencePrice([q('binance', 100)], cfg({ minSources: 2 }), NOW);
  assert.equal(r, null);
  assert.equal(triggerHit({ when: 'below', level: 200 }, r), false);
});

test('a stop on the reference ignores a wick on one venue', () => {
  // SoDEX alone prints 90 against a market at 100: the median of the four stays near 100.
  const ref = referencePrice([q('binance', 100), q('hyperliquid', 100.05), q('aster', 99.98), q('sodex', 90)], DEFAULT_REFERENCE, NOW);
  assert.equal(triggerHit({ when: 'below', level: 95 }, ref), false);
  assert.equal(triggerHit({ when: 'above', level: 99 }, ref), true);
});

test('market guard: a buy into a venue above the reference, or a sell into one below, is refused', () => {
  const ref = referencePrice([q('binance', 100)], cfg(), NOW);
  const g = { enabled: true, slippageBps: 50 };
  const within = marketOrderAllowed('buy', 100.4, ref, g);
  assert.equal(within.ok, true);
  assert.equal(within.reason, 'within');
  assert.ok(Math.abs(within.deviationBps! - 40) < 1e-6);
  assert.equal(marketOrderAllowed('buy', 100.6, ref, g).reason, 'venue-above-reference');
  assert.equal(marketOrderAllowed('sell', 100.6, ref, g).ok, true, 'selling above the reference is in your favour');
  assert.equal(marketOrderAllowed('sell', 99.4, ref, g).reason, 'venue-below-reference');
  assert.equal(marketOrderAllowed('sell', 100.6, ref, { ...g, symmetric: true }).ok, false);
  assert.equal(marketOrderAllowed('buy', 100.6, null, g).reason, 'no-reference');
  assert.equal(marketOrderAllowed('buy', 150, null, { enabled: false, slippageBps: 50 }).ok, true, 'off: today\'s behaviour');
});

test('venue spellings and 1000x contracts are per one coin', () => {
  assert.deepEqual(venueSymbol('sodex', 'btc'), { symbol: 'BTC-USD', unitsPerContract: 1 });
  assert.deepEqual(venueSymbol('binance', 'ETH'), { symbol: 'ETHUSDT', unitsPerContract: 1 });
  assert.deepEqual(venueSymbol('hyperliquid', 'PEPE'), { symbol: 'kPEPE', unitsPerContract: 1000 });
});

test('fetchQuotes reads every weighted venue, scales 1000x markets, and skips a failing one', async () => {
  const seen: string[] = [];
  const fake: FetchLike = async (url, init) => {
    seen.push(url);
    const ok = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
    if (url.startsWith('https://fapi.binance.com/fapi/v1/premiumIndex?symbol=1000PEPEUSDT')) return ok({ symbol: '1000PEPEUSDT', markPrice: '0.0105', time: NOW - 1 });
    if (url.startsWith('https://fapi.asterdex.com/')) return { ok: false, status: 503, text: async () => 'down' };
    if (url === 'https://api.hyperliquid.xyz/info') {
      assert.equal(JSON.parse(String(init?.body)).type, 'metaAndAssetCtxs');
      return ok([{ universe: [{ name: 'BTC' }, { name: 'kPEPE' }] }, [{ markPx: '80000' }, { markPx: '0.0104' }]]);
    }
    throw new Error(`unexpected ${url}`);
  };
  const quotes = await fetchQuotes('PEPE', { weights: { binance: 1, aster: 1, hyperliquid: 1, sodex: 1 } }, {
    fetch: fake,
    hyperliquid: new HyperliquidClient(fake),
    sodex: { markPrices: async () => [{ symbol: 'PEPE-USD', price: 0.0000106 }] },
    now: () => NOW,
  });
  const by = Object.fromEntries(quotes.map((x) => [x.source, x.price]));
  assert.deepEqual(Object.keys(by).sort(), ['binance', 'hyperliquid', 'sodex'], 'aster answered 503 and is absent');
  assert.ok(Math.abs(by.binance! - 0.0000105) < 1e-15);
  assert.ok(Math.abs(by.hyperliquid! - 0.0000104) < 1e-15);
  assert.equal(by.sodex, 0.0000106);
});
