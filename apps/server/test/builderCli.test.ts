/**
 * tools/builderTiers.ts - the operator's tool (docs/BUILDER-TIERS.md §4):
 * `init` writes the configuration and the signing key, `status` says what is
 * on disk, `forget` removes one wallet from the ledger while the server runs.
 *
 * Also here: where the key file may never end up - a release, a backup, the
 * repository.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { platform } from 'node:os';
import { fileURLToPath } from 'node:url';

import { testTiers } from '../src/builder/config.js';
import { BuilderStore } from '../src/builder/store.js';
import { signerFromPem } from '../src/builder/terms.js';
import { OrderState } from '../src/builder/counting.js';
import { runTool, type ToolResult } from '../tools/builderTiers.js';
import { addr, tempDir } from './builderFakes.js';

const DIR = tempDir('vs-btiers-cli-');
const ENV = ['VALUESCAN_BUILDER_TIERS_FILE', 'VALUESCAN_BUILDER_TERMS_KEY_FILE', 'VALUESCAN_BUILDER_DB'] as const;

interface Place {
  dir: string;
  config: string;
  key: string;
  db: string;
  env: Record<string, string>;
}

let n = 0;
function place(): Place {
  const dir = join(DIR, `case-${n++}`);
  mkdirSync(dir, { recursive: true });
  const p = { dir, config: join(dir, 'state', 'builder-tiers.json'), key: join(dir, 'state', 'builder-terms.key'), db: join(dir, 'state', 'builder.db') };
  return { ...p, env: { VALUESCAN_BUILDER_TIERS_FILE: p.config, VALUESCAN_BUILDER_TERMS_KEY_FILE: p.key, VALUESCAN_BUILDER_DB: p.db } };
}

/** Run the tool against one place; the environment is put back afterwards. */
function tool(p: Place, argv: string[], now?: number): ToolResult {
  const saved = ENV.map((k) => process.env[k]);
  Object.assign(process.env, p.env);
  try {
    return runTool(argv, now);
  } finally {
    ENV.forEach((k, i) => (saved[i] === undefined ? delete process.env[k] : (process.env[k] = saved[i])));
  }
}

const pemBody = (path: string): string => readFileSync(path, 'utf8').split('\n')[1]!;

test('init --test-tiers: writes the test configuration and a key, and prints the public half only', () => {
  const p = place();
  const r = tool(p, ['init', '--builder-id', '424242', '--test-tiers']);
  assert.equal(r.code, 0);
  assert.deepEqual(Object.keys(r.out), ['configPath', 'keyPath', 'publicKey', 'keyId', 'builderId', 'maxFeeRate', 'tiers', 'volumeDays', 'configWritten', 'keyWritten']);
  assert.deepEqual(
    { ...r.out, publicKey: '', keyId: '' },
    {
      configPath: p.config, keyPath: p.key, publicKey: '', keyId: '', builderId: 424242, maxFeeRate: 20,
      tiers: [{ minVolumeUsd: 0, perps: 20, spot: 20 }, { minVolumeUsd: 10, perps: 15, spot: 20 }], volumeDays: null,
      configWritten: true, keyWritten: true,
    },
  );
  // The file is exactly the test configuration: 2 bp, 1.5 bp on perps from 10 USD, no overrides.
  assert.deepEqual(JSON.parse(readFileSync(p.config, 'utf8')), testTiers(424242));
  assert.deepEqual(JSON.parse(readFileSync(p.config, 'utf8')), {
    builderId: 424242, maxFeeRate: 20,
    tiers: [{ minVolumeUsd: 0, perps: 20, spot: 20 }, { minVolumeUsd: 10, perps: 15, spot: 20 }],
    underpaid: { policy: 'default-fee', days: 30 },
  });
  // The key on disk is the one whose public half was printed - and the private half was not.
  const signer = signerFromPem(readFileSync(p.key, 'utf8'));
  assert.equal(r.out.publicKey, signer.publicKey);
  assert.equal(r.out.keyId, signer.keyId);
  assert.match(String(r.out.publicKey), /^[A-Za-z0-9_-]{43}$/);
  const printed = JSON.stringify(r.out);
  assert.ok(!printed.includes(pemBody(p.key)));
  assert.ok(!/PRIVATE/.test(printed));
  if (platform() !== 'win32') assert.equal(statSync(p.key).mode & 0o777, 0o600, 'owner only');
});

