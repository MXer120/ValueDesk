/**
 * The user lock: a password derives a key that opens its check and nothing
 * else, a wrong one is refused slowly, the unlocked key is dropped after the
 * idle auto-lock, money moves ask again, and a passkey's PRF output becomes
 * the key by HKDF exactly as specified (WebAuthn itself cannot run in Node).
 *   ../../node_modules/.bin/tsx --test src/trading/keyLock.test.ts
 */
import { test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { hkdfSync } from 'node:crypto';
import {
  KeyLockCancelled,
  PBKDF2_ITERATIONS,
  _resetKeyLockForTests,
  confirmMoneyMove,
  currentUnlockRequest,
  deriveKeyFromPrf,
  derivePasswordKey,
  keyLockState,
  lockConfig,
  lockNow,
  makeCheck,
  removeLock,
  requestUnlock,
  setAskOnMoney,
  setAutoLockMinutes,
  setLockResealer,
  setPasswordLock,
  touch,
  userKeyFor,
  verifyCheck,
  type UnlockRequest,
} from './keyLock';

const OWNER = '0x00000000000000000000000000000000000000aa';
const PW = 'correct horse battery';

/** The dialog's request, once it is queued. */
async function nextRequest(): Promise<UnlockRequest> {
  for (let i = 0; i < 200; i++) {
    const r = currentUnlockRequest();
    if (r) return r;
    await new Promise((res) => setImmediate(res));
  }
  throw new Error('no unlock request was opened');
}

beforeEach(() => {
  setLockResealer(null);
  _resetKeyLockForTests({ failDelayMs: 0 });
});

test('password -> a non-extractable AES-GCM key; the right password opens the check, a wrong one does not', async () => {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const k = await derivePasswordKey(PW, salt, 1000);
  assert.equal(k.extractable, false);
  assert.equal((k.algorithm as AesKeyAlgorithm).name, 'AES-GCM');
  assert.equal((k.algorithm as AesKeyAlgorithm).length, 256);
  await assert.rejects(crypto.subtle.exportKey('raw', k));
  const check = await makeCheck(k, OWNER);
  assert.equal(await verifyCheck(await derivePasswordKey(PW, salt, 1000), OWNER, check), true);
  assert.equal(await verifyCheck(await derivePasswordKey('wrong password', salt, 1000), OWNER, check), false);
  assert.equal(await verifyCheck(await derivePasswordKey(PW, crypto.getRandomValues(new Uint8Array(16)), 1000), OWNER, check), false, 'another salt');
  assert.equal(await verifyCheck(k, '0x00000000000000000000000000000000000000bb', check), false, 'another wallet');
});

test('setting a password lock: 600k iterations, a 16-byte salt, nothing secret stored, unlocked at once', async () => {
  await setPasswordLock(OWNER, PW);
  const cfg = lockConfig(OWNER)!;
  assert.equal(cfg.kind, 'password');
  assert.ok(cfg.kind === 'password' && cfg.iterations === PBKDF2_ITERATIONS && PBKDF2_ITERATIONS === 600_000);
  assert.ok(cfg.kind === 'password' && Buffer.from(cfg.salt, 'base64url').length === 16);
  assert.ok(!JSON.stringify(cfg).includes(PW), 'the password is never stored');
  assert.deepEqual(Object.keys(cfg).sort(), ['check', 'iterations', 'kind', 'salt']);
  assert.deepEqual(keyLockState(OWNER), { kind: 'password', unlocked: true, autoLockMinutes: 30, askOnMoney: true });
  assert.ok(userKeyFor(OWNER));
  await assert.rejects(setPasswordLock('0x00000000000000000000000000000000000000cc', 'short'), /at least 8/);
});

test('unlock: a wrong password is refused after the delay, the right one unlocks; cancel resolves false', async () => {
  await setPasswordLock(OWNER, PW);
  lockNow(OWNER);
  assert.equal(keyLockState(OWNER).unlocked, false);
  assert.equal(userKeyFor(OWNER), null);

  _resetKeyLockForTests({ failDelayMs: 1_000 });
  await setPasswordLock(OWNER, PW);
  lockNow(OWNER);
  const p = requestUnlock(OWNER, 'Unlock trading');
  const r = await nextRequest();
  assert.equal(r.reason, 'Unlock trading');
  assert.equal(r.kind, 'password');
  assert.equal(r.purpose, 'unlock');
  // A second ask while the first is open is the same dialog.
  const again = requestUnlock(OWNER, 'Unlock trading');
  assert.equal(currentUnlockRequest()?.id, r.id);
  const t0 = Date.now();
  assert.equal(await r.submitPassword('not the password'), 'Wrong password.');
  assert.ok(Date.now() - t0 >= 990, 'a wrong password waits a second');
  assert.equal(keyLockState(OWNER).unlocked, false);
  assert.equal(await r.submitPassword(PW), null);
  assert.equal(await p, true);
  assert.equal(await again, true);
  assert.equal(keyLockState(OWNER).unlocked, true);
  assert.equal(currentUnlockRequest(), null, 'the dialog closes');

  lockNow(OWNER);
  const q = requestUnlock(OWNER);
  (await nextRequest()).cancel();
  assert.equal(await q, false);
  assert.equal(await requestUnlock(null), false);
  assert.equal(await requestUnlock('0x00000000000000000000000000000000000000dd'), true, 'no lock: nothing to unlock');
});

test('auto-lock: the key is dropped after the idle time; activity starts it over; 0 = never', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    setAutoLockMinutes(5);
    await setPasswordLock(OWNER, PW);
    assert.equal(keyLockState(OWNER).autoLockMinutes, 5);
    mock.timers.tick(4 * 60_000);
    assert.equal(keyLockState(OWNER).unlocked, true);
    touch(OWNER); // a signature
    mock.timers.tick(4 * 60_000);
    assert.equal(keyLockState(OWNER).unlocked, true, 'activity restarted the idle time');
    mock.timers.tick(61_000);
    assert.equal(keyLockState(OWNER).unlocked, false, 'locked after 5 idle minutes');
    assert.equal(userKeyFor(OWNER), null);
  } finally {
    mock.timers.reset();
  }
});

