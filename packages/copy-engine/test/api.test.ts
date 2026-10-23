import { test } from 'node:test';
import assert from 'node:assert/strict';
import { secp256k1 } from '@noble/curves/secp256k1';
import { bytesToHex, hexToBytes, privateKeyToAddress } from '../../sodex-core/src/index.ts';
import { buildCopyRequest, canonicalJSON, canonicalSettings, checkSettings, copyRequestDigest, parseSettings, verifyCopyRequest, type CopyRequest } from '../src/index.ts';
import { LEADER } from './helpers.ts';

const pk = secp256k1.utils.randomPrivateKey();
const owner = privateKeyToAddress(pk).toLowerCase();

function sign(r: CopyRequest): string {
  const sig = secp256k1.sign(hexToBytes(copyRequestDigest(r)), pk);
  const out = new Uint8Array(65);
  out.set(sig.toCompactRawBytes(), 0);
  out[64] = 27 + sig.recovery;
  return bytesToHex(out);
}

test('a request signed by the owner verifies; any change does not', () => {
  const now = 1_800_000_000_000;
  const r = buildCopyRequest({ action: 'pause', owner, executor: 'vd-tokyo-1', payload: { id: 'c1' }, chainId: 42161, now });
  const signed = { ...r, signature: sign(r) };
  const ok = verifyCopyRequest(signed, { executor: 'vd-tokyo-1', now: now + 1000 });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.ok && ok.payload, { id: 'c1' });

  assert.match(String((verifyCopyRequest({ ...signed, payload: '{"id":"c2"}' }, { executor: 'vd-tokyo-1', now }) as { error: string }).error), /not from this wallet/);
  assert.equal(verifyCopyRequest(signed, { executor: 'other', now }).ok, false);
  assert.equal(verifyCopyRequest(signed, { executor: 'vd-tokyo-1', now: now + 6 * 60_000 }).ok, false); // past the deadline
  assert.equal(verifyCopyRequest({ ...signed, action: 'resume' }, { executor: 'vd-tokyo-1', now }).ok, false);
  assert.equal(verifyCopyRequest({ ...signed, chainId: 1 }, { executor: 'vd-tokyo-1', now }).ok, false);
});

test('payloads must be canonical JSON (what the wallet showed is what is stored)', () => {
  assert.equal(canonicalJSON({ b: 1, a: [{ d: 2, c: 1 }], z: undefined }), '{"a":[{"c":1,"d":2}],"b":1}');
  const now = 1_800_000_000_000;
  const r = { ...buildCopyRequest({ action: 'pause', owner, executor: 'x', payload: { id: 'c1' }, chainId: 1, now }), payload: '{ "id": "c1" }' };
  assert.match(String((verifyCopyRequest({ ...r, signature: sign(r) }, { executor: 'x', now }) as { error: string }).error), /canonical/);
});

test('settings: defaults fill gaps, bad values are named, the canonical form is stable', () => {
  const s = parseSettings({ leader: { venue: 'sodex', address: LEADER.toUpperCase().replace('0X', '0x') }, assetDeny: 'eth, btc' });
  assert.equal(s.leader.address, LEADER);
  assert.deepEqual(s.assetDeny, ['BTC', 'ETH']);
  assert.equal(s.maxLeverage, 5);
  const bad = checkSettings({ leader: { venue: 'binance', address: 'nope' }, maxLeverage: 500, slippageBps: 0, assetAllow: ['BTC'], assetDeny: ['BTC'] });
  assert.equal(bad.settings, null);
  assert.ok(bad.errors['leader.venue'] && bad.errors['leader.address'] && bad.errors.maxLeverage && bad.errors.slippageBps && bad.errors.assetDeny);
  const c1 = canonicalJSON(canonicalSettings(s));
  const c2 = canonicalJSON(canonicalSettings(parseSettings(JSON.parse(c1))));
  assert.equal(c1, c2);
});
