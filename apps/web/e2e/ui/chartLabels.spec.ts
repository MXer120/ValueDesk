/**
 * Order lines on the chart and the window that asks before a trade (chart/orderLabelDom.ts, components/TradeConfirm.tsx),
 * on the fake account (sodexFake.ts): every write is answered in the browser context, nothing reaches SoDEX.
 *
 *   npx tsx e2e/ui/run.ts --only chartLabels --web http://127.0.0.1:5184
 *
 * VS_E2E_SHOTS keeps a picture of each state; VS_E2E_THEME=light|dark picks the theme.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { BrowserContext, Page } from 'playwright-core';
import { PHONE, typeInto, uiSuite, until } from './harness';
import { enableTrading } from './trade';
import type { FakeSodex } from './sodexFake';

const h = uiSuite(import.meta.filename);
const SHOTS = process.env.VS_E2E_SHOTS;
const THEME = process.env.VS_E2E_THEME ?? 'dark';
const tag = `${THEME}${PHONE ? '-phone' : ''}`;
const storage: Record<string, string> = { 'vs.theme': THEME };

const shot = async (page: Page, name: string) => {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}-${tag}.png`) });
};
const clip = async (page: Page, name: string, sel: string) => {
  if (!SHOTS) return;
  await page.locator(sel).first().screenshot({ path: join(SHOTS, `${name}-${tag}.png`) });
};

async function btcLast(): Promise<number> {
  const r = await fetch('https://mainnet-gw.sodex.dev/api/v1/perps/markets/tickers?symbol=BTC-USD', { signal: AbortSignal.timeout(15_000) });
  const j = (await r.json()) as { data?: Array<{ symbol: string; lastPx?: string; markPrice?: string }> };
  const row = (j.data ?? []).find((t) => t.symbol === 'BTC-USD');
  const px = Number(row?.lastPx ?? row?.markPrice);
  assert.ok(px > 0, 'a BTC price');
  return px;
}

const round = (n: number) => String(Math.round(n));

/** Limit, stop, take profit and stop loss around the price, beside the seeded one. */
async function moreOrders(ctx: BrowserContext, px: number, exits: boolean) {
  const base = { symbol: 'BTC-USD', timeInForce: 'GTC', filledQuantity: '0', status: 'NEW', createdAt: Date.now() - 60_000 };
  const rows = [
    { ...base, orderID: 777_001, clOrdID: 'a', side: 'BUY', type: 'LIMIT', price: round(px * 0.9985), quantity: '0.002', origQty: '0.002', reduceOnly: false },
    { ...base, orderID: 777_002, clOrdID: 'b', side: 'SELL', type: 'LIMIT', price: round(px * 1.0015), quantity: '0.003', origQty: '0.003', reduceOnly: false },
    { ...base, orderID: 777_003, clOrdID: 'c', side: 'SELL', type: 'MARKET', price: '0', quantity: '0.01', origQty: '0.01', reduceOnly: true, stopType: 'TAKE_PROFIT', stopPrice: round(px * 1.003), triggerType: 'MARK_PRICE' },
    { ...base, orderID: 777_004, clOrdID: 'd', side: 'SELL', type: 'MARKET', price: '0', quantity: '0.01', origQty: '0.01', reduceOnly: true, stopType: 'STOP_LOSS', stopPrice: round(px * 0.997), triggerType: 'MARK_PRICE' },
  ];
  await ctx.route(/\/perps\/accounts\/[^/]+\/orders(\?|$)/, (route) => route.fulfill({
    status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify({ code: 0, timestamp: Date.now(), data: exits ? rows : rows.slice(0, 2) }),
  }));
}

/** Where a label's box is, to press it on the canvas beneath: the same pixels, or this misses. */
async function pressBox(page: Page, row: number, box: number) {
  const r = await page.evaluate(([i, j]) => {
    const rows = [...document.querySelectorAll('.kc-lbls .kc-lbl:not([hidden])')];
    const b = rows[i!]?.children[j!]?.getBoundingClientRect();
    return b ? { x: b.x + b.width / 2, y: b.y + b.height / 2 } : null;
  }, [row, box]);
  assert.ok(r, `box ${box} of row ${row}`);
  await page.mouse.click(r!.x, r!.y);
}

const rowsWith = (page: Page, text: RegExp) =>
  page.evaluate((src) => {
    const re = new RegExp(src);
    return [...document.querySelectorAll('.kc-lbls .kc-lbl:not([hidden])')].findIndex((r) => re.test(r.textContent ?? ''));
  }, text.source);

async function labels(page: Page, least: number) {
  await until(page, async () => (await page.locator('.kc-lbls .kc-lbl:not([hidden])').count()) >= least, 'the labels', 40_000);
}

/** Past the first-use tour and the like, which sit over the chart. */
const clear = (page: Page) => page.addStyleTag({ content: '[aria-label="Developer"], .toast { display: none !important; }' });

