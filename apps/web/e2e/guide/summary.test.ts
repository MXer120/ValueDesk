/**
 * The one summary: what it leads with, and that nothing secret can be in it.
 *   npx tsx --test e2e/guide/summary.test.ts        (from apps/web)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generatePrivateKey } from 'viem/accounts';
import { TX_DEPOSIT, TX_WITHDRAW, WALLET, liveReport, planReport } from './fixtures';
import { readLiveReport, readPlanReport } from './runner';
import { buildSummary, overall, type SummaryInput } from './summary';
import { skippedStage, type Item, type StageResult } from './types';

const stage = (id: StageResult['id'], status: StageResult['status'], items: Item[] = [], reason?: string): StageResult => ({ id, title: `stage ${id}`, status, startedAt: '2026-10-02T21:00:00.000Z', ms: 61_000, items, notes: [], ...(reason ? { reason } : {}) });
const row = (id: string, status: Item['status'], extra: Partial<Item> = {}): Item => ({ id, title: id, status, ms: 1200, ...extra });

function input(o: Partial<SummaryInput> = {}): SummaryInput {
  return {
    startedAt: '2026-10-02T21:00:00.000Z',
    finishedAt: '2026-10-02T21:20:00.000Z',
    mode: { stages: ['A', 'B'], planOnly: false, throwawayKey: false, yes: true },
    stages: [stage('A', 'PASS', [row('web-typecheck', 'PASS'), row('contracts-forge', 'SKIPPED', { detail: 'forge is not installed' })]), stage('B', 'PASS', [row('gw-rest', 'PASS', { group: 'Exchange hosts' })])],
    stopped: null,
    wallet: null,
    profile: null,
    plan: null,
    live: null,
    planReport: null,
    liveReport: null,
    feeTable: null,
    envLines: [],
    next: [],
    files: { summaryMd: 'C:\\r\\x-all.summary.md', summaryJson: 'C:\\r\\x-all.json', logsDir: 'C:\\r\\x-all-logs', runnerReport: null, runnerSummary: null },
    key: null,
    ...o,
  };
}

test('the overall result: a failure beats everything; a stop beats a pass; skipped stages make it incomplete', () => {
  assert.equal(overall({ stages: [stage('A', 'PASS'), stage('B', 'PASS')], stopped: null }), 'PASS');
  assert.equal(overall({ stages: [stage('A', 'PASS'), stage('B', 'FAIL')], stopped: 'stopped with Ctrl+C' }), 'FAIL');
  assert.equal(overall({ stages: [stage('A', 'PASS'), skippedStage('B', 'x')], stopped: 'stopped with Ctrl+C' }), 'STOPPED');
  assert.equal(overall({ stages: [stage('A', 'PASS'), skippedStage('D', 'not funded')], stopped: null }), 'INCOMPLETE');
  assert.equal(overall({ stages: [], stopped: null }), 'INCOMPLETE');
});

test('stages A and B only: one line says the live run was not part of it; every row is listed; plain ASCII', () => {
  const s = buildSummary(input({ next: ['Not part of this run: stage C, D.'] }));
  const screen = s.screen.join('\n');
  assert.match(screen, /^RESULT: PASS/);
  assert.match(screen, /1\. BUILDER FEE, CHAINS, ORDER TYPES, COST\n {3}not run: the live money run \(stage D\) was not part of this run/);
  assert.match(screen, /2\. EVERY STAGE, EVERY STEP/);
  assert.match(screen, /PASS {4,}web-typecheck/);
  assert.match(screen, /SKIPPED {1,}contracts-forge/);
  // Why a row was skipped is said on the screen too, under the table.
  assert.match(screen, /\n {6}SKIPPED contracts-forge: forge is not installed\n/);
  // A group is a line of its own on the screen, and part of every row in the file.
  assert.match(screen, /\[Exchange hosts\]\n {3}PASS {4,}gw-rest/);
  assert.match(s.markdown, /\| PASS \| Exchange hosts: gw-rest \|/);
  assert.match(screen, /3\. WHAT TO DO NEXT\n {3}1\. Not part of this run: stage C, D\./);
  assert.ok(!/WHERE EVERY COIN IS/.test(screen), 'no funds section for a run that could not move any');
  assert.ok(/^[\x20-\x7E\n]*$/.test(`${screen}\n${s.markdown}`), 'ASCII only');
  assert.match(s.markdown, /^# ValueDesk guided test run - PASS\n/);
  assert.match(s.markdown, /\| SKIPPED \| contracts-forge \| 1\.2 s \| - \| forge is not installed \|/);
  assert.equal(s.json.result, 'PASS');
  assert.equal((s.json.stages as unknown[]).length, 2);
});

test('a live run: the summary LEADS with the builder fee checks, then findings, chains, orders, cost', () => {
  const checks = [
    { id: 'builder-fee-default', status: 'pass', detail: 'order 77 carries feeRate 20; its fill paid 0.00236 = 2 bp of 11.81' },
    { id: 'builder-volume-verified', status: 'pass', detail: 'the server counts 12.4 USDC from SoDEX\'s order records' },
    { id: 'builder-fee-lowered', status: 'pass', detail: 'the next order carries 15; its fill paid 1.5 bp' },
    { id: 'builder-underpaid-not-counted', status: 'pass', detail: 'volume unchanged, flag underpaid raised' },
    { id: 'builder-no-builder-not-counted', status: 'pass', detail: 'volume unchanged' },
    { id: 'builder-modify-keeps-builder', status: 'finding', title: 'A modified order still names the builder', detail: 'yes: the record still shows builder 12345' },
    { id: 'builder-replace-keeps-builder', status: 'finding', title: 'A replaced order still names the builder', detail: 'no: SoDEX drops the builder on replace' },
    { id: 'builder-income-matches', status: 'fail', detail: 'the builder balance rose by 0.0031, the fills paid 0.0047' },
    { id: 'key-lifecycle', title: 'the trading key expires', status: 'pass' },
  ];
  const report = liveReport({ checks });
  const s = buildSummary(
    input({
      mode: { stages: ['A', 'B', 'C', 'D'], planOnly: false, throwawayKey: false, yes: false },
      stages: [stage('A', 'PASS'), stage('B', 'PASS'), stage('C', 'PASS'), stage('D', 'FAIL', [row('step-deposit-external', 'PASS', { costUsd: 1.01, txs: [{ chain: 'ARBITRUM_ETH', hash: TX_DEPOSIT, explorer: `https://arbiscan.io/tx/${TX_DEPOSIT}` }] })], '1 check(s) of the live run failed')],
      wallet: WALLET,
      profile: 'core',
      plan: readPlanReport(planReport({ funded: true })),
      live: readLiveReport(report),
      planReport: planReport({ funded: true }),
      liveReport: report,
      feeTable: ['| what | usd |', '|---|---|', '| activation | 1.00 |'],
      envLines: ['VITE_BUILDER_ID=12345', 'VITE_BUILDER_FEE_PERPS=20'],
    }),
  );
  const screen = s.screen.join('\n');
  assert.match(screen, /^RESULT: FAIL/);
  // The order of the sections is the order the owner asked for.
  const order = ['1. BUILDER FEE - what you asked to see', 'FINDINGS (2)', '2. EVERY CHAIN - deposit and withdrawal', '3. EVERY ORDER TYPE', '4. WHAT IT COST', '5. EVERY STAGE, EVERY STEP', 'FEE TABLE (from the live runner)', 'WHERE EVERY COIN IS', 'SETTINGS FOR THE APP', 'WHAT TO DO NEXT'];
  const at = order.map((h) => screen.indexOf(h));
  assert.ok(at.every((i) => i >= 0), `missing: ${order.filter((_, i) => at[i]! < 0).join(' | ')}`);
  assert.deepEqual([...at].sort((a, b) => a - b), at);

  // (a) to (g), each with the runner's verdict - and "not run" where it reported nothing.
  assert.match(screen, /\(a\) {2}First orders carry the default fee \(2 bp\).* PASS/);
  assert.match(screen, /\(c\) {2}The next order carries the lower fee \(1\.5 bp\).* PASS/);
  assert.match(screen, /\(e\) {2}A modified order still names the builder {2,}FINDING/);
  assert.match(screen, /\(f\) {2}The builder account's income equals the builderFee of the run's fills {2,}FAIL/);
  assert.match(screen, /\(g\) {2}Approval lowered or revoked.* not run/);
  assert.match(screen, /\(f\) the builder balance rose by 0\.0031, the fills paid 0\.0047/);
  // Findings: their own list, right under the results, with the runner's evidence.
  assert.match(screen, /FINDINGS \(2\) - not failures; this is how SoDEX behaved\. Read them:\n\s+- A modified order still names the builder: yes: the record still shows builder 12345\n\s+- A replaced order still names the builder: no: SoDEX drops the builder on replace/);
  assert.match(screen, /other checks the runner reported:[\s\S]*the trading key expires {2,}PASS/);
  // Chains and orders.
  assert.match(screen, /Arbitrum One {2,}USDC {2,}PASS {2,}PASS/);
  assert.match(screen, /Solana {2,}USDC {2,}not testable {2,}not run/);
  assert.match(screen, /2 of 5 routes tested/);
  assert.match(screen, /perps BTC-USD: market BUY 0\.00014 \(~11\.81 USD\) {2,}PASS/);
  // Cost and funds.
  assert.match(screen, /estimated by the plan \.+ \$3\.36/);
  assert.match(screen, /spent in the live run \.+ \$3\.41/);
  assert.match(screen, /spend cap \.+ \$8\.00/);
  assert.match(screen, /SoDEX Spot {2,}vUSDC 9\.1/);

  const j = s.json as Record<string, any>;
  assert.equal(j.result, 'FAIL');
  assert.equal(j.wallet, WALLET);
  assert.equal(j.builderFeeChecks.length, 9);
  assert.equal(j.builderFeeChecks[7].status, 'fail');
  assert.equal(j.findings.length, 2);
  assert.equal(j.otherRunnerChecks[0].id, 'key-lifecycle');
  assert.equal(j.chains.length, 5);
  assert.equal(j.cost.spentUsd, 3.41);
  assert.equal(j.stages[3].items[0].txs[0].hash, TX_DEPOSIT);
  assert.match(s.markdown, /\*\*Findings\*\* - what the run observed about how SoDEX behaves/);
  assert.match(s.markdown, /\| \(d\) \| Cheating attempt: an order without the builder is not credited \| PASS \| volume unchanged \|/);
});

test('plan only: nothing is claimed - every builder check and every chain reads "not run", with the reason', () => {
  const s = buildSummary(
    input({
      mode: { stages: ['D'], planOnly: true, throwawayKey: true, yes: true },
      stages: [stage('D', 'PASS', [row('plan', 'PASS'), row('step-deposit-external', 'PLANNED', { costUsd: 1.01 })])],
      plan: readPlanReport(planReport()),
      planReport: planReport(),
      wallet: WALLET,
    }),
  );
  const screen = s.screen.join('\n');
  assert.ok((s.json.builderFeeChecks as Array<{ status: string }>).every((c) => c.status === 'not-run'));
  assert.match(screen, /why: plan only - nothing was executed/);
  assert.match(screen, /Arbitrum One {2,}USDC {2,}not run {2,}not run/);
  assert.match(screen, /0 of 5 routes tested/);
  assert.match(screen, /3\. EVERY ORDER TYPE\n {3}not run: plan only - nothing was executed/);
  assert.match(screen, /spent in the live run \.+ nothing - no live run/);
  assert.match(screen, /No live run took place: the guide moved nothing/);
  assert.match(screen, /PLANNED {2,}step-deposit-external/);
  // An estimate is shown as one (~) on its row, and is not money the stage spent.
  assert.match(screen, /PLANNED {2,}step-deposit-external .*~\$1\.01/);
  assert.match(s.markdown, /\| PLANNED \| step-deposit-external \| 1\.2 s \| ~\$1\.01 \|/);
  assert.equal((s.json.stages as Array<{ costUsd: number | null }>)[0]!.costUsd, null);
  assert.ok(!/\| D \| stage D \| PASS \| [^|]* \| \$1\.01 \|/.test(s.markdown), 'a planned estimate is not the cost of the stage');
});

test('a stopped run says so at the top, in the file and in the JSON', () => {
  const s = buildSummary(input({ stopped: 'stopped with Ctrl+C', stages: [stage('A', 'PASS'), skippedStage('B', 'the run was stopped before this stage')] }));
  assert.match(s.screen[0]!, /^RESULT: STOPPED \(stopped early: stopped with Ctrl\+C\)/);
  assert.match(s.markdown, /\*\*The run was stopped early: stopped with Ctrl\+C\.\*\*/);
  assert.equal(s.json.stopped, 'stopped with Ctrl+C');
  assert.match(s.screen.join('\n'), /B: the run was stopped before this stage/);
});

