// Cold phone loads under Chrome DevTools' "Slow 4G" preset plus 4x CPU, 375x812 Android Chrome.
//   node tools/perf/phone-load.mjs <label>=<origin> <out.json> [--runs=2] [--langs=en,pt,de] [--pages=/,/trade,/points] [--port=9361]
// Slow 4G = DevTools NetworkManager.ts Slow4GConditions: 1.6 Mbit/s x 0.9 down, 750 kbit/s x 0.9 up, 150 ms x 3.75 latency.
import { writeFileSync } from 'node:fs';
import { launchChrome, newPage, evaluate, sleep, parseArgs } from "./cdp.mjs";
const { flags, positional } = parseArgs(process.argv.slice(2));
const [spec, out] = positional;
const [label, origin] = spec.split('=');
const RUNS = Number(flags.runs ?? 2);
const LANGS = String(flags.langs ?? 'en,pt,de').split(',');
const PAGES = String(flags.pages ?? '/,/trade,/points').split(',');
const WINDOW_MS = Number(flags.window ?? 30000);
const NET = { offline: false, latency: 150 * 3.75, downloadThroughput: (1.6 * 1000 * 1000) / 8 * 0.9, uploadThroughput: (750 * 1000) / 8 * 0.9 };
const UA = 'Mozilla/5.0 (Linux; Android 13; SM-A346B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';

const observer = `(() => {
  const P = window.__perf = { lcp: 0, lcpEl: '', fcp: 0 };
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) { P.lcp = e.startTime; P.lcpEl = e.element ? e.element.tagName + '.' + String(e.element.className || '').slice(0, 40) : (e.url || ''); } }).observe({ type: 'largest-contentful-paint', buffered: true }); } catch {}
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.name === 'first-contentful-paint') P.fcp = e.startTime; }).observe({ type: 'paint', buffered: true }); } catch {}
  P.lang = 0;
  let want = null; try { want = localStorage.getItem('vs.lang'); } catch {}
  if (want && want !== 'en') {
    const EN = location.pathname.startsWith('/points') ? ['Connect wallet'] : ['Connect wallet', 'Mark Price', 'Order Book'];
    const check = () => { const b = document.body; if (!b || !b.innerText) return; const t = b.innerText; if (!/[0-9]/.test(t)) return; if (EN.every((w) => !t.includes(w)) && document.querySelector('.navbtn')) { P.lang = performance.now(); mo.disconnect(); clearInterval(iv); } };
    const mo = new MutationObserver(check); mo.observe(document, { subtree: true, childList: true, characterData: true });
    const iv = setInterval(check, 100);
  }
})();`;

const chrome = await launchChrome({ port: Number(flags.port ?? 9361), width: 375, height: 812, extraArgs: ['--ignore-certificate-errors'] }); // the local HTTP/2 server's self-signed certificate
const results = [];
try {
  for (let run = 0; run < RUNS; run++) {
    for (const lang of LANGS) {
      for (const path of PAGES) {
        const page = await newPage(chrome.cdp, { width: 375, height: 812, dpr: 2 });
        const reqs = new Map();
        let t0 = null;
        page.on('Network.requestWillBeSent', (e) => {
          if (t0 === null && e.type === 'Document') t0 = e.timestamp;
          if (!reqs.has(e.requestId)) reqs.set(e.requestId, { url: e.request.url, start: e.timestamp, type: e.type });
        });
        page.on('Network.loadingFinished', (e) => { const r = reqs.get(e.requestId); if (r) { r.end = e.timestamp; r.bytes = e.encodedDataLength; } });
        await page.send('Page.enable');
        await page.send('Network.enable');
        await page.send('Network.setCacheDisabled', { cacheDisabled: true });
        await page.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 2, mobile: true });
        await page.send('Emulation.setUserAgentOverride', { userAgent: UA, platform: 'Android' });
        await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
        await page.send('Emulation.setCPUThrottlingRate', { rate: 4 });
        await page.send('Network.emulateNetworkConditions', NET);
        const boot = lang === 'en' ? observer : `try{localStorage.setItem('vs.lang',${JSON.stringify(lang)})}catch{};${observer}`;
        await page.send('Page.addScriptToEvaluateOnNewDocument', { source: boot });
        await page.send('Page.navigate', { url: origin + path });
        await sleep(WINDOW_MS);
        const perf = await evaluate(page, 'JSON.stringify(window.__perf)').then(JSON.parse).catch(() => ({}));
        await page.close();
        const list = [...reqs.values()].filter((r) => r.end).map((r) => ({
          url: r.url.replace(origin, '').slice(0, 90), type: r.type, bytes: r.bytes,
          startMs: Math.round((r.start - t0) * 1000), endMs: Math.round((r.end - t0) * 1000),
        })).sort((a, b) => a.endMs - b.endMs);
        const own = list.filter((r) => !/^https?:/.test(r.url));
        const before = (ms) => own.filter((r) => r.endMs <= ms);
        const sum = (l) => l.reduce((s, r) => s + r.bytes, 0);
        const i18n = own.filter((r) => r.url.startsWith('/i18n/'));
        const res = {
          label, run, lang, path, fcp: Math.round(perf.fcp || 0), langShown: Math.round(perf.lang || 0), lcp: Math.round(perf.lcp || 0), lcpEl: perf.lcpEl,
          bytesBeforeFcp: sum(before(perf.fcp)), reqsBeforeFcp: before(perf.fcp).length,
          bytesBeforeLcp: sum(before(perf.lcp)), reqsBeforeLcp: before(perf.lcp).length,
          siteBytes: sum(own.filter((r) => !r.url.startsWith('/api/'))), apiBytes: sum(own.filter((r) => r.url.startsWith('/api/'))),
          i18nBytes: sum(i18n), i18nDoneMs: i18n.length ? Math.max(...i18n.map((r) => r.endMs)) : 0, i18nFiles: i18n.length,
          thirdPartyBytes: sum(list.filter((r) => /^https?:/.test(r.url))),
          i18nReqs: i18n.map((r) => `${r.startMs}-${r.endMs}ms ${r.bytes}B ${r.url}`),
          firstScreen: before(Math.max(perf.lcp || 0, perf.fcp || 0)).map((r) => `${r.endMs}ms ${r.bytes}B ${r.url}`),
        };
        results.push(res);
        console.log(`${label} run${run} ${lang} ${path}: FCP ${res.fcp} LCP ${res.lcp} lang ${res.langShown} | before LCP ${(res.bytesBeforeLcp / 1024).toFixed(0)} KB in ${res.reqsBeforeLcp} req | site ${(res.siteBytes / 1024).toFixed(0)} KB, i18n ${(res.i18nBytes / 1024).toFixed(0)} KB (${res.i18nFiles} files, done ${res.i18nDoneMs} ms)`);
        writeFileSync(out, JSON.stringify(results, null, 1));
      }
    }
  }
} finally {
  await chrome.close();
}
