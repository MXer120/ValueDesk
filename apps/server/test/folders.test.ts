/**
 * Knowledge folders as a request sees them (routes/folders.ts, src/folders/):
 * the wallet sign-in and its token, the limits - counts, bytes, rates, the
 * server's own room - enforced by the server, an upload reserved, sent and
 * checked (to disk through the API in pieces, or straight to S3 with a signed link), how
 * a file is fetched back, that one wallet never reaches another's, moving and
 * reordering, erasing everything, and the S3 signing against AWS's own examples.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import Fastify from 'fastify';
import { secp256k1 } from '@noble/curves/secp256k1';

import { bytesToHex, privateKeyToAddress } from '../src/signing/eip712.js';
import { SessionTokens, checkSignIn, signInDigest } from '../src/folders/auth.js';
import { DiskBlobs, S3Blobs, type BlobStore } from '../src/folders/blobs.js';
import { DEFAULT_LIMITS, foldersConfigFromEnv, type FoldersConfig } from '../src/folders/limits.js';
import { credentialSource, EMPTY_SHA256, presignUrl, signHeaders, type AwsCredentials } from '../src/folders/s3.js';
import { FoldersStore, UPLOAD_TTL_MS } from '../src/folders/store.js';
import { checkNote, isPlainText, safeHref, sniffFile, trimUtf8Tail } from '../src/folders/validate.js';
import { SIGN_IN_STATEMENT, type SignIn } from '../src/folders/types.js';
import { foldersRoutes } from '../src/routes/folders.js';
import { HOSTED_ROUTES, hostedRoute, limitsFor, DEFAULT_LIMITS as HOSTED_LIMITS } from '../src/hosted.js';

const ROOT = mkdtempSync(join(tmpdir(), 'vs-folders-'));
const OPEN: FoldersStore[] = [];
const SERVERS: Server[] = [];
test.after(() => {
  for (const s of OPEN) s.close();
  for (const s of SERVERS) s.close();
  rmSync(ROOT, { recursive: true, force: true });
});

let caseNo = 0;
function config(over: Omit<Partial<FoldersConfig>, 'limits'> & { limits?: Partial<FoldersConfig['limits']> } = {}): FoldersConfig {
  return {
    dir: join(ROOT, `case-${caseNo++}`),
    s3: null,
    signInsPerDay: 10,
    totalBytes: 1 << 30,
    minFreeBytes: 0,
    downloadBytesPerDay: 1 << 30,
    downloadBytesPerDayTotal: 1 << 30,
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

async function setup(o: { cfg?: FoldersConfig; free?: () => number; now?: () => number; blobs?: (cfg: FoldersConfig) => BlobStore } = {}) {
  const cfg = o.cfg ?? config();
  const store = new FoldersStore(cfg, { freeBytes: o.free, now: o.now });
  OPEN.push(store);
  const tokens = new SessionTokens(cfg.dir);
  const blobs = o.blobs?.(cfg) ?? new DiskBlobs(cfg.dir);
  const app = Fastify();
  await app.register(foldersRoutes, { store, tokens, cfg, blobs, upkeep: false, now: o.now });
  await app.ready();
  const login = async (w = wallet()) => {
    const r = await app.inject({ method: 'POST', url: '/api/folders/session', payload: { signIn: signIn(w, {}, o.now?.()) } });
    assert.equal(r.statusCode, 200, r.body);
    return { ...w, token: r.json().token as string };
  };
  const call = (token: string | null, method: 'GET' | 'POST', url: string, payload?: unknown) =>
    app.inject({ method, url, headers: token ? { authorization: `Bearer ${token}` } : {}, ...(payload === undefined ? {} : { payload: payload as object }) });
  /** An upload as the web makes one: reserve, send the bytes where the server says, finish. */
  const upload = async (token: string, folderId: string, bytes: Buffer, name = 'a.pdf', o2: { size?: number } = {}) => {
    const start = await call(token, 'POST', '/api/folders/upload/start', { folderId, name, size: o2.size ?? bytes.length });
    if (start.statusCode !== 200) return start;
    const { id, target } = start.json() as { id: string; target: { method: 'PUT' | 'POST'; url: string; headers: Record<string, string>; bearer: boolean; partBytes?: number } };
    if (target.bearer) {
      // Through the API: in pieces, in order, as the web sends them.
      const step = target.partBytes ?? bytes.length;
      for (let n = 0; n * step < Math.max(1, bytes.length); n++) {
        const put = await app.inject({ method: target.method, url: `${target.url}&part=${n}`, headers: { ...target.headers, authorization: `Bearer ${token}` }, payload: bytes.subarray(n * step, (n + 1) * step) });
        if (put.statusCode !== 200) return put;
      }
    } else {
      const res = await fetch(target.url, { method: target.method, headers: target.headers, body: bytes });
      assert.ok(res.status < 300 || res.status === 403, `S3 stand-in answered ${res.status}`);
    }
    return call(token, 'POST', '/api/folders/upload/finish', { id });
  };
  /** A file fetched as the web fetches it: its link, then the bytes from where the link points. */
  const fetchFile = async (token: string, id: string, thumb = false) => {
    const u = await call(token, 'GET', `/api/folders/file/url?id=${id}${thumb ? '&thumb=1' : ''}`);
    if (u.statusCode !== 200) return { status: u.statusCode, body: u.json() as { code?: string } };
    const link = u.json() as { url: string; bearer: boolean; mime: string; partBytes?: number; size?: number };
    if (link.bearer) {
      // Through the API: piece by piece, put together here as the web does.
      const parts: Buffer[] = [];
      let headers: Record<string, string> = {};
      const count = link.partBytes ? Math.max(1, Math.ceil((link.size ?? 0) / link.partBytes)) : 1;
      for (let n = 0; n < count; n++) {
        const r = await call(token, 'GET', `${link.url}&part=${n}`);
        if (r.statusCode !== 200) return { status: r.statusCode, body: r.json() as { code?: string } };
        if (n === 0) headers = r.headers as Record<string, string>;
        parts.push(r.rawPayload);
      }
      return { status: 200, headers, bytes: Buffer.concat(parts), link };
    }
    const r = await fetch(link.url);
    return { status: r.status, headers: Object.fromEntries(r.headers.entries()), bytes: Buffer.from(await r.arrayBuffer()), link };
  };
  return { app, store, cfg, login, call, upload, fetchFile };
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
  assert.equal(bytesToHex(d), '0x73723a8d8d4868b167a3b8c3300e4091dd053259a9568e21ea75402dff16fd5f');
});

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
  const { token, address } = await s.login();
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

  const pdf = await s.upload(token, ids[1]!, PDF);
  assert.equal(pdf.statusCode, 200, pdf.body);
  const file = join(s.cfg.dir, 'files', address, pdf.json().item.id);
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
  const fullUpload = await s.upload(token, folderId, PDF);
  assert.equal(fullUpload.json().code, 'folder-full', 'a reservation counts like an item');

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

