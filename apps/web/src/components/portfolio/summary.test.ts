/**
 * The portfolio's summary maths: every dollar in one bucket, nothing counted twice.
 *   npx tsx --test src/components/portfolio/summary.test.ts   (from apps/web)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimedCoins, shareKey, summarize, type SummaryInput, type WealthRow } from './summary';

const row = (o: Partial<WealthRow> & { coin: string }): WealthRow => ({
  fundId: o.coin, marketValue: 0, inFlight: 0, shares: 0, spotShares: 0, perpShares: 0, evmShares: 0, ...o,
});
const base: SummaryInput = { perps: null, spot: null, evm: null, wealth: null, venueTotal: null };
const sumOfBuckets = (s: ReturnType<typeof summarize>) => (s.perps ?? 0) + (s.spot ?? 0) + (s.wealth ?? 0) + (s.evm ?? 0);

test('nothing known is null, never a confident $0', () => {
  const s = summarize(base);
  assert.equal(s.total, null);
  assert.equal(s.wealth, null);
});

test('the total is exactly the four buckets', () => {
  const s = summarize({
    ...base,
    perps: 100,
    spot: [{ coin: 'vUSDC', usd: 50 }],
    evm: [{ chain: 'VALUECHAIN', symbol: 'USDC', usd: 25 }],
    wealth: [row({ coin: 'aCXMT', marketValue: 10, shares: 1, evmShares: 1 })],
  });
  assert.equal(s.total, 185);
  assert.equal(s.total, sumOfBuckets(s));
});

test('a CLOB fund held in Spot counts once, under Wealth', () => {
  const s = summarize({
    ...base,
    perps: 0,
    spot: [{ coin: 'vUSDC', usd: 40 }, { coin: 'vQQQ', usd: 600 }],
    evm: [],
    wealth: [row({ coin: 'vQQQ', marketValue: 610, shares: 1, spotShares: 1 })],
  });
  assert.equal(s.spot, 40, 'the share left Spot');
  assert.equal(s.wealth, 610, 'at the fund price, not the balance read price');
  assert.equal(s.total, 650);
});

test('a vault share in the wallet counts once, under Wealth', () => {
  const s = summarize({
    ...base,
    perps: 0,
    spot: [],
    evm: [{ chain: 'VALUECHAIN', symbol: 'aCXMT', usd: 99 }, { chain: 'VALUECHAIN', symbol: 'USDC', usd: 5 }],
    wealth: [row({ coin: 'aCXMT', marketValue: 100, shares: 10, evmShares: 10 })],
  });
  assert.equal(s.evm, 5);
  assert.equal(s.wealth, 100);
  assert.equal(s.total, 105);
});

test('a same-named token on another chain is not the fund share', () => {
  const s = summarize({
    ...base,
    evm: [{ chain: 'ETH', symbol: 'aCXMT', usd: 7 }],
    wealth: [row({ coin: 'aCXMT', marketValue: 100, shares: 10, evmShares: 10 })],
  });
  assert.equal(s.evm, 7);
});

test('shares pledged as Perps margin stay in Perps: av already holds them', () => {
  const s = summarize({
    ...base,
    perps: 1000,
    spot: [],
    evm: [],
    wealth: [row({ coin: 'vsoUSDC', marketValue: 400, shares: 4, perpShares: 3, evmShares: 1 })],
  });
  assert.equal(s.perps, 1000, 'Perps equals the trade page');
  assert.equal(s.wealth, 100, 'only the share outside Perps');
  assert.equal(s.wealthInPerps, 300);
  assert.equal(s.total, 1100);
});

test('one fund split across Spot, Perps and EVM still counts once', () => {
  const s = summarize({
    ...base,
    perps: 30,
    spot: [{ coin: 'vBOXX', usd: 30 }],
    evm: [{ chain: 'VALUECHAIN', symbol: 'vBOXX', usd: 30 }],
    wealth: [row({ coin: 'vBOXX', marketValue: 90, shares: 3, spotShares: 1, perpShares: 1, evmShares: 1 })],
  });
  assert.equal(s.total, 90);
  assert.equal(s.total, sumOfBuckets(s));
});

test('in-flight value is added to Wealth, on top of settled value', () => {
  const s = summarize({ ...base, wealth: [row({ coin: 'aCXMT', marketValue: 10, inFlight: 5, shares: 1, evmShares: 1 })] });
  assert.equal(s.wealth, 15);
});

test('a fund SoDEX cannot price leaves its coin where it was, so the money does not vanish', () => {
  const s = summarize({
    ...base,
    perps: 0,
    spot: [{ coin: 'vQQQ', usd: 600 }],
    evm: [],
    wealth: [row({ coin: 'vQQQ', marketValue: null, shares: 1, spotShares: 1 })],
  });
  assert.equal(s.spot, 600);
  assert.equal(s.wealth, 0);
  assert.equal(s.total, 600);
  assert.equal(s.unpriced, 1);
  assert.equal(claimedCoins([row({ coin: 'vQQQ', marketValue: null })]).size, 0);
});

test('a failed Wealth read leaves Spot and EVM as read, and the bucket unknown', () => {
  const s = summarize({ ...base, perps: 1, spot: [{ coin: 'vQQQ', usd: 600 }], evm: [{ chain: 'VALUECHAIN', symbol: 'aCXMT', usd: 9 }] });
  assert.equal(s.wealth, null);
  assert.equal(s.total, 610);
});

test('the SLP is the gap to the series, and only a real one', () => {
  const held = { ...base, perps: 100, spot: [{ coin: 'vUSDC', usd: 100 }], evm: [], wealth: [] };
  assert.equal(summarize({ ...held, venueTotal: 200.5 }).slp, null, 'lag and rounding are not a vault');
  const s = summarize({ ...held, venueTotal: 500 });
  assert.equal(s.slp, 300);
  assert.equal(s.wealth, 300);
  assert.equal(s.total, 500);
});

test('the SLP inference does not count a fund the series already holds in Spot', () => {
  const s = summarize({
    ...base,
    perps: 0,
    spot: [{ coin: 'vQQQ', usd: 600 }],
    evm: [],
    wealth: [row({ coin: 'vQQQ', marketValue: 600, shares: 1, spotShares: 1 })],
    venueTotal: 600,
  });
  assert.equal(s.slp, null);
  assert.equal(s.total, 600);
});

test('copy trading and bots cannot change the total: the input has no field for them', () => {
  const input = { ...base, perps: 500, spot: [], evm: [], wealth: [] };
  // A copy's allocation and a bot's quoted size, as a caller might wrongly pass them.
  const withActivity = { ...input, copies: [{ allocationUsd: 400, pnl: 20 }], bots: [{ volume: 1e6 }] } as SummaryInput;
  assert.equal(summarize(withActivity).total, summarize(input).total);
  assert.deepEqual(Object.keys(summarize(input)).sort(), ['evm', 'perps', 'slp', 'spot', 'total', 'unpriced', 'wealth', 'wealthInPerps']);
});

test('share keys: the v prefix is lower-case only', () => {
  assert.equal(shareKey('vQQQ'), 'QQQ');
  assert.equal(shareKey('QQQ'), 'QQQ');
  assert.equal(shareKey('vsoUSDC'), shareKey('soUSDC'));
  assert.notEqual(shareKey('VANA'), shareKey('ANA'));
});
