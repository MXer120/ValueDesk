/**
 * The demo desk for the film (owner 2026-11-06: "a connected wallet, just use demo data that looks
 * real"). The local dev web with a throwaway test wallet and the e2e suite's fake SoDEX account:
 * balances, positions and orders are demo data answered in this browser; every write stays here.
 * Market data, heatmaps, traders, cohorts and news are the live site's, by read-only GET. No request
 * other than a GET reaches production, so the throwaway wallet leaves no trace there.
 */
import { homedir } from 'node:os';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { chromium, type BrowserContext, type CDPSession, type Locator, type Page, type Route } from 'playwright-core';
import { createTestWallet } from '../../../apps/web/e2e/ui/wallet';
import { enableTrading } from '../../../apps/web/e2e/ui/trade';
import { acceptWelcome, connectWallet, dismissOnboarding, dismissSetup } from '../../../apps/web/e2e/ui/harness';

export const DEPS = join(homedir(), 'vd-video-deps');
export const OUT = join(DEPS, 'takes');
const FFMPEG = join(DEPS, 'node_modules', '@remotion', 'compositor-win32-x64-msvc', 'ffmpeg.exe');
const CHROME = process.env.VS_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
export const WEB = process.env.VD_WEB || 'http://localhost:5181';
const LIVE = 'https://www.valuedesk.so';
export let VIEW = { width: 1920, height: 1080 };
/** A laptop's 16:10 screen, for the takes shown on the 3D laptop. */
export const setView = (height: number, width = 1920) => { VIEW = { width, height }; };
const DSF = 2;
const FPS = 60;

/** The demo account: believable, modest, nothing that reads as a promise of returns. */
export const DEMO = {
  balance: 25_000,
  stateful: true,
  positions: [
    { symbol: 'BTC-USD', size: '0.12', entry: '75120', leverage: 10 },
    { symbol: 'ETH-USD', size: '-1.8', entry: '2262', leverage: 5 },
    { symbol: 'SOL-USD', size: '24', entry: '90.1', leverage: 5 },
  ],
};

/** A pointer big enough to follow on a phone, with a soft ring on a press. */
const CURSOR = () => {
  const paint = () => {
    if (document.getElementById('__film_cursor')) return;
    const c = document.createElement('div');
    c.id = '__film_cursor';
    c.innerHTML = '<svg width="46" height="46" viewBox="0 0 24 24"><path d="M4 2.5 19.5 12l-7 1.6-3.4 6.4z" fill="#fff" stroke="#000" stroke-opacity=".6" stroke-width=".9" stroke-linejoin="round"/></svg><i style="position:absolute;left:-22px;top:-22px;width:50px;height:50px;border-radius:50%;background:rgba(0,180,129,.38);transform:scale(0);transition:transform .16s ease-out,opacity .3s ease-out;opacity:0"></i>';
    c.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;filter:drop-shadow(0 4px 10px rgba(0,0,0,.6));transform:translate(-400px,-400px)';
    document.documentElement.append(c);
    const ring = c.querySelector('i') as HTMLElement;
    addEventListener('mousemove', (e) => { c.style.transform = `translate(${e.clientX - 5}px,${e.clientY - 3}px)`; }, true);
    addEventListener('mousedown', () => { ring.style.transform = 'scale(1)'; ring.style.opacity = '1'; }, true);
    addEventListener('mouseup', () => { ring.style.transform = 'scale(1.5)'; ring.style.opacity = '0'; setTimeout(() => { ring.style.transform = 'scale(0)'; }, 320); }, true);
  };
  if (document.documentElement) paint(); else addEventListener('DOMContentLoaded', paint);
};

const CLOCK = () => {
  const now = performance.now.bind(performance);
  const raf = window.requestAnimationFrame.bind(window);
  let slow = 1; let r0 = now(); let v0 = r0;
  const virt = (r: number) => v0 + (r - r0) / slow;
  performance.now = () => virt(now());
  window.requestAnimationFrame = (cb) => raf((ts) => cb(virt(ts)));
  (window as unknown as { __filmSlow: (s: number) => void }).__filmSlow = (s) => { const r = now(); v0 = virt(r); r0 = r; slow = s; };
};

/** Gentle on production: at most three reads at once, and a timed-out read asked again after a pause. */
let running = 0;
const waiting: Array<() => void> = [];
const slot = async () => { if (running >= 3) await new Promise<void>((r) => waiting.push(r)); running++; };
const free = () => { running--; waiting.shift()?.(); };
async function fetchLive(url: string, headers: Record<string, string>): Promise<Response> {
  await slot();
  try {
    for (let i = 0; ; i++) {
      const r = await fetch(url, { headers });
      if (r.status < 500 || i >= 4) return r;
      await new Promise((d) => setTimeout(d, 1500 * (i + 1)));
    }
  } finally { free(); }
}

