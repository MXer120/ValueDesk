/**
 * The verifier end to end, against a stand-in for SoDEX and on a clock the
 * test moves (docs/BUILDER-TIERS.md §5, §6): what counts, what does not, how
 * the fee follows, and that nothing a request does can make the server ask
 * SoDEX for more than its budgets - or grow its database or its queues.
 *
 * Every order in here is signed with a real key and answered by the fake
 * explorer in the explorer's own shape, so "who signed it" is a real recovery.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { testTiers } from '../src/builder/config.js';
import { OrderState, dayOf } from '../src/builder/counting.js';
import { BuilderService, type TermsBody } from '../src/builder/service.js';
import { BuilderStore } from '../src/builder/store.js';
import { termsMessage, writeNewKeyFile } from '../src/builder/terms.js';
import {
  MAX_APPROVALS, MAX_JOBS, MAX_SWEEP_PAGES, OVERLAP_MS, PAGE, REVERIFY_MS, VERIFY_EVERY_MAX_MS, VERIFY_EVERY_MS, perMinFrom,
} from '../src/builder/verifier.js';
import { BUILDER, CHAIN, Clock, FakeSodex, MemoryLog, OTHER_BUILDER, addr, apiKey, drive, tempDir, type ApiKey } from './builderFakes.js';

const DIR = tempDir('vs-btiers-verify-');
const SEC = 1_000;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

type Terms = Extract<TermsBody, { builderId: number }>;

interface World {
  clock: Clock;
  sodex: FakeSodex;
  log: MemoryLog;
  svc: BuilderService;
  dir: string;
  dbPath: string;
  /** Ask for terms as the app does. */
  ask(wallet: string, hint?: boolean, client?: string): Terms;
  /** Leave a hint and let the verifier run until it has nothing queued. */
  verify(wallet: string, ms?: number): Promise<Terms>;
  /** A second server process on the same files (a restart). */
  restart(): World;
}

/** Every service a test opened, so the databases are closed before the temp directory goes. */
const OPEN: BuilderService[] = [];
test.after(() => {
  for (const s of OPEN) s.stop();
});

let caseNo = 0;
function world(o: { tiers?: Record<string, unknown>; verifyPerMin?: number; approvalsPerMin?: number; explorerPerMin?: number; lookbackMs?: number; dir?: string; clock?: Clock; sodex?: FakeSodex } = {}): World {
  const dir = o.dir ?? join(DIR, `case-${caseNo++}`);
  mkdirSync(dir, { recursive: true });
  const tiersPath = join(dir, 'builder-tiers.json');
  const keyPath = join(dir, 'builder-terms.key');
  const dbPath = join(dir, 'builder.db');
  if (!o.dir) {
    writeFileSync(tiersPath, JSON.stringify(o.tiers ?? testTiers(BUILDER)));
    writeNewKeyFile(keyPath);
  }
  const clock = o.clock ?? new Clock();
  const sodex = o.sodex ?? new FakeSodex(clock);
  const log = new MemoryLog();
  const svc = new BuilderService({
    tiersPath, keyPath, dbPath, chainId: CHAIN, io: sodex, log, now: clock.now,
    verifyPerMin: o.verifyPerMin, approvalsPerMin: o.approvalsPerMin, explorerPerMin: o.explorerPerMin, lookbackMs: o.lookbackMs,
  });
  svc.load();
  OPEN.push(svc);
  const ask = (wallet: string, hint = false, client = '203.0.113.7'): Terms => {
    const body = svc.terms({ address: wallet, nonce: 'n'.repeat(22), hint, client });
    assert.ok(body.builderId !== null, 'the feature is on');
    return body;
  };
  const w: World = {
    clock, sodex, log, svc, dir, dbPath, ask,
    async verify(wallet, ms = 3 * HOUR) {
      ask(wallet, true);
      await drive(svc.verifier!, clock, ms);
      return ask(wallet);
    },
    restart() {
      svc.stop();
      const next = world({ ...o, dir, clock, sodex });
      next.svc.verifier!.resume();
      return next;
    },
  };
  return w;
}

/** The most requests of one kind inside any window of `windowMs`. */
function busiest(times: number[], windowMs = MIN): number {
  const t = [...times].sort((a, b) => a - b);
  let best = 0;
  for (let i = 0, j = 0; i < t.length; i++) {
    while (t[i]! - t[j]! >= windowMs) j++;
    best = Math.max(best, i - j + 1);
  }
  return best;
}
const timesOf = (w: World, kind: 'builders' | 'keys' | 'trades' | 'explorer'): number[] => w.sodex.calls.filter((c) => c.kind === kind).map((c) => c.at);

/** A wallet that approved our builder and enabled trading in the app. */
function trader(w: World, n: number, accountId = 4000 + n): { wallet: string; app: ApiKey; own: ApiKey } {
  const wallet = addr(0xa000 + n);
  const app = apiKey('valuescan-web');
  const own = apiKey('my-script');
  w.sodex.approve(wallet, accountId);
  w.sodex.listKey(wallet, app);
  w.sodex.listKey(wallet, own);
  return { wallet, app, own };
}

let orderSeq = 1;
const nextId = (): number => orderSeq++;

// --- the mechanism, start to end --------------------------------------------------------------

