/**
 * Signed terms: the exact bytes, the key and the signature
 * (docs/BUILDER-TIERS.md §3). The fixed vectors in builderTerms.vector.json
 * are what the app's verification is tested against too: a private TEST key,
 * the message, the signature. They are checked here with two implementations
 * that are not the one that signs: @noble/curves and WebCrypto, which is what
 * the browser uses.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { platform } from 'node:os';
import { ed25519 } from '@noble/curves/ed25519';

import { KeySource, NONCE_RE, TERMS_TTL_MS, TERMS_VERSION, TermsSigner, signerFromPem, signerFromSeed, termsMessage, writeNewKeyFile, type TermsFields } from '../src/builder/terms.js';
import { MemoryLog, tempDir } from './builderFakes.js';

const DIR = tempDir('vs-btiers-terms-');

interface Vector {
  fields: TermsFields;
  message: string;
  sig: string;
}
const V = JSON.parse(readFileSync(new URL('./builderTerms.vector.json', import.meta.url), 'utf8')) as {
  seedHex: string;
  publicKey: string;
  keyId: string;
  vectors: Vector[];
};
const SEED = Buffer.from(V.seedHex, 'hex');
const FIELDS: TermsFields = V.vectors[0]!.fields;

/** Verify the way the app does: WebCrypto, raw public key, the UTF-8 bytes of the message. */
async function webVerify(publicKey: string, message: string, sig: string): Promise<boolean> {
  const key = await crypto.subtle.importKey('raw', Buffer.from(publicKey, 'base64url'), { name: 'Ed25519' }, false, ['verify']);
  return crypto.subtle.verify('Ed25519', key, Buffer.from(sig, 'base64url'), new TextEncoder().encode(message));
}

test('terms: the message is nine lines, joined by a newline, with no trailing one', () => {
  const msg = termsMessage(FIELDS);
  assert.equal(
    msg,
    [
      'valuescan-builder-terms/1',
      'chain:286623',
      'builder:123456',
      'address:0xabababababababababababababababababababab',
      'perps:15',
      'spot:20',
      'nonce:AAAAAAAAAAAAAAAAAAAAAA',
      'issued:1790000000000',
      'ttl:600000',
    ].join('\n'),
  );
  assert.equal(TERMS_VERSION, 'valuescan-builder-terms/1');
  assert.equal(TERMS_TTL_MS, 600_000);
  assert.ok(!msg.endsWith('\n'));
  assert.equal(msg.split('\n').length, 9);
});

test('terms: the fixed vectors - message, signature, public key, key id', async () => {
  const signer = signerFromSeed(SEED);
  assert.equal(signer.publicKey, V.publicKey);
  assert.equal(signer.keyId, V.keyId);
  assert.match(signer.keyId, /^[0-9a-f]{8}$/);
  // The public key of this seed, from an independent implementation.
  assert.equal(Buffer.from(ed25519.getPublicKey(SEED)).toString('base64url'), V.publicKey);
  assert.equal(V.vectors.length, 3);
  for (const v of V.vectors) {
    assert.equal(termsMessage(v.fields), v.message);
    const sig = signer.sign(v.message);
    assert.equal(sig, v.sig, 'Ed25519 is deterministic: the same key and message give the same signature');
    assert.equal(Buffer.from(sig, 'base64url').length, 64);
    assert.ok(!/[+/=]/.test(sig), 'base64url, no padding');
    assert.equal(ed25519.verify(Buffer.from(sig, 'base64url'), Buffer.from(v.message, 'utf8'), Buffer.from(V.publicKey, 'base64url')), true);
    assert.equal(await webVerify(V.publicKey, v.message, sig), true, 'the browser\'s way verifies it');
  }
});

test('terms: any changed value is another message - the signature no longer verifies', async () => {
  const sig = V.vectors[0]!.sig;
  const changes: Array<Partial<TermsFields>> = [
    { perps: 14 }, { spot: 19 }, { perps: 0 }, { address: '0x' + 'ac'.repeat(20) }, { nonce: 'AAAAAAAAAAAAAAAAAAAAAB' },
    { builderId: 123457 }, { chain: 138565 }, { issued: FIELDS.issued + 1 }, { ttl: FIELDS.ttl + 1 },
  ];
  for (const c of changes) {
    const msg = termsMessage({ ...FIELDS, ...c });
    assert.equal(await webVerify(V.publicKey, msg, sig), false, JSON.stringify(c));
  }
  // Another key does not verify it either.
  const other = signerFromSeed(Buffer.alloc(32, 7));
  assert.notEqual(other.keyId, V.keyId);
  assert.equal(await webVerify(other.publicKey, V.vectors[0]!.message, sig), false);
});

