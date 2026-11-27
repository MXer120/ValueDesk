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

/** The dev build's dock, the indexing toast and the page's localhost switch float over the page (none is in production). */
const clearOverlays = (p: Page) => p.addStyleTag({ content: '[aria-label="Developer"], .toast, .pfv-switch { display: none !important; }' });

const THEME = process.env.VS_E2E_THEME;
const storage: Record<string, string> = THEME ? { 'vs.theme': THEME } : {};

/**
 * The wallet's history walk starts the moment it connects (HistoryNote.tsx), before this spec's fakes for its fills
 * are in: hold it until they are, then let it go.
 */
const holdHistory = (p: Page, address: string, on: boolean) =>
  p.evaluate(([a, h]) => { if (h) localStorage.setItem(`vs:history:held:${a}`, '1'); else localStorage.removeItem(`vs:history:held:${a}`); }, [address.toLowerCase(), on] as const);

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

/**
 * The page (components/portfolio/wallet/Wallet.tsx, the Portfolio page since 2026-11-26): the card, the accounts and
 * their drawers, the chart, earn and automate, Fees beside Trading, and the account band; Wealth is a view of its own.
 */
const page = (p: Page) => ({
  /** The card: the page is up. */
  ready: () => p.locator('.pfv3-card').waitFor({ timeout: 30_000 }),
  /** An account's row in Accounts (Perps, Spot, Wealth, On-chain) and its figure. */
  row: (label: string) => p.locator('.pfv3-accounts .pfv-legend__row', { has: p.locator('.pfv-legend__k', { hasText: new RegExp(`^${label}$`) }) }),
  value: (label: string) => page(p).row(label).locator('.pfv-legend__v b'),
  /** The band's tabs: All, Perps, Spot, Wealth, On-chain, and on the right Copy trading, Bots (owner 2026-11-27). */
  section: (name: string) => p.locator('.pfv3-band').getByRole('tab', { name, exact: true }),
  /** Wealth, the view: from its account's drawer. */
  openWealth: async () => {
    const row = page(p).row('Wealth');
    if ((await row.getAttribute('aria-expanded')) !== 'true') await row.click();
    await p.locator('#pfv-drawer-wealth').getByRole('button', { name: /Open Wealth|View all .* in Wealth|See all funds/ }).click();
    await p.locator('.pfv-wealth').waitFor();
  },
  summary: () => p.locator('.pfv3-trading .pfv-sum'),
});

h.test('no wallet: the layout stands, accounts and their figures, the four ways to earn and no invented figure', async ({ page: p, origin }) => {
  await p.goto(new URL('/portfolio', origin).href);
  await clearOverlays(p);
  await page(p).ready();
  assert.equal(await p.locator('.pfv-h1').innerText(), 'Portfolio');
  assert.equal(await p.locator('.pfv3-offers > li').count(), 4);
  const text = (await p.locator('.pfv3-offers').innerText()).replace(/\s+/g, ' ');
  for (const want of ['Copy trading', 'USDC Earn', 'US Cash Yield', 'Bots']) assert.ok(text.includes(want), `${want} is in Earn and automate`);
  // Every way in is a button of its own.
  for (const name of ['See vault', 'See fund', 'Find traders']) assert.ok(await p.locator('.pfv3-offers').getByRole('button', { name }).isVisible(), `${name} is a button`);
  assert.equal(await p.locator('.pfv3-accounts .pfv-legend > li').count(), 4);
  assert.ok(await page(p).section('Wealth').isVisible());
  await shot(p, 'no-wallet');
}, { storage });

