/**
 * Stage C from the first question to the last, with stand-ins for the builder
 * check, the tier tool, the terms endpoint and the .env.local file.
 *   npx tsx --test e2e/guide/stageC.test.ts        (from apps/web)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { judgeBuilder, readTiersJson, type BuilderCheck, type TiersInfo } from './builder';
import { planReport } from './fixtures';
import { runStageC, type CDeps, type TiersCall } from './stageC';
import { TERMS_CHAIN, keyIdOf, termsMessage } from './terms';
import { FakeRunner, NAMES_TIERS, kit, type FakeRunnerOptions } from './testkit';

const BUILDER = `0x${'b1'.repeat(20)}`;
const ELIGIBLE = judgeBuilder({ address: BUILDER, builderId: 12345, spot: 130.5, perps: 102 });
const LOW = judgeBuilder({ address: BUILDER, builderId: 12345, spot: 130.5, perps: 40 });

/** The server's terms key, made for this test: its public half is what the tier tool prints. */
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const PUB = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
const TIERS: TiersInfo = { configPath: 'C:\\data\\builder-tiers.json', keyPath: 'C:\\data\\builder-terms.key', publicKey: PUB, keyId: keyIdOf(PUB), builderId: 12345, tiers: [{ minVolumeUsd: 0, perps: 20, spot: 20 }, { minVolumeUsd: 10, perps: 15, spot: 20 }], maxFeeRate: 20, valid: true, problems: [] };

interface FakeC {
  deps: CDeps;
  d: FakeRunner;
  checked: string[];
  tierCalls: Array<[string, number | undefined]>;
  termsAsked: number;
  env: { text: string | null; reads: number; writes: string[] };
}

function fakeC(o: { checks?: Array<BuilderCheck | null>; tiers?: Partial<Record<'init' | 'status', TiersCall>>; signs?: boolean; env?: string | null; runner?: FakeRunnerOptions; resolve?: string | null } = {}): FakeC {
  const d = new FakeRunner(o.runner ?? { plans: [{ report: planReport(), code: 2 }], names: NAMES_TIERS });
  const checks = [...(o.checks ?? [ELIGIBLE])];
  const f: FakeC = { deps: null as unknown as CDeps, d, checked: [], tierCalls: [], termsAsked: 0, env: { text: o.env === undefined ? null : o.env, reads: 0, writes: [] } };
  f.deps = {
    d,
    nonce: () => 'n0nce_n0nce_n0nce_1234',
    checkBuilder: async (address) => {
      f.checked.push(address);
      const c = checks.length > 1 ? checks.shift()! : checks[0]!;
      return c ? { check: c, error: null } : { check: null, error: 'SoDEX did not answer' };
    },
    resolveAccount: async (id) => (o.resolve === null ? { address: null, error: 'SoDEX knows no account with that id' } : { address: o.resolve ?? BUILDER, error: id ? null : 'x' }),
    tiers: async (cmd, builderId) => {
      f.tierCalls.push([cmd, builderId]);
      return o.tiers?.[cmd] ?? { present: false, info: null, leaked: false, error: null };
    },
    terms: async (address, nonce) => {
      f.termsAsked++;
      const fields = { chain: TERMS_CHAIN, builderId: 12345, address, perps: 20, spot: 20, nonce, issued: 1_790_000_000_000, ttl: 600_000 };
      const sig = o.signs === false ? null : sign(null, Buffer.from(termsMessage(fields), 'utf8'), privateKey).toString('base64url');
      return { status: 200, cacheControl: 'no-store', json: { ok: true, chain: fields.chain, builderId: fields.builderId, address, fee: { perps: 20, spot: 20 }, nonce, issued: fields.issued, ttl: fields.ttl, keyId: keyIdOf(PUB), sig, default: { perps: 20, spot: 20 }, tier: { index: 0, next: { atUsd: 10, fee: { perps: 15, spot: 20 } } }, flags: [] } };
    },
    env: {
      path: 'C:\\repo\\apps\\web\\.env.local',
      read: () => {
        f.env.reads++;
        return f.env.text;
      },
      write: (text) => {
        f.env.writes.push(text);
        f.env.text = text;
      },
    },
  };
  return f;
}

