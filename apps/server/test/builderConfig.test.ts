/**
 * Builder fee tiers: the configuration file and which fee it gives a wallet
 * (docs/BUILDER-TIERS.md §4). Validation is all-or-nothing, an invalid file
 * never replaces a valid one, a missing file is "off", and a fee is never
 * above the default of the first tier.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { FEE_CAP, TiersSource, defaultFee, parseTiers, testTiers, validateTiers, type TiersConfig } from '../src/builder/config.js';
import { FLAGS, MICRO, NO_FACTS, decide, tierIndex } from '../src/builder/tiers.js';
import { MemoryLog, tempDir } from './builderFakes.js';

const DIR = tempDir('vs-btiers-cfg-');
const WALLET = '0x00000000000000000000000000000000000000a1';
const PARTNER = '0x0000000000000000000000000000000000000001';
const DAY = 86_400_000;

/** The example of the contract page. */
const EXAMPLE = {
  builderId: 123456,
  maxFeeRate: 20,
  tiers: [
    { minVolumeUsd: 0, perps: 20, spot: 20 },
    { minVolumeUsd: 10, perps: 15, spot: 20 },
  ],
  overrides: { [PARTNER]: { perps: 10, spot: 10, note: 'partner' } },
  underpaid: { policy: 'default-fee', days: 30 },
};

const valid = (raw: unknown): TiersConfig => {
  const r = validateTiers(raw);
  assert.deepEqual(r.problems, []);
  return r.config!;
};

const problemsOf = (patch: Record<string, unknown>): string[] => {
  const r = validateTiers({ ...structuredClone(EXAMPLE), ...patch });
  assert.equal(r.config, null, `${JSON.stringify(patch)} must be rejected as a whole`);
  return r.problems;
};

// --- validation ---------------------------------------------------------------------

test('config: the example of the contract is valid, and read as written', () => {
  const cfg = valid(EXAMPLE);
  assert.equal(cfg.builderId, 123456);
  assert.equal(cfg.maxFeeRate, 20);
  assert.deepEqual(cfg.tiers, EXAMPLE.tiers);
  assert.deepEqual(cfg.overrides[PARTNER], { perps: 10, spot: 10, note: 'partner' });
  assert.deepEqual(cfg.underpaid, { policy: 'default-fee', days: 30 });
  assert.deepEqual(defaultFee(cfg), { perps: 20, spot: 20 });
  // Nothing can change it in memory afterwards.
  assert.throws(() => ((cfg.tiers as unknown as Array<{ perps: number }>)[1]!.perps = 1), TypeError);
  assert.throws(() => ((cfg as { builderId: number }).builderId = 1), TypeError);
});

test('config: --test-tiers is 2 bp on both engines, 1.5 bp on perps from 10 USD, no overrides', () => {
  const raw = testTiers(987);
  assert.deepEqual(raw, {
    builderId: 987,
    maxFeeRate: 20,
    tiers: [
      { minVolumeUsd: 0, perps: 20, spot: 20 },
      { minVolumeUsd: 10, perps: 15, spot: 20 },
    ],
    underpaid: { policy: 'default-fee', days: 30 },
  });
  const cfg = valid(raw);
  assert.deepEqual(cfg.overrides, {});
});

test('config: what is left out has a default; overrides are optional, underpaid defaults to default-fee for 30 days', () => {
  const cfg = valid({ builderId: 1, maxFeeRate: 200, tiers: [{ minVolumeUsd: 0, perps: 50, spot: 0 }] });
  assert.deepEqual(cfg.overrides, {});
  assert.deepEqual(cfg.underpaid, { policy: 'default-fee', days: 30 });
  assert.deepEqual(valid({ ...EXAMPLE, underpaid: { policy: 'ignore' } }).underpaid, { policy: 'ignore', days: 30 });
  // A note for the reader of the file is allowed anywhere a setting is.
  valid({ ...EXAMPLE, _comment: 'test tiers', tiers: [{ minVolumeUsd: 0, perps: 20, spot: 20, _why: 'default' }] });
});

test('config: the builder id and the ceiling', () => {
  for (const builderId of [0, -1, 1.5, '123', null, undefined, 2 ** 60]) {
    assert.match(problemsOf({ builderId }).join('\n'), /builderId/, String(builderId));
  }
  for (const maxFeeRate of [-1, 2001, 1.5, '20', undefined]) {
    assert.match(problemsOf({ maxFeeRate }).join('\n'), /maxFeeRate/, String(maxFeeRate));
  }
});

