/**
 * The admin suite (routes/admin.ts, admin/*): off without a password; the sign-in is
 * an admin wallet's signature AND the password, the signature first; the lock after
 * wrong passwords; 24-hour sessions; every write signed for exactly what it does;
 * the Origin; the hosted gate's `admin` class; the audit chain; the builder numbers;
 * the analytics it reads (ops/analytics.ts, routes/analytics.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import Fastify from 'fastify';
import { secp256k1 } from '@noble/curves/secp256k1';

import { adminRoutes, LOCK_AFTER, type AdminRouteOptions } from '../src/routes/admin.js';
import { analyticsRoutes } from '../src/routes/analytics.js';
import { ADMIN_SESSION_TTL_MS, adminActionDigest, adminSignInDigest, hashPassword, verifyPassword, writePasswordHash } from '../src/admin/auth.js';
import { ADMIN_SIGN_IN_STATEMENT, adminPayloadHash, canonicalJson, type AdminAction, type AdminActionName, type AdminSignIn } from '../src/admin/signIn.js';
import { AdminStore } from '../src/admin/store.js';
import { openLedger } from '../src/admin/builderStats.js';
import { FeedbackStore } from '../src/ops/feedbackThreads.js';
import { AnalyticsStore, parseAnalytics } from '../src/ops/analytics.js';
import { BuilderStore } from '../src/builder/store.js';
import { OrderState } from '../src/builder/counting.js';
import { testTiers, validateTiers } from '../src/builder/config.js';
import { DEFAULT_LIMITS, installHostedGate, type HostedConfig } from '../src/hosted.js';
import { KeyedLimiter } from '../src/rateLimit.js';
import { bytesToHex, privateKeyToAddress } from '../src/signing/eip712.js';
import { tempDir } from './builderFakes.js';

const DIR = tempDir('vs-admin-');
const DEV = 'https://dev.valuedesk.so';
const SITE = 'https://www.valuedesk.so';
const PASSWORD = 'correct horse battery staple';
let caseNo = 0;

function newWallet() {
  const key = randomBytes(32);
  return { key, address: privateKeyToAddress(key).toLowerCase() };
}
type W = ReturnType<typeof newWallet>;

const rsv = (digest: Uint8Array, key: Uint8Array): string => {
  const sig = secp256k1.sign(digest, key, { lowS: true, prehash: false });
  const out = new Uint8Array(65);
  out.set(sig.toBytes('compact'), 0);
  out[64] = 27 + sig.recovery;
  return bytesToHex(out);
};

function signIn(w: W, o: Partial<AdminSignIn> = {}, now = Date.now()): AdminSignIn {
  const base = { owner: w.address, statement: ADMIN_SIGN_IN_STATEMENT, nonce: randomBytes(16).toString('hex'), issuedAt: String(now), expiresAt: String(now + 4 * 60_000), chainId: 1, ...o };
  return { ...base, signature: rsv(adminSignInDigest(base), w.key) };
}

function action(w: W, a: AdminActionName, target: string, payload: unknown, now = Date.now(), o: Partial<AdminAction> = {}): AdminAction {
  const base = {
    owner: w.address, action: a, target, summary: 'a test', payload: adminPayloadHash(payload), nonce: randomBytes(16).toString('hex'),
    issuedAt: String(now), expiresAt: String(now + 4 * 60_000), chainId: 1, ...o,
  };
  return { ...base, signature: rsv(adminActionDigest(base), w.key) };
}

async function suite(o: Partial<AdminRouteOptions> & { password?: string | null; gate?: boolean } = {}) {
  const dir = join(DIR, `case-${caseNo++}`);
  const admin = newWallet();
  const passwordPath = join(dir, 'admin-auth', 'password');
  if (o.password !== null) writePasswordHash(await hashPassword(o.password ?? PASSWORD, { logN: 12 }), passwordPath);
  const store = o.store ?? new AdminStore(join(dir, 'admin.db'));
  const feedback = o.feedback ?? new FeedbackStore(join(dir, 'feedback.db'));
  const told: string[] = [];
  const app = Fastify();
  await app.register(adminRoutes, {
    store, feedback, passwordPath, admins: [admin.address], origins: [DEV], hosted: o.gate ?? false, limiter: new KeyedLimiter(),
    tell: async (t: string) => (told.push(t), told.length),
    ...o,
  });
  if (o.gate) {
    const cfg: HostedConfig = { enabled: true, trustProxy: false, originSecrets: [], limits: DEFAULT_LIMITS };
    installHostedGate(app, { cfg, site: [SITE], admin: [DEV] });
  }
  await app.ready();
  const post = (url: string, payload: unknown = {}, headers: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url, payload: JSON.stringify(payload), headers: { 'content-type': 'application/json', origin: DEV, ...headers } });
  const login = async (w = admin) => {
    const r = await post('/api/admin/session', { signIn: signIn(w, {}, o.now?.() ?? Date.now()), password: PASSWORD });
    assert.equal(r.statusCode, 200, r.body);
    return { authorization: `Bearer ${r.json().token as string}` };
  };
  return { app, admin, store, feedback, told, post, login, dir, passwordPath };
}

// --- off, and the lock ---------------------------------------------------------------------

test('no password set: every admin route is a 404, signed in or not', async () => {
  const s = await suite({ password: null });
  for (const url of ['/api/admin/session', '/api/admin/me', '/api/admin/tickets', '/api/admin/status']) {
    assert.equal((await s.post(url, { signIn: signIn(s.admin), password: PASSWORD })).statusCode, 404, url);
  }
});

test('sign-in: the admin wallet AND the password; another wallet, a replay or a wrong password is refused', async () => {
  const s = await suite();
  const other = newWallet();
  assert.equal((await s.post('/api/admin/session', { signIn: signIn(other), password: PASSWORD })).json().code, 'signature');
  // A signature that names the admin but was made by another key.
  const forged = { ...signIn(other), owner: s.admin.address };
  assert.equal((await s.post('/api/admin/session', { signIn: forged, password: PASSWORD })).statusCode, 401);
  const wrong = await s.post('/api/admin/session', { signIn: signIn(s.admin), password: 'not the password at all' });
  assert.equal(wrong.statusCode, 401);
  assert.equal(wrong.json().code, 'password');
  assert.match(s.told.at(-1)!, /^🚨 FAILURE · Admin sign-in refused: wrong password/);
  const once = signIn(s.admin);
  const ok = await s.post('/api/admin/session', { signIn: once, password: PASSWORD });
  assert.equal(ok.statusCode, 200);
  assert.match(ok.json().token, /^vda_[A-Za-z0-9_-]{43}$/);
  assert.match(s.told.at(-1)!, /^ℹ️ INFO · Admin sign-in/);
  assert.equal((await s.post('/api/admin/session', { signIn: once, password: PASSWORD })).statusCode, 401, 'a sign-in is used once');
  // Never the password, in the audit or what the owner is told.
  const audit = JSON.stringify(s.store.auditRows({ limit: 50 }));
  assert.ok(!audit.includes(PASSWORD) && !s.told.join('').includes(PASSWORD));
  assert.deepEqual(s.store.auditRows({ limit: 50 }).map((r) => `${r.kind}:${r.ok}`).reverse(), [
    'signin.signature:false', 'signin.signature:false', 'signin.password:false', 'signin:true', 'signin.signature:false',
  ]);
});

test(`sign-in lock: ${LOCK_AFTER} wrong passwords in 15 minutes lock it, even for the right one`, async () => {
  let t = 1_800_000_000_000;
  const s = await suite({ now: () => t });
  for (let i = 0; i < LOCK_AFTER; i++) {
    assert.equal((await s.post('/api/admin/session', { signIn: signIn(s.admin, {}, t), password: `wrong password ${i}` })).statusCode, 401);
  }
  const locked = await s.post('/api/admin/session', { signIn: signIn(s.admin, {}, t), password: PASSWORD });
  assert.equal(locked.statusCode, 423);
  assert.match(s.told.at(-1)!, /sign-in locked for 15 min/);
  t += 15 * 60_000 + 1_000;
  assert.equal((await s.post('/api/admin/session', { signIn: signIn(s.admin, {}, t), password: PASSWORD })).statusCode, 200);
});

test('a session: needed by every route, 24 hours from sign-in however used, ended by sign-out', async () => {
  let t = 1_800_000_000_000;
  const s = await suite({ now: () => t });
  assert.equal((await s.post('/api/admin/me')).statusCode, 401);
  assert.equal((await s.post('/api/admin/me', {}, { authorization: `Bearer vda_${'A'.repeat(43)}` })).statusCode, 401);
  const r = await s.post('/api/admin/session', { signIn: signIn(s.admin, {}, t), password: PASSWORD });
  const auth = { authorization: `Bearer ${r.json().token as string}` };
  assert.equal(r.json().expiresAt, t + ADMIN_SESSION_TTL_MS);
  t += ADMIN_SESSION_TTL_MS - 1_000;
  assert.equal((await s.post('/api/admin/me', {}, auth)).json().wallet, s.admin.address);
  t += 2_000;
  assert.equal((await s.post('/api/admin/me', {}, auth)).statusCode, 401, 'expired after 24 h');
  const again = await s.post('/api/admin/session', { signIn: signIn(s.admin, {}, t), password: PASSWORD });
  const auth2 = { authorization: `Bearer ${again.json().token as string}` };
  assert.equal((await s.post('/api/admin/signout', {}, auth2)).statusCode, 200);
  assert.equal((await s.post('/api/admin/tickets', {}, auth2)).statusCode, 401);
});

test('the Origin: only the suite\'s own; the hosted gate refuses the site\'s origin for an admin route', async () => {
  const s = await suite();
  const auth = await s.login();
  assert.equal((await s.post('/api/admin/me', {}, { ...auth, origin: 'https://evil.example' })).statusCode, 403);
  assert.equal((await s.post('/api/admin/me', {}, { ...auth, origin: SITE })).statusCode, 403);
  assert.equal((await s.post('/api/admin/me', {}, auth)).statusCode, 200);

  const g = await suite({ gate: true });
  assert.equal((await g.post('/api/admin/session', { signIn: signIn(g.admin), password: PASSWORD }, { origin: SITE })).statusCode, 403);
  const ok = await g.post('/api/admin/session', { signIn: signIn(g.admin), password: PASSWORD });
  assert.equal(ok.statusCode, 200, ok.body);
  // A GET of an admin path is no route at all.
  assert.equal((await g.app.inject({ method: 'GET', url: '/api/admin/me', headers: { origin: DEV } })).statusCode, 404);
});

test('the hosted gate has its say before the route: its origin secret and the suite\'s Origin, whatever the route allows', async () => {
  const dir = join(DIR, `gate-${caseNo++}`);
  const pw = join(dir, 'pw');
  writePasswordHash(await hashPassword(PASSWORD, { logN: 12 }), pw);
  const app = Fastify();
  // The route's own list lets the site's origin through here: only the gate can refuse it.
  await app.register(adminRoutes, {
    passwordPath: pw, store: new AdminStore(join(dir, 'a.db')), feedback: new FeedbackStore(join(dir, 'f.db')), origins: [SITE, DEV], hosted: true,
    admins: ['0x' + '1'.repeat(40)], limiter: new KeyedLimiter(), tell: async () => null,
  });
  const secret = 's'.repeat(40);
  installHostedGate(app, { cfg: { enabled: true, trustProxy: false, originSecrets: [secret], limits: DEFAULT_LIMITS }, site: [SITE], admin: [DEV] });
  await app.ready();
  const me = async (origin: string, withSecret = true) =>
    (await app.inject({ method: 'POST', url: '/api/admin/me', payload: '{}', headers: { 'content-type': 'application/json', origin, ...(withSecret ? { 'x-origin-verify': secret } : {}) } })).statusCode;
  assert.equal(await me(SITE), 403, "the site's origin, refused by the gate");
  assert.equal(await me(DEV, false), 403, 'no origin secret, refused by the gate');
  assert.equal(await me(DEV), 401, 'past the gate: no session');
});

// --- writes ---------------------------------------------------------------------------------

test('answering a ticket: the session alone writes nothing; the signature must cover this ticket and this text, once', async () => {
  const s = await suite();
  const auth = await s.login();
  const v = { wallet: '0x' + '1'.repeat(40) };
  const { threadId } = s.feedback.addUserMessage(v, { category: 'bug', text: 'the chart is blank', context: { route: '/trade' }, wallet: v.wallet, verified: true, images: [] });
  const list = (await s.post('/api/admin/tickets', {}, auth)).json().tickets as Array<{ id: number; status: string; lastText: string }>;
  assert.deepEqual(list.map((t) => [t.id, t.status, t.lastText]), [[threadId, 'open', 'the chart is blank']]);

  const text = 'Thanks - fixed in v0.2.110.';
  const target = `ticket ${threadId}`;
  assert.equal((await s.post('/api/admin/ticket/reply', { id: threadId, text }, auth)).statusCode, 403);
  const otherText = action(s.admin, 'ticket.reply', target, { id: threadId, text: 'something else' });
  assert.equal((await s.post('/api/admin/ticket/reply', { id: threadId, text, action: otherText }, auth)).json().code, 'signature');
  const otherTicket = action(s.admin, 'ticket.reply', `ticket ${threadId + 1}`, { id: threadId, text });
  assert.equal((await s.post('/api/admin/ticket/reply', { id: threadId, text, action: otherTicket }, auth)).statusCode, 403);
  const stranger = action(newWallet(), 'ticket.reply', target, { id: threadId, text });
  assert.equal((await s.post('/api/admin/ticket/reply', { id: threadId, text, action: { ...stranger, owner: s.admin.address } }, auth)).statusCode, 403);
  const statusSig = action(s.admin, 'ticket.status', target, { id: threadId, text });
  assert.equal((await s.post('/api/admin/ticket/reply', { id: threadId, text, action: statusSig }, auth)).statusCode, 403);

  const good = action(s.admin, 'ticket.reply', target, { id: threadId, text });
  const r = await s.post('/api/admin/ticket/reply', { id: threadId, text, action: good }, auth);
  assert.equal(r.statusCode, 200, r.body);
  assert.equal((await s.post('/api/admin/ticket/reply', { id: threadId, text, action: good }, auth)).statusCode, 403, 'a signature writes once');
  const msgs = s.feedback.messages(threadId);
  assert.deepEqual(msgs.map((m) => [m.from, m.text]), [['user', 'the chart is blank'], ['owner', text]]);
  assert.equal(s.feedback.summary(v)!.owner, 1, "the visitor's bell sees the answer");
  assert.match(s.told.at(-1)!, /^↩️ Answered on dev\.valuedesk\.so · thread #\d+\n\nThanks/);
  const after = (await s.post('/api/admin/tickets', {}, auth)).json().tickets as Array<{ status: string }>;
  assert.equal(after[0]!.status, 'waiting');

  const close = action(s.admin, 'ticket.status', target, { id: threadId, status: 'closed' });
  assert.equal((await s.post('/api/admin/ticket/status', { id: threadId, status: 'closed', action: close }, auth)).statusCode, 200);
  assert.equal(((await s.post('/api/admin/tickets', {}, auth)).json().tickets as Array<{ status: string }>)[0]!.status, 'closed');
  // The visitor writes again: open again.
  s.feedback.addUserMessage(v, { category: 'bug', text: 'still blank', context: null, wallet: v.wallet, verified: true, images: [] }, Date.now() + 5_000);
  assert.equal(((await s.post('/api/admin/tickets', {}, auth)).json().tickets as Array<{ status: string }>)[0]!.status, 'open');
  const one = (await s.post('/api/admin/ticket', { id: threadId }, auth)).json();
  assert.equal(one.messages.length, 3);
  assert.deepEqual(one.messages[0].context, { route: '/trade' });
});

test('signing every session out: signed, and then nothing opens', async () => {
  const s = await suite();
  const a = await s.login();
  const b = await s.login();
  assert.equal(((await s.post('/api/admin/me', {}, a)).json().sessions as unknown[]).length, 2);
  const sig = action(s.admin, 'sessions.revoke', 'all sessions', {});
  assert.equal((await s.post('/api/admin/sessions/revoke', { action: sig }, a)).json().ended, 2);
  assert.equal((await s.post('/api/admin/me', {}, a)).statusCode, 401);
  assert.equal((await s.post('/api/admin/me', {}, b)).statusCode, 401);
});

test('a stale or long-lived action signature is refused', async () => {
  const s = await suite();
  const auth = await s.login();
  const old = Date.now() - 10 * 60_000;
  const stale = action(s.admin, 'sessions.revoke', 'all sessions', {}, old);
  assert.equal((await s.post('/api/admin/sessions/revoke', { action: stale }, auth)).statusCode, 403);
  const long = action(s.admin, 'sessions.revoke', 'all sessions', {}, Date.now(), { expiresAt: String(Date.now() + 60 * 60_000) });
  assert.equal((await s.post('/api/admin/sessions/revoke', { action: long }, auth)).statusCode, 403);
});

// --- the audit chain, the password -------------------------------------------------------------

test('the audit log is a chain: a row changed afterwards shows', async () => {
  const s = await suite();
  await s.login();
  await s.login();
  assert.deepEqual(s.store.verifyAudit(), { rows: 2, brokenAt: null });
  s.store.close();
  const db = new DatabaseSync(join(s.dir, 'admin.db'));
  db.prepare("UPDATE audit SET country = 'XX' WHERE id = 1").run();
  db.close();
  assert.deepEqual(new AdminStore(join(s.dir, 'admin.db')).verifyAudit(), { rows: 1, brokenAt: 1 });
});

test('password: scrypt, salted, checked in constant time; malformed hashes and inputs are false', async () => {
  const h = await hashPassword(PASSWORD, { logN: 12 });
  assert.match(h, /^scrypt\$12\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{86}$/);
  assert.notEqual(h, await hashPassword(PASSWORD, { logN: 12 }), 'a new salt each time');
  assert.equal(await verifyPassword(PASSWORD, h), true);
  assert.equal(await verifyPassword(PASSWORD + ' ', h), false);
  assert.equal(await verifyPassword(undefined, h), false);
  assert.equal(await verifyPassword(PASSWORD, 'scrypt$40$8$1$x$y'), false);
  await assert.rejects(hashPassword('short'), /at least 12/);
  assert.equal(canonicalJson({ b: 1, a: [1, { d: 2, c: 'x' }] }), '{"a":[1,{"c":"x","d":2}],"b":1}');
});

// --- the builder's numbers ------------------------------------------------------------------------

test('builder numbers: counted volume, fees = notional x rate / 100 000, kept beyond the ledger\'s own order cap', async () => {
  const dir = join(DIR, `ledger-${caseNo++}`);
  const now = Date.UTC(2026, 9, 31, 12);
  const day = Math.floor(now / 86_400_000);
  const ledgerPath = join(dir, 'builder.db');
  const ledger = new BuilderStore(ledgerPath, { now });
  const a = '0x' + 'a'.repeat(40);
  const w = ledger.createWallet(234812, a, 7, now - 86_400_000, 0);
  ledger.recordFee(234812, a, { at: now - 86_400_000, perps: 15, spot: 15 });
  ledger.commitFills({
    builder: 234812, address: a, gen: w.createdAt, engine: 'perps', addMicro: 0, byDay: new Map(), queued: 1, noBuilder: { n: 0, at: 0 }, found: true,
    rows: [{ key: 'BTC-USD:1', orderId: '1', symbol: 'BTC-USD', clOrdID: 'vs-1', t: now - 1000, lastT: now - 1000, state: OrderState.pending, paidMicro: 10_000_000_000, rate: 15, countedMicro: 0, tries: 0, nextAt: 0 }],
    fills: [{ key: 'BTC-USD:9:1', t: now - 1000 }],
    state: { hi: now - 1000, swFrom: 0, swEnd: 0, swTop: 0, swPages: 0, sweptAt: now }, pruneFillsBefore: null,
  });
  ledger.commitLookup({
    builder: 234812, address: a, gen: w.createdAt, engine: 'perps', closed: true, addMicro: 10_000_000_000, byDay: new Map([[day, 10_000_000_000]]), now, misses: 0,
    row: { key: 'BTC-USD:1', orderId: '1', symbol: 'BTC-USD', clOrdID: 'vs-1', t: now - 1000, lastT: now - 1000, state: OrderState.counted, paidMicro: 10_000_000_000, rate: 15, countedMicro: 10_000_000_000, tries: 1, nextAt: 0 },
    underpaid: { n: 0, at: 0 }, tampered: { n: 0, at: 0 }, evidence: [],
  });
  ledger.close();
  const cfg = validateTiers(testTiers(234812)).config!;
  const s = await suite({ ledger: () => openLedger(ledgerPath), tiers: () => cfg, now: () => now });
  const auth = await s.login();
  const b = (await s.post('/api/admin/builder', { days: 7 }, auth)).json().builder;
  // $10,000 at 1.5 bp = $1.50 = 1,500,000 micro-USD.
  assert.deepEqual(b.volume.lifetime, { perps: 10_000_000_000, spot: 0 });
  assert.equal(b.fees.d1, 1_500_000);
  assert.deepEqual(b.fees.lifetime, { perps: 1_500_000, spot: 0 });
  assert.equal(b.wallets.total, 1);
  assert.equal(b.days.length, 7);
  const users = (await s.post('/api/admin/users', {}, auth)).json().users as Array<{ address: string; builder: { fees: unknown; volume30d: number; signedFee: { perps: number } } }>;
  assert.equal(users.length, 1);
  assert.deepEqual(users[0]!.builder.fees, { perps: 1_500_000, spot: 0 });
  assert.equal(users[0]!.builder.volume30d, 10_000_000_000);
  assert.equal(users[0]!.builder.signedFee.perps, 15);
  // The ledger drops the order (its 2,000-row cap): the fees stay counted.
  const raw = new DatabaseSync(ledgerPath);
  raw.prepare('DELETE FROM orders').run();
  raw.close();
  assert.equal((await s.post('/api/admin/builder', {}, auth)).json().builder.fees.lifetime.perps, 1_500_000);
});

// --- analytics ------------------------------------------------------------------------------------

const id = () => randomBytes(16).toString('base64url');

test('analytics: nothing without consent; routes scrubbed, unknown features dropped, the edge\'s country only', async () => {
  const now = Date.now();
  const visitor = id();
  const visit = id();
  assert.equal(parseAnalytics({ visitor, visit, events: [{ t: now, k: 'view', p: '/' }] }, now).ok, false, 'no consent, no batch');
  const p = parseAnalytics({
    consent: 'analytics', visitor, visit, wallet: '0x' + 'B'.repeat(40),
    ctx: { lang: 'de-DE', tz: 'Europe/Berlin', screen: '1920x1080', device: 'desktop', browser: 'chrome 130', os: 'windows', ref: 'www.X.com', utm: { source: 'x', campaign: 'launch' }, landing: '/trader/0xabcdef0123456789' },
    events: [
      { t: now, k: 'view', p: `/trader/0x${'c'.repeat(40)}?tab=fills` },
      { t: now, k: 'feature', p: '/trade', n: 'order.place', d: { venue: 'sodex', type: 'limit', size: 1.234, who: `0x${'d'.repeat(40)}`, note: 'free text here' } },
      { t: now, k: 'feature', p: '/trade', n: 'made.up' },
      { t: now, k: 'time', p: '/trade', ms: 42_000 },
      { t: now - 7 * 3_600_000, k: 'view', p: '/old' },
    ],
  }, now);
  assert.ok(p.ok);
  const b = p.batch;
  assert.equal(b.events.length, 3);
  assert.equal(b.events[0]!.p, '/trader/:address');
  assert.equal(b.events[1]!.d, JSON.stringify({ venue: 'sodex', type: 'limit', size: 1.23 }));
  assert.equal(b.ctx.ref, 'x.com');
  assert.equal(b.ctx.landing, '/trader/:address');
  assert.equal(b.wallet, '0x' + 'b'.repeat(40));

  const dir = join(DIR, `analytics-${caseNo++}`);
  const store = new AnalyticsStore(join(dir, 'analytics.db'));
  const app = Fastify();
  await app.register(analyticsRoutes, { store, trustGeo: true, limiter: new KeyedLimiter() });
  const body = { consent: 'analytics', visitor, visit, ctx: { device: 'mobile' }, events: [{ t: Date.now(), k: 'view', p: '/scan' }, { t: Date.now(), k: 'feature', p: '/scan', n: 'search.run' }] };
  const r = await app.inject({ method: 'POST', url: '/api/vs/a', payload: JSON.stringify(body), headers: { 'content-type': 'text/plain', 'x-viewer-country': 'de', 'x-viewer-region': 'RP' } });
  assert.equal(r.statusCode, 204);
  const sum = store.summary(Date.now() - 86_400_000, Date.now() + 86_400_000);
  assert.equal(sum.totals.visits, 1);
  assert.equal(sum.totals.views, 1);
  assert.deepEqual(sum.countries, [{ key: 'DE', n: 1 }]);
  assert.deepEqual(sum.regions, [{ key: 'DE-RP', n: 1 }]);
  assert.deepEqual(sum.features.map((f) => [f.key, f.n]), [['search.run', 1]]);
  assert.equal((await app.inject({ method: 'POST', url: '/api/vs/a', payload: JSON.stringify({ ...body, consent: undefined }), headers: { 'content-type': 'application/json' } })).statusCode, 400);

  // Without the edge (local dev): no country, whatever a header says.
  const app2 = Fastify();
  const store2 = new AnalyticsStore(join(dir, 'analytics2.db'));
  await app2.register(analyticsRoutes, { store: store2, limiter: new KeyedLimiter() });
  await app2.inject({ method: 'POST', url: '/api/vs/a', payload: JSON.stringify(body), headers: { 'content-type': 'application/json', 'x-viewer-country': 'US' } });
  assert.deepEqual(store2.summary(Date.now() - 86_400_000, Date.now() + 86_400_000).countries, [{ key: '(none)', n: 1 }]);
  writeFileSync(join(dir, 'done'), '');
});
