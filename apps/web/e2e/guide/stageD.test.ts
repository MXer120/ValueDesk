/**
 * Stage D from the first question to the end, against a fake live runner that
 * records exactly what it is handed. What these tests pin down:
 *   - the key reaches the runner only through the child's environment, and only
 *     for the plan and the live run of that wallet - never an argument, never a
 *     config file, never the screen;
 *   - a live run starts only at a console, after YES and the typed address, and
 *     the real-funds switch is on in the config only for that run;
 *   - everything before it is a read-only plan, with --registry-only while waiting.
 *   npx tsx --test e2e/guide/stageD.test.ts        (from apps/web)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { TX_DEPOSIT, WALLET, liveReport, planReport } from './fixtures';
import { askKey, detectCapabilities, moneyRun, planOnce, runStageD, waitForFunding } from './stageD';
import { EXAMPLE_CONFIG, FakeRunner, NAMES_TIERS, kit, type FakeRunnerOptions } from './testkit';

// A key made for these tests. It controls nothing, and the fake runner never signs.
const KEY = generatePrivateKey();
const ADDRESS = privateKeyToAccount(KEY).address;
const BARE = KEY.slice(2);

/** A plan report for THIS test wallet. */
const plan = (o: Parameters<typeof planReport>[0] = {}): { report: unknown; code: number } => {
  const r = planReport(o);
  r.wallet = ADDRESS.toLowerCase();
  r.throwawayKey = false;
  return { report: r, code: r.exitCode as number };
};
const live = (o: Parameters<typeof liveReport>[0] = {}): { report: unknown; code: number } => {
  const r = liveReport(o);
  r.wallet = ADDRESS.toLowerCase();
  return { report: r, code: r.exitCode as number };
};

/** The answers of a complete, successful run: no receiver, the wallet confirmed, tabs closed, YES, the address. */
const HAPPY = ['', 'y', '', 'YES', ADDRESS];

function assertNoKeyAnywhere(text: string, where: string): void {
  assert.ok(!text.toLowerCase().includes(BARE.toLowerCase()), `the key must not appear in ${where}`);
}

test('--plan-only --throwaway-key: no key is asked; one read-only plan; the owner\'s config.json is not touched', async () => {
  const k = kit({ argv: ['--stages', 'D', '--plan-only', '--throwaway-key', '--yes'], interactive: false });
  const fake = new FakeRunner({ plans: [{ report: planReport(), code: 2 }] });
  try {
    const r = await runStageD(k.ctx, fake);
    assert.equal(r.status, 'PASS', r.reason);
    assert.equal(k.prompter.hiddenAsked, 0);
    assert.equal(fake.lives.length, 0);
    assert.equal(fake.plans.length, 1);
    const call = fake.plans[0]!;
    assert.equal(call.key, null);
    assert.deepEqual(call.argv.filter((a) => a.startsWith('--')).sort(), ['--config', '--registry-only', '--report-dir', '--throwaway-key']);
    assert.ok(fake.saved.every((s) => s.path !== k.ctx.paths.config.config), 'a throwaway plan writes a scratch config only');
    assert.deepEqual(r.items.map((i) => `${i.title}:${i.status}`).slice(0, 3), ['read-only plan:PASS', 'deposit-external:PLANNED', 'enable-trading:PLANNED']);
    assert.equal(r.items.find((i) => i.title === 'cleanup')!.status, 'SKIPPED');
    assert.match(k.screen(), /Send 25\.00 USDC on Arbitrum One to 0x/);
    assert.equal(k.ctx.shared.wallet, WALLET);
  } finally {
    k.cleanup();
  }
});

