/**
 * Which deposit address is shown (sodex/depositAddress.ts): the CURRENT one,
 * only when every source that answered agrees, never a flagged one.
 *   npx tsx --test test/depositAddress.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { issuerStatus, pickDepositAddress, sameDepositAddress } from '../src/sodex/depositAddress.js';

const A = '0xD290c3c0Cd6561b4552E7f8F267a3fD331514896';
const B = '0x5Cc60dB393c3d48B8128BC82183dA57fD9fC7B01';

test('the usual case: the registry lists the current address - shown (EVM compared without case)', () => {
  assert.deepEqual(pickDepositAddress({ chain: 'ETH', current: A, list: [A.toLowerCase()] }), { ok: true, address: A });
  assert.deepEqual(pickDepositAddress({ chain: 'ETH', current: A, list: [A], issuer: { status: 'Enabled', address: A } }), { ok: true, address: A });
});

test('after a replacement (the registry appends): the CURRENT address, not sodex.com\'s oldest first entry', () => {
  assert.deepEqual(pickDepositAddress({ chain: 'ETH', current: B, list: [A, B] }), { ok: true, address: B });
});

test('flagged by SoDEX: withheld, and marked so the user can ask for the new one', () => {
  const r = pickDepositAddress({ chain: 'ETH', current: A, list: [A], issuer: { status: 'Suspicious', address: A } });
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.flagged, true);
});

test('withheld whenever the sources do not all agree, or only one answered', () => {
  assert.equal(pickDepositAddress({ chain: 'ETH', current: A, list: [B] }).ok, false, 'current not in the coin\'s list');
  assert.equal(pickDepositAddress({ chain: 'ETH', current: A, list: [A], issuer: { status: 'Enabled', address: B } }).ok, false, 'issuer disagrees');
  assert.equal(pickDepositAddress({ chain: 'ARC', current: null, list: [] }).ok, false, 'nothing issued (USDC on ARC)');
  assert.equal(pickDepositAddress({ chain: 'ETH', current: null, list: [A] }).ok, false, 'no current address on-chain');
  assert.equal(pickDepositAddress({ chain: 'ETH', current: A }).ok, false, 'the chain alone is one source');
  assert.equal(pickDepositAddress({ chain: 'ETH', current: A, issuer: { status: 'Processing', address: A } }).ok, true, 'chain + issuer agree (SOSO)');
});

test('non-EVM addresses compare byte for byte; an XRP/Stellar entry with a memo is not offered', () => {
  assert.equal(sameDepositAddress('rnA9QDmAy7y25cdNw7N82M2PpfbhnLEy5E', 'rna9qdmay7y25cdnw7n82m2ppfbhnley5e'), false);
  assert.equal(pickDepositAddress({ chain: 'XRP', current: 'rnA9QDmAy7y25cdNw7N82M2PpfbhnLEy5E', list: ['rnA9QDmAy7y25cdNw7N82M2PpfbhnLEy5E'] }).ok, true);
  assert.equal(pickDepositAddress({ chain: 'XRP', current: 'rnA9QDmAy7y25cdNw7N82M2PpfbhnLEy5E:123', list: ['rnA9QDmAy7y25cdNw7N82M2PpfbhnLEy5E:123'] }).ok, false);
});

test('the issuer status is mapped as sodex.com maps it', () => {
  assert.deepEqual(['Enabled', 'Processing', 'Suspicious', 'weird', undefined].map(issuerStatus), ['Enabled', 'Processing', 'Suspicious', 'Empty', 'Empty']);
});