test('config: a fee is a whole number within SoDEX\'s cap, the ceiling and the default of the first tier', () => {
  assert.deepEqual(FEE_CAP, { perps: 200, spot: 2000 });
  const tiers = (t: unknown[]) => problemsOf({ maxFeeRate: 2000, tiers: t }).join('\n');
  assert.match(tiers([{ minVolumeUsd: 0, perps: 201, spot: 20 }]), /perps 201 is above 200/);
  assert.match(tiers([{ minVolumeUsd: 0, perps: 20, spot: 2001 }]), /spot 2001 is above 2000/);
  assert.match(tiers([{ minVolumeUsd: 0, perps: 1.5, spot: 20 }]), /whole number/);
  assert.match(tiers([{ minVolumeUsd: 0, perps: -1, spot: 20 }]), /0 or more/);
  assert.match(tiers([{ minVolumeUsd: 0, perps: '20', spot: 20 }]), /whole number/);
  assert.match(tiers([{ minVolumeUsd: 0, spot: 20 }]), /perps/);
  // maxFeeRate caps every tier ...
  assert.match(problemsOf({ maxFeeRate: 19 }).join('\n'), /perps 20 is above 19/);
  // ... and no later tier may charge more than the first.
  assert.match(tiers([{ minVolumeUsd: 0, perps: 20, spot: 20 }, { minVolumeUsd: 10, perps: 21, spot: 20 }]), /tiers\[1\]: perps 21 is above the default fee 20/);
  assert.match(tiers([{ minVolumeUsd: 0, perps: 20, spot: 20 }, { minVolumeUsd: 10, perps: 15, spot: 25 }]), /tiers\[1\]: spot 25 is above the default fee 20/);
  // 0 is a fee.
  valid({ builderId: 1, maxFeeRate: 20, tiers: [{ minVolumeUsd: 0, perps: 20, spot: 0 }, { minVolumeUsd: 5, perps: 0, spot: 0 }] });
});

test('config: tiers start at 0 and rise strictly', () => {
  const tiers = (t: unknown) => problemsOf({ tiers: t }).join('\n');
  assert.match(tiers([]), /at least one tier/);
  assert.match(tiers('none'), /at least one tier/);
  assert.match(tiers([{ minVolumeUsd: 5, perps: 20, spot: 20 }]), /must start at minVolumeUsd 0/);
  assert.match(tiers([{ minVolumeUsd: 0, perps: 20, spot: 20 }, { minVolumeUsd: 0, perps: 15, spot: 20 }]), /tiers\[1\]: minVolumeUsd must be above/);
  assert.match(tiers([{ minVolumeUsd: 0, perps: 20, spot: 20 }, { minVolumeUsd: 100, perps: 15, spot: 20 }, { minVolumeUsd: 50, perps: 10, spot: 20 }]), /tiers\[2\]: minVolumeUsd must be above/);
  assert.match(tiers([{ minVolumeUsd: -1, perps: 20, spot: 20 }]), /minVolumeUsd must be a number/);
  assert.match(tiers([{ minVolumeUsd: Number.NaN, perps: 20, spot: 20 }]), /minVolumeUsd must be a number/);
  assert.match(tiers([null]), /tiers\[0\] must be an object/);
  assert.match(tiers(Array.from({ length: 33 }, (_, i) => ({ minVolumeUsd: i, perps: 20, spot: 20 }))), /at most 32/);
});