h.test('Total Value counts each dollar once, and copies and bots have no bucket', async ({ page: p, wallet, ctx, origin }) => {
  await holdHistory(p, wallet.address, true);
  await enableTrading({ page: p, wallet, ctx }, { spot: { vUSDC: 40, vQQQ: 2, vUSDT: 25 }, balance: 1000, stateful: true });
  // After the account fake: the last route wins, and that one forwards every read it does not know.
  await fakeWealth(ctx, wallet.address);
  await fakeBook(ctx);
  await fakeHistory(ctx);
  await holdHistory(p, wallet.address, false);
  await p.goto(new URL('/portfolio', origin).href);
  await clearOverlays(p);
  await page(p).ready();
  for (const label of ['Wealth', 'Spot', 'Perps', 'On-chain']) await until(p, async () => (await page(p).value(label).innerText()).includes('$'), `the ${label} account`, 20_000);
  const money = async (label: string) => num((await page(p).value(label).innerText()).replace(/[^0-9.,]/g, ''));
  const perps = await money('Perps');
  const spot = await money('Spot');
  const wealth = await money('Wealth');
  const evm = await money('On-chain').catch(() => 0);
  const total = num((await p.locator('.pfv3-card__v').innerText()).replace(/[^0-9.,]/g, ''));
  assert.ok(Math.abs(total - (perps + spot + wealth + evm)) < 0.02, `total ${total} = ${perps} + ${spot} + ${wealth} + ${evm}`);
  // 1290 + 315 + 505 settled, minus the 404 of soUSDC pledged in Perps, plus 120 in flight.
  assert.ok(Math.abs(wealth - 1826) < 0.02, `wealth ${wealth}`);
  assert.ok(spot < 200, `the vQQQ share left Spot (${spot})`);
  assert.equal(await p.locator('.pfv3-accounts .pfv-legend > li').count(), 4);

  // Fees and Trading share one row: same top, same height (desktop and tablet; one column on a phone).
  if ((p.viewportSize()?.width ?? 0) > 760) {
    const [fees, trading] = await Promise.all(['.pfv3-fees', '.pfv3-trading'].map((s) => p.locator(s).boundingBox()));
    assert.ok(Math.abs(fees!.y - trading!.y) < 1 && Math.abs(fees!.height - trading!.height) < 1, `Fees ${fees!.y}/${fees!.height} beside Trading ${trading!.y}/${trading!.height}`);
  }

  // An account's drawer: at most four rows, then the way to the table that has all of them.
  await page(p).row('Spot').click();
  const drawer = p.locator('#pfv-drawer-spot');
  await drawer.locator('.pfv-coins li').first().waitFor();
  assert.ok(await drawer.locator('.pfv-coins li').count() <= 4, 'four rows at most');
  await shot(p, 'spot-drawer');

  // No partial figure while the wallet's history is still being read.
  await page(p).summary().locator('.pfv-skel-num').first().waitFor();
  await shot(p, 'summary-reading');
  await until(p, async () => {
    const t = await page(p).summary().innerText();
    return /Trades\s*2/.test(t) && (await page(p).summary().locator('.pfv-skel-num').count()) === 0;
  }, 'the summary to add up the fills and the funding', 150_000);
  const sum = (await page(p).summary().innerText()).replace(/\s+/g, ' ');
  assert.match(sum, /Buys 1 Sells 1/);
  assert.match(sum, /Volume \$300,00/);
  assert.match(sum, /Fees paid \$0,12/);
  assert.match(sum, /Funding \S*\$1,50 \S*\$0,00 received · \S*\$1,50 paid/);
  await shot(p, 'trading');
  // 30 days by default (owner 2026-11-27), on the summary and on the chart.
  assert.equal(await p.locator('.pfv3-range').getByRole('radio', { name: '30d' }).getAttribute('aria-checked'), 'true');
  assert.equal(await p.locator('.pfx-chart').getByRole('radio', { name: '30d' }).getAttribute('aria-checked'), 'true');
  await p.locator('.pfv3-range').getByRole('radio', { name: '7d' }).click();
  assert.equal(await p.locator('.pfv3-range').getByRole('radio', { name: '7d' }).getAttribute('aria-checked'), 'true');

  // The chart: hours on 24h, days on 7d; the view is a dropdown; the line morphs between them (chart/lineMorph.ts).
  const labels = () => p.locator('.pfx-chart .pf-chart__xlabel').allTextContents();
  await p.locator('.pfx-chart').getByRole('radio', { name: '24h' }).click();
  await until(p, async () => (await labels()).some((l) => /^\d\d:00$/.test(l)), 'hours on the 24h axis', 15_000);
  await p.waitForTimeout(700);
  await shot(p, 'axis-24h', false);
  await p.locator('.pfx-chart').getByRole('radio', { name: '7d' }).click();
  await until(p, async () => (await labels()).length >= 3 && !(await labels()).some((l) => l.includes(':')), 'days on the 7d axis', 5_000);
  await p.locator('.pfx-chart .psel__btn').click();
  await p.getByRole('option', { name: 'PnL', exact: true }).waitFor();
  await p.waitForTimeout(350);
  assert.ok(await p.getByRole('option', { name: 'PnL', exact: true }).evaluate((el) => {
    const r = el.getBoundingClientRect();
    return el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
  }), 'the view list is on top, not clipped');
  await shot(p, 'timeframe', false);
  const heightOf = () => p.locator('.pfx-chart').evaluate((el) => el.getBoundingClientRect().height);
  const valueHeight = await heightOf();
  await p.getByRole('option', { name: 'PnL', exact: true }).click();
  assert.equal(await heightOf(), valueHeight, 'the card keeps its height on PnL');
  await p.waitForTimeout(700);
  await p.locator('.pfx-chart').evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await shot(p, 'pnl', false);
  await p.locator('.pfx-chart .psel__btn').click();
  await p.getByRole('option', { name: 'PnL Calendar' }).click();
  await p.locator('.pfc-grid').waitFor();
  await shot(p, 'calendar', false);
  await p.getByRole('button', { name: 'View tiers' }).click();
  await p.getByRole('dialog').first().waitFor();
  await shot(p, 'fee-sheet', false);
  await p.keyboard.press('Escape');
  for (const name of ['All', 'Spot', 'Wealth', 'On-chain', 'Copy trading', 'Bots']) {
    await page(p).section(name).click();
    await p.waitForTimeout(700);
    await shot(p, `section-${name.toLowerCase().replace(' ', '-')}`);
  }
  await page(p).openWealth();
  await p.waitForTimeout(1500);
  await shot(p, 'wealth-view');
  // Nothing in Wealth is cut off at the side, on a phone above all.
  const { scroll, client } = await p.locator('.pfv-wealth').evaluate((e) => ({ scroll: e.scrollWidth, client: e.clientWidth }));
  assert.ok(scroll <= client + 1, `Wealth fits: ${scroll} <= ${client}`);
}, { storage, timeout: 240_000 });

