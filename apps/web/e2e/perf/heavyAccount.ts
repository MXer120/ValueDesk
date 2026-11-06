/**
 * How the app holds up when the connected account is very busy (bots): frame times, long tasks and input delay
 * at each load level, on a production build, with a simulated account (fakeAccount.js: nothing is signed or sent).
 *
 *   VITE_CHANNEL=beta npx vite build --outDir <dir> --minify false
 *   npx tsx e2e/perf/heavyAccount.ts <dir> <out.json> [scenarios=orders,history,positions,order-history,bots] [levels=L0,L1,L2,L3,L4] [secs=30] [profile=L4] [shots=<dir>] [cpu=4] [phone=1]
 * The scenario `bots` needs the beta build (VITE_CHANNEL=beta): the Bots page, with this harness answering the beta door and the executor.
 *
 * Not in CI: it needs a browser and takes minutes. The local API (valuescan-server, :8797) answers /api.
 */
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchEdge } from '../ui/browser';
import { connectWallet, dismissOnboarding, dismissSetup, acceptWelcome, hideDevPanel, newUiContext } from '../ui/harness';
import { createTestWallet } from '../ui/wallet';
import { COPY_TERMS_VERSION, canonicalJSON } from '../../../../packages/copy-engine/src/index.ts';
import { COPY_TERMS } from '../../src/legal/copyTerms';
import { bytesToHex, keccak256, utf8 } from '../../../../packages/sodex-core/src/index.ts';

const [dist, outFile] = process.argv.slice(2);
const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`${k}=`))?.slice(k.length + 1) ?? d;
const SECS = Number(arg('secs', '30'));
const SCENARIOS = arg('scenarios', 'orders,history,positions').split(',');
const LEVELS = arg('levels', 'L0,L1,L2,L3,L4').split(',');
const PROFILE = arg('profile', '');
const SHOTS = arg('shots', '');
const BOTS = SCENARIOS.includes('bots');
/** CPU slowdown (Emulation.setCPUThrottlingRate): 1 this machine, 4 a mid laptop, 6 with phone=1 a phone. */
const CPU = Number(arg('cpu', '1'));
const PHONE_VIEW = arg('phone', '') === '1';
const CHART = arg('chart', '1') === '1';

const LOADS: Record<string, { bots: number; updatesPerSec: number; fillsPerSec: number; openOrders: number; positions: number }> = {
  L0: { bots: 0, updatesPerSec: 0, fillsPerSec: 0, openOrders: 20, positions: 5 },
  L1: { bots: 1, updatesPerSec: 4, fillsPerSec: 0.5, openOrders: 40, positions: 5 },
  L2: { bots: 10, updatesPerSec: 40, fillsPerSec: 5, openOrders: 90, positions: 10 },
  L3: { bots: 25, updatesPerSec: 100, fillsPerSec: 12, openOrders: 300, positions: 20 },
  L4: { bots: 100, updatesPerSec: 400, fillsPerSec: 50, openOrders: 1000, positions: 40 },
  L5: { bots: 300, updatesPerSec: 1200, fillsPerSec: 150, openOrders: 3000, positions: 80 },
};
const TABS: Record<string, RegExp> = { orders: /^Open orders/i, history: /^Trade history/i, positions: /^Positions/i, 'order-history': /^Order history/i };

