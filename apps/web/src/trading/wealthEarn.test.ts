/**
 * USDC Earn's bridge calls, byte by byte, against SoDEX's verified Caller ABI and a real order read from ValueChain
 * (wealthEarn.fixture.json, 2026-11-27). No network, nothing sent.
 *   npx tsx --test src/trading/wealthEarn.test.ts   (from apps/web)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { keccak_256 } from '@noble/hashes/sha3';
import { decodeEventLog, decodeFunctionResult, encodeFunctionData, parseAbi, type Abi, type Hex } from 'viem';
import {
  CALL_CREATED_TOPIC, EARN_SELECTOR, bridgeCallData, callForData, callForOfReceipt, decodeCallFor, earnProblem, expectedOut,
  getTokenData, minAmountData, minOutOf, pairData, wad, type EarnFacts,
} from './wealthEarn';
import type { CoinConfig } from './funds';

const fx = JSON.parse(readFileSync(new URL('./wealthEarn.fixture.json', import.meta.url), 'utf8')) as {
  callerAbi: Abi; getCallForById190494: Hex; createdLog: { address: string; topics: Hex[]; data: Hex };
};
const abi = fx.callerAbi;
const create7 = (abi as unknown as Array<{ name?: string; inputs?: unknown[] }>).filter((x) => x.name !== 'createBridgeCallFor' || x.inputs?.length === 7) as unknown as Abi;
const keccak = (s: string): string => `0x${Buffer.from(keccak_256(new TextEncoder().encode(s))).toString('hex')}`;
const sel = (s: string): string => keccak(s).slice(0, 10);

test('each selector is the keccak of the verified signature', () => {
  assert.equal(EARN_SELECTOR.caller, sel('caller()'));
  assert.equal(EARN_SELECTOR.getToken, sel('getToken(string)'));
  assert.equal(EARN_SELECTOR.createBridgeCallFor, sel('createBridgeCallFor(string,uint8,string,uint256,string,uint256,bool)'));
  assert.equal(EARN_SELECTOR.getCallForById, sel('getCallForById(uint256)'));
  assert.equal(EARN_SELECTOR.callForMinAmounts, sel('callForMinAmounts(string,string)'));
  assert.equal(EARN_SELECTOR.isCallForCoinSymbolPair, sel('isCallForCoinSymbolPair(string,string,string)'));
  assert.equal(CALL_CREATED_TOPIC, keccak('BridgeCallForCreated((uint256,string,string,address,uint8,string,string,uint256,string,string,uint256,uint256,uint8,uint256,uint256,string,bool,uint256))'));
  assert.equal(fx.createdLog.topics[0], CALL_CREATED_TOPIC, 'the topic of a real log');
});

test('subscribe and redeem calldata are exactly what the verified ABI encodes (direct, 7 arguments, toClob false)', () => {
  assert.equal(
    bridgeCallData('buy', 6_450_000n, 6_319_928_371_644_308_855n),
    encodeFunctionData({ abi: create7, functionName: 'createBridgeCallFor', args: ['BASE_ETH', 3, 'USDC', 6_450_000n, 'soUSDC', 6_319_928_371_644_308_855n, false] }),
  );
  assert.equal(
    bridgeCallData('sell', 7_383_765_472_290_629_684n, 7_385_772n),
    encodeFunctionData({ abi: create7, functionName: 'createBridgeCallFor', args: ['BASE_ETH', 4, 'soUSDC', 7_383_765_472_290_629_684n, 'USDC', 7_385_772n, false] }),
  );
});

test('the route checks encode as the ABI does', () => {
  const portal = parseAbi(['function getToken(string coinSymbol) view returns (address token)']); // the Portal's verified ABI
  assert.equal(getTokenData('soUSDC'), encodeFunctionData({ abi: portal, functionName: 'getToken', args: ['soUSDC'] }));
  assert.equal(minAmountData('USDC'), encodeFunctionData({ abi, functionName: 'callForMinAmounts', args: ['BASE_ETH', 'USDC'] }));
  assert.equal(pairData('USDC', 'soUSDC'), encodeFunctionData({ abi, functionName: 'isCallForCoinSymbolPair', args: ['BASE_ETH', 'USDC', 'soUSDC'] }));
  assert.equal(callForData(190_494n), encodeFunctionData({ abi, functionName: 'getCallForById', args: [190_494n] }));
});

type Tuple = { callForId: bigint; user: string; callForType: number; inAmount: bigint; minOutAmount: bigint; outAmount: bigint; status: number; createdTimestamp: bigint; settledTimestamp: bigint; toClob: boolean };
const same = (mine: ReturnType<typeof decodeCallFor>, t: Tuple) => {
  assert.equal(mine.callForId, t.callForId);
  assert.equal(mine.user.toLowerCase(), t.user.toLowerCase());
  assert.equal(mine.callForType, t.callForType);
  assert.equal(mine.inAmount, t.inAmount);
  assert.equal(mine.minOutAmount, t.minOutAmount);
  assert.equal(mine.outAmount, t.outAmount);
  assert.equal(mine.status, t.status);
  assert.equal(mine.createdAt, Number(t.createdTimestamp));
  assert.equal(mine.settledAt, Number(t.settledTimestamp));
  assert.equal(mine.toClob, t.toClob);
};

test('a real order read back (getCallForById 190494): every static field as viem decodes it', () => {
  const t = decodeFunctionResult({ abi, functionName: 'getCallForById', data: fx.getCallForById190494 }) as unknown as Tuple;
  const mine = decodeCallFor(fx.getCallForById190494);
  same(mine, t);
  assert.equal(mine.callForId, 190_494n);
  assert.equal(mine.callForType, 3, 'a deposit');
  assert.equal(mine.inAmount, 6_450_000n, '6.45 USDC in');
  assert.equal(mine.status, 1, 'settled');
});

test('a real BridgeCallForCreated log decodes the same, and the receipt finds it for its user only', () => {
  const ev = decodeEventLog({ abi, data: fx.createdLog.data, topics: fx.createdLog.topics as [Hex, ...Hex[]] }) as unknown as { args: { bridgeCallFor: Tuple } };
  const mine = decodeCallFor(fx.createdLog.data);
  same(mine, ev.args.bridgeCallFor);
  const receipt = { status: 'success' as const, logs: [{ address: '0xcb7f80dff2727c791fa491722c428e6657f7e2c6', topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'], data: '0x' }, fx.createdLog] };
  assert.equal(callForOfReceipt(receipt, fx.createdLog.address, mine.user)?.callForId, mine.callForId);
  assert.equal(callForOfReceipt(receipt, fx.createdLog.address, '0x1111111111111111111111111111111111111111'), null, 'another wallet\'s order is not ours');
  assert.equal(callForOfReceipt(receipt, '0x2222222222222222222222222222222222222222', mine.user), null, 'only the Caller\'s log counts');
});

test('amounts: expected out at the NAV, and the 99% minimum sodex.com sends', () => {
  assert.equal(wad('1.010358385850987000'), 1_010_358_385_850_987_000n);
  assert.equal(wad('1'), 10n ** 18n);
  assert.throws(() => wad('abc'));
  assert.equal(expectedOut('buy', 5_000_000n, 10n ** 18n, 6, 18), 5n * 10n ** 18n);
  assert.equal(minOutOf(5n * 10n ** 18n), 4_950_000_000_000_000_000n);
  // A redemption of 4 shares at 1.010358385850987: 4.041433 USDC, rounded down; at least 4.001019.
  const out = expectedOut('sell', 4n * 10n ** 18n, wad('1.010358385850987'), 6, 18);
  assert.equal(out, 4_041_433n);
  assert.equal(minOutOf(out), 4_001_018n);
  // sodex.com's real order 190494 asked for 99% of what its NAV gave: ours at that NAV lands within one unit.
  const nav = (6_450_000n * 10n ** 30n) / (6_319_928_371_644_308_855n * 10_000n / 9_900n);
  const mine = minOutOf(expectedOut('buy', 6_450_000n, nav, 6, 18));
  assert.ok(mine >= 6_319_928_371_644_308_855n - 10n ** 6n && mine <= 6_319_928_371_644_308_855n + 10n ** 6n, `${mine}`);
});

const coin = (c: string, dp: number): CoinConfig => ({ coin: c, asset: `v${c}`, assetId: 0, valuechain: { token: '0x0', symbol: `v${c}`, decimals: dp, native: false }, chains: [] });
const facts = (o: Partial<EarnFacts> = {}): EarnFacts => ({
  caller: '0x478fec6b6ead70d0e03beeba15027aa6d51180ab', usdc: coin('USDC', 6), share: coin('soUSDC', 18), nav: 10n ** 18n, navAsOf: null,
  minIn: 5_000_000n, minRedeem: 4n * 10n ** 18n, usdcBalance: 100_000_000n, shareBalance: 50n * 10n ** 18n, gasBalance: 10n ** 16n, open: true, why: null, ...o,
});

test('what stops a request, in words', () => {
  assert.equal(earnProblem('buy', 10_000_000n, facts()), null);
  assert.match(earnProblem('buy', 0n, facts())!, /amount/);
  assert.match(earnProblem('buy', 4_999_999n, facts())!, /minimum/);
  assert.match(earnProblem('buy', 100_000_001n, facts())!, /Not enough USDC/);
  assert.match(earnProblem('sell', 3n * 10n ** 18n, facts())!, /minimum redemption/);
  assert.match(earnProblem('sell', 51n * 10n ** 18n, facts())!, /More than the shares/);
  assert.match(earnProblem('buy', 10_000_000n, facts({ gasBalance: 0n }))!, /SOSO/);
  assert.equal(earnProblem('buy', 10_000_000n, facts({ open: false, why: 'Route off.' })), 'Route off.');
});