test('config: overrides are wallets, within the same limits, each once', () => {
  const ov = (o: unknown) => problemsOf({ overrides: o }).join('\n');
  assert.match(ov({ 'not-an-address': { perps: 10, spot: 10 } }), /must be a wallet address/);
  assert.match(ov({ [PARTNER]: { perps: 25, spot: 10 } }), /perps 25 is above 20/);
  assert.match(ov({ [PARTNER]: { perps: 10 } }), /spot/);
  assert.match(ov({ [PARTNER]: 'vip' }), /must be an object/);
  assert.match(ov({ [PARTNER]: { perps: 10, spot: 10, note: 'x'.repeat(201) } }), /note/);
  assert.match(ov({ '0x00000000000000000000000000000000000000AB': { perps: 10, spot: 10 }, '0x00000000000000000000000000000000000000ab': { perps: 5, spot: 5 } }), /listed twice/);
  assert.match(ov([]), /overrides must be an object/);
  // An override above the first tier's fee, with a ceiling that would allow it.
  const r = validateTiers({ ...EXAMPLE, maxFeeRate: 100, overrides: { [PARTNER]: { perps: 30, spot: 10 } } });
  assert.match(r.problems.join('\n'), /perps 30 is above the default fee 20/);
  // Keys are stored lower-case, whatever the file says.
  const cfg = valid({ ...EXAMPLE, overrides: { '0x00000000000000000000000000000000000000AB': { perps: 10, spot: 10 } } });
  assert.deepEqual(Object.keys(cfg.overrides), ['0x00000000000000000000000000000000000000ab']);
});

test('config: the underpaid policy', () => {
  const up = (u: unknown) => problemsOf({ underpaid: u }).join('\n');
  assert.match(up({ policy: 'ban', days: 30 }), /policy must be/);
  assert.match(up({ policy: 'default-fee', days: 0 }), /days/);
  assert.match(up({ policy: 'default-fee', days: 1.5 }), /days/);
  assert.match(up('default-fee'), /underpaid must be an object/);
});

test('config: a name the code does not know is a problem, not something to skip', () => {
  assert.match(problemsOf({ overides: {} }).join('\n'), /unknown setting "overides"/);
  assert.match(problemsOf({ tiers: [{ minVolumeUsd: 0, perps: 20, spot: 20, perp: 5 }] }).join('\n'), /tiers\[0\]: unknown setting "perp"/);
  assert.match(problemsOf({ overrides: { [PARTNER]: { perps: 10, spot: 10, fee: 1 } } }).join('\n'), /unknown setting "fee"/);
  assert.match(problemsOf({ underpaid: { policy: 'ignore', day: 3 } }).join('\n'), /underpaid: unknown setting "day"/);
  for (const notAnObject of [null, [], 'x', 7]) assert.equal(validateTiers(notAnObject).config, null);
});

test('config: text that is not JSON, or too large, is rejected with a reason', () => {
  assert.match(parseTiers('{ "builderId": 1,').problems[0]!, /not valid JSON/);
  assert.match(parseTiers(' '.repeat(3 * 1024 * 1024)).problems[0]!, /larger than/);
  assert.deepEqual(parseTiers(JSON.stringify(EXAMPLE)).problems, []);
});

test('config: every problem of a file is reported at once', () => {
  const r = validateTiers({ builderId: 0, maxFeeRate: -5, tiers: [{ minVolumeUsd: 3, perps: 999, spot: 'x' }], underpaid: { policy: 'x' }, extra: 1 });
  assert.equal(r.config, null);
  assert.ok(r.problems.length >= 5, r.problems.join(' | '));
});

// --- tier selection -------------------------------------------------------------------

const CFG = valid({
  builderId: 123456,
  maxFeeRate: 20,
  tiers: [
    { minVolumeUsd: 0, perps: 20, spot: 20 },
    { minVolumeUsd: 10, perps: 15, spot: 20 },
    { minVolumeUsd: 1000, perps: 10, spot: 15 },
  ],
  overrides: { [PARTNER]: { perps: 5, spot: 5, note: 'a partner; this text is the operator\'s' } },
  underpaid: { policy: 'default-fee', days: 30 },
});
const NOW = 1_790_000_000_000;
const vol = (perpsUsd: number, spotUsd = 0) => ({ ...NO_FACTS, perpsMicro: Math.round(perpsUsd * MICRO), spotMicro: Math.round(spotUsd * MICRO) });

test('tiers: the tier is the last one whose threshold the total volume has reached', () => {
  assert.equal(tierIndex(CFG, 0), 0);
  assert.equal(tierIndex(CFG, 9_999_999), 0);
  assert.equal(tierIndex(CFG, 10 * MICRO), 1, 'from 10 USD on, not above it');
  assert.equal(tierIndex(CFG, 999.999999 * MICRO), 1);
  assert.equal(tierIndex(CFG, 1000 * MICRO), 2);
  assert.equal(tierIndex(CFG, 1e12 * MICRO), 2);
});

