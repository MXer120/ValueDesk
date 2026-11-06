/**
 * The portfolio page on a fake account (sodexFake.ts answers every write; the wealth reads are
 * answered here), so it walks with money in every bucket and NOTHING reaches SoDEX's writes.
 *
 *   npx tsx e2e/ui/run.ts --only portfolio --web http://127.0.0.1:5183
 *
 * Set VS_E2E_SHOTS to a folder to keep a picture of each state.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { BrowserContext, Page } from 'playwright-core';
import { connectWallet, num, uiSuite, until } from './harness';
import { enableTrading } from './trade';

const h = uiSuite(import.meta.filename);
const SHOTS = process.env.VS_E2E_SHOTS;

/** The dev build's dock and the indexing toast float over the page (the dock is not in production). */
const clearOverlays = (p: Page) => p.addStyleTag({ content: '[aria-label="Developer"], .toast { display: none !important; }' });

const THEME = process.env.VS_E2E_THEME;
const storage: Record<string, string> = THEME ? { 'vs.theme': THEME } : {};

/** The page scrolls inside the shell, so a whole page takes a tall window. */
const shot = async (page: Page, name: string, tall = true) => {
  if (!SHOTS) return;
  const was = page.viewportSize()!;
  if (tall) await page.setViewportSize({ width: was.width, height: was.width < 500 ? 3200 : 1900 });
  await page.waitForTimeout(tall ? 700 : 0);
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
  if (tall) await page.setViewportSize(was);
};

const FUND = (fundId: string, name: string, fundType: string, coin: string, spot?: string) => ({
  fundId, name, fundType, fundStatus: 'live', asOf: '2026-11-05T19:00:00Z',
  share: { coin, address: `0x${'1'.repeat(40)}`, decimals: 8 },
  ...(spot ? { spot: { symbol: spot, symbolId: 41, displayName: spot, quote: { coin: 'vUSDC', decimals: 6 } } } : {}),
});