test('init: what exists is left alone - run twice it changes nothing; --force replaces the configuration, never the key', () => {
  const p = place();
  const first = tool(p, ['init', '--builder-id', '7', '--test-tiers']);
  const key = readFileSync(p.key, 'utf8');
  writeFileSync(p.config, JSON.stringify({ ...testTiers(7), tiers: [{ minVolumeUsd: 0, perps: 20, spot: 20 }, { minVolumeUsd: 500, perps: 12, spot: 20 }] }));
  const again = tool(p, ['init', '--builder-id', '7', '--test-tiers']);
  assert.equal(again.code, 0);
  assert.deepEqual({ c: again.out.configWritten, k: again.out.keyWritten }, { c: false, k: false });
  assert.equal(again.out.publicKey, first.out.publicKey);
  assert.deepEqual(again.out.tiers, [{ minVolumeUsd: 0, perps: 20, spot: 20 }, { minVolumeUsd: 500, perps: 12, spot: 20 }], 'the owner\'s own tiers are reported, not overwritten');

  // Another builder id in the file that exists: refused, nothing touched.
  const other = tool(p, ['init', '--builder-id', '8', '--test-tiers']);
  assert.equal(other.code, 1);
  assert.match(String(other.out.error), /names builder 7; --force replaces it/);
  assert.equal(JSON.parse(readFileSync(p.config, 'utf8')).builderId, 7);

  const forced = tool(p, ['init', '--builder-id', '8', '--test-tiers', '--force']);
  assert.equal(forced.code, 0);
  assert.deepEqual({ c: forced.out.configWritten, k: forced.out.keyWritten, id: forced.out.builderId }, { c: true, k: false, id: 8 });
  assert.equal(readFileSync(p.key, 'utf8'), key, 'the key a build has pinned is never replaced');
  assert.equal(forced.out.publicKey, first.out.publicKey);
  assert.deepEqual(JSON.parse(readFileSync(p.config, 'utf8')), testTiers(8));
});

test('init: a default fee instead of the test tiers; an invalid file that exists is reported, not used', () => {
  const p = place();
  const r = tool(p, ['init', '--builder-id', '9', '--fee-perps', '50', '--fee-spot', '30']);
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(readFileSync(p.config, 'utf8')), { builderId: 9, maxFeeRate: 50, tiers: [{ minVolumeUsd: 0, perps: 50, spot: 30 }], underpaid: { policy: 'default-fee', days: 30 } });
  // Fees SoDEX would refuse are refused here.
  const q = place();
  const bad = tool(q, ['init', '--builder-id', '9', '--fee-perps', '500', '--fee-spot', '30']);
  assert.equal(bad.code, 1);
  assert.match(JSON.stringify(bad.out.problems), /perps 500 is above 200/);
  assert.equal(existsSync(q.config), false);
  assert.equal(existsSync(q.key), false, 'nothing is created for a configuration that is refused');

  writeFileSync(p.config, '{ "builderId": 9 ');
  const broken = tool(p, ['init', '--builder-id', '9', '--test-tiers']);
  assert.equal(broken.code, 1);
  assert.match(String(broken.out.error), /is not valid; --force replaces it/);
  // A key file that is not a key is reported by its problem, never by its text.
  mkdirSync(dirname(q.key), { recursive: true });
  writeFileSync(q.key, '-----BEGIN PRIVATE KEY-----\nbm90IGEga2V5IGJ1dCBsb29rcyBwcml2YXRl\n-----END PRIVATE KEY-----\n');
  const noKey = tool(q, ['init', '--builder-id', '9', '--test-tiers']);
  assert.equal(noKey.code, 1);
  assert.match(String(noKey.out.error), /signing key file cannot be used/);
  assert.ok(!JSON.stringify(noKey.out).includes('bm90IGEga2V5'));
});

test('usage: what is not understood is refused with exit code 2 and changes nothing', () => {
  const p = place();
  for (const argv of [
    [], ['help'], ['init'], ['init', '--builder-id'], ['init', '--builder-id', 'abc', '--test-tiers'], ['init', '--builder-id', '0', '--test-tiers'],
    ['init', '--builder-id', '5'], ['init', '--builder-id', '5', '--fee-perps', '20'], ['init', '--builder-id', '5', '--test-tiers', '--fee-perps', '20', '--fee-spot', '20'],
    ['init', '--builder-id', '5', '--test-tiers', '--yes'], ['init', '--builder-id', '5', '--builder-id', '6', '--test-tiers'],
    ['status', 'extra'], ['status', '--address', 'all'],
  ]) {
    const r = tool(p, argv);
    assert.equal(r.code, 2, argv.join(' '));
    assert.equal(typeof r.out.error, 'string');
    assert.equal(typeof r.out.usage, 'string');
  }
  assert.equal(existsSync(p.config), false);
  assert.equal(existsSync(p.key), false);
  assert.equal(existsSync(p.db), false);
});

