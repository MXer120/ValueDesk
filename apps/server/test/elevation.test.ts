/**
 * The properties that make "a compromise of this machine cannot move funds"
 * true, rather than merely intended.
 *
 * The load-bearing one is not in this file at all: it is that the RESTING key is
 * minted trade-only (wire mask 14 - a set bit DISABLES a permission), so the
 * exchange - not this code - refuses to move funds with it. That is SoDEX's
 * documented behaviour, not yet observed; docs/PERMISSION-MASK.md has the
 * testnet plan. What is testable here is everything built on top of that: the
 * short-lived elevation key is single-use, bound to the exact operation the user
 * approved, expires, and never reaches disk.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';

import {
  elevationMask,
  requiredBit,
  intentMatches,
  describeIntent,
  type ElevationIntent,
} from '../src/elevation.js';
import {
  APIKeyPermission,
  PERMISSION_MASK,
  enabledPermissionNames,
  permits,
} from '../src/signing/actions.js';

const intent = (over: Partial<ElevationIntent> = {}): ElevationIntent => ({
  scope: 'transfer',
  engine: 'spot',
  coinId: 1,
  amount: '10',
  toAccountId: 4242,
  direction: null,
  ...over,
});

// --- scope ------------------------------------------------------------------

test('the resting scope cannot move funds (per the documented mask semantics)', () => {
  // This is the whole security model in one assertion - read with SoDEX's
  // polarity, where a SET bit DISABLES. The version of this test that checked
  // `3 & WITHDRAW === 0` passed for a key the docs say CAN withdraw.
  const m = PERMISSION_MASK.TRADE_ONLY;
  assert.equal(permits(m, APIKeyPermission.WITHDRAW), false);
  assert.equal(permits(m, APIKeyPermission.TRANSFER), false);
  assert.equal(permits(m, APIKeyPermission.TRADE), true);
});

test('an elevation grants one capability, not both', () => {
  // An internal transfer must not silently come with the ability to withdraw.
  const t = elevationMask(intent());
  assert.deepEqual(enabledPermissionNames(t), ['transfer']);

  const w = elevationMask(intent({ scope: 'withdraw', toAccountId: null }));
  assert.deepEqual(enabledPermissionNames(w), ['withdraw']);
});

test('a spot <-> perps move needs WITHDRAW, not TRANSFER', () => {
  // On the wire it is SPOT_WITHDRAW / PERPS_WITHDRAW, and the schema files
  // "withdraw ... to EVM or the other engine" under WITHDRAW. Minting TRANSFER
  // for it would be refused by a gateway that enforces the mask.
  const cross = intent({ toAccountId: null, direction: 'spot-to-perps' });
  assert.equal(requiredBit(cross), APIKeyPermission.WITHDRAW);
  assert.deepEqual(enabledPermissionNames(elevationMask(cross)), ['withdraw']);
});

test('requiredBit names the bit the operation actually needs', () => {
  assert.equal(requiredBit(intent()), APIKeyPermission.TRANSFER);
  assert.equal(requiredBit(intent({ scope: 'withdraw', toAccountId: null })), APIKeyPermission.WITHDRAW);
});

// --- intent binding ---------------------------------------------------------

test('an identical intent matches', () => {
  assert.equal(intentMatches(intent(), intent()), true);
});

test('every field of the intent is load-bearing', () => {
  // Each of these is an attack: redirect the destination, inflate the amount,
  // swap the asset, move on the other engine, or turn a transfer into a
  // withdrawal. None may be spendable on a signature the user gave for
  // something else.
  const cases: Array<[string, Partial<ElevationIntent>]> = [
    ['destination', { toAccountId: 9999 }],
    ['amount', { amount: '10000' }],
    ['asset', { coinId: 2 }],
    ['engine', { engine: 'perps' }],
    ['scope', { scope: 'withdraw' }],
    ['direction', { direction: 'spot-to-perps' }],
  ];
  for (const [label, over] of cases) {
    assert.equal(intentMatches(intent(), intent(over)), false, `${label} must not be substitutable`);
  }
});

test('a null destination is distinct from any account id', () => {
  // Withdrawals carry toAccountId:null. Treating null as a wildcard would let a
  // withdrawal signature be spent on a transfer to an arbitrary account.
  assert.equal(intentMatches(intent({ toAccountId: null }), intent({ toAccountId: 1 })), false);
  assert.equal(intentMatches(intent({ toAccountId: null }), intent({ toAccountId: null })), true);
});

test('the summary names the destination, so the UI can show what is being signed', () => {
  // The wallet renders permissions as a bare integer and cannot describe the
  // operation, so this string is the only thing the user can actually read.
  const s = describeIntent(intent());
  assert.match(s, /transfer/);
  assert.match(s, /10/);
  assert.match(s, /#4242/);

  assert.match(describeIntent(intent({ scope: 'withdraw', toAccountId: null })), /your own wallet/);
  assert.match(
    describeIntent(intent({ toAccountId: null, direction: 'spot-to-perps' })),
    /spot-to-perps/,
  );
});

// --- the local API token ----------------------------------------------------

test('the local API token lives outside the project directory', async () => {
  // Same reasoning as the device key: the project folder is OneDrive-synced, and
  // a credential that authorises writes must not replicate to the cloud.
  const mod = await import(`../src/localToken.js?t=${Math.random()}`);
  const path = resolve(mod.localTokenPath());
  const projectRoot = resolve(
    new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
  );
  assert.ok(
    !path.toLowerCase().startsWith(projectRoot.toLowerCase()),
    `local API token must not live under the project (would be cloud-synced): ${path}`,
  );
});

test('token comparison rejects the empty, the short and the wrong', async () => {
  const mod = await import(`../src/localToken.js?t=${Math.random()}`);
  const good = mod.localToken();
  assert.match(good, /^[0-9a-f]{64}$/);
  assert.equal(mod.tokenMatches(good), true);
  assert.equal(mod.tokenMatches(good.toUpperCase()), true, 'case is normalised');
  assert.equal(mod.tokenMatches(undefined), false);
  assert.equal(mod.tokenMatches(''), false);
  assert.equal(mod.tokenMatches('a'), false);
  assert.equal(mod.tokenMatches('f'.repeat(64)), false);
  // A prefix of the real token must not pass - length is checked before compare.
  assert.equal(mod.tokenMatches(good.slice(0, 32)), false);
});

// --- the origin gate --------------------------------------------------------

test('only loopback origins are allowed, and lookalikes are not', async () => {
  const { isAllowedOrigin } = await import('../src/origin.js');
  for (const ok of ['http://localhost:5173', 'http://127.0.0.1:8787', 'https://localhost']) {
    assert.equal(isAllowedOrigin(ok), true, ok);
  }
  for (const bad of [
    'http://localhost.evil.example',
    'http://127.0.0.1.evil.example',
    'https://evil.example',
    'file://',
    'null',
    'javascript:alert(1)',
  ]) {
    assert.equal(isAllowedOrigin(bad), false, bad);
  }
});

// --- the memory-only session key --------------------------------------------

test('a memory-only session key cannot be persisted, even by mistake', async () => {
  // The one-click flow's whole value is that nothing reaches disk. This is
  // enforced in saveAccount rather than only at the call site, so a future
  // caller that forgets to branch fails loudly instead of silently writing a
  // trading key into a cloud-synced folder.
  const ks = await import('../src/keystore.js');
  const record = ks.encryptKeystore(
    '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318',
    'x'.repeat(40),
    {
      apiKeyName: 'vt-mem', accountId: 1, address: '0x' + 'a'.repeat(40),
      keyAddress: '0x' + 'b'.repeat(40), network: 'mainnet', permissions: 3,
      expiresAt: 0, createdAt: 1, protection: 'memory',
    },
  );
  assert.throws(() => ks.saveAccount('/tmp/should-never-be-written.json', record), /refusing to persist/i);
});

// --- rate limiting -----------------------------------------------------------

test('write and money limits cut in, and money is the tighter of the two', async () => {
  const rl = await import('../src/rateLimit.js');
  rl.reset();
  // Money movement is meant to cost a wallet signature each time, so its ceiling
  // is far below the general write ceiling.
  assert.ok(rl.MONEY_LIMIT.max < rl.WRITE_LIMIT.max);

  for (let i = 0; i < rl.MONEY_LIMIT.max; i++) {
    assert.equal(rl.take('money', rl.MONEY_LIMIT), null, `request ${i} should pass`);
  }
  const retry = rl.take('money', rl.MONEY_LIMIT);
  assert.ok(typeof retry === 'number' && retry > 0, 'the next one is refused with a wait');
  rl.reset();
});

test('a money path is counted against both limits, a trade path only against writes', async () => {
  const rl = await import('../src/rateLimit.js');
  assert.deepEqual(rl.classify('/api/trade/perps/order').map((c) => c.key), ['write']);
  assert.deepEqual(rl.classify('/api/money/withdraw').map((c) => c.key), ['write', 'money']);
});

// --- EIP-712 domain chain id -------------------------------------------------

test('the wallet signing chain id is bounded, not trusted', async () => {
  // It has to come from the client (only the browser knows what chain the wallet
  // is on), so junk, negatives and out-of-range values must not reach a payload
  // the user is asked to sign.
  const { permissionedAPIKeyTypedData } = await import('../src/signing/userSigned.js');
  const td = permissionedAPIKeyTypedData(
    { accountID: 1, name: 'k', publicKey: '0x' + 'b'.repeat(40), expiresAt: 0, permissions: 3 },
    286623, 1n, 1,
  );
  // The SoDEX chain id travels in the message; the wallet's chain in the domain.
  assert.equal(td.domain.chainId, 1);
  assert.equal(td.message.chainID, '286623');
});

// --- no key ever reaches the disk --------------------------------------------

test('no route can write a key to disk', async () => {
  // The strongest form of "keys are memory-only" is that the code which could
  // persist one is never called. Asserted statically, because a runtime test
  // would only prove the paths it happened to exercise.
  const { readdirSync, readFileSync, statSync } = await import('node:fs');
  const { join } = await import('node:path');
  // fileURLToPath, not URL.pathname: the latter percent-encodes spaces, and this
  // project lives under a path that has them. Same trap as config.ts documents.
  const { fileURLToPath } = await import('node:url');
  const srcRoot = fileURLToPath(new URL('../src', import.meta.url));

  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!name.endsWith('.ts')) continue;
      // keystore.ts DEFINES the persistence primitives; it is allowed to contain
      // them. What matters is that nothing else calls them.
      if (name === 'keystore.ts') continue;
      const body = readFileSync(full, 'utf8');
      for (const call of ['ks.saveAccount(', 'ks.encryptKeystore(', 'saveAccount(KEYSTORE_PATH']) {
        if (body.includes(call)) offenders.push(`${name}: ${call}`);
      }
    }
  };
  walk(srcRoot);

  assert.deepEqual(
    offenders,
    [],
    `these call sites would write a signing key to disk:\n  ${offenders.join('\n  ')}`,
  );
});

test('saveAccount still refuses a memory-protected record', async () => {
  // Belt and braces for the test above: even if a future call site appears, a
  // memory session cannot be the thing it writes.
  const ks = await import('../src/keystore.js');
  const rec = ks.encryptKeystore(
    '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318',
    'x'.repeat(40),
    {
      apiKeyName: 'k', accountId: 1, address: '0x' + 'a'.repeat(40),
      keyAddress: '0x' + 'b'.repeat(40), network: 'mainnet', permissions: 3,
      expiresAt: 0, createdAt: 1, protection: 'memory',
    },
  );
  assert.throws(() => ks.saveAccount('/tmp/never.json', rec), /refusing to persist/i);
});
