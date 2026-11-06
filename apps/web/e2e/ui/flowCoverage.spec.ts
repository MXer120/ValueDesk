/**
 * Who traded when SoDEX counted more than we hold (server flow/ledger.ts), on a mocked /api/vs/flow: the holes are said in
 * figures, the summary reads as floors, no empty candle reads as "nobody traded", and nothing claims every print. Runs by
 * itself on desktop and phone sizes; `VS_E2E_SHOTS=<dir>` also saves each state there.
 *   node --import tsx --test e2e/ui/flowCoverage.spec.ts      (VS_E2E_UI_WEB=<dev web> or a dev web on 5180-5183)
 * The addresses and figures are made up for the screenshot; nothing here reads real data.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { Browser, Page } from 'playwright-core';
import { findDevWeb, launchEdge } from './browser';

const HOUR = 3_600_000;
const FROM = Date.UTC(2026, 10, 4, 10);
const TO = FROM + HOUR;
const SLOT = 5 * 60_000;
const SHOTS = process.env.VS_E2E_SHOTS?.trim();

const address = (i: number) => `0x${(0x7a3f91 + i * 7919).toString(16).padStart(6, '0')}${'d4c1'.repeat(8)}${(i * 31 + 16).toString(16).padStart(2, '0')}`;
const rows = Array.from({ length: 9 }, (_, i) => {
  const vol = 910_000 / (i + 1);
  const buy = vol * (0.3 + ((i * 37) % 50) / 100);
  return {
    venue: 'sodex', address: address(i), key: String(4000 + i), vol, share: 0.34 / (i + 1), buyNtl: buy, sellNtl: vol - buy, buyN: 40 - i * 3, sellN: 30 - i * 2,
    buyPx: 76_180 + i, sellPx: 76_240 - i, net: (buy - (vol - buy)) / 76_200, takerShare: 0.4, lean: buy > vol / 2 ? 'long' : 'short',
  };
});
const summary = { total: 2_690_000, takerBuy: 1_480_000, takerSell: 1_210_000, wallets: 148, top10: 0.71, prints: 811, vwap: 76_204.5 };
const base = { coin: 'BTC', from: FROM, to: TO, final: false, summary, rows, markets: [{ venue: 'sodex', symbol: 'BTC-USD', since: FROM - 3 * 86_400_000 }], down: [] as number[][], since: FROM - 3 * 86_400_000 };

const STATES = {
  // Hyperliquid BTC 14:30 as measured, trade.xyz above its count, Lighter by volume.
  venues: {
    ...base,
    markets: [{ venue: 'hyperliquid', symbol: 'BTC', since: base.since }, { venue: 'lighter', symbol: 'BTC', since: base.since }, { venue: 'arcus', symbol: 'BTC-USD', since: base.since }],
    gaps: [[FROM + 6 * SLOT, FROM + 7 * SLOT]],
    coverage: null,
    checks: [
      { venue: 'hyperliquid', unit: 'prints', from: FROM, to: TO, held: 34_806, expected: 36_003, holeSlots: 1, overSlots: 0, unchecked: [], holes: [{ from: FROM + 6 * SLOT, to: FROM + 7 * SLOT, held: 4_061, venue: 5_258 }] },
      { venue: 'lighter', unit: 'volume', from: FROM, to: TO, held: 244, expected: 250, holeSlots: 1, overSlots: 0, unchecked: [], holes: [{ from: FROM + 2 * SLOT, to: FROM + 3 * SLOT, held: 20, venue: 26 }] },
      { venue: 'arcus', unit: 'prints', from: FROM, to: TO, held: 0, expected: 0, holeSlots: 0, overSlots: 0, unchecked: [[FROM, TO]], holes: [], pending: true },
    ],
  },
  // 11-06 12:10 as measured in shape: a run of short slots, some of them empty.
  holes: {
    ...base,
    gaps: [[FROM, FROM + 5 * SLOT], [FROM + 8 * SLOT, FROM + 10 * SLOT]],
    coverage: {
      venue: 'sodex', from: FROM, to: TO, held: 811, expected: 2_685, holeSlots: 7, unchecked: [],
      holes: [{ from: FROM, to: FROM + 5 * SLOT, held: 240, venue: 1_180 }, { from: FROM + 8 * SLOT, to: FROM + 10 * SLOT, held: 71, venue: 1_005 }],
    },
  },
  none: {
    ...base,
    summary: { total: 0, takerBuy: 0, takerSell: 0, wallets: 0, prints: 0, vwap: null },
    rows: [],
    gaps: [[FROM, TO]],
    coverage: { venue: 'sodex', from: FROM, to: TO, held: 0, expected: 3_026, holeSlots: 12, unchecked: [], holes: [{ from: FROM, to: TO, held: 0, venue: 3_026 }] },
  },
  checking: {
    ...base,
    gaps: [],
    coverage: { venue: 'sodex', from: FROM, to: TO, held: 500, expected: 500, holeSlots: 0, holes: [], unchecked: [[FROM + 6 * SLOT, TO]] },
  },
  whole: {
    ...base,
    final: true,
    gaps: [],
    summary: { ...summary, prints: 2_685 },
    coverage: { venue: 'sodex', from: FROM, to: TO, held: 2_685, expected: 2_685, holeSlots: 0, holes: [], unchecked: [] },
  },
} as const;

let browser: Browser;
let origin: string;
before(async () => {
  origin = process.env.VS_E2E_UI_WEB?.trim() || (await findDevWeb());
  browser = await launchEdge({ headed: false, slowMo: 0 });
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
});
after(async () => { await browser?.close(); });

async function show(state: keyof typeof STATES, phone: boolean): Promise<{ page: Page; close: () => Promise<void> }> {
  const ctx = await browser.newContext(phone
    ? { viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 }
    : { viewport: { width: 460, height: 860 }, deviceScaleFactor: 2 });
  await ctx.route((u) => u.pathname === '/flow-coverage-mock', (r) => r.fulfill({
    status: 200,
    contentType: 'text/html',
    body: '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0"><div id="root"></div><script type="module" src="/e2e/ui/flowCoverage.mock.tsx"></script></body></html>',
  }));
  await ctx.route((u) => u.pathname === '/api/vs/flow', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, ...STATES[state] }) }));
  const page = await ctx.newPage();
  await page.goto(`${origin}/flow-coverage-mock?at=${FROM}&i=1h`);
  await page.getByText('Who traded').first().waitFor();
  await page.getByText('From the venues').waitFor();
  return { page, close: () => ctx.close() };
}

for (const phone of [false, true]) {
  const size = phone ? 'phone' : 'desktop';
  const shot = async (page: Page, name: string) => {
    if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}-${size}.png`) });
  };

  test(`${size}: holes are said in figures and the summary reads as floors`, async () => {
    const { page, close } = await show('holes', phone);
    await page.getByText(/Held 811 of 2[.,]685 trades/).waitFor();
    await page.getByText(/SoDEX counted 2[.,]685 trades in this candle and we hold 811\./).first().waitFor();
    assert.ok(await page.getByText('811+', { exact: true }).isVisible());
    assert.ok(await page.getByText('148+', { exact: true }).isVisible());
    assert.equal(await page.getByText(/Every print/).count(), 0);
    assert.equal(await page.locator('.tfl-holes > i').count(), 2);
    const wider = await page.evaluate(() => {
      if (document.documentElement.scrollWidth <= window.innerWidth) return [];
      return [...document.querySelectorAll('body *')]
        .filter((e) => e.getBoundingClientRect().right > window.innerWidth + 0.5)
        .slice(0, 8)
        .map((e) => `${e.tagName}.${String(e.className)} ${Math.round(e.getBoundingClientRect().width)}`);
    });
    assert.deepEqual(wider, [], 'no sideways scroll');
    await shot(page, 'holes');
    await close();
  });

  test(`${size}: other venues show their own figures, and one being read says so`, async () => {
    const { page, close } = await show('venues', phone);
    await page.getByText(/Hyperliquid: held 34[.,]806 of 36[.,]003 trades/).waitFor();
    await page.getByText(/Lighter: held 97[.,]6% of volume/).waitFor();
    await page.getByText('Checking', { exact: true }).waitFor();
    await shot(page, 'venues');
    await close();
  });

  test(`${size}: a candle we hold nothing of never reads as nobody traded`, async () => {
    const { page, close } = await show('none', phone);
    await page.getByText('We hold no trades for this candle').waitFor();
    assert.equal(await page.getByText('No trades in this candle').count(), 0);
    await shot(page, 'none-held');
    await close();
  });

  test(`${size}: a count not in yet is said, not read as whole`, async () => {
    const { page, close } = await show('checking', phone);
    await page.getByText('Not checked yet').waitFor();
    assert.equal(await page.getByText(/all .* of its trades held/).count(), 0);
    await shot(page, 'not-checked');
    await close();
  });

  test(`${size}: whole says so at the foot, with no note above`, async () => {
    const { page, close } = await show('whole', phone);
    await page.getByText(/SoDEX: all 2[.,]685 of its trades held, by its own count\./).waitFor();
    assert.equal(await page.locator('.tfl-note').count(), 0);
    await shot(page, 'whole');
    await close();
  });
}
