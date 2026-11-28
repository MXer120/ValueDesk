/**
 * Recurring Buy: calldata byte by byte against SoDEX's AutomaticInvestment ABI (verified on main-scan.valuechain.xyz,
 * implementation 0x9d7e230d..., 2026-11-27) and the documented prefund ledger; the schedule sodex.com offers.
 * No network, nothing sent.   npx tsx --test src/trading/recurring.test.ts   (from apps/web)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keccak_256 } from '@noble/hashes/sha3';
import { encodeAbiParameters, encodeFunctionData, parseAbi } from 'viem';
import {
  RECURRING_SELECTOR, createPlanData, dayProblem, decodeVaultRange, depositData, firstRunDate, fundsProblem, planActionData, planProblem,
  redeemData, scheduleWords, sharesFor, updatePlanData, type PrefundFacts,
} from './recurring';

const sel = (s: string): string => `0x${Buffer.from(keccak_256(new TextEncoder().encode(s))).toString('hex').slice(0, 8)}`;

const plan = parseAbi([
  'function getNumVaults() view returns (uint256)',
  'function getVaultByRange(uint256 rangeStart, uint256 rangeEnd) view returns (address[] vaults, uint8[] vaultTypes)',
  'function getTargetConfig(address vault) view returns ((uint8 vaultType, uint256 minInvestAmount))',
  'function deposit() view returns (address)',
  'function createInvestmentPlan(address vault, uint256 amount, uint8 planType, uint8 dayOfPeriod)',
  'function updateInvestmentPlanByIndex(uint256 planIndex, uint256 amount, uint8 planType, uint8 dayOfPeriod)',
  'function pauseInvestmentPlanByIndex(uint256 planIndex)',
  'function resumeInvestmentPlanByIndex(uint256 planIndex)',
  'function cancelInvestmentPlanByIndex(uint256 planIndex)',
]);
const ledger = parseAbi([
  'function asset() view returns (address)',
  'function balanceOfAssets(address account) view returns (uint256)',
  'function balanceOfShares(address account) view returns (uint256)',
  'function deposit(uint256 assets) returns (uint256 shares)',
  'function redeem(uint256 shares) returns (uint256 assets)',
]);

const CXMT = '0x9876b381a94876ea8fea56b625e15556fb450629';

test('each selector is the keccak of the verified (or documented) signature', () => {
  assert.equal(RECURRING_SELECTOR.getNumVaults, sel('getNumVaults()'));
  assert.equal(RECURRING_SELECTOR.getVaultByRange, sel('getVaultByRange(uint256,uint256)'));
  assert.equal(RECURRING_SELECTOR.getTargetConfig, sel('getTargetConfig(address)'));
  assert.equal(RECURRING_SELECTOR.depositContract, sel('deposit()'));
  assert.equal(RECURRING_SELECTOR.createInvestmentPlan, sel('createInvestmentPlan(address,uint256,uint8,uint8)'));
  assert.equal(RECURRING_SELECTOR.updateInvestmentPlanByIndex, sel('updateInvestmentPlanByIndex(uint256,uint256,uint8,uint8)'));
  assert.equal(RECURRING_SELECTOR.pauseInvestmentPlanByIndex, sel('pauseInvestmentPlanByIndex(uint256)'));
  assert.equal(RECURRING_SELECTOR.resumeInvestmentPlanByIndex, sel('resumeInvestmentPlanByIndex(uint256)'));
  assert.equal(RECURRING_SELECTOR.cancelInvestmentPlanByIndex, sel('cancelInvestmentPlanByIndex(uint256)'));
  assert.equal(RECURRING_SELECTOR.asset, sel('asset()'));
  assert.equal(RECURRING_SELECTOR.balanceOfAssets, sel('balanceOfAssets(address)'));
  assert.equal(RECURRING_SELECTOR.balanceOfShares, sel('balanceOfShares(address)'));
  assert.equal(RECURRING_SELECTOR.deposit, sel('deposit(uint256)'));
  assert.equal(RECURRING_SELECTOR.redeem, sel('redeem(uint256)'));
});

test('plan calls encode as the ABI does: type codes DAILY 0, WEEKLY 1, BI_WEEKLY 2, MONTHLY 3', () => {
  assert.equal(createPlanData(CXMT, 100_000_000n, 'WEEKLY', 1), encodeFunctionData({ abi: plan, functionName: 'createInvestmentPlan', args: [CXMT, 100_000_000n, 1, 1] }));
  assert.equal(createPlanData(CXMT, 5_000_000n, 'DAILY', 0), encodeFunctionData({ abi: plan, functionName: 'createInvestmentPlan', args: [CXMT, 5_000_000n, 0, 0] }));
  assert.equal(createPlanData(CXMT, 5_000_000n, 'MONTHLY', 30), encodeFunctionData({ abi: plan, functionName: 'createInvestmentPlan', args: [CXMT, 5_000_000n, 3, 30] }));
  assert.equal(updatePlanData(114n, 250_000_000n, 'BI_WEEKLY', 5), encodeFunctionData({ abi: plan, functionName: 'updateInvestmentPlanByIndex', args: [114n, 250_000_000n, 2, 5] }));
  assert.equal(planActionData('pause', 114n), encodeFunctionData({ abi: plan, functionName: 'pauseInvestmentPlanByIndex', args: [114n] }));
  assert.equal(planActionData('resume', 114n), encodeFunctionData({ abi: plan, functionName: 'resumeInvestmentPlanByIndex', args: [114n] }));
  assert.equal(planActionData('cancel', 114n), encodeFunctionData({ abi: plan, functionName: 'cancelInvestmentPlanByIndex', args: [114n] }));
});

test('prefund ledger calls encode as documented', () => {
  assert.equal(depositData(300_000_000n), encodeFunctionData({ abi: ledger, functionName: 'deposit', args: [300_000_000n] }));
  assert.equal(redeemData(10n ** 20n), encodeFunctionData({ abi: ledger, functionName: 'redeem', args: [10n ** 20n] }));
});

test('the allowlist read decodes both arrays', () => {
  const vaults = [CXMT, '0x67531aef9ce1ad5af176d0940bb8dfb0e1c1ecbe', '0x09e08d7b9e9483f51beba65e1fd702ec910b1ee5'] as const;
  const hex = encodeAbiParameters([{ type: 'address[]' }, { type: 'uint8[]' }], [vaults as unknown as `0x${string}`[], [0, 0, 1]]);
  assert.deepEqual(decodeVaultRange(hex), [
    { vault: CXMT, market: 0 },
    { vault: '0x67531aef9ce1ad5af176d0940bb8dfb0e1c1ecbe', market: 0 },
    { vault: '0x09e08d7b9e9483f51beba65e1fd702ec910b1ee5', market: 1 },
  ]);
  assert.deepEqual(decodeVaultRange(encodeAbiParameters([{ type: 'address[]' }, { type: 'uint8[]' }], [[], []])), []);
});

test('the days sodex.com offers: none daily, Monday-Friday weekly and every 2 weeks, 1-30 monthly', () => {
  assert.equal(dayProblem('DAILY', 0), null);
  assert.ok(dayProblem('DAILY', 1));
  assert.equal(dayProblem('WEEKLY', 1), null);
  assert.equal(dayProblem('BI_WEEKLY', 5), null);
  assert.ok(dayProblem('WEEKLY', 6), 'no weekend days');
  assert.ok(dayProblem('WEEKLY', 0));
  assert.equal(dayProblem('MONTHLY', 30), null);
  assert.ok(dayProblem('MONTHLY', 31), 'sodex.com offers days 1-30');
  assert.equal(scheduleWords('WEEKLY', 1), 'every Monday');
  assert.equal(scheduleWords('BI_WEEKLY', 3), 'every second Wednesday');
  assert.equal(scheduleWords('MONTHLY', 15), 'on day 15 of every month');
  assert.equal(scheduleWords('DAILY', 0), 'every trading day');
});

test('the first due date in the market\'s own time', () => {
  // Fri 2026-11-27 20:19 UTC = Sat 04:19 in China, Fri 16:19 in the US book's fixed UTC-4.
  const now = Date.UTC(2026, 10, 27, 20, 19);
  assert.equal(firstRunDate('DAILY', 0, 0, now), '2026-11-30', 'China: Saturday, so Monday');
  assert.equal(firstRunDate('DAILY', 0, 1, now), '2026-11-30', 'US: Friday past 09:30, weekend, so Monday');
  assert.equal(firstRunDate('WEEKLY', 3, 0, now), '2026-12-02');
  assert.equal(firstRunDate('MONTHLY', 1, 0, now), '2026-12-01');
  assert.equal(firstRunDate('MONTHLY', 28, 0, now), '2026-12-28');
  assert.equal(firstRunDate('BI_WEEKLY', 1, 0, now), '2026-12-07', 'this week\'s Monday has passed: two weeks on');
  // Before 09:30 local the day still counts: Mon 2026-11-30 00:10 UTC = 08:10 in China.
  assert.equal(firstRunDate('DAILY', 0, 0, Date.UTC(2026, 10, 30, 0, 10)), '2026-11-30');
  assert.equal(firstRunDate('WEEKLY', 1, 0, Date.UTC(2026, 10, 30, 2, 0)), '2026-12-07', '10:00 in China: today\'s window has shut');
  // A month without the day: 30 February does not exist, so March.
  assert.equal(firstRunDate('MONTHLY', 30, 0, Date.UTC(2027, 1, 2, 12)), '2027-03-30');
});

const pf = (o: Partial<PrefundFacts> = {}): PrefundFacts => ({ deposit: '0x0', usdc: '0x0', usdcDecimals: 6, available: 217_540_642n, shares: 217_000_000_000_000_000_000n, walletUsdc: 50_000_000n, gasBalance: 1n, ...o });

test('withdrawing: never more shares than pay the amount asked; all of it takes every share', () => {
  const f = pf();
  assert.equal(sharesFor(f.available, f), f.shares);
  assert.equal(sharesFor(f.available + 1n, f), f.shares);
  const half = sharesFor(100_000_000n, f);
  assert.ok((half * f.available) / f.shares <= 100_000_000n);
  assert.equal(sharesFor(0n, f), 0n);
  assert.equal(sharesFor(1n, pf({ available: 0n })), 0n);
});

test('what stops funding or a plan, in words', () => {
  assert.equal(fundsProblem('add', 50_000_000n, pf()), null);
  assert.match(fundsProblem('add', 50_000_001n, pf())!, /wallet/);
  assert.match(fundsProblem('withdraw', 217_540_643n, pf())!, /More than/);
  assert.match(fundsProblem('add', 1n, pf({ gasBalance: 0n }))!, /SOSO/);
  assert.equal(planProblem({ minAmount: 5_000_000n }, 5_000_000n, 'WEEKLY', 1), null);
  assert.match(planProblem({ minAmount: 100_000_000n }, 99_999_999n, 'WEEKLY', 1)!, /minimum/);
  assert.match(planProblem({ minAmount: 5_000_000n }, 5_000_000n, 'MONTHLY', 31)!, /1 to 30/);
});
