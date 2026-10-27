import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OrderSide, type SignableAction } from '@sodex-core';
import { IS_SANCTIONED_SELECTOR, SANCTIONS_ORACLE, SCREENING_RPC, _resetScreeningForTests, readScreening, screenWallet, screeningCall, screeningOf } from './screening';
import { legalRefusal, legalStateFor } from '../trading/legalGate';
import { _resetAcceptanceForTests, _signedTermsForTests } from './acceptance';

const LISTED = '0x098b716b8aaf21512996dc57eb0615e2383e2f96';
/** Listed by the oracle (in these tests) but not in the repository's list: the oracle path. */
const ORACLE_ONLY = '0x3333333333333333333333333333333333333333';
const CLEAN = '0x1111111111111111111111111111111111111111';
const TRUE = `0x${'0'.repeat(63)}1`;
const FALSE = `0x${'0'.repeat(64)}`;

test('the oracle call and its answer', () => {
  assert.equal(screeningCall(LISTED.toUpperCase().replace('0X', '0x')), `${IS_SANCTIONED_SELECTOR}${'0'.repeat(24)}${LISTED.slice(2)}`);
  assert.equal(readScreening(TRUE), 'sanctioned');
  assert.equal(readScreening(FALSE), 'clear');
  for (const bad of [undefined, '0x', '0x01', `0x${'0'.repeat(63)}2`, 42]) assert.equal(readScreening(bad), 'unknown');
});

test('an address on the shared list (the one the executor and the API enforce) is sanctioned without asking the node, even when it is down', async () => {
  _resetScreeningForTests();
  _resetAcceptanceForTests();
  let asked = 0;
  const down = (async () => {
    asked++;
    throw new Error('node down');
  }) as never;
  assert.equal(screeningOf(LISTED), 'sanctioned');
  assert.equal(await screenWallet(LISTED.toUpperCase().replace('0X', '0x'), down), 'sanctioned');
  assert.equal(asked, 0);
  _signedTermsForTests(LISTED);
  const cancel = { engine: 'perps', type: 'cancelOrder', params: {} } as SignableAction;
  assert.match(legalRefusal(cancel, legalStateFor(LISTED))!, /sanctions list/);
  assert.equal(await screenWallet(CLEAN, down), 'unknown');
  assert.equal(asked, 1);
  _resetScreeningForTests();
  _resetAcceptanceForTests();
});

test('one request per address; a listed wallet signs nothing, not even a cancel; no answer restricts nothing', async () => {
  _resetScreeningForTests();
  _resetAcceptanceForTests();
  const asked: string[] = [];
  const call = (async (url: string, _m: string, params: unknown[]) => {
    const p = params[0] as { to: string; data: string };
    assert.equal(url, SCREENING_RPC);
    assert.equal(p.to, SANCTIONS_ORACLE);
    asked.push(p.data);
    return { result: p.data.endsWith(ORACLE_ONLY.slice(2)) ? TRUE : FALSE };
  }) as never;
  assert.equal(await screenWallet(ORACLE_ONLY, call), 'sanctioned');
  assert.equal(await screenWallet(ORACLE_ONLY, call), 'sanctioned');
  assert.equal(await screenWallet(CLEAN, call), 'clear');
  assert.equal(asked.length, 2);
  assert.equal(screeningOf(ORACLE_ONLY.toUpperCase().replace('0X', '0x')), 'sanctioned');

  _signedTermsForTests(ORACLE_ONLY);
  _signedTermsForTests(CLEAN);
  const cancel = { engine: 'perps', type: 'cancelOrder', params: {} } as SignableAction;
  const close = { engine: 'perps', type: 'newOrder', params: { orders: [{ side: OrderSide.SELL, reduceOnly: true }] } } as SignableAction;
  assert.match(legalRefusal(cancel, legalStateFor(ORACLE_ONLY))!, /sanctions list/);
  assert.match(legalRefusal(close, legalStateFor(ORACLE_ONLY))!, /sanctions list/);
  assert.equal(legalRefusal(cancel, legalStateFor(CLEAN)), null);

  const down = (async () => { throw new Error('node down'); }) as never;
  const other = '0x2222222222222222222222222222222222222222';
  assert.equal(await screenWallet(other, down), 'unknown');
  _signedTermsForTests(other);
  assert.equal(legalRefusal(cancel, legalStateFor(other)), null);
  assert.equal(await screenWallet('not an address', call), 'unknown');
  _resetScreeningForTests();
  _resetAcceptanceForTests();
});