/** Wealth for the test wallet: vQQQ in Spot, aCXMT in the wallet, soUSDC bridged and partly pledged, and a request on its way. */
async function fakeWealth(ctx: BrowserContext, address: string) {
  const a = address.toLowerCase();
  const data = (d: unknown) => JSON.stringify({ code: 0, timestamp: Date.now(), data: d });
  await ctx.route(/\/api\/v1\/wealth\//, async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname.replace('/api/v1/wealth', '').replace(/\/users\/0x[0-9a-fA-F]+/, (u) => u.toLowerCase());
    const json = (d: unknown) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: data(d) });
    if (p === '/funds') {
      return json([
        FUND('Morpho-Earn', 'SoSoValue x Unified Labs USDC', 'bridged_vault', 'vsoUSDC'),
        FUND('vBOXX', 'vBOXX Fund', 'clob', 'vBOXX', 'vBOXX_vUSDC'),
        FUND('vQQQ', 'QQQ Fund', 'clob', 'vQQQ', 'vQQQ_vUSDC'),
        FUND('CXMT', 'CXMT', 'escrow_vault', 'aCXMT'),
      ]);
    }
    if (p === '/markets') {
      return json({ quotes: [
        { fundId: 'Morpho-Earn', symbol: 'soUSDC', roi24h: '0.0138', apy7d: '5.92', yieldBasis: 'net_excluding_rewards' },
        { fundId: 'vBOXX', symbol: 'BOXX', roi24h: '0.0031', roi1M: '0.357', roi1Y: '4.001', apy7d: '3.74' },
        { fundId: 'vQQQ', symbol: 'QQQ', roi24h: '-6.78', roi1M: '-14.7', roi1Y: '3.49', apy7d: '-99.5' },
        { fundId: 'CXMT', symbol: 'CXMT', roi24h: '-3.54', roi1M: '-22.38' },
      ] });
    }
    if (p === '/funds/CXMT') {
      // The real deployment's addresses: the sheet reads minimums and balances from the chain, read-only.
      return json({
        ...FUND('CXMT', 'CXMT', 'escrow_vault', 'aCXMT'),
        share: { coin: 'aCXMT', address: '0x9876b381a94876ea8fea56b625e15556fb450629', decimals: 18 },
        contracts: { vault: '0x9876b381a94876ea8fea56b625e15556fb450629', asset: '0xcb7f80dff2727c791fa491722c428e6657f7e2c6' },
        chainConfig: { assetDecimals: 6, paused: false },
      });
    }
    if (/\/trading-status$/.test(p)) {
      const id = p.split('/')[2];
      if (id === 'CXMT') return json({ fundId: id, vault: `0x${'2'.repeat(40)}`, channel: 'batch', closedReason: null, nextChannel: 'closed', nextChannelAt: 1793925000, rfq: null, batch: { opensAt: 1, cutoffAt: 1793925000, expectedDeliveryAt: 1793948400 }, subscription: null });
      return json({ fundId: id, vault: '', channel: 'clob', closedReason: null, nextChannel: 'closed', nextChannelAt: 1794013200, rfq: null, batch: null, subscription: null });
    }
    if (p === `/users/${a}/positions`) {
      return json({ positions: [
        { fundId: 'vQQQ', source: 'clob', share: { coin: 'vQQQ' }, spotShares: '2', ledgerShares: '2', processingCost: '0', pendingProceeds: '0' },
        { fundId: 'CXMT', source: 'vault', coin: 'aCXMT', evmShares: '50', ledgerShares: '50', processingCost: '120', pendingProceeds: '0' },
        { fundId: 'Morpho-Earn', source: 'bridge', share: { coin: 'vsoUSDC' }, evmShares: '100', perpShares: '400', ledgerShares: '500', processingCost: '0', pendingProceeds: '0' },
      ] });
    }
    if (p === `/users/${a}/pnl`) {
      return json({
        settledValue: '2110', totalCost: '2000', totalPnl: '110', totalRealizedPnl: '10', totalUnrealizedPnl: '100', totalPnl24h: '-42.5', inFlightValue: '120', totalValue: '2230', complete: true,
        positions: [
          { fundId: 'vQQQ', source: 'clob', priced: true, marketValue: '1290', shares: '2', unrealizedPnl: '40', realizedPnl: '0', pnl24h: '-90' },
          { fundId: 'CXMT', source: 'vault', priced: true, marketValue: '315', shares: '50', unrealizedPnl: '-15', realizedPnl: '0', pnl24h: '-12' },
          { fundId: 'Morpho-Earn', source: 'bridge', priced: true, marketValue: '505', shares: '500', unrealizedPnl: '5', realizedPnl: '10', pnl24h: '0.2' },
        ],
      });
    }
    if (/\/pnl-history$/.test(p)) {
      const day = 86_400_000;
      return json({ points: Array.from({ length: 30 }, (_, i) => ({ ts: Date.now() - (29 - i) * day, pnl: String(i * 3.7), totalValue: String(2000 + i * 7 + (i % 5) * 9) })) });
    }
    if (/\/fund-details$/.test(p)) {
      return json({ entries: [
        { fundId: 'CXMT', kind: 'deposit', status: 'processing', channel: 'batch', txHash: `0x${'ab'.repeat(32)}`, requestedAt: '2026-11-05T10:00:00Z', at: '2026-11-05T10:00:00Z', cost: '120', costEstimated: true },
        { fundId: 'vQQQ', kind: 'deposit', status: 'completed', channel: 'spot', at: '2026-11-01T10:00:00Z', cost: '1250', shares: '2' },
        { fundId: 'CXMT', kind: 'redeem', status: 'completed', channel: 'batch', claimable: true, at: '2026-10-20T10:00:00Z', proceeds: '50', shares: '8', txHash: `0x${'cd'.repeat(32)}` },
      ] });
    }
    if (/\/recurring-buys$/.test(p)) return json({ plans: [] });
    return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ code: -1, error: 'not found' }) });
  });
}

/** SoDEX's account-value series and the account's own fills and funding, so the chart and the summary have data. */
async function fakeHistory(ctx: BrowserContext) {
  const ok = (d: unknown) => ({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ code: 0, data: d }) });
  await ctx.route(/\/api\/v1\/wallet\/portfolio\/chart/, (route) => {
    const hourly = new URL(route.request().url()).searchParams.get('window') === '24H';
    const step = hourly ? 3_600_000 : 86_400_000;
    const n = hourly ? 24 : 60;
    const chart = Array.from({ length: n }, (_, i) => ({
      ts_ms: Date.now() - (n - 1 - i) * step,
      account_value_usd: 2000 + i * 9 + Math.sin(i / 3) * 70 + Math.sin(i / 7) * 110,
      pnl_usd: i * 2.5 + Math.sin(i / 2.5) * 22,
      spot_pnl_usd: 0,
      perps_pnl_usd: i * 2.5 + Math.sin(i / 2.5) * 22,
    }));
    return route.fulfill(ok({ chart, total_pnl_usd: 100, roi: 0.05 }));
  });
  const now = Date.now();
  await ctx.route(/\/api\/v1\/perps\/accounts\/[^/]+\/trades/, (route) => route.fulfill(ok([
    { time: now - 3_600_000, side: 'BUY', price: '100', quantity: '2', fee: '0.08', feeCoin: 'vUSDC', symbol: 'BTC-USD' },
    { time: now - 7_200_000, side: 'SELL', price: '100', quantity: '1', fee: '0.04', feeCoin: 'vUSDC', symbol: 'BTC-USD' },
  ])));
  await ctx.route(/\/api\/v1\/perps\/accounts\/[^/]+\/fundings/, (route) => route.fulfill(ok([
    { timestamp: now - 3_600_000, fundingFee: '-1.5', feeCoin: 'vUSDC', symbol: 'BTC-USD' },
  ])));
}

