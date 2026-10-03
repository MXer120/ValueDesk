/**
 * Whole LIVE runs, offline: the runner (guard, key-backed wallet, the app's own
 * funds/session/actions/terms code) against a stateful fake of the backend,
 * the SoDEX gateway and its account stream, the relayer and every chain's
 * JSON-RPC node (sim/world.ts). Nothing leaves the process - the fake replaces
 * globalThis.fetch UNDER the runner's guard.
 *
 * What it proves: every write the app really makes matches what the step
 * armed, every assertion converges on the state the write produced, the
 * builder fee and its tiers work end to end against a terms route signed with
 * the shared test key, and the run ends where the plan says. What it cannot
 * prove: that SoDEX itself behaves like this fake - the live run's findings say that.
 *   npx tsx --test e2e/live/simulate.test.ts        (from apps/web)
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { gateway as exchangeGateway } from '../../src/exchange/sodexGateway';
import { formatUnits } from '../../src/trading/onboard';
import { _setBuilderPollDelaysForTests } from '../../src/trading/builderApproval';
import { runE2E } from './runner';
import { BACKEND, BUILDER_ADDRESS, DEPOSIT_ADDR, FRIEND, TERMS_PUBLIC_KEY, VC_USDC, fakeSocketFactory, installFake, newWorld, termsPublicKey, type World } from './sim/world';

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
  _setBuilderPollDelaysForTests([0, 400, 800, 1500, 2500, 4000]);
});

const CONFIG = {
  acknowledgeRealFunds: true,
  maxSpendUsd: 15,
  startChain: 'ARBITRUM_ETH',
  deposit: { chain: 'ARBITRUM_ETH', amount: '25' },
  receivers: { valuechain: FRIEND },
  cleanup: { enabled: true, chain: 'ARBITRUM_ETH' },
  orders: { triggerWaitSeconds: 2 },
  timeouts: { depositMinutes: 1, withdrawMinutes: 1, settleSeconds: 20, orderSeconds: 20, verifierMinutes: 0.1, addressIssueSeconds: 1, streamSeconds: 1 },
};

interface Check {
  id: string;
  status: string;
  detail: string;
  step: string;
  evidence: Record<string, unknown>;
}

async function run(config: object, o: { confirm?: (address: string) => string; setup?: (w: World) => void; only?: string[] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'vs-e2e-sim-'));
  const cfgPath = join(dir, 'config.json');
  writeFileSync(cfgPath, JSON.stringify(config));
  const key = generatePrivateKey();
  const address = privateKeyToAccount(key).address.toLowerCase();
  const w = newWorld(address);
  /* A real run is its own process and takes minutes; these runs share one process and take seconds, so
     the app's per-IP budgets would carry over from one test into the next. Each starts empty, like a real run. */
  for (const ledger of [exchangeGateway.budget, exchangeGateway.historyDrip]) {
    (ledger as unknown as { mem: unknown[] }).mem = [];
    assert.equal(ledger.spent(), 0, `the ${ledger.name} budget could not be reset for the simulated run`);
  }
  _setBuilderPollDelaysForTests([0, 20, 40]);
  w.arbUsdc.set(address, 30_000_000n);
  w.arbEth.set(address, 10n ** 16n);
  o.setup?.(w);
  restore = installFake();
  const lines: string[] = [];
  const code = await runE2E({
    mode: 'live',
    configPath: cfgPath,
    confirm: o.confirm ? o.confirm(address) : address,
    only: (o.only as Parameters<typeof runE2E>[0]['only']) ?? null,
    keyHex: key,
    throwaway: false,
    registryOnly: false,
    reportDir: dir,
    backendOverride: BACKEND,
    log: (l) => lines.push(l),
    test: { socketFactory: fakeSocketFactory, historyGapMs: 25, pace: 0.01 },
  });
  const file = readdirSync(dir).find((f) => f.endsWith('-live.json'));
  const report = file ? JSON.parse(readFileSync(join(dir, file), 'utf8')) : null;
  const checks: Check[] = report?.checks ?? [];
  const byId = new Map(checks.map((c) => [c.id, c]));
  if (process.env.VS_SIM_DUMP) writeFileSync(process.env.VS_SIM_DUMP, [...lines, '', ...checks.map((c) => `${c.status.padEnd(8)} ${c.id}: ${c.detail}`)].join('\n'));
  return { code, lines, report, address, key, w, checks, byId };
}

