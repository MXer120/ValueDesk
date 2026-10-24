/**
 * Knowledge folders as a request sees them (routes/folders.ts, src/folders/):
 * the wallet sign-in and its token, the limits - counts, bytes, rates, the
 * server's own room - enforced by the server, what an upload may be and how it
 * is served back, that one wallet never reaches another's, moving and
 * reordering, and erasing everything.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import Fastify from 'fastify';
import { secp256k1 } from '@noble/curves/secp256k1';

import { bytesToHex, privateKeyToAddress } from '../src/signing/eip712.js';
import { SessionTokens, checkSignIn, signInDigest } from '../src/folders/auth.js';
import { DEFAULT_LIMITS, foldersConfigFromEnv, type FoldersConfig } from '../src/folders/limits.js';
import { FoldersStore } from '../src/folders/store.js';
import { checkNote, isPlainText, safeHref, sniffFile } from '../src/folders/validate.js';
import { SIGN_IN_STATEMENT, type SignIn } from '../src/folders/types.js';
import { foldersRoutes } from '../src/routes/folders.js';
import { HOSTED_ROUTES, hostedRoute, limitsFor, DEFAULT_LIMITS as HOSTED_LIMITS } from '../src/hosted.js';

const ROOT = mkdtempSync(join(tmpdir(), 'vs-folders-'));
const OPEN: FoldersStore[] = [];
test.after(() => {
  for (const s of OPEN) s.close();
  rmSync(ROOT, { recursive: true, force: true });
});

let caseNo = 0;
function config(over: Omit<Partial<FoldersConfig>, 'limits'> & { limits?: Partial<FoldersConfig['limits']> } = {}): FoldersConfig {
  return {
    dir: join(ROOT, `case-${caseNo++}`),
    signInsPerDay: 10,
    totalBytes: 1 << 30,
    minFreeBytes: 0,
    retentionMs: 365 * 86_400_000,
    ...over,
    limits: { ...DEFAULT_LIMITS, ...over.limits },
  };
}

function wallet() {
  const key = randomBytes(32);
  return { key, address: privateKeyToAddress(key).toLowerCase() };
}

/** A sign-in as a wallet makes it: the typed data's digest, signed (r, s, v = 27/28). */
function signIn(w: { key: Uint8Array; address: string }, o: Partial<SignIn> = {}, now = Date.now()): SignIn {
  const base = {
    owner: w.address,
    statement: SIGN_IN_STATEMENT,
    nonce: randomBytes(16).toString('hex'),
    issuedAt: String(now),
    expiresAt: String(now + 5 * 60_000),
    chainId: 1,
    ...o,
  };
  const sig = secp256k1.sign(signInDigest(base), w.key, { lowS: true, prehash: false });
  const rsv = new Uint8Array(65);
  rsv.set(sig.toBytes('compact'), 0);
  rsv[64] = 27 + sig.recovery;
  return { ...base, signature: bytesToHex(rsv), ...(o.signature ? { signature: o.signature } : {}) };
}

async function setup(o: { cfg?: FoldersConfig; free?: () => number; now?: () => number } = {}) {
  const cfg = o.cfg ?? config();
  const store = new FoldersStore(cfg, { freeBytes: o.free, now: o.now });
  OPEN.push(store);
  const tokens = new SessionTokens(cfg.dir);
  const app = Fastify();
  await app.register(foldersRoutes, { store, tokens, cfg, upkeep: false, now: o.now });
  await app.ready();
  const login = async (w = wallet()) => {
    const r = await app.inject({ method: 'POST', url: '/api/folders/session', payload: { signIn: signIn(w, {}, o.now?.()) } });
    assert.equal(r.statusCode, 200, r.body);
    return { ...w, token: r.json().token as string };
  };
  const call = (token: string | null, method: 'GET' | 'POST', url: string, payload?: unknown) =>
    app.inject({ method, url, headers: token ? { authorization: `Bearer ${token}` } : {}, ...(payload === undefined ? {} : { payload: payload as object }) });
  return { app, store, cfg, login, call };
}