test('tiers: a wallet nothing is known about pays the default and is shown the next tier', () => {
  const d = decide(CFG, WALLET, NO_FACTS, NOW);
  assert.deepEqual(d.fee, { perps: 20, spot: 20 });
  assert.deepEqual(d.default, { perps: 20, spot: 20 });
  assert.deepEqual(d.tier, { index: 0, next: { atUsd: 10, fee: { perps: 15, spot: 20 } } });
  assert.deepEqual(d.flags, []);
});

test('tiers: perps and spot volume count together; the last tier has no next', () => {
  assert.deepEqual(decide(CFG, WALLET, vol(6, 3.99), NOW).fee, { perps: 20, spot: 20 });
  const one = decide(CFG, WALLET, vol(6, 4), NOW);
  assert.deepEqual(one.fee, { perps: 15, spot: 20 });
  assert.deepEqual(one.tier, { index: 1, next: { atUsd: 1000, fee: { perps: 10, spot: 15 } } });
  const top = decide(CFG, WALLET, vol(400, 600), NOW);
  assert.deepEqual(top.fee, { perps: 10, spot: 15 });
  assert.deepEqual(top.tier, { index: 2, next: null });
});

test('tiers: an underpaid or tampered order in the last `days` days puts the wallet on the default fee', () => {
  for (const flag of ['underpaid', 'tampered'] as const) {
    const facts = { ...vol(5000), [`${flag}At`]: NOW - 29 * DAY };
    const d = decide(CFG, WALLET, facts, NOW);
    assert.deepEqual(d.fee, { perps: 20, spot: 20 }, flag);
    assert.deepEqual(d.flags, [flag]);
    assert.equal(d.tier.index, 2, 'the tier shown is still the volume\'s');
    // After the window it is over, and so is the flag.
    const later = decide(CFG, WALLET, { ...vol(5000), [`${flag}At`]: NOW - 30 * DAY }, NOW);
    assert.deepEqual(later.fee, { perps: 10, spot: 15 }, flag);
    assert.deepEqual(later.flags, []);
  }
});

test('tiers: policy "ignore" shows the flag and leaves the fee alone', () => {
  const cfg = valid({ ...structuredClone(EXAMPLE), underpaid: { policy: 'ignore', days: 30 } });
  const d = decide(cfg, WALLET, { ...vol(50), underpaidAt: NOW - DAY, tamperedAt: NOW - DAY }, NOW);
  assert.deepEqual(d.fee, { perps: 15, spot: 20 });
  assert.deepEqual(d.flags, ['underpaid', 'tampered']);
});

test('tiers: a fee set by hand wins over the tier and over the policy, whatever the case of the address', () => {
  const d = decide(CFG, PARTNER, { ...NO_FACTS, underpaidAt: NOW - DAY }, NOW);
  assert.deepEqual(d.fee, { perps: 5, spot: 5 });
  assert.deepEqual(d.flags, ['underpaid', 'override']);
  assert.deepEqual(decide(CFG, PARTNER.toUpperCase().replace('0X', '0x'), NO_FACTS, NOW).fee, { perps: 5, spot: 5 });
});

test('tiers: `no-builder` is a flag only - it never changes the fee', () => {
  const d = decide(CFG, WALLET, { ...vol(50), noBuilderAt: NOW - DAY }, NOW);
  assert.deepEqual(d.fee, { perps: 15, spot: 20 });
  assert.deepEqual(d.flags, ['no-builder']);
});

test('tiers: whatever the inputs, the fee is never above the default and the flags are the four named ones', () => {
  const facts = [NO_FACTS, vol(5), vol(50), vol(1e9), { ...vol(50), underpaidAt: NOW - 1 }, { ...vol(50), tamperedAt: NOW - 1, noBuilderAt: NOW - 1, underpaidAt: NOW - 1 }];
  for (const f of facts) {
    for (const a of [WALLET, PARTNER]) {
      const d = decide(CFG, a, f, NOW);
      assert.ok(d.fee.perps <= d.default.perps && d.fee.spot <= d.default.spot);
      assert.ok(Number.isInteger(d.fee.perps) && Number.isInteger(d.fee.spot) && d.fee.perps >= 0 && d.fee.spot >= 0);
      for (const flag of d.flags) assert.ok(FLAGS.includes(flag), flag);
      // The operator's note about a wallet is in the file, and nowhere in a decision.
      assert.ok(!JSON.stringify(d).includes('partner'));
    }
  }
  assert.deepEqual([...FLAGS].sort(), ['no-builder', 'override', 'tampered', 'underpaid']);
});