test('the mechanism: 2 bp by default, 1.5 bp on perps once more than 10 USD of volume paid the fee', async () => {
  const w = world();
  const { wallet, app } = trader(w, 1);

  // Nothing is known about the wallet: the default fee, signed.
  const first = w.ask(wallet);
  assert.deepEqual(first.fee, { perps: 20, spot: 20 });
  assert.deepEqual(first.default, { perps: 20, spot: 20 });
  assert.deepEqual(first.tier, { index: 0, next: { atUsd: 10, fee: { perps: 15, spot: 20 } } });
  assert.deepEqual(first.volume, { perpsUsd: 0, spotUsd: 0, totalUsd: 0, days: null, verifiedAt: null, pending: false });
  assert.deepEqual(first.flags, []);
  assert.equal(w.sodex.calls.length, 0, 'asking costs SoDEX nothing');

  // Two orders through the app, at the fee owed: 6 + 6.4 USD.
  w.clock.advance(SEC);
  w.sodex.order(wallet, { engine: 'perps', orderId: nextId(), at: w.clock.now(), builder: { id: BUILDER, fee: 20 }, key: app, fills: [{ price: '60000', quantity: '0.0001' }] });
  w.clock.advance(SEC);
  w.sodex.order(wallet, { engine: 'perps', orderId: nextId(), at: w.clock.now(), builder: { id: BUILDER, fee: 20 }, key: app, fills: [{ price: '64000', quantity: '0.00005' }, { price: '64000', quantity: '0.00005' }] });
  w.clock.advance(4 * SEC);

  // The app leaves a hint after the fill. Still the old fee: nothing was read yet.
  const hinted = w.ask(wallet, true);
  assert.deepEqual(hinted.fee, { perps: 20, spot: 20 });
  assert.equal(hinted.volume.pending, true);

  const started = w.clock.now();
  await drive(w.svc.verifier!, w.clock, HOUR);
  const after = w.ask(wallet);
  assert.deepEqual(after.volume, { perpsUsd: 12.4, spotUsd: 0, totalUsd: 12.4, days: null, verifiedAt: after.volume.verifiedAt, pending: false });
  assert.deepEqual(after.fee, { perps: 15, spot: 20 }, 'the milestone is reached: perps 1.5 bp, spot unchanged');
  assert.deepEqual(after.tier, { index: 1, next: null });
  assert.deepEqual(after.flags, []);
  assert.ok(after.volume.verifiedAt! >= started);

  // What it cost: one approval read, one page of fills per engine, one explorer lookup per order.
  assert.equal(w.sodex.count('builders'), 1);
  assert.equal(w.sodex.count('trades'), 2);
  assert.equal(w.sodex.count('explorer'), 2);
  assert.equal(w.sodex.count('keys'), 2);
  assert.deepEqual(w.sodex.calls.filter((c) => c.kind === 'trades').map((c) => /\/(perps|spot)\//.exec(c.path)![1]), ['perps', 'spot']);
  // The lower fee was there within a minute of the hint: as soon as the second order was looked up.
  const fees = w.svc.store!.feeHistory(BUILDER, wallet);
  assert.equal(fees.length, 1);
  assert.deepEqual({ perps: fees[0]!.perps, spot: fees[0]!.spot }, { perps: 15, spot: 20 });
  assert.ok(fees[0]!.at - started < MIN, `the fee changed ${fees[0]!.at - started} ms after the hint`);

  // The next order carries 15 and counts.
  w.clock.advance(5 * SEC);
  w.sodex.order(wallet, { engine: 'perps', orderId: nextId(), at: w.clock.now(), builder: { id: BUILDER, fee: 15 }, key: app, fills: [{ price: '60000', quantity: '0.0002' }] });
  const third = await w.verify(wallet);
  assert.equal(third.volume.perpsUsd, 24.4);
  assert.deepEqual(third.fee, { perps: 15, spot: 20 });
  assert.deepEqual(third.flags, []);
});

test('the signature of an answer verifies over the values the answer carries, the way the browser checks it', async () => {
  const w = world();
  const { wallet } = trader(w, 2);
  const body = w.svc.terms({ address: wallet, nonce: 'Zm9vYmFyYmF6cXV4MTIzNA', hint: false, client: 'c' });
  assert.ok(body.builderId !== null);
  const signer = w.svc.keys.current()!;
  assert.equal(body.keyId, signer.keyId);
  assert.deepEqual(
    { chain: body.chain, builderId: body.builderId, address: body.address, nonce: body.nonce, issued: body.issued, ttl: body.ttl },
    { chain: CHAIN, builderId: BUILDER, address: wallet, nonce: 'Zm9vYmFyYmF6cXV4MTIzNA', issued: w.clock.now(), ttl: 600_000 },
  );
  const message = termsMessage({ chain: body.chain, builderId: body.builderId, address: body.address, perps: body.fee.perps, spot: body.fee.spot, nonce: body.nonce, issued: body.issued, ttl: body.ttl });
  const key = await crypto.subtle.importKey('raw', Buffer.from(signer.publicKey, 'base64url'), { name: 'Ed25519' }, false, ['verify']);
  const check = (msg: string) => crypto.subtle.verify('Ed25519', key, Buffer.from(body.sig!, 'base64url'), new TextEncoder().encode(msg));
  assert.equal(await check(message), true);
  // A lower fee, another wallet, another request: not what was signed.
  assert.equal(await check(message.replace('perps:20', 'perps:15')), false);
  assert.equal(await check(message.replace(wallet, addr(1))), false);
  assert.equal(await check(message.replace('Zm9vYmFyYmF6cXV4MTIzNA', 'Zm9vYmFyYmF6cXV4MTIzNB')), false);
  // What is shown but not signed can be rewritten by anyone without touching the fee: it is not in the message.
  for (const unsigned of ['volume', 'tier', 'flags', 'default']) assert.ok(!message.includes(unsigned));
});

test('the tier is reached, then an underpaid order and one without a builder: neither counts, and the wallet is back on the default fee', async () => {
  const w = world();
  const { wallet, app, own } = trader(w, 3);
  w.clock.advance(SEC);
  w.sodex.order(wallet, { engine: 'perps', orderId: nextId(), at: w.clock.now(), builder: { id: BUILDER, fee: 20 }, key: app, fills: [{ price: '62000', quantity: '0.0002' }] });
  w.clock.advance(2 * SEC);
  const reached = await w.verify(wallet);
  assert.deepEqual(reached.fee, { perps: 15, spot: 20 });
  assert.equal(reached.volume.perpsUsd, 12.4);

  // Sent around the app, by a key of the user's own: 0.5 bp instead of the 1.5 owed, and one with no builder at all.
  w.clock.advance(MIN);
  const low = nextId();
  w.sodex.order(wallet, { engine: 'perps', orderId: low, at: w.clock.now(), builder: { id: BUILDER, fee: 5 }, key: own, clOrdID: 'cheat-1', fills: [{ price: '62000', quantity: '0.01' }] });
  w.clock.advance(SEC);
  const bare = nextId();
  w.sodex.order(wallet, { engine: 'perps', orderId: bare, at: w.clock.now(), builder: null, key: own, clOrdID: 'vs-cheat2', fills: [{ price: '62000', quantity: '0.01' }] });
  w.clock.advance(2 * SEC);

  const back = await w.verify(wallet);
  assert.equal(back.volume.perpsUsd, 12.4, 'neither of the two orders (620 USD each) was counted');
  assert.deepEqual(back.flags, ['underpaid', 'no-builder']);
  assert.deepEqual(back.fee, { perps: 20, spot: 20 }, 'policy default-fee');
  assert.deepEqual(back.tier, { index: 1, next: null }, 'the volume tier is still shown');

  const row = w.svc.store!.wallet(BUILDER, wallet)!;
  assert.deepEqual({ underpaid: row.underpaidN, tampered: row.tamperedN, noBuilder: row.noBuilderN }, { underpaid: 1, tampered: 0, noBuilder: 1 });
  assert.equal(w.svc.store!.order(BUILDER, wallet, 'perps', `BTC-USD:${low}`)!.state, OrderState.underpaid);
  assert.equal(w.svc.store!.order(BUILDER, wallet, 'perps', `BTC-USD:${bare}`)!.state, OrderState.checked);
  // The operator can see which order it was.
  const ev = w.svc.store!.evidenceOf(BUILDER, wallet);
  assert.equal(ev.length, 1);
  assert.deepEqual(
    { kind: ev[0]!.kind, engine: ev[0]!.engine, orderId: ev[0]!.orderId, fee: ev[0]!.fee, owed: ev[0]!.owed, signer: ev[0]!.signer, keyName: ev[0]!.keyName },
    { kind: 'underpaid', engine: 'perps', orderId: String(low), fee: 5, owed: 15, signer: own.address, keyName: null },
  );
  assert.match(ev[0]!.txHash!, /^0x[0-9a-f]{64}$/);
  // The fee on record: 15 when the tier was reached, 20 again from the moment the underpaid order was found.
  assert.deepEqual(w.svc.store!.feeHistory(BUILDER, wallet).map((f) => [f.perps, f.spot]), [[15, 20], [20, 20]]);
});

test('after the wallet is back on the default: 20 counts, 15 counts only while terms from before can still be valid', async () => {
  const w = world();
  const { wallet, app, own } = trader(w, 4);
  w.clock.advance(SEC);
  w.sodex.order(wallet, { engine: 'perps', orderId: nextId(), at: w.clock.now(), builder: { id: BUILDER, fee: 20 }, key: app, fills: [{ price: '50000', quantity: '0.001' }] });
  w.clock.advance(SEC);
  await w.verify(wallet);
  w.clock.advance(MIN);
  w.sodex.order(wallet, { engine: 'perps', orderId: nextId(), at: w.clock.now(), builder: { id: BUILDER, fee: 1 }, key: own, clOrdID: 'x', fills: [{ price: '50000', quantity: '0.001' }] });
  w.clock.advance(SEC);
  const penal = await w.verify(wallet);
  assert.deepEqual(penal.fee, { perps: 20, spot: 20 });
  const raisedAt = w.svc.store!.feeHistory(BUILDER, wallet).at(-1)!.at;

  // The app still holds terms at 15 for up to ten minutes: an order at 15 inside that time paid what it owed.
  w.clock.t = raisedAt + 9 * MIN;
  w.sodex.order(wallet, { engine: 'perps', orderId: nextId(), at: w.clock.now(), builder: { id: BUILDER, fee: 15 }, key: app, fills: [{ price: '50000', quantity: '0.002' }] });
  // After the terms have run out (ttl + 2 minutes), 15 is underpaid ...
  w.clock.t = raisedAt + 12 * MIN + SEC;
  w.sodex.order(wallet, { engine: 'perps', orderId: nextId(), at: w.clock.now(), builder: { id: BUILDER, fee: 15 }, key: own, clOrdID: 'y', fills: [{ price: '50000', quantity: '0.004' }] });
  // ... and 20 counts.
  w.clock.advance(SEC);
  w.sodex.order(wallet, { engine: 'perps', orderId: nextId(), at: w.clock.now(), builder: { id: BUILDER, fee: 20 }, key: app, fills: [{ price: '50000', quantity: '0.008' }] });
  w.clock.advance(SEC);
  const t = await w.verify(wallet);
  assert.equal(t.volume.perpsUsd, 50 + 100 + 400, 'the first order, the one at 15 in time, the one at 20');
  assert.equal(w.svc.store!.wallet(BUILDER, wallet)!.underpaidN, 2);
  assert.deepEqual(t.fee, { perps: 20, spot: 20 });
  // Thirty days after the last underpaid order the tier applies again.
  w.clock.advance(30 * DAY);
  const later = w.ask(wallet);
  assert.deepEqual(later.fee, { perps: 15, spot: 20 });
  assert.deepEqual(later.flags, []);
});

// --- what counts ---------------------------------------------------------------------------------

test('counting: other builders, spot buys, other quote coins and both engines', async () => {
  const w = world();
  const { wallet, app, own } = trader(w, 5);
  w.sodex.approve(wallet, 4005, OTHER_BUILDER, 500);
  const at = () => (w.clock.advance(SEC), w.clock.now());
  const other = nextId();
  // Another builder's order: a builder fee was paid - to someone else.
  w.sodex.order(wallet, { engine: 'perps', orderId: other, at: at(), builder: { id: OTHER_BUILDER, fee: 100 }, key: own, clOrdID: 's1', fills: [{ price: '50000', quantity: '1' }] });
  // No builder, the user's own key and client order id: the user's business.
  w.sodex.order(wallet, { engine: 'perps', orderId: nextId(), at: at(), builder: null, key: own, clOrdID: 'bot-1', fills: [{ price: '50000', quantity: '1' }] });
  // Ours, perps, both sides.
  w.sodex.order(wallet, { engine: 'perps', orderId: nextId(), at: at(), side: 'BUY', builder: { id: BUILDER, fee: 20 }, key: app, fills: [{ price: '100', quantity: '0.03' }] });
  w.sodex.order(wallet, { engine: 'perps', orderId: nextId(), at: at(), side: 'SELL', builder: { id: BUILDER, fee: 20 }, key: app, fills: [{ price: '100', quantity: '0.02' }] });
  // Spot: the buy carries the builder and pays nothing - it never counts. The sell does.
  w.sodex.order(wallet, { engine: 'spot', orderId: nextId(), at: at(), side: 'BUY', builder: { id: BUILDER, fee: 20 }, key: app, fills: [{ price: '2000', quantity: '0.5' }] });
  w.sodex.order(wallet, { engine: 'spot', orderId: nextId(), at: at(), side: 'SELL', builder: { id: BUILDER, fee: 20 }, key: app, fills: [{ price: '2000', quantity: '0.0015' }] });
  // A pair that is not quoted in a dollar coin.
  w.sodex.order(wallet, { engine: 'spot', orderId: nextId(), at: at(), side: 'SELL', symbol: 'vBTC_vETH', builder: { id: BUILDER, fee: 20 }, key: app, fills: [{ price: '25', quantity: '4' }] });
  w.clock.advance(SEC);

  const t = await w.verify(wallet);
  assert.deepEqual(t.volume, { perpsUsd: 5, spotUsd: 3, totalUsd: 8, days: null, verifiedAt: t.volume.verifiedAt, pending: false });
  assert.deepEqual(t.fee, { perps: 20, spot: 20 }, '8 USD: below the milestone');
  assert.deepEqual(t.flags, [], 'nothing here is held against the wallet');
  assert.equal(w.svc.store!.order(BUILDER, wallet, 'perps', `BTC-USD:${other}`)!.state, OrderState.other);
  const row = w.svc.store!.wallet(BUILDER, wallet)!;
  assert.deepEqual({ u: row.underpaidN, t: row.tamperedN, n: row.noBuilderN, open: row.openN }, { u: 0, t: 0, n: 0, open: 0 });
});

test('counting: an order that fills further later is counted by its increase, once - and running again changes nothing', async () => {
  const w = world();
  const { wallet, app } = trader(w, 6);
  w.clock.advance(SEC);
  const resting = nextId();
  w.sodex.order(wallet, { engine: 'perps', orderId: resting, at: w.clock.now(), builder: { id: BUILDER, fee: 20 }, key: app, fills: [{ price: '100', quantity: '0.03' }] });
  w.clock.advance(SEC);
  assert.equal((await w.verify(wallet)).volume.perpsUsd, 3);
  const lookups = w.sodex.count('explorer');

  // It fills further half an hour later.
  w.clock.advance(30 * MIN);
  w.sodex.fillMore(wallet, 'perps', resting, [{ price: '100', quantity: '0.04', at: w.clock.now() }]);
  w.clock.advance(SEC);
  assert.equal((await w.verify(wallet)).volume.perpsUsd, 7);
  assert.equal(w.sodex.count('explorer'), lookups, 'the order is known: no second lookup');

  // Again, and again: the overlap is read a second and a third time and adds nothing.
  for (let i = 0; i < 3; i++) {
    w.clock.advance(SEC);
    const again = await w.verify(wallet);
    assert.equal(again.volume.perpsUsd, 7, `run ${i + 3}`);
  }
  assert.equal(w.sodex.count('explorer'), lookups);
  const o = w.svc.store!.order(BUILDER, wallet, 'perps', `BTC-USD:${resting}`)!;
  assert.deepEqual({ state: o.state, counted: o.countedMicro, paid: o.paidMicro }, { state: OrderState.counted, counted: 7_000_000, paid: 7_000_000 });
});

test('counting: each pass reads on from where the last one ended, a little before it', async () => {
  const w = world();
  const { wallet, app } = trader(w, 7);
  w.clock.advance(SEC);
  const t1 = w.clock.now();
  w.sodex.order(wallet, { engine: 'perps', orderId: nextId(), at: t1, builder: { id: BUILDER, fee: 20 }, key: app, fills: [{ price: '100', quantity: '0.01' }] });
  w.clock.advance(SEC);
  const created = w.clock.now();
  await w.verify(wallet);
  const starts = () => w.sodex.calls.filter((c) => c.kind === 'trades' && c.path.includes('/perps/')).map((c) => Number(new URLSearchParams(c.path.split('?')[1]).get('startTime')));
  // The first read reaches back a week from when the wallet was taken on.
  assert.equal(starts()[0], created - 7 * DAY);
  assert.equal(w.svc.store!.engine(BUILDER, wallet, 'perps').hi, t1);
  assert.equal(w.svc.store!.engine(BUILDER, wallet, 'spot').hi, 0, 'no spot fill was ever seen');

  w.clock.advance(3 * HOUR);
  const t2 = w.clock.now();
  w.sodex.order(wallet, { engine: 'perps', orderId: nextId(), at: t2, builder: { id: BUILDER, fee: 20 }, key: app, fills: [{ price: '100', quantity: '0.02' }] });
  w.clock.advance(SEC);
  const t = await w.verify(wallet);
  assert.equal(t.volume.perpsUsd, 3);
  assert.equal(starts()[1], t1 - OVERLAP_MS, 'from two minutes before the newest fill read');
  assert.equal(w.svc.store!.engine(BUILDER, wallet, 'perps').hi, t2);
  // Spot still starts at the floor: there is no newer point to start from.
  const spotStarts = w.sodex.calls.filter((c) => c.kind === 'trades' && c.path.includes('/spot/')).map((c) => Number(new URLSearchParams(c.path.split('?')[1]).get('startTime')));
  assert.deepEqual(spotStarts, [created - 7 * DAY, created - 7 * DAY]);
});

test('counting: a wallet with more fills than one page is read page by page - every fill once, also across a restart', async () => {
  const w0 = world({ explorerPerMin: 6 });
  const { wallet, app } = trader(w0, 8);
  // 25 orders of 100 fills each, 1 USD per fill; the fills of two neighbouring orders share their millisecond,
  // so a page boundary falls inside a millisecond.
  const base = w0.clock.now();
  for (let i = 0; i < 25; i++) {
    const at = base + Math.floor(i / 2) * 10 * SEC;
    w0.sodex.order(wallet, { engine: 'perps', orderId: nextId(), at, builder: { id: BUILDER, fee: 20 }, key: app, fills: Array.from({ length: 100 }, () => ({ price: '100', quantity: '0.01' })) });
  }
  w0.clock.advance(5 * MIN);
  assert.equal(PAGE, 1000);
  w0.ask(wallet, true);
  // Until the first page is in ...
  await drive(w0.svc.verifier!, w0.clock, 10 * SEC);
  assert.equal(w0.sodex.count('trades'), 1);
  const mid = w0.svc.store!.engine(BUILDER, wallet, 'perps');
  assert.ok(mid.swFrom > 0 && mid.swEnd > 0 && mid.swPages === 1, 'the sweep is in progress and says where it is');
  assert.equal(mid.hi, 0, 'nothing is final before the sweep is');

  // ... then the server restarts. The hint is still on record; the sweep goes on where it was.
  const w = w0.restart();
  assert.equal(w.svc.verifier!.pending(wallet), true);
  await drive(w.svc.verifier!, w.clock, 2 * HOUR);
  const t = w.ask(wallet);
  assert.equal(t.volume.perpsUsd, 2500, 'every one of the 2,500 fills, once');
  assert.equal(t.volume.pending, false);
  const pages = w.sodex.calls.filter((c) => c.kind === 'trades' && c.path.includes('/perps/'));
  assert.equal(pages.length, 3);
  const ends = pages.map((c) => new URLSearchParams(c.path.split('?')[1]).get('endTime'));
  assert.equal(ends[0], null);
  assert.ok(Number(ends[1]) > Number(ends[2]), 'each page ends where the one before stopped');
  assert.equal(w.sodex.count('explorer'), 25);
  assert.equal(w.sodex.count('builders'), 1, 'the wallet was not asked about again');

  // And once more: nothing changes.
  w.clock.advance(HOUR);
  assert.equal((await w.verify(wallet)).volume.perpsUsd, 2500);
  assert.equal(w.sodex.count('explorer'), 25);
});

test('counting: a sweep stops at its page limit; what lies deeper is left out, and said so', async () => {
  const w = world({ explorerPerMin: 0 });
  const { wallet, app } = trader(w, 9);
  // One order, far more fills than a sweep reads.
  const fills = Array.from({ length: (MAX_SWEEP_PAGES + 1) * PAGE }, (_, i) => ({ price: '100', quantity: '0.01', at: w.clock.now() + i }));
  w.sodex.order(wallet, { engine: 'perps', orderId: nextId(), at: w.clock.now(), builder: { id: BUILDER, fee: 20 }, key: app, fills });
  w.clock.advance(HOUR);
  w.ask(wallet, true);
  await drive(w.svc.verifier!, w.clock, 3 * HOUR);
  assert.equal(w.sodex.calls.filter((c) => c.kind === 'trades' && c.path.includes('/perps/')).length, MAX_SWEEP_PAGES);
  assert.ok(w.log.lines.some((l) => l.level === 'warn' && /more fills than one sweep reads/.test(l.msg)));
  assert.equal(w.svc.verifier!.pending(wallet), false, 'the wallet does not stay in the queue for ever');
});

test('counting: raising the default fee in the file does not turn orders placed before into underpaid ones', async () => {
  const w = world();
  const { wallet, app } = trader(w, 20);
  w.clock.advance(SEC);
  // Placed at the default of the day, 2 bp. The wallet has not been verified yet.
  w.sodex.order(wallet, { engine: 'perps', orderId: nextId(), at: w.clock.now(), builder: { id: BUILDER, fee: 20 }, key: app, fills: [{ price: '100', quantity: '0.05' }] });
  w.clock.advance(HOUR);
  // The owner raises the default to 5 bp.
  writeFileSync(join(w.dir, 'builder-tiers.json'), JSON.stringify({ builderId: BUILDER, maxFeeRate: 50, tiers: [{ minVolumeUsd: 0, perps: 50, spot: 50 }, { minVolumeUsd: 100, perps: 40, spot: 50 }], _n: 'raised' }));
  await w.svc.refresh();
  assert.deepEqual(w.svc.store!.defaults(BUILDER).map((r) => [r.perps, r.spot]), [[20, 20], [50, 50]]);
  // An order at the old 2 bp after the change and after every old terms ran out: that one is underpaid.
  w.clock.advance(HOUR);
  w.sodex.order(wallet, { engine: 'perps', orderId: nextId(), at: w.clock.now(), builder: { id: BUILDER, fee: 20 }, key: app, clOrdID: 'late', fills: [{ price: '100', quantity: '0.07' }] });
  w.clock.advance(SEC);
  const t = await w.verify(wallet);
  assert.deepEqual(t.default, { perps: 50, spot: 50 });
  assert.equal(t.volume.perpsUsd, 5, 'the order from before the change counts; it paid what was owed then');
  assert.equal(w.svc.store!.wallet(BUILDER, wallet)!.underpaidN, 1, 'only the late one');
});

test('counting: an engine whose default fee is 0 is never read - the app attaches no builder there', async () => {
  const w = world({ tiers: { builderId: BUILDER, maxFeeRate: 20, tiers: [{ minVolumeUsd: 0, perps: 20, spot: 0 }, { minVolumeUsd: 10, perps: 15, spot: 0 }] } });
  const { wallet, app } = trader(w, 21);
  w.clock.advance(SEC);
  w.sodex.order(wallet, { engine: 'perps', orderId: nextId(), at: w.clock.now(), builder: { id: BUILDER, fee: 20 }, key: app, fills: [{ price: '50000', quantity: '0.001' }] });
  w.sodex.order(wallet, { engine: 'spot', orderId: nextId(), at: w.clock.now(), side: 'SELL', builder: null, key: app, fills: [{ price: '2000', quantity: '1' }] });
  w.clock.advance(SEC);
  const t = await w.verify(wallet);
  assert.deepEqual(t.fee, { perps: 15, spot: 0 });
  assert.equal(w.sodex.calls.filter((c) => c.kind === 'trades').length, 1);
  assert.ok(w.sodex.calls.every((c) => !c.path.includes('/spot/')), 'no spot read of any kind');
  assert.deepEqual(t.flags, [], 'a builder-less spot order is what the app sends there');
  assert.ok(t.volume.verifiedAt);
});

// --- who sent an order -----------------------------------------------------------------------------

test('tampered: an order without our fee, signed by the key our app registered, is proof - and only that is', async () => {
  const w = world();
  const { wallet, app, own } = trader(w, 10);
  w.clock.advance(SEC);
  w.sodex.order(wallet, { engine: 'perps', orderId: nextId(), at: w.clock.now(), builder: { id: BUILDER, fee: 20 }, key: app, fills: [{ price: '50000', quantity: '0.001' }] });
  w.clock.advance(SEC);
  assert.deepEqual((await w.verify(wallet)).fee, { perps: 15, spot: 20 });
  assert.deepEqual([...w.svc.store!.keysOf(wallet)], [[app.address, 'valuescan-web']], 'only the key our app registered is kept');

  // The same key sends an order without a builder. The client order id is not even the app's.
  w.clock.advance(MIN);
  const bad = nextId();
  w.sodex.order(wallet, { engine: 'perps', orderId: bad, at: w.clock.now(), builder: null, key: app, clOrdID: 'whatever', fills: [{ price: '50000', quantity: '0.01' }] });
  // The user's own key, no builder: nothing is concluded from that one.
  w.clock.advance(SEC);
  const fine = nextId();
  w.sodex.order(wallet, { engine: 'perps', orderId: fine, at: w.clock.now(), builder: null, key: own, clOrdID: 'bot-7', fills: [{ price: '50000', quantity: '0.01' }] });
  w.clock.advance(SEC);

  const t = await w.verify(wallet);
  assert.deepEqual(t.flags, ['tampered']);
  assert.deepEqual(t.fee, { perps: 20, spot: 20 }, 'the same policy as underpaid');
  assert.equal(t.volume.perpsUsd, 50);
  const ev = w.svc.store!.evidenceOf(BUILDER, wallet);
  assert.equal(ev.length, 1);
  assert.deepEqual(
    { kind: ev[0]!.kind, orderId: ev[0]!.orderId, signer: ev[0]!.signer, keyName: ev[0]!.keyName, fee: ev[0]!.fee, owed: ev[0]!.owed },
    { kind: 'tampered', orderId: String(bad), signer: app.address, keyName: 'valuescan-web', fee: null, owed: 15 },
  );
  assert.match(ev[0]!.txHash!, /^0x[0-9a-f]{64}$/);
  assert.equal(w.svc.store!.wallet(BUILDER, wallet)!.tamperedN, 1);
  assert.ok(w.log.lines.some((l) => l.level === 'warn' && /does not carry our fee/.test(l.msg)));
});

test('tampered: keys rotate - an order signed by the app\'s earlier key is still recognised', async () => {
  const w = world();
  const { wallet, app } = trader(w, 11);
  w.clock.advance(SEC);
  w.sodex.order(wallet, { engine: 'perps', orderId: nextId(), at: w.clock.now(), builder: { id: BUILDER, fee: 20 }, key: app, fills: [{ price: '100', quantity: '0.01' }] });
  w.clock.advance(SEC);
  await w.verify(wallet);

  // The old key sends a builder-less order; then trading is enabled again and the name gets a new key.
  w.clock.advance(MIN);
  w.sodex.order(wallet, { engine: 'spot', orderId: nextId(), at: w.clock.now(), side: 'SELL', builder: null, key: app, fills: [{ price: '2000', quantity: '0.1' }] });
  const fresh = apiKey('valuescan-web');
  w.sodex.listKey(wallet, fresh);
  w.clock.advance(SEC);
  const t = await w.verify(wallet);
  assert.deepEqual(t.flags, ['tampered', 'no-builder']);
  assert.equal(w.svc.store!.keysOf(wallet).size, 2, 'both keys are on record');
  assert.equal(w.svc.store!.evidenceOf(BUILDER, wallet)[0]!.signer, app.address);
});

test('tampered: a wallet with no key of our app on record is not looked up at all - there is nothing to compare with', async () => {
  const w = world();
  const wallet = addr(0xb001);
  const own = apiKey('webkey');
  w.sodex.approve(wallet, 5001);
  w.sodex.listKey(wallet, own);
  w.clock.advance(SEC);
  for (let i = 0; i < 5; i++) w.sodex.order(wallet, { engine: 'perps', orderId: nextId(), at: w.clock.now() + i, builder: null, key: own, clOrdID: `mm-${i}`, fills: [{ price: '100', quantity: '1' }] });
  w.clock.advance(SEC);
  const t = await w.verify(wallet);
  assert.equal(w.sodex.count('explorer'), 0);
  assert.deepEqual(t.flags, []);
  assert.deepEqual(w.svc.store!.rowsOf(wallet), { wallets: 1, engines: 2, orders: 0, fills: 0, fees: 0, keys: 0, evidence: 0, days: 0 });
});

// --- hints: limits and back-off ----------------------------------------------------------------------

test('hints: a wallet is verified at most once per interval, and less and less often while nothing new is found', async () => {
  const w = world();
  const { wallet, app } = trader(w, 12);
  w.clock.advance(SEC);
  w.sodex.order(wallet, { engine: 'perps', orderId: nextId(), at: w.clock.now(), builder: { id: BUILDER, fee: 20 }, key: app, fills: [{ price: '100', quantity: '0.01' }] });
  w.clock.advance(SEC);
  await w.verify(wallet);
  const passes = () => w.sodex.calls.filter((c) => c.kind === 'trades' && c.path.includes('/perps/')).map((c) => c.at);
  assert.equal(passes().length, 1);
  const verified = () => w.svc.store!.wallet(BUILDER, wallet)!.verifiedAt;

  // A burst of hints right after: one verification, and not before a minute has passed.
  let last = verified();
  for (let i = 0; i < 50; i++) {
    w.clock.advance(100);
    w.ask(wallet, true, `client-${i}`);
  }
  assert.equal(w.svc.verifier!.queues.jobs, 1, 'fifty hints, one place in the queue');
  await drive(w.svc.verifier!, w.clock, 3 * HOUR);
  assert.equal(passes().length, 2);
  assert.ok(passes()[1]! - last >= VERIFY_EVERY_MS, 'not before the interval has passed');

  // That pass found nothing new, and neither do the next ones: the gap doubles each time.
  const gaps: number[] = [];
  for (let i = 0; i < 7; i++) {
    last = verified();
    w.ask(wallet, true);
    await drive(w.svc.verifier!, w.clock, 3 * HOUR);
    gaps.push(passes().at(-1)! - last);
  }
  assert.ok(gaps[0]! >= 2 * VERIFY_EVERY_MS && gaps[0]! < 3 * VERIFY_EVERY_MS, `after one idle pass: ${gaps[0]}`);
  for (let i = 1; i < gaps.length; i++) assert.ok(gaps[i]! >= Math.min(VERIFY_EVERY_MAX_MS, 2 ** (i + 1) * VERIFY_EVERY_MS), `gap ${i}: ${gaps[i]}`);
  assert.ok(gaps.at(-1)! >= VERIFY_EVERY_MAX_MS && gaps.at(-1)! < VERIFY_EVERY_MAX_MS + 5 * MIN, 'never longer than the cap');
  assert.equal(VERIFY_EVERY_MAX_MS, 30 * MIN);

  // Something new: the wallet is back to the short interval.
  w.sodex.order(wallet, { engine: 'perps', orderId: nextId(), at: w.clock.now(), builder: { id: BUILDER, fee: 20 }, key: app, fills: [{ price: '100', quantity: '0.01' }] });
  w.clock.advance(SEC);
  await w.verify(wallet);
  assert.equal(w.svc.store!.wallet(BUILDER, wallet)!.idleRuns, 0);
  last = verified();
  w.ask(wallet, true);
  await drive(w.svc.verifier!, w.clock, 3 * HOUR);
  assert.ok(passes().at(-1)! - last < 2 * VERIFY_EVERY_MS);
});

test('hints: a wallet that has not approved our builder is dropped after one cheap read, and not asked about again at once', async () => {
  const w = world();
  const stranger = addr(0xc001);
  const otherBuilders = addr(0xc002);
  w.sodex.approve(otherBuilders, 6002, OTHER_BUILDER, 500);
  for (const a of [stranger, otherBuilders]) {
    const t = w.ask(a, true);
    assert.equal(t.volume.pending, true, 'until the approval read is in');
  }
  await drive(w.svc.verifier!, w.clock, HOUR);
  assert.equal(w.sodex.count('builders'), 2);
  assert.equal(w.sodex.count('trades') + w.sodex.count('explorer') + w.sodex.count('keys'), 0, 'no history, no explorer, no key read for either');
  assert.equal(w.svc.store!.walletCount(), 0);
  for (const a of [stranger, otherBuilders]) assert.equal(w.ask(a).volume.pending, false);

  // Asked again within the minute: nothing is sent.
  for (let i = 0; i < 20; i++) {
    w.clock.advance(SEC);
    w.ask(stranger, true);
  }
  await drive(w.svc.verifier!, w.clock, 30 * SEC);
  assert.equal(w.sodex.count('builders'), 2);
  // Later it may have approved: it is asked about again, once.
  w.clock.advance(2 * MIN);
  w.sodex.approve(stranger, 6001);
  w.ask(stranger, true);
  await drive(w.svc.verifier!, w.clock, HOUR);
  assert.equal(w.sodex.count('builders'), 3);
  assert.equal(w.svc.store!.walletCount(), 1);
});

// --- abuse ---------------------------------------------------------------------------------------------

test('abuse: a flood of terms requests for random addresses grows nothing and costs SoDEX no more than the budgets', async () => {
  const w = world();
  const size = () => statSync(w.dbPath).size;
  const before = size();
  // Plain requests: thousands, for wallets nobody ever saw.
  for (let i = 0; i < 3_000; i++) w.ask(addr(0x100000 + i), false, `198.51.100.${i % 250}`);
  assert.equal(w.sodex.calls.length, 0);
  assert.deepEqual(w.svc.verifier!.queues, { jobs: 0, approvals: 0, denied: 0 });
  assert.equal(size(), before, 'builder.db did not grow by a byte');

  // The same with hints, from 250 clients, over ten minutes.
  let asked = 0;
  for (let round = 0; round < 60; round++) {
    for (let i = 0; i < 100; i++) w.ask(addr(0x200000 + asked++), true, `198.51.100.${(asked * 7) % 250}`);
    assert.ok(w.svc.verifier!.queues.approvals <= MAX_APPROVALS, 'the queue is bounded');
    await drive(w.svc.verifier!, w.clock, 10 * SEC);
  }
  await drive(w.svc.verifier!, w.clock, 3 * HOUR);
  assert.equal(asked, 6_000);
  const reads = timesOf(w, 'builders');
  assert.ok(reads.length > 100 && reads.length <= MAX_APPROVALS + 60 * 10 / 6 + 5, `${reads.length} approval reads`);
  assert.ok(busiest(reads) <= 10, `at most 10 approval reads in any minute (saw ${busiest(reads)})`);
  assert.equal(w.sodex.count('trades') + w.sodex.count('explorer') + w.sodex.count('keys'), 0, 'not one history or explorer request');
  assert.equal(w.svc.store!.walletCount(), 0, 'no wallet row for a wallet without an approval');
  // (`fees` holds one row that is no wallet's: the default fee, on record since the ledger was opened.)
  for (const table of ['wallets', 'engines', 'orders', 'fills', 'fees', 'keys', 'evidence']) {
    const n = (w.svc.store!.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE address <> '*'`).get() as { n: number }).n;
    assert.equal(n, 0, table);
  }
  assert.deepEqual(w.svc.store!.defaults(BUILDER).map((r) => [r.perps, r.spot]), [[20, 20]]);
  assert.equal(w.svc.verifier!.queues.jobs, 0);
  assert.ok(w.svc.verifier!.queues.denied <= 5_000);

  // A real trader is still served afterwards.
  const { wallet, app } = trader(w, 13);
  w.sodex.order(wallet, { engine: 'perps', orderId: nextId(), at: w.clock.now(), builder: { id: BUILDER, fee: 20 }, key: app, fills: [{ price: '50000', quantity: '0.001' }] });
  w.clock.advance(SEC);
  assert.deepEqual((await w.verify(wallet)).fee, { perps: 15, spot: 20 });
});

test('abuse: one client cannot fill the approval queue; a full queue drops the newest hint', async () => {
  const w = world();
  for (let i = 0; i < 500; i++) w.ask(addr(0x300000 + i), true, '203.0.113.99');
  assert.equal(w.svc.verifier!.queues.approvals, 6, 'six unknown wallets a minute per client');
  // Many clients: the queue fills to its bound and stays there.
  for (let i = 0; i < 2_000; i++) w.ask(addr(0x400000 + i), true, `10.0.${Math.floor(i / 250)}.${i % 250}`);
  assert.equal(w.svc.verifier!.queues.approvals, MAX_APPROVALS);
  assert.equal(w.sodex.calls.length, 0, 'nothing is sent from inside a request');
});

test('abuse: hints for every known wallet at once - the queue is bounded and the history budget holds', async () => {
  const w = world({ approvalsPerMin: 30 });
  const wallets: string[] = [];
  for (let i = 0; i < 40; i++) {
    const { wallet, app } = trader(w, 100 + i);
    wallets.push(wallet);
    w.sodex.order(wallet, { engine: 'perps', orderId: nextId(), at: w.clock.now(), builder: { id: BUILDER, fee: 20 }, key: app, fills: [{ price: '100', quantity: '0.01' }] });
  }
  w.clock.advance(SEC);
  for (const a of wallets) w.ask(a, true, a);
  await drive(w.svc.verifier!, w.clock, 4 * HOUR);
  // Then everyone hints all the time, for two hours.
  for (let i = 0; i < 240; i++) {
    for (const a of wallets) w.ask(a, true, a);
    assert.ok(w.svc.verifier!.queues.jobs <= MAX_JOBS);
    await drive(w.svc.verifier!, w.clock, 30 * SEC);
  }
  const history = timesOf(w, 'trades');
  assert.ok(history.length > 100);
  assert.equal(busiest(history), 1, 'never two history requests inside one minute');
  assert.ok(busiest(timesOf(w, 'explorer')) <= 3);
  assert.ok(busiest(timesOf(w, 'builders')) <= 30);
  // Every wallet was verified, in turn.
  for (const a of wallets) assert.ok(w.svc.store!.wallet(BUILDER, a)!.verifiedAt > 0, a);
});

// --- budgets and rate limits ---------------------------------------------------------------------------

test('budget: history requests are evenly spaced - 1 a minute by default, never more than 2 whatever is configured', async () => {
  assert.equal(perMinFrom(undefined, 1, 2), 1);
  assert.equal(perMinFrom('', 1, 2), 1);
  assert.equal(perMinFrom('2', 1, 2), 2);
  assert.equal(perMinFrom('60', 1, 2), 2, 'a setting cannot go above the safe rate of the pair');
  assert.equal(perMinFrom('0.5', 1, 2), 0.5);
  for (const junk of ['0', '-3', 'fast', 'NaN']) assert.equal(perMinFrom(junk, 1, 2), 1, junk);

  for (const [setting, most, gap] of [[undefined, 1, 60_500], [2, 2, 30_250], [50, 2, 30_250]] as const) {
    const w = world({ verifyPerMin: setting, approvalsPerMin: 30 });
    const wallets: string[] = [];
    for (let i = 0; i < 12; i++) {
      const { wallet } = trader(w, 200 + i);
      wallets.push(wallet);
      w.ask(wallet, true, wallet);
    }
    await drive(w.svc.verifier!, w.clock, 2 * HOUR);
    const t = timesOf(w, 'trades').sort((a, b) => a - b);
    assert.equal(t.length, 24, 'two engines for each of twelve wallets');
    assert.ok(busiest(t) <= most, `setting ${setting}: ${busiest(t)} in a minute`);
    for (let i = 1; i < t.length; i++) assert.ok(t[i]! - t[i - 1]! >= gap, `setting ${setting}: ${t[i]! - t[i - 1]!} ms between two requests`);
  }
});

test('budget: restarts do not add up to a burst - the time of the last history request is on disk', async () => {
  let w = world();
  const { wallet } = trader(w, 300);
  w.ask(wallet, true);
  await drive(w.svc.verifier!, w.clock, 5 * SEC);
  assert.equal(w.sodex.count('trades'), 1, 'the perps page went out; spot waits for its slot');
  // Ten restarts in ten seconds, each with the wallet still in the queue.
  for (let i = 0; i < 10; i++) {
    w.clock.advance(SEC);
    w = w.restart();
    await drive(w.svc.verifier!, w.clock, 100);
  }
  assert.equal(w.sodex.count('trades'), 1, 'no restart sent another one early');
  await drive(w.svc.verifier!, w.clock, HOUR);
  const t = timesOf(w, 'trades');
  assert.equal(t.length, 2);
  assert.ok(t[1]! - t[0]! >= 60_500);
});

test('rate limit: a 1015 stops the history lane for minutes, longer each time, across restarts - and it is never retried into', async () => {
  let w = world();
  const a = trader(w, 310);
  const b = trader(w, 311);
  w.sodex.fail.trades = [429];
  w.ask(a.wallet, true, 'a');
  w.ask(b.wallet, true, 'b');
  const t0 = w.clock.now();
  await drive(w.svc.verifier!, w.clock, 4 * MIN + 50 * SEC);
  assert.equal(w.sodex.count('trades'), 1, 'the refused request, and nothing after it for five minutes');
  assert.ok(w.log.lines.some((l) => l.level === 'warn' && /rate-limited a history read/.test(l.msg)));
  assert.equal(w.svc.verifier!.pending(a.wallet), true, 'the wallet keeps its place');

  // A restart inside the pause does not forget it.
  w = w.restart();
  await drive(w.svc.verifier!, w.clock, 5 * SEC);
  assert.equal(w.sodex.count('trades'), 1);

  // After the pause one request goes out; refused again, the pause doubles.
  w.sodex.fail.trades = [429];
  await drive(w.svc.verifier!, w.clock, 9 * MIN);
  const t = timesOf(w, 'trades');
  assert.equal(t.length, 2);
  assert.ok(t[1]! - t0 >= 5 * MIN && t[1]! - t0 < 6 * MIN);
  // Then it works again, and both wallets are verified at the ordinary pace.
  await drive(w.svc.verifier!, w.clock, 2 * HOUR);
  const all = timesOf(w, 'trades');
  assert.ok(all[2]! - all[1]! >= 10 * MIN, 'ten minutes after the second refusal');
  assert.equal(all.length, 2 + 4);
  assert.equal(busiest(all), 1);
  for (const x of [a, b]) assert.ok(w.svc.store!.wallet(BUILDER, x.wallet)!.verifiedAt > 0);
});

test('rate limit: the shared client\'s cooldown and a busy weight budget hold every gateway read back', async () => {
  const w = world();
  const { wallet } = trader(w, 320);
  w.sodex.cooldown = 45 * SEC;
  w.ask(wallet, true);
  await drive(w.svc.verifier!, w.clock, 30 * SEC);
  assert.equal(w.sodex.calls.length, 0, 'nothing is sent while SoDEX is cooling down - not even the approval read');
  w.sodex.cooldown = 0;
  w.sodex.weight = 1_000;
  await drive(w.svc.verifier!, w.clock, 30 * SEC);
  assert.equal(w.sodex.calls.length, 0, 'nor while the shared weight budget is mostly in use');
  w.sodex.weight = 100;
  await drive(w.svc.verifier!, w.clock, HOUR);
  assert.equal(w.sodex.count('trades'), 2);
});

test('failures: a page that fails is retried later, three times at most, and the lane rests as if every retry was sent', async () => {
  const w = world();
  const { wallet } = trader(w, 330);
  w.sodex.fail.trades = [500, 'timeout', 500];
  w.ask(wallet, true);
  await drive(w.svc.verifier!, w.clock, 3 * HOUR);
  const t = timesOf(w, 'trades');
  assert.equal(t.length, 3, 'three attempts, then the wallet is left for its next hint');
  for (let i = 1; i < t.length; i++) assert.ok(t[i]! - t[i - 1]! >= 4 * 60_500, `the shared client may have sent four: ${t[i]! - t[i - 1]!} ms`);
  assert.equal(w.svc.verifier!.pending(wallet), false);
  assert.equal(w.svc.store!.wallet(BUILDER, wallet)!.dueAt, 0);
  // The next hint starts over.
  w.ask(wallet, true);
  await drive(w.svc.verifier!, w.clock, 3 * HOUR);
  assert.ok(w.svc.store!.wallet(BUILDER, wallet)!.verifiedAt > 0);
});

test('re-read without a hint: a wallet that trades only through the executor is counted within REVERIFY_MS (10-30 gap)', async () => {
  const w = world();
  const { wallet, app } = trader(w, 360);
  w.clock.advance(SEC);
  w.sodex.order(wallet, { engine: 'perps', orderId: nextId(), at: w.clock.now(), builder: { id: BUILDER, fee: 20 }, key: app, fills: [{ price: '50000', quantity: '0.001' }] });
  w.clock.advance(SEC);
  await w.verify(wallet);
  assert.equal(w.ask(wallet).volume.perpsUsd, 50);
  // Later, an order nobody hints about (no tab open, an executor before the volume-read hint).
  w.clock.advance(HOUR);
  w.sodex.order(wallet, { engine: 'perps', orderId: nextId(), at: w.clock.now(), builder: { id: BUILDER, fee: 20 }, key: app, fills: [{ price: '60000', quantity: '0.001' }] });
  await drive(w.svc.verifier!, w.clock, 30 * MIN);
  assert.equal(w.ask(wallet).volume.perpsUsd, 50, 'nothing reads it before its re-read is due');
  // The pump wakes every 10 min with nothing queued; a run past REVERIFY_MS queues the wallet again.
  w.clock.advance(REVERIFY_MS);
  await drive(w.svc.verifier!, w.clock, HOUR);
  assert.equal(w.ask(wallet).volume.perpsUsd, 110, 'the sweep re-read it and counted the new order');
});

// --- the explorer ---------------------------------------------------------------------------------------

test('explorer: any answer that is not a 200 stops the lane, for longer each time; the order waits and is counted later', async () => {
  const w = world();
  const { wallet, app } = trader(w, 340);
  w.clock.advance(SEC);
  w.sodex.order(wallet, { engine: 'perps', orderId: nextId(), at: w.clock.now(), builder: { id: BUILDER, fee: 20 }, key: app, fills: [{ price: '50000', quantity: '0.001' }] });
  w.clock.advance(SEC);
  w.sodex.fail.explorer = [503, 'timeout'];
  w.ask(wallet, true);
  const t0 = w.clock.now();
  await drive(w.svc.verifier!, w.clock, 9 * MIN);
  assert.equal(w.sodex.count('explorer'), 1, 'one request, then ten minutes of nothing');
  let t = w.ask(wallet);
  assert.equal(t.volume.perpsUsd, 0);
  assert.equal(t.volume.pending, true, 'the order still waits for its lookup');
  assert.ok(w.log.lines.some((l) => l.level === 'warn' && /explorer did not answer with a 200/.test(l.msg) && l.o.status === 503));

  await drive(w.svc.verifier!, w.clock, 15 * MIN);
  const x = timesOf(w, 'explorer');
  assert.equal(x.length, 2, 'the second try failed too: twenty minutes now');
  assert.ok(x[1]! - t0 >= 10 * MIN);
  await drive(w.svc.verifier!, w.clock, 2 * HOUR);
  const all = timesOf(w, 'explorer');
  assert.equal(all.length, 3);
  assert.ok(all[2]! - all[1]! >= 20 * MIN);
  t = w.ask(wallet);
  assert.equal(t.volume.perpsUsd, 50);
  assert.deepEqual(t.fee, { perps: 15, spot: 20 });
  assert.equal(t.volume.pending, false);
});

test('explorer: an HTTP 404 for one order never stops the lane - the orders behind it are counted (10-29 stall)', async () => {
  const w = world();
  const { wallet, app } = trader(w, 345);
  w.sodex.notFoundStatus = true;
  w.clock.advance(SEC);
  const lost = nextId();
  w.sodex.order(wallet, { engine: 'perps', orderId: lost, at: w.clock.now(), builder: { id: BUILDER, fee: 20 }, key: app, fills: [{ price: '50000', quantity: '0.001' }] });
  w.sodex.txs.clear(); // the explorer never knew this one
  w.clock.advance(SEC);
  w.sodex.order(wallet, { engine: 'perps', orderId: nextId(), at: w.clock.now(), builder: { id: BUILDER, fee: 20 }, key: app, fills: [{ price: '60000', quantity: '0.001' }] });
  w.clock.advance(SEC);
  w.ask(wallet, true);
  await drive(w.svc.verifier!, w.clock, 30 * MIN);
  const t = w.ask(wallet);
  assert.equal(t.volume.perpsUsd, 60, 'the known order counted within minutes, not after a 6-hour pause');
  assert.ok(!w.log.lines.some((l) => /lane is paused/.test(l.msg)), 'a 404 pauses nothing');
  assert.equal(w.svc.store!.order(BUILDER, wallet, 'perps', `BTC-USD:${lost}`)!.state, OrderState.unknown, 'the unknown one: retried, then given up');
});

test('explorer: an order it does not know is asked for again a few times, then given up - and never counted', async () => {
  const w = world();
  const { wallet, app } = trader(w, 350);
  w.clock.advance(SEC);
  const id = nextId();
  w.sodex.order(wallet, { engine: 'perps', orderId: id, at: w.clock.now(), builder: { id: BUILDER, fee: 20 }, key: app, fills: [{ price: '50000', quantity: '0.001' }] });
  w.sodex.txs.clear();
  w.clock.advance(SEC);
  const t = await w.verify(wallet);
  assert.equal(w.sodex.count('explorer'), 8, 'at once, then after 30 s, 1, 1.5, 2, 3, 5 and 10 min');
  assert.equal(t.volume.perpsUsd, 0);
  assert.equal(t.volume.pending, false);
  assert.equal(w.svc.store!.order(BUILDER, wallet, 'perps', `BTC-USD:${id}`)!.state, OrderState.unknown);
  assert.equal(w.svc.store!.wallet(BUILDER, wallet)!.openN, 0);
});

test('explorer: switched off (0 a minute) nothing is looked up and nothing is counted', async () => {
  const w = world({ explorerPerMin: 0 });
  const { wallet, app } = trader(w, 360);
  w.clock.advance(SEC);
  w.sodex.order(wallet, { engine: 'perps', orderId: nextId(), at: w.clock.now(), builder: { id: BUILDER, fee: 20 }, key: app, fills: [{ price: '50000', quantity: '0.001' }] });
  w.clock.advance(SEC);
  const t = await w.verify(wallet);
  assert.equal(w.sodex.count('explorer') + w.sodex.count('keys'), 0);
  assert.equal(t.volume.perpsUsd, 0, 'fills alone do not say whose builder was paid');
  assert.deepEqual(t.fee, { perps: 20, spot: 20 });
});

// --- forget ------------------------------------------------------------------------------------------------

test('forget: a wallet removed while the server runs stays removed - nothing in memory writes it back', async () => {
  const w = world();
  const { wallet, app, own } = trader(w, 370);
  w.clock.advance(SEC);
  w.sodex.order(wallet, { engine: 'perps', orderId: nextId(), at: w.clock.now(), builder: { id: BUILDER, fee: 20 }, key: app, fills: [{ price: '50000', quantity: '0.001' }] });
  w.clock.advance(MIN);
  await w.verify(wallet);
  w.sodex.order(wallet, { engine: 'perps', orderId: nextId(), at: w.clock.now(), builder: { id: BUILDER, fee: 1 }, key: own, clOrdID: 'c', fills: [{ price: '50000', quantity: '0.001' }] });
  w.clock.advance(MIN);
  const penal = await w.verify(wallet);
  assert.deepEqual(penal.flags, ['underpaid']);
  assert.deepEqual(penal.fee, { perps: 20, spot: 20 });
  assert.equal(penal.volume.perpsUsd, 50);

  // A hint is waiting and one more order is on its way to the explorer when the operator's tool runs.
  w.sodex.order(wallet, { engine: 'perps', orderId: nextId(), at: w.clock.now(), builder: { id: BUILDER, fee: 20 }, key: app, fills: [{ price: '50000', quantity: '0.001' }] });
  w.clock.advance(2 * MIN);
  w.ask(wallet, true);
  assert.equal(w.svc.verifier!.pending(wallet), true);

  const tool = new BuilderStore(w.dbPath);
  const forgotAt = w.clock.now();
  const removed = tool.forget(wallet, forgotAt);
  tool.close();
  // (Both orders' fills: nothing is pruned for being old without the owner's word, retention.ts.)
  assert.deepEqual(removed, { wallets: 1, engines: 2, orders: 2, fills: 2, fees: 2, keys: 1, evidence: 1, days: 1 });

  // The very next request starts from nothing.
  const clean = w.ask(wallet);
  assert.deepEqual(clean.fee, { perps: 20, spot: 20 });
  assert.deepEqual(clean.flags, []);
  assert.deepEqual({ ...clean.volume, pending: false }, { perpsUsd: 0, spotUsd: 0, totalUsd: 0, days: null, verifiedAt: null, pending: false });

  // The queued verification finds its wallet gone and writes nothing.
  const sent = w.sodex.calls.length;
  await drive(w.svc.verifier!, w.clock, HOUR);
  assert.equal(w.sodex.calls.length, sent, 'not even a request');
  assert.deepEqual(w.svc.store!.rowsOf(wallet), { wallets: 0, engines: 0, orders: 0, fills: 0, fees: 0, keys: 0, evidence: 0, days: 0 });
  assert.equal(w.svc.verifier!.pending(wallet), false);

  // A new run with the same wallet: what it did before is not counted again, what it does now is.
  w.clock.advance(MIN);
  w.sodex.order(wallet, { engine: 'perps', orderId: nextId(), at: w.clock.now(), builder: { id: BUILDER, fee: 20 }, key: app, fills: [{ price: '50000', quantity: '0.0001' }] });
  w.clock.advance(SEC);
  const again = await w.verify(wallet);
  assert.equal(again.volume.perpsUsd, 5, 'only the order placed after the wallet was forgotten');
  assert.deepEqual(again.flags, [], 'the underpaid order of the first run is not found again');
  assert.deepEqual(again.fee, { perps: 20, spot: 20 });
  assert.equal(w.svc.store!.wallet(BUILDER, wallet)!.floor, forgotAt);
  w.sodex.order(wallet, { engine: 'perps', orderId: nextId(), at: w.clock.now(), builder: { id: BUILDER, fee: 20 }, key: app, fills: [{ price: '50000', quantity: '0.0002' }] });
  w.clock.advance(SEC);
  const second = await w.verify(wallet);
  assert.equal(second.volume.perpsUsd, 15);
  assert.deepEqual(second.fee, { perps: 15, spot: 20 }, 'the fee change is seen again, from the start');
});

test('forget: a lookup in flight for a forgotten wallet is not written either', async () => {
  const w = world();
  const { wallet, app } = trader(w, 380);
  w.clock.advance(SEC);
  for (let i = 0; i < 3; i++) w.sodex.order(wallet, { engine: 'perps', orderId: nextId(), at: w.clock.now() + i, builder: { id: BUILDER, fee: 20 }, key: app, fills: [{ price: '100', quantity: '0.01' }] });
  w.clock.advance(SEC);
  w.ask(wallet, true);
  await drive(w.svc.verifier!, w.clock, 5 * SEC);
  assert.equal(w.svc.store!.wallet(BUILDER, wallet)!.openN, 2, 'one of three is looked up, two wait');
  const tool = new BuilderStore(w.dbPath);
  tool.forget(wallet, w.clock.now());
  tool.close();
  await drive(w.svc.verifier!, w.clock, HOUR);
  assert.deepEqual(w.svc.store!.rowsOf(wallet), { wallets: 0, engines: 0, orders: 0, fills: 0, fees: 0, keys: 0, evidence: 0, days: 0 });
  assert.equal(w.ask(wallet).volume.totalUsd, 0);
});

// --- the ledger itself ----------------------------------------------------------------------------------------

test('ledger: another builder id starts a fresh ledger and loses nothing of the old one', async () => {
  const w = world();
  const { wallet, app } = trader(w, 390);
  w.clock.advance(SEC);
  w.sodex.order(wallet, { engine: 'perps', orderId: nextId(), at: w.clock.now(), builder: { id: BUILDER, fee: 20 }, key: app, fills: [{ price: '50000', quantity: '0.001' }] });
  w.clock.advance(SEC);
  assert.equal((await w.verify(wallet)).volume.perpsUsd, 50);

  // The file now names another builder (a typo, or a new account).
  writeFileSync(join(w.dir, 'builder-tiers.json'), JSON.stringify({ ...testTiers(BUILDER + 1), _n: 'changed' }));
  await w.svc.refresh();
  const other = w.svc.terms({ address: wallet, nonce: 'n'.repeat(16), hint: false, client: 'c' });
  assert.ok(other.builderId === BUILDER + 1);
  assert.equal(other.volume.totalUsd, 0);
  assert.deepEqual(other.fee, { perps: 20, spot: 20 });
  // Back to the first builder: its ledger is as it was.
  writeFileSync(join(w.dir, 'builder-tiers.json'), JSON.stringify({ ...testTiers(BUILDER), _n: 'and back again' }));
  await w.svc.refresh();
  const back = w.ask(wallet);
  assert.equal(back.volume.perpsUsd, 50);
  assert.deepEqual(back.fee, { perps: 15, spot: 20 });
});

test('ledger: with the owner saying so (VALUESCAN_PRUNE=builder) order rows are kept while an order may still fill, then dropped; a late fill is looked up afresh', async () => {
  process.env.VALUESCAN_PRUNE = 'builder';
  try {
    const w = world();
    const { wallet, app } = trader(w, 400);
    w.clock.advance(SEC);
    const id = nextId();
    w.sodex.order(wallet, { engine: 'perps', orderId: id, at: w.clock.now(), builder: { id: BUILDER, fee: 20 }, key: app, fills: [{ price: '100', quantity: '0.01' }] });
    w.clock.advance(SEC);
    await w.verify(wallet);
    assert.ok(w.svc.store!.order(BUILDER, wallet, 'perps', `BTC-USD:${id}`));
    // Forty days later the row is gone with the next pass ...
    w.clock.advance(40 * DAY);
    await w.verify(wallet);
    assert.equal(w.svc.store!.order(BUILDER, wallet, 'perps', `BTC-USD:${id}`), null);
    assert.equal(w.ask(wallet).volume.perpsUsd, 1, 'what it counted stays counted');
    // ... and should the order fill again after all, the explorer is asked once more and only the new fill is added.
    w.sodex.fillMore(wallet, 'perps', id, [{ price: '100', quantity: '0.02', at: w.clock.now() }]);
    w.clock.advance(SEC);
    const lookups = w.sodex.count('explorer');
    assert.equal((await w.verify(wallet)).volume.perpsUsd, 3);
    assert.equal(w.sodex.count('explorer'), lookups + 1);
  } finally {
    delete process.env.VALUESCAN_PRUNE;
  }
});

test('ledger: unless the owner says so an order row is kept however old, and a late fill adds only itself', async () => {
  const w = world();
  const { wallet, app } = trader(w, 401);
  w.clock.advance(SEC);
  const id = nextId();
  w.sodex.order(wallet, { engine: 'perps', orderId: id, at: w.clock.now(), builder: { id: BUILDER, fee: 20 }, key: app, fills: [{ price: '100', quantity: '0.01' }] });
  w.clock.advance(SEC);
  await w.verify(wallet);
  w.clock.advance(40 * DAY);
  await w.verify(wallet);
  assert.ok(w.svc.store!.order(BUILDER, wallet, 'perps', `BTC-USD:${id}`), 'kept (retention.ts)');
  w.sodex.fillMore(wallet, 'perps', id, [{ price: '100', quantity: '0.02', at: w.clock.now() }]);
  w.clock.advance(SEC);
  assert.equal((await w.verify(wallet)).volume.perpsUsd, 3);
});

test('counting: with volumeDays 14 a new wallet is read back 14 days, and its volume of those days sets the tier', async () => {
  const w = world({ tiers: { builderId: BUILDER, maxFeeRate: 25, volumeDays: 14, tiers: [{ minVolumeUsd: 0, perps: 20, spot: 20 }, { minVolumeUsd: 10, perps: 15, spot: 20 }] } });
  const { wallet, app } = trader(w, 31);
  // A fill ten days before the wallet is taken on: past the 7-day lookback, inside the 14-day window.
  const t1 = w.clock.now() - 10 * DAY;
  w.sodex.order(wallet, { engine: 'perps', orderId: nextId(), at: t1, builder: { id: BUILDER, fee: 20 }, key: app, fills: [{ price: '1000', quantity: '0.012' }] });
  w.clock.advance(SEC);
  const created = w.clock.now();
  const t = await w.verify(wallet);
  const starts = w.sodex.calls.filter((c) => c.kind === 'trades' && c.path.includes('/perps/')).map((c) => Number(new URLSearchParams(c.path.split('?')[1]).get('startTime')));
  assert.equal(starts[0], created - 14 * DAY, 'read back as far as the window reaches');
  assert.equal(t.volume.perpsUsd, 12);
  assert.deepEqual(t.fee, { perps: 15, spot: 20 }, '$12 in the last 14 days: the $10 tier');
  // Five days later that fill is 15 days old: out of the window, back on the default fee - with no new read at all.
  w.clock.advance(5 * DAY);
  const later = w.ask(wallet);
  assert.equal(later.volume.perpsUsd, 0);
  assert.deepEqual(later.fee, { perps: 20, spot: 20 });
});

test('traded: every fill counts toward all the wallet traded - with no builder fee (the invite welcome), ours or none - once, across overlapping sweeps', async () => {
  const w = world();
  const { wallet, app, own } = trader(w, 9);
  w.clock.advance(SEC);
  const day = dayOf(w.clock.now());
  // The welcome's orders name the builder at fee 0: SoDEX charges nothing, the ledger counts nothing - traded does.
  const free = nextId();
  w.sodex.order(wallet, { engine: 'perps', orderId: free, at: w.clock.now(), builder: { id: BUILDER, fee: 0 }, key: app, fills: [{ price: '100', quantity: '0.5' }] });
  w.sodex.order(wallet, { engine: 'perps', orderId: nextId(), at: w.clock.now(), builder: null, key: own, fills: [{ price: '100', quantity: '0.2' }] });
  w.sodex.order(wallet, { engine: 'spot', orderId: nextId(), at: w.clock.now(), builder: { id: BUILDER, fee: 0 }, key: app, side: 'SELL', fills: [{ price: '100', quantity: '0.1' }] });
  w.clock.advance(SEC);
  const t = await w.verify(wallet);
  assert.equal(t.volume.perpsUsd, 0, 'nothing paid a builder fee: nothing counted');
  assert.deepEqual(w.svc.store!.tradedMicro(BUILDER, wallet, day), { perps: 70_000_000, spot: 10_000_000 });
  // Read again (the overlap comes back each time): nothing twice.
  for (let i = 0; i < 3; i++) {
    w.clock.advance(SEC);
    await w.verify(wallet);
  }
  assert.deepEqual(w.svc.store!.tradedMicro(BUILDER, wallet, day), { perps: 70_000_000, spot: 10_000_000 });
  // The order fills further later: only the new fill adds.
  w.clock.advance(10 * MIN);
  w.sodex.fillMore(wallet, 'perps', free, [{ price: '100', quantity: '0.3', at: w.clock.now() }]);
  w.clock.advance(SEC);
  await w.verify(wallet);
  assert.deepEqual(w.svc.store!.tradedMicro(BUILDER, wallet, day), { perps: 100_000_000, spot: 10_000_000 });
  // Up to when every fill was read: what the executor counts its own fills after.
  assert.ok(w.svc.store!.readThrough(BUILDER, wallet) >= w.clock.now() - 2 * MIN, 'read up to about now');
});