const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2', '.json': 'application/json', '.wasm': 'application/wasm', '.jpg': 'image/jpeg' };
/** One bot as GET /algos lists it: its book's series at BOT_SERIES_MAX, the most a long-running bot sends. */
function fakeBot(i: number, owner: string, symbols: string[], px: Record<string, number>) {
  const now = Date.now();
  const symbol = symbols[i % symbols.length]!;
  const series: Array<[number, number, number, number]> = [];
  for (let k = 0; k < 1500; k++) series.push([now - (1500 - k) * 300_000, 1000 + k * 137.25 + i, Number((k * 0.0173 - i).toFixed(4)), Number((k * 0.0291).toFixed(4))]);
  const orders = [0, 1, 2, 3].map((n) => ({ side: n % 2 ? 'sell' : 'buy', price: px[symbol]! * (1 + (n - 1.5) * 0.001), quantity: 10 / px[symbol]!, tag: 'quote' }));
  return {
    algo: {
      id: `bot${i}`, owner, accountId: 987654, mode: 'hosted', spec: { kind: 'maker', bot: true, strategy: 'maker', symbol, paper: i % 2 === 0, label: null }, status: 'running', statusReason: null,
      createdAt: now - 86_400_000 * 7 + i * 1000, updatedAt: now, startedAt: now - 86_400_000 * 7, endedAt: null, parentId: null, consent: null, seed: i, filled: 10, filledValue: 200_000, makerQty: 9, fees: 12, arrival: px[symbol], k: {},
      book: { buyQty: 5, buyValue: 100_000, sellQty: 5, sellValue: 100_000, makerValue: 180_000, takerValue: 20_000, tradeFees: 8, builderFees: 4, fills: 900, series },
    },
    target: null, progress: 0, avgPrice: null, vsArrivalBps: null, vsMarketVwapBps: null, marketVwap: null, nextAt: null, endsAt: null, working: 'quoting', triggerPrice: null, conditions: null, exits: [], legs: [],
    bot: { volume: 200_000 + i, inventory: 0.1, inventoryUsd: 50, grossPnl: 3, netPnl: -9, tradeFees: 8, builderFees: 4, makerShare: 0.9, costPerMillion: 45, fills: 900, mark: px[symbol], orders, closing: false },
  };
}
const fakeExec = { bots: 0, owner: '', symbols: [] as string[], px: {} as Record<string, number>, bytes: 0, polls: 0 };

function serve(root: string): Promise<{ origin: string; close: () => void }> {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const json = (o: unknown) => {
      const body = JSON.stringify(o);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
      return body.length;
    };
    if (BOTS) {
      if (url.pathname === '/api/beta/me') return void json({ channel: 'beta', wallet: fakeExec.owner, listed: true });
      if (url.pathname === '/api/copy/v1/info') return void json({ executorId: 'fake', kind: 'hosted', version: '0', network: 'mainnet', location: 'here', open: true, owner: null, builder: null, termsVersion: COPY_TERMS_VERSION, viewerCountry: 'DE', keyTtlDaysMax: 180, keyName: 'fake', algos: { maxPerOwner: 500 }, bots: { fee: 5 }, features: ['bots'] });
      if (url.pathname === '/api/copy/v1/me') return void json({ owner: fakeExec.owner, terms: null, policy: { region: 'eea', allowed: true, maxLeverage: 2, reason: null, country: 'DE', mismatch: false }, key: null, copies: [] });
      if (url.pathname === '/api/copy/v1/algos') {
        const list = Array.from({ length: fakeExec.bots }, (_, i) => fakeBot(i, fakeExec.owner, fakeExec.symbols, fakeExec.px));
        const thin = url.searchParams.get('series') === '0';
        for (const v of thin ? list : []) v.algo.book.series = [];
        fakeExec.bytes += json(thin ? { algos: list, noSeries: true } : { algos: list });
        fakeExec.polls++;
        return;
      }
      if (url.pathname.startsWith('/api/copy/v1/')) return void json({ notices: [], entries: [], events: [] });
    }
    if (url.pathname.startsWith('/api')) {
      try {
        const r = await fetch(`http://127.0.0.1:8797${url.pathname}${url.search}`, { method: req.method, signal: AbortSignal.timeout(20_000) });
        res.writeHead(r.status, { 'content-type': r.headers.get('content-type') ?? 'application/json' });
        res.end(Buffer.from(await r.arrayBuffer()));
      } catch {
        res.writeHead(502);
        res.end();
      }
      return;
    }
    let file = join(root, decodeURIComponent(url.pathname));
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(root, 'index.html');
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => {
    const a = server.address() as { port: number };
    ok({ origin: `http://127.0.0.1:${a.port}`, close: () => server.close() });
  }));
}

async function prices(): Promise<Record<string, number>> {
  const r = await fetch('https://mainnet-gw.sodex.dev/api/v1/perps/markets/tickers', { signal: AbortSignal.timeout(15_000) });
  const j = (await r.json()) as { data?: Array<{ symbol: string; lastPx?: string; markPrice?: string; lastPrice?: string; quoteVolume?: string }> };
  const rows = (j.data ?? []).filter((t) => Number(t.lastPx ?? t.markPrice ?? t.lastPrice) > 0);
  rows.sort((a, b) => Number(b.quoteVolume ?? 0) - Number(a.quoteVolume ?? 0));
  const btc = rows.filter((t) => /^BTC/.test(t.symbol));
  const out: Record<string, number> = {};
  for (const t of [...btc, ...rows].slice(0, 12)) out[t.symbol] = Number(t.lastPx ?? t.markPrice ?? t.lastPrice);
  return out;
}

