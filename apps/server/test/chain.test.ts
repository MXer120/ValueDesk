/**
 * Tests for the on-chain deposit path.
 *
 * These guard the two things that would lose real money if wrong: the function
 * selectors/calldata sent to the exchange contract, and the decimal <-> base
 * unit conversion. The expected values are pinned against a REAL mainnet
 * deposit transaction, not against my own implementation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CHAIN,
  NATIVE_TOKEN,
  SELECTORS,
  registration,
  encodeApprove,
  encodeDeposit,
  fromBaseUnits,
  toBaseUnits,
  describeRevert,
  CONTRACT_ERRORS,
} from '../src/sodex/chain.js';

// --- selectors --------------------------------------------------------------

test('depositERC20 selector matches the live contract', () => {
  // Observed on mainnet tx 0x51cd123c…053c, method_id 97feb926.
  assert.equal(SELECTORS.depositERC20, '0x97feb926');
});

test('ERC-20 selectors are the standard ones', () => {
  assert.equal(SELECTORS.approve, '0x095ea7b3');
  assert.equal(SELECTORS.allowance, '0xdd62ed3e');
  assert.equal(SELECTORS.balanceOf, '0x70a08231');
});

// --- calldata ---------------------------------------------------------------

test('native deposit calldata byte-matches a real mainnet transaction', () => {
  // ValueChain tx 0x51cd123c2054f6bd9e4e0b289ed3ca3e99466585def2cd799dcb62d1168e053c
  // depositERC20(token=0x0, amount=301998998000000000000)
  const real =
    '0x97feb926' +
    '0000000000000000000000000000000000000000000000000000000000000000' +
    '000000000000000000000000000000000000000000000010' + '5f13f89f29e76000';
  assert.equal(encodeDeposit(NATIVE_TOKEN, 301998998000000000000n), real);
});

test('ERC-20 deposit encodes the token address in the first word', () => {
  const vusdc = '0xcb7F80Dff2727c791fA491722c428e6657f7e2c6';
  const data = encodeDeposit(vusdc, 100_000_000n); // 100 vUSDC @ 6dp
  assert.equal(data.slice(0, 10), '0x97feb926');
  assert.equal(data.slice(10, 74), '000000000000000000000000cb7f80dff2727c791fa491722c428e6657f7e2c6');
  assert.equal(BigInt('0x' + data.slice(74)), 100_000_000n);
  assert.equal(data.length, 10 + 128);
});

test('approve targets the exchange contract, never anything else', () => {
  const data = encodeApprove(CHAIN.exchange, 42n);
  assert.equal(data.slice(0, 10), '0x095ea7b3');
  assert.equal(
    data.slice(10, 74),
    '000000000000000000000000' + CHAIN.exchange.slice(2).toLowerCase(),
  );
  assert.equal(BigInt('0x' + data.slice(74)), 42n);
});

test('the exchange address is the one observed custodying deposits', () => {
  assert.equal(CHAIN.exchange, '0x0101010101010101010101010101010101010101');
  assert.equal(CHAINS_MAINNET_ID(), 286623);
});

const CHAINS_MAINNET_ID = () => (CHAIN.chainId === 286623 || CHAIN.chainId === 138565 ? 286623 : -1);

// --- base units -------------------------------------------------------------

test('toBaseUnits scales exactly, without floats', () => {
  assert.equal(toBaseUnits('25.5', 6), 25_500_000n);
  assert.equal(toBaseUnits('1', 18), 10n ** 18n);
  assert.equal(toBaseUnits('0.5', 18), 5n * 10n ** 17n);
  assert.equal(toBaseUnits('0.000001', 6), 1n);
  assert.equal(toBaseUnits('301.998998', 18), 301998998000000000000n);
  // 0.1 + 0.2 style precision loss must be impossible here.
  assert.equal(toBaseUnits('0.1', 18), 100000000000000000n);
});

test('toBaseUnits refuses more precision than the asset has', () => {
  // Silently truncating here would deposit a different amount than displayed.
  assert.throws(() => toBaseUnits('1.1234567', 6), /decimal places/);
  assert.throws(() => toBaseUnits('0.0000001', 6), /decimal places/);
  assert.doesNotThrow(() => toBaseUnits('1.123456', 6));
});

test('toBaseUnits refuses negative amounts', () => {
  assert.throws(() => toBaseUnits('-5', 6), /positive/);
});

test('fromBaseUnits round-trips', () => {
  for (const [v, dp] of [
    ['25.5', 6], ['1', 18], ['0.000001', 6], ['1000000', 8], ['0.00000001', 8],
  ] as Array<[string, number]>) {
    assert.equal(fromBaseUnits(toBaseUnits(v, dp), dp), v, `${v} @ ${dp}dp`);
  }
});

test('fromBaseUnits produces no trailing zeros', () => {
  assert.equal(fromBaseUnits(1_500_000n, 6), '1.5');
  assert.equal(fromBaseUnits(1_000_000n, 6), '1');
  assert.equal(fromBaseUnits(0n, 18), '0');
});

// --- contract errors --------------------------------------------------------

test('the exchange custom errors are decoded to plain language', () => {
  // Selectors identified by simulating each failure against the live contract.
  // Simulated 2026-09-26 from a never-seen wallet: 1.0 SOSO reverts with this, 1.1 SOSO opens the account.
  assert.match(describeRevert('0xe7178dd4') ?? '', /activation fee/i);
  assert.match(describeRevert('0xed39c7cb') ?? '', /value must exactly equal/i);
  assert.match(describeRevert('0xfb8f41b2') ?? '', /approve/i);
  assert.equal(describeRevert('0xdeadbeef'), undefined);
  assert.equal(describeRevert(undefined), undefined);
});

test('revert decoding tolerates full ABI-encoded error payloads', () => {
  // Real payloads carry arguments after the 4-byte selector.
  const withArgs = '0xfb8f41b2' + '0'.repeat(192);
  assert.match(describeRevert(withArgs) ?? '', /approve/i);
});

test('every known error selector is 4 bytes', () => {
  for (const k of Object.keys(CONTRACT_ERRORS)) {
    assert.match(k, /^0x[0-9a-f]{8}$/, k);
  }
});

// --- account registration ---------------------------------------------------

test('the account-model selectors match the deployed contract', () => {
  // Extracted from the exchange implementation bytecode and resolved against
  // the public 4-byte directory.
  assert.equal(SELECTORS.getUserId, '0x2b956ff7');
  assert.equal(SELECTORS.register, '0x4420e486');
});

test('registration errors are explained rather than shown as hex', () => {
  // getUserId reverts with this for an address the exchange never registered.
  assert.match(describeRevert('0x40298ab1') ?? '', /not registered/i);
  // register() is owner-only; a wallet calling it gets OwnableUnauthorizedAccount.
  assert.match(describeRevert('0x118cdaa7') ?? '', /only sodex can register/i);
});

test('registration() reports unregistered rather than throwing', async () => {
  // A never-used address: the contract reverts, and this must degrade to a
  // clean "not registered" so the UI can explain it.
  const r = await registration('0x' + 'ab'.repeat(20));
  assert.equal(r.registered, false);
  assert.equal(r.accountId, null);
});

// --- API key permission masks ----------------------------------------------

// These pin OUR reading of SoDEX's docs, not SoDEX's behaviour. The previous
// versions asserted `TRADE|CANCEL === 3` and "3 & WITHDRAW === 0", which only
// checked the code against its own misreading - both passed while the minted
// key was, per the docs, a withdraw-and-transfer key. What the gateway actually
// does is settled by the testnet plan in docs/PERMISSION-MASK.md, not here.

test('permission bits match the SDK enum (bit index -> 1 << index)', async () => {
  const { APIKeyPermission } = await import('../src/signing/actions.js');
  assert.equal(APIKeyPermission.TRADE, 1);
  assert.equal(APIKeyPermission.CANCEL, 2);
  assert.equal(APIKeyPermission.WITHDRAW, 4);
  assert.equal(APIKeyPermission.TRANSFER, 8);
});

test('a set bit DISABLES a permission, and an absent mask enables everything', async () => {
  // REST schema, APIKeyPermissionEnum: "A bit value of 1 means the permission is
  // disabled. If permissions is omitted, all permissions are enabled."
  const { APIKeyPermission: P, permits, canMoveFunds, enabledPermissionNames } =
    await import('../src/signing/actions.js');
  for (const bit of [P.TRADE, P.CANCEL, P.WITHDRAW, P.TRANSFER]) {
    assert.equal(permits(0, bit), true, 'an ordinary key (no mask) has every permission');
    assert.equal(permits(15, bit), false, 'mask 15 disables everything');
  }
  assert.equal(canMoveFunds(0), true, 'an ordinary sodex.com key can move funds');
  assert.deepEqual(enabledPermissionNames(0), ['trade', 'cancel', 'withdraw', 'transfer']);
  assert.deepEqual(enabledPermissionNames(15), []);
});

test('regression: the old "trade-only" mask 3 is a withdraw-and-transfer key', async () => {
  const { APIKeyPermission: P, permits, canMoveFunds, enabledPermissionNames } =
    await import('../src/signing/actions.js');
  assert.equal(permits(3, P.TRADE), false);
  assert.equal(permits(3, P.CANCEL), false);
  assert.equal(canMoveFunds(3), true);
  assert.deepEqual(enabledPermissionNames(3), ['withdraw', 'transfer']);
  // And the old elevation masks: "transfer" (11) was withdraw-only, and
  // "withdraw" (15) could do nothing at all.
  assert.deepEqual(enabledPermissionNames(11), ['withdraw']);
  assert.deepEqual(enabledPermissionNames(15), []);
});

test('the minted masks each leave exactly one permission enabled', async () => {
  const { PERMISSION_MASK: M, enabledPermissionNames, canMoveFunds, isPermissionedKeyMask } =
    await import('../src/signing/actions.js');
  assert.equal(M.TRADE_ONLY, 14);
  assert.equal(M.WITHDRAW_ONLY, 11);
  assert.equal(M.TRANSFER_ONLY, 7);
  assert.deepEqual(enabledPermissionNames(M.TRADE_ONLY), ['trade']);
  assert.deepEqual(enabledPermissionNames(M.WITHDRAW_ONLY), ['withdraw']);
  assert.deepEqual(enabledPermissionNames(M.TRANSFER_ONLY), ['transfer']);
  assert.equal(canMoveFunds(M.TRADE_ONLY), false);
  for (const m of Object.values(M)) assert.equal(isPermissionedKeyMask(m), true, `mask ${m}`);
});

test('only masks the gateway documents as creatable pass validation', async () => {
  // "permissions must disable TRADE, CANCEL, or both; enabling both TRADE and
  // CANCEL is not supported."
  const { isPermissionedKeyMask } = await import('../src/signing/actions.js');
  for (const ok of [1, 2, 3, 7, 11, 13, 14, 15]) assert.equal(isPermissionedKeyMask(ok), true, `${ok}`);
  for (const bad of [0, 4, 8, 12, 16, -1, 1.5, Number.NaN]) {
    assert.equal(isPermissionedKeyMask(bad), false, `${bad}`);
  }
});

test('mainnet key minting stays off until the masks are verified', async () => {
  const { mintingBlockedReason } = await import('../src/config.js');
  assert.match(mintingBlockedReason('mainnet', false) ?? '', /PERMISSION-MASK\.md/);
  assert.equal(mintingBlockedReason('mainnet', true), null);
  assert.equal(mintingBlockedReason('testnet', false), null, 'testnet is where the plan runs');
});

test('the permission mask changes the signed digest', async () => {
  // Guards against `permissions` being dropped from the EIP-712 struct hash -
  // which would let a trade-only authorisation be replayed as a withdraw key.
  const { permissionedAPIKeyDigest } = await import('../src/signing/userSigned.js');
  const { bytesToHex } = await import('../src/signing/eip712.js');
  const base = {
    accountID: 43933,
    name: 'k',
    publicKey: '0x1234567890abcdef1234567890abcdef12345678',
    expiresAt: 0,
  };
  const d3 = bytesToHex(permissionedAPIKeyDigest({ ...base, permissions: 3 }, 138565, 1n, 1));
  const d15 = bytesToHex(permissionedAPIKeyDigest({ ...base, permissions: 15 }, 138565, 1n, 1));
  assert.notEqual(d3, d15);
});
