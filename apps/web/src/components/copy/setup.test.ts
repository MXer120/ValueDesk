/**
 * Copy setup: parsing, the quoted fees, and the worked example.
 * Run (from apps/web): npx tsx --test src/components/copy/setup.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TraderProfile, VsPosition } from '../../vsApi';
import {
  DEFAULT_SETUP, COPY_BUILDER_TENTHS_BPS, TAKER_RATE, copyErrorInWords, fmtRate, fmtSignedPct, fmtSize, largestPosition,
  normaliseSetup, parseCoins, parseSetup, readTarget, toCopySettings, windowStart, workedExample, type SetupState,
} from './setup';
import { setNumStyle } from '../../numStyle';
import { checkSettings } from '@copy-engine';
import { fmtRate as rate, fmtSignedPct as signedPct, fmtSize as size } from './setup';

test('formatting in the default number format (1.234,56): trimmed sizes keep their decimal comma', () => {
  setNumStyle('dot-comma');
  try {
    assert.equal(rate(0.0004), '0,040%');
    assert.equal(signedPct(0.1234), '+12,34%');
    assert.equal(signedPct(0), '0,00%');
    assert.equal(size(18_420), '18.420');
    assert.equal(size(2.5), '2,5');
    assert.equal(size(0.0213), '0,0213');
    assert.equal(size(1234.4), '1.234');
  } finally {
    setNumStyle('comma-dot');
  }
});

// These cases read the en-US format (1,234.56); the app's default (1.234,56) is checked separately.
setNumStyle('comma-dot');

const setup = (o: Partial<SetupState> = {}): SetupState => ({ ...DEFAULT_SETUP, ...o });

const pos = (o: Partial<VsPosition> = {}): VsPosition => ({
  symbol: 'BTC', side: 'long', size: 2, notional: 200_000, entryPx: 95_000, markPx: 100_000,
  liqPx: null, uPnl: 10_000, leverage: 5, ...o,
});

const profile = (positions: VsPosition[], accountValue: number | null = 1_000_000): Pick<TraderProfile, 'positions' | 'summary'> => ({
  positions,
  summary: { venue: 'hyperliquid', address: '0x' + '1'.repeat(40), accountValue, pnl: {}, roi: {}, volume: {} },
});

const coin = (s: string) => s;

test('defaults parse cleanly into the engine config', () => {
  const p = parseSetup(DEFAULT_SETUP);
  assert.deepEqual(p.errors, {});
  assert.equal(p.config.sizingMode, 'proportional');
  assert.equal(p.config.allocationUsd, 1000);
  assert.equal(p.config.maxLeverage, 5);
  assert.equal(p.config.stopLossPct, 0.5);
  assert.equal(p.config.takeProfitPct, null);
  assert.equal(p.config.drawdownStopPct, 0.3);
  assert.equal(p.config.ratio, 0.1);
});

test('percent fields become fractions; blank optional fields switch the guard off', () => {
  const p = parseSetup(setup({ ratioPct: '25', stopLoss: '', takeProfit: '150', drawdown: ' ' }));
  assert.equal(p.config.ratio, 0.25);
  assert.equal(p.config.stopLossPct, null);
  assert.equal(p.config.takeProfitPct, 1.5);
  assert.equal(p.config.drawdownStopPct, null);
});

test('thousands separators and a dollar sign are accepted', () => {
  assert.equal(parseSetup(setup({ allocation: '$12,500' })).config.allocationUsd, 12_500);
});

test('bad input is reported per field and never reaches the config as NaN', () => {
  const p = parseSetup(setup({ allocation: '0', maxLeverage: 'abc', stopLoss: '120', slippageBps: '-1' }));
  assert.ok(p.errors.allocation);
  assert.ok(p.errors.maxLeverage);
  assert.ok(p.errors.stopLoss);
  assert.ok(p.errors.slippageBps);
  for (const v of Object.values(p.config)) if (typeof v === 'number') assert.ok(Number.isFinite(v));
});

test('ratio and notional are only required in their own mode', () => {
  assert.equal(parseSetup(setup({ ratioPct: '' })).errors.ratioPct, undefined);
  assert.ok(parseSetup(setup({ mode: 'fixedRatio', ratioPct: '' })).errors.ratioPct);
  assert.ok(parseSetup(setup({ mode: 'fixedNotional', notional: '0' })).errors.notional);
  assert.equal(parseSetup(setup({ mode: 'fixedNotional', notional: '250' })).fixedNotionalUsd, 250);
});

test('coin lists are upper-cased and de-duplicated; a coin on both lists is an error', () => {
  assert.deepEqual(parseCoins('btc, Eth ;SOL btc'), ['BTC', 'ETH', 'SOL']);
  assert.ok(parseSetup(setup({ allow: 'BTC', deny: 'btc' })).errors.deny);
});

test('stored state from an older build is completed from the defaults', () => {
  const s = normaliseSetup({ allocation: '50', mode: 'nonsense' as never });
  assert.equal(s.allocation, '50');
  assert.equal(s.mode, 'proportional');
  assert.equal(s.slippageBps, DEFAULT_SETUP.slippageBps);
});

test('fees: base-tier taker and the 2.5 bp copy fee', () => {
  assert.equal(fmtRate(TAKER_RATE.sodex), '0.040%');
  assert.equal(fmtRate(TAKER_RATE.hyperliquid), '0.045%');
  assert.equal(fmtRate(COPY_BUILDER_TENTHS_BPS / 100_000), '0.025%');
});

test('formatting: true minus sign, explicit plus, sizes by magnitude', () => {
  assert.equal(fmtSignedPct(0.1234), '+12.34%');
  assert.equal(fmtSignedPct(-0.05), '−5.00%');
  assert.equal(fmtSignedPct(0), '0.00%');
  assert.equal(fmtSignedPct(null), '—');
  assert.equal(fmtSize(2.5), '2.5');
  assert.equal(fmtSize(0.021345), '0.0213');
  assert.equal(fmtSize(18_420.4), '18,420');
});

test('worked example, proportional: leader notional x allocation / leader equity', () => {
  const ex = workedExample(parseSetup(DEFAULT_SETUP), profile([pos(), pos({ symbol: 'ETH', notional: 5_000, size: 1 })]), coin);
  // $200,000 x 1,000 / 1,000,000 = $200 -> 0.002 BTC at $100,000.
  assert.ok(ex);
  assert.match(ex!.text, /^Leader long 2 BTC \(\$200,000\) on \$1,000,000 equity\. You: long 0\.002 BTC \(\$200\.00\)\.$/);
  assert.equal(ex!.caveat, null);
});

test('worked example: caps and the minimum order are called out', () => {
  const capped = workedExample(parseSetup(setup({ mode: 'fixedRatio', ratioPct: '10', maxPosition: '2500' })), profile([pos()]), coin);
  // 10% of $200,000 = $20,000 -> capped at min($2,500, 5 x $1,000 = $5,000) = $2,500.
  assert.match(capped!.text, /\(\$2,500\.00\)\.$/);
  assert.match(capped!.caveat!, /max position/);

  const tiny = workedExample(parseSetup(setup({ allocation: '10' })), profile([pos()]), coin);
  // $200,000 x 10 / 1,000,000 = $2 < $10.
  assert.match(tiny!.caveat!, /minimum order/);
});

test('worked example: flat leader or missing equity', () => {
  assert.equal(workedExample(parseSetup(DEFAULT_SETUP), profile([]), coin), null);
  assert.equal(largestPosition(null), null);
  const noEq = workedExample(parseSetup(DEFAULT_SETUP), profile([pos({ side: 'short' })], null), coin);
  assert.match(noEq!.text, /^Leader short 2 BTC/);
  assert.match(noEq!.caveat!, /account value/);
});

test('URL target: address and venue are validated', () => {
  const a = '0x' + 'AbC1'.repeat(10);
  assert.deepEqual(readTarget(`?address=${a}&venue=sodex`, 'hyperliquid'), { address: a.toLowerCase(), venue: 'sodex' });
  assert.deepEqual(readTarget('?address=nope&venue=binance', 'hyperliquid'), { address: null, venue: 'hyperliquid' });
});

test('window start', () => {
  assert.equal(windowStart('7d', 1_000_000_000), 1_000_000_000 - 7 * 86_400_000);
  assert.equal(windowStart('all', 5), null);
});

test('counter-trade: the worked example takes the other side, and the signed rules say counter', () => {
  const s = setup({ direction: 'counter', mode: 'fixedRatio', ratioPct: '1', maxPosition: '100000' });
  const ex = workedExample(parseSetup(s), profile([pos({ side: 'long', size: 2, notional: 200_000 })]), coin);
  assert.match(ex!.text, /^Leader long 2 BTC .*You: short 0\.02 BTC/);
  const rules = toCopySettings(parseSetup(s), s, { venue: 'hyperliquid', address: '0x' + 'A'.repeat(40) });
  assert.equal(rules.direction, 'counter');
  assert.equal(toCopySettings(parseSetup(setup()), setup(), { venue: 'sodex', address: '0x' + '1'.repeat(40) }).direction, 'copy');
  assert.equal(normaliseSetup({ direction: 'sideways' as never }).direction, 'copy');
});

test('the engine rule limits in the copy window units: percent, dollars, bps', () => {
  setNumStyle('dot-comma');
  // A 0,5 % stop loss passes the form (above 0) and fails the engine (at least 1 %), which said it in fractions.
  const s = parseSetup({ ...DEFAULT_SETUP, stopLoss: '0.5', drawdown: '150' });
  assert.equal(s.errors.drawdown, 'Drawdown stop can be at most 100.');
  const r = checkSettings(toCopySettings(parseSetup({ ...DEFAULT_SETUP, stopLoss: '0.5' }), { ...DEFAULT_SETUP, stopLoss: '0.5' }, { venue: 'sodex', address: '0x' + '1'.repeat(40) }));
  assert.equal(r.errors.stopLossPct, 'Stop loss must be between 0.01 and 1.', 'what the engine says');
  assert.equal(copyErrorInWords('stopLossPct', r.errors.stopLossPct!), 'Stop loss must be between 1 % and 100 %.');
  assert.equal(copyErrorInWords('takeProfitPct', 'Take profit must be between 0.01 and 100.'), 'Take profit must be between 1 % and 10.000 %.');
  assert.equal(copyErrorInWords('ratio', 'Ratio must be between 0.0001 and 10.'), 'Ratio must be between 0,01 % and 1.000 %.');
  assert.equal(copyErrorInWords('allocationUsd', 'Allocation must be between 10 and 10000000.'), 'Allocation must be between $10 and $10.000.000.');
  assert.equal(copyErrorInWords('slippageBps', 'Slippage cap must be between 1 and 500.'), 'Slippage cap must be between 1 and 500 bps.');
  assert.equal(copyErrorInWords('assetDeny', 'BTC is on both lists.'), 'BTC is on both lists.');
});