test('items: the wallet storage quota and the server room are enforced on the server, reservations included', async () => {
  let free = 10 * 1024 * 1024;
  const s = await setup({ cfg: config({ limits: { walletBytes: 1024 * 1024 }, minFreeBytes: 1024 * 1024 }), free: () => free });
  const { token } = await s.login();
  const folderId = (await s.call(token, 'POST', '/api/folders/folder/create', { name: 'Big' })).json().folder.id;
  const half = Buffer.concat([Buffer.from('%PDF-1.7\n'), randomBytes(600 * 1024)]);
  // Two reservations at once: the second does not fit beside the first, sent or not.
  const first = await s.call(token, 'POST', '/api/folders/upload/start', { folderId, name: 'a.pdf', size: half.length });
  assert.equal(first.statusCode, 200);
  const second = await s.call(token, 'POST', '/api/folders/upload/start', { folderId, name: 'b.pdf', size: half.length });
  assert.equal(second.statusCode, 413);
  assert.equal(second.json().code, 'quota');
  const small = Buffer.concat([Buffer.from('%PDF-1.7\n'), randomBytes(1000)]);
  free = 1024 * 1024; // the volume is down to its reserve
  const room = await s.upload(token, folderId, small);
  assert.equal(room.statusCode, 507);
  assert.equal(room.json().code, 'storage-full');
  assert.equal((await s.call(token, 'POST', '/api/folders/upload/start', { folderId, name: 'x', size: 64 * 1024 * 1024 })).json().code, 'too-large');
  assert.equal((await s.call(token, 'POST', '/api/folders/upload/start', { folderId, name: 'x', size: 0 })).statusCode, 400);
});

