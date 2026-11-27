import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AlgoView } from '@copy-engine';
import { cardView, pctSigned, usdShort, usdSigned, xIntent, type CardOpts } from './card';
import { botCard, botLink, copyCard, portfolioCard, positionCard, tradeCard } from './shareData';

const ON: Pick<CardOpts, 'amounts' | 'second' | 'wallet' | 'code'> = { amounts: true, second: true, wallet: false, code: null };
const W = '0x00000000000000000000000000000000000000a1';

test('numbers: signed with a real minus, short dollars, percent places', () => {
  assert.equal(usdSigned(12_480.2), '+$12,480');
  assert.equal(usdSigned(-842.1), '−$842.10');
  assert.equal(usdShort(2_140_000), '$2.14M');
  assert.equal(usdShort(640_000), '$640K');
  assert.equal(pctSigned(1.846), '+184.6%');
  assert.equal(pctSigned(-0.014), '−1.4%');
});

const trade = () => tradeCard({ symbol: 'BTC-USD', side: 'long', leverage: 20, entry: 94_210.5, exit: 102_905, size: 0.78, unit: 'BTC', pnl: 12_480.2, roe: 1.846, opened: 0, closed: 1_800_000_000_000, wallet: W })!;

test('a trade: the return leads, the dollars under it; hiding dollars takes every dollar figure off', () => {
  const v = cardView(trade(), ON);
  assert.equal(v.big, '+184.6%');
  assert.equal(v.sub, '+$12,480');
  assert.ok(v.facts.some((f) => f.label === 'Size'));
  const hid = cardView(trade(), { ...ON, amounts: false });
  assert.equal(hid.sub, null);
  assert.ok(!hid.facts.some((f) => f.kind === 'usd'), 'no size, no dollars');
  const noPrices = cardView(trade(), { ...ON, second: false });
  assert.ok(!noPrices.facts.some((f) => f.kind === 'price'));
});

test('the wallet only when turned on; the code only when given', () => {
  assert.ok(!cardView(trade(), ON).footLeft.includes('0x0000'));
  assert.ok(cardView(trade(), { ...ON, wallet: true }).footLeft.includes('0x0000…00a1'));
  assert.equal(cardView(trade(), ON).footRight, 'valuedesk.so');
  assert.equal(cardView(trade(), { ...ON, code: 'VALUEDESK' }).footRight, 'valuedesk.so · code VALUEDESK');
});

test('a copy card hides the trader behind the second switch', () => {
  const c = copyCard({ leader: '0x7a3f00000000000000000000000000000000091c2'.slice(0, 42), venue: 'Hyperliquid', pnl: 3_920, pct: 0.392, since: 1_800_000_000_000, multiplier: 1.5, orders: 212, realized: 1_000, paper: false, wallet: W })!;
  assert.match(cardView(c, ON).title, /^0x7a3f/);
  assert.equal(cardView(c, { ...ON, second: false }).title, 'A trader');
  assert.equal(c.link, 'https://valuedesk.so/copy', 'the link never carries the trader');
});

test('a position: unrealized at the mark, its link opens the market', () => {
  const p = positionCard({ symbol: 'ETH-USD', side: 'short', leverage: 10, entry: 3_412.6, mark: 3_380, size: 1.2, unit: 'ETH', upnl: 39.12, roe: 0.096, wallet: W })!;
  assert.equal(p.link, 'https://valuedesk.so/trade?symbol=ETH-USD');
  assert.ok(p.facts.some((f) => f.label === 'Mark'));
});

test('a portfolio card with dollars hidden says which way in words, from the same PnL', () => {
  const p = portfolioCard({ range: '7D', change: -120, ys: [0, -50, -120], trades: null, volume: null, value: 5_000, wallet: W });
  const v = cardView(p, { ...ON, amounts: false });
  assert.equal(v.big, 'In loss');
  assert.equal(v.bigTone, 'down');
  assert.ok(!v.facts.some((f) => f.kind === 'usd'));
});

const bot = (kind: 'mm' | 'grid', o: Partial<NonNullable<AlgoView['bot']>> = {}) => ({
  algo: {
    id: 'a1', owner: W, status: 'running', createdAt: 1_800_000_000_000, startedAt: 1_800_000_000_000, endedAt: null,
    spec: kind === 'mm'
      ? { kind: 'mm', symbol: 'ETH-USD', bot: true, paper: false, ref: 'binance', restMs: 10_000, offsetTicks: 0, skewTicks: 0, stillBps: 0, noFair: false }
      : { kind: 'grid', symbol: 'SOL-USD', bot: true, paper: false, levels: 20 },
    book: { series: [[1, 0, 0, 0], [2, 30_000, -4, 3], [3, 62_923, -10.09, 6]] },
  },
  bot: { netPnl: -10.09, volume: 62_923, costPerMillion: 160, fills: 92, makerShare: 1, ...o },
}) as unknown as AlgoView;

test('a market maker card leads with its volume and the cost; hidden dollars lead with the cost', () => {
  const c = botCard(bot('mm'), 1_800_000_000_000 + 3_600_000)!;
  assert.equal(c.kind, 'botvol');
  const v = cardView(c, ON);
  assert.equal(v.big, '$62,923');
  assert.equal(v.sub, '1.60 bp');
  const hid = cardView(c, { ...ON, amounts: false });
  assert.equal(hid.big, '1.60 bp');
  assert.ok(!hid.facts.some((f) => f.kind === 'usd'));
  assert.equal(c.chart?.type, 'volume');
  assert.match(c.when, /^Running 1h/);
});

test('a grid card leads with its net PnL; its link is one click from the same setup', () => {
  const v = bot('grid', { netPnl: 1_284 });
  const c = botCard(v)!;
  assert.equal(cardView(c, ON).big, '+$1,284');
  assert.equal(botLink(v), 'https://valuedesk.so/bots/new?market=SOL-USD&kind=gridv', 'the grid preset it is (20 levels: Tight)');
  assert.match(xIntent(c, { amounts: true }), /^https:\/\/x\.com\/intent\/post\?text=.*&url=https%3A%2F%2Fvaluedesk\.so%2Fbots%2Fnew/);
  assert.ok(!c.post({ amounts: false }).includes('$'), 'hidden dollars stay out of the post too');
});

test('a portfolio share says which chart and window it is (owner 2026-11-28: exactly what is selected)', () => {
  const pnl = cardView(portfolioCard({ range: '30D', change: 840, ys: [0, 300, 840], trades: null, volume: null, value: 9_000, wallet: W }), ON);
  assert.equal(pnl.bigLabel, 'PnL, last 30 days');
  const value = portfolioCard({ range: '7D', change: -3_059_300, ys: [0, -1, -3], trades: null, volume: null, value: 14_300_000, wallet: W, view: 'value', title: '0xca49…53c8 on Hyperliquid', label: 'Scan', link: 'https://valuedesk.so/scan?address=0xca49&venue=hyperliquid', foot: 'Hyperliquid' });
  const v = cardView(value, ON);
  assert.equal(v.bigLabel, 'Change in value, last 7 days');
  assert.equal(v.title, '0xca49…53c8 on Hyperliquid');
  assert.deepEqual(value.pills.map((x) => x.text), ['7D', 'Total value']);
  assert.match(value.link, /\/scan\?address=/);
  assert.equal(cardView(portfolioCard({ range: '14D', change: 1, ys: [0, 1], trades: null, volume: null, value: null, wallet: W }), ON).bigLabel, 'PnL, last 14 days');
});