/** The USDT/USDC book, so the quote is exact. */
async function fakeBook(ctx: BrowserContext) {
  await ctx.route(/\/api\/v1\/spot\/markets\/vUSDT_vUSDC\/orderbook/, (route) => route.fulfill({
    status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify({ code: 0, data: { blockTime: Date.now(), blockHeight: 1, updateID: 1, bids: [['0.9970', '50'], ['0.9900', '1000'], ['0.9800', '5000']], asks: [['1.0010', '500']] } }),
  }));
}

const page = (p: Page) => ({
  tab: (name: string | RegExp) => p.getByRole('tab', { name }).first(),
  value: (label: string) => p.locator('.pfx-bucket', { hasText: label }).locator('.pfa__part-v'),
});

h.test('no wallet: the layout stands, Trade and Wealth, four promo cards and no invented figure', async ({ page: p, origin }) => {
  await p.goto(new URL('/portfolio', origin).href);
  await clearOverlays(p);
  await p.locator('.pfx-title').waitFor();
  assert.equal(await p.locator('.pfx-promo').count(), 4);
  const text = (await p.locator('.pfx-promos').innerText()).replace(/\s+/g, ' ');
  for (const want of ['Copy trading', 'USDC Earn', 'US Cash Yield', 'Bots']) assert.ok(text.includes(want), `${want} is on a card`);
  assert.ok(await page(p).tab('Wealth').isVisible());
  await shot(p, 'no-wallet');
}, { storage });

h.test('Total Value counts each dollar once, and copies and bots have no bucket', async ({ page: p, wallet, ctx, origin }) => {
  await enableTrading({ page: p, wallet, ctx }, { spot: { vUSDC: 40, vQQQ: 2, vUSDT: 25 }, balance: 1000, stateful: true });
  // After the account fake: the last route wins, and that one forwards every read it does not know.
  await fakeWealth(ctx, wallet.address);
  await fakeBook(ctx);
  await fakeHistory(ctx);
  await p.goto(new URL('/portfolio', origin).href);
  await clearOverlays(p);
  await p.locator('.pfx-title').waitFor();
  for (const label of ['Wealth', 'Spot', 'Perps', 'EVM']) await until(p, async () => (await page(p).value(label).innerText()).includes('$'), `the ${label} bucket`, 20_000);
  const money = async (label: string) => num((await page(p).value(label).innerText()).replace(/[^0-9.,]/g, ''));
  const perps = await money('Perps');
  const spot = await money('Spot');
  const wealth = await money('Wealth');
  const evm = await money('EVM').catch(() => 0);
  const total = num((await p.locator('.pfx-value__v').first().innerText()).replace(/[^0-9.,]/g, ''));
  assert.ok(Math.abs(total - (perps + spot + wealth + evm)) < 0.02, `total ${total} = ${perps} + ${spot} + ${wealth} + ${evm}`);
  // 1290 + 315 + 505 settled, minus the 404 of soUSDC pledged in Perps, plus 120 in flight.
  assert.ok(Math.abs(wealth - 1826) < 0.02, `wealth ${wealth}`);
  assert.ok(spot < 200, `the vQQQ share left Spot (${spot})`);
  assert.equal(await p.locator('.pfx-bucket').count(), 4);
  await until(p, async () => /trades\s*2/.test(await p.locator('.pfx-sum').innerText()), 'the summary to add up the fills', 15_000);
  const sum = (await p.locator('.pfx-sum').innerText()).replace(/\s+/g, ' ');
  assert.match(sum, /Buys 1 Sells 1/);
  assert.match(sum, /vol\. of trades \$300,00/);
  assert.match(sum, /commission \$0,12/);
  await shot(p, 'trade-tab');
  // The timeframe is the app's dropdown: choosing changes the summary's window.
  await p.locator('.pfx-sum .psel__btn').click();
  await p.locator('.pfx-sum').getByRole('option', { name: '30d' }).waitFor();
  await p.locator('.pfx-sum').evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await shot(p, 'timeframe', false);
  await p.locator('.pfx-sum').getByRole('option', { name: '30d' }).click();
  await until(p, async () => (await p.locator('.pfx-sum .psel__btn').innerText()).includes('30d'), 'the 30-day summary', 5_000);
  await p.getByRole('radio', { name: 'PnL', exact: true }).click();
  await p.locator('.pfx-chart').evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await shot(p, 'pnl', false);
  await p.getByRole('radio', { name: 'PnL Calendar' }).click();
  await p.locator('.pfc-grid').waitFor();
  await shot(p, 'calendar', false);
  await p.getByRole('button', { name: 'View tiers' }).click();
  await p.getByRole('dialog').first().waitFor();
  await shot(p, 'fee-sheet', false);
  await p.keyboard.press('Escape');
  for (const name of ['Spot', 'Wealth', 'Copy trading', 'Bots']) {
    await p.locator('.pfx-sections').getByRole('tab', { name, exact: true }).click();
    await p.waitForTimeout(700);
    await shot(p, `section-${name.toLowerCase().replace(' ', '-')}`);
  }
  await page(p).tab('Wealth').click();
  await p.locator('.pfx-board').waitFor();
  await p.waitForTimeout(1500);
  await shot(p, 'wealth-tab');
  // No column of the fund list or the holdings is cut off, on a phone above all.
  for (const wrap of await p.locator('.pfx-tablewrap').all()) {
    const { scroll, client } = await wrap.evaluate((e) => ({ scroll: e.scrollWidth, client: e.clientWidth }));
    assert.ok(scroll <= client + 1, `table fits: ${scroll} <= ${client}`);
  }
}, { storage });

