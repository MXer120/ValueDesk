/**
 * Multiple simultaneously-unlocked accounts.
 *
 * Two properties here are unrecoverable if wrong, which is why they are tested
 * rather than reasoned about:
 *
 *  1. NO KEY IS EVER ORPHANED. The plaintext of a signing key exists in exactly
 *     one place - the keystore ciphertext. A migration that fails to find an old
 *     single-slot record, or a save that overwrites a sibling record, destroys
 *     funds-bearing credentials with no way back.
 *  2. NONCES REACH THE GATEWAY IN INCREASING ORDER. The gateway requires this per
 *     API key and rejects a lower nonce as stale, so an order silently fails.
 *     With N keys sharing one counter the guarantee has to hold for every
 *     subsequence, not just the whole.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as ks from '../src/keystore.js';
import { KeystoreError, type KeystoreMeta, type KeystoreRecord } from '../src/keystore.js';
import { SodexClient, NotUnlockedError } from '../src/sodex/rest.js';
import { hexToBytes, privateKeyToAddress } from '../src/signing/eip712.js';
import { revokeAPIKey, ACTION } from '../src/signing/actions.js';

// Two distinct, valid secp256k1 keys. Fixed so a failure is reproducible.
const KEY_A = '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
const KEY_B = '0x8f2a559490a2c1e0d3c47e1a6e2f6e9c1b7a9d3e5f81234567890abcdef01234';

const ADDR_A = '0x' + 'a'.repeat(40);
const ADDR_B = '0x' + 'b'.repeat(40);

const meta = (address: string, over: Partial<KeystoreMeta> = {}): KeystoreMeta => ({
  apiKeyName: `key-${address.slice(2, 6)}`,
  accountId: 1000 + Number.parseInt(address.slice(2, 4), 16),
  address,
  keyAddress: '0xc' + address.slice(3),
  network: 'testnet',
  permissions: 15,
  expiresAt: 0,
  createdAt: 1730000000000,
  protection: 'passphrase',
  ...over,
});

function withTmp(fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'ot-multi-'));
  try {
    fn(join(dir, 'keystore.json'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- migration ---------------------------------------------------------------

test('a legacy single-slot keystore migrates and the key still decrypts', () => {
  withTmp((path) => {
    // Byte-for-byte what the pre-multi-account `save()` wrote: the record itself
    // as the whole file, with no accounts map and no active pointer.
    const legacy = ks.encryptKeystore(KEY_A, 'pw-a', meta(ADDR_A));
    writeFileSync(path, JSON.stringify(legacy, null, 2));
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).version, 1, 'fixture is not the legacy shape');

    const vault = ks.loadVault(path);
    assert.equal(vault.version, 2);
    assert.deepEqual(Object.keys(vault.accounts), [ADDR_A.toLowerCase()]);
    assert.equal(vault.active, ADDR_A.toLowerCase(), 'the only account must become active');

    // The whole point: the existing secret still opens it. Migration re-keys the
    // container, never the ciphertext.
    assert.equal(ks.decryptKeystore(vault.accounts[ADDR_A.toLowerCase()]!, 'pw-a'), KEY_A);
    assert.equal(ks.decryptKeystore(ks.load(path)!, 'pw-a'), KEY_A);
    assert.equal(ks.decryptKeystore(ks.loadAccount(path, ADDR_A)!, 'pw-a'), KEY_A);
  });
});

test('migrating then adding a second account leaves the legacy key intact', () => {
  withTmp((path) => {
    writeFileSync(path, JSON.stringify(ks.encryptKeystore(KEY_A, 'pw-a', meta(ADDR_A))));
    ks.saveAccount(path, ks.encryptKeystore(KEY_B, 'pw-b', meta(ADDR_B)));

    const vault = ks.loadVault(path);
    assert.equal(vault.version, 2, 'the file should now be stored in vault form');
    assert.equal(Object.keys(vault.accounts).length, 2);
    assert.equal(ks.decryptKeystore(ks.loadAccount(path, ADDR_A)!, 'pw-a'), KEY_A);
    assert.equal(ks.decryptKeystore(ks.loadAccount(path, ADDR_B)!, 'pw-b'), KEY_B);
  });
});

test('a legacy record with no wallet address is filed under its key address', () => {
  // Written before the master address was recorded. Dropping it would orphan the
  // only copy of the key, so it is keyed by the one identity it does carry.
  const legacy = ks.encryptKeystore(KEY_A, 'pw', meta(ADDR_A, { address: '' }));
  const vault = ks.parseVault(JSON.parse(JSON.stringify(legacy)));
  assert.deepEqual(Object.keys(vault.accounts), [legacy.meta.keyAddress.toLowerCase()]);
  assert.equal(ks.decryptKeystore(vault.accounts[legacy.meta.keyAddress.toLowerCase()]!, 'pw'), KEY_A);
});

test('an unrecognised keystore file is refused, not silently treated as empty', () => {
  // Reading it as "no keystore" would make the next save overwrite real key
  // material with a fresh single-account vault.
  assert.throws(() => ks.parseVault({ version: 99, stuff: true }), KeystoreError);
  assert.throws(() => ks.parseVault('nope'), KeystoreError);
  withTmp((path) => {
    writeFileSync(path, '{ not json');
    assert.throws(() => ks.loadVault(path), KeystoreError);
  });
});

// --- independence ------------------------------------------------------------

test('two accounts save, load and decrypt independently, each with its own salt', () => {
  withTmp((path) => {
    const a = ks.encryptKeystore(KEY_A, 'pw-a', meta(ADDR_A));
    const b = ks.encryptKeystore(KEY_B, 'pw-b', meta(ADDR_B));
    ks.saveAccount(path, a);
    ks.saveAccount(path, b);

    const back = ks.loadVault(path).accounts;
    const ra = back[ADDR_A.toLowerCase()]!;
    const rb = back[ADDR_B.toLowerCase()]!;

    assert.equal(ks.decryptKeystore(ra, 'pw-a'), KEY_A);
    assert.equal(ks.decryptKeystore(rb, 'pw-b'), KEY_B);

    // A shared salt would let one scrypt evaluation be amortised across every
    // record - the exact cost scrypt is deployed to impose per key.
    assert.notEqual(ra.salt, rb.salt);
    assert.notEqual(ra.iv, rb.iv);
    assert.match(ra.salt, /^[0-9a-f]{64}$/);
    assert.match(rb.salt, /^[0-9a-f]{64}$/);
  });
});

test('two accounts under the SAME passphrase still get different salts', () => {
  withTmp((path) => {
    ks.saveAccount(path, ks.encryptKeystore(KEY_A, 'same', meta(ADDR_A)));
    ks.saveAccount(path, ks.encryptKeystore(KEY_B, 'same', meta(ADDR_B)));
    const back = ks.loadVault(path).accounts;
    assert.notEqual(back[ADDR_A.toLowerCase()]!.salt, back[ADDR_B.toLowerCase()]!.salt);
    assert.equal(ks.decryptKeystore(back[ADDR_A.toLowerCase()]!, 'same'), KEY_A);
    assert.equal(ks.decryptKeystore(back[ADDR_B.toLowerCase()]!, 'same'), KEY_B);
  });
});

test('saving account B does not destroy account A', () => {
  withTmp((path) => {
    ks.saveAccount(path, ks.encryptKeystore(KEY_A, 'pw-a', meta(ADDR_A)));
    const afterA = ks.loadAccount(path, ADDR_A)!;

    ks.saveAccount(path, ks.encryptKeystore(KEY_B, 'pw-b', meta(ADDR_B)));

    const stillA = ks.loadAccount(path, ADDR_A);
    assert.ok(stillA, 'account A was dropped by a sibling save - its key is unrecoverable');
    assert.deepEqual(stillA, afterA, 'account A must be byte-identical after B is written');
    assert.equal(ks.decryptKeystore(stillA!, 'pw-a'), KEY_A);
    assert.equal(ks.listAccounts(path).length, 2);
  });
});

test('re-saving one account rewrites only that record', () => {
  withTmp((path) => {
    ks.saveAccount(path, ks.encryptKeystore(KEY_A, 'pw-a', meta(ADDR_A)));
    ks.saveAccount(path, ks.encryptKeystore(KEY_B, 'pw-b', meta(ADDR_B)));
    const a = ks.loadAccount(path, ADDR_A)!;

    // Rotate B's passphrase.
    ks.saveAccount(path, ks.encryptKeystore(KEY_B, 'pw-b2', meta(ADDR_B)));

    assert.deepEqual(ks.loadAccount(path, ADDR_A), a);
    assert.equal(ks.decryptKeystore(ks.loadAccount(path, ADDR_B)!, 'pw-b2'), KEY_B);
    assert.throws(() => ks.decryptKeystore(ks.loadAccount(path, ADDR_B)!, 'pw-b'), KeystoreError);
  });
});

test('a wrong passphrase for A does not unlock B', () => {
  withTmp((path) => {
    ks.saveAccount(path, ks.encryptKeystore(KEY_A, 'pw-a', meta(ADDR_A)));
    ks.saveAccount(path, ks.encryptKeystore(KEY_B, 'pw-b', meta(ADDR_B)));
    const a = ks.loadAccount(path, ADDR_A)!;
    const b = ks.loadAccount(path, ADDR_B)!;

    // Each record authenticates under its own secret only. Cross-unlocking would
    // mean the salts or the derived keys were shared.
    assert.throws(() => ks.decryptKeystore(b, 'pw-a'), KeystoreError);
    assert.throws(() => ks.decryptKeystore(a, 'pw-b'), KeystoreError);
    // ...and a failed attempt leaves both records usable.
    assert.equal(ks.decryptKeystore(a, 'pw-a'), KEY_A);
    assert.equal(ks.decryptKeystore(b, 'pw-b'), KEY_B);
  });
});

// --- active account + removal ------------------------------------------------

test('the active account is persisted and can be switched', () => {
  withTmp((path) => {
    ks.saveAccount(path, ks.encryptKeystore(KEY_A, 'pw-a', meta(ADDR_A)));
    ks.saveAccount(path, ks.encryptKeystore(KEY_B, 'pw-b', meta(ADDR_B)));
    // Last save wins by default - it is the account the user just enabled.
    assert.equal(ks.load(path)!.meta.address, ADDR_B);

    assert.equal(ks.setActiveAccount(path, ADDR_A), true);
    assert.equal(ks.load(path)!.meta.address, ADDR_A);
    // Case-insensitive: EIP-55 display casing must not fork the identity.
    assert.equal(ks.setActiveAccount(path, ADDR_B.toUpperCase().replace('0X', '0x')), true);
    assert.equal(ks.load(path)!.meta.address, ADDR_B);

    assert.equal(ks.setActiveAccount(path, '0x' + 'f'.repeat(40)), false);
  });
});

test('removing one account keeps the other and re-points active', () => {
  withTmp((path) => {
    ks.saveAccount(path, ks.encryptKeystore(KEY_A, 'pw-a', meta(ADDR_A)));
    ks.saveAccount(path, ks.encryptKeystore(KEY_B, 'pw-b', meta(ADDR_B)));

    assert.equal(ks.removeAccount(path, ADDR_B), true);
    assert.equal(ks.loadAccount(path, ADDR_B), null);
    assert.equal(ks.decryptKeystore(ks.loadAccount(path, ADDR_A)!, 'pw-a'), KEY_A);
    assert.equal(ks.load(path)!.meta.address, ADDR_A, 'active must move to a surviving account');

    // Emptying the vault removes the file, so "no keystore yet" stays one state.
    assert.equal(ks.removeAccount(path, ADDR_A), true);
    assert.equal(existsSync(path), false);
    assert.equal(ks.load(path), null);
    assert.equal(ks.removeAccount(path, ADDR_A), false);
  });
});

// --- in-memory sessions ------------------------------------------------------

const session = (privateKeyHex: string, address: string, apiKeyName: string) => ({
  privateKey: hexToBytes(privateKeyHex),
  apiKeyName,
  accountId: 42,
  address,
  keyAddress: privateKeyToAddress(hexToBytes(privateKeyHex)),
  permissions: 15,
});

test('two sessions are held at once and lock independently', () => {
  const c = new SodexClient('https://test.invalid', 1);
  c.addSession(session(KEY_A, ADDR_A, 'key-a'));
  c.addSession(session(KEY_B, ADDR_B, 'key-b'));

  assert.equal(c.sessionCount, 2);
  assert.equal(c.activeAddress, ADDR_B.toLowerCase(), 'the most recent unlock becomes active');
  assert.equal(c.sessionInfo()!.apiKeyName, 'key-b');
  assert.equal(c.sessionInfo(ADDR_A)!.apiKeyName, 'key-a');
  assert.equal(c.sessionList().filter((s) => s.active).length, 1);

  assert.equal(c.setActiveAddress(ADDR_A), true);
  assert.equal(c.requireSession().apiKeyName, 'key-a');
  assert.equal(c.setActiveAddress('0x' + 'f'.repeat(40)), false);

  // Locking the active account must promote a survivor, not leave the process
  // holding a key it reports as locked.
  assert.equal(c.lockAccount(ADDR_A), true);
  assert.equal(c.sessionCount, 1);
  assert.equal(c.isUnlocked, true);
  assert.equal(c.activeAddress, ADDR_B.toLowerCase());
  assert.equal(c.hasSession(ADDR_A), false);

  c.lockAll();
  assert.equal(c.isUnlocked, false);
  assert.equal(c.activeAddress, null);
  assert.throws(() => c.requireSession(), NotUnlockedError);
});

test('a public session view never carries the private key', () => {
  const c = new SodexClient('https://test.invalid', 1);
  c.addSession(session(KEY_A, ADDR_A, 'key-a'));
  const serialised = JSON.stringify(c.sessionList());
  assert.ok(!serialised.includes(KEY_A.slice(2)), 'private key leaked into the session view');
  assert.equal((c.sessionInfo() as unknown as Record<string, unknown>).privateKey, undefined);
});

// --- nonce ordering across accounts ------------------------------------------

interface Sent {
  nonce: bigint;
  apiKey: string;
}

/** Capture what actually reaches the wire, in wire order. */
function withFetchRecorder(fn: (sent: Sent[]) => Promise<void>): Promise<void> {
  const sent: Sent[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const h = (init.headers ?? {}) as Record<string, string>;
    sent.push({ nonce: BigInt(h['X-API-Nonce']!), apiKey: h['X-API-Key']! });
    return new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 });
  }) as typeof globalThis.fetch;
  return fn(sent).finally(() => {
    globalThis.fetch = real;
  });
}

