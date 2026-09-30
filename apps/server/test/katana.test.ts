/**
 * Venue-abstraction tests: interval validation, response normalisation, the
 * rate-limit bucket and the backoff maths.
 *
 * DELIBERATELY OFFLINE. Nothing here opens a socket. A test that hit Katana would
 * be flaky the moment the venue hiccupped, and - because Katana allows only ~5
 * requests per second per IP - a test suite that polled it would spend the same
 * budget the running app needs, making the app fail while the tests were green.
 * Every fixture below is a verbatim record from a live response, so the parsing
 * is tested against reality without depending on reality being reachable.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  KATANA_BACKOFF_CAP_MS,
  KATANA_INTERVALS,
  KATANA_MAX_BOOK_DEPTH,
  KatanaApiError,
  TokenBucket,
  bookLimitForDepth,
  isKatanaInterval,
  katanaBackoffMs,
  katanaErrorFrom,
  katanaRetryKind,
} from '../src/venues/katana/rest.js';
import {
  canonicalMarket,
  normaliseKatanaBook,
  normaliseKatanaCandle,
  normaliseKatanaMarket,
  normaliseKatanaTicker,
  normaliseKatanaTrade,
  takerSideFromMaker,
  type KatanaBook,
  type KatanaCandle,
  type KatanaMarket,
  type KatanaTicker,
  type KatanaTrade,
} from '../src/venues/katana/index.js';
import {
  SODEX_INTERVALS,
  normaliseSodexBook,
  normaliseSodexKline,
  normaliseSodexTicker,
  normaliseSodexTrade,
} from '../src/venues/sodex.js';
import {
  UnsupportedIntervalError,
  VenueRequestError,
  clampLimit,
  decStr,
  numOrNull,
  sortCandlesOldestFirst,
  sortTradesNewestFirst,
  type VenueCandle,
  type VenueTrade,
} from '../src/venues/types.js';

// --- interval validation -----------------------------------------------------

test('katana accepts exactly the seven intervals it serves', () => {
  assert.deepEqual([...KATANA_INTERVALS], ['1m', '5m', '15m', '30m', '1h', '4h', '1d']);
  for (const iv of KATANA_INTERVALS) assert.equal(isKatanaInterval(iv), true, iv);
});

test('katana rejects 3m, 6h, 12h and 1w', () => {
  // Each of these is a plausible-looking interval that the live API answers with
  // HTTP 400 INVALID_PARAMETER. Rejecting locally saves a round trip and, more
  // to the point, saves a rate-limit token that a real request would burn.
  for (const iv of ['3m', '6h', '12h', '1w']) {
    assert.equal(isKatanaInterval(iv), false, `${iv} must be rejected`);
  }
});

test('katana interval validation is case- and type-strict', () => {
  // Katana spells the daily bucket '1d'; SoDEX spells its own '1D'. Accepting
  // either here would push a guaranteed 400 out to the venue.
  assert.equal(isKatanaInterval('1D'), false);
  assert.equal(isKatanaInterval('1M'), false);
  assert.equal(isKatanaInterval(''), false);
  assert.equal(isKatanaInterval(undefined), false);
  assert.equal(isKatanaInterval(60), false);
});

test('the two venues do not share an interval vocabulary', () => {
  // The reason VenueInfo carries per-venue `intervals` instead of one constant.
  const sodexOnly = SODEX_INTERVALS.filter((i) => !isKatanaInterval(i));
  assert.ok(sodexOnly.includes('1D'), 'SoDEX 1D is not a Katana interval');
  assert.ok(sodexOnly.includes('3m'), 'SoDEX 3m is not a Katana interval');
  assert.ok(!(SODEX_INTERVALS as readonly string[]).includes('1d'), 'SoDEX has no lowercase 1d');
});

test('UnsupportedIntervalError reports the alternatives and is a 400', () => {
  const e = new UnsupportedIntervalError('katana-perps', '3m', KATANA_INTERVALS);
  assert.equal(e.statusCode, 400);
  assert.equal(e.interval, '3m');
  assert.deepEqual([...e.supported], [...KATANA_INTERVALS]);
  assert.ok(e instanceof VenueRequestError);
});

// --- orderbook depth conversion ----------------------------------------------

test('per-side depth is doubled into Katana total-levels limit', () => {
  // Measured on the live API: limit=10 -> 5 bids + 5 asks, limit=50 -> 25 + 25.
  // Katana's `limit` counts BOTH sides, so a per-side depth must be doubled or
  // the caller silently receives half the ladder it asked for.
  assert.equal(bookLimitForDepth(5), 10);
  assert.equal(bookLimitForDepth(25), 50);
  assert.equal(bookLimitForDepth(100), 200);
});

test('a one-level request is widened to Katana minimum of 2', () => {
  // limit=1 is answered with "must be between 2 and 1,000", so a depth-1 request
  // has to be widened; the caller's own slice trims the extra level back off.
  assert.equal(bookLimitForDepth(1), 2);
  assert.equal(bookLimitForDepth(0), 2);
  assert.equal(bookLimitForDepth(-5), 2);
});

test('book depth never exceeds the venue maximum', () => {
  assert.equal(bookLimitForDepth(KATANA_MAX_BOOK_DEPTH), 1000);
  assert.equal(bookLimitForDepth(99_999), 1000);
});

// --- backoff maths -----------------------------------------------------------

test('rate-limit backoff starts at a full bucket window', () => {
  // Katana's 429 carries no Retry-After, and the bucket needs ~1s to refill, so
  // the first rate-limit retry must not fire sooner than that or it is certain to
  // draw a second 429 and merely spend an attempt.
  assert.equal(katanaBackoffMs(1, 'rateLimit', 0), 500);
  assert.equal(katanaBackoffMs(1, 'rateLimit', 1), 1000);
});

test('transport backoff starts far lower than rate-limit backoff', () => {
  // Nothing is throttling a socket reset - the request simply did not land - so
  // waiting a full second would be latency spent for no reason.
  assert.ok(katanaBackoffMs(1, 'transport', 1) < katanaBackoffMs(1, 'rateLimit', 0));
  assert.equal(katanaBackoffMs(1, 'transport', 0), 150);
  assert.equal(katanaBackoffMs(1, 'transport', 1), 300);
});

test('backoff doubles per attempt', () => {
  assert.equal(katanaBackoffMs(1, 'rateLimit', 1), 1000);
  assert.equal(katanaBackoffMs(2, 'rateLimit', 1), 2000);
  assert.equal(katanaBackoffMs(3, 'rateLimit', 1), 4000);
  assert.equal(katanaBackoffMs(4, 'rateLimit', 1), 8000);
});

test('backoff is capped', () => {
  for (const attempt of [5, 10, 40]) {
    assert.ok(katanaBackoffMs(attempt, 'rateLimit', 1) <= KATANA_BACKOFF_CAP_MS);
    assert.ok(katanaBackoffMs(attempt, 'transport', 1) <= KATANA_BACKOFF_CAP_MS);
  }
  // 2**40 overflows into Infinity if the cap is applied after the doubling
  // rather than around it; this asserts the result stays a real number.
  assert.ok(Number.isFinite(katanaBackoffMs(40, 'rateLimit', 0.5)));
});

test('backoff keeps half the window fixed so a retry is never instant', () => {
  // Equal jitter: the fixed half stops a zero-delay replay, the random half stops
  // several stalled tabs resynchronising into one burst that re-trips the limiter.
  for (const attempt of [1, 2, 3]) {
    const lo = katanaBackoffMs(attempt, 'rateLimit', 0);
    const hi = katanaBackoffMs(attempt, 'rateLimit', 1);
    assert.ok(lo > 0, 'never zero');
    assert.equal(hi, lo * 2, 'jitter spans exactly half the window');
  }
});

test('attempt numbers below 1 are clamped rather than inverting the window', () => {
  assert.equal(katanaBackoffMs(0, 'rateLimit', 1), 1000);
  assert.equal(katanaBackoffMs(-3, 'rateLimit', 1), 1000);
});

// --- retry classification ----------------------------------------------------

test('429 and 5xx retry, 4xx does not', () => {
  assert.equal(katanaRetryKind(new KatanaApiError(429, 'Rate limit exceeded', '/v1/time')), 'rateLimit');
  assert.equal(katanaRetryKind(new KatanaApiError(500, 'boom', '/v1/time')), 'transport');
  assert.equal(katanaRetryKind(new KatanaApiError(503, 'boom', '/v1/time')), 'transport');
  // Deterministic failures: replaying reproduces them exactly while burning a
  // token shared with every other browser tab.
  assert.equal(katanaRetryKind(new KatanaApiError(400, 'bad interval', '/v1/candles')), null);
  assert.equal(katanaRetryKind(new KatanaApiError(404, 'MARKET_NOT_FOUND', '/v1/trades')), null);
});

test('network faults retry, unknown values do not', () => {
  const timeout = new Error('timed out');
  timeout.name = 'TimeoutError';
  assert.equal(katanaRetryKind(timeout), 'transport');
  // undici reports DNS/socket faults as TypeError('fetch failed').
  assert.equal(katanaRetryKind(new TypeError('fetch failed')), 'transport');
  // Allow-list: anything unrecognised is final.
  assert.equal(katanaRetryKind(new SyntaxError('bad json')), null);
  assert.equal(katanaRetryKind('nope'), null);
  assert.equal(katanaRetryKind(null), null);
});

test('a Katana 5xx surfaces as 502, not as our own 500', () => {
  // Blaming this process for an upstream outage sends the operator to the wrong
  // logs. 502 says "the venue is unwell", which is the actionable truth.
  assert.equal(new KatanaApiError(503, 'down', '/v1/time').statusCode, 502);
  assert.equal(new KatanaApiError(429, 'slow down', '/v1/time').statusCode, 429);
  assert.equal(new KatanaApiError(404, 'missing', '/v1/time').statusCode, 404);
});

test('both live Katana error body shapes are decoded', () => {
  // Validation / rate limit: {code, message}
  const a = katanaErrorFrom(400, { code: 'INVALID_PARAMETER', message: 'bad interval' }, '/v1/candles');
  assert.equal(a.message, 'bad interval');
  assert.equal(a.code, 'INVALID_PARAMETER');
  // Unrouted path: Fastify's own {statusCode, error, message}
  const b = katanaErrorFrom(404, { message: 'Route GET:/v1/x not found', error: 'Not Found', statusCode: 404 }, '/v1/x');
  assert.equal(b.message, 'Route GET:/v1/x not found');
  assert.equal(b.code, undefined);
  // Unparseable body still yields a usable message rather than "undefined".
  assert.equal(katanaErrorFrom(500, null, '/v1/x').message, 'HTTP 500');
});

// --- token bucket ------------------------------------------------------------

test('the bucket allows a burst up to capacity then makes callers wait', () => {
  const b = new TokenBucket(4, 4, 1000);
  for (let i = 0; i < 4; i++) assert.equal(b.reserve(1000), 0, `burst slot ${i}`);
  // Fifth caller in the same instant must wait a quarter second for one token.
  assert.equal(b.reserve(1000), 250);
});

test('concurrent callers are given distinct increasing delays', () => {
  // The whole reason tokens are allowed to go negative. If every over-budget
  // caller saw "0 tokens" and got the same delay, they would all wake together
  // and collide into the same 429 they were backing off from.
  const b = new TokenBucket(4, 4, 0);
  for (let i = 0; i < 4; i++) b.reserve(0);
  const delays = [b.reserve(0), b.reserve(0), b.reserve(0)];
  assert.deepEqual(delays, [250, 500, 750]);
});

test('the bucket refills over time', () => {
  const b = new TokenBucket(4, 4, 0);
  for (let i = 0; i < 4; i++) b.reserve(0);
  // One second later a full bucket has regenerated: 4 tokens at 4/s.
  assert.equal(b.reserve(1000), 0);
  assert.equal(b.reserve(1000), 0);
  assert.equal(b.reserve(1000), 0);
  assert.equal(b.reserve(1000), 0);
  assert.equal(b.reserve(1000), 250);
});

test('the bucket never banks more than capacity', () => {
  // An idle hour must not buy an hour-long burst - that is exactly the burst the
  // venue answers with a wall of 429s.
  const b = new TokenBucket(4, 4, 0);
  assert.equal(b.available(3_600_000), 4);
  const c = new TokenBucket(4, 4, 0);
  for (let i = 0; i < 4; i++) assert.equal(c.reserve(3_600_000), 0);
  assert.equal(c.reserve(3_600_000), 250);
});

test('a clock that goes backwards does not mint tokens', () => {
  const b = new TokenBucket(4, 4, 10_000);
  for (let i = 0; i < 4; i++) b.reserve(10_000);
  // Negative elapsed time must contribute no refill.
  assert.equal(b.reserve(5_000), 250);
});

// --- Katana normalisation ----------------------------------------------------

// Verbatim from GET /v1/markets.
const KAT_MARKET: KatanaMarket = {
  market: 'BTC-USD', type: 'perpetual', status: 'active',
  baseAsset: 'BTC', quoteAsset: 'USD',
  stepSize: '0.00010000', tickSize: '1.00000000',
  minimumPositionSize: '0.00050000', indexPrice: '80041.66177339',
};

// Verbatim from GET /v1/tickers.
const KAT_TICKER: KatanaTicker = {
  market: 'SOL-USD', time: 1787867110000,
  open: '97.65000000', high: '109.85000000', low: '97.60000000', close: '108.36000000',
  baseVolume: '45273.27000000', quoteVolume: '4723803.77040000',
  percentChange: '10.96774100', trades: 1772,
  ask: '108.20000000', bid: '108.16000000',
  markPrice: '108.20000000', indexPrice: '108.29548307',
};

test('katana market normalises to the shared symbol shape', () => {
  const s = normaliseKatanaMarket(KAT_MARKET);
  assert.equal(s.symbol, 'BTC-USD');
  assert.equal(s.base, 'BTC');
  assert.equal(s.quote, 'USD');
  assert.equal(s.status, 'active');
  assert.equal(s.tickSize, '1.00000000');
  assert.equal(s.stepSize, '0.00010000');
  assert.equal(s.minQuantity, '0.00050000');
});

test('katana ticker maps close to last and keeps percent units', () => {
  const t = normaliseKatanaTicker(KAT_TICKER);
  // Katana has no `last` field; `close` is the last traded price.
  assert.equal(t.last, '108.36000000');
  assert.equal(t.bid, '108.16000000');
  assert.equal(t.ask, '108.20000000');
  assert.equal(t.open24h, '97.65000000');
  // (108.36 - 97.65) / 97.65 = 10.97%. The published value is already the
  // percentage, so normalisation must NOT rescale it.
  assert.equal(t.changePct24h, 10.967741);
  const recomputed = ((108.36 - 97.65) / 97.65) * 100;
  assert.ok(Math.abs(t.changePct24h! - recomputed) < 0.01, 'percent units, not a fraction');
});

test('a field the venue omits becomes null, never zero', () => {
  // The house rule made mechanical: a wrong number on a trading screen is worse
  // than a blank one, so an absent mark price must not arrive as "0".
  const t = normaliseKatanaTicker({ market: 'KAT-USD' });
  assert.equal(t.last, null);
  assert.equal(t.bid, null);
  assert.equal(t.markPrice, null);
  assert.equal(t.changePct24h, null);
  assert.notEqual(t.markPrice, '0');
});

test('decStr and numOrNull refuse to fabricate a value', () => {
  assert.equal(decStr(undefined), null);
  assert.equal(decStr(null), null);
  assert.equal(decStr(''), null);
  assert.equal(decStr('  '), null);
  assert.equal(decStr(Number.NaN), null);
  assert.equal(decStr('0'), '0', 'a real zero is preserved');
  assert.equal(decStr(0), '0');
  assert.equal(numOrNull(undefined), null);
  assert.equal(numOrNull('abc'), null);
  assert.equal(numOrNull(Number.POSITIVE_INFINITY), null);
  assert.equal(numOrNull('12.5'), 12.5);
  assert.equal(numOrNull(0), 0, 'a real zero is preserved');
});

// --- the trade-side inversion (the one that silently paints a tape wrong) ----

test('katana makerSide is INVERTED to get the aggressor', () => {
  // Katana publishes the RESTING side. The account that crossed the spread is on
  // the other side of the print. Passing makerSide straight through would colour
  // every row backwards and invert the buy/sell pressure read off the tape - a
  // failure with no error anywhere, just a wrong screen.
  assert.equal(takerSideFromMaker('buy'), 'sell');
  assert.equal(takerSideFromMaker('sell'), 'buy');
  assert.equal(takerSideFromMaker('BUY'), 'sell');
  assert.equal(takerSideFromMaker('Sell'), 'buy');
});

test('an unrecognised maker side stays total rather than throwing', () => {
  // Bounded to one mislabelled row; throwing would blank the whole tape.
  assert.equal(takerSideFromMaker(undefined), 'buy');
  assert.equal(takerSideFromMaker(''), 'buy');
});

test('sodex S maps straight across with NO inversion', () => {
  // SoDEX publishes the aggressor directly. The two adapters disagreeing here is
  // the entire reason the interface normalises to `takerSide`.
  assert.equal(normaliseSodexTrade({ t: 1, T: 1, S: 'BUY', p: '1', q: '1' }).takerSide, 'buy');
  assert.equal(normaliseSodexTrade({ t: 1, T: 1, S: 'SELL', p: '1', q: '1' }).takerSide, 'sell');
});

test('the same economic print normalises identically on both venues', () => {
  // A taker who SOLD into a resting bid. SoDEX says S=SELL; Katana says the maker
  // was buying. Both must land on takerSide 'sell'.
  const kat = normaliseKatanaTrade({
    fillId: 'f1', price: '79994.00000000', quantity: '0.01240000',
    time: 1787867110639, makerSide: 'buy', sequence: 1671900,
  });
  const sod = normaliseSodexTrade({ t: 11788880, T: 1787867110639, S: 'SELL', p: '79994', q: '0.0124' });
  assert.equal(kat.takerSide, 'sell');
  assert.equal(sod.takerSide, kat.takerSide);
});

test('katana trade keeps prices as strings and carries its sequence', () => {
  const t: KatanaTrade = {
    fillId: '1204f70b-9036-3586-b5d0-99cce34e5db9',
    price: '79994.00000000', quantity: '0.01240000', quoteQuantity: '991.92560000',
    time: 1787867110639, makerSide: 'buy', sequence: 1671900,
  };
  const v = normaliseKatanaTrade(t);
  assert.equal(v.id, '1204f70b-9036-3586-b5d0-99cce34e5db9');
  assert.equal(v.price, '79994.00000000', 'no float round-trip');
  assert.equal(v.size, '0.01240000');
  assert.equal(v.timestamp, 1787867110639);
  assert.equal(v.sequence, 1671900);
});

// --- ordering ----------------------------------------------------------------

const trade = (ts: number, seq: number): VenueTrade => ({
  id: String(seq), price: '1', size: '1', takerSide: 'buy', timestamp: ts, sequence: seq,
});

test('trades come back newest first regardless of venue order', () => {
  // Katana serves ascending, SoDEX descending. Sorting rather than reversing means
  // a silent change to either venue cannot flip a tape upside down.
  const ascending = [trade(1, 1), trade(2, 2), trade(3, 3)];
  assert.deepEqual(sortTradesNewestFirst([...ascending]).map((t) => t.sequence), [3, 2, 1]);
  const descending = [trade(3, 3), trade(2, 2), trade(1, 1)];
  assert.deepEqual(sortTradesNewestFirst([...descending]).map((t) => t.sequence), [3, 2, 1]);
});

test('same-millisecond trades are ordered by sequence', () => {
  const tied = [trade(5, 1), trade(5, 3), trade(5, 2)];
  assert.deepEqual(sortTradesNewestFirst(tied).map((t) => t.sequence), [3, 2, 1]);
});

const candle = (start: number): VenueCandle => ({
  start, open: '1', high: '1', low: '1', close: '1',
  baseVolume: null, quoteVolume: null, trades: null,
});

test('candles come back oldest first regardless of venue order', () => {
  // SoDEX serves klines NEWEST first (verified live) and Katana oldest first. A
  // chart drawn from raw SoDEX order would run right to left.
  const sodexOrder = [candle(1787867220000), candle(1787867160000), candle(1787867100000)];
  assert.deepEqual(
    sortCandlesOldestFirst(sodexOrder).map((c) => c.start),
    [1787867100000, 1787867160000, 1787867220000],
  );
});

// --- orderbook normalisation -------------------------------------------------

// Verbatim from GET /v1/orderbook?market=BTC-USD&level=2 (tuples carry a third
// element, the order count, that SoDEX does not publish).
const KAT_BOOK: KatanaBook = {
  sequence: 392456946,
  bids: [['80006.00000000', '0.02490000', 1], ['80005.00000000', '0.00370000', 1], ['80004.00000000', '0.03740000', 1]],
  asks: [['80007.00000000', '0.02490000', 1], ['80009.00000000', '0.00370000', 1], ['80011.00000000', '0.03740000', 1]],
  lastPrice: '80013.00000000', markPrice: '80007.00000000',
};

test('katana book normalises to price/size levels, best first', () => {
  const b = normaliseKatanaBook('BTC-USD', KAT_BOOK, 3);
  assert.equal(b.bids[0]!.price, '80006.00000000', 'highest bid first');
  assert.equal(b.asks[0]!.price, '80007.00000000', 'lowest ask first');
  assert.equal(b.bids[0]!.size, '0.02490000');
  assert.equal(b.sequence, 392456946);
});

test('the book is trimmed to exactly the requested per-side depth', () => {
  // Katana splits its two-sided `limit` evenly and a depth-1 request had to be
  // widened to 2, so the returned count does not match the request until it is
  // sliced here.
  const b = normaliseKatanaBook('BTC-USD', KAT_BOOK, 1);
  assert.equal(b.bids.length, 1);
  assert.equal(b.asks.length, 1);
  assert.equal(b.bids[0]!.price, '80006.00000000');
});

test('an out-of-order book is sorted, not trusted', () => {
  const scrambled: KatanaBook = {
    sequence: 1,
    bids: [['79000', '1'], ['80006', '1'], ['79500', '1']],
    asks: [['80500', '1'], ['80007', '1'], ['80200', '1']],
  };
  const b = normaliseKatanaBook('BTC-USD', scrambled, 3);
  assert.deepEqual(b.bids.map((l) => l.price), ['80006', '79500', '79000']);
  assert.deepEqual(b.asks.map((l) => l.price), ['80007', '80200', '80500']);
});

test('katana book timestamp is null because the venue does not stamp it', () => {
  // Substituting our own receive time would invent a venue timestamp - a value a
  // trader could reasonably read as "the venue said so at this instant".
  assert.equal(normaliseKatanaBook('BTC-USD', KAT_BOOK, 3).timestamp, null);
});

test('an empty or malformed book yields empty sides, not a crash', () => {
  const b = normaliseKatanaBook('KAT-USD', {}, 5);
  assert.deepEqual(b.bids, []);
  assert.deepEqual(b.asks, []);
  assert.equal(b.sequence, null);
});

// --- SoDEX normalisation -----------------------------------------------------

test('sodex book keeps both its revision id and its block timestamp', () => {
  // Unlike Katana, SoDEX stamps the snapshot, so both fields are real here.
  const b = normaliseSodexBook('BTC-USD', {
    blockTime: 1787867269816, updateID: 2882686211,
    bids: [['80042', '1.26008'], ['80041', '1.41649']],
    asks: [['80043', '0.56969'], ['80044', '0.33127']],
  }, 2);
  assert.equal(b.sequence, 2882686211);
  assert.equal(b.timestamp, 1787867269816);
  assert.equal(b.bids[0]!.price, '80042');
  assert.equal(b.asks[0]!.price, '80043');
});

test('sodex ticker normalises its abbreviated field names', () => {
  const t = normaliseSodexTicker({
    symbol: 'SPCX-USD', lastPx: '140.27', openPx: '140.19', highPx: '141.93', lowPx: '138.7',
    volume: '303.1', quoteVolume: '42487.3407', changePct: 0.05706541122762,
    askPx: '140.27', bidPx: '140.26', indexPrice: '140.33', markPrice: '140.27',
  });
  assert.equal(t.last, '140.27');
  assert.equal(t.bid, '140.26');
  assert.equal(t.high24h, '141.93');
  assert.equal(t.baseVolume24h, '303.1');
  // (140.27 - 140.19) / 140.19 = 0.057%. Percent units on both venues, verified
  // separately against each - so no per-venue scaling factor is needed.
  assert.ok(Math.abs(t.changePct24h! - 0.05706541122762) < 1e-12);
});

test('a sodex spot ticker has no mark or index price and says so', () => {
  const t = normaliseSodexTicker({ symbol: 'vBTC_vUSDC', lastPx: '80000' });
  assert.equal(t.markPrice, null);
  assert.equal(t.indexPrice, null);
});

test('sodex kline normalises its single-letter fields', () => {
  const c = normaliseSodexKline({
    t: 1787867220000, o: '80000', h: '80042', l: '80000', c: '80042',
    v: '0.16633', q: '13310.72731', n: 20,
  });
  assert.deepEqual(c, {
    start: 1787867220000, open: '80000', high: '80042', low: '80000', close: '80042',
    baseVolume: '0.16633', quoteVolume: '13310.72731', trades: 20,
  });
});

test('katana candle normalises to the same shape as a sodex kline', () => {
  const raw: KatanaCandle = {
    start: 1787866980000, open: '79961.00000000', high: '79988.00000000',
    low: '79961.00000000', close: '79973.00000000',
    baseVolume: '0.04600000', quoteVolume: '3678.83970000', trades: 9,
  };
  const c = normaliseKatanaCandle(raw);
  assert.equal(c.start, 1787866980000);
  assert.equal(c.open, '79961.00000000');
  assert.equal(c.close, '79973.00000000');
  assert.equal(c.trades, 9);
  // Same key set as the SoDEX candle above - that is what makes the two
  // interchangeable to a caller.
  const sod = normaliseSodexKline({ t: 1, o: '1', h: '1', l: '1', c: '1' });
  assert.deepEqual(Object.keys(c).sort(), Object.keys(sod).sort());
});

// --- limit clamping ----------------------------------------------------------

test('limits clamp into range instead of throwing', () => {
  // A bad `limit` on a query string should not deny the trader their data; the
  // venue would only reject it for us one round trip later.
  assert.equal(clampLimit('50', 20, 1, 1000), 50);
  assert.equal(clampLimit('0', 20, 1, 1000), 1);
  assert.equal(clampLimit('99999', 20, 1, 1000), 1000);
  assert.equal(clampLimit('abc', 20, 1, 1000), 20, 'falls back');
  assert.equal(clampLimit(undefined, 20, 1, 1000), 20);
  assert.equal(clampLimit(7.9, 20, 1, 1000), 7, 'truncated, never rounded up');
});

// --- market id ---------------------------------------------------------------

test('katana market ids are canonicalised to uppercase', () => {
  // All nine live markets are uppercase and Katana matches exactly, so a
  // lowercase URL would 404 without this.
  assert.equal(canonicalMarket('btc-usd'), 'BTC-USD');
  assert.equal(canonicalMarket('  eth-usd  '), 'ETH-USD');
  assert.equal(canonicalMarket('SOL-USD'), 'SOL-USD');
});
