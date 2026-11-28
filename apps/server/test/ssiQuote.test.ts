/**
 * The SSI index quote relay (routes/ssiQuote.ts): only SoDEX's own quote call passes, the input is checked, SoDEX's
 * answer goes back as it is, and the limit holds. No network: a fake fetch stands in for wealth.sodex.dev.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { SSI_QUOTE_LIMIT, parseSsiQuote, ssiQuoteRoutes } from '../src/routes/ssiQuote.js';

const OWNER = '0x1111111111111111111111111111111111111111';
const good = { fundId: 'antb', side: 'buy', owner: OWNER, payAmount: '10000000' };

test('the request: a fund id, buy or sell, an address and base units, nothing else passes', () => {
  assert.deepEqual(parseSsiQuote(good), good);
  assert.equal(parseSsiQuote({ ...good, fundId: '../x' }), null);
  assert.equal(parseSsiQuote({ ...good, side: 'mint' }), null);
  assert.equal(parseSsiQuote({ ...good, owner: '0x12' }), null);
  assert.equal(parseSsiQuote({ ...good, payAmount: '0' }), null);
  assert.equal(parseSsiQuote({ ...good, payAmount: '1.5' }), null);
  assert.equal(parseSsiQuote(null), null);
});

async function app(answer: { status: number; body: unknown }, seen: Array<{ url: string; body: string }> = []) {
  const a = Fastify();
  await a.register(ssiQuoteRoutes({
    fetch: async (url, init) => { seen.push({ url, body: init.body }); return { status: answer.status, json: async () => answer.body }; },
  }));
  return a;
}

test('SoDEX\'s quote call, and its data back as it is', async () => {
  const seen: Array<{ url: string; body: string }> = [];
  const a = await app({ status: 200, body: { code: 0, msg: 'success', data: { protocol: 'ssi-v2-rfq', quotable: true } } }, seen);
  const r = await a.inject({ method: 'POST', url: '/api/vs/wealth/ssi-quote', payload: { ...good, extra: 'dropped' } });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json(), { ok: true, data: { protocol: 'ssi-v2-rfq', quotable: true } });
  assert.equal(seen[0]!.url, 'https://wealth.sodex.dev/api/v1/wealth/funds/antb/rfq/quote');
  assert.deepEqual(JSON.parse(seen[0]!.body), { side: 'buy', owner: OWNER, payAmount: '10000000' }, 'only the three fields SoDEX takes');
});

test('a bad request never reaches SoDEX; a SoDEX error is a 502', async () => {
  const seen: Array<{ url: string; body: string }> = [];
  const a = await app({ status: 200, body: { code: -1, msg: 'nope' } }, seen);
  assert.equal((await a.inject({ method: 'POST', url: '/api/vs/wealth/ssi-quote', payload: { ...good, owner: 'x' } })).statusCode, 400);
  assert.equal(seen.length, 0);
  const r = await a.inject({ method: 'POST', url: '/api/vs/wealth/ssi-quote', payload: good });
  assert.equal(r.statusCode, 502);
  assert.equal(r.json().error, 'nope');
});

test('the limit per client holds', async () => {
  const a = await app({ status: 200, body: { code: 0, data: {} } });
  let last = 0;
  for (let i = 0; i <= SSI_QUOTE_LIMIT.max; i++) last = (await a.inject({ method: 'POST', url: '/api/vs/wealth/ssi-quote', payload: good })).statusCode;
  assert.equal(last, 429);
});