// --- the file on disk --------------------------------------------------------------------

/** Write the file and move its time forward, so two writes within one clock tick still differ. */
let stamp = Date.now();
function write(path: string, body: unknown): void {
  writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body));
  stamp += 2_000;
  utimesSync(path, stamp / 1000, stamp / 1000);
}

test('file: missing = off; a valid file switches the feature on without a restart', async () => {
  const path = join(DIR, 'a-tiers.json');
  const log = new MemoryLog();
  const src = new TiersSource(path, log);
  src.loadSync();
  assert.equal(src.current(), null);
  assert.deepEqual({ ...src.status(), path: '' }, { path: '', exists: false, valid: false, problems: [], loadedAt: null });

  write(path, EXAMPLE);
  assert.equal(await src.refresh(), true, 'the configuration in force changed');
  assert.equal(src.current()!.builderId, 123456);
  assert.equal(src.status().valid, true);
  assert.equal(await src.refresh(), false, 'an unchanged file is not read again');
  assert.equal(log.lines.filter((l) => /configuration loaded/.test(l.msg)).length, 1);
});

test('file: a changed file takes effect; an invalid one is rejected as a whole and the last valid one stays in force', async () => {
  const path = join(DIR, 'b-tiers.json');
  const log = new MemoryLog();
  const src = new TiersSource(path, log);
  write(path, EXAMPLE);
  src.loadSync();
  const first = src.current()!;

  write(path, { ...EXAMPLE, tiers: [{ minVolumeUsd: 0, perps: 20, spot: 20 }, { minVolumeUsd: 25, perps: 12, spot: 20 }] });
  assert.equal(await src.refresh(), true);
  assert.equal(src.current()!.tiers[1]!.perps, 12);

  const inForce = src.current();
  write(path, { ...EXAMPLE, tiers: [{ minVolumeUsd: 0, perps: 999, spot: 20 }] });
  assert.equal(await src.refresh(), false, 'nothing changed in force');
  assert.equal(src.current(), inForce);
  const st = src.status();
  assert.equal(st.valid, false);
  assert.match(st.problems.join('\n'), /perps 999/);
  assert.ok(log.lines.some((l) => l.level === 'error' && /rejected/.test(l.msg) && l.o.inForce === 'the last valid configuration'));

  write(path, '{ half a file');
  await src.refresh();
  assert.equal(src.current(), inForce, 'a half-written file changes nothing either');

  write(path, EXAMPLE);
  assert.equal(await src.refresh(), true);
  assert.deepEqual(src.current(), first);
  assert.equal(src.status().valid, true);
});

test('file: an invalid file with nothing valid before it leaves the feature off; a deleted file switches it off', async () => {
  const path = join(DIR, 'c-tiers.json');
  const log = new MemoryLog();
  const src = new TiersSource(path, log);
  write(path, { builderId: 0 });
  src.loadSync();
  assert.equal(src.current(), null);
  assert.ok(log.lines.some((l) => l.level === 'error' && l.o.inForce === 'none - the feature is off'));

  write(path, EXAMPLE);
  await src.refresh();
  assert.ok(src.current());
  rmSync(path);
  assert.equal(await src.refresh(), true);
  assert.equal(src.current(), null, 'deleting the file is the kill switch');
  assert.equal(src.status().exists, false);
  assert.ok(log.lines.some((l) => l.level === 'warn' && /is gone/.test(l.msg)));
});

test('config: volumeDays - the tiers go by the last 1 to 90 days, or (left out) by lifetime volume', () => {
  assert.equal(valid(EXAMPLE).volumeDays, null, 'left out: lifetime');
  assert.equal(valid({ ...structuredClone(EXAMPLE), volumeDays: 14 }).volumeDays, 14);
  assert.equal(valid({ ...structuredClone(EXAMPLE), volumeDays: 90 }).volumeDays, 90);
  for (const bad of [0, 91, 14.5, '14', -1, null]) {
    assert.ok(problemsOf({ volumeDays: bad }).some((p) => /volumeDays/.test(p)), String(bad));
  }
});
