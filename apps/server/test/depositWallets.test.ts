/**
 * sodex.com's deposit-wallet registry: our call data and decoding, pinned to a
 * live answer (captured read-only with viem for a public account, 2026-09-26).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeDepositWalletList, encodeDepositWalletList } from '../src/sodex/depositWallets.js';

const fx = JSON.parse(readFileSync(new URL('./depositWallets.fixture.json', import.meta.url), 'utf8')) as {
  account: string;
  cases: Record<string, { data: string; result: string; chains: string[]; wallets: string[][] }>;
};

test('getDepositWalletList: the call data is byte-identical to viem\'s', () => {
  for (const [coin, c] of Object.entries(fx.cases)) assert.equal(encodeDepositWalletList(fx.account, coin), c.data, coin);
});

test('getDepositWalletList: decodes (string[], string[][]) exactly, including an empty wallet list (USDC on ARC)', () => {
  for (const [coin, c] of Object.entries(fx.cases)) {
    const d = decodeDepositWalletList(c.result);
    assert.deepEqual(d.chains, c.chains, coin);
    assert.deepEqual(d.wallets, c.wallets, coin);
  }
  assert.deepEqual(fx.cases.USDC!.wallets.at(-1), [], 'ARC has no USDC address for this account');
  assert.equal(fx.cases.XRP!.wallets[0]![0], 'rnA9QDmAy7y25cdNw7N82M2PpfbhnLEy5E', 'a plain XRP address - no ":memo" part');
});

test('a truncated or garbage answer throws instead of inventing an address', () => {
  assert.throws(() => decodeDepositWalletList(fx.cases.XRP!.result.slice(0, 200)));
  assert.throws(() => decodeDepositWalletList('0x' + 'ff'.repeat(64)));
});