test('status: what is on disk and whether it is valid', () => {
  const p = place();
  const off = tool(p, ['status']);
  assert.equal(off.code, 0);
  assert.deepEqual(
    { valid: off.out.valid, problems: off.out.problems, builderId: off.out.builderId, tiers: off.out.tiers, publicKey: off.out.publicKey, keyId: off.out.keyId, c: off.out.configExists, k: off.out.keyExists, d: off.out.dbExists },
    { valid: false, problems: ['the file does not exist: the feature is off'], builderId: null, tiers: null, publicKey: null, keyId: null, c: false, k: false, d: false },
  );
  const made = tool(p, ['init', '--builder-id', '11', '--test-tiers']);
  const on = tool(p, ['status']);
  for (const k of ['configPath', 'valid', 'problems', 'builderId', 'tiers', 'keyPath', 'publicKey', 'keyId']) assert.ok(k in on.out, k);
  assert.deepEqual(
    { valid: on.out.valid, problems: on.out.problems, builderId: on.out.builderId, tiers: on.out.tiers, publicKey: on.out.publicKey, keyId: on.out.keyId },
    { valid: true, problems: [], builderId: 11, tiers: made.out.tiers, publicKey: made.out.publicKey, keyId: made.out.keyId },
  );
  assert.ok(!JSON.stringify(on.out).includes(pemBody(p.key)));
  assert.equal(existsSync(p.db), false, 'status creates nothing');

  writeFileSync(p.config, JSON.stringify({ ...testTiers(11), maxFeeRate: 5 }));
  const bad = tool(p, ['status']);
  assert.equal(bad.out.valid, false);
  assert.match(JSON.stringify(bad.out.problems), /perps 20 is above 5/);
  assert.equal(bad.out.builderId, null, 'an invalid file is not reported as if it were in force');
});

/** A ledger with one verified wallet (and a second one that must not be touched). */
function ledger(p: Place, wallet: string, other: string): void {
  const store = new BuilderStore(p.db, { now: 1_000 });
  for (const [a, id] of [[wallet, 1], [other, 2]] as const) {
    const w = store.createWallet(11, a, id, 5_000, 0);
    store.recordKeys(a, [{ name: 'valuescan-web', key: addr(0xdead + id) }], 5_000);
    store.recordFee(11, a, { at: 6_000, perps: 15, spot: 20 });
    store.commitFills({
      builder: 11, address: a, gen: w.createdAt, engine: 'perps', addMicro: 0, byDay: new Map(), queued: 1, noBuilder: { n: 0, at: 0 }, found: true,
      rows: [{ key: 'BTC-USD:1', orderId: '1', symbol: 'BTC-USD', clOrdID: 'vs-1', t: 5_500, lastT: 5_500, state: OrderState.pending, paidMicro: 12_400_000, rate: 20, countedMicro: 0, tries: 0, nextAt: 0 }],
      fills: [{ key: 'BTC-USD:9:1', t: 5_500 }],
      state: { hi: 5_500, swFrom: 0, swEnd: 0, swTop: 0, swPages: 0, sweptAt: 5_600 }, pruneFillsBefore: 0,
    });
    store.commitLookup({
      builder: 11, address: a, gen: w.createdAt, engine: 'perps', closed: true, addMicro: 12_400_000, byDay: new Map([[0, 12_400_000]]), now: 5_700, misses: 0,
      row: { key: 'BTC-USD:1', orderId: '1', symbol: 'BTC-USD', clOrdID: 'vs-1', t: 5_500, lastT: 5_500, state: OrderState.counted, paidMicro: 12_400_000, rate: 20, countedMicro: 12_400_000, tries: 1, nextAt: 0 },
      underpaid: { n: 1, at: 5_600 }, tampered: { n: 0, at: 0 },
      evidence: [{ kind: 'underpaid', engine: 'perps', orderId: '2', txHash: '0x' + 'ab'.repeat(32), at: 5_600, signer: addr(0xbad), keyName: null, fee: 5, owed: 20 }],
    });
  }
  store.close();
}

