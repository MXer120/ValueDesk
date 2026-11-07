/**
 * sodexPeek (valuedesk/sodex/traderCore.ts): a copy card's SoDEX figures from 3 reads - the same
 * curve and last activity buildSodexProfile gives, and `undefined` where only the profile can say it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSodexProfile, sodexPeek, type SodexTraderIo } from '../src/valuedesk/sodex/traderCore.js';
import type { PortfolioChart } from '../src/valuedesk/sodex/mappers.js';

const A = '0x' + '5'.repeat(40);
const NOW = Date.now();
const H = 3_600_000;

const chart = (window: string, n: number, base = 1000): PortfolioChart => ({
  account_id: 7, window, market_type: 'all', total_pnl_usd: String(n * 3), roi: '0.01',
  chart: Array.from({ length: n }, (_, i) => ({ ts_ms: NOW - (n - i) * H, account_value_usd: String(base + i), pnl_usd: String(i * 3 - 2), roi: '0' })),
});

function stubIo(o: { windowPoints?: number; aid?: number; cooling?: boolean } = {}) {
  const asked: string[] = [];
  const io = {
    perpsState: async () => { asked.push('perpsState'); return { aid: o.aid ?? 7, av: '1000', P: [{ s: 'BTC-USD', sz: '0.1', ep: '100000', ut: NOW - 5 * H }] }; },
    spotState: async () => { asked.push('spotState'); return { aid: o.aid ?? 7, B: [] }; },
    markPrices: async () => { asked.push('markPrices'); return []; },
    spotTickers: async () => { asked.push('spotTickers'); return []; },
    closedPositions: async () => { asked.push('closedPositions'); return [{ symbol: 'ETH-USD', realizedPnL: '5', createdAt: NOW - 9 * H, updatedAt: NOW - 2 * H }]; },
    tradesPage: async () => [],
    portfolioChart: async (_aid: number, w: string) => { asked.push(`chart ${w}`); return chart(w, w === '30D' ? (o.windowPoints ?? 30) : w === '1Y' ? 300 : 24); },
    lbRank: async (w: string) => { asked.push(`lbRank ${w}`); return { found: false } as never; },
    coolingDown: () => o.cooling ?? false,
  } as unknown as SodexTraderIo;
  return { io, asked };
}

test('the card\'s curve and last activity are the profile\'s, from 3 reads instead of 13', async () => {
  const card = stubIo();
  const peek = await sodexPeek(card.io, A, '30d');
  const full = (await buildSodexProfile(stubIo().io, A))!;
  assert.ok(peek);
  assert.deepEqual(peek.equity['30d']!.map((p) => p.pnl), full.equity['30d']!.map((p) => p.pnl));
  assert.deepEqual(peek.equity['30d'], full.equity['30d']);
  assert.equal(peek.summary.lastActive, full.summary.lastActive);
  assert.equal(peek.summary.lastActive, NOW - 2 * H, 'the newest close, after the open position\'s update');
  assert.deepEqual(card.asked.sort(), ['chart 30D', 'closedPositions', 'perpsState']);
});

test('cooling down: no closed positions, the open position\'s update - as the profile', async () => {
  const peek = await sodexPeek(stubIo({ cooling: true }).io, A, '7d');
  const full = (await buildSodexProfile(stubIo({ cooling: true }).io, A))!;
  assert.equal(peek!.summary.lastActive, NOW - 5 * H);
  assert.equal(peek!.summary.lastActive, full.summary.lastActive);
  assert.deepEqual(peek!.equity['7d'], full.equity['7d']);
});

test('no account: null; a window chart under two points: undefined (the profile derives it from the 1Y chart)', async () => {
  assert.equal(await sodexPeek(stubIo({ aid: 0 }).io, A, '30d'), null);
  assert.equal(await sodexPeek(stubIo({ windowPoints: 1 }).io, A, '30d'), undefined);
});
