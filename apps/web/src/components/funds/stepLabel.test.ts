import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promptCounter, type FundsStep } from '../../trading/funds';
import { openingWalletStep } from './openingStep';
import { stepLabel } from './stepLabel';

const phone = { walletName: 'Trust Wallet' };
const ext = { walletName: 'MetaMask' };

test('the button: approve then confirm, counted, in the connected wallet by name', () => {
  const seen: FundsStep[] = [];
  const ask = promptCounter((s) => seen.push(s), 2);
  ask('approve');
  ask('confirm');
  assert.deepEqual(seen.map((s) => stepLabel(s, phone)), ['Please approve in Trust Wallet (1/2)', 'Please confirm in Trust Wallet (2/2)']);
  assert.deepEqual(seen.map((s) => stepLabel(s, ext)), ['Please approve in MetaMask (1/2)', 'Please confirm in MetaMask (2/2)']);
});

test('the button: a single prompt has no count, work in between reads Confirming…, a nameless wallet is "your wallet"', () => {
  const seen: FundsStep[] = [];
  promptCounter((s) => seen.push(s), 1)('confirm');
  assert.equal(stepLabel(seen[0]!, { walletName: 'Rabby Wallet' }), 'Please confirm in Rabby Wallet');
  assert.equal(stepLabel({ wallet: null }, ext), 'Confirming…');
  assert.equal(stepLabel(null, phone), 'Confirming…');
  for (const walletName of ['', 'WalletConnect', 'Browser wallet', '  ']) {
    assert.equal(stepLabel(seen[0]!, { walletName }), 'Please confirm in your wallet', walletName);
  }
});

test('an ERC-20 deposit reports approve 1/2 before any slow read; a chain switch recounts it as 1/3', () => {
  // What depositFromWallet reports synchronously, before balance, chain and nonce.
  assert.equal(stepLabel(openingWalletStep(false), ext), 'Please approve in MetaMask (1/2)');
  assert.equal(stepLabel({ wallet: 'approve', n: 1, of: 3 }, ext), 'Please approve in MetaMask (1/3)');
  assert.equal(stepLabel({ wallet: 'confirm', n: 3, of: 3 }, ext), 'Please confirm in MetaMask (3/3)');
  assert.equal(stepLabel(openingWalletStep(true), ext), 'Please confirm in MetaMask');
});

test('the count never reads n above the total (an unexpected extra prompt)', () => {
  const seen: FundsStep[] = [];
  const ask = promptCounter((s) => seen.push(s), 1);
  ask('approve');
  ask('confirm');
  assert.equal(stepLabel(seen[1]!, ext), 'Please confirm in MetaMask (2/2)');
});