const show = (r: { lines: string[]; checks: Check[] }): string =>
  [...r.lines.filter((l) => /FAIL|BLOCKED|REFUSED|refused|Error|error|STOPPED/.test(l)).slice(0, 60), ...r.checks.filter((c) => c.status === 'fail').map((c) => `FAIL ${c.id}: ${c.detail}`)].join('\n');

/** No check failed - each with what it saw. */
function noFailures(checks: Check[]): void {
  const failed = checks.filter((x) => x.status === 'fail');
  assert.deepEqual(failed.map((c) => `${c.id}: ${c.detail}`), []);
}

/** The guard refused nothing the app sent: every write was one the step expected. */
function noRefusals(report: { network: { refused: Array<{ what: string; blocked: string }> } }): void {
  assert.deepEqual(report.network.refused.map((r) => `${r.what}: ${r.blocked}`), []);
}

test('a whole live run against the fake: every step runs, every check passes (or is a finding), the money ends where the plan says', async () => {
  const r = await run(CONFIG);
  const { code, report, address, key, w, byId } = r;
  if (process.env.VS_SIM_VERBOSE) console.log(`${r.lines.join('\n')}\n--- fake writes ---\n${w.writes.join('\n')}`);
  noFailures(r.checks);
  noRefusals(report);
  assert.deepEqual(
    report.steps.map((s: { id: string; status: string }) => `${s.id}:${s.status}`),
    [
      'preflight:ok', 'deposit-external:ok', 'enable-trading:ok', 'transfers:ok', 'builder-tiers:skipped', 'orders-spot:ok', 'orders-perps:ok', 'refusals:ok',
      'spot-to-evm:ok', 'evm-to-spot:ok', 'withdraw-valuechain-self:ok', 'withdraw-valuechain-other:ok', 'withdraw-external:ok', 'extra-deposits:skipped',
      'extra-withdrawals:ok', 'key-lifecycle:ok', 'cleanup:ok', 'cross-check:ok', 'revoke-builder:skipped',
    ],
    show(r),
  );
  assert.equal(code, 0, 'exit code 0: every step ran, no check failed');
  // Every check of a step that ran has a verdict - none silently missing.
  const ran = new Set(report.steps.filter((s: { status: string }) => s.status === 'ok').map((s: { id: string }) => s.id));
  for (const c of r.checks) {
    if (!ran.has(c.step) || c.status !== 'not-run') continue;
    assert.fail(`${c.id} did not run: ${c.detail}`);
  }
  // The order types, one by one.
  for (const id of ['spot-limit-rest', 'spot-limit-change-price', 'spot-limit-change-size', 'spot-limit-cancel', 'spot-market-buy-by-funds', 'spot-market-buy-by-quantity', 'spot-market-sell', 'spot-gtx-rest', 'spot-gtx-cross', 'spot-ioc-no-cross', 'spot-ioc-cross', 'spot-schedule-cancel', 'spot-fees-commission', 'spot-fees-builder', 'spot-end-clean']) {
    assert.equal(byId.get(id)?.status, 'pass', `${id}: ${byId.get(id)?.detail}`);
  }
  for (const id of ['perps-position-stop-loss', 'perps-position-take-profit', 'perps-trigger-observed', 'perps-entry-with-tp-sl', 'refuse-trigger-type-not-mark']) assert.equal(byId.get(id)?.status, 'pass', `${id}: ${byId.get(id)?.detail}`);
  for (const id of ['perps-leverage-cross', 'perps-leverage-isolated', 'perps-market-by-quantity', 'perps-margin-add', 'perps-margin-remove', 'perps-reduce-only-close', 'perps-limit-rest', 'perps-limit-change-price', 'perps-limit-change-size', 'perps-limit-cancel', 'perps-gtx-rest', 'perps-gtx-cross', 'perps-ioc-no-cross', 'perps-ioc-cross', 'perps-cancel-all', 'perps-schedule-cancel-clear', 'perps-schedule-cancel-fires', 'perps-fees-commission', 'perps-fees-builder', 'perps-end-flat']) {
    assert.equal(byId.get(id)?.status, 'pass', `${id}: ${byId.get(id)?.detail}`);
  }
  assert.equal(byId.get('perps-market-by-funds')?.status, 'skipped');
  // FOK: the fake answers as SoDEX documents it ("not supported") - recorded as a finding, never a failure.
  for (const id of ['spot-fok-not-fillable', 'spot-fok-fillable', 'perps-fok-not-fillable', 'perps-fok-fillable']) assert.equal(byId.get(id)?.status, 'finding', `${id}: ${byId.get(id)?.detail}`);
  // Refusals: nothing moved.
  for (const id of ['refuse-perps-limit-below-min-notional', 'refuse-spot-limit-below-min-notional', 'refuse-perps-market-below-min-notional', 'refuse-spot-market-below-min-notional', 'refuse-quantity-rounds-to-zero', 'refuse-off-tick-price', 'refuse-off-step-quantity', 'refuse-reduce-only-without-position', 'refuse-spot-trigger', 'refuse-transfer-over-balance', 'refuse-withdraw-over-balance', 'refuse-withdraw-below-minimum', 'refuse-malformed-receiver']) {
    assert.equal(byId.get(id)?.status, 'pass', `${id}: ${byId.get(id)?.detail}`);
  }
  assert.equal(byId.get('refuse-unapproved-builder')?.status, 'pass', 'no builder in this run: an order naming one is rejected by SoDEX all the same');
  assert.equal(byId.get('refuse-builder-fee-above-approval')?.status, 'skipped');
  // The key's life.
  for (const id of ['key-enable', 'key-restore', 'key-still-registered', 'key-disable-revoke', 'key-old-key-rejected', 'key-reenable']) assert.equal(byId.get(id)?.status, 'pass', `${id}: ${byId.get(id)?.detail}`);
  assert.equal(w.signers.revocations.length, 2, 'two revocation signatures, one per engine');
  assert.ok(w.signers.revocations.every((s) => s === address), 'each recovers the wallet');
  assert.ok(w.refused.some((x) => /API key not found/.test(x)), 'the order signed with the revoked key was refused by the fake SoDEX');
  // Funds.
  for (const id of ['transfer-spot-to-perps', 'transfer-perps-to-spot', 'transfer-spot-to-evm-usdc', 'transfer-spot-to-evm-soso', 'transfer-evm-to-spot', 'withdraw-valuechain-self', 'withdraw-valuechain-other', 'deposit-usdc-arbitrum_eth', 'withdraw-usdc-arbitrum_eth', 'withdraw-eth-arbitrum_eth', 'cleanup-sweep']) {
    assert.equal(byId.get(id)?.status, 'pass', `${id}: ${byId.get(id)?.detail}`);
  }
  // The final reconciliation: exactly four history reads, each after the one before by the limiter's gap.
  for (const id of ['cross-orders-perps', 'cross-orders-spot', 'cross-fills-perps', 'cross-fills-spot', 'cross-stream-vs-rest', 'cross-end-state', 'builder-order-records']) {
    assert.ok(['pass', 'finding'].includes(byId.get(id)?.status ?? ''), `${id}: ${byId.get(id)?.status} ${byId.get(id)?.detail}`);
  }
  assert.equal(w.historyReads.length, 4, `history reads: ${w.historyReads.map((x) => x.path).join(', ')}`);
  for (let i = 1; i < w.historyReads.length; i++) assert.ok(w.historyReads[i]!.at - w.historyReads[i - 1]!.at >= 20, 'one history read per gap');
  assert.equal(report.historyReads.length, 4);
  // Where the money went.
  assert.equal(w.aid, 777, 'the first deposit opened the account');
  assert.equal(w.tok(VC_USDC, FRIEND), 1_000_000n, 'withdraw-valuechain-other: 1 USDC reached the other address');
  assert.equal(w.arbEth.get(address), 10n ** 16n + 10n ** 15n, 'extra-withdrawals: 0.0015 ETH - 0.0005 fee arrived on Arbitrum');
  assert.equal(w.open.length, 0, 'no open orders');
  assert.ok([...w.positions.values()].every((p) => p.size === '0'), 'flat');
  assert.equal(w.tok(VC_USDC, address), 0n, 'cleanup emptied the ValueChain wallet\'s USDC');
  assert.equal(w.spot.get(0) ?? 0n, 0n, 'cleanup withdrew all Spot USDC');
  assert.ok(w.vcNative > 0n, 'SOSO for gas stayed in the wallet');
  const arb = w.arbUsdc.get(address)!;
  // 30 funded - 25 deposited + (5 - 1) withdraw-external + the cleanup's sweep of what Spot held (less SOSO bought for gas, ETH withdrawn, fees).
  assert.ok(arb > 5_000_000n + 4_000_000n + 5_000_000n && arb < 30_000_000n, `Arbitrum USDC at the end: ${formatUnits(arb, 6)}`);
  assert.ok(w.writes.some((x) => x.startsWith(`arbitrum transfer 25000000 -> ${DEPOSIT_ADDR}`)), 'the deposit went to the verified address');
  // The report: complete, carries no key, and has what the guided launcher reads.
  const text = JSON.stringify(report);
  assert.ok(!text.toLowerCase().includes(key.slice(2).toLowerCase()), 'the report does not contain the key');
  assert.ok(Array.isArray(report.chains) && report.chains.some((c: { chain: string; coin: string; deposit: { status: string } }) => c.chain === 'ARBITRUM_ETH' && c.coin === 'USDC' && c.deposit.status === 'pass'));
  assert.ok(report.orderTypes.length >= 40 && report.orderTypes.every((o: { engine: string }) => o.engine === 'spot' || o.engine === 'perps'));
  assert.ok(report.feeTable.length >= 8, 'every fill is in the fee table');
  assert.ok(report.spend.costUsd > 0 && report.spend.costUsd < CONFIG.maxSpendUsd);
  // No builder is configured: no order names one, and the builders endpoint is never written to.
  assert.deepEqual(w.signers.approvals, []);
  assert.ok(w.orderBodies.filter((o) => !o.raw.includes('"builder":{"id":777')).every((o) => !o.raw.includes('builder')), 'no order of the app carries a builder');
});

