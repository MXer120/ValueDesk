import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isAddress, privateKeyToAddress, toChecksumAddress } from '../src/eip712.ts';
import {
  DAY_MS,
  DEFAULT_TRADING_KEY_TTL_MS,
  apiKeyNameProblem,
  destroyTradingKey,
  expiryFromNow,
  expiryProblem,
  generateApiKeyName,
  generateTradingKey,
  isKeyExpired,
  secondsUntilExpiry,
  tradingKeyFromHex,
} from '../src/keys.ts';

test('generateTradingKey: random, valid, address derived, privateKey hidden from JSON/spread', () => {
  const a = generateTradingKey();
  const b = generateTradingKey();
  assert.notEqual(a.address, b.address);
  assert.ok(isAddress(a.address));
  assert.equal(a.address, a.address.toLowerCase());
  assert.equal(privateKeyToAddress(a.privateKey), a.address);
  assert.equal(a.privateKey.length, 32);
  assert.equal(JSON.stringify(a), JSON.stringify({ address: a.address }));
  assert.equal('privateKey' in { ...a }, false);
  assert.equal(Object.keys(a).includes('privateKey'), false);
  assert.ok(Object.isFrozen(a));
});

test('generateTradingKey retries an invalid scalar and uses the injected RNG', () => {
  let calls = 0;
  const rng = (n: number) => {
    calls++;
    return calls === 1 ? new Uint8Array(n) /* zero = invalid */ : new Uint8Array(n).fill(7);
  };
  const k = generateTradingKey(rng);
  assert.equal(calls, 2);
  assert.deepEqual([...k.privateKey], new Array(32).fill(7));
});

test('destroyTradingKey zeroes the bytes', () => {
  const k = generateTradingKey();
  destroyTradingKey(k);
  assert.ok(k.privateKey.every((x) => x === 0));
});

test('tradingKeyFromHex never echoes the secret in errors', () => {
  const secret = 'zz' + 'ab'.repeat(31);
  try {
    tradingKeyFromHex(secret);
    assert.fail('should throw');
  } catch (e) {
    assert.ok(!(e as Error).message.includes('abab'), (e as Error).message);
  }
  assert.throws(() => tradingKeyFromHex('0x' + '00'.repeat(32)), /not a valid secp256k1 scalar/);
});

test('API key names: documented regex, "default" reserved, generator output valid', () => {
  assert.equal(apiKeyNameProblem('vs-1_A'), null);
  assert.match(apiKeyNameProblem('default')!, /reserved/);
  assert.ok(apiKeyNameProblem('x'.repeat(37)));
  assert.ok(apiKeyNameProblem('has.dot'));
  const n = generateApiKeyName('vs', 1_760_000_000_000);
  assert.equal(apiKeyNameProblem(n), null);
  assert.match(n, /^vs-[0-9a-z]+-[0-9a-z]{4}$/);
});

test('expiry is MILLISECONDS end to end', () => {
  const now = 1_760_000_000_000;
  assert.equal(expiryFromNow(undefined, now), now + DEFAULT_TRADING_KEY_TTL_MS);
  assert.equal(DEFAULT_TRADING_KEY_TTL_MS, DAY_MS);
  assert.equal(isKeyExpired(now - 1, now), true);
  assert.equal(isKeyExpired(now + 1, now), false);
  assert.equal(isKeyExpired(0, now), false, '0 = never');
  // Opentrade's browser signer: seconds-vs-ms meant a live key read as never expiring.
  assert.equal(isKeyExpired(Math.floor(now / 1000) + 60, now), true, 'a SECONDS value is long past in ms');
  assert.equal(secondsUntilExpiry(now + 90_500, now), 90);
  assert.equal(secondsUntilExpiry(0, now), null);
});

test('expiryProblem enforces the short-lived policy', () => {
  const now = 1_760_000_000_000;
  assert.equal(expiryProblem(now + DAY_MS, { now }), null);
  assert.match(expiryProblem(0, { now })!, /never/);
  assert.equal(expiryProblem(0, { now, allowNeverExpires: true }), null);
  assert.match(expiryProblem(1_800_000_000, { now })!, /SECONDS/);
  assert.match(expiryProblem(now - 1, { now })!, /past/);
  assert.match(expiryProblem(now + 60_000, { now })!, /5 minutes/);
  assert.match(expiryProblem(now + 8 * DAY_MS, { now })!, /7 days/);
});

test('toChecksumAddress (EIP-55 reference vector)', () => {
  assert.equal(
    toChecksumAddress('0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed'),
    '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
  );
});