const NOTE = { blocks: [{ type: 'h1', spans: [{ text: 'Thesis' }] }, { type: 'p', spans: [{ text: 'BTC ', marks: ['b'] }, { text: 'breaks out' }] }] };
const TABLE = { columns: ['Level', 'Why'], rows: [['64000', 'weekly high'], ['58000', 'gap']] };
const NEWS = { id: 'n1', title: 'ETF flows turn', href: 'https://sosovalue.com/news/1', time: 1_760_000_000_000, author: 'SoSoValue', symbols: ['BTC'], summary: 'Inflows.' };
const CHART = { v: 1, engine: 'perps', symbol: 'BTC-USD', interval: '1h', drawings: [{ name: 'segment', points: [{ timestamp: 1, value: 2 }] }], indicators: [{ name: 'VOL', visible: true }], include: { position: false, executions: false }, at: 1 };
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), randomBytes(2000), Buffer.from('\n%%EOF\n')]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(300)]);

/* ------------------------------------------------------------- sign-in ----- */

test('sign-in: the typed data digest is the one every EIP-712 wallet computes (pinned vector)', () => {
  const d = signInDigest({ owner: '0x' + '11'.repeat(20), statement: SIGN_IN_STATEMENT, nonce: 'ab'.repeat(16), issuedAt: '1760000000000', expiresAt: '1760000300000', chainId: 1 });
  // The same vector is pinned in apps/web/src/folders/session.test.ts, computed there by
  // @sodex-core's generic hashTypedData from signInTypedData - so the web signs what this checks.
  assert.equal(bytesToHex(d), SIGN_IN_VECTOR);
});
const SIGN_IN_VECTOR = '0x73723a8d8d4868b167a3b8c3300e4091dd053259a9568e21ea75402dff16fd5f';

test('sign-in: a wallet signs once and gets a token; a replay, another signer, a stale or a forged one does not', async () => {
  const s = await setup();
  const w = wallet();
  const si = signIn(w);
  const ok = await s.app.inject({ method: 'POST', url: '/api/folders/session', payload: { signIn: si } });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().owner, w.address);
  const replay = await s.app.inject({ method: 'POST', url: '/api/folders/session', payload: { signIn: si } });
  assert.equal(replay.statusCode, 409);
  assert.equal(replay.json().code, 'replay');

  const other = wallet();
  const forged = { ...signIn(other), owner: w.address };
  assert.equal((await s.app.inject({ method: 'POST', url: '/api/folders/session', payload: { signIn: forged } })).json().code, 'signature');
  const old = signIn(w, {}, Date.now() - 20 * 60_000);
  assert.match(checkSignIn(old).ok ? '' : (checkSignIn(old) as { error: string }).error, /expired/);
  const long = signIn(w, { expiresAt: String(Date.now() + 60 * 60_000) });
  assert.equal(checkSignIn(long).ok, false, 'valid for longer than ten minutes');
  const wrongText = signIn(w, { statement: 'Send all my funds' });
  assert.equal(checkSignIn(wrongText).ok, false, 'only the fixed statement');

  const t = (await s.login(w)).token;
  assert.equal((await s.call(t, 'GET', '/api/folders')).statusCode, 200);
  assert.equal((await s.call(null, 'GET', '/api/folders')).statusCode, 401);
  assert.equal((await s.call(t.slice(0, -2) + 'xx', 'GET', '/api/folders')).statusCode, 401, 'a forged mac');
});

test('sign-in: one address signs in a limited number of wallets a day', async () => {
  const s = await setup({ cfg: config({ signInsPerDay: 2 }) });
  await s.login();
  const second = await s.login();
  // The same wallet again is not a new one.
  await s.login({ key: second.key, address: second.address });
  const third = await s.app.inject({ method: 'POST', url: '/api/folders/session', payload: { signIn: signIn(wallet()) } });
  assert.equal(third.statusCode, 429);
});

/* -------------------------------------------------------------- limits ----- */