const here = dirname(fileURLToPath(import.meta.url));
const site = await serve(dist!);
const browser = await launchEdge({ headed: false });
const px = await prices();
console.log('markets', Object.keys(px).join(' '));
const results: Array<Record<string, unknown>> = [];

for (const scenario of SCENARIOS) {
  const wallet = createTestWallet();
  const ctx = await newUiContext(browser, wallet, {}, { phone: PHONE_VIEW });
  await ctx.addInitScript({ content: `window.__VS_FAKE = ${JSON.stringify({ owner: wallet.address, prices: px })};` });
  await ctx.addInitScript({ content: readFileSync(join(here, 'fakeAccount.js'), 'utf8') });
  if (scenario === 'bots') {
    const me = wallet.address.toLowerCase();
    Object.assign(fakeExec, { owner: me, symbols: Object.keys(px), px });
    const hash = bytesToHex(keccak256(utf8(canonicalJSON(COPY_TERMS))));
    await ctx.addInitScript({ content: `
      localStorage.setItem(${JSON.stringify(`vd.copy.terms:${me}`)}, ${JSON.stringify(JSON.stringify({ termsVersion: COPY_TERMS_VERSION, termsHash: hash, country: 'DE', acceptedAt: Date.now(), recorded: true, request: {} }))});
      sessionStorage.setItem(${JSON.stringify(`vd.copy.session:/api/copy/v1:${me}`)}, ${JSON.stringify(JSON.stringify({ token: 'fake', expiresAt: Date.now() + 86_400_000 }))});
    ` });
  }
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e?.message ?? e).slice(0, 300)));
  if (scenario === 'bots') fakeExec.bots = 1;
  await page.goto(`${site.origin}/${scenario === 'bots' ? 'bots' : 'trade'}`, { waitUntil: 'domcontentloaded' });
  await hideDevPanel(page).catch(() => {});
  await acceptWelcome(page).catch(() => {});
  await connectWallet(page, { settle: true }).catch((e) => console.log('connect', String(e).slice(0, 200)));
  await dismissOnboarding(page, 3000).catch(() => {});
  await dismissSetup(page, 3000).catch(() => {});
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Performance.enable');
  if (CPU > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU });
  const tab = page.getByRole('tab', { name: TABS[scenario] ?? TABS.orders! }).first();
  if (scenario !== 'bots') await tab.click({ timeout: 10_000 }).catch((e) => console.log('tab', scenario, String(e).slice(0, 200)));
  if (arg('who', '') === '1') await page.getByRole('button', { name: /who traded/i }).first().click({ timeout: 5_000 }).catch((e) => console.log('who traded', String(e).slice(0, 160)));
  const metrics = async () => Object.fromEntries(((await cdp.send('Performance.getMetrics')) as { metrics: Array<{ name: string; value: number }> }).metrics.map((m) => [m.name, m.value]));
  for (const level of LEVELS) {
    const l = LOADS[level]!;
    await page.evaluate((o) => (window as any).__vsLoad.set(o), l);
    fakeExec.bots = l.bots;
    await page.waitForTimeout(8_000);
    // A wider timeframe (interval=1D) brings more of the order lines inside the pane: the labels' worst case.
    const interval = arg('interval', '');
    if (interval) await page.getByRole('button', { name: interval, exact: true }).first().click({ timeout: 5_000 }).catch((e) => console.log('interval', String(e).slice(0, 160)));
    if (interval) await page.waitForTimeout(3_000);
    console.log('labels', JSON.stringify(await page.evaluate(() => ({ shown: document.querySelectorAll('.kc-lbl:not([hidden])').length, blurred: document.querySelectorAll('.kc-lbl.is-blur:not([hidden])').length, tagsBlurred: document.querySelectorAll('.kc-lbl__axis.is-blur:not([hidden])').length }))));
    await page.evaluate(() => (window as any).__vsLoad.reset());
    fakeExec.bytes = 0;
    fakeExec.polls = 0;
    const m0 = await metrics();
    await page.waitForTimeout(SECS * 1000);
    const m1 = await metrics();
    const s = (await page.evaluate(() => (window as any).__vsLoad.stats())) as Record<string, number>;
    const d = (k: string) => (((m1[k] ?? 0) - (m0[k] ?? 0)) * 1000) / SECS;
    // Moving away from the tab and back: what a click feels like under this load.
    const other = page.getByRole('tab', { name: scenario === 'positions' ? TABS.orders! : TABS.positions! }).first();
    const clickMs: number[] = [];
    if (scenario !== 'bots') for (const t of [other, tab]) {
      const h = await t.elementHandle({ timeout: 2000 }).catch(() => null);
      if (h) clickMs.push(await page.evaluate((el) => (window as any).__vsLoad.clickToPaint(el), h));
      await page.waitForTimeout(800);
    }
    // Dragging the chart under this load: the frames and long tasks while it pans.
    let pan: Record<string, number> | null = null;
    if (CHART && !PHONE_VIEW && scenario !== 'bots') {
      const box = await page.locator('canvas').first().boundingBox().catch(() => null);
      if (box) {
        await page.evaluate(() => (window as any).__vsLoad.reset());
        const x = box.x + box.width / 2;
        const y = box.y + box.height / 2;
        await page.mouse.move(x, y);
        if (PROFILE === level) {
          await cdp.send('Profiler.enable');
          await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
          await cdp.send('Profiler.start');
        }
        await page.mouse.down();
        for (let i = 0; i < 60; i++) {
          await page.mouse.move(x + Math.sin(i / 6) * 150, y);
          await page.waitForTimeout(40);
        }
        await page.mouse.up();
        if (PROFILE === level) writeFileSync(`${outFile}.${scenario}-${level}-pan.cpuprofile`, JSON.stringify(((await cdp.send('Profiler.stop')) as { profile: unknown }).profile));
        pan = (await page.evaluate(() => (window as any).__vsLoad.stats())) as Record<string, number>;
      }
    }
    const toasts = await page.locator('[class*="toast"]').count().catch(() => -1);
    const row = {
      scenario, level, ...l, toasts, pan, botsMBPerPoll: fakeExec.polls ? fakeExec.bytes / fakeExec.polls / 1e6 : 0, polls: fakeExec.polls,
      taskMsPerSec: d('TaskDuration'), scriptMsPerSec: d('ScriptDuration'), styleMsPerSec: d('RecalcStyleDuration'), layoutMsPerSec: d('LayoutDuration'),
      genMsPerSec: s.genMs! / SECS, heapMB: (m1.JSHeapUsedSize ?? 0) / 1e6, clickMs,
      ...s,
    };
    results.push(row);
    console.log(`${scenario} ${level} task ${row.taskMsPerSec.toFixed(0)} ms/s (gen ${row.genMsPerSec.toFixed(0)}) frames ${s.frameCount} p50 ${s.frameP50!.toFixed(1)} p95 ${s.frameP95!.toFixed(1)} p99 ${s.frameP99!.toFixed(1)} max ${s.frameMax!.toFixed(0)} long ${s.longTasks}/${s.longTaskMs!.toFixed(0)}ms max ${s.longTaskMax!.toFixed(0)} lag95 ${s.lagP95!.toFixed(0)} click ${clickMs.map((x) => x.toFixed(0)).join('/')} nodes ${s.nodes} heap ${row.heapMB.toFixed(0)}MB frames/s sent ${(s.frames! / SECS).toFixed(0)} toasts ${toasts}${fakeExec.polls ? ` bots poll ${(fakeExec.bytes / fakeExec.polls / 1e6).toFixed(2)} MB x${fakeExec.polls}` : ''}${pan ? ` | pan p50 ${pan.frameP50!.toFixed(1)} p95 ${pan.frameP95!.toFixed(1)} max ${pan.frameMax!.toFixed(0)} long ${pan.longTasks}/${pan.longTaskMs!.toFixed(0)}ms` : ''}`);
    if (SHOTS) await page.screenshot({ path: join(SHOTS, `${scenario}-${level}.png`) }).catch(() => {});
    if (PROFILE === level) {
      await cdp.send('Profiler.enable');
      await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
      await cdp.send('Profiler.start');
      await page.waitForTimeout(15_000);
      const { profile } = (await cdp.send('Profiler.stop')) as { profile: unknown };
      writeFileSync(`${outFile}.${scenario}-${level}.cpuprofile`, JSON.stringify(profile));
    }
    writeFileSync(outFile!, JSON.stringify(results, null, 1));
  }
  if (errors.length) console.log('page errors', scenario, errors.slice(0, 5));
  await ctx.close();
}
await browser.close();
site.close();
process.exit(0);