const PRESENT = (info: TiersInfo): TiersCall => ({ present: true, info, leaked: false, error: null });

test('skip: the builder tests are off, nothing is checked or written', async () => {
  const k = kit({ argv: ['--stages', 'C'], lines: ['2'] });
  const f = fakeC();
  try {
    const r = await runStageC(k.ctx, f.deps);
    assert.equal(r.status, 'SKIPPED');
    assert.equal(k.ctx.shared.builder, null);
    assert.deepEqual(f.checked, []);
    assert.deepEqual(f.d.saved, []);
    assert.match(k.screen(), /A BUILDER ACCOUNT is the SoDEX account that receives the ValueDesk fee/);
    assert.match(k.screen(), /PARKED, not spent/);
    assert.match(k.screen(), /Nothing here creates, funds or moves money on a builder account/);
    assert.ok(!/Create one/.test(k.screen()), 'no way to create a builder account is offered');
  } finally {
    k.cleanup();
  }
});

test('--yes with no builder named: the default is to skip (nothing is guessed)', async () => {
  const k = kit({ argv: ['--stages', 'C', '--yes'] });
  const f = fakeC();
  try {
    assert.equal((await runStageC(k.ctx, f.deps)).status, 'SKIPPED');
    assert.deepEqual(k.prompter.asked, []);
  } finally {
    k.cleanup();
  }
});

test('an existing builder, no tier tool yet: checked read-only, fees asked, config and settings written out', async () => {
  // 1 = I have one; the address; n = no tiers question is not asked when the tool... (it is asked: y); fees: Enter, 100; revoke: Enter; append: Enter (no)
  const k = kit({ argv: ['--stages', 'C'], lines: ['1', BUILDER, 'y', '', '100', '', ''] });
  const f = fakeC();
  try {
    const r = await runStageC(k.ctx, f.deps);
    assert.equal(r.status, 'PASS', r.reason);
    assert.deepEqual(k.prompter.unused, []);
    assert.deepEqual(f.checked, [BUILDER]);
    const screen = k.screen();
    for (const want of ['builder ID ........ 12345', 'Spot  ............. 130.5 vUSDC   ok (at least 100)', 'Perps ............. 102 vUSDC   ok (at least 100)', 'ELIGIBLE. The builder ID is 12345.', 'VITE_BUILDER_ID=12345', 'VITE_BUILDER_FEE_PERPS=50', 'VITE_BUILDER_FEE_SPOT=100', 'VITE_BUILDER_MAX_FEE=100']) assert.ok(screen.includes(want), want);
    assert.match(k.flat(), /fee-tier tool \(apps\/server\/tools\/builderTiers\.ts\) is not in this checkout yet/);
    // The builder section of the run config: required, with the fees typed, never acknowledged.
    const saved = f.d.saved.at(-1)!;
    assert.equal(saved.path, k.ctx.paths.config.config);
    assert.deepEqual(saved.cfg.builder, { id: 12345, feePerps: 50, feeSpot: 100, maxFee: 100, required: true, revokeAtEnd: true });
    assert.equal(saved.cfg.acknowledgeRealFunds, false);
    assert.deepEqual(k.ctx.shared.builder, { id: 12345, address: BUILDER, feePerps: 50, feeSpot: 100, maxFee: 100, revokeAtEnd: true });
    assert.equal(k.ctx.shared.builderAddress, BUILDER);
    // .env.local was offered and declined: not even read.
    assert.equal(f.env.reads, 0);
    assert.deepEqual(f.env.writes, []);
    assert.deepEqual(r.items.map((i) => `${i.id}:${i.status}`), ['builder-eligible:PASS', 'tiers:SKIPPED', 'config:PASS']);
  } finally {
    k.cleanup();
  }
});

