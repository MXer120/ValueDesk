/**
 * The device-secret keystore: the thing that replaced the user passphrase.
 *
 * The property that matters is that the secret is NOT stored next to the
 * ciphertext — this project lives inside a OneDrive folder, so anything written
 * beside the source is synchronised to the cloud. If both halves synced, the
 * encryption would be decorative.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { encryptKeystore, decryptKeystore, KeystoreError, type KeystoreMeta } from '../src/keystore.js';

const KEY = '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';

const meta = (protection: 'device' | 'passphrase'): KeystoreMeta => ({
  apiKeyName: 'valuetrade-test',
  accountId: 9150,
  address: '0x' + 'a'.repeat(40),
  keyAddress: '0x' + 'b'.repeat(40),
  network: 'mainnet',
  permissions: 15,
  expiresAt: 0,
  createdAt: 1730000000000,
  protection,
});

/** Load deviceKey.ts against a scratch location. */
async function withDeviceKeyDir<T>(fn: (dir: string, mod: typeof import('../src/deviceKey.js')) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'ot-dev-'));
  const prev = process.env.VALUETRADE_DEVICE_KEY;
  process.env.VALUETRADE_DEVICE_KEY = join(dir, 'device.key');
  try {
    // Cache-bust so each case gets a fresh read of the env var.
    const mod = await import(`../src/deviceKey.js?t=${Math.random()}`);
    return await fn(dir, mod);
  } finally {
    if (prev === undefined) delete process.env.VALUETRADE_DEVICE_KEY;
    else process.env.VALUETRADE_DEVICE_KEY = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the device key is created on first use and reused after', async () => {
  await withDeviceKeyDir(async (_dir, mod) => {
    assert.equal(mod.deviceKeyExists(), false);
    const first = mod.deviceSecret();
    assert.equal(first.length, 32);
    assert.equal(mod.deviceKeyExists(), true);
    // Stable across calls, or an existing keystore would become undecryptable.
    assert.deepEqual(mod.deviceSecret(), first);
  });
});

test('a keystore encrypted with the device secret round-trips', async () => {
  await withDeviceKeyDir(async (_dir, mod) => {
    const file = encryptKeystore(KEY, mod.devicePassphrase(), meta('device'));
    assert.equal(decryptKeystore(file, mod.devicePassphrase()), KEY);
  });
});

test('the keystore alone is useless without the device key', async () => {
  // The exact scenario this design exists for: the keystore syncs to the cloud
  // or lands in a backup, but the device key never leaves the machine.
  const stolen = await withDeviceKeyDir(async (_dir, mod) =>
    encryptKeystore(KEY, mod.devicePassphrase(), meta('device')),
  );
  // Different machine => different secret.
  await withDeviceKeyDir(async (_dir, mod) => {
    assert.throws(() => decryptKeystore(stolen, mod.devicePassphrase()), KeystoreError);
  });
});

test('the device key is written outside the project directory', async () => {
  await withDeviceKeyDir(async (_dir, mod) => {
    delete process.env.VALUETRADE_DEVICE_KEY;
    const real = await import(`../src/deviceKey.js?t=${Math.random()}`);
    const path = resolve(real.deviceKeyPath());
    const projectRoot = resolve(new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
    assert.ok(
      !path.toLowerCase().startsWith(projectRoot.toLowerCase()),
      `device key must not live under the project (would be cloud-synced): ${path}`,
    );
    void mod;
  });
});

test('a malformed device key fails loudly instead of minting a new one', async () => {
  // Silently regenerating would make an existing keystore permanently unreadable.
  await withDeviceKeyDir(async (dir, mod) => {
    const p = join(dir, 'device.key');
    writeFileSync(p, 'not-hex');
    assert.ok(existsSync(p));
    assert.throws(() => mod.deviceSecret(), /malformed/i);
  });
});

test('the stored device key is 32 bytes of hex and nothing else', async () => {
  await withDeviceKeyDir(async (dir, mod) => {
    mod.deviceSecret();
    const raw = readFileSync(join(dir, 'device.key'), 'utf8').trim();
    assert.match(raw, /^[0-9a-f]{64}$/);
  });
});

test('protection mode is recorded so unlock knows what to do', () => {
  const dev = encryptKeystore(KEY, 'x'.repeat(40), meta('device'));
  const pass = encryptKeystore(KEY, 'hunter22', meta('passphrase'));
  assert.equal(dev.meta.protection, 'device');
  assert.equal(pass.meta.protection, 'passphrase');
  // Metadata stays readable without any secret, so the UI can decide up front.
  assert.equal(dev.meta.permissions, 15);
});
