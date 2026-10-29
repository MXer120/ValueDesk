/**
 * Before a copy starts, the trader's markets a copy cannot follow on SoDEX (notCopyable.ts):
 * one line from their positions and recent fills, the list behind it, and nothing claimed
 * without SoDEX's list or without fresh prices for the same-asset check.
 * Run (from apps/web): npx tsx --test src/components/copy/notCopyable.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { notCopyable, type NotCopyableInput } from './notCopyable';

const row = (id: number, name: string) => ({ id, name, baseCoin: name.replace(/-USD$/, ''), tickSize: '0.01', stepSize: '0.001', minQuantity: '0.001', maxQuantity: '1000', minNotional: '10', maxLeverage: 20, status: 'TRADING' });
const MARKETS = [row(1, 'BTC-USD'), row(2, 'ETH-USD'), row(3, 'SOL-USD'), row(4, 'GOLD-USD'), row(5, '1000PEPE-USD')];
const T = 1_800_000_000_000;
const pos = (symbol: string, markPx: number | null = null) => ({ symbol, markPx });
const input = (o: Partial<NotCopyableInput>): NotCopyableInput => ({ venue: 'hyperliquid', positions: null, positionsAt: T, fills: null, markets: MARKETS, marks: null, ...o });

test('the open positions first: "3 of 7 open positions can\'t be copied", the coins named, the list behind it', () => {
  const n = notCopyable(input({ positions: ['BTC', 'PURR', 'ETH', 'HYPE', 'SOL', 'kBONK', 'kPEPE'].map((s) => pos(s)) }), T);
  assert.equal(n.line, "3 of 7 open positions can't be copied: PURR, HYPE and kBONK aren't on SoDEX.");
  assert.deepEqual(n.items, [
    { symbol: 'PURR', why: 'not listed on SoDEX', held: true },
    { symbol: 'HYPE', why: 'not listed on SoDEX', held: true },
    { symbol: 'kBONK', why: 'not listed on SoDEX', held: true },
  ]);
  assert.equal(notCopyable(input({ positions: [pos('PURR')] }), T).line, "1 of 1 open position can't be copied: PURR isn't on SoDEX.");
});

test('a different asset is named only on fresh prices of both venues; the coins traded lately add a clause, spot is left out', () => {
  const marks = { at: T, rows: [{ symbol: 'GOLD-USD', markPrice: '3900' }, { symbol: 'BTC-USD', markPrice: '80000' }] };
  const positions = [pos('BTC', 80_010), pos('xyz:GOLD', 2_450), pos('PURR', 0.2)];
  const fills = [{ symbol: 'HYPE', time: T - 5 }, { symbol: '@107', time: T - 4 }, { symbol: 'BTC', time: T - 3 }, { symbol: 'FARTCOIN', time: T - 2 }, { symbol: 'HYPE', time: T - 1 }];
  const n = notCopyable(input({ positions, fills, marks }), T);
  assert.equal(n.line, "2 of 3 open positions can't be copied: PURR isn't on SoDEX; xyz:GOLD is another asset on SoDEX. 2 more coins traded lately can't be either.");
  assert.deepEqual(n.items.map((x) => [x.symbol, x.held]), [['xyz:GOLD', true], ['PURR', true], ['HYPE', false], ['FARTCOIN', false]]);
  assert.equal(n.items[0]!.why, 'GOLD-USD on SoDEX is another asset (priced 37.2% apart)');

  // The positions read long before SoDEX's marks: no verdict, so nothing is said about the asset.
  const stale = notCopyable(input({ positions, positionsAt: T - 10 * 60_000, marks }), T);
  assert.equal(stale.line, "1 of 3 open positions can't be copied: PURR isn't on SoDEX.");

  // Only the coins traded lately: said as those.
  const recent = notCopyable(input({ positions: [pos('BTC')], fills }), T);
  assert.equal(recent.line, "2 of the 3 coins traded lately can't be copied: HYPE and FARTCOIN aren't on SoDEX.");
});

test('nothing to say: every market listed, no positions or fills, or SoDEX\'s list not read', () => {
  assert.deepEqual(notCopyable(input({ positions: [pos('BTC'), pos('kPEPE')], fills: [{ symbol: 'ETH', time: T }] }), T), { line: null, items: [] });
  assert.deepEqual(notCopyable(input({}), T), { line: null, items: [] });
  assert.deepEqual(notCopyable(input({ positions: [pos('PURR')], markets: null }), T), { line: null, items: [] });
  assert.deepEqual(notCopyable(input({ positions: [pos('PURR')], markets: [] }), T), { line: null, items: [] });
  // A SoDEX trader: only a market SoDEX no longer lists is named.
  assert.equal(notCopyable(input({ venue: 'sodex', positions: [pos('BTC-USD'), pos('OLD-USD')] }), T).line, "1 of 2 open positions can't be copied: OLD-USD isn't on SoDEX.");
});

test('more than four names: three, and how many more', () => {
  const n = notCopyable(input({ positions: ['AAA', 'BBB', 'CCC', 'DDD', 'EEE'].map((s) => pos(s)) }), T);
  assert.equal(n.line, "5 of 5 open positions can't be copied: AAA, BBB, CCC and 2 more aren't on SoDEX.");
  assert.equal(n.items.length, 5, 'the list has them all');
});

test('the backtest keeps only fills a copy could trade: SoDEX lists a market for the coin; nothing is judged before the list is in', async () => {
  const { copyableMarket } = await import('./notCopyable');
  const ok = copyableMarket('hyperliquid', MARKETS)!;
  assert.equal(ok('BTC'), true);
  assert.equal(ok('kPEPE'), true, '1000PEPE-USD carries it');
  assert.equal(ok('PURR'), false, 'not on SoDEX');
  assert.equal(ok('PURR/USDC'), false, 'spot is never copied');
  assert.equal(copyableMarket('hyperliquid', null), null);
  assert.equal(copyableMarket('hyperliquid', []), null);
});