test('fee tiers: set up through the server\'s tool, the first tier is the fee, the running server\'s signature is verified', async () => {
  const k = kit({ argv: ['--stages', 'C'], lines: ['1', '12345', '', '', ''] }); // I have one; its ID; tiers: yes; revoke: yes; append: no
  const f = fakeC({ tiers: { init: PRESENT(TIERS), status: PRESENT(TIERS) } });
  try {
    const r = await runStageC(k.ctx, f.deps);
    assert.equal(r.status, 'PASS', r.reason);
    assert.deepEqual(k.prompter.unused, []);
    assert.deepEqual(f.tierCalls, [['init', 12345], ['status', undefined]]);
    assert.equal(f.termsAsked, 1);
    assert.deepEqual(r.items.map((i) => `${i.id}:${i.status}`), ['builder-eligible:PASS', 'tiers:PASS', 'terms:PASS', 'config:PASS']);
    assert.match(r.items.find((i) => i.id === 'terms')!.detail!, /signature verifies \(key [0-9a-f]{8}\)/);
    const screen = k.flat();
    assert.match(screen, /2 bp on perps to start with, and 1\.5 bp once more than 10 USDC of volume is verified/);
    assert.match(screen, /The run starts on the first tier: perps 2 bp \(0\.02 %\), spot 2 bp \(0\.02 %\)/);
    assert.ok(k.screen().includes(`Public key ..... ${PUB}`));
    // The config carries the terms key; the app's lines too.
    assert.deepEqual(f.d.saved.at(-1)!.cfg.builder, { id: 12345, feePerps: 20, feeSpot: 20, maxFee: 20, required: true, revokeAtEnd: true, termsKeys: [PUB] });
    assert.deepEqual(k.ctx.shared.envLines, ['VITE_BUILDER_ID=12345', 'VITE_BUILDER_FEE_PERPS=20', 'VITE_BUILDER_FEE_SPOT=20', 'VITE_BUILDER_MAX_FEE=20', `VITE_BUILDER_TERMS_KEYS=${PUB}`]);
    assert.match(screen, /Saving that file makes the web dev server reload by itself/);
  } finally {
    k.cleanup();
  }
});

test('fee tiers: a server that does not sign (or signs with another key) fails the stage', async () => {
  const k = kit({ argv: ['--stages', 'C', '--builder', BUILDER, '--yes'] });
  const f = fakeC({ tiers: { init: PRESENT(TIERS), status: PRESENT(TIERS) }, signs: false });
  try {
    const r = await runStageC(k.ctx, f.deps);
    assert.equal(r.status, 'FAIL');
    assert.match(r.items.find((i) => i.id === 'terms')!.detail!, /NOT SIGNED/);
    assert.equal(f.termsAsked, 4, 'the server is given a few seconds to pick the files up');
    assert.match(k.ctx.shared.next.join(' '), /does not serve signed fee terms that verify/);
  } finally {
    k.cleanup();
  }
});

test('fee tiers: the tool printing a private key stops the setup - none of its output is used or shown', async () => {
  const k = kit({ argv: ['--stages', 'C', '--builder', BUILDER, '--yes'] });
  const f = fakeC({ tiers: { init: { present: true, info: null, leaked: true, error: 'the tool printed something that looks like a private key' } } });
  try {
    const r = await runStageC(k.ctx, f.deps);
    assert.equal(r.items.find((i) => i.id === 'tiers')!.status, 'FAIL');
    assert.equal(f.termsAsked, 0);
    assert.equal(k.ctx.shared.builder!.termsKeys, undefined);
    assert.match(k.flat(), /STOP: the tier tool printed something that looks like a private key/);
  } finally {
    k.cleanup();
  }
});

test('fee tiers: files that belong to another builder are not overwritten - the owner gets the command', async () => {
  const k = kit({ argv: ['--stages', 'C', '--builder', BUILDER, '--yes'] });
  const other = { ...TIERS, builderId: 999 };
  const f = fakeC({ tiers: { init: PRESENT(other), status: PRESENT(other) } });
  try {
    const r = await runStageC(k.ctx, f.deps);
    assert.equal(r.items.find((i) => i.id === 'tiers')!.status, 'FAIL');
    assert.match(k.flat(), /builderTiers\.ts init --builder-id 12345 --test-tiers --force/);
    assert.equal(f.tierCalls.some(([, id]) => id === 999), false);
  } finally {
    k.cleanup();
  }
});

