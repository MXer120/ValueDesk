import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { _resetTransferLog, beginTransfer, dropTransfer, finishTransfer, noteTransferStep, transferEntries } from './transferLog';

beforeEach(() => _resetTransferLog());

const row = {
  coin: 'USDC',
  amount: '11.24999',
  from: 'evm' as const,
  to: 'spot' as const,
  walletStep: { wallet: 'approve' as const, n: 1, of: 2 },
  settling: false,
};

test('the log is newest first, follows the in-flight step, and keeps 20', () => {
  const first = beginTransfer(row);
  noteTransferStep(first, { wallet: 'confirm', n: 2, of: 2 });
  noteTransferStep(first, { wallet: null });
  finishTransfer(first, 'success');
  const done = transferEntries()[0]!;
  assert.equal(done.status, 'success');
  assert.equal(done.settling, false);
  assert.equal(done.walletStep?.wallet, 'confirm');
  assert.equal(done.amount, '11.24999');

  const second = beginTransfer({ ...row, amount: '1', walletStep: null, settling: true });
  assert.deepEqual(transferEntries().map((e) => e.id), [second, first]);
  dropTransfer(second);
  assert.deepEqual(transferEntries().map((e) => e.id), [first]);

  const ids: string[] = [];
  for (let i = 0; i < 25; i++) ids.push(beginTransfer({ ...row, amount: String(i) }));
  const stored = transferEntries();
  assert.equal(stored.length, 20);
  assert.equal(stored[0]!.id, ids[24]);
  assert.equal(stored[19]!.amount, '5');
});
