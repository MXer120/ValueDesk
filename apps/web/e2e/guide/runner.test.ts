/**
 * The contract with the live runner, read from the outside: capabilities, the
 * command line, the plan, funding, resuming.
 *   npx tsx --test e2e/guide/runner.test.ts        (from apps/web)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PLAN_CONSOLE, USAGE_TODAY, WALLET, liveReport, planReport, TX_DEPOSIT } from './fixtures';
import {
  DEFAULT_CAPABILITIES,
  KNOWN_STEPS,
  capabilitiesFromUsage,
  configWarnings,
  depositToken,
  extractFeeTable,
  findReportPath,
  findWallet,
  fundingInstructions,
  fundingStatus,
  hasProfile,
  missingLine,
  parseCapabilities,
  parseChecklistLine,
  planFromConsole,
  plannedSkips,
  profileMenu,
  readLiveReport,
  readPlanReport,
  receiversNeeded,
  receiversToAsk,
  refusalLines,
  resumeCommand,
  resumeSteps,
  retestSteps,
  runnerArgs,
  stepItemStatus,
  stripClock,
  summaryPathsFor,
} from './runner';

// --- capabilities -----------------------------------------------------------------------------

test('capabilities: the runner\'s own JSON answer, even with a banner around it', () => {
  const c = parseCapabilities('some banner\n{ "steps": ["a","b"], "profiles": ["core","all-chains","builder-rerun"], "flags": ["--profile"] }\n', 0);
  assert.deepEqual(c, { steps: ['a', 'b'], profiles: ['core', 'all-chains', 'builder-rerun'], flags: ['--profile'], source: 'capabilities' });
  assert.equal(hasProfile(c!, 'builder-rerun'), true);
});

test('capabilities: not that answer = null (never a crash)', () => {
  assert.equal(parseCapabilities('{ "steps": ["a"] }', 2), null); // it exited with an error
  assert.equal(parseCapabilities('unknown argument capabilities', 0), null);
  assert.equal(parseCapabilities('{ "steps": "a" }', 0), null);
  assert.equal(parseCapabilities('{ "steps": [] }', 0), null);
  assert.equal(parseCapabilities('{ broken', 0), null);
});

test('capabilities: an older runner is read from its usage text - its steps, its flags, no profiles', () => {
  const c = capabilitiesFromUsage(USAGE_TODAY);
  assert.ok(c);
  assert.equal(c.source, 'usage');
  assert.deepEqual(c.steps.slice(0, 4), ['deposit-external', 'enable-trading', 'transfers', 'orders']);
  assert.equal(c.steps.at(-1), 'revoke-builder');
  assert.deepEqual(c.profiles, []);
  for (const f of ['--config', '--confirm', '--only', '--throwaway-key', '--registry-only', '--report-dir']) assert.ok(c.flags.includes(f), f);
  assert.equal(capabilitiesFromUsage('command not found'), null);
});

test('capabilities: the real runner\'s usage text is understood (if the runner is in this checkout)', () => {
  const file = fileURLToPath(new URL('../live/run.ts', import.meta.url));
  if (!existsSync(file)) return;
  const src = readFileSync(file, 'utf8');
  // Either it answers `capabilities` itself by now, or its usage lists the steps after `--only`.
  if (/capabilities/.test(src)) return;
  const usage = /const USAGE = `([\s\S]*?)`;/.exec(src)?.[1] ?? '';
  assert.match(usage, /--only a,b/);
});

test('profiles: the menu offers what the runner has, in the owner\'s order, and names what is missing', () => {
  const none = profileMenu(DEFAULT_CAPABILITIES);
  assert.deepEqual(none.available, []);
  assert.deepEqual(none.missing.map((p) => p.name), ['core', 'evm-tour', 'all-chains', 'builder-rerun']);
  const some = profileMenu({ steps: [], profiles: ['all-chains', 'core', 'builder-rerun', 'nightly'], flags: [], source: 'capabilities' });
  // The full test comes first whenever the runner has all-chains: it is that profile with everything switched on.
  assert.deepEqual(some.available.map((p) => p.name), ['full', 'core', 'all-chains', 'builder-rerun', 'nightly']);
  assert.match(some.available[0]!.title, /^Full test \(everything\)/);
  assert.match(some.available[3]!.covers.join(' '), /forget --address/);
  assert.deepEqual(some.missing.map((p) => p.name), ['evm-tour']);
  assert.match(some.available.at(-1)!.covers[0]!, /no description/);
});

// --- the command line -------------------------------------------------------------------------

test('runnerArgs: plan and live, and there is no way to put a key into them', () => {
  assert.deepEqual(runnerArgs({ mode: 'capabilities' }), ['capabilities']);
  assert.deepEqual(runnerArgs({ mode: 'plan', throwaway: true, registryOnly: true, reportDir: 'r' }), ['plan', '--throwaway-key', '--registry-only', '--report-dir', 'r']);
  assert.deepEqual(runnerArgs({ mode: 'plan', config: 'c.json', only: ['a', 'b'], profile: 'core', registryOnly: true }), ['plan', '--config', 'c.json', '--profile', 'core', '--only', 'a,b', '--registry-only']);
  assert.deepEqual(runnerArgs({ mode: 'live', config: 'c.json', confirm: WALLET, reportDir: 'r' }), ['live', '--config', 'c.json', '--confirm', WALLET, '--report-dir', 'r']);
});

test('runnerArgs: a live run without its gates is refused before the runner is even started', () => {
  assert.throws(() => runnerArgs({ mode: 'live', config: 'c.json' }), /--confirm/);
  assert.throws(() => runnerArgs({ mode: 'live', config: 'c.json', confirm: 'yes' }), /--confirm/);
  assert.throws(() => runnerArgs({ mode: 'live', confirm: WALLET }), /config/);
  assert.throws(() => runnerArgs({ mode: 'live', config: 'c.json', confirm: WALLET, throwaway: true }), /throwaway/);
  assert.throws(() => runnerArgs({ mode: 'live', config: 'c.json', confirm: WALLET, registryOnly: true }), /registry-only/);
});

// --- console ----------------------------------------------------------------------------------

test('console lines: the clock, the wallet, the report file, refusals, config warnings', () => {
  assert.equal(stripClock('20:23:01  wallet   0xabc'), 'wallet   0xabc');
  assert.equal(findWallet(PLAN_CONSOLE), WALLET);
  assert.equal(findReportPath(PLAN_CONSOLE), 'C:\\reports\\2026-10-02T20-23-01-798Z-plan.json');
  assert.equal(findReportPath(['nothing']), null);
  assert.deepEqual(refusalLines(['20:00:00  REFUSED: pass --confirm 0xabc', '20:00:00    CONFIG ERROR: deposit.amount must be a decimal STRING', 'fatal: boom', 'fine']), [
    'REFUSED: pass --confirm 0xabc',
    'CONFIG ERROR: deposit.amount must be a decimal STRING',
    'fatal: boom',
  ]);
  assert.deepEqual(configWarnings(['20:00:00    config warning: Unknown key "builder.termsKeys" is ignored (a typo?).']), ['Unknown key "builder.termsKeys" is ignored (a typo?).']);
});

// --- the plan ---------------------------------------------------------------------------------

test('the plan from the runner\'s report', () => {
  const v = readPlanReport(planReport());
  assert.ok(v);
  assert.equal(v.wallet, WALLET);
  assert.equal(v.exitCode, 2);
  assert.equal(v.throwaway, true);
  assert.equal(v.preflightError, null);
  assert.equal(v.problems.length, 2);
  assert.equal(v.checklist.length, 2);
  assert.equal(v.estimatedCostUsd, 3.36);
  assert.equal(v.maxSpendUsd, 8);
  assert.equal(v.steps.length, 8);
  assert.equal(v.steps.find((s) => s.id === 'cleanup')!.skip, 'cleanup.enabled is false');
  assert.equal(v.routes.length, 7);
  assert.equal(v.suggestedMaxSpendUsd, null, 'an older runner suggests no cap');
  assert.equal(readPlanReport(planReport({ suggestedMaxSpendUsd: 32 }))!.suggestedMaxSpendUsd, 32);
  assert.equal(readPlanReport({ tool: 'something else' }), null);
  assert.equal(readPlanReport(null), null);
});

test('the plan when preflight itself failed: no plan, but the reason', () => {
  const v = readPlanReport({ tool: 'valuescan-live-e2e', wallet: WALLET, exitCode: 1, plan: null, config: {}, steps: [{ id: 'preflight', status: 'failed', error: 'ApiError: backend not reachable' }] });
  assert.ok(v);
  assert.equal(v.preflightError, 'ApiError: backend not reachable');
  const st = fundingStatus(v);
  assert.equal(st.funded, false);
  assert.match(st.blockers[0]!, /read-only checks failed: ApiError: backend not reachable/);
});

test('the same plan from the console alone (a runner that wrote no readable report)', () => {
  const v = planFromConsole(PLAN_CONSOLE, 2);
  assert.equal(v.wallet, WALLET);
  assert.equal(v.throwaway, true);
  assert.deepEqual(v.problems, ['fund the wallet: 25.00 USDC on Arbitrum One (it holds 0.00)', 'fund the wallet: 0.000200 ETH on Arbitrum One (it holds 0.00)']);
  assert.equal(v.checklist.length, 2);
  assert.equal(v.warnings.length, 1);
  assert.equal(v.estimatedCostUsd, 3.36);
  assert.equal(v.maxSpendUsd, 8);
  assert.equal(v.suggestedMaxSpendUsd, null);
  assert.equal(planFromConsole([...PLAN_CONSOLE.slice(0, -1), '20:23:15  Suggested maxSpendUsd for this run: 32 (the config says 8)', PLAN_CONSOLE.at(-1)!], 2).suggestedMaxSpendUsd, 32);
  assert.deepEqual(v.steps.map((s) => s.id), ['deposit-external', 'enable-trading', 'orders', 'withdraw-valuechain-other', 'withdraw-external', 'extra-withdrawals', 'cleanup', 'revoke-builder']);
  assert.equal(v.steps[0]!.costUsd, 1.01);
  assert.equal(v.steps[0]!.lines.length, 2);
  assert.equal(v.steps[3]!.skip, 'receivers.valuechain is not set');
  assert.equal(v.routes.length, 7);
  assert.deepEqual(v.selectedSteps.slice(0, 2), ['deposit-external', 'enable-trading']);
  // Both readings agree on what matters for funding.
  assert.deepEqual(fundingStatus(v).missing.map((m) => m.raw), fundingStatus(readPlanReport(planReport())!).missing.map((m) => m.raw));
});

test('the plan from the console: a failed preflight', () => {
  const v = planFromConsole(['20:00:00  == preflight: read-only checks', '20:00:01  FAILED preflight (0.5 s): ApiError: backend not reachable'], 1);
  assert.equal(v.preflightError, 'ApiError: backend not reachable');
});

// --- funding ----------------------------------------------------------------------------------

test('a checklist line: chain names with spaces, amounts, nested brackets', () => {
  assert.deepEqual(parseChecklistLine('[ ] Arbitrum One     25.00 USDC  (deposit) - wallet holds 0.00'), { ok: false, chain: 'Arbitrum One', amount: '25.00', coin: 'USDC', why: 'deposit', holds: '0.00', raw: '[ ] Arbitrum One     25.00 USDC  (deposit) - wallet holds 0.00' });
  const eth = parseChecklistLine('  [x] Arbitrum One     0.000200 ETH   (gas for the USDC transfer (with headroom; the rest stays in the wallet)) - wallet holds 0.000300');
  assert.equal(eth?.ok, true);
  assert.equal(eth?.coin, 'ETH');
  assert.equal(eth?.why, 'gas for the USDC transfer (with headroom; the rest stays in the wallet)');
  assert.equal(eth?.holds, '0.000300');
  assert.equal(parseChecklistLine('[ ] BNB Smart Chain  0.000500 BNB   (gas (with headroom)) - wallet holds ?')?.chain, 'BNB Smart Chain');
  assert.equal(parseChecklistLine('[ ] Avalanche C-Chain 1.50 AVAX  (gas) - wallet holds 0')?.chain, 'Avalanche C-Chain');
  assert.equal(parseChecklistLine('[x] nothing to send from other chains for the selected steps'), null);
});

test('fundingStatus: not funded -> what is missing; funded -> ready; another problem -> a blocker waiting cannot fix', () => {
  const unfunded = fundingStatus(readPlanReport(planReport())!);
  assert.equal(unfunded.funded, false);
  assert.equal(unfunded.ready, false);
  assert.equal(unfunded.missing.length, 2);
  assert.deepEqual(unfunded.blockers, []);
  assert.equal(missingLine(unfunded), '25.00 USDC on Arbitrum One (holds 0.00); 0.000200 ETH on Arbitrum One (holds 0.00)');

  const funded = fundingStatus(readPlanReport(planReport({ funded: true }))!);
  assert.equal(funded.funded, true);
  assert.equal(funded.ready, true);
  assert.equal(missingLine(funded), 'nothing');

  const blocked = fundingStatus(readPlanReport(planReport({ funded: true, problems: ['perps BTC-USD is HALTED, not TRADING'] }))!);
  assert.equal(blocked.funded, true);
  assert.equal(blocked.ready, false);
  assert.deepEqual(blocked.blockers, ['perps BTC-USD is HALTED, not TRADING']);
});

test('funding in plain words: what, where, to whom - and which USDC', () => {
  const v = readPlanReport(planReport())!;
  assert.deepEqual(depositToken(v), { chain: 'Arbitrum One', token: '0xaf88d065e77c8cc2239327c5edb3a432268e5831' });
  const lines = fundingInstructions(WALLET, fundingStatus(v), v);
  assert.equal(lines[0], `1. Send 25.00 USDC on Arbitrum One to ${WALLET}`);
  assert.match(lines[1]!, /what for: deposit\. The wallet holds 0\.00 USDC there now\./);
  assert.match(lines[2]!, /native USDC, token contract 0xaf88d065e77c8cc2239327c5edb3a432268e5831 - not a bridged USDC/);
  assert.equal(lines[3], `2. Send 0.000200 ETH on Arbitrum One to ${WALLET}`);
});

// --- receivers --------------------------------------------------------------------------------

test('receivers: read from the runner\'s messages when it lists none', () => {
  const v = readPlanReport(planReport())!;
  assert.deepEqual(v.receivers.map((r) => [r.name, r.set]), [['valuechain', false]]);
  assert.match(v.receivers[0]!.why, /withdraw-valuechain-other: receivers\.valuechain is not set/);
  const needs = receiversNeeded(undefined, {
    problems: ['extraWithdrawals[1]: XRP Ledger takes a memo (destination tag) - give receivers.xrp a "memo", or "noMemo": true for an address that needs none', 'receivers.solana: not a valid Solana address'],
    warnings: [],
    steps: [],
  });
  assert.deepEqual(needs.map((n) => [n.name, n.set, n.memo, n.problem]), [['xrp', true, true, null], ['solana', true, false, 'not a valid Solana address']]);
  assert.equal(receiversToAsk(needs).length, 2);
});

test('receivers: the runner\'s own list wins when it has one', () => {
  const v = readPlanReport(planReport({ receiversNeeded: [{ name: 'solana', chain: 'Solana', why: 'withdrawal of 5 USDC', memo: false, set: false }, { name: 'bad name!', chain: 'x' }, { name: 'xrp', label: 'XRP Ledger', memo: 'required', set: true, problem: 'needs a memo' }] }))!;
  assert.deepEqual(v.receivers.map((r) => [r.name, r.chain, r.memo, r.set]), [['solana', 'Solana', false, false], ['xrp', 'XRP Ledger', true, true]]);
  // An empty list from the runner means: none needed - the messages are not second-guessed.
  assert.deepEqual(readPlanReport(planReport({ receiversNeeded: [] }))!.receivers, []);
});

// --- a live run -------------------------------------------------------------------------------

test('a finished live run: every step, its cost, its transactions', () => {
  const v = readLiveReport(liveReport());
  assert.ok(v);
  assert.equal(v.mode, 'live');
  assert.equal(v.exitCode, 0);
  assert.equal(v.wallet, WALLET);
  assert.deepEqual(v.steps.map((s) => `${s.id}:${s.status}`), ['preflight:ok', 'deposit-external:ok', 'enable-trading:ok', 'orders:ok', 'withdraw-external:ok', 'extra-withdrawals:ok', 'cleanup:skipped']);
  const dep = v.steps[1]!;
  assert.equal(dep.costUsd, 1.01);
  assert.deepEqual(dep.txs, [{ chain: 'ARBITRUM_ETH', hash: TX_DEPOSIT, explorer: `https://arbiscan.io/tx/${TX_DEPOSIT}` }]);
  assert.equal(v.steps.find((s) => s.id === 'orders')!.subSteps.length, 7);
  assert.deepEqual(v.spend, { costUsd: 3.41, sentAwayUsd: 0 });
  assert.equal(v.whereFunds.length, 4);
  assert.deepEqual(resumeSteps(v, KNOWN_STEPS), { stoppedAt: null, remaining: [] });
});

test('a stopped live run: where it stopped, what is left, how to resume', () => {
  const v = readLiveReport(liveReport({ stoppedAt: 'withdraw-external' }))!;
  assert.equal(v.exitCode, 1);
  assert.equal(v.steps.find((s) => s.id === 'withdraw-external')!.error, 'TimeoutError: the withdrawal did not become final in 30 min');
  assert.equal(v.inFlight.length, 1);
  const order = ['deposit-external', 'enable-trading', 'orders', 'withdraw-external', 'extra-withdrawals', 'cleanup'];
  const report = liveReport({ stoppedAt: 'withdraw-external' });
  assert.deepEqual([...plannedSkips(report)].sort(), ['cleanup', 'revoke-builder', 'withdraw-valuechain-other']);
  const r = resumeSteps(v, order, plannedSkips(report));
  assert.equal(r.stoppedAt, 'withdraw-external');
  assert.deepEqual(r.remaining, ['withdraw-external', 'extra-withdrawals']); // the plan skips cleanup: nothing to resume there
  // Without the plan's word, every step after the stop is offered.
  assert.deepEqual(resumeSteps(v, order).remaining, ['withdraw-external', 'extra-withdrawals', 'cleanup']);
  assert.deepEqual(resumeCommand(WALLET, r.remaining), ['cd apps\\web', `npx tsx e2e/live/run.ts live --config e2e/live/config.json --confirm ${WALLET} --only withdraw-external,extra-withdrawals`]);
});

test('step statuses as rows: only "ok" is a pass; a step cut off in the middle is a failure', () => {
  assert.equal(stepItemStatus('ok'), 'PASS');
  assert.equal(stepItemStatus('skipped'), 'SKIPPED');
  assert.equal(stepItemStatus('planned'), 'PLANNED');
  for (const s of ['failed', 'blocked', 'running', 'whatever']) assert.equal(stepItemStatus(s), 'FAIL');
});

test('the runner\'s fee table: a section of its summary, else its JSON rows, else nothing', () => {
  const md = '# Run\n\n## Steps\n\nx\n\n## Fees paid\n\n| what | usd |\n|---|---|\n| activation | 1.00 |\n\n### detail\n\nmore\n\n## Next\n\ny\n';
  assert.deepEqual(extractFeeTable(md, null), ['| what | usd |', '|---|---|', '| activation | 1.00 |', '', '### detail', '', 'more']);
  assert.deepEqual(extractFeeTable(null, [{ what: 'activation', usd: 1 }, { what: 'gas', usd: 0.01, chain: 'ARBITRUM_ETH' }]), ['| what | usd | chain |', '|---|---|---|', '| activation | 1 |  |', '| gas | 0.01 | ARBITRUM_ETH |']);
  assert.equal(extractFeeTable('# Run\n\nnothing about that\n', null), null);
  assert.equal(extractFeeTable(null, null), null);
  assert.deepEqual(summaryPathsFor('C:\\r\\2026-live.json'), ['C:\\r\\2026-live.summary.md', 'C:\\r\\2026-live.json.summary.md']);
});

test('retest: every step that did not pass whole - a step that ended "ok" with a failed or unjudged check runs again; plan skips never', () => {
  const order = ['deposit-external', 'enable-trading', 'builder-tiers', 'orders-spot', 'orders-perps', 'withdraw-valuechain-other', 'cleanup'];
  const view = {
    selectedSteps: order,
    steps: [
      { id: 'deposit-external', status: 'ok' },
      { id: 'enable-trading', status: 'ok' },
      { id: 'builder-tiers', status: 'ok' },
      { id: 'orders-spot', status: 'ok' },
      { id: 'orders-perps', status: 'failed' },
    ] as never,
    checks: [
      { id: 'deposit-usdc', step: 'deposit-external', status: 'pass' },
      { id: 'builder-underpaid-not-counted', step: 'builder-tiers', status: 'fail' },
      { id: 'spot-fees-builder', step: 'orders-spot', status: 'not-run' },
      { id: 'spot-fok-fillable', step: 'orders-spot', status: 'finding' },
      { id: 'withdraw-valuechain-other', step: 'withdraw-valuechain-other', status: 'skipped' },
    ],
  };
  assert.deepEqual(retestSteps(view, order, new Set(['withdraw-valuechain-other'])), ['builder-tiers', 'orders-spot', 'orders-perps', 'cleanup']);
  // A finding or a skip is an answer, not something to run again.
  assert.deepEqual(retestSteps({ ...view, checks: view.checks.filter((c) => c.status !== 'fail' && c.status !== 'not-run') }, order, new Set(['withdraw-valuechain-other'])), ['orders-perps', 'cleanup']);
});

test('the live report: its checks are read with their steps', () => {
  const v = readLiveReport(liveReport({ stoppedAt: 'withdraw-external', checks: [{ id: 'a', step: 'orders', status: 'not-run', detail: 'x' }, { status: 'pass' }] }))!;
  assert.deepEqual(v.checks, [{ id: 'a', step: 'orders', status: 'not-run' }]);
});