async function setup(env: { page: Page; ctx: BrowserContext; wallet: Parameters<typeof enableTrading>[0]['wallet'] }, exits = true): Promise<{ sx: FakeSodex; px: number }> {
  const px = await btcLast();
  const entry = round(px * 0.9992);
  const sx = await enableTrading(env, { position: { symbol: 'BTC-USD', size: '0.01', entry, leverage: 10 }, openOrder: { symbol: 'BTC-USD', side: 'BUY', price: round(px * 0.9985), quantity: '0.002' } });
  await moreOrders(env.ctx, px, exits);
  await clear(env.page);
  await labels(env.page, exits && !PHONE ? 4 : 2);
  // A phone's panels are a carousel, and it opens on the ticket.
  await env.page.locator('.chartholder.kc-canvas').first().scrollIntoViewIfNeeded();
  await env.page.waitForTimeout(400);
  return { sx, px };
}

h.test('labels: boxes on one line, blurred, and the buttons answer on the pixels they are drawn', async (env) => {
  const { sx } = await setup(env);
  const { page } = env;
  await page.waitForTimeout(800);
  await shot(page, 'labels-trade-page');
  await clip(page, 'labels-chart', '.chartholder.kc-canvas');

  const facts = await page.evaluate(() => {
    const row = document.querySelector<HTMLElement>('.kc-lbls .kc-lbl.is-blur');
    const style = row ? getComputedStyle(row) : null;
    return { blur: style?.backdropFilter ?? '', radius: style?.borderRadius ?? '', count: document.querySelectorAll('.kc-lbls .kc-lbl:not([hidden])').length, tags: document.querySelectorAll('.kc-lbls .kc-lbl__axis:not([hidden])').length };
  });
  assert.match(facts.blur, /blur/);
  assert.equal(facts.tags, facts.count, 'each label has its tag');

  // The X of the limit order, on the canvas under its box.
  const limit = await rowsWith(page, /Limit/);
  assert.ok(limit >= 0);
  const mark = sx.mark();
  await pressBox(page, limit, 0);
  const ask = page.getByRole('dialog', { name: 'Cancel this order?' });
  await ask.waitFor({ state: 'visible', timeout: 8_000 });
  await page.waitForTimeout(300);
  await shot(page, 'confirm-cancel');
  await page.keyboard.press('Escape');
  await ask.waitFor({ state: 'hidden' });
  assert.equal(sx.since(mark).length, 0, 'Esc sends nothing');

  // The position's X: the close window. Enter does not fire in its first moments.
  const position = await rowsWith(page, /PnL/);
  assert.ok(position >= 0, 'the position has its label');
  await pressBox(page, position, 0);
  const close = page.getByRole('dialog', { name: 'Close position at market' });
  await close.waitFor({ state: 'visible', timeout: 8_000 });
  await page.waitForTimeout(300);
  await shot(page, 'confirm-close');
  await close.getByRole('button', { name: 'Keep position' }).click();
  await close.waitFor({ state: 'hidden' });
}, { storage, timeout: 180_000 });

