// How long a timeframe tap, and a return to the Trade tab, take to put candles on the chart - on a phone.
//   node tools/perf/chart-switch.mjs <origin> [--runs=3] [--profile=none|fast4g|slow4g] [--port=9411] [--out=file.json]
//
// 375x812 Android Chrome, touch, 4x CPU slowdown, the network as `--profile` says (DevTools' presets, as phone-data.mjs)
// once the first candles are up - the page's own code is in by then, so only the switches' reads are throttled.
// Per run, in one tab on /trade?debug=chart:
//   1m -> 5m   a series this page has not shown yet (a network load)
//   5m -> 1m   a series it showed seconds ago (Chart.tsx keeps it: chart/seriesCache.ts)
//   1m -> 5m   seen as well
//   Trade -> Bots -> Trade   the tab bar's way back (the chart unmounts and mounts again)
// Each tap is a real touch (Input.dispatchTouchEvent, 80 ms between down and up). "Drawn" is the first frame after
// the chart's legend names the new interval: the commit that unmasks the plot and starts the candles' morph in.
// The chart's own log lines say which path each switch took ('kept series shown at once' or 'klines response').
import { writeFileSync } from 'node:fs';
import { launchChrome, newPage, evaluate, sleep, parseArgs } from './cdp.mjs';

const { flags, positional } = parseArgs(process.argv.slice(2));
const origin = positional[0];
if (!origin) throw new Error('usage: node chart-switch.mjs <origin> [--runs=3] [--profile=none|fast4g|slow4g]');
const RUNS = Number(flags.runs ?? 3);
const PROFILES = {
  none: null,
  slow4g: { offline: false, latency: 150 * 3.75, downloadThroughput: (1.6 * 1000 * 1000) / 8 * 0.9, uploadThroughput: (750 * 1000) / 8 * 0.9 },
  fast4g: { offline: false, latency: 60 * 2.75, downloadThroughput: (9 * 1000 * 1000) / 8 * 0.9, uploadThroughput: (1.5 * 1000 * 1000) / 8 * 0.9 },
};
const profile = String(flags.profile ?? 'none');
const UA = 'Mozilla/5.0 (Linux; Android 13; SM-A346B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';

const probe = `(() => {
  const S = window.__cs = { t0: 0, at: 0, click: 0 };
  document.addEventListener('pointerdown', () => { S.t0 = performance.now(); S.at = Date.now(); }, true);
  document.addEventListener('click', () => { S.click = performance.now(); }, true);
  /** The first frame in which the legend names interval iv (and shows a price). */
  window.__csDrawn = (iv, capMs) => new Promise((done) => {
    const hit = () => { const el = document.querySelector('.kc-legend-sym'); return !!el && el.textContent.includes('· ' + iv) && /[0-9]/.test(document.querySelector('.kc-legend-ohlc')?.textContent ?? ''); };
    const fin = () => requestAnimationFrame(() => done(performance.now()));
    if (hit()) return fin();
    const mo = new MutationObserver(() => { if (hit()) { mo.disconnect(); clearTimeout(cap); fin(); } });
    mo.observe(document.body, { subtree: true, childList: true, characterData: true });
    const cap = setTimeout(() => { mo.disconnect(); done(0); }, capMs);
  });
  try { localStorage.setItem('vd.site.terms.look', JSON.stringify('2026-11-14')); } catch {}
})();`;

