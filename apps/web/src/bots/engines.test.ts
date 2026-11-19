import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coinOf, engineOfSymbol, isBotSpot, marketLabel, twinOf } from './engines';
import { draftFor, draftOfSpec, specOf } from './presets';
import { parseAlgoSpec } from '@copy-engine';

// SoDEX's own names (spot list 2026-11-19).
const PERPS = ['BTC-USD', 'ETH-USD', 'SOL-USD', 'XAUT-USD', 'SOSO-USD', 'NVDA-USD'];
const SPOT = ['vBTC_vUSDC', 'vETH_vUSDC', 'vSOL_vUSDC', 'vXAUt_vUSDC', 'WSOSO_vUSDC', 'vUSDT_vUSDC', 'vDEFIssi_vUSDC'];

test('engine and coin of a market name, on both engines', () => {
  assert.equal(engineOfSymbol('BTC-USD'), 'perps');
  assert.equal(engineOfSymbol('vBTC_vUSDC'), 'spot');
  assert.equal(coinOf('BTC-USD'), 'BTC');
  assert.equal(coinOf('vBTC_vUSDC'), 'BTC');
  assert.equal(coinOf('vXAUt_vUSDC'), 'XAUT');
  assert.equal(coinOf('WSOSO_vUSDC'), 'SOSO');
  assert.equal(marketLabel('BTC-USD'), 'BTC');
  assert.equal(marketLabel('vBTC_vUSDC'), 'BTC/USDC');
  assert.equal(isBotSpot('vUSDT_vUSDC'), false, 'a stablecoin pair is no bot market');
});

test('the same coin on the other engine; none where SoDEX lists none', () => {
  assert.equal(twinOf('BTC-USD', 'spot', SPOT), 'vBTC_vUSDC');
  assert.equal(twinOf('vXAUt_vUSDC', 'perps', PERPS), 'XAUT-USD');
  assert.equal(twinOf('WSOSO_vUSDC', 'perps', PERPS), 'SOSO-USD');
  assert.equal(twinOf('NVDA-USD', 'spot', SPOT), null);
  assert.equal(twinOf('BTC-USD', 'perps', PERPS), 'BTC-USD', 'already there');
});

test('a spot bot is signed with its engine, no leverage, and a spot grid runs long', () => {
  const mm = { ...draftFor('maker', 'balanced', 'vBTC_vUSDC'), leverage: 5 };
  assert.equal(mm.engine, 'spot');
  const s = specOf(mm, 90_000);
  assert.equal(s.engine, 'spot');
  assert.equal(s.symbol, 'vBTC_vUSDC');
  assert.equal('leverage' in s, false, 'spot has no leverage');
  const g = specOf({ ...draftFor('grid', 'balanced', 'vETH_vUSDC'), gridDir: 'neutral' }, 3_000);
  assert.equal(g.direction, 'long');
  assert.equal(specOf(draftFor('grid', 'balanced', 'ETH-USD'), 3_000).engine, 'perps');
  // A running spot bot reads back as spot.
  const back = draftOfSpec(parseAlgoSpec({ ...specOf(draftFor('grid', 'balanced', 'vETH_vUSDC'), 3_000) }));
  assert.equal(back.engine, 'spot');
  assert.equal(back.symbol, 'vETH_vUSDC');
});
