/**
 * The follower's notices (notices.ts): what an algo or a copy raises - failed, stopped, held,
 * halted, closed, made smaller, liquidated - and what it does not (what the follower did themself), with a stable id.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { algoClosedNotice, algoNotice, copyClosedNotice, copyNotice, copyReducedNotice, type AlgoRecord, type Subscription } from '../src/index.ts';

const W = '0x00000000000000000000000000000000000000aa';
const algo = { id: 'al_1', owner: W, spec: { kind: 'twap', side: 'sell', symbol: 'BTC-USD', paper: false } } as unknown as AlgoRecord;
const copy = { id: 'cp_1', owner: W, settings: { leader: { venue: 'hyperliquid', address: '0x1234567890abcdef1234567890abcdef12345678' }, paper: true } } as unknown as Subscription;

test('an algo: failed is an error, stopped or held by the engine a warning, finished info; what the follower did is none', () => {
  const f = algoNotice(algo, 'failed', 'Not started: no margin.', 1_000)!;
  assert.deepEqual(f, { owner: W, source: 'algo', ref: 'al_1', kind: 'failed', grade: 'error', title: 'TWAP sell on BTC-USD failed', body: 'Not started: no margin.', at: 1_000, paper: false, id: 'algo:al_1:failed:1000' });
  assert.equal(algoNotice(algo, 'cancelled', 'Stopped: the browser tab that ran it was closed.')!.grade, 'warn');
  assert.equal(algoNotice(algo, 'cancelled', 'Cancelled by you.'), null);
  assert.equal(algoNotice(algo, 'paused', 'Paused by you.'), null);
  assert.equal(algoNotice(algo, 'paused', 'Held: SoDEX position limit.')!.kind, 'held');
  assert.equal(algoNotice(algo, 'done', 'Filled.')!.grade, 'info');
  assert.equal(algoNotice(algo, 'expired', 'Time is up.')!.kind, 'ended');
  assert.equal(algoNotice(algo, 'running', null), null);
});

test('a copy: halted an error, held / paused / stopped by the engine a warning; a position closed outside an error, by its stop info', () => {
  assert.equal(copyNotice(copy, 'halted', 'Your drawdown stop (20%) closed this copy.')!.grade, 'error');
  assert.equal(copyNotice(copy, 'blocked', 'The copy key is not available here.')!.title, 'Copy of 0x1234…5678 is held');
  assert.equal(copyNotice(copy, 'stopped', 'Stopped by you; positions kept.'), null);
  assert.equal(copyNotice(copy, 'paused', 'Paused by you.'), null);
  assert.equal(copyNotice(copy, 'active', null), null);
  assert.equal(copyNotice(copy, 'halted', 'x')!.paper, true);
  const outside = copyClosedNotice(copy, 'ETH-USD', 'own-position', 'Closed outside the copier.', 5);
  assert.deepEqual([outside.grade, outside.kind, outside.ref, outside.id], ['error', 'closed', 'cp_1:ETH-USD', 'copy:cp_1:ETH-USD:closed:5']);
  assert.equal(copyClosedNotice(copy, 'ETH-USD', 'stop-loss', 'Your stop-loss closed it.').grade, 'info');
});

test('a liquidation is an error, whole or in part; a part closed outside by the follower or SoDEX a warning, by the copy\'s stop info', () => {
  const liq = copyClosedNotice(copy, 'ETH-USD', 'liquidation', 'SoDEX liquidated this copied position.', 5);
  assert.deepEqual([liq.grade, liq.kind, liq.title], ['error', 'closed', 'ETH-USD liquidated in the copy of 0x1234…5678']);
  const part = copyReducedNotice(copy, 'ETH-USD', 'liquidation', 'SoDEX liquidated 0.4 of this copied position.', 6);
  assert.deepEqual([part.grade, part.kind, part.ref, part.id, part.title], ['error', 'reduced', 'cp_1:ETH-USD', 'copy:cp_1:ETH-USD:reduced:6', 'ETH-USD partly liquidated in the copy of 0x1234…5678']);
  assert.equal(copyReducedNotice(copy, 'ETH-USD', 'own-position', 'x').grade, 'warn');
  assert.equal(copyReducedNotice(copy, 'ETH-USD', 'stop-loss', 'x').grade, 'info');
});

test('an algo whose position was closed outside it: an error, on the algo', () => {
  const n = algoClosedNotice(algo, 'Your BTC-USD position is gone.', 7);
  assert.deepEqual([n.source, n.ref, n.kind, n.grade, n.title, n.id], ['algo', 'al_1', 'closed', 'error', 'TWAP sell on BTC-USD: position closed outside it', 'algo:al_1:closed:7']);
});
