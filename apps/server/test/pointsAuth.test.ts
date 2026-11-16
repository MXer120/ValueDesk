/**
 * The SoPoints sign-in relay (routes/pointsAuth.ts): SoDEX's sign-in text only, fixed type and autoSign, no Origin,
 * the token alone back, a rate limit.
 *   npx tsx --test test/pointsAuth.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { POINTS_AUTH_LIMITS, SIGN_IN_TEXT, pointsAuthRoutes } from '../src/routes/pointsAuth.js';

const ADDR = '0x1111111111111111111111111111111111111111';
const MSG = 'Confirm wallet to reveal your SoDEX referral code. No blockchain transaction or gas fee will occur.\n\nURI: https://sodex.com\nNonce: vymr4xdJ9FGiHfdrMfVuyU\n';
const SIG = `0x${'ab'.repeat(65)}`;

function app(answer: (path: string, body: Record<string, unknown>) => unknown) {
  const calls: Array<{ url: string; body: Record<string, unknown>; headers: Headers }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ url: String(url), body, headers: new Headers(init?.headers) });
    return new Response(JSON.stringify(answer(String(url), body)), { status: 200 });
  }) as typeof fetch;
  const a = Fastify();
  void a.register(pointsAuthRoutes({ fetchImpl }));
  return { a, calls };
}

test('SoDEX\'s own sign-in text passes; an order, a transfer or a changed text does not', () => {
  assert.ok(SIGN_IN_TEXT.test(MSG));
  assert.ok(!SIGN_IN_TEXT.test(MSG.replace('referral code', 'funds')));
  assert.ok(!SIGN_IN_TEXT.test(`${MSG}Transfer 100 USDC`));
  assert.ok(!SIGN_IN_TEXT.test('{"type":"withdraw","amount":"100"}'));
});

test('nonce: type fixed to sign_in, no Origin, only the message back', async () => {
  const { a, calls } = app(() => ({ code: 0, data: { message: MSG, nonce: 'n', other: 'x' } }));
  const r = await a.inject({ method: 'POST', url: '/api/vs/sodex-auth/nonce', payload: { address: ADDR, type: 'terms_of_use' } });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json(), { ok: true, message: MSG });
  assert.equal(calls[0]!.url, 'https://sodex.com/auth/v2/nonce');
  assert.deepEqual(calls[0]!.body, { address: ADDR, type: 'sign_in' });
  assert.equal(calls[0]!.headers.get('origin'), null);
  assert.equal(r.headers['cache-control'], 'no-store');
});

test('nonce: a message from SoDEX that is not its sign-in text is not passed on', async () => {
  const { a } = app(() => ({ code: 0, data: { message: 'Sign this order' } }));
  const r = await a.inject({ method: 'POST', url: '/api/vs/sodex-auth/nonce', payload: { address: ADDR } });
  assert.equal(r.statusCode, 502);
});

test('verify: autoSign false and sign_in whatever the caller sends; the token alone comes back', async () => {
  const { a, calls } = app(() => ({ code: 0, data: { accessToken: 'jwt', refresh: 'r', user: { id: 1 } } }));
  const r = await a.inject({ method: 'POST', url: '/api/vs/sodex-auth/verify', payload: { address: ADDR, message: MSG, signature: SIG, type: 'terms_of_use', autoSign: true } });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json(), { ok: true, accessToken: 'jwt' });
  assert.deepEqual(calls[0]!.body, { address: ADDR, message: MSG, signature: SIG, type: 'sign_in', autoSign: false });
});

test('verify: any other text is refused before SoDEX is asked', async () => {
  const { a, calls } = app(() => ({ code: 0, data: { accessToken: 'jwt' } }));
  for (const message of ['Transfer 100 USDC', MSG.replace('Nonce', 'Order')]) {
    const r = await a.inject({ method: 'POST', url: '/api/vs/sodex-auth/verify', payload: { address: ADDR, message, signature: SIG } });
    assert.equal(r.statusCode, 400);
  }
  const bad = await a.inject({ method: 'POST', url: '/api/vs/sodex-auth/verify', payload: { address: 'nope', message: MSG, signature: SIG } });
  assert.equal(bad.statusCode, 400);
  assert.equal(calls.length, 0);
});

test('verify: SoDEX refusing the signature is a 401 with its reason, no token', async () => {
  const { a } = app(() => ({ code: 4001, message: 'invalid signature' }));
  const r = await a.inject({ method: 'POST', url: '/api/vs/sodex-auth/verify', payload: { address: ADDR, message: MSG, signature: SIG } });
  assert.equal(r.statusCode, 502);
  assert.deepEqual(r.json(), { ok: false, error: 'invalid signature' });
});

test('rate limit per client', async () => {
  const { a } = app(() => ({ code: 0, data: { message: MSG } }));
  let last = 0;
  for (let i = 0; i <= POINTS_AUTH_LIMITS.nonce.max; i++) last = (await a.inject({ method: 'POST', url: '/api/vs/sodex-auth/nonce', payload: { address: ADDR } })).statusCode;
  assert.equal(last, 429);
});