test('NO SECRETS: a key planted in every text the summary is built from is in none of its three outputs', () => {
  const key = generatePrivateKey(); // made for this test; controls nothing
  const bare = key.slice(2);
  const stray = `0x${'9c'.repeat(32)}`; // key-sized, and not a known transaction hash
  const report = liveReport({ checks: [{ id: 'builder-fee-default', status: 'pass', detail: `evidence with ${key} in it` }] });
  (report as { whereFunds: string[] }).whereFunds.push(`  leaked ${bare.toUpperCase()}`);
  const s = buildSummary(
    input({
      mode: { stages: ['D'], planOnly: false, throwawayKey: false, yes: false },
      stages: [
        stage('D', 'FAIL', [
          row('step-deposit-external', 'PASS', { detail: `VS_E2E_KEY=${key}`, txs: [{ chain: 'ARBITRUM_ETH', hash: TX_DEPOSIT, explorer: `https://arbiscan.io/tx/${TX_DEPOSIT}` }] }),
          row('step-orders', 'FAIL', { detail: `signature 0x${'ab'.repeat(65)} and a stray ${stray}`, log: `C:\\logs\\${bare}.log` }),
        ], `stopped with ${bare}`),
      ],
      wallet: WALLET,
      plan: readPlanReport(planReport({ funded: true })),
      live: readLiveReport(report),
      planReport: planReport({ funded: true }),
      liveReport: report,
      feeTable: [`| fee | ${key} |`],
      envLines: [`VITE_SOMETHING=${bare}`],
      next: [`do not paste ${key} anywhere`],
      key,
    }),
  );
  const outputs = { screen: s.screen.join('\n'), markdown: s.markdown, json: JSON.stringify(s.json) };
  for (const [name, text] of Object.entries(outputs)) {
    assert.ok(!text.toLowerCase().includes(bare.toLowerCase()), `the key is in the ${name}`);
    assert.ok(!text.includes(stray.slice(2)), `a key-sized value that is no known hash is in the ${name}`);
    assert.ok(!text.includes('ab'.repeat(65)), `a signature is in the ${name}`);
    assert.ok(text.includes('[redacted'), `${name} shows that something was removed`);
  }
  // Transaction hashes from the report's own hash fields survive - they are what the owner looks up.
  assert.ok(outputs.markdown.includes(TX_DEPOSIT));
  assert.ok(outputs.json.includes(TX_DEPOSIT));
  // The wallet address (40 hex) is not a secret and stays.
  assert.ok(outputs.json.includes(WALLET));
});

test('NO SECRETS without knowing the key: the size alone is enough to remove it', () => {
  const key = generatePrivateKey();
  const s = buildSummary(input({ next: [`a key the guide was never told about: ${key}`], stages: [stage('A', 'FAIL', [row('x', 'FAIL', { detail: key.slice(2) })])] }));
  for (const text of [s.screen.join('\n'), s.markdown, JSON.stringify(s.json)]) assert.ok(!text.includes(key.slice(2)));
});

test('a hash that only appears in free text is not trusted as a transaction hash', () => {
  const report = liveReport();
  const s = buildSummary(
    input({
      mode: { stages: ['D'], planOnly: false, throwawayKey: false, yes: false },
      stages: [stage('D', 'PASS', [row('step-withdraw-external', 'PASS', { detail: `see ${TX_WITHDRAW} and ${`0x${'77'.repeat(32)}`}` })])],
      live: readLiveReport(report),
      liveReport: report,
    }),
  );
  // TX_WITHDRAW is in the runner report's txs[] -> known. The other one is only in a sentence -> removed.
  assert.ok(s.markdown.includes(TX_WITHDRAW));
  assert.ok(!s.markdown.includes('77'.repeat(32)));
});
