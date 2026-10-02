// Runtime metrics per page of one or more served builds (vite preview -> a live API).
//
//   node tools/perf/metrics.mjs base=http://127.0.0.1:4180,after=http://127.0.0.1:4181 out.json
//        [--runs=3] [--profile=fast|slow|both] [--pages=<regex>] [--port=9333] [--return]
//
// Each run is a cold load in a fresh browser profile (empty HTTP cache and storage).
// With --return it is a RETURN VISIT instead: the same page was loaded once before in
// that profile (unthrottled, not measured), so the HTTP cache and localStorage are warm.
// The origins are interleaved run by run, so every build sees the same backend,
// exchanges and network. Reported per page and profile, as the median of the runs:
//   FCP, LCP, CLS            from PerformanceObserver
//   data shown               the page's own data on screen (pages.mjs `ready`), ms from navigation
//   TBT                      blocking time of the long tasks between FCP and TTI
//   TBT incl. load           the same from navigation start (counts the boot script)
//   TTI                      end of the last long task that is followed by 5 quiet seconds
//   JS heap                  after a forced GC at the end of the observation
//   requests / bytes         started in the first WINDOW seconds, split into the build's
//                            own files, OUR API (/api) and the exchanges (traffic.mjs)
//   WebSockets               opened in the window (page and SharedWorker), frames received
import { writeFileSync } from 'node:fs';
import { evaluate, launchChrome, newContext, newPage, parseArgs, sleep, watchSharedWorkers } from './cdp.mjs';
import { pagesFor, scanAddresses, selectPages } from './pages.mjs';
import { createTraffic } from './traffic.mjs';

const { flags, positional } = parseArgs(process.argv.slice(2));
const [originArg, outFile] = positional;
if (!originArg || !outFile) {
  console.error('usage: metrics.mjs label=origin[,label=origin] out.json [--runs=3] [--profile=fast|slow|both] [--pages=regex] [--port=9333] [--return]');
  process.exit(2);
}
const RUNS = Number(flags.runs ?? 3);
const RETURN_VISIT = Boolean(flags.return);
/** The first visit of a return visit: long enough for the page to finish starting. */
const FIRST_VISIT_MS = 7_000;
const PROFILES = {
  // `window`: seconds after navigation in which requests are counted.
  fast: { name: 'fast', cpu: 1, net: null, window: 10, max: 30_000 },
  // A mid-range laptop on a so-so connection: 4x CPU slowdown, 10 Mbit/s down, 40 ms RTT.
  slow: {
    name: 'slow', cpu: 4, window: 20, max: 45_000,
    net: { offline: false, latency: 40, downloadThroughput: (10 * 1024 * 1024) / 8, uploadThroughput: (5 * 1024 * 1024) / 8 },
  },
};
const profileArg = flags.profile ?? 'both';
const profiles = profileArg === 'both' ? [PROFILES.fast, PROFILES.slow] : [PROFILES[profileArg]];
if (profiles.some((p) => !p)) { console.error('--profile must be fast, slow or both'); process.exit(2); }

/** Installed before the page's first script. `ready` is the page's pages.mjs marker, or null. */
const observer = (ready) => `(() => {
  const P = window.__perf = { lcp: 0, lcpSize: 0, lcpEl: '', cls: 0, lt: [], fcp: 0, ready: null };
  const READY = ${JSON.stringify(ready ?? null)};
  if (READY) {
    const shown = () => { for (const el of document.querySelectorAll(READY.selector)) if (READY.anyText || /[0-9]/.test(el.textContent)) return true; return false; };
    const mo = new MutationObserver(() => { if (shown()) { P.ready = performance.now(); mo.disconnect(); } });
    mo.observe(document, { childList: true, subtree: true, characterData: true });
  }
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) { P.lcp = e.startTime; P.lcpSize = e.size; P.lcpEl = e.element ? (e.element.tagName + '.' + String(e.element.className || '').slice(0, 60)) : (e.url || ''); } }).observe({ type: 'largest-contentful-paint', buffered: true }); } catch {}
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) P.lt.push([e.startTime, e.duration]); }).observe({ type: 'longtask', buffered: true }); } catch {}
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) P.cls += e.value; }).observe({ type: 'layout-shift', buffered: true }); } catch {}
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.name === 'first-contentful-paint') P.fcp = e.startTime; }).observe({ type: 'paint', buffered: true }); } catch {}
})();`;