test('folders: three per wallet, named, renamed, reordered, deleted with what they hold', async () => {
  const s = await setup();
  const { token } = await s.login();
  const ids: string[] = [];
  for (const name of ['Macro', 'BTC', 'Alts']) {
    const r = await s.call(token, 'POST', '/api/folders/folder/create', { name });
    assert.equal(r.statusCode, 200, r.body);
    ids.push(r.json().folder.id);
  }
  const fourth = await s.call(token, 'POST', '/api/folders/folder/create', { name: 'One more' });
  assert.equal(fourth.statusCode, 409);
  assert.equal(fourth.json().code, 'folders-full');
  assert.equal((await s.call(token, 'POST', '/api/folders/folder/create', { name: '   ' })).statusCode, 400);
  assert.equal((await s.call(token, 'POST', '/api/folders/folder/create', { name: 'x'.repeat(61) })).statusCode, 400);

  assert.equal((await s.call(token, 'POST', '/api/folders/folder/rename', { id: ids[0], name: 'Macro & rates' })).json().folders[0].name, 'Macro & rates');
  const ordered = await s.call(token, 'POST', '/api/folders/folder/order', { ids: [ids[2], ids[0], ids[1]] });
  assert.deepEqual(ordered.json().folders.map((f: { id: string }) => f.id), [ids[2], ids[0], ids[1]]);
  assert.equal((await s.call(token, 'POST', '/api/folders/folder/order', { ids: [ids[0], ids[1]] })).statusCode, 400, 'every folder once');

  const up = await s.call(token, 'POST', `/api/folders/upload?folderId=${ids[1]}&name=a.pdf`, undefined);
  assert.notEqual(up.statusCode, 200, 'an upload without a body');
  const pdf = await s.app.inject({ method: 'POST', url: `/api/folders/upload?folderId=${ids[1]}&name=a.pdf`, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' }, payload: PDF });
  assert.equal(pdf.statusCode, 200, pdf.body);
  const file = join(s.cfg.dir, 'files', (await s.call(token, 'GET', '/api/folders')).json().owner, pdf.json().item.id);
  assert.ok(existsSync(file));
  const del = await s.call(token, 'POST', '/api/folders/folder/delete', { id: ids[1] });
  assert.equal(del.json().folders.length, 2);
  assert.equal(del.json().usage.bytes, 0);
  assert.ok(!existsSync(file), 'its files go with the folder');
  // A third can be made again.
  assert.equal((await s.call(token, 'POST', '/api/folders/folder/create', { name: 'New' })).statusCode, 200);
});

test('items: each kind is stored as its own shape; a folder holds a limited number', async () => {
  const s = await setup({ cfg: config({ limits: { itemsPerFolder: 4 } }) });
  const { token } = await s.login();
  const folderId = (await s.call(token, 'POST', '/api/folders/folder/create', { name: 'BTC' })).json().folder.id;
  const make = (kind: string, data: unknown, title = kind) => s.call(token, 'POST', '/api/folders/item/create', { folderId, kind, title, data });

  const note = await make('note', NOTE, 'Thesis');
  assert.equal(note.statusCode, 200, note.body);
  assert.equal(note.json().item.meta.excerpt, 'Thesis — BTC breaks out');
  const table = (await make('table', TABLE)).json().item;
  assert.deepEqual([table.meta.rows, table.meta.cols], [2, 2]);
  const news = (await make('news', NEWS)).json().item;
  assert.equal(news.meta.href, NEWS.href);
  const chart = (await make('chart', CHART)).json().item;
  assert.deepEqual([chart.meta.symbol, chart.meta.interval, chart.meta.engine], ['BTC-USD', '1h', 'perps']);

  const full = await make('note', NOTE);
  assert.equal(full.statusCode, 409);
  assert.equal(full.json().code, 'folder-full');

  const got = (await s.call(token, 'GET', `/api/folders/item?id=${chart.id}`)).json().item;
  assert.deepEqual(got.data, CHART, 'a chart snapshot comes back as the chart wrote it');
  assert.equal((await make('file', {})).statusCode, 400, 'files are uploaded');
  assert.equal((await make('chart', { ...CHART, v: 2 })).statusCode, 400);
  assert.equal((await make('news', { ...NEWS, href: 'javascript:alert(1)' })).statusCode, 400);
});

test('items: a note keeps text and known marks only - no markup, no script links', () => {
  const n = checkNote({
    blocks: [
      { type: 'p', spans: [{ text: '<img src=x onerror=alert(1)>', marks: ['b', 'onclick'] }, { text: 'link', href: 'javascript:alert(1)' }, { text: 'ok', href: 'https://example.com/a' }] },
      { type: 'ul', items: [[{ text: 'one' }], [{ text: 'two\u0000' }]] },
      { type: 'hr' },
    ],
  });
  assert.deepEqual(n.blocks[0], { type: 'p', spans: [{ text: '<img src=x onerror=alert(1)>', marks: ['b'] }, { text: 'link' }, { text: 'ok', href: 'https://example.com/a' }] });
  assert.deepEqual(n.blocks[1], { type: 'ul', items: [[{ text: 'one' }], [{ text: 'two' }]] });
  assert.throws(() => checkNote({ blocks: [{ type: 'script', spans: [] }] }));
  assert.equal(safeHref('data:text/html,<b>'), null);
  assert.equal(safeHref('https://user:pw@example.com/'), null);
});

test('items: the wallet storage quota and the server room are enforced on the server', async () => {
  let free = 10 * 1024 * 1024;
  const s = await setup({ cfg: config({ limits: { walletBytes: 1024 * 1024 }, minFreeBytes: 1024 * 1024 }), free: () => free });
  const { token } = await s.login();
  const folderId = (await s.call(token, 'POST', '/api/folders/folder/create', { name: 'Big' })).json().folder.id;
  const up = (bytes: Buffer, name = 'a.pdf') =>
    s.app.inject({ method: 'POST', url: `/api/folders/upload?folderId=${folderId}&name=${name}`, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' }, payload: bytes });
  const half = Buffer.concat([Buffer.from('%PDF-1.7\n'), randomBytes(600 * 1024)]);
  assert.equal((await up(half)).statusCode, 200);
  const over = await up(half);
  assert.equal(over.statusCode, 413);
  assert.equal(over.json().code, 'quota');
  const small = Buffer.concat([Buffer.from('%PDF-1.7\n'), randomBytes(1000)]);
  free = 1024 * 1024; // the volume is down to its reserve
  const room = await up(small);
  assert.equal(room.statusCode, 507);
  assert.equal(room.json().code, 'storage-full');
});

test('uploads: sniffed from the bytes - PDF, images and plain text only; served back as an attachment to their owner only', async () => {
  const s = await setup();
  const a = await s.login();
  const b = await s.login();
  const folderId = (await s.call(a.token, 'POST', '/api/folders/folder/create', { name: 'Docs' })).json().folder.id;
  const up = (bytes: Buffer, name: string, token = a.token) =>
    s.app.inject({ method: 'POST', url: `/api/folders/upload?folderId=${folderId}&name=${encodeURIComponent(name)}`, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' }, payload: bytes });

  const pdf = await up(PDF, 'Q3 report.pdf');
  assert.equal(pdf.statusCode, 200, pdf.body);
  assert.equal(pdf.json().item.title, 'Q3 report');
  assert.equal(pdf.json().item.meta.fileType, 'pdf');
  // A name and a type claim nothing: an HTML page called .pdf, an SVG, a script are refused.
  for (const [bytes, name] of [
    [Buffer.from('<!DOCTYPE html><script>alert(1)</script>'), 'x.pdf'],
    [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'), 'x.png'],
    [Buffer.from('  <html><body>hi</body></html>'), 'x.txt'],
    [Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]), 'x.docx'],
  ] as const) {
    const r = await up(bytes, name);
    assert.equal(r.statusCode, 415, name);
    assert.equal(r.json().code, 'file-type');
  }
  const txt = await up(Buffer.from('levels: 64k, 58k\n'), 'levels.txt');
  assert.equal(txt.json().item.meta.fileType, 'text');
  assert.equal((await up(PNG, 'chart.png')).json().item.meta.fileType, 'png');

  const id = pdf.json().item.id;
  const got = await s.call(a.token, 'GET', `/api/folders/file?id=${id}`);
  assert.equal(got.statusCode, 200);
  assert.equal(got.headers['content-type'], 'application/pdf');
  assert.match(String(got.headers['content-disposition']), /^attachment; filename="Q3 report.pdf"; filename\*=UTF-8''Q3%20report.pdf$/);
  assert.match(String(got.headers['content-security-policy']), /sandbox/);
  assert.match(String(got.headers['cache-control']), /no-store/);
  assert.deepEqual(got.rawPayload, PDF);
  const t = await s.call(a.token, 'GET', `/api/folders/file?id=${txt.json().item.id}`);
  assert.equal(t.headers['content-type'], 'text/plain; charset=utf-8');

  // Another wallet: the same id is not there.
  assert.equal((await s.call(b.token, 'GET', `/api/folders/file?id=${id}`)).statusCode, 404);
  assert.equal((await s.call(b.token, 'GET', `/api/folders/item?id=${id}`)).statusCode, 404);
  assert.equal((await s.call(b.token, 'POST', '/api/folders/item/delete', { id })).statusCode, 404);
  assert.equal((await s.call(b.token, 'POST', '/api/folders/item/move', { id, folderId, index: 0 })).statusCode, 404);
  assert.equal((await up(PDF, 'b.pdf', b.token)).statusCode, 404, "into another wallet's folder");
  assert.equal((await s.call(b.token, 'GET', '/api/folders')).json().folders.length, 0);
});

test('items: renamed, edited with a revision check, moved and reordered, deleted', async () => {
  const s = await setup({ cfg: config({ limits: { itemsPerFolder: 3 } }) });
  const { token } = await s.login();
  const f1 = (await s.call(token, 'POST', '/api/folders/folder/create', { name: 'One' })).json().folder.id;
  const f2 = (await s.call(token, 'POST', '/api/folders/folder/create', { name: 'Two' })).json().folder.id;
  const mk = async (folderId: string, title: string) => (await s.call(token, 'POST', '/api/folders/item/create', { folderId, kind: 'note', title, data: NOTE })).json().item;
  const a = await mk(f1, 'a');
  const b = await mk(f1, 'b');
  const c = await mk(f1, 'c');
  for (const t of ['x', 'y', 'z']) await mk(f2, t);

  const renamed = await s.call(token, 'POST', '/api/folders/item/update', { id: a.id, title: 'Alpha', rev: a.rev });
  assert.equal(renamed.json().item.title, 'Alpha');
  const stale = await s.call(token, 'POST', '/api/folders/item/update', { id: a.id, data: NOTE, rev: a.rev });
  assert.equal(stale.statusCode, 409, 'another tab saved first');
  const edited = await s.call(token, 'POST', '/api/folders/item/update', { id: a.id, data: { blocks: [{ type: 'p', spans: [{ text: 'new' }] }] }, rev: renamed.json().item.rev });
  assert.equal(edited.json().item.meta.excerpt, 'new');

  const order = (r: { json(): { folders: Array<{ id: string; items: Array<{ title: string }> }> } }, f: string) => r.json().folders.find((x) => x.id === f)!.items.map((i) => i.title);
  assert.deepEqual(order(await s.call(token, 'POST', '/api/folders/item/move', { id: c.id, folderId: f1, index: 0 }), f1), ['c', 'Alpha', 'b']);
  const full = await s.call(token, 'POST', '/api/folders/item/move', { id: b.id, folderId: f2, index: 0 });
  assert.equal(full.json().code, 'folder-full');
  await s.call(token, 'POST', '/api/folders/item/delete', { id: (await s.call(token, 'GET', '/api/folders')).json().folders[1].items[0].id });
  const moved = await s.call(token, 'POST', '/api/folders/item/move', { id: b.id, folderId: f2, index: 1 });
  assert.deepEqual(order(moved, f1), ['c', 'Alpha']);
  assert.deepEqual(order(moved, f2), ['y', 'b', 'z']);
  assert.equal((await s.call(token, 'POST', '/api/folders/item/update', { id: (await mk(f1, 'n')).id, data: NEWS })).statusCode, 400, 'a note stays a note');
});

test('rates: changes per wallet per minute and uploads per hour', async () => {
  const s = await setup({ cfg: config({ limits: { writesPerMinute: 3, uploadsPerHour: 1 } }) });
  const { token } = await s.login();
  const folderId = (await s.call(token, 'POST', '/api/folders/folder/create', { name: 'A' })).json().folder.id;
  assert.equal((await s.call(token, 'POST', '/api/folders/folder/rename', { id: folderId, name: 'B' })).statusCode, 200);
  assert.equal((await s.call(token, 'POST', '/api/folders/folder/rename', { id: folderId, name: 'C' })).statusCode, 200);
  const r = await s.call(token, 'POST', '/api/folders/folder/rename', { id: folderId, name: 'D' });
  assert.equal(r.statusCode, 429);
  assert.ok(Number(r.headers['retry-after']) > 0);
  assert.equal((await s.call(token, 'GET', '/api/folders')).statusCode, 200, 'reading is not a change');

  const s2 = await setup({ cfg: config({ limits: { uploadsPerHour: 1 } }) });
  const t2 = (await s2.login()).token;
  const f2 = (await s2.call(t2, 'POST', '/api/folders/folder/create', { name: 'A' })).json().folder.id;
  const up = () => s2.app.inject({ method: 'POST', url: `/api/folders/upload?folderId=${f2}&name=a.pdf`, headers: { authorization: `Bearer ${t2}`, 'content-type': 'application/octet-stream' }, payload: PDF });
  assert.equal((await up()).statusCode, 200);
  assert.equal((await up()).statusCode, 429);
});

test('erase: everything goes - folders, items, files - and every token handed out before stops working', async () => {
  const s = await setup();
  const w = await s.login();
  const second = await s.login({ key: w.key, address: w.address });
  const folderId = (await s.call(w.token, 'POST', '/api/folders/folder/create', { name: 'A' })).json().folder.id;
  await s.app.inject({ method: 'POST', url: `/api/folders/upload?folderId=${folderId}&name=a.pdf`, headers: { authorization: `Bearer ${w.token}`, 'content-type': 'application/octet-stream' }, payload: PDF });
  await s.call(w.token, 'POST', '/api/folders/item/create', { folderId, kind: 'chart', title: 'BTC', data: CHART, thumb: `data:image/png;base64,${PNG.toString('base64')}` });
  assert.ok(readdirSync(join(s.cfg.dir, 'files', w.address)).length === 2);

  assert.equal((await s.call(w.token, 'POST', '/api/folders/erase', {})).statusCode, 400, 'needs the confirmation');
  const r = await s.call(w.token, 'POST', '/api/folders/erase', { confirm: 'erase-everything' });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json().erased, { items: 2, folders: 1 });
  assert.ok(!existsSync(join(s.cfg.dir, 'files', w.address)));
  assert.equal((await s.call(w.token, 'GET', '/api/folders')).statusCode, 401);
  assert.equal((await s.call(second.token, 'GET', '/api/folders')).statusCode, 401, 'on every device');
  const again = await s.login({ key: w.key, address: w.address });
  const fresh = (await s.call(again.token, 'GET', '/api/folders')).json();
  assert.equal(fresh.folders.length, 0);
  assert.equal(fresh.usage.bytes, 0);
  assert.equal(s.store.totalBytes, 0);
});

test('retention: a wallet not seen for the retention period is deleted; the nightly copy keeps seven days', async () => {
  let now = Date.now();
  const s = await setup({ cfg: config({ retentionMs: 30 * 86_400_000 }), now: () => now });
  const old = await s.login();
  const kept = await s.login();
  for (const w of [old, kept]) await s.call(w.token, 'POST', '/api/folders/folder/create', { name: 'A' });
  now += 20 * 86_400_000;
  // A token lasts a week; signing in again (or any request with a live token) counts as seen.
  const back = await s.login({ key: kept.key, address: kept.address });
  assert.equal((await s.call(back.token, 'GET', '/api/folders')).statusCode, 200);
  now += 15 * 86_400_000;
  assert.deepEqual(s.store.sweep(), { owners: 1 });
  assert.equal(s.store.list(old.address).folders.length, 0);
  assert.equal(s.store.list(kept.address).folders.length, 1);

  for (let d = 0; d < 9; d++) {
    now += 86_400_000;
    s.store.backup();
  }
  assert.equal(readdirSync(join(s.cfg.dir, 'backup')).filter((f) => f.endsWith('.db')).length, 7);
});

/* ----------------------------------------------------------- pieces ----- */

test('sniffing: what a file is comes from its first bytes', () => {
  assert.equal(sniffFile(PDF), 'pdf');
  assert.equal(sniffFile(PNG), 'png');
  assert.equal(sniffFile(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2])), 'jpeg');
  assert.equal(sniffFile(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')), 'webp');
  assert.equal(sniffFile(Buffer.from('GIF89a....')), 'gif');
  assert.equal(sniffFile(Buffer.from('a,b\n1,2\n')), 'text');
  assert.equal(sniffFile(Buffer.from([0x00, 0x01, 0x02, 0x03])), null);
  assert.equal(isPlainText(Buffer.from([0xc3, 0x28])), false, 'not UTF-8');
  assert.equal(isPlainText(Buffer.from('﻿<?xml version="1.0"?><svg/>')), false);
});

test('limits: the defaults are the proposal; the environment changes them within bounds', () => {
  const d = foldersConfigFromEnv({});
  assert.deepEqual(
    [d.limits.folders, d.limits.itemsPerFolder, d.limits.fileBytes, d.limits.walletBytes, d.limits.writesPerMinute, d.limits.uploadsPerHour, d.signInsPerDay],
    [3, 50, 4 * 1048576, 25 * 1048576, 60, 20, 10],
  );
  assert.equal(d.totalBytes, 20 * 1073741824);
  assert.equal(d.minFreeBytes, 5 * 1073741824);
  assert.equal(d.retentionMs, 365 * 86_400_000);
  const e = foldersConfigFromEnv({ FOLDERS_MAX_ITEMS: '100', FOLDERS_MAX_FILE_MB: '2.5', FOLDERS_DIR: '/x/folders' });
  assert.equal(e.limits.itemsPerFolder, 100);
  assert.equal(e.limits.fileBytes, Math.floor(2.5 * 1048576));
  assert.equal(e.dir, '/x/folders');
  assert.throws(() => foldersConfigFromEnv({ FOLDERS_MAX_FILE_MB: '10' }), /maximum/, 'more than the edge can carry');
  assert.throws(() => foldersConfigFromEnv({ FOLDERS_RETENTION_DAYS: '7' }), /30/);
  assert.throws(() => foldersConfigFromEnv({ FOLDERS_MAX_FOLDERS: 'many' }));
});

test('hosted: the folders routes are listed, POSTs as writes or the sign-in, counted per client', () => {
  const folders = HOSTED_ROUTES.filter((r) => r.url.startsWith('/api/folders'));
  assert.equal(folders.length, 14);
  for (const r of folders) {
    if (r.method === 'GET') assert.equal(r.cls, 'read', r.url);
    else assert.equal(r.cls, r.url === '/api/folders/session' ? 'auth' : 'write', r.url);
  }
  assert.deepEqual(limitsFor(hostedRoute('POST', '/api/folders/item/create')!, {}, HOSTED_LIMITS, 'c').map((l) => l.key), ['read|c', 'write|c']);
  assert.deepEqual(limitsFor(hostedRoute('POST', '/api/folders/session')!, {}, HOSTED_LIMITS, 'c').map((l) => l.key), ['auth|c', 'auth|*']);
});
