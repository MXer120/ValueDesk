/**
 * The sealed trading key: opens only under its own device key, its own record
 * and its own address; the memory vault forgets expired keys.
 *   npx tsx --test src/trading/vault.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateTradingKey } from '@sodex-core';
import { memoryVault, newWrapKey, openKey, sealKey, type StoredKey } from './vault';

const meta = (over: Partial<StoredKey> = {}): StoredKey => {
  const k = generateTradingKey();
  return {
    v: 1,
    network: 'mainnet',
    owner: '0x00000000000000000000000000000000000000aa',
    accountId: 1,
    name: 'vs-test',
    keyAddress: k.address,
    expiresAt: Date.now() + 3_600_000,
    createdAt: Date.now(),
    builder: null,
    ...over,
  };
};

test('seal and open round-trip; the plaintext is never the ciphertext', async () => {
  const k = generateTradingKey();
  const m = meta({ keyAddress: k.address });
  const wrap = await newWrapKey();
  const sealed = await sealKey(wrap, m, k.privateKey);
  assert.equal(sealed.iv.length, 12);
  assert.notDeepEqual(new Uint8Array(sealed.ct).slice(0, 32), k.privateKey);
  const opened = await openKey(wrap, m, sealed);
  assert.deepEqual(opened, k.privateKey);
});

test('a sealed key does not open under another device key, record or address', async () => {
  const k = generateTradingKey();
  const m = meta({ keyAddress: k.address });
  const wrap = await newWrapKey();
  const sealed = await sealKey(wrap, m, k.privateKey);
  assert.equal(await openKey(await newWrapKey(), m, sealed), null, 'another browser');
  assert.equal(await openKey(wrap, { ...m, owner: '0x00000000000000000000000000000000000000bb' }, sealed), null, 'moved to another wallet');
  assert.equal(await openKey(wrap, { ...m, network: 'testnet' }, sealed), null, 'moved to another network');
  assert.equal(await openKey(wrap, { ...m, keyAddress: generateTradingKey().address }, sealed), null, 'another key address');
  const flipped = new Uint8Array(sealed.ct.slice(0));
  flipped[0] = flipped[0]! ^ 1;
  assert.equal(await openKey(wrap, m, { iv: sealed.iv, ct: flipped.buffer }), null, 'tampered ciphertext');
});

test('the device key cannot be exported', async () => {
  const wrap = await newWrapKey();
  assert.equal(wrap.extractable, false);
  await assert.rejects(crypto.subtle.exportKey('raw', wrap));
});

test('memory vault: per wallet and network, expired keys are forgotten and zeroed', async () => {
  const v = memoryVault();
  const k = generateTradingKey();
  const m = meta({ keyAddress: k.address, expiresAt: Date.now() + 1000 });
  await v.save(m, k.privateKey);
  assert.ok(await v.load('mainnet', m.owner));
  assert.equal(await v.load('testnet', m.owner), null);
  assert.equal(await v.load('mainnet', '0x00000000000000000000000000000000000000cc'), null);
  assert.equal(await v.load('mainnet', m.owner, Date.now() + 2000), null, 'expired');
  assert.equal(await v.load('mainnet', m.owner), null, 'and gone');
});