h.test('moving a line asks, with from and to; Put it back sends nothing', async (env) => {
  const { sx } = await setup(env);
  const { page } = env;
  const box = await page.evaluate(() => {
    const row = [...document.querySelectorAll<HTMLElement>('.kc-lbls .kc-lbl:not([hidden])')].find((r) => /Limit/.test(r.textContent ?? ''));
    const b = row?.getBoundingClientRect();
    const end = row?.lastElementChild?.getBoundingClientRect();
    return b && end ? { x: end.right + 80, y: b.y + b.height / 2 } : null;
  });
  assert.ok(box);
  const mark = sx.mark();
  await page.mouse.move(box!.x, box!.y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(box!.x + i, box!.y - i * 4);
  await page.waitForTimeout(150);
  await clip(page, 'labels-dragging', '.chartholder.kc-canvas');
  await page.mouse.up();
  const ask = page.getByRole('dialog', { name: 'Move this order?' });
  await ask.waitFor({ state: 'visible', timeout: 8_000 });
  await page.waitForTimeout(300);
  assert.match((await ask.textContent()) ?? '', /→/);
  await shot(page, 'confirm-move');
  await ask.getByRole('button', { name: 'Put it back' }).click();
  await ask.waitFor({ state: 'hidden' });
  assert.equal(sx.since(mark).length, 0);
}, { storage, timeout: 180_000 });

h.test('+ TP opens the sheet, and its Confirm asks once more', async (env) => {
  // No exits here, so the position offers + TP and + SL.
  const { sx, px } = await setup(env, false);
  const { page } = env;
  await until(page, async () => (await rowsWith(page, /\+ TP/)) >= 0, 'a position with + TP', 30_000);
  await page.waitForTimeout(1000);
  await shot(page, 'labels-position-trade-page');
  await clip(page, 'labels-position', '.chartholder.kc-canvas');
  const row = await rowsWith(page, /\+ TP/);
  await pressBox(page, row, 3);
  const sheet = page.getByRole('dialog', { name: 'Take Profit & Stop Loss' });
  await sheet.waitFor({ state: 'visible', timeout: 8_000 });
  await typeInto(sheet.getByRole('textbox', { name: 'Take Profit price' }), round(px * 1.05));
  const confirm = sheet.getByRole('button', { name: 'Confirm', exact: true });
  await until(page, async () => await confirm.isEnabled(), 'Confirm');
  const mark = sx.mark();
  await confirm.click();
  const ask = page.getByRole('dialog', { name: 'Confirm take profit and stop loss' });
  await ask.waitFor({ state: 'visible' });
  await page.waitForTimeout(300);
  await shot(page, 'confirm-tpsl');
  await page.keyboard.press('Escape');
  await ask.waitFor({ state: 'hidden' });
  assert.ok(await sheet.isVisible(), 'the sheet stays');
  assert.equal(sx.since(mark).length, 0);
}, { storage, timeout: 180_000 });

h.test('the rest: the ticket review, a preview line, cancel all, Settings, the book dot', async (env) => {
  const { sx, px } = await setup(env);
  const { page } = env;
  const mark = sx.mark();

  // The ticket: a limit with its preview on the chart, then its review.
  const { ticket } = await import('./ticket');
  const t = ticket(page);
  await t.limit(Math.round(px * 0.9978), 0.001);
  await page.waitForTimeout(900);
  await clip(page, 'labels-preview', '.chartholder-wrap');
  const { sideButton } = await import('./trade');
  await sideButton(page).click();
  const review = page.getByRole('dialog', { name: /^Review order/ });
  await review.waitFor({ state: 'visible' });
  await page.waitForTimeout(300);
  await shot(page, 'confirm-order');
  await review.getByRole('button', { name: 'Back to ticket' }).click();
  await review.waitFor({ state: 'hidden' });

  const activity = page.getByRole('group', { name: 'Account activity' });
  await activity.getByRole('tab', { name: /^Open Orders/ }).click();
  await activity.getByRole('button', { name: 'Cancel all', exact: true }).click({ timeout: 10_000 });
  const all = page.getByRole('dialog', { name: 'Cancel all perps orders' });
  await all.waitFor({ state: 'visible' });
  await page.waitForTimeout(300);
  await shot(page, 'confirm-cancel-all');
  await all.getByRole('button', { name: 'Keep them' }).click();
  await all.waitFor({ state: 'hidden' });
  assert.equal(sx.since(mark).filter((w) => w.method !== 'GET').length, 0, 'nothing was sent');

  if (!PHONE) {
    // A resting order on a row the book shows: the dot right of its price, whatever its size.
    const rowPrice = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.mkt-bookrow')];
      return rows[rows.length - 3]?.textContent ?? '';
    });
    // Dot groups thousands, so the row's text runs 76.183 62.675 528.738: its first figure is the price.
    const atRow = (rowPrice.match(/^\d{1,3}\.\d{3}/)?.[0] ?? '').replace('.', '');
    await env.ctx.route(/\/perps\/accounts\/[^/]+\/orders(\?|$)/, (route) => route.fulfill({
      status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({ code: 0, timestamp: Date.now(), data: [{ symbol: 'BTC-USD', orderID: 777_009, clOrdID: 'dot', side: 'BUY', type: 'LIMIT', timeInForce: 'GTC', price: atRow, quantity: '0.002', origQty: '0.002', filledQuantity: '0', status: 'NEW', reduceOnly: false, createdAt: Date.now() }] }),
    }));
    await until(page, async () => (await page.locator('.mkt-bookrow__mine').count()) > 0, `the dot at ${atRow}`, 30_000).catch((err) => console.log(`book dot: ${err}`));
    console.log(`book dots: ${await page.locator('.mkt-bookrow__mine').count()} (row text "${rowPrice.slice(0, 30)}", order at ${atRow})`);
    if (SHOTS) await page.locator('.mkt-bookrow').first().locator('xpath=ancestor::*[contains(@class,"dash-panel")][1]').screenshot({ path: join(SHOTS, `book-dot-${tag}.png`) }).catch((err) => console.log(`book clip: ${err}`));

    await page.getByRole('button', { name: /^Settings/ }).first().click();
    const settings = page.getByRole('dialog', { name: 'Settings' });
    await settings.getByRole('button', { name: 'Trading', exact: true }).click();
    await page.waitForTimeout(300);
    await shot(page, 'settings-trading');
    await settings.getByRole('switch', { name: 'Confirm: Cancelling an order' }).click();
    assert.match((await page.evaluate(() => localStorage.getItem('vs.confirm'))) ?? '', /"cancel":false/);
  }
}, { storage, timeout: 180_000 });