test('the nonce sequence stays strictly increasing across interleaved accounts', async () => {
  const c = new SodexClient('https://test.invalid', 1);
  c.addSession(session(KEY_A, ADDR_A, 'key-a'));
  c.addSession(session(KEY_B, ADDR_B, 'key-b'));

  await withFetchRecorder(async (sent) => {
    // Concurrent, alternating accounts: the case a per-account counter or a
    // nonce taken before the weight wait would get wrong.
    const order = [ADDR_A, ADDR_B, ADDR_A, ADDR_B, ADDR_B, ADDR_A];
    await Promise.all(
      order.map((address) =>
        c.post('spot', '/accounts/api-keys/revoke', ACTION.revokeAPIKey, revokeAPIKey(42, 'x'), address),
      ),
    );

    assert.equal(sent.length, order.length);
    for (let i = 1; i < sent.length; i++) {
      assert.ok(
        sent[i]!.nonce > sent[i - 1]!.nonce,
        `nonce ${sent[i]!.nonce} followed ${sent[i - 1]!.nonce} - the gateway rejects the lower one as stale`,
      );
    }

    // The per-key requirement is the one the gateway actually enforces, and it
    // follows from the whole sequence increasing only if each key's subsequence
    // is drawn from it in order - assert that directly rather than by inference.
    for (const key of ['key-a', 'key-b']) {
      const mine = sent.filter((s) => s.apiKey === key).map((s) => s.nonce);
      assert.equal(mine.length, 3);
      for (let i = 1; i < mine.length; i++) assert.ok(mine[i]! > mine[i - 1]!);
    }

    // Each write went out under ITS OWN key, not whichever happened to be active.
    assert.equal(sent.filter((s) => s.apiKey === 'key-a').length, 3);
    assert.equal(sent.filter((s) => s.apiKey === 'key-b').length, 3);
  });
});