test('the whole live flow: plan, wait for funds, complete plan, YES, the address, the run', async () => {
  const k = kit({ argv: ['--stages', 'D'], lines: HAPPY, hidden: [KEY], waits: [null] });
  const fake = new FakeRunner({ plans: [{ report: planReport(), code: 2 }, plan(), plan({ funded: true }), plan({ funded: true })], live: live() });
  try {
    const r = await runStageD(k.ctx, fake);
    assert.equal(r.status, 'PASS', r.reason);
    assert.deepEqual(k.prompter.unused, []);

    // What ran: a preview with a throwaway key, the wallet's plan, one more after waiting, the complete plan, the live run.
    assert.deepEqual(fake.calls.map((c) => c.inv.mode), ['capabilities', 'plan', 'plan', 'plan', 'plan', 'live']);
    const [preview, first, waited, complete] = fake.plans;
    assert.equal(preview!.inv.throwaway, true);
    assert.equal(preview!.key, null, 'the preview never gets the key');
    assert.equal(first!.key, KEY);
    assert.equal(waited!.key, KEY);
    assert.deepEqual([first!.inv.registryOnly, waited!.inv.registryOnly, complete!.inv.registryOnly], [true, true, false], 'only the last plan before the run asks SoDEX for deposit addresses');

    // The live run: confirmed with the address, protected from the guide's own Ctrl+C handling, key in the environment only.
    const run = fake.lives[0]!;
    assert.equal(run.key, KEY);
    assert.equal(run.protect, true);
    assert.equal(run.inv.confirm, ADDRESS);
    assert.equal(run.config!.acknowledgeRealFunds, true);
    for (const c of fake.calls) assertNoKeyAnywhere(c.argv.join(' '), 'the runner\'s arguments');
    for (const s of fake.saved) assertNoKeyAnywhere(JSON.stringify(s.cfg), 'a config file');
    assertNoKeyAnywhere(k.screen(), 'the screen');

    // The real-funds switch: on for the run, off before and after.
    assert.deepEqual(fake.ackHistory.filter(Boolean).length, 1);
    assert.equal(fake.ackHistory.at(-1), false);
    assert.equal(fake.plans.every((p) => p.config!.acknowledgeRealFunds === false), true);

    // What the owner was told, in order.
    const screen = k.screen();
    for (const want of ['BRAND-NEW wallet', `This key controls the wallet  ${ADDRESS}`, 'SEND THIS TO THE TEST WALLET', `1. Send 25.00 USDC on Arbitrum One to ${ADDRESS}`, 'The wallet holds what the run needs', 'close every other Valuescan tab and every sodex.com tab', 'This moves REAL money', 'The live run finished']) {
      assert.ok(screen.includes(want), want);
    }
    assert.ok(screen.indexOf('SEND THIS TO THE TEST WALLET') < screen.indexOf('close every other Valuescan tab'));

    // The rows: the plan, then every step of the run with its cost and transactions.
    assert.deepEqual(r.items.map((i) => `${i.title}:${i.status}`), ['read-only plan:PASS', 'preflight:PASS', 'deposit-external:PASS', 'enable-trading:PASS', 'orders:PASS', 'withdraw-external:PASS', 'extra-withdrawals:PASS', 'cleanup:SKIPPED']);
    const dep = r.items.find((i) => i.title === 'deposit-external')!;
    assert.equal(dep.costUsd, 1.01);
    assert.equal(dep.txs![0]!.hash, TX_DEPOSIT);
    assert.equal(k.ctx.shared.wallet, ADDRESS);
    assert.ok(k.ctx.shared.liveReport);
  } finally {
    k.cleanup();
  }
});

test('not at a console: a live run is refused before any key is asked for', async () => {
  const k = kit({ argv: ['--stages', 'D'], lines: [''], hidden: [KEY], interactive: false });
  const fake = new FakeRunner({ plans: [{ report: planReport(), code: 2 }], live: live() });
  try {
    const r = await runStageD(k.ctx, fake);
    assert.equal(r.status, 'SKIPPED');
    assert.match(r.reason!, /not at a console/);
    assert.equal(k.prompter.hiddenAsked, 0);
    assert.equal(fake.lives.length, 0);
    assert.ok(fake.calls.every((c) => c.key === null));
  } finally {
    k.cleanup();
  }
});

test('plan-only with a typed key (how the prompt is tested): the plan gets the key, --registry-only, and nothing else happens', async () => {
  const k = kit({ argv: ['--stages', 'D', '--plan-only'], lines: ['', 'y'], hidden: [KEY], interactive: false });
  const fake = new FakeRunner({ plans: [{ report: planReport(), code: 2 }, plan()], live: live() });
  try {
    const r = await runStageD(k.ctx, fake);
    assert.equal(r.status, 'PASS', r.reason);
    assert.equal(fake.lives.length, 0);
    assert.deepEqual(fake.plans.map((p) => [p.key === KEY, p.inv.registryOnly]), [[false, true], [true, true]]);
    assert.deepEqual(fake.ackHistory.filter(Boolean), []);
    assertNoKeyAnywhere(k.screen(), 'the screen');
    assert.match(k.screen(), /What a live run would need in the wallet/);
  } finally {
    k.cleanup();
  }
});

