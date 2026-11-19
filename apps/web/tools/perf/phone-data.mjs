// When does each page's OWN DATA show on a phone, cold and on an in-app tab switch?
//   node tools/perf/phone-data.mjs <label>=<origin> <out.json> [--runs=2] [--profiles=slow4g,fast4g] [--port=9401]
//
// Per page: a cold load (fresh profile) - first paint, largest paint, and "data": the first element matching the
// page's marker with a digit in it (pages below). Then, in the same tab, a tap on the in-app link to every other page
// (by history.pushState + popstate, which the router follows the same way as a link's click) and the time from it to
// that page's data. Profiles, DevTools' own presets (NetworkManager.ts): Slow 4G 1.6 Mbit/s x 0.9 down, 150 ms x 3.75 latency;
// Fast 4G 9 Mbit/s x 0.9 down, 60 ms x 2.75 latency; both with 4x CPU slowdown, 375x812 Android Chrome, touch.
import { writeFileSync } from 'node:fs';
import { launchChrome, newPage, evaluate, sleep, parseArgs } from './cdp.mjs';

const { flags, positional } = parseArgs(process.argv.slice(2));
const [spec, out] = positional;
const [label, origin] = spec.split('=');
const RUNS = Number(flags.runs ?? 2);
const PROFILES = {
  slow4g: { offline: false, latency: 150 * 3.75, downloadThroughput: (1.6 * 1000 * 1000) / 8 * 0.9, uploadThroughput: (750 * 1000) / 8 * 0.9 },
  fast4g: { offline: false, latency: 60 * 2.75, downloadThroughput: (9 * 1000 * 1000) / 8 * 0.9, uploadThroughput: (1.5 * 1000 * 1000) / 8 * 0.9 },
};
const profiles = String(flags.profiles ?? 'slow4g,fast4g').split(',');
const UA = 'Mozilla/5.0 (Linux; Android 13; SM-A346B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';

export const PAGES = [
  { id: 'trade', path: '/trade', ready: '.kc-legend-ohlc' },
  { id: 'cohorts', path: '/explore', query: '?view=cohorts', ready: '.coh-card__wallets' },
  { id: 'leaderboard', path: '/leaderboard', ready: '.lbp-trader' },
  { id: 'points', path: '/points', ready: '.sdx-market' },
];
const only = flags.pages ? new Set(String(flags.pages).split(',')) : null;
const pages = PAGES.filter((p) => !only || only.has(p.id));

const observer = `(() => {
  const P = window.__pd = { fcp: 0, lcp: 0, marks: {} };
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) P.lcp = e.startTime; }).observe({ type: 'largest-contentful-paint', buffered: true }); } catch {}
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.name === 'first-contentful-paint') P.fcp = e.startTime; }).observe({ type: 'paint', buffered: true }); } catch {}
  window.__pdWatch = (key, sel) => new Promise((done) => {
    const hit = () => { for (const el of document.querySelectorAll(sel)) { const r = el.getBoundingClientRect(); if (r.width && r.height && /[0-9]/.test(el.textContent)) return true; } return false; };
    if (hit()) { P.marks[key] = performance.now(); return done(P.marks[key]); }
    const mo = new MutationObserver(() => { if (hit()) { P.marks[key] = performance.now(); mo.disconnect(); clearInterval(iv); done(P.marks[key]); } });
    mo.observe(document, { subtree: true, childList: true, characterData: true });
    const iv = setInterval(() => { if (hit()) { P.marks[key] = performance.now(); mo.disconnect(); clearInterval(iv); done(P.marks[key]); } }, 50);
  });
  try { localStorage.setItem('vd.site.terms.look', JSON.stringify('2026-11-14')); } catch {}
})();`;

const chrome = await launchChrome({ port: Number(flags.port ?? 9401), width: 375, height: 812, extraArgs: ['--ignore-certificate-errors'] }); // the local HTTP/2 server's self-signed certificate
const results = [];
try {
  for (let run = 0; run < RUNS; run++) {
    for (const prof of profiles) {
      for (const pg of pages) {
        const page = await newPage(chrome.cdp, { width: 375, height: 812, dpr: 2 });
        await page.send('Page.enable');
        await page.send('Network.enable');
        await page.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 2, mobile: true });
        await page.send('Emulation.setUserAgentOverride', { userAgent: UA, platform: 'Android' });
        await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
        await page.send('Emulation.setCPUThrottlingRate', { rate: 4 });
        await page.send('Network.emulateNetworkConditions', PROFILES[prof]);
        await page.send('Page.addScriptToEvaluateOnNewDocument', { source: observer });
        await page.send('Page.navigate', { url: origin + pg.path + (pg.query ?? '') });
        const cap = prof === 'slow4g' ? 45000 : 25000;
        const data = await evaluate(page, `Promise.race([window.__pdWatch('data', ${JSON.stringify(pg.ready)}), new Promise((r) => setTimeout(() => r(0), ${cap}))])`).catch(() => 0);
        await sleep(prof === 'slow4g' ? 12000 : 6000); // the load event and the prefetch of other pages' code
        const p = await evaluate(page, 'JSON.stringify(window.__pd)').then(JSON.parse);
        const row = { label, run, profile: prof, page: pg.id, fcp: Math.round(p.fcp), lcp: Math.round(p.lcp), data: Math.round(data), switches: {} };
        // In-app switches: tap the link to each other page, wait for its data, then come back.
        for (const to of pages) {
          if (to.id === pg.id) continue;
          // The app's router follows popstate (router.ts useRoute), the same path a link's click takes, in every build.
          const t = await evaluate(page, `(async () => {
            const t0 = performance.now();
            history.pushState(history.state, '', '${to.path}${to.query ?? ''}');
            dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
            const t1 = await Promise.race([window.__pdWatch('to-${to.id}-' + t0, ${JSON.stringify(to.ready)}), new Promise((r) => setTimeout(() => r(0), 20000))]);
            return t1 ? Math.round(t1 - t0) : 0;
          })()`).catch(() => -2);
          row.switches[to.id] = t;
          await sleep(1500);
        }
        results.push(row);
        console.log(`${label} r${run} ${prof} ${pg.id}: fcp ${row.fcp} lcp ${row.lcp} data ${row.data} | switch ${Object.entries(row.switches).map(([k, v]) => `${k} ${v}`).join(', ')}`);
        writeFileSync(out, JSON.stringify(results, null, 1));
        await page.close();
      }
    }
  }
} finally {
  await chrome.close();
}
