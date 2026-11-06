import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CONFIRM_KINDS, _forgetConfirmPrefs, confirmOn, resetConfirms, setConfirmOn } from './confirmPrefs';

const store = new Map<string, string>();
const memory = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};
beforeEach(() => {
  store.clear();
  (globalThis as { localStorage?: unknown }).localStorage = memory;
  _forgetConfirmPrefs();
});

test('every kind asks by default', () => {
  for (const k of CONFIRM_KINDS) assert.equal(confirmOn(k), true, k);
});

test('one kind turned off leaves the others asking, and is remembered', () => {
  setConfirmOn('cancel', false);
  assert.equal(confirmOn('cancel'), false);
  assert.equal(confirmOn('close'), true);
  _forgetConfirmPrefs();
  assert.equal(confirmOn('cancel'), false, 'after a reload');
  assert.equal(confirmOn('cancelAll'), true);
  setConfirmOn('cancel', true);
  _forgetConfirmPrefs();
  assert.equal(confirmOn('cancel'), true);
});

test('orders keep the key their old "don\'t show again" used, so an earlier tick stands', () => {
  store.set('opentrade.review.suppress', '1');
  _forgetConfirmPrefs();
  assert.equal(confirmOn('order'), false);
  setConfirmOn('order', true);
  assert.equal(store.has('opentrade.review.suppress'), false);
  setConfirmOn('order', false);
  assert.equal(store.get('opentrade.review.suppress'), '1');
});

test('only a stored false turns a kind off: junk and a broken value still ask', () => {
  store.set('vs.confirm', JSON.stringify({ close: 0, move: 'false', cancel: null }));
  _forgetConfirmPrefs();
  for (const k of ['close', 'move', 'cancel'] as const) assert.equal(confirmOn(k), true, k);
  store.set('vs.confirm', '{oops');
  _forgetConfirmPrefs();
  assert.equal(confirmOn('close'), true);
});

test('a browser that refuses storage asks, also after trying to turn one off', () => {
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem() { throw new Error('denied'); },
    setItem() { throw new Error('denied'); },
    removeItem() { throw new Error('denied'); },
  };
  _forgetConfirmPrefs();
  assert.equal(confirmOn('close'), true);
  setConfirmOn('order', false);
  setConfirmOn('close', false);
  assert.equal(confirmOn('order'), true);
  assert.equal(confirmOn('close'), true);
});

test('reset asks everything again', () => {
  for (const k of CONFIRM_KINDS) setConfirmOn(k, false);
  resetConfirms();
  for (const k of CONFIRM_KINDS) assert.equal(confirmOn(k), true, k);
});

test('the terms gate and the fee guards do not read this setting', () => {
  for (const file of ['./feeGuard.ts', './builder.ts', '../legal/LegalGate.tsx']) {
    const src = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /confirmPrefs|TradeConfirm/, file);
  }
});