test('the wrong address typed three times: no run, and the real-funds switch was never on', async () => {
  const k = kit({ argv: ['--stages', 'D'], lines: ['', 'y', '', 'YES', WALLET, 'nope', '0x0'], hidden: [KEY] });
  const fake = new FakeRunner({ plans: [{ report: planReport(), code: 2 }, plan({ funded: true })], live: live() });
  try {
    const r = await runStageD(k.ctx, fake);
    assert.equal(r.status, 'SKIPPED');
    assert.match(r.reason!, /wallet address was not confirmed/);
    assert.equal(fake.lives.length, 0);
    assert.deepEqual(fake.ackHistory.filter(Boolean), []);
  } finally {
    k.cleanup();
  }
});

test('"yes" in small letters is not YES: no run', async () => {
  const k = kit({ argv: ['--stages', 'D'], lines: ['', 'y', '', 'yes', 'q'], hidden: [KEY] });
  const fake = new FakeRunner({ plans: [{ report: planReport(), code: 2 }, plan({ funded: true })], live: live() });
  try {
    const r = await runStageD(k.ctx, fake);
    assert.equal(r.status, 'SKIPPED');
    assert.match(r.reason!, /not confirmed/);
    assert.equal(fake.lives.length, 0);
  } finally {
    k.cleanup();
  }
});

test('--yes does not confirm a wallet, a YES or an address', async () => {
  const k = kit({ argv: ['--stages', 'D', '--yes'], lines: [], hidden: [KEY] });
  const fake = new FakeRunner({ plans: [{ report: planReport(), code: 2 }, plan({ funded: true })], live: live() });
  try {
    await assert.rejects(runStageD(k.ctx, fake), /input ended/);
    assert.equal(fake.lives.length, 0);
    assert.deepEqual(fake.ackHistory.filter(Boolean), []);
  } finally {
    k.cleanup();
  }
});

test('the wallet is not funded and the owner stops waiting: no run, and the summary says what to send', async () => {
  const k = kit({ argv: ['--stages', 'D'], lines: ['', 'y'], hidden: [KEY], waits: [null, 'q'] });
  const fake = new FakeRunner({ plans: [{ report: planReport(), code: 2 }, plan()], live: live() });
  try {
    const r = await runStageD(k.ctx, fake);
    assert.equal(r.status, 'SKIPPED');
    assert.match(r.reason!, /stopped waiting/);
    assert.equal(fake.lives.length, 0);
    assert.equal(fake.plans.length, 3); // preview, the wallet's plan, one re-check
    assert.match(k.ctx.shared.next.join('\n'), new RegExp(`Fund the test wallet ${ADDRESS} \\(25\\.00 USDC on Arbitrum One`));
    assert.equal(r.items[0]!.status, 'PASS'); // the plan itself worked
  } finally {
    k.cleanup();
  }
});

test('a plan problem that funding does not fix fails the stage at once - no waiting', async () => {
  const k = kit({ argv: ['--stages', 'D'], lines: ['', 'y'], hidden: [KEY] });
  const fake = new FakeRunner({ plans: [{ report: planReport(), code: 2 }, plan({ problems: ['perps BTC-USD is HALTED, not TRADING'] })], live: live() });
  try {
    const r = await runStageD(k.ctx, fake);
    assert.equal(r.status, 'FAIL');
    assert.equal(fake.lives.length, 0);
    assert.equal(fake.plans.length, 2);
    assert.match(k.flat(), /waiting will not change it.*perps BTC-USD is HALTED/);
  } finally {
    k.cleanup();
  }
});

test('the run stops in the middle: where the funds are, what is left, how to resume - and the switch is off again', async () => {
  const k = kit({ argv: ['--stages', 'D'], lines: HAPPY, hidden: [KEY] });
  const fake = new FakeRunner({ plans: [{ report: planReport(), code: 2 }, plan({ funded: true })], live: live({ stoppedAt: 'withdraw-external' }) });
  try {
    const r = await runStageD(k.ctx, fake);
    assert.equal(r.status, 'FAIL');
    assert.match(r.reason!, /stopped at withdraw-external/);
    assert.equal(fake.ackHistory.at(-1), false);
    const screen = k.flat();
    for (const want of ['THE RUN STOPPED at the step "withdraw-external"', 'Where the funds are now:', 'SoDEX Spot', 'IN FLIGHT: withdrawal of 5 USDC', 'TO RESUME', 'choose "Resume the earlier run"', `--confirm ${ADDRESS} --only withdraw-external,extra-withdrawals`]) assert.ok(screen.includes(want), want);
    assert.match(k.ctx.shared.next.join('\n'), /stopped at "withdraw-external"[\s\S]*steps left: withdraw-external, extra-withdrawals/);
    assert.equal(r.items.find((i) => i.title === 'withdraw-external')!.status, 'FAIL');
  } finally {
    k.cleanup();
  }
});