test('forget: one wallet, everything about it, in one go - and it stays known as forgotten', () => {
  const p = place();
  tool(p, ['init', '--builder-id', '11', '--test-tiers']);
  const wallet = '0x52908400098527886E0F7030069857D2E4169EE7';
  const other = addr(0x77);
  ledger(p, wallet.toLowerCase(), other);

  const seen = tool(p, ['status', '--address', wallet]);
  assert.equal(seen.code, 0);
  const report = seen.out.wallet as Record<string, unknown>;
  assert.deepEqual(report.rows, { wallets: 1, engines: 1, orders: 1, fills: 1, fees: 1, keys: 1, evidence: 1, days: 1 });
  assert.deepEqual(report.volume, { perpsUsd: 12.4, spotUsd: 0 });
  assert.equal((report.evidence as unknown[]).length, 1, 'the operator sees which order raised a flag');

  // The server has the ledger open while the tool runs.
  const server = new BuilderStore(p.db);
  const r = tool(p, ['forget', '--address', wallet], 9_000);
  assert.equal(r.code, 0);
  assert.deepEqual(r.out, {
    address: wallet.toLowerCase(), dbPath: p.db, dbExists: true,
    removed: { wallets: 1, engines: 1, orders: 1, fills: 1, fees: 1, keys: 1, evidence: 1, days: 1 }, total: 8, countsFrom: 9_000,
  });
  // The server sees it gone with its next read ...
  assert.equal(server.wallet(11, wallet.toLowerCase()), null);
  assert.deepEqual(server.rowsOf(wallet.toLowerCase()), { wallets: 0, engines: 0, orders: 0, fills: 0, fees: 0, keys: 0, evidence: 0, days: 0 });
  assert.equal(server.lastFee(11, wallet.toLowerCase()), null);
  assert.equal(server.keysOf(wallet.toLowerCase()).size, 0);
  // ... a write it still had in mind for that wallet does not go through ...
  assert.equal(server.commitFills({
    builder: 11, address: wallet.toLowerCase(), gen: 5_000, engine: 'perps', addMicro: 1, byDay: new Map([[0, 1]]), queued: 0, noBuilder: { n: 0, at: 0 }, found: false, rows: [], fills: [],
    state: { hi: 1, swFrom: 0, swEnd: 0, swTop: 0, swPages: 0, sweptAt: 1 }, pruneFillsBefore: null,
  }), false);
  assert.deepEqual(server.rowsOf(wallet.toLowerCase()), { wallets: 0, engines: 0, orders: 0, fills: 0, fees: 0, keys: 0, evidence: 0, days: 0 });
  // ... and when the wallet comes back, nothing from before the command is read again.
  assert.equal(server.floorOf(wallet.toLowerCase()), 9_000);
  assert.equal(server.createWallet(11, wallet.toLowerCase(), 1, 20_000, 20_000 - 7 * 86_400_000).floor, 9_000);
  // The other wallet, and the default fee on record, are untouched.
  assert.deepEqual(server.rowsOf(other), { wallets: 1, engines: 1, orders: 1, fills: 1, fees: 1, keys: 1, evidence: 1, days: 1 });
  assert.equal(server.wallet(11, other)!.perpsMicro, 12_400_000);
  server.close();

  // Forgetting it again removes the row the wallet got meanwhile and moves the mark.
  const twice = tool(p, ['forget', '--address', wallet.toLowerCase()], 30_000);
  assert.deepEqual(twice.out.removed, { wallets: 1, engines: 0, orders: 0, fills: 0, fees: 0, keys: 0, evidence: 0, days: 0 });
  assert.equal(twice.out.countsFrom, 30_000);
  const after = tool(p, ['status', '--address', wallet]);
  assert.deepEqual({ known: (after.out.wallet as Record<string, unknown>).known, forgottenAt: (after.out.wallet as Record<string, unknown>).forgottenAt }, { known: false, forgottenAt: 30_000 });
});

