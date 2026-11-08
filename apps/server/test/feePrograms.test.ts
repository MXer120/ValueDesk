/**
 * Fee programs and VIP (owner 2026-11-08): the lowest of tier, programs and VIP per product, never below 0; a program
 * that ends puts the wallet back on its tier by itself; signed site terms end with the program; the executor's read
 * carries copy and bot fees with their end; the server's bot ladder is the engine's.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { testTiers, parseTiers } from '../src/builder/config.js';
import { BuilderService, isVip } from '../src/builder/service.js';
import { writeNewKeyFile, TERMS_TTL_MS } from '../src/builder/terms.js';
import { BOT_LADDER, VIP_PROGRAM_FEE, botLadderFee, lowered, soonestEnd } from '../src/builder/programs.js';
import { AdminStore, type FeeProgram } from '../src/admin/store.js';
import { BOT_FEE_LADDER, botFeeFor } from '../../../packages/copy-engine/src/policy.js';
import { BUILDER, CHAIN, Clock, FakeSodex, MemoryLog, addr, tempDir } from './builderFakes.js';

const A = addr(0xa1);
const T0 = 1_790_000_000_000;
const DAY = 86_400_000;
const prog = (p: Partial<FeeProgram>): FeeProgram => ({ id: 1, address: A, products: ['perps', 'spot', 'copy', 'bots'], fee: 0, from: T0 - 1, until: null, label: 'Test', addedAt: T0, addedBy: addr(1), ...p });
const cfgOf = () => {
  const r = parseTiers(JSON.stringify(testTiers(BUILDER)));
  if (!r.config) throw new Error(r.problems.join('; '));
  return r.config;
};

test('lowered: the lowest program per product; VIP is the last tier everywhere; not started or ended counts for nothing', () => {
  const cfg = cfgOf();
  const none = lowered([], false, cfg, T0);
  assert.deepEqual(none.fees, {});
  const vip = lowered([], true, cfg, T0);
  assert.deepEqual([vip.fees.perps?.fee, vip.fees.spot?.fee, vip.fees.copy?.fee, vip.fees.bots?.fee], [15, 20, 10, 1]);
  const two = lowered([prog({ fee: 8, products: ['perps'] }), prog({ id: 2, fee: 3, products: ['perps', 'copy'], until: T0 + DAY })], false, cfg, T0);
  assert.equal(two.fees.perps?.fee, 3);
  assert.equal(two.fees.perps?.until, T0 + DAY);
  assert.equal(two.fees.copy?.fee, 3);
  assert.equal(two.fees.spot, undefined);
  assert.deepEqual(lowered([prog({ from: T0 + 1 })], false, cfg, T0).fees, {}, 'not started');
  assert.deepEqual(lowered([prog({ until: T0 })], false, cfg, T0).fees, {}, 'ended at T0');
  const vipFor30 = lowered([prog({ fee: VIP_PROGRAM_FEE, until: T0 + 30 * DAY, label: 'VIP 30 days' })], false, cfg, T0);
  assert.equal(vipFor30.fees.bots?.fee, 1);
  assert.equal(vipFor30.fees.perps?.why, 'VIP 30 days');
  assert.equal(soonestEnd(vipFor30, ['perps', 'spot']), T0 + 30 * DAY);
  assert.equal(lowered([prog({ fee: -50 })], false, cfg, T0).fees.copy?.fee, 0, 'never below 0');
});

test('bot ladder: the server keeps the engine\'s', () => {
  assert.deepEqual(BOT_LADDER.map((s) => [s.fromUsd, s.fee]), BOT_FEE_LADDER.map((s) => [s.fromUsd, s.fee]));
  for (const v of [0, 99_999, 100_000, 250_000, 500_000, 9_999_999, 10_000_000]) assert.equal(botLadderFee(v), botFeeFor(v), `$${v}`);
});

function service(programs: FeeProgram[]) {
  const dir = tempDir('vs-fees-');
  const tiersPath = join(dir, 'builder-tiers.json');
  const keyPath = join(dir, 'builder-terms.key');
  writeFileSync(tiersPath, JSON.stringify(testTiers(BUILDER)));
  writeNewKeyFile(keyPath);
  const clock = new Clock(T0);
  const svc = new BuilderService({ tiersPath, keyPath, dbPath: join(dir, 'builder.db'), chainId: CHAIN, io: new FakeSodex(clock), log: new MemoryLog(), now: clock.now, programs: (a, at) => programs.filter((g) => g.address === a && g.from <= at && (g.until === null || g.until > at)) });
  svc.load();
  after(() => svc.stop());
  return { svc, clock };
}

test('site terms: a program lowers the signed fee, the terms end with it, and the wallet is back on its tier after', () => {
  const { svc, clock } = service([prog({ fee: 0, products: ['perps'], until: T0 + 5 * 60_000 })]);
  const t = svc.terms({ address: A, nonce: 'n'.repeat(22), hint: false, client: 'c' });
  assert.ok(t.ok && 'fee' in t);
  if (!('fee' in t)) return;
  assert.equal(t.fee.perps, 0, 'the program');
  assert.equal(t.fee.spot, 20, 'spot is not in it: the tier');
  assert.equal(t.ttl, 5 * 60_000, 'the terms end with the program');
  assert.ok(t.flags.includes('override'));
  clock.advance(5 * 60_000);
  const back = svc.terms({ address: A, nonce: 'm'.repeat(22), hint: false, client: 'c' });
  assert.ok('fee' in back && back.fee.perps === 20, 'back on its tier');
  assert.ok('ttl' in back && back.ttl === TERMS_TTL_MS);
});

test('admin store: programs for many wallets, the running ones by wallet and time, ended by hand', () => {
  const dir = tempDir('vs-fees-admin-');
  const s = new AdminStore(join(dir, 'admin.db'));
  after(() => s.close());
  const B = addr(0xb2);
  const ids = s.addFeePrograms({ addresses: [A, B], products: ['copy', 'bots'], fee: 0, from: T0, until: T0 + DAY, label: 'Launch week', by: addr(1) }, T0);
  assert.equal(ids.length, 2);
  assert.equal(s.activeFeePrograms(A, T0 + 1).length, 1);
  assert.equal(s.activeFeePrograms(A, T0 + DAY).length, 0, 'ended at until');
  assert.equal(s.activeFeePrograms(A, T0 - 1).length, 0, 'not yet');
  assert.ok(s.endFeeProgram(ids[1]!, T0 + 100));
  assert.equal(s.activeFeePrograms(B, T0 + 200).length, 0, 'ended by hand');
  assert.equal(s.activeFeePrograms(B, T0 + 50).length, 1, 'kept on record: it ran before it ended (an order then is judged by it)');
  assert.equal(s.feePrograms().length, 2);
});

test('VIP: $1M of the wallet\'s own 14-day volume, nothing else (owner 2026-11-08)', () => {
  assert.ok(isVip({ volumeUsd: 1_000_000 }));
  assert.ok(isVip({ volumeUsd: 4_500_000 }));
  assert.ok(!isVip({ volumeUsd: 999_999 }));
  assert.ok(!isVip({ volumeUsd: 0 }));
  assert.ok(!isVip(null));
});

test('admin store: a VIP program is kept as VIP (-1), not as a 0 fee', () => {
  const dir = tempDir('vs-fees-vip-');
  const s = new AdminStore(join(dir, 'admin.db'));
  after(() => s.close());
  s.addFeePrograms({ addresses: [A], products: ['bots'], fee: VIP_PROGRAM_FEE, from: T0, until: null, label: 'VIP', by: addr(1) }, T0);
  assert.equal(s.activeFeePrograms(A, T0 + 1)[0]!.fee, VIP_PROGRAM_FEE);
});
