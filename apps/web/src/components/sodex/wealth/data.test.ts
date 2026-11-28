/** The Wealth versions' rules against made-up inputs. Nothing leaves the machine. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installViteStubs } from '../../macro/testEnv';

installViteStubs();
const { channelOf, expectedDelivery, headline, leftShort, pctText, usdCompact, val } = await import('./data');
const { pledgedValue } = await import('./parts');
const { setNumStyle } = await import('../../../numStyle');
setNumStyle('comma-dot');

const fund = (fundType: 'clob' | 'escrow_vault' | 'bridged_vault') => ({ fundType } as never);

test('headline: a yield fund leads with its 7-day APY; an ETF never does', () => {
  assert.deepEqual(headline(true, { fundId: 'x', apy7d: '5.17948511' }), { label: '7-day APY', short: 'APY', value: 5.17948511, kind: 'apy' });
  assert.equal(headline(false, { fundId: 'x', apy7d: '-86.6', roi1Y: '4.2', roi1M: '-9.9' }).label, '1-year return');
  assert.equal(headline(false, { fundId: 'x', apy7d: '61338.4', roi1M: '10.25' }).label, '1-month return');
  assert.equal(headline(false, { fundId: 'x' }).value, null);
});

test('numbers: percents and sizes in the app style, a true minus, a dash for nothing', () => {
  assert.equal(pctText(4.2064707), '+4.21%');
  assert.equal(pctText(-21.586931), '−21.59%');
  assert.equal(pctText(5.18, false), '5.18%');
  assert.equal(pctText(1374.29766759), '+1,374.30%');
  assert.equal(pctText(null), '—');
  assert.equal(usdCompact(215796.024318), '$215.8K');
  assert.equal(val(''), null);
  assert.equal(val('x'), null);
  assert.equal(leftShort(1_000 + 27 * 60_000, 1_000), '27m');
  assert.equal(leftShort(5 * 3_600_000 + 12 * 60_000, 0), '5h 12m');
  assert.equal(leftShort(2 * 86_400_000 + 4 * 3_600_000, 0), '2d 4h');
});

test('channel: what the fund allows now, with the batch cutoff in ms', () => {
  assert.equal(channelOf({ action: null, fund: fund('clob') }).label, 'Order book');
  assert.equal(channelOf({ action: { kind: 'trade', symbol: 'vQQQ_vUSDC' }, fund: fund('clob') }).tone, 'positive');
  const batch = channelOf({ action: { kind: 'batch', cutoffAt: 1795653000, deliveryAt: 1795676400 }, fund: fund('escrow_vault') });
  assert.equal(batch.at, 1795653000_000);
  assert.equal(batch.atLabel, 'Cutoff');
  // USDC Earn (bridged vault): ValueDesk sends the bridge order itself since 2026-11-28; other external funds stay on sodex.com.
  assert.equal(channelOf({ action: { kind: 'external', why: '' }, fund: fund('bridged_vault') }).label, 'Bridge, about a minute');
  assert.equal(channelOf({ action: { kind: 'external', why: '' }, fund: fund('escrow_vault') }).label, 'On sodex.com');
  assert.equal(channelOf({ action: { kind: 'closed', why: 'Market closed', nextAt: null }, fund: fund('clob') }).label, 'Trading temporarily unavailable');
});

test('expected delivery: only for a request inside the current batch window, never a guess', () => {
  const status = { batch: { opensAt: 1000, cutoffAt: 2000, expectedDeliveryAt: 3000 } } as never;
  const at = (s: number) => ({ fundId: 'CXMT', kind: 'deposit', status: 'processing', at: new Date(s * 1000).toISOString() });
  assert.equal(expectedDelivery(at(1500), status), 3_000_000);
  assert.equal(expectedDelivery(at(999), status), null);
  assert.equal(expectedDelivery(at(2000), status), null);
  assert.equal(expectedDelivery(at(1500), null), null);
});

test('pledged: the part of each holding sitting as Perps margin, at its market value', () => {
  const h = (marketValue: number | null, shares: number, perpShares: number) => ({ marketValue, shares, perpShares } as never);
  assert.equal(pledgedValue([h(7.071012, 7, 7)]), 7.071012);
  assert.equal(pledgedValue([h(100, 10, 4), h(null, 3, 3), h(50, 0, 0)]), 40);
  assert.equal(pledgedValue(null), 0);
});