test('terms: nothing but checked values gets into the message', () => {
  const bad: Array<Partial<TermsFields>> = [
    { address: '0x' + 'AB'.repeat(20) }, // must be lower case: one spelling per wallet
    { address: '0x' + 'ab'.repeat(19) },
    { address: `0x${'ab'.repeat(20)}\nperps:0` },
    { nonce: 'short' },
    { nonce: 'A'.repeat(65) },
    { nonce: 'AAAAAAAAAAAAAAAA\nperps:0' },
    { nonce: 'AAAAAAAAAAAAAAAA:perps' },
    { nonce: 'AAAAAAAA AAAAAAAA' },
    { nonce: 'AAAAAAAAAAAAAAAA\r' },
    { perps: 15.5 }, { perps: -1 }, { perps: 201 }, { spot: 2001 }, { spot: Number.NaN },
    { issued: -1 }, { issued: 1.5 }, { ttl: Number.POSITIVE_INFINITY }, { chain: 1e30 }, { builderId: -3 },
  ];
  for (const c of bad) assert.throws(() => termsMessage({ ...FIELDS, ...c }), RangeError, JSON.stringify(c));
  // The nonce rule: 16 to 64 of the URL-safe alphabet, anchored.
  for (const ok of ['A'.repeat(16), 'a_b-'.repeat(16), '0123456789abcdefABCDEF_-']) assert.ok(NONCE_RE.test(ok), ok);
  for (const no of ['A'.repeat(15), 'A'.repeat(65), 'AAAAAAAAAAAAAAA\n', ' AAAAAAAAAAAAAAAA', 'AAAAAAAAAAAAAAA+', 'AAAAAAAAAAAAAAA/', 'AAAAAAAAAAAAAAA=']) assert.ok(!NONCE_RE.test(no), JSON.stringify(no));
});

test('key: a signer shows its public half and nothing else', () => {
  const signer = signerFromSeed(SEED);
  assert.deepEqual(Object.keys(signer).sort(), ['keyId', 'publicKey']);
  const dumped = JSON.stringify(signer) + String(signer) + JSON.stringify(Object.entries(signer));
  assert.ok(!dumped.includes(V.seedHex));
  assert.ok(!/PRIVATE KEY/.test(dumped));
  // Only Ed25519 private keys are taken.
  assert.throws(() => new TermsSigner(generateKeyPairSync('ed25519').publicKey), /Ed25519 private key/);
  assert.throws(() => new TermsSigner(generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey), /Ed25519 private key/);
  assert.throws(() => signerFromSeed(Buffer.alloc(31)), RangeError);
});

test('key file: created once, as a PKCS#8 PEM only its owner can read, and never replaced', () => {
  const path = join(DIR, 'new', 'builder-terms.key');
  const signer = writeNewKeyFile(path);
  const pem = readFileSync(path, 'utf8');
  assert.match(pem, /^-----BEGIN PRIVATE KEY-----\n[A-Za-z0-9+/=\n]+-----END PRIVATE KEY-----\n$/);
  const again = signerFromPem(pem);
  assert.equal(again.publicKey, signer.publicKey);
  assert.equal(again.keyId, signer.keyId);
  assert.equal(Buffer.from(signer.publicKey, 'base64url').length, 32);
  // Owner only, where the platform has file modes (Windows has none: the data directory is the user's own).
  if (platform() !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600);
  // A second call must not replace the key a build has pinned.
  assert.throws(() => writeNewKeyFile(path), /EEXIST/);
  assert.equal(readFileSync(path, 'utf8'), pem);
  // Two keys are never the same.
  assert.notEqual(writeNewKeyFile(join(DIR, 'new', 'other.key')).publicKey, signer.publicKey);
});

let stamp = Date.now();
function write(path: string, body: string): void {
  writeFileSync(path, body);
  stamp += 2_000;
  utimesSync(path, stamp / 1000, stamp / 1000);
}

test('key source: no file = unsigned terms; a damaged file is not used and its text is never logged', async () => {
  const path = join(DIR, 'src.key');
  const log = new MemoryLog();
  const src = new KeySource(path, log);
  src.loadSync();
  assert.equal(src.current(), null);
  assert.deepEqual(src.status(), { path, exists: false, problem: null, publicKey: null, keyId: null });

  // Well-formed base64, but not a key.
  const secretLooking = 'c2VjcmV0LWxvb2tpbmctdGV4dC10aGF0LWlzLW5vdC1hLWtleQ==';
  write(path, `-----BEGIN PRIVATE KEY-----\n${secretLooking}\n-----END PRIVATE KEY-----\n`);
  await src.refresh();
  assert.equal(src.current(), null);
  assert.equal(src.status().exists, true);
  assert.ok(src.status().problem);
  assert.ok(log.lines.some((l) => l.level === 'error' && /not a usable Ed25519/.test(l.msg)));
  assert.ok(!log.text().includes(secretLooking), 'the file\'s text is not in the log');
  assert.ok(!JSON.stringify(src.status()).includes(secretLooking));

  // A key of another kind is refused too.
  write(path, generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string);
  await src.refresh();
  assert.equal(src.current(), null);
  assert.match(src.status().problem!, /Ed25519/);
});

test('key source: the key the tool creates is picked up without a restart, and a removed one stops the signing', async () => {
  const path = join(DIR, 'live.key');
  const log = new MemoryLog();
  const src = new KeySource(path, log);
  src.loadSync();
  assert.equal(src.current(), null);
  const made = writeNewKeyFile(path);
  await src.refresh();
  assert.equal(src.current()!.publicKey, made.publicKey);
  assert.deepEqual(src.status(), { path, exists: true, problem: null, publicKey: made.publicKey, keyId: made.keyId });
  const pem = readFileSync(path, 'utf8');
  const body = pem.split('\n')[1]!;
  assert.ok(!log.text().includes(body), 'loading a key logs its public half only');
  assert.ok(log.text().includes(made.publicKey));

  const { rmSync } = await import('node:fs');
  rmSync(path);
  await src.refresh();
  assert.equal(src.current(), null);
  assert.ok(log.lines.some((l) => l.level === 'warn' && /is gone/.test(l.msg)));
});
