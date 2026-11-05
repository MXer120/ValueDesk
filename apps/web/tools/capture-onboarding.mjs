/**
 * The first-signup flow's pictures (public/onboarding/): real captures of the running app, in both
 * themes, with no wallet connected. Run it against a dev web and API when a page in them changes:
 *
 *   node apps/web/tools/capture-onboarding.mjs [--web http://localhost:5180] [--only copy,heatmap,flow,terminal] [--theme dark,light]
 *
 * Uses the installed Chrome through playwright-core (nothing is downloaded). PNGs are turned into
 * WebP by that same browser (canvas), so there is no image dependency either.
 */
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(HERE, '..', 'package.json'));
const { chromium } = require('playwright-core');

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const WEB = arg('web', 'http://localhost:5180');
/** The public site's data for the heatmap's history and Who traded: a dev server has little of its own. Read-only GETs. */
const DATA = arg('data', 'https://www.valuedesk.so');
const ONLY = new Set(arg('only', 'terminal,copy,heatmap,flow').split(','));
const THEMES = arg('theme', 'dark,light').split(',');
const OUT = join(HERE, '..', 'public', 'onboarding');
mkdirSync(OUT, { recursive: true });

const CHROME = process.env.VS_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const browser = await chromium.launch({ executablePath: CHROME, headless: true });

/** One page in a theme, past the welcome popup, with the dev tools hidden. */
async function open(theme, path, viewport = { width: 1680, height: 1050 }, dpr = 1) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: dpr });
  await ctx.addInitScript((t) => {
    if (t === 'light') localStorage.setItem('vs.theme', 'light'); else localStorage.removeItem('vs.theme');
    localStorage.setItem('vd.site.terms.look', JSON.stringify('2026-10-28'));
    localStorage.setItem('vd.consent.analytics.v1', JSON.stringify({ allowed: false, at: 1 }));
    localStorage.setItem('vs.setup.done', '1');
  }, theme);
  await ctx.route(/\/api\/vs\/(liquidations|flow)/, async (route) => {
    const u = new URL(route.request().url());
    try {
      const r = await fetch(DATA + u.pathname + u.search, { headers: { origin: DATA, referer: DATA + '/' } });
      await route.fulfill({ status: r.status, contentType: r.headers.get('content-type') ?? 'application/json', body: Buffer.from(await r.arrayBuffer()) });
    } catch {
      await route.continue();
    }
  });
  const page = await ctx.newPage();
  await page.goto(WEB + path, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(6000);
  await page.addStyleTag({ content: '[class*="devp"]{display:none!important} .toasts{display:none!important}' });
  return { page, done: () => ctx.close() };
}

const converter = await (await browser.newContext()).newPage();
/** A PNG as WebP, at most `width` px wide. */
async function toWebp(png, name, width, quality = 0.82) {
  const b64 = png.toString('base64');
  const data = await converter.evaluate(async ({ b64, width, quality }) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const k = Math.min(1, width / img.naturalWidth);
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * k);
    c.height = Math.round(img.naturalHeight * k);
    const x = c.getContext('2d');
    x.imageSmoothingQuality = 'high';
    x.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/webp', quality).split(',')[1];
  }, { b64, width, quality });
  const file = join(OUT, `${name}.webp`);
  writeFileSync(file, Buffer.from(data, 'base64'));
  console.log(name, `${Math.round(statSync(file).size / 1024)} KB`);
}

/** The terminal without the empty account tables under it (no wallet is connected here). */
const TERMINAL_TOP = { x: 0, y: 0, width: 1680, height: 740 };

async function heatTab(page) {
  await page.getByText('Liq. heatmap', { exact: true }).first().click();
  await page.waitForTimeout(5000);
}

for (const theme of THEMES) {
  if (ONLY.has('terminal')) {
    const { page, done } = await open(theme, '/trade', { width: 1600, height: 1000 });
    await toWebp(await page.screenshot(), `terminal-${theme}`, 1100);
    await done();
  }

  if (ONLY.has('copy')) {
    const { page, done } = await open(theme, '/copy');
    await page.waitForTimeout(4000);
    await page.evaluate(() => document.querySelector('.cpy-grid, [class*="cpy-grid"]')?.scrollIntoView({ block: 'start' }));
    await page.waitForTimeout(2500);
    await toWebp(await page.screenshot(), `copy-main-${theme}`, 1680);
    await page.locator('.cpy-card .cpy-copybtn--copy').first().click();
    await page.waitForTimeout(6000);
    const dialog = page.locator('.modal.cpy-modal').first();
    await toWebp(await dialog.screenshot(), `copy-front-${theme}`, 760);
    await done();
    const lb = await open(theme, '/leaderboard');
    await lb.page.waitForTimeout(3000);
    await toWebp(await lb.page.screenshot(), `copy-back-${theme}`, 900);
    await lb.done();
  }

  if (ONLY.has('heatmap')) {
    const { page, done } = await open(theme, '/trade', { width: 1680, height: 1050 });
    await heatTab(page);
    const panel = page.locator('.lqm').first();
    await page.locator('.lqm-seg button', { hasText: 'Live' }).first().click().catch(() => {});
    await page.waitForTimeout(3500);
    await toWebp(await panel.screenshot(), `heatmap-front-${theme}`, 760);
    await page.locator('.lqm-seg button', { hasText: 'Chart' }).first().click().catch(() => {});
    await page.waitForTimeout(4000);
    await toWebp(await panel.screenshot(), `heatmap-back-${theme}`, 760);
    await page.locator('.lqm-seg button', { hasText: 'Historical' }).first().click().catch(() => {});
    await page.waitForTimeout(3000);
    await page.locator('.lqm').first().getByText('1H', { exact: true }).first().click().catch(() => {});
    await page.waitForTimeout(15000);
    await toWebp(await page.screenshot({ clip: TERMINAL_TOP }), `heatmap-main-${theme}`, 1680);
    await done();
  }

  if (ONLY.has('flow')) {
    const { page, done } = await open(theme, '/trade', { width: 1680, height: 1050 });
    await page.getByRole('button', { name: 'Who traded', exact: true }).first().click();
    await page.waitForTimeout(2000);
    // A candle in the middle of the plot.
    const canvas = await page.locator('.kc-panel canvas').first().boundingBox();
    if (canvas) await page.mouse.click(canvas.x + canvas.width * 0.55, canvas.y + canvas.height * 0.4);
    await page.waitForTimeout(6000);
    await toWebp(await page.screenshot({ clip: TERMINAL_TOP }), `flow-main-${theme}`, 1680);
    const side = page.locator('.kc-flow-wrap').first();
    await toWebp(await side.screenshot(), `flow-front-${theme}`, 760);
    const chart = page.locator('.kc-panel').first();
    await toWebp(await chart.screenshot(), `flow-back-${theme}`, 760);
    await done();
  }
}
await browser.close();
