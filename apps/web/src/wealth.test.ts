/**
 * wealth.ts against samples of SoDEX's own answers (2026-11-05). Nothing leaves the machine.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchFundDetails, fetchFunds, fetchMaintenance, fetchMarkets, fetchPnl, fetchPnlHistory, fetchPositions, fetchPriceHistory,
  WEALTH_MAINTENANCE_PATH, fundIdFromPath, groupOf, isEmptyHolding, isVault, joinFunds, leadReturn, numOrNull, ratePct, seriesOf,
  sortRows, tradeHref, yieldBasisLabel, type WealthFund, type WealthQuote,
} from './wealth';

const FUNDS: WealthFund[] = [
  { fundId: 'CXMT', name: 'CXMT', fundType: 'escrow_vault', fundStatus: 'live', nav: '6.33', aum: '22493.68', share: { coin: 'aCXMT' } },
  { fundId: 'Morpho-Earn', name: 'SoSoValue x Unified Labs USDC', fundType: 'bridged_vault', fundStatus: 'live', share: { coin: 'vsoUSDC' } },
  { fundId: 'vQQQ', name: 'QQQ Fund', fundType: 'clob', fundStatus: 'live', share: { coin: 'vQQQ' }, spot: { symbol: 'vQQQ_vUSDC', symbolId: 41, displayName: 'QQQ/USDC' } },
  { fundId: 'vBOXX', name: 'vBOXX Fund', fundType: 'clob', spot: { symbol: 'vBOXX_vUSDC' } },
  { fundId: 'vSMH', name: 'vSMH Fund', fundType: 'clob', spot: { symbol: 'vSMH_vUSDC' } },
];

const QUOTES: WealthQuote[] = [
  { fundId: 'Morpho-Earn', symbol: 'soUSDC', fundType: 'bridged_vault', price: '1.0074', roi24h: '0.0137', apy24h: '5.15', apy7d: '5.92', apy1M: '5.03', yieldBasis: 'net_excluding_rewards' },
  { fundId: 'CXMT', symbol: 'CXMT', price: '6.38', roi24h: '-3.53', roi1M: '-22.37', roiInception: '-13.2', apy7d: '-33.97' },
  { fundId: 'vQQQ', symbol: 'QQQ', price: '646.4', roi24h: '-6.58', roi1Y: '3.7', apy7d: '-99.49' },
];

test('reads: each path as documented, through the injected reader', async () => {
  const paths: string[] = [];
  const read = async <T,>(p: string): Promise<T> => { paths.push(p); return (p.endsWith('/markets') ? { quotes: QUOTES } : p.endsWith('/funds') ? FUNDS : { points: [], positions: [], totals: [], entries: [] }) as T; };
  const addr = '0xabc';
  assert.equal((await fetchFunds(read)).length, 5);
  assert.equal((await fetchMarkets(read)).length, 3);
  await fetchPriceHistory('Morpho-Earn', '1Y', read);
  await fetchPositions(addr, read);
  await fetchPnl(addr, read);
  await fetchFundDetails(addr, read);
  await fetchPnlHistory(addr, '1M', read);
  assert.deepEqual(paths, [
    '/api/v1/wealth/funds',
    '/api/v1/wealth/markets',
    '/api/v1/wealth/funds/Morpho-Earn/price-history?interval=1d&range=1Y',
    '/api/v1/wealth/users/0xabc/positions',
    '/api/v1/wealth/users/0xabc/pnl',
    '/api/v1/wealth/users/0xabc/fund-details',
    '/api/v1/wealth/users/0xabc/pnl-history?interval=1d&range=1M',
  ]);
});

test('reads: an answer missing its list comes back as an empty list', async () => {
  const empty = async <T,>(): Promise<T> => ({}) as T;
  assert.deepEqual(await fetchMarkets(empty), []);
  assert.deepEqual((await fetchPnl('0x1', empty)).positions, []);
  assert.deepEqual((await fetchFundDetails('0x1', empty)).entries, []);
});

test('numOrNull: zero is a figure, a missing field is not', () => {
  assert.equal(numOrNull('0'), 0);
  assert.equal(numOrNull('-3.5'), -3.5);
  assert.equal(numOrNull(undefined), null);
  assert.equal(numOrNull(''), null);
  assert.equal(numOrNull('abc'), null);
});

test('groups follow SoDEX page, which is not the fund type', () => {
  assert.equal(groupOf('vSMH', 'clob'), 'specialty');
  assert.equal(groupOf('vBOXX', 'clob'), 'stable');
  assert.equal(groupOf('vQQQ', 'clob'), 'curated');
  assert.equal(groupOf('CXMT', 'escrow_vault'), 'specialty');
  assert.equal(groupOf('Morpho-Earn', 'bridged_vault'), 'stable');
  // A fund SoDEX adds tomorrow falls back on its type.
  assert.equal(groupOf('NEW1', 'escrow_vault'), 'specialty');
  assert.equal(groupOf('NEW2', 'bridged_vault'), 'stable');
  assert.equal(groupOf('NEW3', 'clob'), 'curated');
});

test('joinFunds: type from /funds when /markets lacks it; a fund with no quote stays, with none', () => {
  const rows = joinFunds(FUNDS, QUOTES);
  const qqq = rows.find((r) => r.fundId === 'vQQQ')!;
  assert.equal(qqq.fundType, 'clob');
  assert.equal(qqq.name, 'US Tech 100');
  assert.equal(qqq.apiName, 'QQQ Fund');
  assert.equal(qqq.quote?.price, '646.4');
  assert.equal(rows.find((r) => r.fundId === 'vBOXX')!.quote, null);
  const onlyQuote = joinFunds([], [{ fundId: 'ZZZ', fundType: 'clob' }])[0]!;
  assert.equal(onlyQuote.name, 'ZZZ');
  assert.equal(onlyQuote.group, 'curated');
});

test('sortRows: SoDEX page order, group by group', () => {
  assert.deepEqual(sortRows(joinFunds(FUNDS, QUOTES)).map((r) => r.fundId), ['CXMT', 'vSMH', 'vQQQ', 'Morpho-Earn', 'vBOXX']);
});

test('leadReturn: picks what exists, never fills in', () => {
  const rows = joinFunds(FUNDS, QUOTES);
  const at = (id: string) => rows.find((r) => r.fundId === id)!;
  assert.deepEqual(leadReturn(at('Morpho-Earn')), { label: '7D APY', value: 5.92, annualised: true });
  assert.deepEqual(leadReturn(at('vQQQ')), { label: '1-year return', value: 3.7, annualised: false });
  assert.deepEqual(leadReturn(at('CXMT')), { label: 'Since inception', value: -13.2, annualised: false });
  assert.equal(leadReturn(at('vBOXX')), null);
});

test('yieldBasisLabel: words for the known basis, nothing for none', () => {
  assert.equal(yieldBasisLabel('net_excluding_rewards'), 'Net, excluding rewards');
  assert.equal(yieldBasisLabel('gross_apy'), 'gross apy');
  assert.equal(yieldBasisLabel(undefined), null);
});

test('tradeHref: spot link for a clob fund, none for a vault', () => {
  assert.equal(tradeHref(FUNDS[2]), '/trade?symbol=vQQQ_vUSDC');
  assert.equal(tradeHref(FUNDS[0]), null);
  assert.equal(tradeHref({ fundId: 'x', name: 'x', fundType: 'clob' }), null);
  assert.equal(isVault(FUNDS[0]), true);
  assert.equal(isVault(FUNDS[2]), false);
  assert.equal(isVault(null), false);
});

test('ratePct: 18-decimal fixed point', () => {
  assert.equal(ratePct('36500000000000000'), 3.65);
  assert.equal(ratePct('0'), 0);
  assert.equal(ratePct(undefined), null);
});

test('seriesOf: oldest first, unreadable points dropped', () => {
  const s = seriesOf([{ ts: '2026-02-01T00:00:00Z', close: '2' }, { ts: 'nope', close: '1' }, { ts: '2026-01-01T00:00:00Z', close: '1' }, { ts: '2026-03-01T00:00:00Z', close: '' }], (p) => p.close);
  assert.deepEqual(s.map((p) => p[1]), [1, 2]);
});

test('fundIdFromPath', () => {
  assert.equal(fundIdFromPath('/wealth'), null);
  assert.equal(fundIdFromPath('/wealth/'), null);
  assert.equal(fundIdFromPath('/wealth/vQQQ'), 'vQQQ');
  assert.equal(fundIdFromPath('/wealth/Morpho-Earn/'), 'Morpho-Earn');
  assert.equal(fundIdFromPath('/trade/vQQQ'), null);
});

test('isEmptyHolding', () => {
  assert.equal(isEmptyHolding(null), true);
  assert.equal(isEmptyHolding({ address: '0x', totalValue: '0', inFlightValue: '0', positions: [] }), true);
  assert.equal(isEmptyHolding({ address: '0x', totalValue: '5', positions: [] }), false);
  assert.equal(isEmptyHolding({ address: '0x', positions: [{ fundId: 'x' }] }), false);
});

test('maintenance: only an answer that says so is maintenance; a failed read is unknown', async () => {
  const answer = (ok: boolean, body: { status?: unknown; message?: unknown } | null) => async (path: string) => {
    assert.equal(path, WEALTH_MAINTENANCE_PATH);
    return { ok, body };
  };
  assert.deepEqual(await fetchMaintenance(undefined, answer(true, { status: 'NORMAL', message: '' })), { state: 'normal', message: null });
  assert.deepEqual(await fetchMaintenance(undefined, answer(true, { status: 'MAINTENANCE', message: 'Back at 14:00' })), { state: 'maintenance', message: 'Back at 14:00' });
  assert.deepEqual(await fetchMaintenance(undefined, answer(false, null)), { state: 'unknown', message: null });
  assert.deepEqual(await fetchMaintenance(undefined, answer(true, { status: 'ODD' })), { state: 'unknown', message: null });
  assert.deepEqual(await fetchMaintenance(undefined, async () => { throw new Error('offline'); }), { state: 'unknown', message: null });
});
