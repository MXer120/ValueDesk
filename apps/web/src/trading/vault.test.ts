/**
 * The sealed trading key: opens only under its own device key, its own record
 * and its own address; the memory vault forgets expired keys. With a user lock
 * the key is sealed twice and opens only with the right user key.
 *   npx tsx --test src/trading/vault.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateTradingKey } from '@sodex-core';
import { KeyLockedError, LOCK_VERSION, memoryVault, newWrapKey, openKey, openRecord, sealKey, sealRecord, type StoredKey } from './vault';

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

// --- the user lock: a double seal ----------------------------------------------

const userKey = () => crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']) as Promise<CryptoKey>;

test('an unlocked record is exactly what it always was: no lock field, the device key alone opens it', async () => {
  const k = generateTradingKey();
  const m = meta({ keyAddress: k.address });
  const wrap = await newWrapKey();
  const rec = await sealRecord(wrap, 'mainnet:x', m, k.privateKey);
  assert.deepEqual(Object.keys(rec).sort(), ['ct', 'id', 'iv', 'meta']);
  assert.equal(rec.lock, undefined);
  assert.deepEqual(await openKey(wrap, m, rec), k.privateKey, 'the old reader still opens it');
  const opened = await openRecord(wrap, rec);
  assert.deepEqual(opened?.privateKey, k.privateKey);
  assert.equal(opened?.locked, undefined);
  // A record written before the lock existed (sealKey alone) opens the same way.
  const legacy = { id: 'mainnet:x', meta: m, ...(await sealKey(wrap, m, k.privateKey)) };
  assert.deepEqual((await openRecord(wrap, legacy))?.privateKey, k.privateKey);
});

test('a locked record opens only with the right user key, under the right device key; a wrong one keeps it', async () => {
  const k = generateTradingKey();
  const m = meta({ keyAddress: k.address });
  const wrap = await newWrapKey();
  const uk = await userKey();
  const rec = await sealRecord(wrap, 'mainnet:x', m, k.privateKey, uk);
  assert.equal(rec.lock, LOCK_VERSION);
  assert.equal(await openKey(wrap, m, rec), null, 'the device key alone opens no private key');
  await assert.rejects(openRecord(wrap, rec), (e: unknown) => e instanceof KeyLockedError && !e.wrongKey && e.meta.keyAddress === m.keyAddress);
  await assert.rejects(openRecord(wrap, rec, await userKey()), (e: unknown) => e instanceof KeyLockedError && e.wrongKey);
  assert.equal(await openRecord(await newWrapKey(), rec, uk), null, 'another browser: unusable, as before');
  assert.equal(await openRecord(wrap, { ...rec, meta: { ...m, owner: '0x00000000000000000000000000000000000000bb' } }, uk), null, 'a record moved to another wallet does not open');
  const opened = await openRecord(wrap, rec, uk);
  assert.deepEqual(opened?.privateKey, k.privateKey);
  assert.equal(opened?.locked, true);
});

test('memory vault: a locked key is kept sealed (no plaintext left), opens with its user key only', async () => {
  const v = memoryVault();
  const k = generateTradingKey();
  const m = meta({ keyAddress: k.address });
  const uk = await userKey();
  await v.save(m, k.privateKey, { userKey: uk });
  await assert.rejects(v.load('mainnet', m.owner), KeyLockedError);
  await assert.rejects(v.load('mainnet', m.owner, Date.now(), await userKey()), (e: unknown) => e instanceof KeyLockedError && e.wrongKey);
  assert.ok(await v.load('mainnet', m.owner, Date.now(), uk), 'a wrong key did not delete it');
  assert.deepEqual((await v.load('mainnet', m.owner, Date.now(), uk))?.privateKey, k.privateKey);
});

test('re-seal on set, change and remove: unlocked -> locked -> another lock -> unlocked', async () => {
  const v = memoryVault();
  const k = generateTradingKey();
  const m = meta({ keyAddress: k.address });
  await v.save(m, k.privateKey);
  const a = await userKey();
  const b = await userKey();

  assert.equal(await v.reseal('mainnet', m.owner, null, a), true, 'set');
  await assert.rejects(v.load('mainnet', m.owner), KeyLockedError);
  assert.equal((await v.load('mainnet', m.owner, Date.now(), a))?.locked, true);

  await assert.rejects(v.reseal('mainnet', m.owner, b, a), KeyLockedError, 'the current lock must open it first');
  assert.equal(await v.reseal('mainnet', m.owner, a, b), true, 'change');
  await assert.rejects(v.load('mainnet', m.owner, Date.now(), a), KeyLockedError);
  assert.deepEqual((await v.load('mainnet', m.owner, Date.now(), b))?.privateKey, k.privateKey);

  assert.equal(await v.reseal('mainnet', m.owner, b, null), true, 'remove');
  const plain = await v.load('mainnet', m.owner);
  assert.deepEqual(plain?.privateKey, k.privateKey);
  assert.equal(plain?.locked, undefined);

  assert.equal(await v.reseal('mainnet', '0x00000000000000000000000000000000000000cc', null, a), false, 'nothing stored');
});