test('a wallet that already has a SoDEX account: resuming the earlier run passes --only and allows the account', async () => {
  const known = { lines: ['20:00:00  SoDEX account     #4711'] };
  const earlier = liveReport({ stoppedAt: 'withdraw-external' });
  earlier.wallet = ADDRESS.toLowerCase();
  const k = kit({ argv: ['--stages', 'D'], lines: ['', 'y', '1', '', 'YES', ADDRESS], hidden: [KEY] });
  const fake = new FakeRunner({
    capabilities: { text: JSON.stringify({ steps: ['deposit-external', 'enable-trading', 'orders', 'withdraw-external', 'extra-withdrawals', 'cleanup'], profiles: [], flags: [] }), code: 0 },
    plans: [{ report: planReport(), code: 2 }, { ...plan({ funded: true }), ...known }],
    live: live(),
    earlier: [['mem://earlier-live.json', earlier]],
  });
  try {
    const r = await runStageD(k.ctx, fake);
    assert.equal(r.status, 'PASS', r.reason);
    assert.match(k.flat(), /already has a SoDEX account \(#4711\).*stopped at the step "withdraw-external"/);
    const run = fake.lives[0]!;
    assert.deepEqual(run.inv.only, ['withdraw-external', 'extra-withdrawals']);
    assert.equal(run.config!.allowExistingAccount, true);
    assert.deepEqual(run.argv.slice(run.argv.indexOf('--only'), run.argv.indexOf('--only') + 2), ['--only', 'withdraw-external,extra-withdrawals']);
  } finally {
    k.cleanup();
  }
});

test('a wallet that already has an account, and the owner stops: nothing runs', async () => {
  const k = kit({ argv: ['--stages', 'D'], lines: ['', 'y', ''], hidden: [KEY] });
  const fake = new FakeRunner({ plans: [{ report: planReport(), code: 2 }, { ...plan({ funded: true }), lines: ['20:00:00  SoDEX account     #4711'] }], live: live() });
  try {
    const r = await runStageD(k.ctx, fake);
    assert.equal(r.status, 'SKIPPED');
    assert.match(r.reason!, /already has a SoDEX account/);
    assert.equal(fake.lives.length, 0);
  } finally {
    k.cleanup();
  }
});

// --- profiles ---------------------------------------------------------------------------------

const CAPS = (profiles: string[]): FakeRunnerOptions['capabilities'] => ({ text: JSON.stringify({ steps: ['deposit-external', 'orders-spot'], profiles, flags: ['--profile'] }), code: 0 });

test('profiles: each one is previewed (what it needs) before the owner chooses; the choice goes to every later call', async () => {
  const k = kit({ argv: ['--stages', 'D'], lines: ['2', '', 'y', '', 'YES', ADDRESS], hidden: [KEY] });
  const fake = new FakeRunner({ capabilities: CAPS(['core', 'evm-tour']), plans: [{ report: planReport(), code: 2 }, { report: planReport(), code: 2 }, plan({ funded: true })], live: live() });
  try {
    const r = await runStageD(k.ctx, fake);
    assert.equal(r.status, 'PASS', r.reason);
    assert.deepEqual(fake.plans.map((p) => [p.inv.profile, p.inv.throwaway === true]), [['core', true], ['evm-tour', true], ['evm-tour', false], ['evm-tour', false]]);
    assert.equal(fake.lives[0]!.inv.profile, 'evm-tour');
    assert.deepEqual(fake.lives[0]!.argv.slice(fake.lives[0]!.argv.indexOf('--profile'), fake.lives[0]!.argv.indexOf('--profile') + 2), ['--profile', 'evm-tour']);
    const screen = k.flat();
    assert.match(screen, /Core - one chain, everything.*needs 25\.00 USDC on Arbitrum One \+ 0\.000200 ETH on Arbitrum One; estimated cost \$3\.36/);
    assert.match(k.screen(), /All chains[^\n]*: not available in this runner version/);
    assert.match(k.screen(), /Builder fee again[^\n]*: not available in this runner version/);
    assert.equal(k.ctx.shared.profile, 'evm-tour');
  } finally {
    k.cleanup();
  }
});

test('--profile with a name this runner version does not have: reported, not crashed, nothing asked', async () => {
  const k = kit({ argv: ['--stages', 'D', '--profile', 'all-chains'], lines: [], hidden: [KEY] });
  const fake = new FakeRunner({ capabilities: CAPS(['core']), plans: [{ report: planReport(), code: 2 }], live: live() });
  try {
    const r = await runStageD(k.ctx, fake);
    assert.equal(r.status, 'SKIPPED');
    assert.equal(r.reason, 'profile "all-chains" is not available in this runner version');
    assert.equal(k.prompter.hiddenAsked, 0);
    assert.equal(fake.plans.length, 0);
  } finally {
    k.cleanup();
  }
});

test('a runner without profiles (2026-10-02): one run, and the wished-for profiles are named as not available', async () => {
  const k = kit({ argv: ['--stages', 'D', '--plan-only'], lines: ['', 'y'], hidden: [KEY], interactive: false });
  const fake = new FakeRunner({ plans: [{ report: planReport(), code: 2 }, plan()] });
  try {
    const r = await runStageD(k.ctx, fake);
    assert.equal(r.status, 'PASS', r.reason);
    assert.match(k.flat(), /ONE live run and no profiles yet.*Not available in this runner version.*EVM tour.*All chains/);
    // The one run IS the core content: "core" is not listed as missing.
    assert.ok(!/Not available in this runner version[^:]*:\s+- Core/.test(k.flat()));
    assert.ok(fake.plans.every((p) => !p.argv.includes('--profile')));
    assert.match(r.notes.join(' '), /no profiles\): evm-tour, all-chains, builder-rerun\./);
  } finally {
    k.cleanup();
  }
});

// --- receivers --------------------------------------------------------------------------------

test('receivers: asked before the key, written to the private config, checked by the runner\'s next plan', async () => {
  const other = `0x${'c0'.repeat(20)}`;
  const k = kit({ argv: ['--stages', 'D', '--plan-only'], lines: [other, 'y'], hidden: [KEY], interactive: false });
  const accepted = planReport({ receiversNeeded: [] });
  const fake = new FakeRunner({ plans: [{ report: planReport(), code: 2 }, { report: accepted, code: 2 }, plan()] });
  try {
    await runStageD(k.ctx, fake);
    const asked = k.screen();
    assert.ok(asked.indexOf('Address for "valuechain"') < asked.indexOf('Private key of the test wallet'), 'receivers come before the key');
    assert.match(asked, /The runner accepts them/);
    const withReceiver = fake.saved.find((s) => (s.cfg.receivers as Record<string, unknown>).valuechain === other);
    assert.ok(withReceiver, 'the address is in the run config');
    assert.equal(fake.plans[1]!.key, null, 'the address is checked with a throwaway key - the real key has not been asked for yet');
    assert.equal((fake.plans[1]!.config!.receivers as Record<string, unknown>).valuechain, other);
  } finally {
    k.cleanup();
  }
});

test('receivers: something key-sized typed as an address is refused and not written anywhere', async () => {
  const k = kit({ argv: ['--stages', 'D', '--plan-only'], lines: [KEY, 'y'], hidden: [KEY], interactive: false });
  const fake = new FakeRunner({ plans: [{ report: planReport(), code: 2 }, plan()] });
  try {
    await runStageD(k.ctx, fake);
    assert.match(k.screen(), /size of a PRIVATE KEY[^\n]*Left out/);
    for (const s of fake.saved) assertNoKeyAnywhere(JSON.stringify(s.cfg), 'a config file');
  } finally {
    k.cleanup();
  }
});

test('receivers: --yes never enters an address', async () => {
  const k = kit({ argv: ['--stages', 'D', '--plan-only', '--yes'], lines: ['y'], hidden: [KEY], interactive: false });
  const fake = new FakeRunner({ plans: [{ report: planReport(), code: 2 }, plan()] });
  try {
    await runStageD(k.ctx, fake);
    assert.match(k.screen(), /left out \(--yes never enters an address\)/);
    assert.ok(fake.saved.every((s) => (s.cfg.receivers as Record<string, unknown>).valuechain === ''));
  } finally {
    k.cleanup();
  }
});

// --- the runner's checks ----------------------------------------------------------------------

test('a check the runner reports as failed fails the stage even when the runner exits 0; a finding does not', async () => {
  const checks = [
    { id: 'builder-fee-default', title: 'first orders carry 20', status: 'pass' },
    { id: 'builder-fee-lowered', title: 'the next order carries 15', status: 'fail', detail: 'it still carried 20' },
    { id: 'builder-replace-keeps-builder', title: 'a replaced order keeps the builder', status: 'finding', detail: 'it does not' },
    { id: 'builder-income-matches', title: 'income', status: 'not-run' },
  ];
  const k = kit({ argv: ['--stages', 'D'], lines: HAPPY, hidden: [KEY] });
  const fake = new FakeRunner({ plans: [{ report: planReport(), code: 2 }, plan({ funded: true })], live: live({ checks }) });
  try {
    const r = await runStageD(k.ctx, fake);
    assert.equal(r.status, 'FAIL');
    assert.equal(r.reason, '1 check(s) of the live run failed');
    const rows = Object.fromEntries(r.items.filter((i) => i.group === 'runner checks').map((i) => [i.id, i.status]));
    assert.deepEqual(rows, { 'check-builder-fee-default': 'PASS', 'check-builder-fee-lowered': 'FAIL', 'check-builder-replace-keeps-builder': 'FINDING', 'check-builder-income-matches': 'SKIPPED' });
    assert.match(k.flat(), /1 of its checks FAILED.*the next order carries 15: it still carried 20/);
    assert.match(k.ctx.shared.next.join('\n'), /Read the 1 finding\(s\)/);

    const k2 = kit({ argv: ['--stages', 'D'], lines: HAPPY, hidden: [KEY] });
    const ok = new FakeRunner({ plans: [{ report: planReport(), code: 2 }, plan({ funded: true })], live: live({ checks: checks.filter((c) => c.status !== 'fail') }) });
    try {
      assert.equal((await runStageD(k2.ctx, ok)).status, 'PASS');
    } finally {
      k2.cleanup();
    }
  } finally {
    k.cleanup();
  }
});

test('with fee tiers on, the owner is told the fee-change test works once per wallet - before the run and in the summary', async () => {
  const withTiers = { ...EXAMPLE_CONFIG(), builder: { id: 12345, feePerps: 20, feeSpot: 20, maxFee: 20, required: true, revokeAtEnd: true, termsKeys: ['PUB'] } };
  const k = kit({ argv: ['--stages', 'D'], lines: HAPPY, hidden: [KEY] });
  const fake = new FakeRunner({ plans: [{ report: planReport(), code: 2 }, plan({ funded: true })], live: live(), existing: withTiers, names: NAMES_TIERS });
  try {
    await runStageD(k.ctx, fake);
    assert.match(k.flat(), /it works ONCE per wallet.*default fee for 30 days.*builderTiers\.ts forget --address 0x/);
    assert.match(k.ctx.shared.next.join('\n'), new RegExp(`forget --address ${ADDRESS}`));
    assert.deepEqual(fake.lives[0]!.config!.builder, withTiers.builder);
  } finally {
    k.cleanup();
  }
});

// --- the pieces -------------------------------------------------------------------------------

test('the dev server is down: stage D is skipped with what to do, and nothing is started', async () => {
  const k = kit({ argv: ['--stages', 'D'], devServerUp: false });
  const fake = new FakeRunner({ plans: [{ report: planReport(), code: 2 }] });
  try {
    const r = await runStageD(k.ctx, fake);
    assert.equal(r.status, 'SKIPPED');
    assert.equal(fake.calls.length, 0);
    assert.match(k.ctx.shared.next.join(' '), /npm run dev/);
  } finally {
    k.cleanup();
  }
});

test('a config file that holds a key stops everything before the runner sees it', async () => {
  const k = kit({ argv: ['--stages', 'D', '--plan-only', '--throwaway-key'], interactive: false });
  const fake = new FakeRunner({ plans: [{ report: planReport(), code: 2 }], existing: { ...EXAMPLE_CONFIG(), note: KEY } });
  try {
    const r = await runStageD(k.ctx, fake);
    assert.equal(r.status, 'FAIL');
    assert.match(r.reason!, /size of a private key at: note/);
    assert.equal(fake.plans.length, 0);
    assertNoKeyAnywhere(k.screen(), 'the screen');
  } finally {
    k.cleanup();
  }
});

test('capabilities: asked once, remembered; a runner that cannot be asked falls back without failing', async () => {
  const k = kit({ argv: ['--stages', 'D'] });
  const fake = new FakeRunner({ capabilities: CAPS(['core']), plans: [] });
  try {
    const a = await detectCapabilities(k.ctx, fake);
    const b = await detectCapabilities(k.ctx, fake);
    assert.equal(a, b);
    assert.equal(fake.calls.length, 1);
    assert.deepEqual(a.profiles, ['core']);
    const k2 = kit({ argv: ['--stages', 'D'] });
    const broken = { ...fake, runner: async () => { throw new Error('spawn failed'); } } as unknown as FakeRunner;
    try {
      assert.equal((await detectCapabilities(k2.ctx, broken)).source, 'defaults');
    } finally {
      k2.cleanup();
    }
  } finally {
    k.cleanup();
  }
});

test('askKey: a bad key is explained and asked again; the address is shown; "no" asks for another wallet', async () => {
  const second = generatePrivateKey();
  const k = kit({ lines: ['n', 'y'], hidden: ['', `0x${'1'.repeat(40)}`, KEY, second] });
  try {
    const held = await askKey(k.ctx, 'the test wallet');
    assert.equal(held!.key, second);
    assert.equal(held!.address, privateKeyToAccount(second).address);
    const screen = k.flat();
    assert.match(screen, /Nothing was entered/);
    assert.match(screen, /wallet ADDRESS \(40 hex characters\)/);
    assert.match(k.screen(), new RegExp(`This key controls the wallet {2}${ADDRESS}`));
    // Both keys stay redacted for the rest of the session.
    assert.equal(k.ctx.out.redact(`a ${KEY} b ${second}`), 'a [redacted key] b [redacted key]');
  } finally {
    k.cleanup();
  }
});

test('waiting for funds: one plan per round, each read-only with --registry-only; "arrived" is noticed', async () => {
  const k = kit({ waits: [null, null] });
  // Round 2: the USDC has arrived, the gas has not.
  const half = plan();
  const body = (half.report as { plan: { checklist: string[]; problems: string[] } }).plan;
  body.checklist[0] = '[x] Arbitrum One     25.00 USDC  (deposit) - wallet holds 25.00';
  body.problems = ['fund the wallet: 0.000200 ETH on Arbitrum One (it holds 0.00)'];
  const fake = new FakeRunner({ plans: [plan(), half, plan({ funded: true })] });
  try {
    const first = await planOnce(k.ctx, fake, { config: 'c.json', key: KEY, throwaway: false, registryOnly: true, profile: null, only: null, logName: 'x.log' });
    const w = await waitForFunding(k.ctx, fake, first, { config: 'c.json', key: KEY, address: ADDRESS, profile: null, only: null, maxWaitMs: null });
    assert.equal(w.state, 'ready');
    assert.match(k.screen(), /something arrived\. Still missing: 0\.000200 ETH on Arbitrum One/);
    assert.ok(fake.plans.every((p) => p.inv.registryOnly === true && p.key === KEY));
    assert.equal(fake.plans.length, 3);
  } finally {
    k.cleanup();
  }
});

test('waiting for funds without a console: one look, no loop', async () => {
  const k = kit({ interactive: false });
  const fake = new FakeRunner({ plans: [plan()] });
  try {
    const first = await planOnce(k.ctx, fake, { config: 'c.json', key: KEY, throwaway: false, registryOnly: true, profile: null, only: null, logName: 'x.log' });
    const w = await waitForFunding(k.ctx, fake, first, { config: 'c.json', key: KEY, address: ADDRESS, profile: null, only: null, maxWaitMs: 0 });
    assert.equal(w.state, 'not-funded');
    assert.equal(fake.plans.length, 1);
  } finally {
    k.cleanup();
  }
});

test('moneyRun for a forced profile the runner does not have: reported, nothing asked', async () => {
  const k = kit({ lines: [], hidden: [KEY] });
  const fake = new FakeRunner({ plans: [{ report: planReport(), code: 2 }] });
  try {
    const r = await moneyRun(k.ctx, fake, { what: 'the test wallet', profile: 'nightly', headings: false });
    assert.equal(r.status, 'SKIPPED');
    assert.match(r.reason!, /nightly/);
    assert.equal(k.prompter.hiddenAsked, 0);
  } finally {
    k.cleanup();
  }
});