test('fee tiers: a refusal of the tool (exit 1) is shown in its own words, with what status says is in force', async () => {
  const k = kit({ argv: ['--stages', 'C', '--builder', BUILDER, '--yes'] });
  // What tools/builderTiers.ts init prints when the file on disk names another builder.
  const refused = readTiersJson(JSON.stringify({ error: 'the configuration file that exists names builder 999; --force replaces it', configPath: 'C:\\data\\builder-tiers.json' }, null, 2))!;
  const f = fakeC({ tiers: { init: { present: true, info: refused, leaked: false, error: 'the configuration file that exists names builder 999; --force replaces it' }, status: PRESENT({ ...TIERS, builderId: 999 }) } });
  try {
    const r = await runStageC(k.ctx, f.deps);
    const tiers = r.items.find((i) => i.id === 'tiers')!;
    assert.equal(tiers.status, 'FAIL');
    assert.match(tiers.detail!, /builderTiers\.ts init refused: the configuration file that exists names builder 999; --force replaces it/);
    assert.match(tiers.detail!, /the tiers file is for builder #999, not #12345/);
    assert.match(k.flat(), /builderTiers\.ts init --builder-id 12345 --test-tiers --force/);
    assert.equal(f.termsAsked, 0);
  } finally {
    k.cleanup();
  }
});

test('--no-tiers and "no": the tool is not run', async () => {
  const k = kit({ argv: ['--stages', 'C', '--builder', BUILDER, '--yes', '--no-tiers'] });
  const f = fakeC({ tiers: { init: PRESENT(TIERS), status: PRESENT(TIERS) } });
  const k2 = kit({ argv: ['--stages', 'C', '--builder', BUILDER], lines: ['n', '', '', '', ''] });
  const f2 = fakeC({ tiers: { init: PRESENT(TIERS), status: PRESENT(TIERS) } });
  try {
    await runStageC(k.ctx, f.deps);
    assert.deepEqual(f.tierCalls, []);
    assert.deepEqual(k.ctx.shared.builder, { id: 12345, address: BUILDER, feePerps: 50, feeSpot: 100, maxFee: 100, revokeAtEnd: true });
    await runStageC(k2.ctx, f2.deps);
    assert.deepEqual(f2.tierCalls, []);
  } finally {
    k.cleanup();
    k2.cleanup();
  }
});

test('not eligible: exactly what is missing and what to move - then the stage stops; nothing is moved, nothing else is asked', async () => {
  const k = kit({ argv: ['--stages', 'C', '--no-tiers'], lines: ['1', BUILDER] }); // have one; address
  const f = fakeC({ checks: [LOW, ELIGIBLE] });
  try {
    const r = await runStageC(k.ctx, f.deps);
    assert.equal(r.status, 'FAIL');
    assert.deepEqual(k.prompter.unused, []);
    assert.deepEqual(f.checked, [BUILDER], 'checked once; not re-read, not offered to fix');
    const screen = k.flat();
    assert.match(screen, /NOT ELIGIBLE YET: - Perps holds 40 vUSDC - it needs 100: short by 60 vUSDC\./);
    assert.match(screen, /1\. Deposit 29\.5 USDC \(or more\) to the builder account/);
    assert.match(screen, /2\. Then Transfer 60 vUSDC from "SoDEX Spot" to "SoDEX Futures" \(Perps\)/);
    assert.match(screen, /The guide does not move anything on a builder account/);
    assert.match(k.ctx.shared.next.join(' '), /not eligible yet: Deposit 29\.5 USDC/);
    assert.equal(k.ctx.shared.builder, undefined);
    assert.deepEqual(f.d.saved, []);
    assert.equal(f.d.lives.length, 0);
  } finally {
    k.cleanup();
  }
});

test('not eligible without anyone to ask (--yes): the stage fails with what is missing', async () => {
  const k = kit({ argv: ['--stages', 'C', '--builder', BUILDER, '--yes'] });
  const f = fakeC({ checks: [LOW] });
  try {
    const r = await runStageC(k.ctx, f.deps);
    assert.equal(r.status, 'FAIL');
    assert.match(r.reason!, /Perps holds 40 vUSDC/);
    assert.equal(k.ctx.shared.builder, undefined);
    assert.deepEqual(f.d.saved, []);
  } finally {
    k.cleanup();
  }
});

test('an account ID is resolved to its wallet through our own API; an unknown one asks for the address', async () => {
  const k = kit({ argv: ['--stages', 'C', '--builder', '12345', '--yes', '--no-tiers'] });
  const f = fakeC();
  try {
    assert.equal((await runStageC(k.ctx, f.deps)).status, 'PASS');
    assert.deepEqual(f.checked, [BUILDER]);
  } finally {
    k.cleanup();
  }
  const k2 = kit({ argv: ['--stages', 'C', '--builder', '777', '--yes'] });
  const f2 = fakeC({ resolve: null });
  try {
    const r = await runStageC(k2.ctx, f2.deps);
    assert.equal(r.status, 'FAIL');
    assert.match(r.reason!, /account #777 could not be resolved/);
    assert.deepEqual(f2.checked, []);
  } finally {
    k2.cleanup();
  }
});

test('a key typed where the builder address belongs is called a key, and asked again', async () => {
  const k = kit({ argv: ['--stages', 'C', '--no-tiers', '--no-revoke'], lines: ['1', `0x${'7d'.repeat(32)}`, BUILDER, '', '', ''] });
  const f = fakeC();
  try {
    assert.equal((await runStageC(k.ctx, f.deps)).status, 'PASS');
    assert.match(k.flat(), /That is the size of a PRIVATE KEY\. Never enter a key here/);
    assert.deepEqual(f.checked, [BUILDER]);
    assert.equal(k.ctx.shared.builder!.revokeAtEnd, false);
  } finally {
    k.cleanup();
  }
});

test('.env.local: only on a typed yes; only the missing lines; a line that is there is never changed', async () => {
  const existing = '# mine\nVITE_WALLETCONNECT_PROJECT_ID=abc\nVITE_BUILDER_ID=12345\nVITE_BUILDER_FEE_PERPS=10\n';
  const k = kit({ argv: ['--stages', 'C', '--builder', BUILDER], lines: ['', '', 'y'] }); // tiers: yes; revoke: yes; append: y
  const f = fakeC({ tiers: { init: PRESENT(TIERS), status: PRESENT(TIERS) }, env: existing });
  try {
    await runStageC(k.ctx, f.deps);
    assert.equal(f.env.writes.length, 1);
    const text = f.env.writes[0]!;
    assert.ok(text.startsWith(existing), 'what was there is still there, unchanged and in place');
    const added = text.slice(existing.length);
    assert.match(added, /^\n# Builder fee test settings - added by RUN-LIVE-TESTS on \d{4}-\d\d-\d\d/);
    assert.deepEqual(added.split('\n').filter((l) => l.startsWith('VITE_')), ['VITE_BUILDER_FEE_SPOT=20', 'VITE_BUILDER_MAX_FEE=20', `VITE_BUILDER_TERMS_KEYS=${PUB}`]);
    assert.match(k.flat(), /NOT changed: VITE_BUILDER_FEE_PERPS is already set to "10" \(this run uses "20"\)/);
    assert.match(k.ctx.shared.next.join(' '), /already sets VITE_BUILDER_FEE_PERPS to other values/);
  } finally {
    k.cleanup();
  }
});

test('.env.local: --yes never writes it - the default is no, and the file is not even read', async () => {
  const k = kit({ argv: ['--stages', 'C', '--builder', BUILDER, '--yes', '--no-tiers'] });
  const f = fakeC({ env: 'VITE_BUILDER_ID=1\n' });
  try {
    const r = await runStageC(k.ctx, f.deps);
    assert.equal(r.status, 'PASS', r.reason);
    assert.equal(f.env.reads, 0);
    assert.deepEqual(f.env.writes, []);
    assert.match(k.screen(), /Add the missing lines to \.env\.local now\? \[y\/N\] no {3}\(--yes: the default\)/);
    assert.deepEqual(k.prompter.asked, []);
  } finally {
    k.cleanup();
  }
});