/** The demo account's history: a believable curve, for the portfolio's chart. */
async function demoHistory(ctx: BrowserContext): Promise<void> {
  await ctx.route((u) => u.hostname === 'mainnet-data.sodex.dev' && u.pathname.endsWith('/wallet/portfolio/chart'), async (route) => {
    const win = new URL(route.request().url()).searchParams.get('window') ?? '1Y';
    const span = ({ '24H': 1, '7D': 7, '14D': 14, '30D': 30 } as Record<string, number>)[win] ?? 120;
    const n = 90;
    const now = Date.now();
    let v = 41_200 + (120 - Math.min(span, 120)) * 72;
    const chart = Array.from({ length: n }, (_, i) => {
      const k = i / (n - 1);
      const target = v + (50_000 - v) * k;
      const wave = Math.sin(i * 0.37) * 240 + Math.sin(i * 0.11 + 1) * 420 + Math.sin(i * 1.3) * 90;
      const value = i === n - 1 ? 50_000 : target + wave * (1 - k * 0.5);
      return { ts_ms: now - (n - 1 - i) * (span * 86_400_000) / (n - 1), account_value_usd: String(value), pnl_usd: String(value - v), spot_pnl_usd: '0', perps_pnl_usd: String(value - v), vault_pnl_usd: '0', roi: String((value - v) / v) };
    });
    await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ code: 0, message: '', data: { chart, total_pnl_usd: String(50_000 - v), roi: String((50_000 - v) / v) } }) });
  });
}

const flowCache = new Map<string, Buffer>();
async function readsFromLive(ctx: BrowserContext): Promise<void> {
  await ctx.route((u) => u.pathname.startsWith('/api/') && u.hostname === 'localhost', async (route: Route) => {
    const req = route.request();
    const u = new URL(req.url());
    if (req.method() !== 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    // Trade flow's answers kept, so a take that picks the same candles again has no loading in it
    const keep = u.pathname.startsWith('/api/vs/flow');
    const kept = keep ? flowCache.get(u.pathname + u.search) : null;
    if (kept) return route.fulfill({ status: 200, contentType: 'application/json', body: kept });
    try {
      const r = await fetchLive(LIVE + u.pathname + u.search, { origin: LIVE, referer: `${LIVE}/`, accept: req.headers().accept ?? '*/*' });
      const body = Buffer.from(await r.arrayBuffer());
      if (keep && r.status === 200) flowCache.set(u.pathname + u.search, body);
      await route.fulfill({ status: r.status, contentType: r.headers.get('content-type') ?? 'application/json', body });
    } catch { await route.abort(); }
  });
}

/** Waits until no read has been running for `quiet` ms: a take only starts on a settled screen. */
export async function settled(page: Page, quiet = 3500, max = 90_000): Promise<void> {
  const t0 = Date.now();
  let calm = Date.now();
  while (Date.now() - t0 < max) {
    if (running > 0 || waiting.length) calm = Date.now();
    if (Date.now() - calm >= quiet) return;
    await page.waitForTimeout(250);
  }
  console.log('settled: gave up after', max, 'ms');
}

export type Demo = { page: Page; cdp: CDPSession; ctx: BrowserContext; close: () => Promise<void> };

/** A desk: connected and trading enabled by default. Heavy pages (no wallet needed) can skip it. */
export async function openDemo(path = '/trade', o: { trading?: boolean; storage?: Record<string, string>; before?: (ctx: BrowserContext) => Promise<void> } = {}): Promise<Demo> {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--use-angle=d3d11', '--enable-gpu-rasterization', '--ignore-gpu-blocklist', '--disable-frame-rate-limit'] });
  const ctx = await browser.newContext({ viewport: VIEW, deviceScaleFactor: DSF, locale: 'en-US', timezoneId: 'UTC', colorScheme: 'dark', serviceWorkers: 'block' });
  ctx.setDefaultTimeout(20_000);
  await ctx.addInitScript({ content: 'globalThis.__name = globalThis.__name || ((f) => f);' });
  await ctx.routeWebSocket((u) => u.pathname === '/' && u.searchParams.has('token'), (ws) => { ws.send(JSON.stringify({ type: 'connected' })); ws.onMessage(() => {}); });
  const wallet = createTestWallet();
  if (!o.before) await wallet.install(ctx);
  await ctx.addInitScript((s: Record<string, string>) => { for (const [k, v] of Object.entries(s)) if (localStorage.getItem(k) === null) localStorage.setItem(k, v); }, {
    'vs.numberFormat': 'comma-dot', 'vs.setup.done': '1', 'vd.consent.analytics.v1': JSON.stringify({ allowed: false, at: 1 }), ...o.storage,
  });
  await ctx.addInitScript(CURSOR);
  await ctx.addInitScript(CLOCK);
  await readsFromLive(ctx);
  await demoHistory(ctx);
  if (o.before) await o.before(ctx);
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: 2_000_000, uploadThroughput: 1_000_000 });
  await page.goto(WEB + path, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await acceptWelcome(page);
  if (o.trading !== false) await enableTrading({ page, ctx, wallet }, DEMO as never);
  await page.addStyleTag({ content: '[class*="devp"]{display:none!important} ::selection{background:transparent!important}' });
  return { page, cdp, ctx, close: () => browser.close() };
}
export { connectWallet, dismissOnboarding, dismissSetup };