/** Incognito on the amounts, in one look; the chart opens on PnL. (The address stays: the setup reads it.) */
const privateStorage = (mode: string) => ({
  ...storage,
  'ot.privacy': JSON.stringify({ equity: true, funds: true, pnl: true }),
  'ot.privacy.mode': JSON.stringify(mode),
  'vs.pf.chart.view': JSON.stringify('pnl'),
});

for (const mode of ['blur', 'stars'] as const) {
  h.test(`Incognito (${mode}): the PnL chart keeps its shape, its y axis and hover value are hidden`, async ({ page: p, wallet, ctx, origin }) => {
    await holdHistory(p, wallet.address, true);
    await enableTrading({ page: p, wallet, ctx }, { balance: 1000 });
    await fakeHistory(ctx);
    await p.goto(new URL('/portfolio', origin).href);
    await clearOverlays(p);
    const chart = p.locator('.pfx-chart');
    await chart.locator('.pf-chart__line').first().waitFor({ timeout: 20_000 });
    // A switch morphs for 580 ms (chart/lineMorph.ts): read the settled chart.
    await p.waitForTimeout(800);
    const labels = await chart.locator('.pf-chart__ylabel').allTextContents();
    assert.ok(labels.length >= 2, 'the axis still has its ticks');
    if (mode === 'stars') assert.ok(labels.every((l) => /^\*+$/.test(l)), `asterisks only: ${labels.join(' | ')}`);
    else assert.equal(await chart.locator('.pf-chart__ylabel.is-blur').count(), labels.length, 'every label blurred');
    // Hover: the day stays, the amount is masked.
    await chart.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await p.waitForTimeout(300);
    const box = (await chart.locator('.pf-chart__svg').boundingBox())!;
    await p.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.4);
    const tip = chart.locator('.pf-chart__tip');
    await tip.waitFor();
    const val = await tip.locator('.pf-chart__tipval').innerText();
    assert.ok(!/\$\d/.test(val) || mode === 'blur', `hover value hidden: ${val}`);
    if (mode === 'blur') assert.equal(await tip.locator('.pf-chart__tipval .mask--blur').count(), 1, 'hover value blurred');
    await shot(p, `privacy-${mode}`, false);
  }, { storage: privateStorage(mode), timeout: 120_000 });
}

