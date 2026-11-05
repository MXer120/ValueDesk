/**
 * Usernames (profiles/, routes/profiles.ts): the first name needs no signature and only a wallet
 * without one can take it; every change is signed by the wallet; one wallet per name in any spelling.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import Fastify from 'fastify';
import { secp256k1 } from '@noble/curves/secp256k1';

import { checkUsernameChange, usernameChangeDigest } from '../src/profiles/check.js';
import { USERNAME_STATEMENT, usernameKey, usernameProblem, usernameTypedData, type UsernameChange } from '../src/profiles/claim.js';
import { ProfileStore } from '../src/profiles/store.js';
import { USERNAME_LIMITS, profileRoutes } from '../src/routes/profiles.js';
import { bytesToHex, privateKeyToAddress } from '../src/signing/eip712.js';
import { KeyedLimiter } from '../src/rateLimit.js';
import { tempDir } from './builderFakes.js';

const NOW = 1_800_000_000_000;

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

function change(w: W, username: string, o: Partial<UsernameChange> = {}, signer: W = w): UsernameChange {
  const base = { owner: w.address, username, statement: USERNAME_STATEMENT, nonce: randomBytes(16).toString('hex'), issuedAt: String(NOW), expiresAt: String(NOW + 5 * 60_000), chainId: 1, ...o };
  return { ...base, signature: rsv(usernameChangeDigest(base), signer.key) };
}

async function api(known?: (a: string) => boolean) {
  const store = new ProfileStore(':memory:');
  const app = Fastify();
  let t = NOW;
  await app.register(profileRoutes, { store, now: () => t, limiter: new KeyedLimiter(1000), ...(known ? { known } : {}) });
  await app.ready();
  const first = (address: string, username: string) => app.inject({ method: 'POST', url: '/api/vs/username', payload: { address, username } });
  const signed = (c: unknown) => app.inject({ method: 'POST', url: '/api/vs/username/change', payload: { change: c } });
  const profile = (a: string) => app.inject({ method: 'GET', url: `/api/vs/profile?address=${a}` });
  const check = (n: string, asker?: string) => app.inject({ method: 'GET', url: `/api/vs/username/check?name=${encodeURIComponent(n)}${asker ? `&for=${asker}` : ''}` });
  return { app, store, first, signed, profile, check, tick: (ms: number) => { t += ms; } };
}

test('name rules: length, characters, addresses and reserved names', () => {
  assert.equal(usernameProblem(''), 'empty');
  assert.equal(usernameProblem('ab'), 'short');
  assert.equal(usernameProblem('a'.repeat(21)), 'long');
  assert.equal(usernameProblem('has space'), 'chars');
  assert.equal(usernameProblem('dash-name'), 'chars');
  assert.equal(usernameProblem('ünï'), 'chars');
  assert.equal(usernameProblem('0xabc123'), 'address');
  assert.equal(usernameProblem('ValueDesk_HQ'), 'reserved');
  assert.equal(usernameProblem('v_a_l_u_e_d_e_s_k'), 'reserved');
  assert.equal(usernameProblem('sodex_support'), 'reserved');
  assert.equal(usernameProblem('Admin'), 'reserved');
  assert.equal(usernameProblem('team'), 'reserved');
  assert.equal(usernameProblem('Luke_1'), null);
  assert.equal(usernameProblem('0xford'), null, 'not hex after 0x: an ordinary name');
  assert.equal(usernameProblem('a'.repeat(20)), null);
  assert.equal(usernameKey('Luke_1'), 'luke_1');
});

test('typed data: the page signs exactly the fields the server hashes', () => {
  const w = newWallet();
  const c = change(w, 'Luke_1');
  const td = usernameTypedData(c);
  assert.equal(td.primaryType, 'UsernameChange');
  assert.deepEqual(td.message, { owner: w.address, username: 'Luke_1', statement: USERNAME_STATEMENT, nonce: c.nonce, issuedAt: c.issuedAt, expiresAt: c.expiresAt });
  const type = `UsernameChange(${td.types.UsernameChange.map((f) => `${f.type} ${f.name}`).join(',')})`;
  assert.equal(type, 'UsernameChange(address owner,string username,string statement,string nonce,uint64 issuedAt,uint64 expiresAt)');
});

test('change check: wording, window, name, and only the wallet itself can sign', () => {
  const w = newWallet();
  const other = newWallet();
  assert.ok(checkUsernameChange(change(w, 'Luke_1'), NOW).ok);
  const cases: Array<[unknown, RegExp]> = [
    [null, /missing/],
    [change(w, 'Luke_1', { statement: 'something else' }), /not the username change/],
    [change(w, 'Luke_1', {}, other), /not from this wallet/],
    [change(w, 'sodex_hq'), /reserved/],
    [change(w, 'Luke_1', { expiresAt: String(NOW - 1), issuedAt: String(NOW - 60_000) }), /expired/],
    [change(w, 'Luke_1', { expiresAt: String(NOW + 3_600_000) }), /longer than allowed/],
    [change(w, 'Luke_1', { issuedAt: String(NOW + 3_600_000), expiresAt: String(NOW + 3_660_000) }), /too far ahead/],
    [{ ...change(w, 'Luke_1'), username: 'Luke_2' }, /not from this wallet/],
  ];
  for (const [c, re] of cases) {
    const r = checkUsernameChange(c, NOW);
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, re);
  }
});

test('first name: no signature, and a repeat is the same answer', async () => {
  const a = await api();
  const w = newWallet();
  assert.equal((await a.profile(w.address)).json().username, null);
  assert.deepEqual((await a.check('Luke_1')).json(), { ok: true, available: true, reason: null });
  const r = await a.first(w.address, 'Luke_1');
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json(), { ok: true, username: 'Luke_1', updatedAt: NOW });
  assert.equal((await a.profile(w.address.toUpperCase().replace('0X', '0x'))).json().username, 'Luke_1');
  assert.equal((await a.first(w.address, 'luke_1')).statusCode, 200, 'a retry after a lost answer');
  assert.equal((await a.check('luke_1')).json().available, false);
  assert.equal((await a.check('luke_1', w.address)).json().available, true, 'its own name, for the wallet that has it');
  await a.app.close();
});

test('first name: bad input is refused and a name has one wallet in any spelling', async () => {
  const a = await api();
  const w = newWallet();
  const other = newWallet();
  assert.equal((await a.first('nope', 'Luke_1')).statusCode, 400);
  assert.equal((await a.first(w.address, 'sodex_hq')).statusCode, 400);
  await a.first(w.address, 'Luke_1');
  const stolen = await a.first(other.address, 'LUKE_1');
  assert.equal(stolen.statusCode, 409);
  assert.equal(stolen.json().code, 'taken');
  assert.equal((await a.profile(other.address)).json().username, null);
  await a.app.close();
});

test('without a signature a name cannot be replaced', async () => {
  const a = await api();
  const w = newWallet();
  await a.first(w.address, 'Luke_1');
  const r = await a.first(w.address, 'Another_1');
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().code, 'has-name');
  assert.equal(r.json().username, 'Luke_1');
  assert.equal((await a.profile(w.address)).json().username, 'Luke_1');
  await a.app.close();
});

test('a signed change replaces the name and frees the old one', async () => {
  const a = await api();
  const w = newWallet();
  await a.first(w.address, 'Luke_1');
  a.tick(1000);
  const r = await a.signed(change(w, 'Luke_2', { issuedAt: String(NOW + 500), expiresAt: String(NOW + 60_000) }));
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().username, 'Luke_2');
  assert.equal((await a.profile(w.address)).json().username, 'Luke_2');
  assert.equal((await a.check('luke_1')).json().available, true);
  await a.app.close();
});

test('a change only by the wallet itself, never to another wallet\'s name, never from an old signature', async () => {
  const a = await api();
  const w = newWallet();
  const other = newWallet();
  await a.first(w.address, 'Luke_1');
  await a.first(other.address, 'Other_1');
  assert.equal((await a.signed(change(w, 'Luke_2', { issuedAt: String(NOW + 1), expiresAt: String(NOW + 60_000) }, other))).statusCode, 400);
  const taken = await a.signed(change(w, 'OTHER_1', { issuedAt: String(NOW + 1), expiresAt: String(NOW + 60_000) }));
  assert.equal(taken.statusCode, 409);
  assert.equal(taken.json().code, 'taken');
  assert.equal((await a.profile(w.address)).json().username, 'Luke_1');

  // Luke_1 -> Luke_2 -> Luke_3, then the signature for Luke_2 again.
  const toTwo = change(w, 'Luke_2', { issuedAt: String(NOW + 1), expiresAt: String(NOW + 60_000) });
  a.tick(2000);
  assert.equal((await a.signed(toTwo)).statusCode, 200);
  a.tick(2000);
  assert.equal((await a.signed(change(w, 'Luke_3', { issuedAt: String(NOW + 3000), expiresAt: String(NOW + 60_000) }))).statusCode, 200);
  const replay = await a.signed(toTwo);
  assert.equal(replay.statusCode, 409);
  assert.equal(replay.json().code, 'stale');
  assert.equal((await a.profile(w.address)).json().username, 'Luke_3');
  await a.app.close();
});

test('a wallet named by someone else takes it back with its signature', async () => {
  const a = await api();
  const victim = newWallet();
  await a.first(victim.address, 'Squatted');
  a.tick(1000);
  assert.equal((await a.signed(change(victim, 'Mine_1', { issuedAt: String(NOW + 500), expiresAt: String(NOW + 60_000) }))).statusCode, 200);
  assert.equal((await a.profile(victim.address)).json().username, 'Mine_1');
  await a.app.close();
});

test('known says a wallet has traded through ValueDesk, and a failing ledger never breaks the answer', async () => {
  const traded = newWallet();
  let broken = false;
  const a = await api((x: string) => { if (broken) throw new Error('no ledger'); return x === traded.address; });
  const known = async (x: string) => (await a.profile(x)).json().known;
  assert.equal(await known(traded.address), true);
  assert.equal(await known(newWallet().address), false);
  broken = true;
  assert.equal(await known(traded.address), false);
  await a.app.close();
});

test('writes per client are limited', async () => {
  const a = await api();
  const w = newWallet();
  let last = 0;
  for (let i = 0; i <= USERNAME_LIMITS.write.max; i++) last = (await a.first(w.address, 'Luke_1')).statusCode;
  assert.equal(last, 429);
  assert.equal((await a.signed(change(w, 'Luke_2'))).statusCode, 429, 'one budget for both');
  await a.app.close();
});

test('names taken on v0.2.158 carry over, and can be changed with a signature', () => {
  const path = join(tempDir('vs-profiles-'), 'profiles.db');
  const w = newWallet();
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE usernames (address TEXT PRIMARY KEY, username TEXT NOT NULL, username_key TEXT NOT NULL UNIQUE, claimed_at INTEGER NOT NULL, statement TEXT NOT NULL, nonce TEXT NOT NULL, issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, chain_id INTEGER NOT NULL, signature TEXT NOT NULL) WITHOUT ROWID;
    CREATE TRIGGER usernames_never_change BEFORE UPDATE ON usernames BEGIN SELECT RAISE(ABORT, 'a username does not change'); END;`);
  db.prepare('INSERT INTO usernames VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(w.address, 'Early_1', 'early_1', NOW - 5000, 's', 'n', NOW - 5000, NOW, 1, '0xsig');
  db.close();
  const s = new ProfileStore(path);
  assert.equal(s.byAddress(w.address)?.username, 'Early_1');
  assert.equal(s.isTaken('early_1'), true);
  assert.ok(s.change(change(w, 'Later_1', { issuedAt: String(NOW + 1), expiresAt: String(NOW + 60_000) }), NOW + 2).ok);
  s.close();
  const again = new ProfileStore(path);
  assert.equal(again.byAddress(w.address)?.username, 'Later_1', 'a reopen does not bring the old name back');
  again.close();
});

test('database: a signed change is kept whole, and the store survives a reopen', () => {
  const path = join(tempDir('vs-profiles-'), 'profiles.db');
  const s = new ProfileStore(path);
  const w = newWallet();
  assert.ok(s.setFirst(w.address, 'Luke_1', NOW).ok);
  const c = change(w, 'Luke_2', { issuedAt: String(NOW + 1), expiresAt: String(NOW + 60_000) });
  assert.ok(s.change(c, NOW + 2).ok);
  s.close();
  const db = new DatabaseSync(path);
  const row = db.prepare('SELECT * FROM name_changes').get() as Record<string, unknown>;
  assert.equal(row.address, w.address);
  assert.equal(row.old_username, 'Luke_1');
  assert.equal(row.username, 'Luke_2');
  assert.equal(row.signature, c.signature);
  assert.equal(row.nonce, c.nonce);
  db.close();
  const again = new ProfileStore(path);
  assert.equal(again.byAddress(w.address)?.username, 'Luke_2');
  assert.equal(again.isTaken('LUKE_2'), true);
  assert.equal(again.isTaken('LUKE_2', w.address), false);
  again.close();
});
