/**
 * The operator's emergency brake as the web app reads it from /api/health
 * (trading/config.ts): it switches trading off whatever the build says -
 * VITE_ALLOW_MAINNET_TRADING included - and only the brake's own switches count.
 *   npx tsx --test src/trading/brake.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { brakeOf, configureFromHealth, tradingConfig, writesOffMessage } from './config';

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
