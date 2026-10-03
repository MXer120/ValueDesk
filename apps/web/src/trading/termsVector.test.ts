/**
 * The fixed vector of the signed builder terms, shared with the server
 * (apps/server/test/builderTerms.vector.json, docs/BUILDER-TIERS.md §3): the
 * server's tests sign it, these check that the app rebuilds the very same
 * bytes, names the same key and accepts the signature - so the two sides
 * cannot drift apart without one of the two suites failing.
 *
 * The key is a TEST key (seed 00 01 ... 1f). Nothing here is used by a build.
 *   npx tsx --test src/trading/termsVector.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readTermsAnswer, termsKeyId, termsMessage, type TermsFields } from './terms';

interface Vector {
  fields: TermsFields;
  message: string;
  sig: string;
}
const V = JSON.parse(readFileSync(fileURLToPath(new URL('../../../server/test/builderTerms.vector.json', import.meta.url)), 'utf8')) as {
  publicKey: string;
  keyId: string;
  vectors: Vector[];
};

const subtle = globalThis.crypto.subtle;

test('shared vector: the app rebuilds the bytes the server signed, and the signature verifies', async () => {
  assert.equal(V.vectors.length, 3);
  const key = await subtle.importKey('raw', Buffer.from(V.publicKey, 'base64url'), { name: 'Ed25519' }, false, ['verify']);
  for (const v of V.vectors) {
    assert.equal(termsMessage(v.fields), v.message);
    const ok = await subtle.verify('Ed25519', key, Buffer.from(v.sig, 'base64url'), new TextEncoder().encode(termsMessage(v.fields)));
    assert.equal(ok, true, v.message.split('\n').join(' | '));
  }
  // A changed fee is another message.
  const lower = termsMessage({ ...V.vectors[0]!.fields, perps: V.vectors[0]!.fields.perps - 1 });
  assert.equal(await subtle.verify('Ed25519', key, Buffer.from(V.vectors[0]!.sig, 'base64url'), new TextEncoder().encode(lower)), false);
});

test('shared vector: the key id is the server\'s', async () => {
  assert.equal(await termsKeyId(V.publicKey), V.keyId);
});

test('shared vector: an answer the server would send for it is read as the terms it signs', () => {
  for (const v of V.vectors) {
    const f = v.fields;
    const body = {
      ok: true, chain: f.chain, builderId: f.builderId, address: f.address, fee: { perps: f.perps, spot: f.spot }, nonce: f.nonce,
      issued: f.issued, ttl: f.ttl, keyId: V.keyId, sig: v.sig,
      default: { perps: f.perps, spot: f.spot }, volume: { perpsUsd: 0, spotUsd: 0, totalUsd: 0, verifiedAt: null, pending: false },
      tier: { index: 0, next: null }, flags: [],
    };
    const read = readTermsAnswer(body, { chain: f.chain, builderId: f.builderId, address: f.address, nonce: f.nonce, defaults: { perps: f.perps, spot: f.spot } });
    assert.ok(read.ok, JSON.stringify(read));
    assert.deepEqual(read.fee, { perps: f.perps, spot: f.spot });
    assert.equal(read.issued, f.issued);
    assert.equal(read.ttl, f.ttl);
    assert.equal(read.keyId, V.keyId);
    assert.equal(Buffer.from(read.sig).toString('base64url'), v.sig);
  }
});