// --- the builder fee and its tiers ---------------------------------------------------------------------------

const BUILDER_ID = 223169;
const TIERS = { builderId: BUILDER_ID, tiers: [{ minVolumeUsd: 0, perps: 20, spot: 20 }, { minVolumeUsd: 10, perps: 15, spot: 20 }], policy: 'default-fee' as const, ttl: 600_000 };
const BUILDER = { id: BUILDER_ID, address: BUILDER_ADDRESS, feePerps: 20, feeSpot: 20, maxFee: 20, revokeAtEnd: true, termsKeys: [TERMS_PUBLIC_KEY] };
const TIER_STEPS = ['deposit-external', 'enable-trading', 'builder-tiers', 'orders-spot', 'orders-perps', 'refusals', 'key-lifecycle', 'cross-check', 'revoke-builder'];

test('the fake signs with the shared test vector\'s key', () => {
  newWorld('0x0000000000000000000000000000000000000001');
  assert.equal(termsPublicKey(), TERMS_PUBLIC_KEY);
});

test('the builder fee and its tiers, end to end: default fee, verified volume, the lower fee, two cheating orders, the approval enforced, the income reconciled', async () => {
  const r = await run({ ...CONFIG, builder: BUILDER }, { only: TIER_STEPS, setup: (w) => {
    w.tiers = TIERS;
    w.builderId = BUILDER_ID;
  } });
  const { report, w, byId, address } = r;
  if (process.env.VS_SIM_VERBOSE) console.log(r.lines.join('\n'));
  noFailures(r.checks);
  noRefusals(report);
  assert.ok(report.steps.every((s: { status: string }) => s.status === 'ok' || s.status === 'skipped'), show(r));
  for (const id of [
    'builder-approval', 'builder-terms-signed', 'builder-terms-tamper-rejected', 'builder-fee-default', 'builder-volume-verified', 'builder-fee-lowered',
    'builder-underpaid-not-counted', 'builder-no-builder-not-counted', 'builder-no-builder-flagged', 'builder-terms-back-to-default',
    'builder-approval-enforced', 'builder-reapproved-orders-resume', 'builder-spot-buy-not-charged', 'builder-order-records', 'builder-income-matches', 'builder-revoke',
    'perps-fees-builder', 'spot-fees-builder', 'refuse-unapproved-builder', 'refuse-builder-fee-above-approval',
  ]) {
    assert.equal(byId.get(id)?.status, 'pass', `${id}: ${byId.get(id)?.status} - ${byId.get(id)?.detail}\n${show(r)}`);
  }
  // G6 against a fake that drops the builder on a replace: the app's constant (false) is right - a pass.
  assert.equal(byId.get('builder-replace-keeps-builder')?.status, 'pass', byId.get('builder-replace-keeps-builder')?.detail);
  // The app changes a resting limit order as cancel + new order (REPLACE_KEEPS_BUILDER is false); the new order carries the builder.
  assert.match(byId.get('spot-limit-change-price')!.detail, /cancel \+ new order/);
  // The fee went 20 -> 15 -> 20, and the orders followed it.
  const perps = w.orderBodies.filter((o) => o.engine === 'perps').map((o) => /"builder":\{"id":\d+,"fee":(\d+)\}/.exec(o.raw)?.[1] ?? 'none');
  assert.ok(perps.includes('20') && perps.includes('15'), `perps order fees: ${perps.join(',')}`);
  assert.ok(perps.includes('10') && perps.includes('none'), 'the two cheating orders went out as built: fee 10 and no builder');
  assert.deepEqual(w.termsAnswers.at(-1)?.fee, { perps: 20, spot: 20 }, 'back on the default fee');
  assert.ok(w.verified?.flags.includes('underpaid') && w.verified.flags.includes('tampered') && w.verified.flags.includes('no-builder'), `flags: ${w.verified?.flags.join(', ')}`);
  // The builder account received exactly what the fills paid.
  const paid = w.trades.reduce((s, t) => s + Number(t.builderFee), 0);
  assert.ok(Math.abs(Number(w.builderBalance.perps) + Number(w.builderBalance.spot) - 200 - paid) < 1e-6);
  // History: four reads in the cross-check, none while the run waited for the verifier.
  assert.equal(w.historyReads.length, 4);
  assert.deepEqual([...new Set(w.signers.approvals)], [address], 'every approval signature recovers the wallet');
  assert.ok(w.approvalBodies.some((b) => /"maxFeeRate":0}$/.test(b)), 'the revocation was signed');
});

