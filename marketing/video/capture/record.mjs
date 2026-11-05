/**
 * Real footage of the running app for the videos: a Chrome page driven by a script, every frame the
 * browser paints saved with its time. Nothing here draws or fakes app content.
 *
 *   node marketing/video/capture/record.mjs heatmap [--theme dark] [--web http://localhost:5180]
 *
 * Writes public/footage/<shot>/ (gitignored): f000123.jpg frames and index.json [{f, t}], plus
 * stills in public/stills/. The heatmap history comes from the public site's API (read-only GETs), as
 * a dev server has little of its own. Uses the installed Chrome; nothing is downloaded.
 */
import { createRequire } from 'node:module';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const require = createRequire(join(ROOT, '..', '..', 'apps', 'web', 'package.json'));
const { chromium } = require('playwright-core');

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const WEB = arg('web', 'http://localhost:5180');
const DATA = arg('data', 'https://www.valuedesk.so');
const THEME = arg('theme', 'dark');
const CHROME = process.env.VS_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const VIEW = { width: 1920, height: 1080 };

async function openApp(path) {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const ctx = await browser.newContext({ viewport: VIEW, deviceScaleFactor: 1.5 });
  await ctx.addInitScript((t) => {
    if (t === 'light') localStorage.setItem('vs.theme', 'light'); else localStorage.removeItem('vs.theme');
    localStorage.setItem('vd.site.terms.look', JSON.stringify('2026-10-28'));
    localStorage.setItem('vd.consent.analytics.v1', JSON.stringify({ allowed: false, at: 1 }));
    localStorage.setItem('vs.setup.done', '1');
  }, THEME);
  await ctx.route(/\/api\/vs\/(liquidations|flow)/, async (route) => {
    const u = new URL(route.request().url());
    try {
      const r = await fetch(DATA + u.pathname + u.search, { headers: { origin: DATA, referer: `${DATA}/` } });
      await route.fulfill({ status: r.status, contentType: r.headers.get('content-type') ?? 'application/json', body: Buffer.from(await r.arrayBuffer()) });
    } catch {
      await route.continue();
    }
  });
  const page = await ctx.newPage();
  await page.goto(WEB + path, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(6000);
  await page.addStyleTag({ content: '[class*="devp"]{display:none!important} .toasts{display:none!important}' });
  return { browser, page };
}

/** Every painted frame while `act` runs, into public/footage/<shot>/. */
async function record(page, shot, act) {
  const dir = join(ROOT, 'public', 'footage', shot);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const cdp = await page.context().newCDPSession(page);
  const index = [];
  let t0 = 0;
  cdp.on('Page.screencastFrame', async (e) => {
    const t = e.metadata.timestamp * 1000;
    if (!t0) t0 = t;
    const f = `f${String(index.length).padStart(6, '0')}.jpg`;
    writeFileSync(join(dir, f), Buffer.from(e.data, 'base64'));
    index.push({ f, t: Math.round(t - t0) });
    await cdp.send('Page.screencastFrameAck', { sessionId: e.sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 90, everyNthFrame: 1, maxWidth: 2880, maxHeight: 1620 });
  await act();
  await cdp.send('Page.stopScreencast');
  writeFileSync(join(dir, 'index.json'), JSON.stringify(index));
  console.log(shot, `${index.length} frames, ${((index.at(-1)?.t ?? 0) / 1000).toFixed(1)} s`);
}

/** The whole page as a crisp still. */
async function still(page, name, clip) {
  const dir = join(ROOT, 'public', 'stills');
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: join(dir, `${name}.png`), ...(clip ? { clip } : {}) });
  console.log('still', name);
}

const glide = async (page, from, to, ms) => {
  const steps = Math.max(2, Math.round(ms / 33));
  for (let i = 1; i <= steps; i++) {
    const k = i / steps;
    const e = k * k * (3 - 2 * k);
    await page.mouse.move(from.x + (to.x - from.x) * e, from.y + (to.y - from.y) * e);
    await page.waitForTimeout(ms / steps);
  }
};

const SHOTS = {
  async heatmap() {
    const { browser, page } = await openApp('/trade');
    await page.getByText('Liq. heatmap', { exact: true }).first().click();
    await page.waitForTimeout(4000);
    const seg = (t) => page.locator('.lqm-seg button', { hasText: t }).first();
    await seg('Live').click().catch(() => {});
    await page.waitForTimeout(3500);
    const lqm = page.locator('.lqm').first();
    await lqm.screenshot({ path: join(ROOT, 'public', 'stills', 'heatmap-live.png') }).catch(async () => {
      mkdirSync(join(ROOT, 'public', 'stills'), { recursive: true });
      await lqm.screenshot({ path: join(ROOT, 'public', 'stills', 'heatmap-live.png') });
    });
    await seg('Historical').click();
    await page.waitForTimeout(2500);
    await lqm.getByText('1H', { exact: true }).first().click().catch(() => {});
    await page.waitForTimeout(16000);
    await still(page, 'heatmap-terminal');
    const box = await lqm.boundingBox();
    await lqm.screenshot({ path: join(ROOT, 'public', 'stills', 'heatmap-history.png') });
    // A person reading the map: the pointer travels over the levels, then zooms in on price.
    const a = { x: box.x + box.width * 0.2, y: box.y + box.height * 0.72 };
    const b = { x: box.x + box.width * 0.72, y: box.y + box.height * 0.62 };
    await page.mouse.move(a.x, a.y);
    await page.waitForTimeout(300);
    await record(page, 'heatmap', async () => {
      await page.waitForTimeout(300);
      await glide(page, a, b, 2600);
      for (let i = 0; i < 6; i++) {
        await page.mouse.wheel(0, -180);
        await page.waitForTimeout(240);
      }
      await page.waitForTimeout(1800);
      await glide(page, b, { x: b.x - box.width * 0.18, y: b.y - box.height * 0.2 }, 1500);
      await page.waitForTimeout(600);
    });
    await browser.close();
  },
};

const which = process.argv[2] ?? 'heatmap';
if (!SHOTS[which]) throw new Error(`no shot "${which}": ${Object.keys(SHOTS).join(', ')}`);
await SHOTS[which]();