test('forget: anything that is not exactly one well-formed address is refused, and nothing is removed', () => {
  const p = place();
  tool(p, ['init', '--builder-id', '11', '--test-tiers']);
  const wallet = addr(0x55);
  ledger(p, wallet, addr(0x56));
  for (const argv of [
    ['forget'], ['forget', '--address'], ['forget', '--address', 'all'], ['forget', '--address', '*'], ['forget', '--address', '%'], ['forget', '--address', '0x'],
    ['forget', '--address', '0x123'], ['forget', '--address', wallet + '00'], ['forget', '--address', wallet.slice(2)], ['forget', '--address', `${wallet},${addr(0x56)}`],
    ['forget', '--address', wallet, '--address', addr(0x56)], ['forget', '--address', wallet, addr(0x56)], ['forget', wallet], ['forget', '--all'],
    ['forget', '--address', wallet, '--force'], ['forget', '--address', `${wallet} OR 1=1`], ['forget', '--address', "0x' OR ''='"],
  ]) {
    const r = tool(p, argv, 9_000);
    assert.equal(r.code, 2, argv.join(' '));
    assert.match(String(r.out.error), /forget: --address must be exactly one wallet address/);
  }
  const store = new BuilderStore(p.db, { readOnly: true });
  for (const a of [wallet, addr(0x56)]) assert.deepEqual(store.rowsOf(a), { wallets: 1, engines: 1, orders: 1, fills: 1, fees: 1, keys: 1, evidence: 1, days: 1 }, a);
  assert.equal(store.floorOf(wallet), 0);
  store.close();
});

test('forget: with no ledger there is nothing to forget, and none is created', () => {
  const p = place();
  const r = tool(p, ['forget', '--address', addr(1)], 9_000);
  assert.equal(r.code, 0);
  assert.deepEqual(r.out, { address: addr(1), dbPath: p.db, dbExists: false, removed: { wallets: 0, engines: 0, orders: 0, fills: 0, fees: 0, keys: 0, evidence: 0, days: 0 }, total: 0, countsFrom: null });
  assert.equal(existsSync(p.db), false);
});

test('fees on the go: milestones and hand-set fees are changed in the file the server reads, each change checked as a whole', () => {
  const p = place();
  assert.equal(tool(p, ['set-tier', '--from-usd', '10', '--perps', '15', '--spot', '20']).code, 1, 'no configuration yet: refused');
  tool(p, ['init', '--builder-id', '7', '--test-tiers']);
  const file = (): Record<string, any> => JSON.parse(readFileSync(p.config, 'utf8'));
  // A note the owner wrote by hand survives every change.
  writeFileSync(p.config, JSON.stringify({ ...file(), _note: 'mine' }));

  // A new milestone, in order; the same volume again changes its fees.
  const add = tool(p, ['set-tier', '--from-usd', '1000000', '--perps', '10', '--spot', '15']);
  assert.equal(add.code, 0, JSON.stringify(add.out));
  assert.deepEqual(file().tiers, [{ minVolumeUsd: 0, perps: 20, spot: 20 }, { minVolumeUsd: 10, perps: 15, spot: 20 }, { minVolumeUsd: 1000000, perps: 10, spot: 15 }]);
  assert.match(String(add.out.appliesWithin), /5 s/);
  tool(p, ['set-tier', '--from-usd', '10', '--perps', '12', '--spot', '18']);
  assert.deepEqual(file().tiers[1], { minVolumeUsd: 10, perps: 12, spot: 18 });
  assert.equal(file()._note, 'mine');

  // The default fee can be lowered; the answer says the web build pins it too.
  const def = tool(p, ['set-tier', '--from-usd', '0', '--perps', '18', '--spot', '20']);
  assert.equal(def.code, 0);
  assert.match(String(def.out.note), /VITE_BUILDER_FEE_PERPS/);

  // What would make the file invalid is refused and nothing is written.
  const before = readFileSync(p.config, 'utf8');
  for (const bad of [
    ['set-tier', '--from-usd', '50', '--perps', '19', '--spot', '20'], // above the default 18
    ['set-tier', '--from-usd', '0', '--perps', '30', '--spot', '20'], // above maxFeeRate 20
    ['set-tier', '--from-usd', '-1', '--perps', '5', '--spot', '5'],
    ['set-tier', '--from-usd', '10', '--perps', '1.5', '--spot', '5'],
    ['remove-tier', '--from-usd', '0'],
    ['remove-tier', '--from-usd', '77'],
    ['set-fee', '--address', '0x1234', '--perps', '5', '--spot', '5'],
    ['set-fee', '--address', addr(1), '--perps', '25', '--spot', '5'],
    ['clear-fee', '--address', addr(2)],
  ]) {
    const r = tool(p, bad);
    assert.ok(r.code === 1 || r.code === 2, `${bad.join(' ')} -> ${r.code}`);
    assert.equal(readFileSync(p.config, 'utf8'), before, `${bad.join(' ')} wrote nothing`);
  }

  assert.equal(tool(p, ['remove-tier', '--from-usd', '1000000']).code, 0);
  assert.deepEqual(file().tiers.map((t: { minVolumeUsd: number }) => t.minVolumeUsd), [0, 10]);

  // One wallet's own fee: set, changed (any spelling of the address), shown by status, cleared.
  const w = addr(3);
  assert.equal(tool(p, ['set-fee', '--address', w.toUpperCase().replace('0X', '0x'), '--perps', '5', '--spot', '10', '--note', 'partner deal']).code, 0);
  assert.equal(tool(p, ['set-fee', '--address', w, '--perps', '4', '--spot', '10']).code, 0);
  assert.deepEqual(file().overrides, { [w.toLowerCase()]: { perps: 4, spot: 10 } });
  assert.deepEqual(tool(p, ['status', '--address', w]).out.handSetFee, { perps: 4, spot: 10 });
  assert.equal(tool(p, ['clear-fee', '--address', w]).code, 0);
  assert.deepEqual(file().overrides, {});
  assert.equal(tool(p, ['status', '--address', w]).out.handSetFee, null);
});