test('auto-lock 0 keeps the key until the tab closes; changing the minutes re-arms an unlocked key', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    setAutoLockMinutes(0);
    await setPasswordLock(OWNER, PW);
    mock.timers.tick(24 * 3_600_000);
    assert.equal(keyLockState(OWNER).unlocked, true);
    setAutoLockMinutes(1);
    mock.timers.tick(61_000);
    assert.equal(keyLockState(OWNER).unlocked, false);
  } finally {
    mock.timers.reset();
  }
});

test('askOnMoney: no lock = yes at once; with a lock asked again even while unlocked; off = only an unlock', async () => {
  assert.equal(await confirmMoneyMove(OWNER, 'Withdraw 100 USDC'), true);
  assert.equal(currentUnlockRequest(), null, 'nothing asked without a lock');

  await setPasswordLock(OWNER, PW);
  assert.equal(keyLockState(OWNER).unlocked, true);
  let p = confirmMoneyMove(OWNER, 'Withdraw 100 USDC');
  let r = await nextRequest();
  assert.equal(r.purpose, 'confirm');
  assert.equal(r.reason, 'Confirm withdrawal of 100 USDC');
  r.cancel();
  assert.equal(await p, false, 'cancel = nothing happens');

  p = confirmMoneyMove(OWNER, 'Transfer 5 USDC');
  r = await nextRequest();
  assert.equal(r.reason, 'Confirm transfer of 5 USDC');
  assert.equal(await r.submitPassword(PW), null);
  assert.equal(await p, true);

  setAskOnMoney(false);
  assert.equal(keyLockState(OWNER).askOnMoney, false);
  assert.equal(await confirmMoneyMove(OWNER, 'Withdraw 1 USDC'), true, 'unlocked and not asked');
  lockNow(OWNER);
  p = confirmMoneyMove(OWNER, 'Withdraw 1 USDC');
  r = await nextRequest();
  assert.equal(r.purpose, 'unlock', 'locked: only the unlock');
  assert.equal(await r.submitPassword(PW), null);
  assert.equal(await p, true);
  assert.equal(keyLockState('0x00000000000000000000000000000000000000ee').askOnMoney, false, 'never true without a lock');
});

test('changing or removing a lock asks for the current one first, and re-seals through the session', async () => {
  const resealed: Array<[string, boolean, boolean]> = [];
  setLockResealer(async (owner, from, to) => {
    resealed.push([owner, !!from, !!to]);
  });
  await setPasswordLock(OWNER, PW);
  assert.deepEqual(resealed, [[OWNER, false, true]], 'unlocked -> locked');

  const change = setPasswordLock(OWNER, 'another long password');
  let r = await nextRequest();
  assert.equal(r.purpose, 'confirm');
  assert.equal(await r.submitPassword('another long password'), 'Wrong password.', 'the NEW password does not prove the old lock');
  assert.equal(await r.submitPassword(PW), null);
  await change;
  assert.deepEqual(resealed[1], [OWNER, true, true]);
  lockNow(OWNER);
  let u = requestUnlock(OWNER);
  r = await nextRequest();
  assert.equal(await r.submitPassword(PW), 'Wrong password.', 'the old password is gone');
  assert.equal(await r.submitPassword('another long password'), null);
  assert.equal(await u, true);

  const cancelled = removeLock(OWNER);
  (await nextRequest()).cancel();
  await assert.rejects(cancelled, KeyLockCancelled);
  assert.equal(keyLockState(OWNER).kind, 'password', 'still locked');

  const removed = removeLock(OWNER);
  r = await nextRequest();
  assert.equal(await r.submitPassword('another long password'), null);
  await removed;
  assert.deepEqual(resealed[2], [OWNER, true, false], 'locked -> unlocked');
  assert.equal(keyLockState(OWNER).kind, 'none');
  assert.equal(userKeyFor(OWNER), null);
  u = requestUnlock(OWNER);
  assert.equal(await u, true);
});

test('a failing re-seal leaves the old lock in place', async () => {
  setLockResealer(async () => {
    throw new Error('vault busy');
  });
  await assert.rejects(setPasswordLock(OWNER, PW), /vault busy/);
  assert.equal(keyLockState(OWNER).kind, 'none');
});

test('passkey: the PRF output becomes the AES key by HKDF-SHA256, info "vd-key-lock-v1" (known answer)', async () => {
  const prf = new Uint8Array(32).map((_, i) => i * 7 + 1);
  const k1 = await deriveKeyFromPrf(prf.slice());
  const k2 = await deriveKeyFromPrf(prf.slice().buffer);
  assert.equal(k1.extractable, false);
  const check = await makeCheck(k1, OWNER);
  assert.equal(await verifyCheck(k2, OWNER, check), true, 'the same PRF output, the same key');
  const other = prf.slice();
  other[0] = other[0]! ^ 1;
  assert.equal(await verifyCheck(await deriveKeyFromPrf(other), OWNER, check), false, 'another passkey');

  // Against Node's own HKDF: the same 32 bytes encrypt the same way.
  const raw = new Uint8Array(hkdfSync('sha256', prf, new Uint8Array(0), 'vd-key-lock-v1', 32));
  const ref = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
  const iv = new Uint8Array(12);
  const msg = new TextEncoder().encode('known answer');
  const a = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k1, msg));
  const b = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, ref, msg));
  assert.deepEqual(a, b);
});
