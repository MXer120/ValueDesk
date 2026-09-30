import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openingWalletStep } from './openingStep';
import { stepLabel } from './stepLabel';

const ext = { walletName: 'MetaMask' };

test('an ERC-20 deposit reports approve 1/2 before any slow read; a chain switch recounts it as 1/3', () => {
  // openingWalletStep is what depositFromWallet / transferFunds report synchronously,
  // before wallet balance, chain id and permit nonce return.
  assert.equal(stepLabel(openingWalletStep(false), ext), 'Please approve in MetaMask (1/2)');
  assert.equal(stepLabel({ wallet: 'approve', n: 1, of: 3 }, ext), 'Please approve in MetaMask (1/3)');
  assert.equal(stepLabel({ wallet: 'approve', n: 2, of: 3 }, ext), 'Please approve in MetaMask (2/3)');
  assert.equal(stepLabel({ wallet: 'confirm', n: 3, of: 3 }, ext), 'Please confirm in MetaMask (3/3)');
});

test('a native wallet transfer is one confirm, not Confirming… and not a fake 1/2', () => {
  assert.equal(stepLabel(openingWalletStep(true), ext), 'Please confirm in MetaMask');
});
