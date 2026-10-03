/**
 * What ARRIVES against SoDEX's deposit minimum (depositGuard.ts arrivalCheck) -
 * the Withdraw sheet's warning, its one confirmation, and its refusals.
 *
 * The owner's case (2026-10): 5 USDC withdrawn to Base met the 5 USDC
 * withdrawal minimum, but to ANOTHER SoDEX account's deposit address 4 arrived
 * after the 1 USDC fee - below the 5 USDC deposit minimum, never credited.
 * The registry reads and withdrawFunds' own refusals: trading/funds.test.ts.
 *   npx tsx --test src/components/funds/depositGuard.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeFunctionData, parseAbi } from 'viem';
import { toChecksumAddress } from '../../trading/addresses';
import type { ChainRoute, CoinConfig } from '../../trading/funds';
import { arrivalCheck, depositAccountsCallData, type ReceiverAccount } from './depositGuard';

const OWNER = '0x1111111111111111111111111111111111111111';
/** Another SoDEX account, its Base deposit address (stored EIP-55, as SoDEX stores them), and the owner's own. */
const OTHER = '0x2222222222222222222222222222222222222222';
const THEIRS = toChecksumAddress('0x4577c24e9e7a53aa775589c7d9fa7ae4bbc426cb');
const MINE = toChecksumAddress('0x5cc60db393c3d48b8128bc82183da57fd9fc7b01');
const DEST = '0x4b363bfcd961eca3aa723151a7ccdab76b869bfd';
const USDC: CoinConfig = {
  coin: 'USDC',
  asset: 'vUSDC',
  assetId: 0,
  valuechain: { token: '0xcb7F80Dff2727c791fA491722c428e6657f7e2c6', symbol: 'vUSDC', decimals: 6, native: false },
  chains: [],
};
/** SoDEX's live Base USDC route: fee 1, withdrawal minimum 5, deposit minimum 5. */
const BASE: ChainRoute = {
  key: 'BASE_ETH', label: 'Base', addressKind: 'evm', memo: null, withdrawType: 0, tokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', isNativeToken: false,
  deposit: { allowed: true, min: '5', etaSeconds: 120 },
  withdraw: { allowed: true, min: '5', fee: '1' },
};
const UNKNOWN: ReceiverAccount = { depositOf: null, own: false };
const micro = (n: number) => BigInt(Math.round(n * 1e6));
const check = (receiver: string, amount: number, registry: ReceiverAccount | null, route: ChainRoute | 'VALUECHAIN' = BASE) =>
  arrivalCheck({ owner: OWNER, coin: USDC, route, receiver, amount: micro(amount), fee: route === 'VALUECHAIN' ? 0n : 1_000_000n, registry });

test("below SoDEX's deposit minimum on arrival, to another address: a warning, and one confirmation before signing", () => {
  const r = check(DEST, 5, UNKNOWN);
  assert.ok(r.verdict === 'confirm', 'confirmation needed');
  assert.equal(
    r.text,
    "Only 4 USDC arrives after the 1 USDC fee - below SoDEX's 5 USDC deposit minimum on Base. If this is the deposit address of a SoDEX account (or of any exchange), it will not be credited. To be credited there, withdraw at least 6 USDC.",
  );
  assert.equal(r.enough, '6', 'the deposit minimum plus the fee');
  assert.match(r.brief, /^Only 4 USDC arrives .* You confirmed this address is a wallet, not a deposit address\.$/);
  assert.equal(check(DEST, 5.999999, UNKNOWN).verdict, 'confirm', 'exact units: 4.999999 is below 5');
  assert.equal(check(DEST, 5, null).verdict, 'confirm', 'registry not read (or unreadable): the same warning, never silence');
  // The withdrawal minimum, when it is the larger, is what "enough" says.
  const r2 = check(DEST, 5, UNKNOWN, { ...BASE, withdraw: { ...BASE.withdraw, min: '8' } });
  assert.ok(r2.verdict === 'confirm' && r2.enough === '8');
});

test('at or above the deposit minimum on arrival: no warning', () => {
  assert.deepEqual(check(DEST, 6, UNKNOWN), { verdict: 'ok' }, '5 arrives: exactly the minimum');
  assert.deepEqual(check(DEST, 100, UNKNOWN), { verdict: 'ok' });
  assert.deepEqual(check(THEIRS, 6, { depositOf: OTHER, own: false }), { verdict: 'ok' }, 'a SoDEX deposit address credits 5');
  assert.deepEqual(check(DEST, 0, UNKNOWN), { verdict: 'ok' }, 'no amount yet');
  assert.deepEqual(check(DEST, 5, UNKNOWN, { ...BASE, deposit: { ...BASE.deposit, min: null } }), { verdict: 'ok' }, 'no minimum known');
});

test('a SoDEX deposit address (the registry names its account) that would get less than the minimum: refused, not just warned', () => {
  const r = check(THEIRS, 5, { depositOf: OTHER, own: false });
  assert.ok(r.verdict === 'refuse' && r.reason === 'sodex-below');
  assert.equal(r.text, "That is a SoDEX deposit address. Only 4 USDC arrives after the 1 USDC fee - below SoDEX's 5 USDC deposit minimum on Base, so it would never be credited. Withdraw at least 6 USDC.");
  const closed = check(THEIRS, 50, { depositOf: OTHER, own: false }, { ...BASE, deposit: { ...BASE.deposit, allowed: false } });
  assert.ok(closed.verdict === 'refuse' && closed.reason === 'sodex-closed' && /takes no USDC deposits on Base/.test(closed.text));
});

test("the owner's own SoDEX deposit address: refused on every route, for any amount", () => {
  for (const amount of [0, 5, 100]) {
    const r = check(MINE, amount, { depositOf: OWNER, own: true });
    assert.ok(r.verdict === 'refuse' && r.reason === 'own', `${amount} USDC`);
    assert.match(r.text, /^That is your own SoDEX deposit address\..*below SoDEX's 5 USDC deposit minimum it is lost\. Withdraw to a wallet instead\.$/);
  }
  const vc = check(MINE, 5, { depositOf: null, own: true }, 'VALUECHAIN');
  assert.ok(vc.verdict === 'refuse' && vc.reason === 'own' && /not a deposit and would not be credited/.test(vc.text));
});

test('the own wallet is unaffected: any amount, no warning, whatever the registry says', () => {
  assert.deepEqual(check(OWNER, 5, UNKNOWN), { verdict: 'ok' });
  assert.deepEqual(check(toChecksumAddress(OWNER), 5, null), { verdict: 'ok' }, 'checksummed, the same wallet');
  assert.deepEqual(check(OWNER, 5, { depositOf: null, own: true }), { verdict: 'ok' });
  // ValueChain to another address is a token transfer: no deposit minimum.
  assert.deepEqual(check(DEST, 1, UNKNOWN, 'VALUECHAIN'), { verdict: 'ok' });
});

test("the reverse lookup's call data is depositAccounts(string chain, string depositWallet), ABI-exact", () => {
  const abi = parseAbi(['function depositAccounts(string chain, string depositWallet) view returns (address)']);
  for (const [c, w] of [['BASE_ETH', THEIRS], ['', ''], ['SOL', 'CJedAagCojZTmokr8Cg2v1v37SPgxRUvtwgoU5QMhEkK'], ['ARBITRUM_ETH_LONG_CHAIN_NAME_OVER_32_BYTES', THEIRS]] as const) {
    assert.equal(depositAccountsCallData(c, w), encodeFunctionData({ abi, functionName: 'depositAccounts', args: [c, w] }), `${c} ${w}`);
  }
});
