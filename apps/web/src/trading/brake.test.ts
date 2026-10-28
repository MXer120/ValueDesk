/**
 * The operator's emergency brake as the web app reads it from /api/health
 * (trading/config.ts): it switches trading off whatever the build says -
 * VITE_ALLOW_MAINNET_TRADING included - and only the brake's own switches count.
 *   npx tsx --test src/trading/brake.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { brakeOf, configureFromHealth, onlyBrakeStops, tradingConfig, writesOffMessage } from './config';
import { isOpening } from './legalGate';

test('brake: off unless /api/health names a switch that is on', () => {
  assert.equal(brakeOf(undefined), null);
  assert.equal(brakeOf(null), null);
  assert.equal(brakeOf({ trading: false, copies: false, algos: false, reason: 'x' }), null);
  assert.deepEqual(brakeOf({ trading: true, reason: ' Investigating. ' }), { trading: true, copies: false, algos: false, reason: 'Investigating.' });
  assert.match(brakeOf({ copies: true })!.reason, /paused/);
});

test('brake: trading on the brake is off even where the build allows mainnet writes, and says why', () => {
  configureFromHealth({ network: 'mainnet', mainnetWritesAllowed: true });
  assert.equal(tradingConfig().writesAllowed, true);
  configureFromHealth({ network: 'mainnet', mainnetWritesAllowed: true, brake: { trading: true, copies: true, algos: true, reason: 'Investigating a fill problem.' } });
  assert.equal(tradingConfig().writesAllowed, false);
  assert.equal(writesOffMessage(), 'ValueDesk paused trading: Investigating a fill problem.');
  // Only copies paused: browser orders still go.
  configureFromHealth({ network: 'mainnet', mainnetWritesAllowed: true, brake: { trading: false, copies: true, algos: false, reason: 'x' } });
  assert.equal(tradingConfig().writesAllowed, true);
  assert.equal(tradingConfig().brake?.copies, true);
  // Lifted.
  configureFromHealth({ network: 'mainnet', mainnetWritesAllowed: true, brake: null });
  assert.equal(tradingConfig().writesAllowed, true);
  assert.equal(tradingConfig().brake, null);
});

test('brake: closing, cancelling and withdrawing still go - only what opens or increases a position is refused', () => {
  configureFromHealth({ network: 'mainnet', mainnetWritesAllowed: true, brake: { trading: true, copies: false, algos: false, reason: 'Incident.' } });
  assert.equal(tradingConfig().writesAllowed, false);
  assert.equal(onlyBrakeStops(), true, 'the brake alone: risk-reducing actions may be signed');
  // What signAndSend checks under the brake (actions.ts).
  const leg = (reduceOnly: boolean) => ({ type: 'newOrder', engine: 'perps', params: { orders: [{ side: 1, reduceOnly }] } }) as never;
  assert.equal(isOpening(leg(true)), false, 'a reduce-only close goes');
  assert.equal(isOpening(leg(false)), true, 'an opening order is refused');
  assert.equal(isOpening({ type: 'cancelOrder', engine: 'perps', params: {} } as never), false, 'a cancel goes');
  // The deployment itself switched off: nothing goes, brake or not.
  configureFromHealth({ network: 'mainnet', mainnetWritesAllowed: false, brake: { trading: true, copies: false, algos: false, reason: 'Incident.' } });
  assert.equal(onlyBrakeStops(), false);
  configureFromHealth({ network: 'mainnet', mainnetWritesAllowed: true, brake: null });
  assert.equal(onlyBrakeStops(), false, 'no brake: the normal path');
});