test('as a command: one JSON object on stdout, the exit code says whether it worked', () => {
  const p = place();
  const script = fileURLToPath(new URL('../tools/builderTiers.ts', import.meta.url));
  const run = (...argv: string[]) =>
    spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', script, ...argv], {
      cwd: dirname(dirname(script)), env: { ...process.env, ...p.env }, encoding: 'utf8', timeout: 60_000,
    });
  const init = run('init', '--builder-id', '31337', '--test-tiers');
  assert.equal(init.status, 0, init.stderr);
  const out = JSON.parse(init.stdout);
  assert.equal(out.builderId, 31337);
  assert.equal(out.keyWritten, true);
  assert.ok(!init.stdout.includes(pemBody(p.key)) && !init.stderr.includes(pemBody(p.key)));
  const st = run('status');
  assert.equal(st.status, 0);
  assert.equal(JSON.parse(st.stdout).publicKey, out.publicKey);
  const bad = run('forget', '--address', 'all');
  assert.equal(bad.status, 2);
  assert.match(JSON.parse(bad.stdout).error, /exactly one wallet address/);
});

// --- where the key may never end up ------------------------------------------------------------

/** The repository root: the directory that holds deploy/ and apps/. */
function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'deploy', 'server', 'bin', 'backup.sh')) && existsSync(join(dir, '.gitignore'))) return dir;
    dir = dirname(dir);
  }
  throw new Error('repository root not found');
}

test('the key file is in no release, no backup and not in the repository', () => {
  const root = repoRoot();
  // Git: the default file names are ignored wherever they turn up, and so is every *.key and *.pem.
  const ignore = readFileSync(join(root, '.gitignore'), 'utf8').split(/\r?\n/).map((l) => l.trim());
  for (const pattern of ['builder-terms.key*', 'builder-tiers.json', '*.key', '*.pem', '*.db', '*.db-wal', '*.db-shm']) assert.ok(ignore.includes(pattern), `.gitignore lists ${pattern}`);
  // A server release is `git archive` of a tag - never the working tree - and is refused if it holds a key anyway.
  const release = readFileSync(join(root, 'deploy', 'release', 'release-server.sh'), 'utf8');
  assert.match(release, /git archive /);
  const guard = /grep -E '([^']+)'/.exec(release.split('\n').find((l) => l.includes('tar -tzf')) ?? '');
  assert.ok(guard, 'the release looks through its tarball');
  const refused = new RegExp(guard[1]!);
  for (const name of ['builder-terms.key', 'apps/server/builder-terms.key', 'state/terms.pem']) assert.ok(refused.test(name), `${name} stops a release`);
  // The backup copies the index database and nothing else: it never reads the state directory, where the key lives.
  const backup = readFileSync(join(root, 'deploy', 'server', 'bin', 'backup.sh'), 'utf8');
  assert.ok(!/builder|\.key|\.pem/.test(backup), 'the backup script names no key and no builder file');
  const uploads = backup.split('\n').filter((l) => /aws s3 cp/.test(l));
  assert.equal(uploads.length, 2);
  for (const l of uploads) assert.match(l, /\| aws s3 cp - "s3:\/\/\$OPS_BUCKET\/\$key(\.sha256)?"/, 'only the index copy and its checksum are uploaded');
  // The example environment does not put the key anywhere a release or the web would pick it up.
  const env = readFileSync(join(root, 'deploy', 'server', 'env', 'api.env.example'), 'utf8');
  assert.match(env, /builder-terms\.key/);
  assert.ok(!/BEGIN PRIVATE KEY/.test(env));
});
