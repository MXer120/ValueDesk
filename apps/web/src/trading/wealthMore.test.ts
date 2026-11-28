/**
 * The Wealth page's 2026-11-28 parts, byte by byte and on real data: index fund orders (ssi.ts) against viem and a real
 * SoDEX quote, claims (claims.ts) on real receipts, ValueDesk index maths (vdIndexes.ts), the instant exit's timing
 * (instantExit.ts). No network, nothing sent.   npx tsx --test src/trading/wealthMore.test.ts   (from apps/web)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { keccak_256 } from '@noble/hashes/sha3';
import { encodeFunctionData, parseAbi } from 'viem';
import { SSI_SELECTOR, digestData, mintData, parseSsiQuote, redeemData, type SsiOrder } from './ssi';
import { CLAIM_SELECTOR, CLAIM_TOPIC, claimCalls, requestOfLogs } from './claims';
import { VD_INDEXES, addLeg, cleanWeights, removeLeg, setWeight, annualised, basketApy, basketHistory, basketSeries, changeOver, equalBp, maxDrawdown, minimumFor, notRecurring, planLegs, rangeOf, recurringLegs, recurringMinimum, routeOf, weightsOk, type VdIndex } from './vdIndexes';
import { hedgeCloseSpec, hedgeQuantity, pricingAt } from './instantExit';
import { parseAlgoSpec } from '@copy-engine';
import type { TradingStatus, WealthFund, WealthQuote } from './wealth';

const fx = JSON.parse(readFileSync(new URL('./claimsSsi.fixture.json', import.meta.url), 'utf8'));
const keccak = (s: string) => `0x${Buffer.from(keccak_256(new TextEncoder().encode(s))).toString('hex')}`;
const ORDER = '(address,address,address,address,uint256,uint256,uint256,uint256,address[],uint256[],address[],uint256[])';

const issuerAbi = parseAbi([
  'struct Order { address requester; address maker; address taker; address beneficiary; uint256 expiry; uint256 nonce; uint256 makerRate; uint256 takerRate; address[] makerTokens; uint256[] makerAmounts; address[] takerTokens; uint256[] takerAmounts; }',
  'function mintViaRFQ(address ssiToken, address payToken, uint256 payAmount, uint256 minShareOut, Order order, bytes signature)',
  'function redeemViaRFQ(address ssiToken, uint256 burnShare, address receiveToken, uint256 minReceiveAmount, Order order, bytes signature)',
  'function digest(Order order) view returns (bytes32)',
]);

const OWNER = '0x1111111111111111111111111111111111111111';
const TOKEN = '0x1b0c2d25f432280882ffbd7da4f5b0597ecc3139';
const USDC = '0xcb7f80dff2727c791fa491722c428e6657f7e2c6';

test('index fund selectors are the keccak of the issuer signatures sodex.com calls', () => {
  assert.equal(SSI_SELECTOR.mintViaRFQ, keccak(`mintViaRFQ(address,address,uint256,uint256,${ORDER},bytes)`).slice(0, 10));
  assert.equal(SSI_SELECTOR.redeemViaRFQ, keccak(`redeemViaRFQ(address,uint256,address,uint256,${ORDER},bytes)`).slice(0, 10));
  assert.equal(SSI_SELECTOR.digest, keccak(`digest(${ORDER})`).slice(0, 10));
});

test('a real SoDEX index quote passes the checks, and its calldata is what viem encodes', () => {
  const q = parseSsiQuote(fx.ssiQuote, { side: 'buy', owner: OWNER, token: TOKEN, asset: USDC, payAmount: 10_000_000n, assetDecimals: 6 });
  assert.equal(q.order.takerTokens.length, 1);
  assert.equal(q.order.makerTokens.length, 10, 'ANTB pays out its ten constituents to the issuer');
  assert.ok(q.minReceive <= q.receive);
  const o = q.order as SsiOrder;
  const tuple = { ...o, requester: o.requester as `0x${string}`, maker: o.maker as `0x${string}`, taker: o.taker as `0x${string}`, beneficiary: o.beneficiary as `0x${string}`, makerTokens: o.makerTokens as `0x${string}`[], takerTokens: o.takerTokens as `0x${string}`[] };
  assert.equal(mintData(TOKEN, USDC, 10_000_000n, q.minReceive, o, q.signature),
    encodeFunctionData({ abi: issuerAbi, functionName: 'mintViaRFQ', args: [TOKEN, USDC, 10_000_000n, q.minReceive, tuple, q.signature as `0x${string}`] }));
  assert.equal(redeemData(TOKEN, 5n * 10n ** 17n, USDC, 1n, o, q.signature),
    encodeFunctionData({ abi: issuerAbi, functionName: 'redeemViaRFQ', args: [TOKEN, 5n * 10n ** 17n, USDC, 1n, tuple, q.signature as `0x${string}`] }));
  assert.equal(digestData(o), encodeFunctionData({ abi: issuerAbi, functionName: 'digest', args: [tuple] }));
});

test('an index quote for another wallet, amount or token is refused', () => {
  const want = { side: 'buy' as const, owner: OWNER, token: TOKEN, asset: USDC, payAmount: 10_000_000n, assetDecimals: 6 };
  assert.throws(() => parseSsiQuote(fx.ssiQuote, { ...want, owner: '0x2222222222222222222222222222222222222222' }), /another wallet/);
  assert.throws(() => parseSsiQuote(fx.ssiQuote, { ...want, payAmount: 9_000_000n }), /payment/);
  assert.throws(() => parseSsiQuote(fx.ssiQuote, { ...want, token: '0x3333333333333333333333333333333333333333' }), /payment/);
  assert.throws(() => parseSsiQuote({ ...fx.ssiQuote, quotable: false }, want), /did not quote/);
  assert.throws(() => parseSsiQuote({ ...fx.ssiQuote, protocol: 'other' }, want), /index order/);
});

test('claims: the topics are the keccak of the events seen on chain, the selectors of the documented claims', () => {
  assert.equal(CLAIM_TOPIC.requestedDeposit, keccak('RequestedDeposit(address,address,address,uint256,uint256,bytes32)'));
  assert.equal(CLAIM_TOPIC.requestedRedeem, keccak('RequestedRedeem(address,address,address,uint256,uint256,bytes32)'));
  assert.equal(CLAIM_TOPIC.buySubmitted, keccak('BuySubmitted(address,address,uint256,uint256,uint256,bytes32)'));
  assert.equal(CLAIM_TOPIC.sellSubmitted, keccak('SellSubmitted(address,address,uint256,uint256,uint256,bytes32)'));
  for (const [k, sig] of Object.entries({ claimDeposit: 'claimDeposit(address,uint256)', claimRedeem: 'claimRedeem(address,uint256)', claimDelayedRedeem: 'claimDelayedRedeem(address,uint256)', claimBuy: 'claimBuy(address,uint256)', claimSell: 'claimSell(address,uint256)', claimDelayedBuy: 'claimDelayedBuy(address,uint256)', claimDelayedSell: 'claimDelayedSell(address,uint256)' })) {
    assert.equal(CLAIM_SELECTOR[k as keyof typeof CLAIM_SELECTOR], keccak(sig).slice(0, 10), k);
  }
});

const VAULT = '0x67531aef9ce1ad5af176d0940bb8dfb0e1c1ecbe';
test('claims: the request id comes out of real UNITREE receipts', () => {
  const red = requestOfLogs(fx.batchRedeem, VAULT);
  assert.equal(red?.kind, 'vault'); assert.equal(red?.side, 'sell');
  const dep = requestOfLogs(fx.batchDeposit, VAULT);
  assert.equal(dep?.kind, 'vault'); assert.equal(dep?.side, 'buy');
  const buy = requestOfLogs(fx.rfqBuy, VAULT);
  assert.equal(buy?.kind, 'rfq'); assert.equal(buy?.side, 'buy');
  assert.equal(buy?.contract.toLowerCase(), '0x4aa5e39956acadd68be0b6720a030be3c14a6239', 'TigrisRFQ');
  assert.equal(requestOfLogs(fx.batchRedeem, '0x9876b381a94876ea8fea56b625e15556fb450629'), null, 'another vault\'s receipt has no request of this one');
  const claims = claimCalls(red!, OWNER, VAULT);
  assert.equal(claims[0]!.data, encodeFunctionData({ abi: parseAbi(['function claimRedeem(address receiver, uint256 requestId)']), functionName: 'claimRedeem', args: [OWNER, red!.id] }));
  assert.equal(claims[1]!.data.slice(0, 10), CLAIM_SELECTOR.claimDelayedRedeem);
  assert.equal(claimCalls(buy!, OWNER, VAULT)[0]!.data, encodeFunctionData({ abi: parseAbi(['function claimBuy(address vault, uint256 orderId)']), functionName: 'claimBuy', args: [VAULT, buy!.id] }));
});

test('every ValueDesk index adds up to one and names distinct funds', () => {
  for (const ix of VD_INDEXES) {
    assert.ok(weightsOk(ix), ix.id);
    assert.equal(new Set(ix.legs.map((l) => l.fundId)).size, ix.legs.length, ix.id);
  }
});

const day = (d: number) => Date.UTC(2026, 9, 1) + d * 86_400_000;
const two: VdIndex = { id: 't', name: 'T', line: '', legs: [{ fundId: 'A', weight: 0.5 }, { fundId: 'B', weight: 0.5 }] };

test('a basket is bought and held: half in A that doubles, half in B that stays, is up 50%', () => {
  const closes = new Map([['A', [{ t: day(0), close: 10 }, { t: day(40), close: 20 }]], ['B', [{ t: day(0), close: 5 }, { t: day(40), close: 5 }]]]);
  const s = basketSeries(two, closes)!;
  assert.equal(s[0]!.v, 1);
  assert.equal(s.at(-1)!.v, 1.5);
  assert.equal(changeOver(s, 40), 0.5);
  assert.equal(changeOver(s, 365), null, 'not a year of closes');
  assert.equal(basketSeries(two, new Map([['A', closes.get('A')!]])), null, 'a leg without closes: no series');
});

test('the basket starts on the first day every leg has a close', () => {
  const closes = new Map([['A', [{ t: day(0), close: 10 }, { t: day(10), close: 11 }, { t: day(20), close: 12 }]], ['B', [{ t: day(10), close: 4 }, { t: day(20), close: 4 }]]]);
  const s = basketSeries(two, closes)!;
  assert.equal(s[0]!.t, day(10));
  assert.ok(Math.abs(s.at(-1)!.v - (0.5 * 12 / 11 + 0.5)) < 1e-12);
});

test('live yield only when every leg has one', () => {
  const q = (apy?: string) => ({ fundId: 'x', apy7d: apy } as WealthQuote);
  assert.equal(basketApy(two, new Map([['A', q('4')], ['B', q('6')]])), 5);
  assert.equal(basketApy(two, new Map([['A', q('4')], ['B', q(undefined)]])), null);
});

const fund = (fundId: string, fundType: WealthFund['fundType']): WealthFund => ({ fundId, name: fundId, fundType, fundStatus: 'live', share: { coin: fundId, address: '0x0', decimals: 18 }, ...(fundType === 'clob' ? { spot: { symbol: `${fundId}_vUSDC`, symbolId: 1, displayName: fundId, quote: { coin: 'vUSDC', decimals: 6 } } } : {}) });

test('legs: cents rounded down, the rest on the largest leg, each through its channel and from its account', () => {
  const ix: VdIndex = { id: 'x', name: 'X', line: '', legs: [{ fundId: 'vVOO', weight: 0.6 }, { fundId: 'vQQQ', weight: 0.25 }, { fundId: 'Morpho-Earn', weight: 0.15 }] };
  const funds = [fund('vVOO', 'clob'), fund('vQQQ', 'clob'), fund('Morpho-Earn', 'bridged_vault')];
  const actions = new Map([['vVOO', { kind: 'trade' as const, symbol: 'vVOO_vUSDC' }], ['vQQQ', { kind: 'closed' as const, why: 'Market closed', nextAt: null }]]);
  const legs = planLegs(ix, 100.01, funds, actions);
  assert.equal(legs.reduce((t, l) => t + Math.round(l.usd * 100), 0), 10001, 'every cent placed');
  assert.deepEqual(legs.map((l) => l.route), ['spot', 'closed', 'earn']);
  assert.deepEqual(legs.map((l) => l.from), ['spot', 'wallet', 'wallet']);
  assert.equal(routeOf(null, null).route, 'closed');
});

test('an index starts where its smallest leg reaches that leg\'s minimum', () => {
  const china: VdIndex = { id: 'c', name: 'C', line: '', legs: [{ fundId: 'CXMT', weight: 0.5 }, { fundId: 'UNITREE', weight: 0.5 }] };
  assert.equal(minimumFor(china, new Map([['CXMT', 1], ['UNITREE', 100]])), 200);
  const core = VD_INDEXES.find((i) => i.id === 'us-core')!;
  assert.equal(minimumFor(core, new Map([['vVOO', 5], ['vQQQ', 5], ['vSCHD', 5]])), 34);
});

test('instant exit: priced an hour after the cutoff (the Shanghai open), and the close is a valid hosted TWAP', () => {
  const st = { channel: 'batch', batch: { opensAt: 1, cutoffAt: 1795998600, expectedDeliveryAt: 1796022000 } } as unknown as TradingStatus;
  assert.equal(new Date(pricingAt(st)!).toISOString(), '2026-11-30T01:30:00.000Z');
  assert.equal(pricingAt({ ...st, channel: 'rfq' } as TradingStatus), null);
  const spec = parseAlgoSpec(hedgeCloseSpec('UNITREE-USD', pricingAt(st)!)) as { kind: string; reduceOnly: boolean; closeShare: number; startAt: number };
  assert.equal(spec.kind, 'twap');
  assert.equal(spec.reduceOnly, true, 'a close never opens');
  assert.equal(spec.closeShare, 1);
  assert.equal(spec.startAt, pricingAt(st)! - 30_000);
  assert.equal(hedgeQuantity(1.2399), '1.23');
});

// --- indexes you make, publish and buy on a schedule (2026-11-28) ---------------------------------------

test('equal parts in whole basis points add up to 10000, the remainder on the first legs', () => {
  assert.deepEqual(equalBp(3), [3334, 3333, 3333]);
  assert.deepEqual(equalBp(6), [1667, 1667, 1667, 1667, 1666, 1666]);
  assert.equal(equalBp(7).reduce((a, b) => a + b, 0), 10_000);
  assert.deepEqual(equalBp(0), []);
});

test('the history leaves out a leg without closes and says so, the rest at its own weights', () => {
  const ix: VdIndex = { id: 'x', name: 'X', line: '', legs: [{ fundId: 'A', weight: 0.5 }, { fundId: 'E', weight: 0.25 }, { fundId: 'B', weight: 0.25 }] };
  const closes = new Map([['A', [{ t: day(0), close: 10 }, { t: day(10), close: 20 }]], ['B', [{ t: day(0), close: 5 }, { t: day(10), close: 5 }]]]);
  const h = basketHistory(ix, closes)!;
  assert.deepEqual(h.leftOut, ['E']);
  assert.equal(h.share, 0.75);
  assert.ok(Math.abs(h.series.at(-1)!.v - (2 / 3 * 2 + 1 / 3)) < 1e-12, 'A two thirds, B one third of what is drawn');
  assert.equal(basketHistory({ legs: [{ fundId: 'E', weight: 1 }] }, closes), null);
});

test('a year on average, the deepest fall, and a range rebased to its start', () => {
  const s = [{ t: day(0), v: 1 }, { t: day(200), v: 1.5 }, { t: day(300), v: 0.75 }, { t: day(731), v: 1.21 }];
  assert.ok(Math.abs(annualised(s)! - 0.1) < 0.002, '+21% over two years is about 10% a year');
  assert.equal(annualised(s.slice(0, 2)), null, 'not under a year');
  assert.equal(maxDrawdown(s), -0.5);
  const r = rangeOf(s, 500);
  assert.equal(r[0]!.t, day(200), 'from the last point at or before the start');
  assert.equal(r[0]!.v, 1);
  assert.equal(rangeOf(s, null).length, 4);
});

const target = (fundId: string, min: number, market: 0 | 1 = 1) => ({ fund: fund(fundId, 'clob'), vault: '0x0', market, minAmount: BigInt(min * 1e6) });

test('a recurring index: one plan per leg by weight, every leg above its own minimum, legs SoDEX does not list named', () => {
  const ix: VdIndex = { id: 'x', name: 'X', line: '', legs: [{ fundId: 'vVOO', weight: 0.6 }, { fundId: 'vQQQ', weight: 0.25 }, { fundId: 'UNITREE', weight: 0.15 }] };
  const targets = [target('vVOO', 5), target('vQQQ', 5), target('UNITREE', 100, 0)];
  const legs = recurringLegs(ix, 1_000_000_001n, targets);
  assert.equal(legs.reduce((s, l) => s + l.amount, 0n), 1_000_000_001n, 'every unit placed');
  assert.deepEqual(legs.map((l) => l.amount), [600_000_001n, 250_000_000n, 150_000_000n]);
  assert.equal(recurringMinimum(ix, targets), 667_000_000n, 'UNITREE needs $100 at 15%: $667 a run');
  assert.deepEqual(notRecurring({ legs: [...ix.legs, { fundId: 'Morpho-Earn', weight: 0 }] }, targets), ['Morpho-Earn']);
});

// --- editing weights ---------------------------------------------------------------------------------

const sumBp = (l: Array<{ bp: number }>) => l.reduce((s, x) => s + x.bp, 0);

test('one weight moves the others: always 100%, never one leg at 100% while others are in', () => {
  const legs = [{ fundId: 'A', bp: 5000 }, { fundId: 'B', bp: 3000 }, { fundId: 'C', bp: 2000 }];
  const up = setWeight(legs, 'A', 7000);
  assert.equal(sumBp(up), 10_000);
  assert.deepEqual(up.map((l) => l.bp), [7000, 1800, 1200], 'B and C give in proportion');
  const max = setWeight(legs, 'A', 10_000);
  assert.deepEqual(max.map((l) => l.bp), [9980, 10, 10], 'the others keep their 0.1%');
  assert.equal(sumBp(addLeg(legs, 'D')), 10_000);
  assert.equal(addLeg(legs, 'D').find((l) => l.fundId === 'D')!.bp, 2500);
  assert.deepEqual(removeLeg(legs, 'C').map((l) => l.bp), [6250, 3750]);
});

test('clean up rounds to the cleanest step each weight allows', () => {
  assert.deepEqual(cleanWeights([{ fundId: 'A', bp: 3334 }, { fundId: 'B', bp: 3333 }, { fundId: 'C', bp: 3333 }]).map((l) => l.bp), [3400, 3300, 3300]);
  const big = cleanWeights([{ fundId: 'A', bp: 6123 }, { fundId: 'B', bp: 2877 }, { fundId: 'C', bp: 1000 }]);
  assert.deepEqual(big.map((l) => l.bp), [6100, 2900, 1000]);
  const small = cleanWeights([{ fundId: 'A', bp: 9862 }, { fundId: 'B', bp: 46 }, { fundId: 'C', bp: 46 }, { fundId: 'D', bp: 46 }]);
  assert.equal(sumBp(small), 10_000);
  assert.ok(small.slice(1).every((l) => l.bp >= 40 && l.bp <= 50), `0.46% stays small: ${small.map((l) => l.bp)}`);
});