test('a fake whose replace KEEPS the builder: the run reports the finding and the constant to flip', async () => {
  const r = await run({ ...CONFIG, builder: BUILDER }, { only: ['deposit-external', 'enable-trading', 'orders-spot'], setup: (w) => {
    w.tiers = TIERS;
    w.builderId = BUILDER_ID;
    w.replaceKeepsBuilder = true;
  } });
  const c = r.byId.get('builder-replace-keeps-builder');
  assert.equal(c?.status, 'finding', c?.detail);
  assert.match(c!.detail, /set REPLACE_KEEPS_BUILDER = true/);
});

test('live refuses to start - nothing is signed or sent - when the backend and the on-chain registry disagree on the deposit address', async () => {
  const { code, lines, w } = await run(CONFIG, { setup: (x) => (x.registryAddress = '0x000000000000000000000000000000000000dead') });
  assert.equal(code, 2);
  // The app cross-checks the address against the registry itself now (exchange/deposits.ts), so it
  // withholds the address before the runner's own independent comparison even runs.
  assert.ok(lines.some((l) => /disagree|not this coin's registered address/.test(l)), 'says why');
  assert.deepEqual(w.writes, [], 'no write of any kind reached the fake');
});

test('live refuses without --confirm equal to the wallet address, or without acknowledgeRealFunds', async () => {
  const wrong = await run(CONFIG, { confirm: () => '0x4b363bfcd961eca3aa723151a7ccdab76b869bfd' });
  assert.equal(wrong.code, 2);
  assert.ok(wrong.lines.some((l) => /REFUSED: --confirm/.test(l)));
  assert.deepEqual(wrong.w.writes, []);
  const noAck = await run({ ...CONFIG, acknowledgeRealFunds: false });
  assert.equal(noAck.code, 2);
  assert.ok(noAck.lines.some((l) => /acknowledgeRealFunds/.test(l)));
  assert.deepEqual(noAck.w.writes, []);
});