test('uploads: sniffed from the bytes - PDF, images and plain text only; fetched back as an attachment by their owner only', async () => {
  const s = await setup();
  const a = await s.login();
  const b = await s.login();
  const folderId = (await s.call(a.token, 'POST', '/api/folders/folder/create', { name: 'Docs' })).json().folder.id;

  const pdf = await s.upload(a.token, folderId, PDF, 'Q3 report.pdf');
  assert.equal(pdf.statusCode, 200, pdf.body);
  assert.equal(pdf.json().item.title, 'Q3 report');
  assert.equal(pdf.json().item.meta.fileType, 'pdf');
  // A name and a type claim nothing: an HTML page called .pdf, an SVG, a script are refused - and gone.
  for (const [bytes, name] of [
    [Buffer.from('<!DOCTYPE html><script>alert(1)</script>'), 'x.pdf'],
    [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'), 'x.png'],
    [Buffer.from('  <html><body>hi</body></html>'), 'x.txt'],
    [Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]), 'x.docx'],
  ] as const) {
    const r = await s.upload(a.token, folderId, bytes, name);
    assert.equal(r.statusCode, 415, name);
    assert.equal(r.json().code, 'file-type');
  }
  assert.deepEqual(readdirSync(join(s.cfg.dir, 'files', a.address)), [pdf.json().item.id], 'a refused upload leaves nothing');
  assert.equal((await s.call(a.token, 'GET', '/api/folders')).json().folders[0].items.length, 1, 'nor a listed item');
  const txt = await s.upload(a.token, folderId, Buffer.from('levels: 64k, 58k\n'), 'levels.txt');
  assert.equal(txt.json().item.meta.fileType, 'text');
  assert.equal((await s.upload(a.token, folderId, PNG, 'chart.png')).json().item.meta.fileType, 'png');
  const liar = await s.upload(a.token, folderId, PDF, 'x.pdf', { size: PDF.length + 10 });
  assert.equal(liar.statusCode, 400, 'the bytes sent are the size reserved');

  const id = pdf.json().item.id;
  const got = await s.fetchFile(a.token, id);
  assert.equal(got.status, 200);
  assert.equal(got.link!.mime, 'application/pdf', 'the type the bytes are, for the browser to put the pieces together as');
  assert.equal(got.headers!['content-type'], 'application/octet-stream', 'a piece is never served as something a browser renders');
  assert.match(String(got.headers!['content-disposition']), /^attachment; filename="Q3 report.pdf"; filename\*=UTF-8''Q3%20report.pdf$/);
  assert.match(String(got.headers!['content-security-policy']), /sandbox/);
  assert.match(String(got.headers!['cache-control']), /no-store/);
  assert.deepEqual(got.bytes, PDF);
  assert.equal((await s.fetchFile(a.token, txt.json().item.id)).link!.mime, 'text/plain; charset=utf-8');

  // Another wallet: the same id is not there.
  assert.equal((await s.call(b.token, 'GET', `/api/folders/file/url?id=${id}`)).statusCode, 404);
  assert.equal((await s.call(b.token, 'GET', `/api/folders/file?id=${id}`)).statusCode, 404);
  assert.equal((await s.call(b.token, 'GET', `/api/folders/item?id=${id}`)).statusCode, 404);
  assert.equal((await s.call(b.token, 'POST', '/api/folders/item/delete', { id })).statusCode, 404);
  assert.equal((await s.call(b.token, 'POST', '/api/folders/item/move', { id, folderId, index: 0 })).statusCode, 404);
  assert.equal((await s.upload(b.token, folderId, PDF, 'b.pdf')).statusCode, 404, "into another wallet's folder");
  // Nor someone else's reservation.
  const res = (await s.call(a.token, 'POST', '/api/folders/upload/start', { folderId, name: 'p.pdf', size: PDF.length })).json().id;
  const put = await s.app.inject({ method: 'POST', url: `/api/folders/upload/put?id=${res}`, headers: { authorization: `Bearer ${b.token}`, 'content-type': 'application/octet-stream' }, payload: PDF });
  assert.equal(put.statusCode, 404);
  assert.equal((await s.call(b.token, 'POST', '/api/folders/upload/finish', { id: res })).statusCode, 404);
  assert.equal((await s.call(b.token, 'GET', '/api/folders')).json().folders.length, 0);
});

