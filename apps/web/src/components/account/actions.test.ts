/**
 * Pure-logic tests for the account actions that replaced the wallet sheet.
 *   npx tsx --test src/components/account/actions.test.ts
 *
 * `goToWallet` dispatches window events; a minimal EventTarget stands in for
 * `window` so the routing can be observed without a DOM.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const target = new EventTarget();
(globalThis as unknown as { window: EventTarget }).window = target;
if (typeof (globalThis as { CustomEvent?: unknown }).CustomEvent === 'undefined') {
  (globalThis as unknown as { CustomEvent: typeof Event }).CustomEvent = class extends Event {} as typeof Event;
}

const {
  WALLET_EVENTS,
  getAccountPending,
  goToWallet,
  sameAddress,
  setAccountPending,
  walletRoute,
} = await import('./actions');

const A = '0xAbCdEf0000000000000000000000000000000001';

test('walletRoute: no address -> connect, whatever else is true', () => {
  assert.equal(walletRoute({ address: null, hasProvider: false, unlocked: false }), 'connect');
  assert.equal(walletRoute({ address: undefined, hasProvider: true, unlocked: true }), 'connect');
  assert.equal(walletRoute({ address: '', hasProvider: true, unlocked: true }), 'connect');
});

test('walletRoute: remembered address with nothing to sign with -> reconnect', () => {
  assert.equal(walletRoute({ address: A, hasProvider: false, unlocked: false }), 'reconnect');
  // A backend key alone does not make the wallet live.
  assert.equal(walletRoute({ address: A, hasProvider: false, unlocked: true }), 'reconnect');
});

test('walletRoute: connected but no trading key -> enable; everything in place -> menu', () => {
  assert.equal(walletRoute({ address: A, hasProvider: true, unlocked: false }), 'enable');
  assert.equal(walletRoute({ address: A, hasProvider: true, unlocked: true }), 'menu');
});

test('goToWallet dispatches exactly the event for the route', () => {
  const seen: string[] = [];
  const names = Object.values(WALLET_EVENTS);
  const on = (e: Event) => seen.push(e.type);
  for (const n of names) target.addEventListener(n, on);
  try {
    goToWallet({ address: null, hasProvider: false, unlocked: false });
    goToWallet({ address: A, hasProvider: false, unlocked: false });
    goToWallet({ address: A, hasProvider: true, unlocked: false });
    goToWallet({ address: A, hasProvider: true, unlocked: true });
  } finally {
    for (const n of names) target.removeEventListener(n, on);
  }
  assert.deepEqual(seen, [
    WALLET_EVENTS.connect, // connect
    WALLET_EVENTS.connect, // reconnect is the same modal
    WALLET_EVENTS.enableTrading,
    WALLET_EVENTS.menu,
  ]);
});

test('sameAddress: case-insensitive, and null never matches', () => {
  assert.equal(sameAddress(A, A.toLowerCase()), true);
  assert.equal(sameAddress(A, A.replace(/1$/, '2')), false);
  assert.equal(sameAddress(null, null), false);
  assert.equal(sameAddress(A, undefined), false);
});

test('pending store: set/get, and a repeated value is a no-op', () => {
  assert.equal(getAccountPending(), null);
  setAccountPending('connect');
  assert.equal(getAccountPending(), 'connect');
  setAccountPending('connect');
  assert.equal(getAccountPending(), 'connect');
  setAccountPending(null);
  assert.equal(getAccountPending(), null);
});