/** End of the last long task that 5 quiet seconds follow; null when the observation ended before such a gap. */
function computeTti(fcp, lts, observedUntil) {
  let cand = fcp;
  for (const [s, d] of lts) {
    const e = s + d;
    if (e <= cand) continue;
    if (s - cand >= 5000) return cand;
    cand = Math.max(cand, e);
  }
  return observedUntil - cand >= 5000 ? cand : null;
}
/** Total blocking time: what each long task spends past its first 50 ms, inside [from, to]. */
function blocking(lts, from, to) {
  let t = 0;
  for (const [s, d] of lts) {
    const a = Math.max(s, from), b = Math.min(s + d, to);
    if (b - a > 50) t += b - a - 50;
  }
  return t;
}

// The shared worker of the page being measured reports into that page's recorder.
let current = null;

async function measureOnce(cdp, origin, pg, profile) {
  let context = null;
  if (RETURN_VISIT) {
    context = await newContext(cdp);
    const first = await newPage(cdp, { context: context.id });
    await first.send('Page.enable');
    await first.send('Page.navigate', { url: origin + pg.path });
    await sleep(FIRST_VISIT_MS);
    await first.close();
  }
  const page = await newPage(cdp, { context: context?.id });
  const traffic = createTraffic(origin);
  current = traffic;
  let loaded = false;
  page.on('Page.loadEventFired', () => { loaded = true; });
  await page.send('Page.enable');
  await traffic.attach(page, 'page');
  await page.send('Network.setCacheDisabled', { cacheDisabled: false });
  await page.send('Runtime.enable');
  await page.send('Performance.enable', {});
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: observer(pg.ready) });
  if (profile.cpu > 1) await page.send('Emulation.setCPUThrottlingRate', { rate: profile.cpu });
  if (profile.net) await page.send('Network.emulateNetworkConditions', profile.net);
  const t0 = Date.now();
  await page.send('Page.navigate', { url: origin + pg.path });
  const MIN = profile.window * 1000 + 500;
  let perf;
  for (;;) {
    await sleep(300);
    const el = Date.now() - t0;
    if (!loaded && el < profile.max) continue;
    perf = await evaluate(page, 'JSON.stringify({ ...window.__perf, now: performance.now() })').then(JSON.parse).catch(() => null);
    if (!perf) continue;
    const lastLt = perf.lt.length ? perf.lt[perf.lt.length - 1][0] + perf.lt[perf.lt.length - 1][1] : 0;
    const quiet = perf.now - Math.max(lastLt, perf.fcp) >= 5200;
    if (el >= profile.max || (el >= MIN && perf.fcp > 0 && quiet)) break;
  }
  const action = pg.action ? await pg.action(page) : null;
  const tti = computeTti(perf.fcp, perf.lt, perf.now);
  const m = Object.fromEntries((await page.send('Performance.getMetrics')).metrics.map((x) => [x.name, x.value]));
  await page.send('HeapProfiler.enable').catch(() => {});
  await page.send('HeapProfiler.collectGarbage').catch(() => {});
  const heap = await page.send('Runtime.getHeapUsage').catch(() => ({}));
  const net = traffic.summary(0, profile.window);
  const res = {
    fcp: perf.fcp, lcp: perf.lcp, lcpEl: perf.lcpEl, cls: perf.cls, ready: perf.ready,
    tti, tbt: blocking(perf.lt, perf.fcp, tti ?? perf.now),
    tbtFromStart: blocking(perf.lt, 0, tti ?? perf.now),
    longTasks: perf.lt.length, longTaskMs: perf.lt.reduce((s, [, d]) => s + d, 0),
    maxLongTask: perf.lt.reduce((s, [, d]) => Math.max(s, d), 0),
    heapUsed: heap.usedSize, nodes: m.Nodes, listeners: m.JSEventListeners,
    scriptMs: m.ScriptDuration * 1000, taskMs: m.TaskDuration * 1000,
    layoutCount: m.LayoutCount, styleCount: m.RecalcStyleCount, layoutMs: m.LayoutDuration * 1000, styleMs: m.RecalcStyleDuration * 1000,
    siteRequests: net.site.n, siteBytes: net.site.bytes,
    apiRequests: net.api.n - net.api.cached, apiBytes: net.api.bytes,
    directRequests: net.direct.n, directBytes: net.direct.bytes,
    sockets: net.ws.opened, socketFrames: net.ws.frames, socketBytes: net.ws.bytes,
    net, observedMs: perf.now, action,
    failed: [...traffic.requests.values()].filter((r) => r.failed && r.failed !== 'canceled' && !/ERR_ABORTED/.test(r.failed)).map((r) => `${r.failed} ${r.url}`).slice(0, 8),
  };
  await page.close();
  await context?.dispose();
  current = null;
  return res;
}

