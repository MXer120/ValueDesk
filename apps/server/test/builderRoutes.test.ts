/**
 * GET /api/vs/builder/terms as a request sees it (docs/BUILDER-TIERS.md §3):
 * what is checked before anything is signed, what the answer carries and how
 * it is cached, that asking writes nothing, and how the hosted gate counts it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Fastify from 'fastify';

import { testTiers } from '../src/builder/config.js';
import { BuilderService } from '../src/builder/service.js';
import { termsMessage, writeNewKeyFile } from '../src/builder/terms.js';
import { FLAGS, MICRO } from '../src/builder/tiers.js';
import { OrderState, dayOf } from '../src/builder/counting.js';
import { DEFAULT_LIMITS, HOSTED_ROUTES, hostedRoute, installHostedGate, limitsFor, type HostedConfig } from '../src/hosted.js';
import { CACHE_POLICIES, perfPlugin } from '../src/perf.js';
import { builderRoutes } from '../src/routes/builder.js';
import { BUILDER, CHAIN, Clock, FakeSodex, MemoryLog, addr, apiKey, drive, tempDir } from './builderFakes.js';

const DIR = tempDir('vs-btiers-route-');
const URL_PATH = '/api/vs/builder/terms';
const NONCE = 'q7Xc-2_LmN0pRsTuVw';
const PARTNER = addr(0xbeef);
const NOTE = 'private-note-about-this-partner-7731';

const OPEN: BuilderService[] = [];
test.after(() => {
  for (const s of OPEN) s.stop();
});

let caseNo = 0;
function setup(o: { tiers?: Record<string, unknown> | null; key?: boolean } = {}) {
  const dir = join(DIR, `case-${caseNo++}`);
  mkdirSync(dir, { recursive: true });
  const tiersPath = join(dir, 'builder-tiers.json');
  const keyPath = join(dir, 'builder-terms.key');
  const dbPath = join(dir, 'builder.db');
  if (o.tiers !== null) writeFileSync(tiersPath, JSON.stringify(o.tiers ?? { ...testTiers(BUILDER), overrides: { [PARTNER]: { perps: 10, spot: 10, note: NOTE } } }));
  if (o.key !== false) writeNewKeyFile(keyPath);
  const clock = new Clock();
  const sodex = new FakeSodex(clock);
  const log = new MemoryLog();
  const svc = new BuilderService({ tiersPath, keyPath, dbPath, chainId: CHAIN, io: sodex, log, now: clock.now });
  svc.load();
  OPEN.push(svc);
  return { dir, tiersPath, keyPath, dbPath, clock, sodex, log, svc };
}

async function appFor(svc: BuilderService) {
  const app = Fastify();
  // As index.ts does: compression and caching first, the security headers after the routes.
  await app.register(perfPlugin);
  await app.register(builderRoutes, { service: svc });
  app.addHook('onSend', async (_req, reply, payload) => {
    if (!reply.hasHeader('Cache-Control')) reply.header('Cache-Control', 'no-store');
    return payload;
  });
  await app.ready();
  return app;
}

const get = (app: Awaited<ReturnType<typeof appFor>>, query: string, headers: Record<string, string> = {}) =>
  app.inject({ method: 'GET', url: `${URL_PATH}?${query}`, headers: { 'accept-encoding': 'br, gzip', ...headers } });

test('route: the answer of the contract - every field, signed, for the lower-case address', async () => {
  const s = setup();
  const app = await appFor(s.svc);
  try {
    const wallet = '0x52908400098527886E0F7030069857D2E4169EE7';
    const r = await get(app, `address=${wallet}&nonce=${NONCE}`);
    assert.equal(r.statusCode, 200);
    const body = r.json();
    assert.deepEqual(Object.keys(body), ['ok', 'chain', 'builderId', 'address', 'fee', 'nonce', 'issued', 'ttl', 'keyId', 'sig', 'default', 'volume', 'tier', 'flags']);
    assert.deepEqual(
      { ...body, sig: 'x', keyId: 'x' },
      {
        ok: true, chain: 286623, builderId: BUILDER, address: wallet.toLowerCase(), fee: { perps: 20, spot: 20 }, nonce: NONCE, issued: s.clock.now(), ttl: 600_000,
        keyId: 'x', sig: 'x', default: { perps: 20, spot: 20 },
        volume: { perpsUsd: 0, spotUsd: 0, totalUsd: 0, days: null, verifiedAt: null, pending: false },
        tier: { index: 0, next: { atUsd: 10, fee: { perps: 15, spot: 20 } } },
        flags: [],
      },
    );
    const signer = s.svc.keys.current()!;
    assert.equal(body.keyId, signer.keyId);
    const message = termsMessage({ chain: body.chain, builderId: body.builderId, address: body.address, perps: body.fee.perps, spot: body.fee.spot, nonce: body.nonce, issued: body.issued, ttl: body.ttl });
    const key = await crypto.subtle.importKey('raw', Buffer.from(signer.publicKey, 'base64url'), { name: 'Ed25519' }, false, ['verify']);
    assert.equal(await crypto.subtle.verify('Ed25519', key, Buffer.from(body.sig, 'base64url'), new TextEncoder().encode(message)), true);
  } finally {
    await app.close();
  }
});

test('route: never cached, never transformed - no ETag, no compression, whatever is asked for', async () => {
  const s = setup();
  const app = await appFor(s.svc);
  try {
    for (const q of [`address=${addr(1)}&nonce=${NONCE}`, `address=${addr(1)}&nonce=${NONCE}&hint=1`, 'address=nope', '']) {
      const r = await get(app, q);
      assert.equal(r.headers['cache-control'], 'no-store, no-transform', q);
      assert.equal(r.headers.etag, undefined, q);
      assert.equal(r.headers['content-encoding'], undefined, q);
    }
    assert.equal(CACHE_POLICIES[URL_PATH], undefined, 'the route has no cache policy');
    // A conditional request is answered in full: there is nothing to revalidate.
    const r = await get(app, `address=${addr(1)}&nonce=${NONCE}`, { 'if-none-match': '*' });
    assert.equal(r.statusCode, 200);
    assert.ok(r.body.length > 100);
  } finally {
    await app.close();
  }
});

test('route: address, nonce and hint are checked here - nothing unchecked reaches the text that is signed', async () => {
  const s = setup();
  const app = await appFor(s.svc);
  const a = addr(0xabc);
  try {
    const bad = [
      '', `nonce=${NONCE}`, `address=${a}`,
      `address=0x123&nonce=${NONCE}`, `address=${a}00&nonce=${NONCE}`, `address=${a.slice(2)}&nonce=${NONCE}`, `address=../../x&nonce=${NONCE}`,
      `address=${a}%0Aperps:0&nonce=${NONCE}`, `address=${a}&address=${a}&nonce=${NONCE}`,
      `address=${a}&nonce=short`, `address=${a}&nonce=${'A'.repeat(65)}`, `address=${a}&nonce=${NONCE}%0Aperps:0`, `address=${a}&nonce=${NONCE}%3Aspot`,
      `address=${a}&nonce=${NONCE}%20`, `address=${a}&nonce=${NONCE}&nonce=${NONCE}`, `address=${a}&nonce=${encodeURIComponent('AAAAAAAAAAAAAAAA+/=')}`,
      `address=${a}&nonce=${NONCE}&hint=2`, `address=${a}&nonce=${NONCE}&hint=true`, `address=${a}&nonce=${NONCE}&hint=`, `address=${a}&nonce=${NONCE}&hint=1&hint=1`,
    ];
    for (const q of bad) {
      const r = await get(app, q);
      assert.equal(r.statusCode, 400, q);
      const body = r.json();
      assert.equal(body.ok, false, q);
      assert.equal(typeof body.error, 'string');
      assert.ok(!('sig' in body), q);
    }
    assert.equal(s.sodex.calls.length, 0);
    assert.deepEqual(s.svc.verifier!.queues, { jobs: 0, approvals: 0, denied: 0 }, 'a refused request leaves no hint');
    // The limits of the nonce, accepted.
    for (const nonce of ['A'.repeat(16), 'a_b-'.repeat(16)]) assert.equal((await get(app, `address=${a}&nonce=${nonce}`)).statusCode, 200, nonce);
    const hinted = await get(app, `address=${a}&nonce=${NONCE}&hint=1`);
    assert.equal(hinted.statusCode, 200);
    assert.equal(hinted.json().volume.pending, true);
    assert.equal(s.svc.verifier!.queues.approvals, 1);
  } finally {
    await app.close();
  }
});

test('route: with the feature off the answer says so, and nothing is created on disk', async () => {
  const s = setup({ tiers: null, key: false });
  const app = await appFor(s.svc);
  try {
    const r = await get(app, `address=${addr(1)}&nonce=${NONCE}&hint=1`);
    assert.equal(r.statusCode, 200);
    assert.deepEqual(r.json(), { ok: true, builderId: null });
    assert.equal(r.headers['cache-control'], 'no-store, no-transform');
    assert.equal(existsSync(s.dbPath), false, 'no database while the feature is off');
    assert.equal(s.svc.verifier, null);
    // Bad input is refused all the same.
    assert.equal((await get(app, 'address=x')).statusCode, 400);

    // The file appears: the feature is on with the next look at it, without a restart.
    writeFileSync(s.tiersPath, JSON.stringify(testTiers(BUILDER)));
    await s.svc.refresh();
    const on = (await get(app, `address=${addr(1)}&nonce=${NONCE}`)).json();
    assert.equal(on.builderId, BUILDER);
    assert.equal(on.sig, null, 'no key file yet: unsigned, so every app charges its default fee');
    assert.equal(on.keyId, null);
    assert.deepEqual(on.fee, { perps: 20, spot: 20 });
    // The tool creates the key; it is picked up the same way.
    const made = writeNewKeyFile(s.keyPath);
    await s.svc.refresh();
    const signed = (await get(app, `address=${addr(1)}&nonce=${NONCE}`)).json();
    assert.equal(signed.keyId, made.keyId);
    assert.equal(typeof signed.sig, 'string');
  } finally {
    await app.close();
  }
});

test('route: asking writes nothing - builder.db cannot grow from requests for wallets it does not know', async () => {
  const s = setup();
  const app = await appFor(s.svc);
  try {
    const before = statSync(s.dbPath).size;
    const version = () => (s.svc.store!.db.prepare('PRAGMA data_version').get() as { data_version: number }).data_version;
    const changes = () => (s.svc.store!.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
    const wal = () => (existsSync(`${s.dbPath}-wal`) ? statSync(`${s.dbPath}-wal`).size : 0);
    const [v0, c0, w0] = [version(), changes(), wal()];
    for (let i = 0; i < 400; i++) {
      const r = await get(app, `address=${addr(0x7000 + i)}&nonce=${NONCE}`);
      assert.equal(r.statusCode, 200);
    }
    assert.equal(changes(), c0, 'not one row was inserted, updated or deleted');
    assert.equal(version(), v0);
    assert.equal(statSync(s.dbPath).size, before);
    assert.equal(wal(), w0, 'and nothing was appended to the write-ahead log');
    assert.equal(s.sodex.calls.length, 0);
    // The same wallet asked a thousand times is still no row.
    for (let i = 0; i < 50; i++) await get(app, `address=${addr(0x7000)}&nonce=${NONCE}`);
    assert.equal(changes(), c0);
    assert.deepEqual(s.svc.store!.rowsOf(addr(0x7000)), { wallets: 0, engines: 0, orders: 0, fills: 0, fees: 0, keys: 0, evidence: 0, days: 0 });
  } finally {
    await app.close();
  }
});

test('route: a fee set by hand is answered - once on record, and the operator\'s note about the wallet never leaves the server', async () => {
  const s = setup();
  const app = await appFor(s.svc);
  try {
    const r = await get(app, `address=${PARTNER}&nonce=${NONCE}`);
    const body = r.json();
    assert.deepEqual(body.fee, { perps: 10, spot: 10 });
    assert.deepEqual(body.flags, ['override']);
    assert.ok(!r.body.includes(NOTE));
    assert.ok(!r.body.includes('note'));
    // The fee went on record with the first answer, and only then.
    for (let i = 0; i < 20; i++) await get(app, `address=${PARTNER}&nonce=${NONCE}`);
    assert.deepEqual(s.svc.store!.feeHistory(BUILDER, PARTNER).map((f) => [f.perps, f.spot]), [[10, 10]]);
    assert.ok(!s.log.text().includes(NOTE), 'nor is it logged');
  } finally {
    await app.close();
  }
});

test('route: flags are the four named ones and nothing else - anyone can ask for any address', async () => {
  const s = setup();
  const app = await appFor(s.svc);
  try {
    // A wallet with everything against it: underpaid, tampered, builder-less - and a partner on top.
    const wallet = PARTNER;
    const appKey = apiKey('valuescan-web');
    s.sodex.approve(wallet, 9001);
    s.sodex.listKey(wallet, appKey);
    s.clock.advance(1_000);
    s.sodex.order(wallet, { engine: 'perps', orderId: 1, at: s.clock.now(), builder: { id: BUILDER, fee: 20 }, key: appKey, fills: [{ price: '100', quantity: '1' }] });
    s.sodex.order(wallet, { engine: 'perps', orderId: 2, at: s.clock.now(), builder: { id: BUILDER, fee: 1 }, key: appKey, fills: [{ price: '100', quantity: '1' }] });
    s.sodex.order(wallet, { engine: 'perps', orderId: 3, at: s.clock.now(), builder: null, key: appKey, clOrdID: 'vs-none', fills: [{ price: '100', quantity: '1' }] });
    s.clock.advance(1_000);
    await get(app, `address=${wallet}&nonce=${NONCE}&hint=1`);
    await drive(s.svc.verifier!, s.clock, 3 * 3_600_000);
    const r = await get(app, `address=${wallet}&nonce=${NONCE}`);
    const body = r.json();
    assert.deepEqual(body.flags, ['underpaid', 'tampered', 'override', 'no-builder']);
    for (const f of body.flags) assert.ok((FLAGS as readonly string[]).includes(f));
    assert.deepEqual(body.fee, { perps: 10, spot: 10 }, 'the fee set by hand holds');
    assert.equal(body.volume.perpsUsd, 100);
    // What the server keeps for the operator - order ids, transaction hashes, key addresses - is not in the answer.
    const ev = s.svc.store!.evidenceOf(BUILDER, wallet);
    assert.equal(ev.length, 3);
    for (const e of ev) {
      assert.ok(!r.body.includes(e.txHash!));
      assert.ok(!r.body.includes(e.signer!));
    }
    assert.ok(!r.body.includes(appKey.address));
    assert.ok(!r.body.includes('valuescan-web'));
    assert.deepEqual(Object.keys(body).sort(), ['address', 'builderId', 'chain', 'default', 'fee', 'flags', 'issued', 'keyId', 'nonce', 'ok', 'sig', 'tier', 'ttl', 'volume']);
  } finally {
    await app.close();
  }
});

test('route: a failure inside is "no terms" for the app - a 200 that says so, with no detail', async () => {
  const broken = { terms: () => { throw new Error('disk on fire at C:\\secret\\path'); } } as unknown as BuilderService;
  const app = await appFor(broken);
  try {
    const r = await get(app, `address=${addr(1)}&nonce=${NONCE}`);
    assert.equal(r.statusCode, 200);
    assert.deepEqual(r.json(), { ok: false, code: 'unavailable', error: 'terms are not available right now' });
    assert.equal(r.headers['cache-control'], 'no-store, no-transform');
  } finally {
    await app.close();
  }
});

test('hosted: the route is public as a read; a hint also counts as a request that can cost upstream reads', async () => {
  const route = hostedRoute('GET', URL_PATH);
  assert.ok(route, 'the route is on the hosted list');
  assert.deepEqual(route, { method: 'GET', url: URL_PATH, cls: 'read', upstreamWhen: ['hint'] });
  assert.equal(HOSTED_ROUTES.filter((r) => r.url === URL_PATH).length, 1);
  const keys = (q: Record<string, string>) => limitsFor(route, q, DEFAULT_LIMITS, 'c').map((l) => l.key);
  assert.deepEqual(keys({ address: addr(1), nonce: NONCE }), ['read|c']);
  assert.deepEqual(keys({ address: addr(1), nonce: NONCE, hint: '1' }), ['read|c', 'upstream|c']);
  assert.equal(hostedRoute('POST', URL_PATH), null);

  // Through the real gate: a client that used up its upstream budget can still ask, it just cannot hint.
  const s = setup();
  const cfg: HostedConfig = { enabled: true, trustProxy: false, originSecrets: [], limits: { ...DEFAULT_LIMITS, upstream: { max: 3, windowMs: 60_000 } } };
  const app = Fastify();
  await app.register(builderRoutes, { service: s.svc });
  installHostedGate(app, { cfg, site: [] });
  await app.ready();
  try {
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await app.inject({ method: 'GET', url: `${URL_PATH}?address=${addr(0x9000 + i)}&nonce=${NONCE}&hint=1` })).statusCode);
    assert.deepEqual(codes, [200, 200, 200, 429, 429]);
    assert.equal((await app.inject({ method: 'GET', url: `${URL_PATH}?address=${addr(0x9000)}&nonce=${NONCE}` })).statusCode, 200);
    // The gate refuses a repeated parameter before the route sees it.
    assert.equal((await app.inject({ method: 'GET', url: `${URL_PATH}?address=${addr(1)}&address=${addr(2)}&nonce=${NONCE}` })).statusCode, 400);
    assert.equal(s.svc.verifier!.queues.approvals, 3);
  } finally {
    await app.close();
  }
});

test('route: with volumeDays the tiers go by the last 14 days - older volume no longer lowers the fee, and the answer shows the window', async () => {
  const W = addr(0xfeed);
  const DAY = 86_400_000;
  const s = setup({
    tiers: { builderId: BUILDER, maxFeeRate: 25, volumeDays: 14, tiers: [{ minVolumeUsd: 0, perps: 15, spot: 15 }, { minVolumeUsd: 1_000_000, perps: 12, spot: 12 }] },
  });
  const app = await appFor(s.svc);
  try {
    await get(app, `address=${W}&nonce=${NONCE}`); // opens the ledger; asking writes nothing
    const store = s.svc.store!;
    const now = s.clock.now();
    const w = store.createWallet(BUILDER, W, 77, now, 0);
    const counted = (t: number, usd: number, key: string) =>
      store.commitLookup({
        builder: BUILDER, address: W, gen: w.createdAt, engine: 'perps', closed: true, addMicro: usd * MICRO, byDay: new Map([[dayOf(t), usd * MICRO]]), now, misses: 0,
        row: { key, orderId: key, symbol: 'BTC-USD', clOrdID: 'vs-1', t, lastT: t, state: OrderState.counted, paidMicro: usd * MICRO, rate: 15, countedMicro: usd * MICRO, tries: 1, nextAt: 0 },
        underpaid: { n: 0, at: 0 }, tampered: { n: 0, at: 0 }, evidence: [],
      });
    const ask = async () => (await get(app, `address=${W}&nonce=${NONCE}`)).json();

    counted(now - 20 * DAY, 2_000_000, 'old');
    let body = await ask();
    assert.deepEqual(body.fee, { perps: 15, spot: 15 }, '$2M three weeks ago: outside the 14 days - the default fee');
    assert.equal(body.volume.totalUsd, 0);

    counted(now - 2 * DAY, 1_500_000, 'recent');
    body = await ask();
    assert.deepEqual(body.fee, { perps: 12, spot: 12 }, '$1.5M two days ago: the $1M tier');
    assert.equal(body.volume.totalUsd, 1_500_000);
    assert.equal(body.tier.index, 1);

    // Eleven days on, the $1.5M is 13 days old: still inside the 14 days (today included). A day later it is out.
    s.clock.advance(11 * DAY);
    assert.deepEqual((await ask()).fee, { perps: 12, spot: 12 });
    s.clock.advance(1 * DAY);
    body = await ask();
    assert.deepEqual(body.fee, { perps: 15, spot: 15 }, 'the volume left the window: back on the default fee');
    assert.equal(body.volume.totalUsd, 0);
    // Lifetime (no volumeDays): everything ever counted.
    writeFileSync(s.tiersPath, JSON.stringify({ builderId: BUILDER, maxFeeRate: 25, tiers: [{ minVolumeUsd: 0, perps: 15, spot: 15 }, { minVolumeUsd: 1_000_000, perps: 12, spot: 12 }] }));
    s.svc.load();
    body = await ask();
    assert.deepEqual(body.fee, { perps: 12, spot: 12 });
    assert.equal(body.volume.totalUsd, 3_500_000);
  } finally {
    await app.close();
  }
});

test('route: /api/vs/bots/vip tells a VIP program by its fee (VIP_PROGRAM_FEE), never by its label', async () => {
  const dir = join(DIR, `case-${caseNo++}`);
  mkdirSync(dir, { recursive: true });
  const tiersPath = join(dir, 'builder-tiers.json');
  const keyPath = join(dir, 'builder-terms.key');
  writeFileSync(tiersPath, JSON.stringify(testTiers(BUILDER)));
  writeNewKeyFile(keyPath);
  const clock = new Clock();
  const now = clock.now();
  const VIPW = addr(0xa1);
  const LABELLED = addr(0xa2);
  const BOTH = addr(0xa3);
  const prog = (address: string, fee: number, label: string, until: number | null) => ({ id: 1, address, products: ['perps', 'spot', 'copy', 'bots'] as Array<'perps' | 'spot' | 'copy' | 'bots'>, fee, from: now - 1, until, label, addedAt: now, addedBy: 'test' });
  const programs = (a: string) =>
    a === VIPW ? [prog(a, -1, 'Launch week', now + 86_400_000)]
    : a === LABELLED ? [prog(a, 3, 'VIP friends', null)]
    : a === BOTH ? [prog(a, -1, 'Beta VIP', now + 1_000), prog(a, -1, '', null)]
    : [];
  const svc = new BuilderService({ tiersPath, keyPath, dbPath: join(dir, 'builder.db'), chainId: CHAIN, io: new FakeSodex(clock), log: new MemoryLog(), now: clock.now, programs });
  svc.load();
  OPEN.push(svc);
  const app = await appFor(svc);
  try {
    await get(app, `address=${VIPW}&nonce=${NONCE}`); // opens the ledger
    const vip = async (a: string) => (await app.inject({ method: 'GET', url: `/api/vs/bots/vip?address=${a}` })).json();
    const a = await vip(VIPW);
    assert.equal(a.eligible, true);
    assert.deepEqual(a.promo, { until: now + 86_400_000, label: 'Launch week' }, 'a VIP program whose label does not say VIP');
    const b = await vip(LABELLED);
    assert.equal(b.promo, null, 'a plain fee program labelled "VIP" is not VIP');
    assert.equal(b.eligible, false);
    const c = await vip(BOTH);
    assert.deepEqual(c.promo, { until: null, label: 'VIP program' }, 'of two, the longest; an empty label reads "VIP program"');
  } finally {
    await app.close();
  }
});
