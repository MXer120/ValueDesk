/**
 * What the summary leads with, read from the runner's report - and never guessed.
 *   npx tsx --test e2e/guide/report.test.ts        (from apps/web)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { liveReport, planReport } from './fixtures';
import { BUILDER_CHECKS, builderCheckRows, chainRows, checkStatus, findings, orderTypeRows, otherChecks, parseRouteRow, readChecks, touchedByPlan } from './report';
import { readLiveReport, readPlanReport } from './runner';

test('checkStatus: the runner\'s words; anything unknown is "not run", never a pass', () => {
  for (const [word, want] of [['pass', 'pass'], ['PASSED', 'pass'], ['ok', 'pass'], [true, 'pass'], ['fail', 'fail'], ['failed', 'fail'], [false, 'fail'], ['finding', 'finding'], ['warn', 'warn'], ['skipped', 'skipped'], ['not-run', 'not-run'], ['not_run', 'not-run'], ['not testable', 'not-testable']] as const) {
    assert.equal(checkStatus(word), want, String(word));
  }
  for (const odd of ['great', '', undefined, null, 7, {}]) assert.equal(checkStatus(odd), 'not-run');
});

test('the builder-fee list is the owner\'s: (a) to (f), and the approval check of the contract', () => {
  assert.deepEqual(BUILDER_CHECKS.map((c) => `${c.letter}:${c.id}`), [
    'a:builder-fee-default',
    'b:builder-volume-verified',
    'c:builder-fee-lowered',
    'd:builder-underpaid-not-counted',
    'd:builder-no-builder-not-counted',
    'e:builder-modify-keeps-builder',
    'e:builder-replace-keeps-builder',
    'f:builder-income-matches',
    'g:builder-approval-enforced',
  ]);
});

test('a report without checks: every row is "not run", with the reason - nothing is inferred from the steps', () => {
  const rows = builderCheckRows(readChecks(liveReport()), 'the live runner did not report this check');
  assert.equal(rows.length, 9);
  assert.ok(rows.every((r) => r.status === 'not-run' && r.detail === 'the live runner did not report this check'));
  assert.deepEqual(readChecks({ checks: 'nope' }), []);
  assert.deepEqual(readChecks(null), []);
});

test('checks by their exact ids: pass, fail, finding - and whatever else the runner reports is kept', () => {
  const report = liveReport({
    checks: [
      { id: 'builder-fee-default', title: 'first orders carry 20', status: 'pass', detail: 'order 77: builder { id 12345, feeRate 20 }, builderFee 0.00236 = 2 bp of 11.81' },
      { id: 'builder-volume-verified', status: 'pass', value: 12.4 },
      { id: 'builder-fee-lowered', status: 'fail', detail: 'the next order still carried 20' },
      { id: 'builder-replace-keeps-builder', status: 'finding', detail: 'the replaced order has no builder: SoDEX drops it on replace' },
      { id: 'builder-fee-defaults', status: 'pass' },
      { id: 'key-lifecycle', title: 'the key expires', status: 'pass' },
      { title: 'no id' },
    ],
  });
  const checks = readChecks(report);
  assert.equal(checks.length, 6);
  const rows = builderCheckRows(checks, 'why');
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(by['builder-fee-default']!.status, 'pass');
  assert.match(by['builder-fee-default']!.detail, /2 bp of 11\.81/);
  assert.equal(by['builder-volume-verified']!.detail, 'result: 12.4');
  assert.equal(by['builder-fee-lowered']!.status, 'fail');
  assert.equal(by['builder-replace-keeps-builder']!.status, 'finding');
  assert.equal(by['builder-modify-keeps-builder']!.status, 'not-run'); // not reported
  assert.equal(by['builder-income-matches']!.status, 'not-run');
  // An id that is ALMOST one of ours is not matched to it.
  assert.deepEqual(otherChecks(checks).map((c) => c.id), ['builder-fee-defaults', 'key-lifecycle']);
});

test('findings: from the checks, the chains and the order types - with the runner\'s evidence', () => {
  const report = liveReport({
    checks: [{ id: 'builder-replace-keeps-builder', title: 'A replaced order still names the builder', status: 'finding', detail: 'it does not: SoDEX drops the builder on replace' }],
    chains: [{ chain: 'BASE_ETH', label: 'Base', coin: 'USDC', deposit: { status: 'finding', detail: 'credited after 14 minutes, not 2' }, withdraw: { status: 'pass' } }],
    orderTypes: [{ id: 'perps-post-only-cross', title: 'post-only order that would cross', engine: 'perps', status: 'finding', detail: 'SoDEX rejects it with code 3012' }, { id: 'x', status: 'pass' }],
  });
  const chains = chainRows(report, null, null);
  const orders = orderTypeRows(report, null);
  assert.deepEqual(findings(readChecks(report), chains, orders), [
    { where: 'A replaced order still names the builder', evidence: 'it does not: SoDEX drops the builder on replace' },
    { where: 'Base USDC deposit', evidence: 'credited after 14 minutes, not 2' },
    { where: 'perps: post-only order that would cross', evidence: 'SoDEX rejects it with code 3012' },
  ]);
});

// --- chains -----------------------------------------------------------------------------------

test('a route row of the runner\'s table', () => {
  assert.deepEqual(parseRouteRow('Arbitrum One       ETH*       open, min 0.0015   open, min 0.0015   0.0005     withdraw+verify'), { chain: 'Arbitrum One', coin: 'ETH', native: true, depositOpen: true, withdrawOpen: true, runner: 'withdraw+verify' });
  assert.deepEqual(parseRouteRow('Zcash              ZEC*       CLOSED             CLOSED             -          -'), { chain: 'Zcash', coin: 'ZEC', native: true, depositOpen: false, withdrawOpen: false, runner: '-' });
  assert.equal(parseRouteRow('BNB Smart Chain    USDC       open, min 5        open, min 5        1          deposit, withdraw+verify')?.chain, 'BNB Smart Chain');
  assert.equal(parseRouteRow("(* = the chain's native coin)"), null);
});

test('what the plan touches: read from its own step lines', () => {
  const plan = readPlanReport(planReport())!;
  assert.deepEqual(touchedByPlan(plan), {
    deposits: [{ coin: 'USDC', chain: 'Arbitrum One', step: 'deposit-external' }],
    withdrawals: [{ coin: 'USDC', chain: 'Arbitrum One', step: 'withdraw-external' }, { coin: 'ETH', chain: 'Arbitrum One', step: 'extra-withdrawals' }],
  });
});

test('chains without report.chains: every route of the table, tested / not run / not testable - and why', () => {
  const plan = readPlanReport(planReport({ funded: true }))!;
  const live = readLiveReport(liveReport())!;
  const rows = chainRows(liveReport(), plan, live);
  const by = Object.fromEntries(rows.map((r) => [`${r.chain} ${r.coin}`, r]));
  assert.equal(rows.length, 5);
  assert.equal(by['Arbitrum One USDC']!.deposit.status, 'pass');
  assert.equal(by['Arbitrum One USDC']!.withdraw.status, 'pass');
  assert.match(by['Arbitrum One USDC']!.withdraw.detail, /arrival verified on the chain/);
  assert.equal(by['Arbitrum One ETH']!.withdraw.status, 'pass');
  assert.equal(by['Arbitrum One ETH']!.deposit.status, 'not-testable'); // the runner deposits USDC only
  assert.equal(by['Base USDC']!.deposit.status, 'not-run');
  assert.equal(by['Base USDC']!.deposit.detail, 'not part of this run');
  assert.equal(by['Solana USDC']!.deposit.status, 'not-testable');
  assert.match(by['Solana USDC']!.deposit.detail, /cannot sign on this chain/);
  assert.equal(by['Zcash ZEC']!.withdraw.status, 'not-testable');
  assert.match(by['Zcash ZEC']!.withdraw.detail, /closed on SoDEX/);
});

test('chains: a plan-only run tests nothing; a stopped run fails the route it stopped on', () => {
  const plan = readPlanReport(planReport())!;
  const planned = chainRows(planReport(), plan, null);
  assert.equal(planned.find((r) => r.coin === 'USDC' && r.chain === 'Arbitrum One')!.deposit.status, 'not-run');
  assert.match(planned[0]!.deposit.detail, /planned only/);
  const stopped = readLiveReport(liveReport({ stoppedAt: 'withdraw-external' }))!;
  const rows = chainRows(liveReport({ stoppedAt: 'withdraw-external' }), plan, stopped);
  const arb = rows.find((r) => r.coin === 'USDC' && r.chain === 'Arbitrum One')!;
  assert.equal(arb.deposit.status, 'pass');
  assert.equal(arb.withdraw.status, 'fail');
  assert.match(arb.withdraw.detail, /did not become final/);
  // The ETH withdrawal comes after the stop: not reached.
  assert.equal(rows.find((r) => r.coin === 'ETH')!.withdraw.status, 'not-run');
});

test('chains: the runner\'s own list wins', () => {
  const report = liveReport({ chains: [{ chain: 'SOLANA', label: 'Solana', coin: 'USDC', deposit: { status: 'not-testable', detail: 'sent by hand; not seen in 30 min' }, withdraw: 'pass' }] });
  assert.deepEqual(chainRows(report, readPlanReport(planReport())!, readLiveReport(report)), [{ chain: 'Solana', coin: 'USDC', deposit: { status: 'not-testable', detail: 'sent by hand; not seen in 30 min' }, withdraw: { status: 'pass', detail: '' } }]);
});

// --- order types ------------------------------------------------------------------------------

test('order types without report.orderTypes: the actions the orders step recorded, each with its verifications', () => {
  const rows = orderTypeRows(liveReport(), readLiveReport(liveReport()));
  assert.deepEqual(rows.map((r) => [r.title, r.status]), [
    ['spot WSOSO_vUSDC: limit BUY 5.69 @ 0.1848 (40 % below the best bid 0.3081)', 'pass'],
    ['spot WSOSO_vUSDC: cancel it (cancelOrder)', 'pass'],
    ['perps BTC-USD: market BUY 0.00014 (~11.81 USD)', 'pass'],
  ]);
  assert.deepEqual(orderTypeRows(liveReport(), null), []);
  assert.deepEqual(orderTypeRows(planReport(), readLiveReport(liveReport({ stoppedAt: 'enable-trading' }))), []);
});

test('order types: the runner\'s own list wins, and a split orders step is read too', () => {
  const report = liveReport({ orderTypes: [{ id: 'spot-limit-gtc', title: 'limit GTC', engine: 'spot', status: 'pass', detail: 'rested, cancelled' }, { id: 'perps-twap', status: 'skipped', detail: 'TWAP cannot carry a builder' }] });
  assert.deepEqual(orderTypeRows(report, null), [{ title: 'spot: limit GTC', status: 'pass', detail: 'rested, cancelled' }, { title: 'perps-twap', status: 'skipped', detail: 'TWAP cannot carry a builder' }]);
  const split = readLiveReport({
    tool: 'valuescan-live-e2e',
    mode: 'live',
    steps: [
      { id: 'orders-spot', status: 'ok', subSteps: [{ title: 'spot X: limit SELL 1 @ 2', status: 'ok' }, { title: 'verify: it rests', status: 'failed', detail: 'not in the open orders' }] },
      { id: 'orders-perps', status: 'ok', subSteps: [{ title: 'perps Y: market BUY 1', status: 'ok' }] },
    ],
  });
  assert.deepEqual(orderTypeRows({}, split), [
    { title: 'spot X: limit SELL 1 @ 2', status: 'fail', detail: 'verify: it rests: not in the open orders' },
    { title: 'perps Y: market BUY 1', status: 'pass', detail: '' },
  ]);
});