let SLOW = 1;
/** Every painted frame while `act` runs, into one constant-rate file; `slow`: see launch.mjs. */
export async function record(d: Demo, shot: string, slow: number, act: () => Promise<void>, panels: Record<string, unknown> = {}): Promise<void> {
  SLOW = slow;
  const { cdp, page } = d;
  const dir = join(OUT, `_${shot}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const frames: Array<{ f: string; t: number }> = [];
  const min = 1000 / (FPS * 1.05) / SLOW;
  let last = -1e9;
  const onFrame = async (e: { data: string; sessionId: number; metadata: { timestamp?: number } }) => {
    const t = (e.metadata.timestamp ?? 0) * 1000;
    if (t - last >= min) { last = t; const f = `f${String(frames.length).padStart(6, '0')}.jpg`; writeFileSync(join(dir, f), Buffer.from(e.data, 'base64')); frames.push({ f, t }); }
    await cdp.send('Page.screencastFrameAck', { sessionId: e.sessionId }).catch(() => {});
  };
  cdp.on('Page.screencastFrame', onFrame);
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, everyNthFrame: 1, maxWidth: VIEW.width * DSF, maxHeight: VIEW.height * DSF });
  if (SLOW > 1) {
    await cdp.send('Animation.enable');
    await cdp.send('Animation.setPlaybackRate', { playbackRate: 1 / SLOW });
    await page.evaluate((s) => (window as unknown as { __filmSlow: (x: number) => void }).__filmSlow(s), SLOW);
  }
  const marks: Record<string, number> = {};
  const t0 = Date.now();
  (d as unknown as { mark: (n: string) => void }).mark = (n) => { marks[n] = +(((Date.now() - t0) / 1000) / SLOW).toFixed(2); };
  await act();
  await cdp.send('Page.stopScreencast');
  cdp.off('Page.screencastFrame', onFrame);
  if (SLOW > 1) {
    await cdp.send('Animation.setPlaybackRate', { playbackRate: 1 });
    await page.evaluate(() => (window as unknown as { __filmSlow: (x: number) => void }).__filmSlow(1));
  }
  const list = frames.map((x, i) => `file '${x.f}'\nduration ${(((frames[i + 1]?.t ?? x.t + 16.7 * SLOW) - x.t) / SLOW / 1000).toFixed(5)}`).join('\n');
  writeFileSync(join(dir, 'list.txt'), `ffconcat version 1.0\n${list}\n`);
  const r = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', 'list.txt', '-r', String(FPS), '-c:v', 'libx264', '-preset', 'medium', '-crf', '15', '-pix_fmt', 'yuv420p', '-g', '30', join(OUT, `${shot}.mp4`)], { cwd: dir });
  if (r.status !== 0) throw new Error(String(r.stderr));
  writeFileSync(join(OUT, `${shot}.json`), JSON.stringify({ view: VIEW, dsf: DSF, panels, marks }, null, 1));
  const gaps = frames.slice(1).map((x, i) => x.t - frames[i]!.t).sort((a, b) => a - b);
  console.log(shot, `${frames.length} frames, ${((frames.at(-1)!.t - frames[0]!.t) / 1000 / SLOW).toFixed(1)} s, gap p50 ${(gaps[gaps.length >> 1]! / SLOW).toFixed(0)} ms`, JSON.stringify(marks));
  rmSync(dir, { recursive: true, force: true });
  SLOW = 1;
}
export const markOf = (d: Demo, n: string) => (d as unknown as { mark: (x: string) => void }).mark(n);

const ease = (k: number) => k * k * k * (k * (k * 6 - 15) + 10);
let at = { x: 960, y: 540 };
export async function jump(page: Page, p: { x: number; y: number }) { at = p; await page.mouse.move(p.x, p.y); }
export async function glide(page: Page, to: { x: number; y: number }, ms = 900) {
  const from = at; ms *= SLOW;
  const bow = Math.min(60, Math.hypot(to.x - from.x, to.y - from.y) * 0.08);
  const t0 = Date.now();
  for (;;) {
    const k = Math.min(1, (Date.now() - t0) / ms);
    const e = ease(k);
    await page.mouse.move(from.x + (to.x - from.x) * e, from.y + (to.y - from.y) * e - Math.sin(k * Math.PI) * bow);
    if (k >= 1) break;
    await page.waitForTimeout(4);
  }
  at = to;
}
export const hold = (page: Page, ms: number) => page.waitForTimeout(ms * SLOW);
export const center = async (l: Locator) => { const b = await l.boundingBox(); if (!b) throw new Error('no box'); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
export async function press(page: Page, l: Locator, ms = 800) { await glide(page, await center(l), ms); await hold(page, 110); await page.mouse.down(); await hold(page, 70); await page.mouse.up(); await hold(page, 90); }
export async function wheel(page: Page, dy: number, ms: number) { const n = Math.round((ms * SLOW) / 16); for (let i = 0; i < n; i++) { await page.mouse.wheel(0, dy / n); await page.waitForTimeout(12); } }
export async function type(page: Page, text: string, perKey = 110) { for (const ch of text) { await page.keyboard.type(ch); await page.waitForTimeout(perKey * SLOW); } }
