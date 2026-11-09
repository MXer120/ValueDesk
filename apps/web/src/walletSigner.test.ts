/**
 * A wallet that signs with another account than the one asked for (owner, 2026-11-09: "the signature is
 * not from this wallet"): refused here, in words that say which account to switch to.
 *   npx tsx --test src/walletSigner.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { hashTypedData } from '../../../packages/sodex-core/src/eip712.ts';
import { recoverTypedSigner, signTypedData, WalletError, type Eip1193Provider } from './wallet.ts';

const hex = (b: Uint8Array) => `0x${Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')}`;
const keyA = new Uint8Array(32).fill(1);
const keyB = new Uint8Array(32).fill(2);
const addrOf = (k: Uint8Array) => hex(keccak_256(secp256k1.getPublicKey(k, false).slice(1)).slice(12));
const A = addrOf(keyA);
const B = addrOf(keyB);

const td = {
  domain: { name: 'Test', version: '1', chainId: 1, verifyingContract: '0x0000000000000000000000000000000000000000' },
  types: {
    EIP712Domain: [
      { name: 'name', type: 'string' }, { name: 'version', type: 'string' },
      { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' },
    ],
    Hello: [{ name: 'owner', type: 'address' }, { name: 'note', type: 'string' }],
  },
  primaryType: 'Hello',
  message: { owner: A, note: 'hi' },
};

function sign(k: Uint8Array): string {
  const s = secp256k1.sign(hashTypedData(td as never), k, { lowS: true, prehash: false });
  return `${hex(s.toCompactRawBytes())}${(27 + s.recovery).toString(16)}`;
}

/** A wallet that reports `accounts` and signs with `key`, whatever address it is asked for. */
const wallet = (accounts: string[], key: Uint8Array): Eip1193Provider => ({
  request: async ({ method }) => (method === 'eth_accounts' ? accounts : method === 'eth_signTypedData_v4' ? sign(key) : null),
});

test('the signer is read back from the typed data', async () => {
  assert.equal(await recoverTypedSigner(td, sign(keyA)), A);
  assert.equal(await recoverTypedSigner(td, '0x1234'), null);
});

test('the right account signs', async () => {
  assert.equal(typeof (await signTypedData(wallet([A], keyA), A, td)), 'string');
  // Address case does not matter.
  assert.equal(typeof (await signTypedData(wallet([A.toUpperCase().replace('0X', '0x')], keyA), A, td)), 'string');
});

test('a wallet on another account is stopped before the prompt', async () => {
  await assert.rejects(signTypedData(wallet([B], keyB), A, td), (e: unknown) => e instanceof WalletError && /Switch your wallet to 0x/.test(e.message));
});

test('a wallet that lists the right account but signs with another of its accounts is caught', async () => {
  await assert.rejects(signTypedData(wallet([A, B], keyB), A, td), (e: unknown) => e instanceof WalletError && e.message.includes(B.slice(0, 6)));
});

test('a signer the wallet does not hold is left to the server (no false alarm from a digest mismatch)', async () => {
  assert.equal(typeof (await signTypedData(wallet([A], keyB), A, td)), 'string');
});

test('a wallet that does not list accounts still signs', async () => {
  assert.equal(typeof (await signTypedData(wallet([], keyA), A, td)), 'string');
});
