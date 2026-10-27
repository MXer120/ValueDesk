/**
 * The API's sanctions screen (src/builder/sanctions.ts): the engine's code and
 * list, character for character, and no signed fee terms for a listed wallet.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Fastify from 'fastify';

import { SANCTIONED_ADDRESSES, SANCTIONS_LIST_META } from '../src/builder/sanctionsList.js';
import { isSanctionedAddress, sanctionedOf } from '../src/builder/sanctions.js';
import { builderRoutes } from '../src/routes/builder.js';
import type { BuilderService } from '../src/builder/service.js';

const MARKER = '// ---- shared with apps/server/src/builder/sanctions.ts below this line ----\n';
const read = (url: URL) => readFileSync(url, 'utf8').replace(/\r\n/g, '\n');
const below = (url: URL) => {
  const s = read(url);
  const i = s.indexOf(MARKER);
  assert.ok(i >= 0, `${url.pathname} has the marker`);
  return s.slice(i + MARKER.length);
};

/** On the oracle's list (a Lazarus Group address on OFAC's SDN list). */
const LISTED = '0x098b716b8aaf21512996dc57eb0615e2383e2f96';
const CLEAN = '0x1111111111111111111111111111111111111111';

test("the API's screen is the engine's, below the marker, with the same list", () => {
  assert.equal(below(new URL('../src/builder/sanctions.ts', import.meta.url)), below(new URL('../../../packages/copy-engine/src/sanctions.ts', import.meta.url)));
  assert.equal(read(new URL('../src/builder/sanctionsList.ts', import.meta.url)), read(new URL('../../../packages/copy-engine/src/sanctionsList.ts', import.meta.url)), 'run scripts/update-sanctions-list.mjs: it writes both');
});

test('the list: lower-case addresses, no duplicates, as many as it says', () => {
  assert.ok(SANCTIONED_ADDRESSES.length > 50);
  assert.equal(SANCTIONED_ADDRESSES.length, SANCTIONS_LIST_META.count);
  assert.equal(new Set(SANCTIONED_ADDRESSES).size, SANCTIONED_ADDRESSES.length);
  for (const a of SANCTIONED_ADDRESSES) assert.match(a, /^0x[0-9a-f]{40}$/);
  assert.ok(isSanctionedAddress(LISTED));
  assert.ok(isSanctionedAddress(LISTED.toUpperCase().replace('0X', '0x')));
  assert.ok(isSanctionedAddress(` ${LISTED} `));
  assert.equal(isSanctionedAddress(CLEAN), false);
  for (const bad of [undefined, null, 42, '', 'not an address', LISTED.slice(0, 41)]) assert.equal(isSanctionedAddress(bad), false);
  assert.equal(sanctionedOf([CLEAN, LISTED]), 1);
  assert.equal(sanctionedOf([CLEAN, null]), null);
});

test('GET /api/vs/builder/terms: a listed wallet gets a 451 and nothing is signed or verified', async () => {
  const asked: string[] = [];
  const service = {
    terms: (r: { address: string }) => {
      asked.push(r.address);
      return { ok: true, builderId: null };
    },
    volumeUsd: () => 0,
  } as unknown as BuilderService;
  const app = Fastify();
  await app.register(builderRoutes, { service });
  await app.ready();
  try {
    const nonce = 'q7Xc-2_LmN0pRsTuVw';
    const listed = await app.inject({ method: 'GET', url: `/api/vs/builder/terms?address=${LISTED.toUpperCase().replace('0X', '0x')}&nonce=${nonce}&hint=1` });
    assert.equal(listed.statusCode, 451);
    assert.equal(listed.json().code, 'sanctioned');
    assert.equal(listed.json().ok, false);
    assert.equal(listed.headers['cache-control'], 'no-store, no-transform');
    assert.deepEqual(asked, []);
    const clean = await app.inject({ method: 'GET', url: `/api/vs/builder/terms?address=${CLEAN}&nonce=${nonce}` });
    assert.equal(clean.statusCode, 200);
    assert.deepEqual(asked, [CLEAN]);
  } finally {
    await app.close();
  }
});
