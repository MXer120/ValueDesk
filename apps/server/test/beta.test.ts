/**
 * The beta channel (beta/gate.ts, routes/beta.ts): a listed wallet's BetaSignIn for a token; the beta
 * API answers nothing else without a token of a wallet still on the list; a wallet taken off is out
 * within the list's cache; tokens and sign-ins of other domains or keys are refused.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import Fastify from 'fastify';
import { secp256k1 } from '@noble/curves/secp256k1';

import { BETA_LIST_TTL_MS, BetaList, BetaTokens, betaSignInDigest, channelFrom, installBetaGate } from '../src/beta/gate.js';
import { BETA_SIGN_IN_STATEMENT, BETA_TOKEN_HEADER, type BetaSignIn } from '../src/beta/signIn.js';
import { betaRoutes } from '../src/routes/beta.js';
import { bytesToHex, privateKeyToAddress } from '../src/signing/eip712.js';
import { tempDir } from './builderFakes.js';

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

function signIn(w: W, now: number, o: Partial<BetaSignIn> = {}): BetaSignIn {
  const base = { owner: w.address, statement: BETA_SIGN_IN_STATEMENT, nonce: randomBytes(16).toString('hex'), issuedAt: String(now), expiresAt: String(now + 5 * 60_000), chainId: 1, ...o };
  return { ...base, signature: rsv(betaSignInDigest(base), w.key) };
}

async function betaApi() {
  let t = 1_800_000_000_000;
  const listed = new Set<string>();
  const tokens = new BetaTokens(tempDir('vs-beta-'));
  const lock = { tokens, list: new BetaList(() => [...listed]), now: () => t };
  const app = Fastify();
  installBetaGate(app, lock);
  await app.register(betaRoutes, lock);
  app.get('/api/health', async () => ({ ok: true }));
  app.get('/api/vs/explore', async () => ({ rows: [] }));
  await app.ready();
  const get = (url: string, token?: string) => app.inject({ method: 'GET', url, headers: token ? { [BETA_TOKEN_HEADER]: token } : {} });
  const session = (s: BetaSignIn) => app.inject({ method: 'POST', url: '/api/beta/session', payload: { signIn: s } });
  return { app, listed, tokens, get, session, now: () => t, tick: (ms: number) => (t += ms) };
}

test('channel: only VALUESCAN_CHANNEL=beta is the beta channel', () => {
  assert.equal(channelFrom({}), 'main');
  assert.equal(channelFrom({ VALUESCAN_CHANNEL: ' Beta ' }), 'beta');
  assert.equal(channelFrom({ VALUESCAN_CHANNEL: 'staging' }), 'main');
});

test('beta API: health and the sign-in are open; everything else needs a token of a listed wallet', async () => {
  const b = await betaApi();
  const tester = newWallet();
  assert.equal((await b.get('/api/health')).statusCode, 200);
  const none = await b.get('/api/vs/explore');
  assert.equal(none.statusCode, 401);
  assert.equal(none.json().code, 'beta');
  assert.deepEqual((await b.get('/api/beta/me')).json(), { channel: 'beta', wallet: null, listed: false });

  // Not on the list: no token, however well signed.
  const refused = await b.session(signIn(tester, b.now()));
  assert.equal(refused.statusCode, 403);
  assert.equal(refused.json().code, 'beta-list');

  b.listed.add(tester.address);
  b.tick(BETA_LIST_TTL_MS);
  const once = signIn(tester, b.now());
  const ok = await b.session(once);
  assert.equal(ok.statusCode, 200, ok.body);
  const token = ok.json().token as string;
  assert.equal((await b.session(once)).statusCode, 403, 'a sign-in is used once');
  assert.equal((await b.get('/api/vs/explore', token)).statusCode, 200);
  assert.deepEqual((await b.get('/api/beta/me', token)).json(), { channel: 'beta', wallet: tester.address, listed: true });

  // Taken off the list: out once the cache turns over, token or not.
  b.listed.delete(tester.address);
  b.tick(BETA_LIST_TTL_MS);
  const out = await b.get('/api/vs/explore', token);
  assert.equal(out.statusCode, 403);
  assert.equal(out.json().code, 'beta-list');
});

test('beta sign-in and tokens: another key, statement or an old sign-in is refused; tokens expire and cannot be forged', async () => {
  const b = await betaApi();
  const tester = newWallet();
  b.listed.add(tester.address);
  const forged = { ...signIn(newWallet(), b.now()), owner: tester.address };
  assert.equal((await b.session(forged)).statusCode, 400);
  assert.equal((await b.session(signIn(tester, b.now(), { statement: 'Sign in to something else' }))).statusCode, 400);
  assert.equal((await b.session(signIn(tester, b.now() - 20 * 60_000))).statusCode, 400);

  const { token } = b.tokens.issue(tester.address, b.now());
  assert.equal(b.tokens.read(token, b.now()), tester.address);
  const other = newWallet().address;
  assert.equal(b.tokens.read(token.replace(tester.address, other), b.now()), null, 'the wallet is bound by the MAC');
  assert.equal(new BetaTokens(tempDir('vs-beta-other-')).read(token, b.now()), null, 'another key reads nothing');
  b.tick(7 * 86_400_000);
  assert.equal(b.tokens.read(token, b.now()), null, 'a week later it is gone');
});