test('pieces: a file larger than the edge carries goes up and comes back in 4 MB pieces, in order, each checked', async () => {
  const s = await setup();
  const { token, address } = await s.login();
  const folderId = (await s.call(token, 'POST', '/api/folders/folder/create', { name: 'Big' })).json().folder.id;
  const big = Buffer.concat([Buffer.from('%PDF-1.7\n'), randomBytes(9 * 1024 * 1024)]);
  const done = await s.upload(token, folderId, big, 'big.pdf');
  assert.equal(done.statusCode, 200, done.body);
  assert.equal(done.json().item.bytes, big.length);
  const back = await s.fetchFile(token, done.json().item.id);
  assert.equal(back.status, 200);
  assert.equal(back.link!.partBytes, 4 * 1024 * 1024);
  assert.ok(back.bytes!.equals(big), 'the pieces put together are the file, byte for byte');

  const put = (id: string, part: number | string, bytes: Buffer) =>
    s.app.inject({ method: 'POST', url: `/api/folders/upload/put?id=${id}&part=${part}`, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' }, payload: bytes });
  const P = 4 * 1024 * 1024;
  const r = (await s.call(token, 'POST', '/api/folders/upload/start', { folderId, name: 'r.pdf', size: big.length })).json();
  assert.equal(r.target.partBytes, P);
  assert.equal((await put(r.id, 1, big.subarray(P, 2 * P))).statusCode, 409, 'not before the piece ahead of it');
  assert.equal((await put(r.id, 0, big.subarray(0, P - 1))).statusCode, 400, 'a piece is exactly as long as its place says');
  assert.equal((await put(r.id, 3, big.subarray(0, 10))).statusCode, 400, 'there is no fourth piece');
  assert.equal((await put(r.id, 'x', big.subarray(0, P))).statusCode, 400);
  assert.equal((await put(r.id, 0, big.subarray(0, P))).statusCode, 200);
  assert.equal((await put(r.id, 0, big.subarray(0, P))).statusCode, 200, 'a piece sent again (a lost answer) changes nothing');
  assert.equal((await s.call(token, 'POST', '/api/folders/upload/finish', { id: r.id })).statusCode, 400, 'two pieces missing: not the size reserved');
  assert.ok(!existsSync(join(s.cfg.dir, 'files', address, r.id)), 'and its bytes are gone');
  assert.equal((await s.call(token, 'GET', `/api/folders/file?id=${done.json().item.id}&part=3`)).statusCode, 400, 'no piece past the end');
});

test('downloads: what one wallet, and everyone, may fetch per day is counted when a link is issued', async () => {
  const s = await setup({ cfg: config({ downloadBytesPerDay: PDF.length * 2 + 10 }) });
  const { token } = await s.login();
  const folderId = (await s.call(token, 'POST', '/api/folders/folder/create', { name: 'D' })).json().folder.id;
  const id = (await s.upload(token, folderId, PDF)).json().item.id;
  assert.equal((await s.fetchFile(token, id)).status, 200);
  assert.equal((await s.fetchFile(token, id)).status, 200);
  const third = await s.fetchFile(token, id);
  assert.equal(third.status, 429);
});

test('uploads: a reservation never finished is swept with its bytes within the hour', async () => {
  let now = Date.now();
  const s = await setup({ now: () => now });
  const { token, address } = await s.login();
  const folderId = (await s.call(token, 'POST', '/api/folders/folder/create', { name: 'U' })).json().folder.id;
  const start = (await s.call(token, 'POST', '/api/folders/upload/start', { folderId, name: 'late.pdf', size: PDF.length })).json();
  await s.app.inject({ method: 'POST', url: start.target.url, headers: { ...start.target.headers, authorization: `Bearer ${token}` }, payload: PDF });
  assert.equal((await s.call(token, 'GET', '/api/folders')).json().folders[0].items.length, 0, 'not listed before it is finished');
  assert.ok(existsSync(join(s.cfg.dir, 'files', address, start.id)));
  now += UPLOAD_TTL_MS + 1;
  const swept = s.store.sweep();
  assert.equal(swept.uploads, 1);
  assert.deepEqual(swept.gone, [{ owner: address, names: [start.id] }]);
  assert.equal((await s.call(token, 'POST', '/api/folders/upload/finish', { id: start.id })).statusCode, 404, 'too late');
  assert.equal(s.store.totalBytes, 0, 'the reservation no longer counts');
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
  assert.equal((await s2.upload(t2, f2, PDF)).statusCode, 200);
  assert.equal((await s2.upload(t2, f2, PDF)).statusCode, 429);
});

test('erase: everything goes - folders, items, files, reservations - and every token handed out before stops working', async () => {
  const s = await setup();
  const w = await s.login();
  const second = await s.login({ key: w.key, address: w.address });
  const folderId = (await s.call(w.token, 'POST', '/api/folders/folder/create', { name: 'A' })).json().folder.id;
  await s.upload(w.token, folderId, PDF);
  await s.call(w.token, 'POST', '/api/folders/item/create', { folderId, kind: 'chart', title: 'BTC', data: CHART, thumb: `data:image/png;base64,${PNG.toString('base64')}` });
  await s.call(w.token, 'POST', '/api/folders/upload/start', { folderId, name: 'half.pdf', size: 10 });
  assert.equal(readdirSync(join(s.cfg.dir, 'files', w.address)).length, 2);

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
  assert.equal(s.store.sweep().owners, 1);
  assert.equal(s.store.list(old.address).folders.length, 0);
  assert.equal(s.store.list(kept.address).folders.length, 1);

  for (let d = 0; d < 9; d++) {
    now += 86_400_000;
    s.store.backup();
  }
  assert.equal(readdirSync(join(s.cfg.dir, 'backup')).filter((f) => f.endsWith('.db')).length, 7);
});

/* ------------------------------------------------------------------- S3 ----- */

const DOC_CREDS: AwsCredentials = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' };

test('S3 signing: the worked examples of the S3 documentation, byte for byte', () => {
  // "Authenticating Requests: Using Query Parameters (AWS Signature Version 4)": a presigned GET.
  const now = Date.parse('2013-05-24T00:00:00Z');
  const loc = { bucket: 'examplebucket', region: 'us-east-1' };
  const url = new URL(presignUrl({ method: 'GET', loc, key: 'test.txt', creds: DOC_CREDS, expiresIn: 86400, now, host: 'examplebucket.s3.amazonaws.com' }));
  assert.equal(url.searchParams.get('X-Amz-Signature'), 'aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404');
  assert.equal(url.searchParams.get('X-Amz-Credential'), 'AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request');
  // "...: Using the Authorization Header": GET Object with a Range.
  const h = signHeaders({ method: 'GET', loc, key: 'test.txt', creds: DOC_CREDS, payloadHash: EMPTY_SHA256, headers: { range: 'bytes=0-9' }, now, host: 'examplebucket.s3.amazonaws.com' });
  assert.equal(
    h.authorization,
    'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request,SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
  );
  // Temporary keys (the instance role's) travel as the security token, signed with the rest.
  const withToken = new URL(presignUrl({ method: 'PUT', loc, key: 'files/0xab/id', creds: { ...DOC_CREDS, sessionToken: 'tok/en+=' }, expiresIn: 60, now, headers: { 'content-length': '5' } }));
  assert.equal(withToken.searchParams.get('X-Amz-Security-Token'), 'tok/en+=');
  assert.equal(withToken.searchParams.get('X-Amz-SignedHeaders'), 'content-length;host');
  assert.equal(withToken.host, 'examplebucket.s3.us-east-1.amazonaws.com');
});

test('S3 credentials: the instance role through IMDSv2, cached until fifteen minutes before they lapse (longer than any link); the environment first', async () => {
  let now = 0;
  let calls = 0;
  const src = credentialSource({ env: {}, now: () => now, fetchImds: async () => ({ accessKeyId: `K${++calls}`, secretAccessKey: 's', sessionToken: 't', expiresAt: now + 60 * 60_000 }) });
  assert.equal((await src()).accessKeyId, 'K1');
  now += 40 * 60_000;
  assert.equal((await src()).accessKeyId, 'K1', 'still more than fifteen minutes left');
  now += 6 * 60_000;
  assert.equal((await src()).accessKeyId, 'K2', 'refreshed before a ten-minute upload link could outlive them');
  const env = credentialSource({ env: { AWS_ACCESS_KEY_ID: 'E', AWS_SECRET_ACCESS_KEY: 'S' }, fetchImds: async () => assert.fail('IMDS is not asked') });
  assert.equal((await env()).accessKeyId, 'E');
});

/**
 * An S3 stand-in, path style (/<bucket>/<key>): it keeps objects, answers HEAD, ranged GETs and
 * DELETE, and - like S3 - refuses a presigned request whose signature does not cover what was
 * sent (the length of an upload above all) or that has expired, and a server request without
 * an Authorization header.
 */
async function fakeS3(creds: AwsCredentials) {
  const objects = new Map<string, Buffer>();
  const seen: Array<{ method: string; key: string; presigned: boolean }> = [];
  const server = createServer(async (req: IncomingMessage, res) => {
    const url = new URL(req.url ?? '/', 'http://s3.test');
    const [, bucket, ...rest] = url.pathname.split('/');
    const key = rest.map(decodeURIComponent).join('/');
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    const presigned = url.searchParams.has('X-Amz-Signature');
    seen.push({ method: req.method ?? '', key, presigned });
    if (presigned) {
      const q = Object.fromEntries(url.searchParams.entries());
      const signedNames = q['X-Amz-SignedHeaders']!.split(';').filter((n) => n !== 'host');
      const headers = Object.fromEntries(signedNames.map((n) => [n, String(req.headers[n] ?? '')]));
      const query = Object.fromEntries(Object.entries(q).filter(([k]) => !k.startsWith('X-Amz-')));
      const at = q['X-Amz-Date']!;
      const now = Date.parse(`${at.slice(0, 4)}-${at.slice(4, 6)}-${at.slice(6, 8)}T${at.slice(9, 11)}:${at.slice(11, 13)}:${at.slice(13, 15)}Z`);
      const again = new URL(presignUrl({ method: req.method as 'GET' | 'PUT', loc: { bucket: bucket!, region: 'ap-northeast-1', endpoint: `http://${req.headers.host}` }, key, creds, expiresIn: Number(q['X-Amz-Expires']), now, headers, query }));
      if (again.searchParams.get('X-Amz-Signature') !== q['X-Amz-Signature'] || Date.now() > now + Number(q['X-Amz-Expires']) * 1000) {
        res.writeHead(403).end('<Error><Code>SignatureDoesNotMatch</Code></Error>');
        return;
      }
    } else if (!String(req.headers.authorization ?? '').startsWith('AWS4-HMAC-SHA256 ')) {
      res.writeHead(403).end('<Error><Code>AccessDenied</Code></Error>');
      return;
    }
    const k = `${bucket}/${key}`;
    if (req.method === 'PUT') {
      objects.set(k, body);
      res.writeHead(200).end();
    } else if (req.method === 'DELETE') {
      objects.delete(k);
      res.writeHead(204).end();
    } else {
      const o = objects.get(k);
      if (!o) return res.writeHead(404).end('<Error><Code>NoSuchKey</Code></Error>');
      if (req.method === 'HEAD') return res.writeHead(200, { 'content-length': String(o.length) }).end();
      const range = /^bytes=(\d+)-(\d+)$/.exec(String(req.headers.range ?? ''));
      const part = range ? o.subarray(Number(range[1]), Number(range[2]) + 1) : o;
      res.writeHead(range ? 206 : 200, {
        'content-type': url.searchParams.get('response-content-type') ?? 'application/octet-stream',
        ...(url.searchParams.get('response-content-disposition') ? { 'content-disposition': url.searchParams.get('response-content-disposition')! } : {}),
        'content-length': String(part.length),
      });
      res.end(part);
    }
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  SERVERS.push(server);
  return { endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, objects, seen };
}

test('S3 mode: the browser PUTs the bytes to S3 with a link for exactly that key and size; the server checks them and lists the file', async () => {
  const creds: AwsCredentials = { accessKeyId: 'AKIATEST', secretAccessKey: 'secret', sessionToken: 'session' };
  const s3 = await fakeS3(creds);
  const loc = { bucket: 'valuedesk-folders-tokyo', region: 'ap-northeast-1', endpoint: s3.endpoint };
  const s = await setup({ cfg: config({ s3: loc }), blobs: () => new S3Blobs(loc, async () => creds) });
  const { token, address } = await s.login();
  const folderId = (await s.call(token, 'POST', '/api/folders/folder/create', { name: 'S3' })).json().folder.id;

  const start = (await s.call(token, 'POST', '/api/folders/upload/start', { folderId, name: 'big.pdf', size: PDF.length })).json();
  assert.equal(start.target.bearer, false, "the wallet's token never goes to S3");
  assert.match(start.target.url, new RegExp(`/valuedesk-folders-tokyo/files/${address}/${start.id}\\?`));
  // A body of another size than the one signed is refused by S3 itself.
  const bigger = await fetch(start.target.url, { method: 'PUT', headers: start.target.headers, body: Buffer.concat([PDF, Buffer.from('x')]) });
  assert.equal(bigger.status, 403);
  assert.equal((await fetch(start.target.url, { method: 'PUT', headers: start.target.headers, body: PDF })).status, 200);
  const done = await s.call(token, 'POST', '/api/folders/upload/finish', { id: start.id });
  assert.equal(done.statusCode, 200, done.body);
  assert.equal(done.json().item.meta.fileType, 'pdf');
  assert.ok(s3.seen.some((r) => r.method === 'HEAD' && !r.presigned) && s3.seen.some((r) => r.method === 'GET' && !r.presigned), 'size and first bytes read by the server');

  const got = await s.fetchFile(token, start.id);
  assert.equal(got.status, 200);
  assert.equal(got.link!.bearer, false);
  assert.equal(got.headers!['content-type'], 'application/pdf', 'S3 answers with the sniffed type the link names');
  assert.match(String(got.headers!['content-disposition']), /^attachment; filename="big.pdf"/);
  assert.deepEqual(got.bytes, PDF);
  assert.equal(new URL(got.link!.url).searchParams.get('X-Amz-Expires'), '60', 'a download link lasts a minute');
  assert.equal((await s.call(token, 'GET', `/api/folders/file?id=${start.id}`)).statusCode, 404, 'no bytes through the API in S3 mode');

  // An HTML page sent as a PDF: refused, and the object deleted.
  const html = Buffer.from('<!doctype html><script>alert(1)</script>');
  const evil = (await s.call(token, 'POST', '/api/folders/upload/start', { folderId, name: 'evil.pdf', size: html.length })).json();
  await fetch(evil.target.url, { method: 'PUT', headers: evil.target.headers, body: html });
  assert.equal((await s.call(token, 'POST', '/api/folders/upload/finish', { id: evil.id })).statusCode, 415);
  assert.ok(!s3.objects.has(`valuedesk-folders-tokyo/files/${address}/${evil.id}`));
  // Nothing sent at all.
  const none = (await s.call(token, 'POST', '/api/folders/upload/start', { folderId, name: 'n.pdf', size: 10 })).json();
  assert.equal((await s.call(token, 'POST', '/api/folders/upload/finish', { id: none.id })).statusCode, 400);

  // A chart's thumbnail goes to S3 from the server, and comes back through a link.
  const chart = (await s.call(token, 'POST', '/api/folders/item/create', { folderId, kind: 'chart', title: 'BTC', data: CHART, thumb: `data:image/png;base64,${PNG.toString('base64')}` })).json().item;
  assert.ok(s3.objects.has(`valuedesk-folders-tokyo/files/${address}/${chart.id}.thumb`));
  const thumb = await s.fetchFile(token, chart.id, true);
  assert.equal(thumb.headers!['content-type'], 'image/png');
  assert.deepEqual(thumb.bytes, PNG);

  // Deleting an item deletes its object; erasing deletes them all.
  await s.call(token, 'POST', '/api/folders/item/delete', { id: start.id });
  assert.ok(!s3.objects.has(`valuedesk-folders-tokyo/files/${address}/${start.id}`));
  await s.call(token, 'POST', '/api/folders/erase', { confirm: 'erase-everything' });
  assert.equal([...s3.objects.keys()].filter((k) => k.includes(address)).length, 0);
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
  // The first 64 KB of a long text can end inside a character: judged without it.
  const cut = Buffer.from('Notes on €uro rates', 'utf8').subarray(0, 10);
  assert.equal(sniffFile(cut), null, 'a whole file that ends mid-character is not text');
  assert.equal(sniffFile(cut, false), 'text', 'the head of a longer one is');
  assert.equal(trimUtf8Tail(Buffer.from('ab€', 'utf8')).length, 5, 'a complete character stays');
});

test('limits: the defaults are the owner\'s (25 MB a file, 100 MB a wallet); the environment changes them within bounds', () => {
  const d = foldersConfigFromEnv({});
  assert.equal(d.s3, null);
  assert.deepEqual(
    [d.limits.folders, d.limits.itemsPerFolder, d.limits.fileBytes, d.limits.walletBytes, d.limits.writesPerMinute, d.limits.uploadsPerHour, d.signInsPerDay],
    [3, 50, 25 * 1048576, 100 * 1048576, 60, 20, 10],
  );
  assert.equal(d.totalBytes, 20 * 1073741824);
  assert.equal(d.minFreeBytes, 10 * 1073741824, 'the index lives on the same volume');
  assert.equal(d.retentionMs, 365 * 86_400_000);
  const s3 = foldersConfigFromEnv({ FOLDERS_S3_BUCKET: 'valuedesk-folders-tokyo' });
  assert.deepEqual(s3.s3, { bucket: 'valuedesk-folders-tokyo', region: 'ap-northeast-1' });
  assert.deepEqual([s3.limits.fileBytes, s3.limits.walletBytes, s3.totalBytes, s3.minFreeBytes], [25 * 1048576, 100 * 1048576, 200 * 1073741824, 0]);
  assert.equal(s3.downloadBytesPerDay, 1024 * 1048576);
  assert.equal(foldersConfigFromEnv({ FOLDERS_S3_BUCKET: 'b-1', FOLDERS_MAX_FILE_MB: '80' }).limits.fileBytes, 80 * 1048576);
  assert.throws(() => foldersConfigFromEnv({ FOLDERS_S3_BUCKET: 'b-1', FOLDERS_MAX_FILE_MB: '200' }), /maximum/);
  assert.equal(foldersConfigFromEnv({ FOLDERS_MAX_FILE_MB: '60' }).limits.fileBytes, 60 * 1048576, 'pieces carry more than the edge does in one request');
  assert.throws(() => foldersConfigFromEnv({ FOLDERS_S3_BUCKET: 'Not_A_Bucket' }));
  assert.throws(() => foldersConfigFromEnv({ FOLDERS_S3_BUCKET: 'b-1', FOLDERS_S3_REGION: 'tokyo' }));
  const e = foldersConfigFromEnv({ FOLDERS_MAX_ITEMS: '100', FOLDERS_MAX_FILE_MB: '2.5', FOLDERS_DIR: '/x/folders' });
  assert.equal(e.limits.itemsPerFolder, 100);
  assert.equal(e.limits.fileBytes, Math.floor(2.5 * 1048576));
  assert.equal(e.dir, '/x/folders');
  assert.throws(() => foldersConfigFromEnv({ FOLDERS_RETENTION_DAYS: '7' }), /30/);
  assert.throws(() => foldersConfigFromEnv({ FOLDERS_MAX_FOLDERS: 'many' }));
});

test('hosted: the folders routes are listed, POSTs as writes or the sign-in, counted per client', () => {
  const folders = HOSTED_ROUTES.filter((r) => r.url.startsWith('/api/folders'));
  assert.equal(folders.length, 17);
  for (const r of folders) {
    if (r.method === 'GET') assert.equal(r.cls, 'read', r.url);
    else assert.equal(r.cls, r.url === '/api/folders/session' ? 'auth' : 'write', r.url);
  }
  assert.deepEqual(limitsFor(hostedRoute('POST', '/api/folders/item/create')!, {}, HOSTED_LIMITS, 'c').map((l) => l.key), ['read|c', 'write|c']);
  assert.deepEqual(limitsFor(hostedRoute('POST', '/api/folders/session')!, {}, HOSTED_LIMITS, 'c').map((l) => l.key), ['auth|c', 'auth|*']);
});