const chrome = await launchChrome({ port: Number(flags.port ?? 9411), width: 375, height: 812 });
const rows = [];
try {
  for (let run = 0; run < RUNS; run++) {
    const page = await newPage(chrome.cdp, { width: 375, height: 812, dpr: 2 });
    await page.send('Page.enable');
    await page.send('Network.enable');
    await page.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 2, mobile: true });
    await page.send('Emulation.setUserAgentOverride', { userAgent: UA, platform: 'Android' });
    await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await page.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: probe });
    // The candle reads, from the network's own events (the page's resource timing buffer fills up on a dev server).
    const reads = new Map();
    page.on('Network.requestWillBeSent', (p) => { if (/\/klines\?/.test(p.request.url)) reads.set(p.requestId, { url: p.request.url.replace(/^https?:\/\/[^/]+/, ''), sent: p.timestamp }); });
    page.on('Network.loadingFinished', (p) => { const r = reads.get(p.requestId); if (r) { r.ms = Math.round((p.timestamp - r.sent) * 1000); r.bytes = p.encodedDataLength; } });
    await page.send('Page.navigate', { url: `${origin}/trade?debug=chart` });
    for (let i = 0; i < 100 && !(await evaluate(page, `!!window.__csDrawn && location.pathname === '/trade'`).catch(() => false)); i++) await sleep(100);
    const first = await evaluate(page, `window.__csDrawn('1m', 60000)`).catch(() => 0);
    await sleep(4000);
    // The network profile from here on: the switches are what is measured, with the page's code in
    // (a dev server's hundreds of modules would otherwise be measured too).
    if (PROFILES[profile]) await page.send('Network.emulateNetworkConditions', PROFILES[profile]);
    await sleep(1000);
    const touch = async (sel, text) => {
      const box = JSON.parse(await evaluate(page, `(() => { const el = [...document.querySelectorAll(${JSON.stringify(sel)})].find((e) => e.textContent.trim() === ${JSON.stringify(text)} && e.getBoundingClientRect().width > 0); if (!el) return 'null'; const r = el.getBoundingClientRect(); return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 }); })()`));
      if (!box) throw new Error(`no ${sel} "${text}" on screen`);
      await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x, y: box.y, id: 1 }] });
      await sleep(80);
      await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    };
    /** The chart's log lines since the tap, with their time after it. */
    const steps = () => evaluate(page, `JSON.stringify((window.__vs?.logs?.() ?? []).filter((e) => e.ns === 'chart' && e.t >= window.__cs.at).map((e) => (e.t - window.__cs.at) + 'ms ' + e.msg))`).then(JSON.parse).catch(() => []);
    /** ms from the finger going down to the candles drawn (and, in row.fromClick, from the click). */
    const tf = async (to) => {
      const wait = evaluate(page, `window.__csDrawn(${JSON.stringify(to)}, 30000).then((t) => JSON.stringify(t ? [Math.round(t - window.__cs.t0), Math.round(t - window.__cs.click)] : [0, 0]))`);
      await touch('.kc-tf', to);
      const [ms, fromClick] = JSON.parse(await wait);
      await sleep(2500);
      const n = Object.keys(row.steps ?? {}).length;
      (row.steps ??= {})[`${to}#${n}`] = await steps();
      (row.fromClick ??= []).push(fromClick);
      return ms;
    };
    const row = { run, profile, firstCandlesMs: Math.round(first) };
    row.unseen_1m_to_5m = await tf('5m');
    row.seen_5m_to_1m = await tf('1m');
    row.seen_1m_to_5m = await tf('5m');
    // Back to 1m, then away to another tab and back: the chart mounts again.
    await tf('1m');
    const back = await evaluate(page, `(async () => {
      history.pushState(history.state, '', '/bots');
      dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
      await new Promise((r) => setTimeout(r, 3000));
      const wait = window.__csDrawn('1m', 30000);
      const t0 = performance.now();
      history.pushState(history.state, '', '/trade');
      dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
      const t = await wait;
      return t ? Math.round(t - t0) : 0;
    })()`).catch(() => -1);
    row.return_to_trade = back;
    await sleep(2500);
    const logs = await evaluate(page, `JSON.stringify((window.__vs?.logs?.() ?? []).filter((e) => e.ns === 'chart').map((e) => e.msg).filter((m) => /kept series|klines response|series switch|older bars|early read/.test(m)))`).then(JSON.parse).catch(() => []);
    row.paths = logs;
    row.klineReads = [...reads.values()].map((r) => ({ url: r.url, ms: r.ms, bytes: r.bytes }));
    rows.push(row);
    console.log(JSON.stringify({ ...row, paths: row.paths.length, klineReads: row.klineReads.length }));
    await page.close();
  }
} finally {
  await chrome.close();
}
if (flags.out) writeFileSync(String(flags.out), JSON.stringify(rows, null, 2));
const medOf = (vals) => {
  const v = vals.filter((x) => x > 0).sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : 0;
};
const med = (k) => medOf(rows.map((r) => r[k]));
console.log(JSON.stringify({
  median: Object.fromEntries(['firstCandlesMs', 'unseen_1m_to_5m', 'seen_5m_to_1m', 'seen_1m_to_5m', 'return_to_trade'].map((k) => [k, med(k)])),
  medianFromClick: { unseen_1m_to_5m: medOf(rows.map((r) => r.fromClick?.[0] ?? 0)), seen_5m_to_1m: medOf(rows.map((r) => r.fromClick?.[1] ?? 0)), seen_1m_to_5m: medOf(rows.map((r) => r.fromClick?.[2] ?? 0)) },
}));
