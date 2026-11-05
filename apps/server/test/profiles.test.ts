/**
 * Usernames (profiles/, routes/profiles.ts): signed by the wallet, one per wallet, one wallet per
 * name in any spelling, and no way to change one - not through the route, not in the database.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import Fastify from 'fastify';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';

import { usernameClaimDigest, checkUsernameClaim } from '../src/profiles/check.js';
import { USERNAME_STATEMENT, usernameKey, usernameProblem, usernameTypedData, type UsernameClaim } from '../src/profiles/claim.js';
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

function claim(w: W, username: string, o: Partial<UsernameClaim> = {}, signer: W = w): UsernameClaim {
  const base = { owner: w.address, username, statement: USERNAME_STATEMENT, nonce: randomBytes(16).toString('hex'), issuedAt: String(NOW), expiresAt: String(NOW + 5 * 60_000), chainId: 1, ...o };
  return { ...base, signature: rsv(usernameClaimDigest(base), signer.key) };
}

async function api() {
  const store = new ProfileStore(':memory:');
  const app = Fastify();
  await app.register(profileRoutes, { store, now: () => NOW, limiter: new KeyedLimiter(1000) });
  await app.ready();
  const post = (c: unknown) => app.inject({ method: 'POST', url: '/api/vs/username', payload: { claim: c } });
  const profile = (a: string) => app.inject({ method: 'GET', url: `/api/vs/profile?address=${a}` });
  const check = (n: string) => app.inject({ method: 'GET', url: `/api/vs/username/check?name=${encodeURIComponent(n)}` });
  return { app, store, post, profile, check };
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
  const c = claim(w, 'Luke_1');
  const td = usernameTypedData(c);
  assert.equal(td.primaryType, 'UsernameClaim');
  assert.deepEqual(td.message, { owner: w.address, username: 'Luke_1', statement: USERNAME_STATEMENT, nonce: c.nonce, issuedAt: c.issuedAt, expiresAt: c.expiresAt });
  // The EIP-712 type string of the typed data's field list is the one the digest starts from.
  const type = `UsernameClaim(${td.types.UsernameClaim.map((f) => `${f.type} ${f.name}`).join(',')})`;
  assert.equal(type, 'UsernameClaim(address owner,string username,string statement,string nonce,uint64 issuedAt,uint64 expiresAt)');
  assert.equal(keccak_256(new TextEncoder().encode(type)).length, 32);
});

test('claim check: wording, window, name, and only the wallet itself can sign', () => {
  const w = newWallet();
  const other = newWallet();
  assert.ok(checkUsernameClaim(claim(w, 'Luke_1'), NOW).ok);
  const cases: Array<[unknown, RegExp]> = [
    [null, /missing/],
    [claim(w, 'Luke_1', { statement: 'something else' }), /not the username claim/],
    [claim(w, 'Luke_1', {}, other), /not from this wallet/],
    [claim(w, 'sodex_hq'), /reserved/],
    [claim(w, 'Luke_1', { expiresAt: String(NOW - 1), issuedAt: String(NOW - 60_000) }), /expired/],
    [claim(w, 'Luke_1', { expiresAt: String(NOW + 3_600_000) }), /longer than allowed/],
    [claim(w, 'Luke_1', { issuedAt: String(NOW + 3_600_000), expiresAt: String(NOW + 3_660_000) }), /too far ahead/],
    [{ ...claim(w, 'Luke_1'), username: 'Luke_2' }, /not from this wallet/],
  ];
  for (const [c, re] of cases) {
    const r = checkUsernameClaim(c, NOW);
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, re);
  }
});

test('route: take a name; it is the wallet\'s; a repeat is the same answer', async () => {
  const a = await api();
  const w = newWallet();
  assert.equal((await a.profile(w.address)).json().username, null);
  assert.deepEqual((await a.check('Luke_1')).json(), { ok: true, available: true, reason: null });
  const c = claim(w, 'Luke_1');
  const r = await a.post(c);
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json(), { ok: true, username: 'Luke_1', claimedAt: NOW });
  assert.equal((await a.profile(w.address.toUpperCase().replace('0X', '0x'))).json().username, 'Luke_1');
  assert.equal((await a.post(c)).statusCode, 200, 'the same claim twice (a retry after a lost answer)');
  assert.equal((await a.check('luke_1')).json().available, false);
  await a.app.close();
});

test('route: a wallet keeps its first name; a name has one wallet, in any spelling', async () => {
  const a = await api();
  const w = newWallet();
  const other = newWallet();
  await a.post(claim(w, 'Luke_1'));
  const second = await a.post(claim(w, 'Another_1'));
  assert.equal(second.statusCode, 409);
  assert.equal(second.json().code, 'has-name');
  assert.equal(second.json().username, 'Luke_1');
  const stolen = await a.post(claim(other, 'LUKE_1'));
  assert.equal(stolen.statusCode, 409);
  assert.equal(stolen.json().code, 'taken');
  assert.equal((await a.profile(other.address)).json().username, null);
  assert.equal((await a.profile(w.address)).json().username, 'Luke_1');
  await a.app.close();
});

test('route: a claim signed by another wallet and a bad address are refused', async () => {
  const a = await api();
  const w = newWallet();
  const other = newWallet();
  assert.equal((await a.post(claim(w, 'Luke_1', {}, other))).statusCode, 400);
  assert.equal((await a.profile('nope')).statusCode, 400);
  assert.equal((await a.profile(w.address)).json().username, null);
  await a.app.close();
});

test('route: claims per client are limited', async () => {
  const a = await api();
  const w = newWallet();
  const c = claim(w, 'Luke_1');
  let last = 0;
  for (let i = 0; i <= USERNAME_LIMITS.claim.max; i++) last = (await a.post(c)).statusCode;
  assert.equal(last, 429);
  await a.app.close();
});

test('route: known says a wallet has traded through ValueDesk, and a failing ledger never breaks the answer', async () => {
  const store = new ProfileStore(':memory:');
  const traded = newWallet();
  const app = Fastify();
  let broken = false;
  await app.register(profileRoutes, { store, now: () => NOW, limiter: new KeyedLimiter(1000), known: (a: string) => { if (broken) throw new Error('no ledger'); return a === traded.address; } });
  await app.ready();
  const known = async (a: string) => (await app.inject({ method: 'GET', url: `/api/vs/profile?address=${a}` })).json().known;
  assert.equal(await known(traded.address), true);
  assert.equal(await known(newWallet().address), false);
  broken = true;
  assert.equal(await known(traded.address), false);
  await app.close();
});

test('database: the row holds the signed claim, and no UPDATE gets through', () => {
  const path = join(tempDir('vs-profiles-'), 'profiles.db');
  const s = new ProfileStore(path);
  const w = newWallet();
  const c = claim(w, 'Luke_1');
  assert.ok(s.claim(c, NOW).ok);
  s.close();
  const db = new DatabaseSync(path);
  const row = db.prepare('SELECT * FROM usernames').get() as Record<string, unknown>;
  assert.equal(row.address, w.address);
  assert.equal(row.username_key, 'luke_1');
  assert.equal(row.signature, c.signature);
  assert.equal(row.nonce, c.nonce);
  assert.throws(() => db.prepare("UPDATE usernames SET username = 'Other_1', username_key = 'other_1'").run(), /does not change/);
  db.close();
  // Survives a reopen, trigger included.
  const again = new ProfileStore(path);
  assert.equal(again.byAddress(w.address)?.username, 'Luke_1');
  assert.equal(again.isTaken('LUKE_1'), true);
  again.close();
});