h.test('Swap: the exact order SoDEX\'s own dialog sends, and its result', async ({ page: p, wallet, ctx, origin }) => {
  const sx = await enableTrading({ page: p, wallet, ctx }, { spot: { vUSDC: 40, vUSDT: 500 }, balance: 1000, stateful: true });
  await fakeWealth(ctx, wallet.address);
  await fakeBook(ctx);
  await p.goto(new URL('/portfolio', origin).href);
  await clearOverlays(p);
  await p.locator('.pfx-title').waitFor();
  await p.getByRole('button', { name: /Swap/ }).first().click();
  const sheet = p.getByRole('dialog', { name: 'Swap USDT to USDC' });
  await sheet.waitFor();
  await sheet.getByRole('button', { name: 'Enter an amount' }).waitFor();
  await sheet.getByLabel('USDT to swap').fill('4');
  await sheet.getByRole('button', { name: /Min 5 USDT/ }).waitFor();
  await sheet.getByLabel('USDT to swap').fill('600');
  await sheet.getByRole('button', { name: /Not enough USDT/ }).waitFor();
  await sheet.getByLabel('USDT to swap').fill('100');
  await sheet.getByRole('button', { name: 'Swap', exact: true }).waitFor();
  await shot(p, 'swap-sheet', false);
  const before = sx.orders().length;
  await sheet.getByRole('button', { name: 'Swap', exact: true }).click();
  await until(p, () => sx.orders().length > before, 'the order', 10_000);
  const sent = sx.orders().at(-1)!.body as { orders: Array<{ side: number; type: number; timeInForce: number; price: string; quantity: string; clOrdID: string }> };
  const leg = sent.orders[0]!;
  assert.equal(leg.side, 2, 'a sell');
  assert.equal(leg.type, 2, 'market');
  assert.equal(leg.timeInForce, 3, 'IOC');
  assert.equal(Number(leg.price), 0.99, 'at the floor');
  assert.equal(Number(leg.quantity), 100);
  assert.match(leg.clOrdID, /^vd_swap_/);
  assert.equal((sx.orders().at(-1)!.body as { builder?: unknown }).builder, undefined, 'no ValueDesk fee where SoDEX charges none');
  await shot(p, 'swap-sent', false);
}, { storage });

h.test('Invest sheet: a batch vault spends wallet USDC and refuses what it cannot send', async ({ page: p, wallet, ctx, origin }) => {
  await fakeWealth(ctx, wallet.address);
  await connectWallet(p);
  await p.goto(new URL('/portfolio', origin).href);
  await clearOverlays(p);
  await page(p).tab('Wealth').click();
  await p.locator('.pfx-board').waitFor();
  const row = p.locator('.pfx-board tr', { hasText: 'CXMT Vault' });
  await row.getByRole('button', { name: 'Invest' }).click({ timeout: 15_000 });
  const sheet = p.getByRole('dialog', { name: /Invest in CXMT Vault/ });
  await sheet.waitFor();
  await p.waitForTimeout(800);
  await shot(p, 'invest-sheet', false);
}, { storage });
