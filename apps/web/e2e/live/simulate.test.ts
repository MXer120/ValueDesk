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
import { scriptedOwnerInput, type OwnerInput } from './ownerInput';
import { SAMPLE_ADDRESS } from './receivers';
import { BACKEND, BUILDER_ADDRESS, DEPOSIT_ADDR, FRIEND, OWNER_ADDRESS, TERMS_PUBLIC_KEY, VC_USDC, depositAddressOf, fakeSocketFactory, installFake, newWorld, termsPublicKey, type World } from './sim/world';

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

async function run(
  config: object,
  o: {
    confirm?: (address: string) => string;
    setup?: (w: World) => void;
    only?: string[];
    profile?: Parameters<typeof runE2E>[0]['profile'];
    mode?: 'plan' | 'live';
    onManualDeposit?: (w: World, d: { coin: string; chain: string; address: string; amount: string }) => void;
    ownerInput?: OwnerInput;
  } = {},
) {
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
  const mode = o.mode ?? 'live';
  const code = await runE2E({
    mode,
    configPath: cfgPath,
    confirm: mode === 'plan' ? null : o.confirm ? o.confirm(address) : address,
    only: (o.only as Parameters<typeof runE2E>[0]['only']) ?? null,
    ...(o.profile ? { profile: o.profile } : {}),
    keyHex: key,
    throwaway: false,
    registryOnly: false,
    reportDir: dir,
    backendOverride: BACKEND,
    log: (l) => lines.push(l),
    ...(o.ownerInput ? { ownerInput: o.ownerInput } : {}),
    test: { socketFactory: fakeSocketFactory, historyGapMs: 25, pace: 0.01, ...(o.onManualDeposit ? { onManualDeposit: (d) => o.onManualDeposit!(w, d) } : {}) },
  });
  const file = readdirSync(dir).find((f) => f.endsWith(`-${mode}.json`));
  const report = file ? JSON.parse(readFileSync(join(dir, file), 'utf8')) : null;
  const summaryFile = file ? file.replace(/\.json$/, '.summary.md') : null;
  const summary = summaryFile && readdirSync(dir).includes(summaryFile) ? readFileSync(join(dir, summaryFile), 'utf8') : null;
  const checks: Check[] = report?.checks ?? [];
  const byId = new Map(checks.map((c) => [c.id, c]));
  if (process.env.VS_SIM_DUMP) writeFileSync(process.env.VS_SIM_DUMP, [...lines, '', ...checks.map((c) => `${c.status.padEnd(8)} ${c.id}: ${c.detail}`)].join('\n'));
  return { code, lines, report, summary, address, key, w, checks, byId };
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
  // The run in words, next to the report: the builder fee first, the coins last; no key in it either.
  assert.ok(r.summary, 'a summary.md next to the report');
  assert.match(r.summary!, /^# Live E2E run - LIVE - profile core/);
  assert.ok(r.summary!.indexOf('## Builder fee and the fee of every fill') < r.summary!.indexOf('## Chains'));
  assert.match(r.summary!, /### Fee of every fill\n\n\| order \| market \|/);
  assert.match(r.summary!, /## Where every coin is\n\n```/);
  assert.ok(!r.summary!.toLowerCase().includes(key.slice(2).toLowerCase()));
  assert.ok(r.lines.at(-1)!.includes('report'), 'the last line is still the report');
  assert.ok(r.lines.some((l) => /summary {11}.*\.summary\.md$/.test(l)));
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
  // G6 against a fake that keeps the builder on a replace (as SoDEX does, proven live): the app's constant (true) is right - a pass.
  assert.equal(byId.get('builder-replace-keeps-builder')?.status, 'pass', byId.get('builder-replace-keeps-builder')?.detail);
  // The app changes a resting limit order with SoDEX's replace (REPLACE_KEEPS_BUILDER is true); the replacement keeps the builder.
  assert.match(byId.get('spot-limit-change-price')!.detail, /with SoDEX's replace request/);
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

test('a fake whose replace DROPS the builder: the run reports the finding and the constant to flip', async () => {
  const r = await run({ ...CONFIG, builder: BUILDER }, { only: ['deposit-external', 'enable-trading', 'orders-spot'], setup: (w) => {
    w.tiers = TIERS;
    w.builderId = BUILDER_ID;
    w.replaceKeepsBuilder = false;
  } });
  const c = r.byId.get('builder-replace-keeps-builder');
  assert.equal(c?.status, 'finding', c?.detail);
  assert.match(c!.detail, /DROPPED/);
  assert.match(c!.detail, /set REPLACE_KEEPS_BUILDER = false/);
});

/** A resting perps BTC-USD buy far below the market, as a stopped earlier run leaves one. */
function leftover(w: World, clOrdID: string): void {
  const now = Date.now();
  w.orders.push({
    engine: 'perps', orderID: w.nextId++, clOrdID, symbolID: 1, symbol: 'BTC-USD', side: 'BUY', type: 'LIMIT', timeInForce: 'GTC',
    price: '50000', origQty: '0.0002', funds: null, executedQty: '0', executedValue: '0', status: 'NEW', builder: null, reduceOnly: false,
    stopPrice: null, stopType: null, triggerType: null, modifier: 1, primaryOrderID: null, createdAt: now, updatedAt: now, locked: 0n,
    signer: '0x00000000000000000000000000000000000000aa', keyName: 'an earlier run',
  });
}

test('a resumed run: the orders a stopped run left on the market (placed by the app) are cancelled first, and the step runs', async () => {
  const r = await run(CONFIG, { only: ['deposit-external', 'enable-trading', 'orders-perps'], setup: (w) => ['vs-old-1', 'vs-old-2', 'rp-old-3'].forEach((id) => leftover(w, id)) });
  const step = r.report.steps.find((s: { id: string }) => s.id === 'orders-perps');
  assert.equal(step?.status, 'ok', show(r));
  assert.ok(r.lines.some((l) => /an earlier run left 3 open order\(s\) on perps BTC-USD - cleared through the app/.test(l)), show(r));
  const old = r.w.orders.filter((o) => /-old-/.test(o.clOrdID));
  assert.equal(old.length, 3);
  assert.ok(old.every((o) => o.status !== 'NEW' && o.status !== 'PARTIALLY_FILLED'), old.map((o) => `${o.clOrdID} ${o.status}`).join(', '));
});

test('an open order the app did not place stops the step - it is the owner\'s, nothing of it is cancelled', async () => {
  const r = await run(CONFIG, { only: ['deposit-external', 'enable-trading', 'orders-perps'], setup: (w) => leftover(w, 'web-123') });
  const step = r.report.steps.find((s: { id: string }) => s.id === 'orders-perps');
  assert.notEqual(step?.status, 'ok');
  assert.ok(r.lines.some((l) => /that Valuescan did not place \(web-123\)/.test(l)), r.lines.slice(-30).join('\n'));
  assert.equal(r.w.orders.find((o) => o.clOrdID === 'web-123')!.status, 'NEW');
});

test('a resumed run whose steps need more in Spot than the account holds: the run tops Spot up from the wallet first, then runs', async () => {
  const r = await run({ ...CONFIG, maxSpendUsd: 60, allowExistingAccount: true }, {
    profile: 'evm-tour',
    only: ['enable-trading', 'evm-tour'],
    setup: (w) => {
      // An account an earlier run opened, with 4 USDC left in Spot - far below the tour's working capital.
      w.aid = 777;
      w.addSpot(0, 4_000_000n);
      w.arbUsdc.set(w.owner, 100_000_000n);
    },
  });
  const steps = r.report.steps.map((s: { id: string; status: string }) => `${s.id} ${s.status}`);
  assert.ok(r.report.selectedSteps.includes('deposit-external'), `selected: ${r.report.selectedSteps}`);
  assert.equal(r.report.steps.find((s: { id: string }) => s.id === 'deposit-external')?.status, 'ok', `${steps.join(', ')}\n${show(r)}`);
  assert.equal(r.report.steps.find((s: { id: string }) => s.id === 'evm-tour')?.status, 'ok', `${steps.join(', ')}\n${show(r)}`);
  const note = r.lines.find((l) => /deposit-external added as a top-up of (\d+) USDC/.test(l));
  assert.ok(note, 'the top-up is said, with its amount');
  const amount = Number(/top-up of (\d+) USDC/.exec(note!)![1]);
  assert.ok(amount >= 5 && amount <= 100, `top-up ${amount}`);
});

test('a resumed run short in Spot with too little USDC in the wallet for the top-up: refused before anything moves, saying what to send', async () => {
  const r = await run({ ...CONFIG, maxSpendUsd: 60, allowExistingAccount: true }, {
    profile: 'evm-tour',
    only: ['enable-trading', 'evm-tour'],
    setup: (w) => {
      w.aid = 777;
      w.addSpot(0, 4_000_000n);
      w.arbUsdc.set(w.owner, 1_000_000n);
    },
  });
  assert.equal(r.code, 2);
  assert.ok(r.lines.some((l) => /fund the wallet: \d+(\.\d+)? USDC on Arbitrum One/.test(l)), r.lines.slice(-25).join('\n'));
  assert.equal(r.w.writes.length, 0, 'nothing was sent');
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

// --- the wider profiles -------------------------------------------------------------------------------------

const tourChecks = (r: { checks: Check[] }) => r.checks.filter((c) => c.step === 'evm-tour');

test('evm-tour: every EVM chain the runner signs on, out and back - the native coin by a DIRECT transfer to the verified address, USDC through the app', async () => {
  const r = await run({ ...CONFIG, maxSpendUsd: 60 }, {
    profile: 'evm-tour',
    only: ['deposit-external', 'enable-trading', 'evm-tour'],
    setup: (w) => {
      w.arbUsdc.set(w.owner, 100_000_000n);
      w.nativeOf(137).set(w.owner, 10n ** 18n); // POL for the USDC deposit back on Polygon (SoDEX lists no POL route)
    },
  });
  const { report, w, byId } = r;
  if (process.env.VS_SIM_VERBOSE) console.log(r.lines.join('\n'));
  noFailures(r.checks);
  noRefusals(report);
  assert.equal(r.code, 0, show(r));
  const tour = tourChecks(r);
  // Arbitrum (ETH, USDC), Base (ETH, USDC), Robinhood (ETH), BNB Chain (BNB, USDC), Polygon (USDC), Arc (USDC as its native coin), Avalanche (AVAX), HyperEVM (HYPE): 11 legs, 2 checks each.
  assert.equal(tour.length, 22, tour.map((c) => c.id).join(', '));
  for (const c of tour) assert.equal(c.status, 'pass', `${c.id}: ${c.status} ${c.detail}`);
  // Each native coin went back by a plain transfer to that chain's verified deposit address - and only there.
  const natives = w.writes.filter((x) => / native transfer /.test(x));
  assert.equal(natives.length, 7, natives.join('\n'));
  for (const [tag, key] of [['arbitrum', 'ARBITRUM_ETH'], ['base_eth', 'BASE_ETH'], ['robinhood_eth', 'ROBINHOOD_ETH'], ['bsc_bnb', 'BSC_BNB'], ['arc', 'ARC'], ['avaxc', 'AVAXC'], ['hyperevm_hype', 'HYPEREVM_HYPE']] as const) {
    assert.ok(natives.some((x) => x.startsWith(`${tag} native transfer `) && x.endsWith(`-> ${depositAddressOf(key).toLowerCase()}`)), `${key}: ${natives.join('; ')}`);
  }
  // The guard saw each as its own kind, armed with that exact transfer.
  const sent = report.network.requests.filter((q: { what: string }) => q.what.startsWith('native-transfer: DIRECT'));
  assert.equal(sent.length, 7);
  // USDC came back through the app on four chains (Arbitrum, Base, BNB Chain - 18 decimals there - and Polygon).
  for (const tag of ['arbitrum', 'base_eth', 'bsc_bnb', 'matic']) assert.ok(w.writes.some((x) => x.startsWith(`${tag} transfer `) && x.endsWith(`-> ${depositAddressOf(tag === 'arbitrum' ? 'ARBITRUM_ETH' : tag.toUpperCase()).toLowerCase()}`)), `${tag} USDC back`);
  // Arc: 6.05 USDC out, 5 USDC back (18 decimals on the chain, 6 on SoDEX).
  assert.match(byId.get(tour.find((c) => c.id.startsWith('deposit-usdc-arc'))!.id)!.detail, /credited 5 USDC/);
  // What was bought for the tour was sold back after the last chain that needed it.
  const sells = w.orders.filter((o) => o.engine === 'spot' && o.side === 'SELL' && o.status === 'FILLED').map((o) => o.symbol);
  for (const m of ['vETH_vUSDC', 'vAVAX_vUSDC']) assert.ok(sells.includes(m), `sold back on ${m}: ${sells.join(', ')}`);
  // What is below the market's minimum stays in Spot, and the run says so.
  for (const c of ['BNB', 'HYPE']) assert.ok(r.lines.some((l) => new RegExp(`${c}: [0-9.]+ left in Spot`).test(l)), `${c} left in Spot`);
  assert.equal(report.profile, 'evm-tour');
  assert.ok(report.chains.some((c: { chain: string; coin: string; deposit: { status: string } }) => c.chain === 'AVAXC' && c.coin === 'AVAX' && c.deposit.status === 'pass'));
});

test('all-chains: withdrawals to your own addresses on the chains the runner cannot sign on, and a deposit you send by hand', async () => {
  let manual: { coin: string; chain: string; address: string; amount: string } | null = null;
  const r = await run(
    {
      ...CONFIG,
      maxSpendUsd: 200,
      receivers: { valuechain: FRIEND, sol: OWNER_ADDRESS.solana, btc: OWNER_ADDRESS.bitcoin, doge: OWNER_ADDRESS.dogecoin, xrp: { address: OWNER_ADDRESS.xrp, noMemo: true } },
      manualDeposits: [{ coin: 'SOL', chain: 'SOL', amount: '0.03' }],
    },
    {
      profile: 'all-chains',
      only: ['deposit-external', 'enable-trading', 'chain-withdrawals', 'manual-deposits'],
      setup: (w) => w.arbUsdc.set(w.owner, 200_000_000n),
      onManualDeposit: (w, d) => {
        manual = d;
        setTimeout(() => w.addSpot(8, 30_000_000n), 20); // the owner's 0.03 SOL arrives
      },
    },
  );
  const { report, w, byId } = r;
  if (process.env.VS_SIM_VERBOSE) console.log(r.lines.join('\n'));
  noFailures(r.checks);
  noRefusals(report);
  assert.equal(r.code, 0, show(r));
  for (const id of ['withdraw-sol-sol', 'withdraw-usdc-sol', 'withdraw-xrp-xrp', 'withdraw-btc-btc', 'manual-deposit-sol-sol']) assert.equal(byId.get(id)?.status, 'pass', `${id}: ${byId.get(id)?.detail}`);
  assert.match(byId.get('withdraw-doge-doge')!.detail, /not testable from USDC alone: .*no DOGE\/USDC spot market/);
  assert.equal(byId.get('withdraw-doge-doge')!.status, 'skipped');
  assert.equal(byId.get('withdraw-zec-zec')?.status, 'skipped');
  // Paid out to the owner's own addresses: never less than what could be sent straight back.
  const paid = (coin: string) => w.offchain.find((x) => x.coin === coin);
  assert.equal(paid('SOL')?.receiver, OWNER_ADDRESS.solana);
  // SOL is sent back by hand: what arrives covers the 0.03 deposit, the wallet's fee (0.00001) and Solana's rent (0.00089088).
  assert.equal(paid('SOL')?.amount, 30_901_000n, '0.042901 SOL withdrawn, 0.030901 paid out');
  assert.equal(paid('XRP')?.receiver, OWNER_ADDRESS.xrp, 'no memo: the address alone');
  assert.equal(paid('XRP')?.memo, '');
  assert.equal(paid('BTC')?.amount, 50_000n - 6_000n, 'BTC: its 0.0005 minimum, less the fee');
  // The manual deposit: shown only once the app's Deposit sheet and the registry agreed on it.
  assert.deepEqual(manual, { coin: 'SOL', chain: 'SOL', address: depositAddressOf('SOL'), amount: '0.03' });
  const text = r.lines.join('\n');
  assert.match(text, /SEND BY HAND \(optional\) - 1 of 1: SOL on Solana/);
  assert.match(text, /amount \.+ 0\.03 SOL {3}\(SoDEX credits nothing below its deposit minimum of 0\.03 SOL/);
  assert.match(text, /network fee \. your wallet adds it ON TOP/);
});

test('the full test: round trips to your own wallet - a deposit you skip, one you leave out, one sent first where SoDEX has no market - and everything sold back', async () => {
  const sent: string[] = [];
  const owner = scriptedOwnerInput({ 'XRP|XRP': 's' });
  const r = await run(
    {
      ...CONFIG,
      maxSpendUsd: 250,
      receivers: { valuechain: FRIEND, sol: OWNER_ADDRESS.solana, btc: OWNER_ADDRESS.bitcoin, doge: OWNER_ADDRESS.dogecoin, xrp: { address: OWNER_ADDRESS.xrp, noMemo: true } },
      manualDeposits: [
        { coin: 'BTC', chain: 'BTC', amount: 'auto' },
        { coin: 'DOGE', chain: 'DOGE', amount: 'auto' },
        { coin: 'USDC', chain: 'SOL', amount: 'auto', skip: true },
        { coin: 'SOL', chain: 'SOL', amount: 'auto' },
        { coin: 'XRP', chain: 'XRP', amount: 'auto' },
      ],
    },
    {
      profile: 'all-chains',
      only: ['deposit-external', 'enable-trading', 'chain-withdrawals', 'manual-deposits'],
      setup: (w) => w.arbUsdc.set(w.owner, 250_000_000n),
      ownerInput: owner,
      onManualDeposit: (w, d) => {
        sent.push(`${d.coin} ${d.amount}`);
        const units: Record<string, [number, bigint]> = { BTC: [10, 41_000n], DOGE: [11, 4_200_000_000n], SOL: [8, 30_000_000n] };
        const u = units[d.coin];
        if (u) setTimeout(() => w.addSpot(u[0], u[1]), 20); // the owner sends it; XRP they skip
      },
    },
  );
  const { report, w, byId } = r;
  if (process.env.VS_SIM_VERBOSE) console.log(r.lines.join('\n'));
  noFailures(r.checks);
  noRefusals(report);
  assert.equal(r.code, 0, show(r));
  // Asked for, each at least SoDEX's deposit minimum - the wallet's fee on top.
  assert.deepEqual(sent, ['BTC 0.00041', 'DOGE 42', 'SOL 0.03', 'XRP 4']);
  for (const id of ['withdraw-btc-btc', 'withdraw-sol-sol', 'withdraw-xrp-xrp', 'withdraw-usdc-sol', 'manual-deposit-btc-btc', 'manual-deposit-sol-sol', 'manual-deposit-doge-doge']) assert.equal(byId.get(id)?.status, 'pass', `${id}: ${byId.get(id)?.detail}`);
  assert.equal(byId.get('manual-deposit-usdc-sol')?.status, 'skipped');
  assert.match(byId.get('manual-deposit-usdc-sol')!.detail, /^skipped \(owner\): you left this hand-sent deposit out/);
  assert.equal(byId.get('manual-deposit-xrp-xrp')?.status, 'skipped');
  assert.match(byId.get('manual-deposit-xrp-xrp')!.detail, /^skipped \(owner\): you typed "s"/);
  assert.deepEqual(owner.given, ['XRP|XRP: s']);
  // DOGE has no spot market: deposit first, then the run withdrew it back to your address.
  assert.equal(byId.get('withdraw-doge-doge')?.status, 'pass', byId.get('withdraw-doge-doge')?.detail);
  const paid = (coin: string) => w.offchain.find((x) => x.coin === coin);
  assert.equal(paid('DOGE')?.receiver, OWNER_ADDRESS.dogecoin);
  assert.equal(paid('DOGE')?.amount, 3_000_000_000n, '42 DOGE back, 30 arrive after the 12 DOGE fee');
  // XRP: sized so that the 4 XRP deposit back, the wallet's fee and the 1 XRP reserve all come out of what arrived.
  assert.equal(paid('XRP')?.amount, 5_000_020n);
  // What came back was sold back to USDC (BTC is worth enough; the SOL left over is below the market's minimum).
  const sells = w.orders.filter((o) => o.engine === 'spot' && o.side === 'SELL' && o.status === 'FILLED').map((o) => o.symbol);
  assert.ok(sells.includes('vBTC_vUSDC'), `sold back: ${sells.join(', ')}`);
  assert.ok(r.lines.some((l) => /SOL: [0-9.]+ left in Spot/.test(l)), 'what is below the minimum stays, and the run says so');
  // The summary and the report say "skipped (owner)".
  assert.match(r.summary!, /skipped \(owner\)/);
  const hand = report.plan.handDeposits as Array<{ coin: string; state: string; sendBack: string; depositMin: string }>;
  for (const h of hand) assert.ok(Number(h.sendBack) >= Number(h.depositMin), `${h.coin}: ${h.sendBack} >= ${h.depositMin}`);
  assert.equal(hand.find((h) => h.coin === 'USDC')?.state, 'skipped');
});

test('evm-tour without POL on Polygon: the Polygon withdrawal is tested, the deposit back is "not run: no POL for gas" - and nothing asks for POL', async () => {
  const p = await run({ ...CONFIG, maxSpendUsd: 60 }, { profile: 'evm-tour', mode: 'plan', setup: (w) => w.arbUsdc.set(w.owner, 0n) });
  assert.ok(!p.report.plan.checklist.some((l: string) => /POL/.test(l)), p.report.plan.checklist.join('\n'));
  assert.ok(p.report.plan.budget.leftOnChains.some((l: string) => /Polygon: ~1\.00 USDC stays in the test wallet/.test(l)), JSON.stringify(p.report.plan.budget));
  const r = await run({ ...CONFIG, maxSpendUsd: 60 }, { profile: 'evm-tour', only: ['deposit-external', 'enable-trading', 'evm-tour'], setup: (w) => w.arbUsdc.set(w.owner, 100_000_000n) });
  noFailures(r.checks);
  noRefusals(r.report);
  assert.equal(r.code, 0, show(r));
  const wd = r.checks.find((c) => c.id.startsWith('withdraw-usdc-matic'))!;
  const dp = r.checks.find((c) => c.id.startsWith('deposit-usdc-matic'))!;
  assert.equal(wd.status, 'pass', wd.detail);
  assert.equal(dp.status, 'not-run');
  assert.match(dp.detail, /^not run: no POL for gas on Polygon/);
  assert.ok(!r.w.writes.some((x) => x.startsWith('matic transfer ')), 'nothing was sent from Polygon');
});

test('builder-rerun: refused on a wallet with no account; on the funded test wallet it runs the fee test again', async () => {
  const fresh = await run({ ...CONFIG, builder: BUILDER }, { profile: 'builder-rerun' });
  assert.equal(fresh.code, 2);
  assert.ok(fresh.lines.some((l) => /builder-rerun runs on the funded test wallet/.test(l)), fresh.lines.filter((l) => /PROBLEM|- /.test(l)).join('\n'));
  assert.deepEqual(fresh.w.writes, []);
  const r = await run({ ...CONFIG, builder: BUILDER }, {
    profile: 'builder-rerun',
    setup: (w) => {
      w.aid = 777;
      w.spot.set(0, 40_000_000n);
      w.tiers = TIERS;
      w.builderId = BUILDER_ID;
    },
  });
  noFailures(r.checks);
  noRefusals(r.report);
  assert.equal(r.code, 0, show(r));
  assert.deepEqual(r.report.selectedSteps, ['enable-trading', 'builder-tiers', 'cross-check', 'revoke-builder']);
  for (const id of ['builder-approval', 'builder-fee-default', 'builder-volume-verified', 'builder-fee-lowered', 'builder-underpaid-not-counted', 'builder-terms-back-to-default', 'builder-approval-enforced', 'builder-revoke']) {
    assert.equal(r.byId.get(id)?.status, 'pass', `${id}: ${r.byId.get(id)?.detail}`);
  }
});

test('plan --profile all-chains: every route checked read-only, what cannot be tested listed with why, the receivers asked for, the working capital funded - nothing written', async () => {
  const r = await run({ ...CONFIG, maxSpendUsd: 8 }, { profile: 'all-chains', mode: 'plan' });
  const { report, w, byId } = r;
  assert.equal(report.mode, 'plan');
  assert.deepEqual(w.writes, [], 'plan mode wrote nothing');
  assert.equal(byId.get('route-usdc-arbitrum_eth')?.status, 'pass', byId.get('route-usdc-arbitrum_eth')?.detail);
  assert.match(byId.get('route-usdc-arbitrum_eth')!.detail, new RegExp(`deposit address ${DEPOSIT_ADDR.slice(0, 8)}`));
  assert.equal(byId.get('route-zec-zec')?.status, 'skipped');
  assert.equal(byId.get('route-bnb-bsc_bnb')?.status, 'finding', 'BNB: the withdrawal minimum does not cover the fee');
  assert.equal(byId.get('route-xrp-xrp')?.status, 'pass', byId.get('route-xrp-xrp')?.detail);
  assert.ok(report.plan.routeChecks.length >= 15);
  const nt = report.plan.notTestable as Array<{ what: string; why: string }>;
  assert.ok(nt.some((n) => n.what === 'BTC on Bitcoin' && /manualDeposits/.test(n.why) && /receivers\.btc/.test(n.why)), JSON.stringify(nt));
  const rx = report.plan.receiversNeeded as Array<{ name: string; memo: boolean; set: boolean }>;
  for (const n of ['sol', 'btc', 'xrp', 'doge']) assert.ok(rx.some((x) => x.name === n && !x.set), `receivers.${n} asked for`);
  assert.equal(rx.find((x) => x.name === 'xrp')?.memo, true);
  assert.ok(report.plan.suggestedMaxSpendUsd > 8);
  assert.ok(report.plan.problems.some((p: string) => /above maxSpendUsd/.test(p)));
  assert.ok(report.plan.profileNotes.every((n: string) => /deposit\.amount/.test(n)));
  assert.equal(report.plan.steps.find((s: { id: string }) => s.id === 'chain-withdrawals')?.skip, 'no route can run - set your own addresses in receivers (receivers.sol, receivers.btc, ...)');
  // The summary says what the BNB and Base ETH minimums mean for a user, at the top of the findings.
  assert.match(r.summary!, /### Withdrawal minimums that do not cover the fee[\s\S]*\*\*BNB to BNB Smart Chain\*\*: minimum 0\.0005 BNB, fee 0\.002 BNB/);
  assert.match(r.summary!, /\*\*ETH to Base\*\*: minimum 0\.0005 ETH, fee 0\.0005 ETH\. A user who withdraws exactly the minimum would receive nothing/);
});

test('never toward a SoDEX deposit address below its deposit minimum: a withdrawal to the wallet\'s own deposit address that would arrive below it - live refuses to start, nothing is signed or sent', async () => {
  const r = await run({
    ...CONFIG,
    maxSpendUsd: 60,
    // A receiver mistyped as the wallet's OWN Solana deposit address, and 0.02 SOL: 0.008 would arrive, SoDEX credits nothing below 0.03.
    receivers: { valuechain: FRIEND, sol: depositAddressOf('SOL') },
    extraWithdrawals: [{ coin: 'SOL', chain: 'SOL', amount: '0.02', receiver: 'sol', buyIfMissing: true }],
  });
  assert.equal(r.code, 2);
  assert.ok(r.report.plan.problems.some((p: string) => /own SoDEX deposit address on Solana, and 0\.008 SOL would arrive - below SoDEX's deposit minimum 0\.03/.test(p)), r.report.plan.problems.join('\n'));
  assert.deepEqual(r.w.writes, [], 'no write of any kind reached the fake');
});
