/**
 * Market reads by name (sodexMarket.ts withMarket): the read goes out together
 * with the market list instead of after it - that list only confirms the
 * market exists - so the book's first paint costs one round trip, not two. An
 * id or a display name still waits for the list; a name that is not safe in a
 * URL path never reaches one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const SYMBOLS_DELAY_MS = 150;
const calls: Array<{ path: string; t: number }> = [];
let t0 = Date.now();

// The app's gateway client calls the global fetch; answer like SoDEX would.
globalThis.fetch = (async (input: string | URL) => {
  const url = new URL(String(input));
  calls.push({ path: url.pathname + url.search, t: Date.now() - t0 });
  const ok = (data: unknown) => new Response(JSON.stringify({ code: 0, data }), { status: 200 });
  if (url.pathname.endsWith('/markets/symbols')) {
    await new Promise((r) => setTimeout(r, SYMBOLS_DELAY_MS));
    return ok([{ id: 1, name: 'BTC-USD', displayName: 'BTC/USD', baseCoin: 'BTC', quoteCoin: 'USD' }]);
  }
  if (url.pathname.endsWith('/orderbook')) return ok({ s: url.pathname.split('/')[5], b: [['1', '1']], a: [['2', '1']] });
  if (url.pathname.endsWith('/trades')) return ok([]);
  if (url.pathname.endsWith('/klines')) return ok([{ t: 60_000, o: '1', h: '2', l: '1', c: '2', v: '3' }]);
  return new Response(JSON.stringify({ code: 404, message: 'not found' }), { status: 404 });
}) as typeof fetch;

const { freshTicker, market, MarketRequestError } = await import('./sodexMarket');

test('market: a book read by name goes out together with the market list, not after it', async () => {
  calls.length = 0;
  t0 = Date.now();
  const r = await market.orderbook('perps', 'BTC-USD', 20);
  const book = calls.find((c) => c.path.includes('/orderbook'))!;
  assert.ok(calls.some((c) => c.path.endsWith('/markets/symbols')), 'the list is still read (it confirms the market)');
  assert.ok(book.t < SYMBOLS_DELAY_MS, `the book did not wait for the list (sent at ${book.t} ms)`);
  assert.equal(r.symbol, 'BTC-USD');
  assert.deepEqual(r.book, { s: 'BTC-USD', b: [['1', '1']], a: [['2', '1']] });
});

test('market: a display name or an id waits for the list and reads by the canonical name', async () => {
  for (const ref of ['BTC/USD', '1']) {
    calls.length = 0;
    const r = await market.orderbook('perps', ref, 20);
    assert.equal(r.symbol, 'BTC-USD');
    const books = calls.filter((c) => c.path.includes('/orderbook'));
    assert.deepEqual(books.map((c) => c.path), ['/api/v1/perps/markets/BTC-USD/orderbook?limit=20'], ref);
  }
});

test('market: an unknown market is still refused', async () => {
  await assert.rejects(market.trades('perps', 'NOPE-USD', 10), (e: unknown) => e instanceof MarketRequestError && e.status === 404);
});

test('market: a name that is not safe in a URL path never reaches one', async () => {
  calls.length = 0;
  await assert.rejects(market.orderbook('perps', '../accounts/0xabc/trades', 20));
  assert.ok(calls.every((c) => !c.path.includes('accounts')), calls.map((c) => c.path).join(', '));
});

test('market: candle pages stay out of the gateway\'s last-good copies', async () => {
  const { gateway } = await import('./sodexGateway');
  const r = await market.klines('perps', 'BTC-USD', '1m', 5);
  assert.equal(r.klines.length, 1);
  assert.equal(gateway.lastGood('/api/v1/perps/markets/BTC-USD/klines?interval=1m&limit=5'), null);
  // A read that may be fallen back to still is kept.
  await market.orderbook('perps', 'BTC-USD', 20);
  assert.ok(gateway.lastGood('/api/v1/perps/markets/BTC-USD/orderbook?limit=20'));
});

const staleBase = { symbol: 'vADA_vUSDC', lastPx: '0.5', openPx: '0.4', highPx: '0.6', lowPx: '0.3', volume: '10', quoteVolume: '727', change: '0.1', changePct: 2.45, askPx: '0.51', bidPx: '0.49' };
const staleNow = 1_800_000_000_000;

test('a ticker window closed over 24 h ago is empty: no volume, no move; the price and the book stay', () => {
  const out = freshTicker({ ...staleBase, closeTime: staleNow - 86_400_001 }, staleNow);
  assert.equal(out.quoteVolume, '0');
  assert.equal(out.volume, '0');
  assert.equal(out.changePct, 0);
  assert.equal(out.lowPx, '0.5');
  assert.equal(out.lastPx, '0.5');
  assert.equal(out.askPx, '0.51');
});

test('a live ticker window, and one with no close time, stay as they are', () => {
  const live = { ...staleBase, closeTime: staleNow - 1_000 };
  assert.equal(freshTicker(live, staleNow), live);
  assert.equal(freshTicker(staleBase, staleNow), staleBase);
});