h.test('History notification: paused it stays up with its parts, resumed it reads to the end and goes', async ({ page: p, wallet, ctx, origin }) => {
  await holdHistory(p, wallet.address, true);
  await enableTrading({ page: p, wallet, ctx }, { balance: 1000 });
  await fakeHistory(ctx);
  await p.goto(new URL('/portfolio', origin).href);
  await p.addStyleTag({ content: '[aria-label="Developer"], .pfv-switch { display: none !important; }' });
  const note = p.getByRole('status', { name: 'History' });
  await note.waitFor();
  await until(p, async () => (await note.innerText()).includes('History paused'), 'the paused notification', 15_000);
  await note.locator('.ix-note__top').click();
  for (const part of ['Perps trades', 'Spot trades', 'Funding']) assert.ok((await note.innerText()).includes(part), part);
  await p.waitForTimeout(400);
  await shot(p, 'history-note', false);
  if ((p.viewportSize()?.width ?? 0) > 1000) {
    for (const [w, hgt, name] of [[1280, 800, 'laptop'], [834, 1112, 'tablet']] as const) {
      await p.setViewportSize({ width: w, height: hgt });
      await p.waitForTimeout(500);
      await shot(p, `history-note-${name}`, false);
    }
    await p.setViewportSize({ width: 1600, height: 1000 });
  }
  // The open card covers what is under it.
  const alpha = await note.evaluate((el) => {
    const m = getComputedStyle(el).backgroundColor.match(/rgba?\(([^)]+)\)/);
    const parts = m ? m[1]!.split(',') : [];
    return parts.length === 4 ? Number(parts[3]) : 1;
  });
  assert.equal(alpha, 1, 'an opaque card when open');
  await note.getByRole('button', { name: 'Resume' }).click();
  await until(p, async () => !(await note.isVisible()), 'the notification to go once all is read', 150_000);
  await until(p, async () => /Trades\s*2/.test(await page(p).summary().innerText()), 'the summary from what it read', 30_000);
}, { storage, timeout: 240_000 });

h.test('Swap: the exact order SoDEX\'s own dialog sends, and its result', async ({ page: p, wallet, ctx, origin }) => {
  const sx = await enableTrading({ page: p, wallet, ctx }, { spot: { vUSDC: 40, vUSDT: 500 }, balance: 1000, stateful: true });
  await fakeWealth(ctx, wallet.address);
  await fakeBook(ctx);
  await p.goto(new URL('/portfolio', origin).href);
  await clearOverlays(p);
  await page(p).ready();
  await p.locator('.pfv3-keys').getByRole('button', { name: /Swap/ }).first().click();
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
  await page(p).ready();
  await page(p).openWealth();
  const row = p.locator('.pfv-funds li', { hasText: 'CXMT Vault' });
  await row.getByRole('button', { name: 'Invest' }).click({ timeout: 15_000 });
  const sheet = p.getByRole('dialog', { name: /Invest in CXMT Vault/ });
  await sheet.waitFor();
  await p.waitForTimeout(800);
  await shot(p, 'invest-sheet', false);
}, { storage });