test('an unqualified signed write uses the active account', async () => {
  const c = new SodexClient('https://test.invalid', 1);
  c.addSession(session(KEY_A, ADDR_A, 'key-a'));
  c.addSession(session(KEY_B, ADDR_B, 'key-b'));
  c.setActiveAddress(ADDR_A);

  await withFetchRecorder(async (sent) => {
    // The 13 pre-existing call sites pass no address; they must keep working.
    await c.post('spot', '/accounts/api-keys/revoke', ACTION.revokeAPIKey, revokeAPIKey(42, 'x'));
    assert.equal(sent[0]!.apiKey, 'key-a');
  });
});

test('signing for a locked account fails before anything is transmitted', async () => {
  const c = new SodexClient('https://test.invalid', 1);
  c.addSession(session(KEY_A, ADDR_A, 'key-a'));

  await withFetchRecorder(async (sent) => {
    await assert.rejects(
      () => c.post('spot', '/accounts/api-keys/revoke', ACTION.revokeAPIKey, revokeAPIKey(42, 'x'), ADDR_B),
      NotUnlockedError,
    );
    // Not "the request failed" but "the request never happened" - a signed write
    // that reached the gateway under the wrong key would be a real order.
    assert.equal(sent.length, 0);
  });
});

test('a record keeps its own signing key end to end', () => {
  // Guards the wiring between keystore and session: the address that keys the
  // vault and the address the session signs for must be the same account.
  withTmp((path) => {
    ks.saveAccount(path, ks.encryptKeystore(KEY_A, 'pw-a', meta(ADDR_A)));
    ks.saveAccount(path, ks.encryptKeystore(KEY_B, 'pw-b', meta(ADDR_B)));

    const c = new SodexClient('https://test.invalid', 1);
    for (const rec of ks.listAccounts(path) as KeystoreRecord[]) {
      const pw = rec.meta.address === ADDR_A ? 'pw-a' : 'pw-b';
      const pk = ks.decryptKeystore(rec, pw);
      c.addSession({
        privateKey: hexToBytes(pk),
        apiKeyName: rec.meta.apiKeyName,
        accountId: rec.meta.accountId,
        address: rec.meta.address,
        keyAddress: rec.meta.keyAddress,
        permissions: rec.meta.permissions,
      });
    }
    assert.equal(c.sessionCount, 2);
    assert.equal(c.requireSession(ADDR_A).apiKeyName, meta(ADDR_A).apiKeyName);
    assert.equal(c.requireSession(ADDR_B).apiKeyName, meta(ADDR_B).apiKeyName);
    assert.notDeepEqual(c.requireSession(ADDR_A).privateKey, c.requireSession(ADDR_B).privateKey);
  });
});