const median = (xs) => {
  const a = xs.filter((x) => x != null && !Number.isNaN(x)).sort((p, q) => p - q);
  if (!a.length) return null;
  const k = a.length >> 1;
  return a.length % 2 ? a[k] : (a[k - 1] + a[k]) / 2;
};
const KEYS = [
  'fcp', 'lcp', 'ready', 'cls', 'tti', 'tbt', 'tbtFromStart', 'longTasks', 'longTaskMs', 'maxLongTask', 'heapUsed', 'nodes', 'listeners',
  'scriptMs', 'taskMs', 'layoutCount', 'styleCount', 'layoutMs', 'styleMs',
  'siteRequests', 'siteBytes', 'apiRequests', 'apiBytes', 'directRequests', 'directBytes', 'sockets', 'socketFrames', 'socketBytes',
];

const ORIGINS = originArg.split(',').map((x) => { const i = x.indexOf('='); return [x.slice(0, i), x.slice(i + 1).replace(/\/$/, '')]; });
const addr = await scanAddresses(ORIGINS[0][1]);
const pages = selectPages(pagesFor(addr), flags.pages);
const out = { origins: Object.fromEntries(ORIGINS), runs: RUNS, visit: RETURN_VISIT ? 'return' : 'first', when: new Date().toISOString(), scanAddresses: addr, profiles: Object.fromEntries(profiles.map((p) => [p.name, { cpu: p.cpu, net: p.net, windowSeconds: p.window }])), pages: {} };
const chrome = await launchChrome({ port: Number(flags.port ?? 9333) });
try {
  await watchSharedWorkers(chrome.cdp, async (session) => { if (current) await current.attach(session, 'worker'); });
  for (const pg of pages) {
    for (const prof of profiles) {
      const runs = Object.fromEntries(ORIGINS.map(([l]) => [l, []]));
      for (let i = 0; i < RUNS; i++) {
        for (const [label, o] of (i % 2 ? [...ORIGINS].reverse() : ORIGINS)) {
          try {
            const r = await measureOnce(chrome.cdp, o, pg, prof);
            runs[label].push(r);
            const kb = (b) => `${(b / 1024).toFixed(0)}kB`;
            console.log(`${label} ${pg.id} [${prof.name}] #${i + 1}: fcp ${r.fcp.toFixed(0)} lcp ${r.lcp.toFixed(0)} data ${r.ready == null ? '-' : r.ready.toFixed(0)} tbt ${r.tbt.toFixed(0)} tbt0 ${r.tbtFromStart.toFixed(0)} tti ${r.tti == null ? '-' : r.tti.toFixed(0)} site ${r.siteRequests}/${kb(r.siteBytes)} api ${r.apiRequests}/${kb(r.apiBytes)} direct ${r.directRequests}/${kb(r.directBytes)} ws ${r.sockets} (${r.socketFrames} frames) heap ${(r.heapUsed / 1048576).toFixed(1)}MB`);
          } catch (e) {
            current = null;
            console.log(`${label} ${pg.id} [${prof.name}] #${i + 1} failed: ${e.message}`);
          }
        }
      }
      for (const [label] of ORIGINS) {
        const med = Object.fromEntries(KEYS.map((k) => [k, median(runs[label].map((r) => r[k]))]));
        out.pages[`${label}|${pg.id}|${prof.name}`] = { median: med, runs: runs[label] };
      }
      writeFileSync(outFile, JSON.stringify(out, null, 2));
    }
  }
} finally {
  await chrome.close();
}
console.log('done ->', outFile);
