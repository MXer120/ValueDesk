// How fast does a tap on a phone answer? A real touch (CDP Input.dispatchTouchEvent) on a navigation item, 375x812
// Android Chrome, 4x CPU, after the page has loaded and its after-load prefetch is done. Per tap, from the finger
// lifting (touchend) to:
//   lit:  the first frame in which the tapped item is drawn as the current page (aria-current="page"),
//   page: the first frame in which the next page's own marker is on screen.
// Times are taken in the page (performance.now() at touchend; a frame = the requestAnimationFrame after the change).
//   node tools/perf/tap-lit.mjs <label>=<origin> <out.json> [--runs=3] [--profile=slow4g|fast4g|none] [--port=9421]
import { writeFileSync } from 'node:fs';
import { launchChrome, newPage, evaluate, sleep, parseArgs } from './cdp.mjs';

const { flags, positional } = parseArgs(process.argv.slice(2));
const [spec, out] = positional;
const [label, origin] = spec.split('=');
const RUNS = Number(flags.runs ?? 3);
const NETS = {
  slow4g: { offline: false, latency: 150 * 3.75, downloadThroughput: (1.6 * 1000 * 1000) / 8 * 0.9, uploadThroughput: (750 * 1000) / 8 * 0.9 },
  fast4g: { offline: false, latency: 60 * 2.75, downloadThroughput: (9 * 1000 * 1000) / 8 * 0.9, uploadThroughput: (1.5 * 1000 * 1000) / 8 * 0.9 },
};
const NET = NETS[flags.profile ?? 'slow4g'] ?? null;
const UA = 'Mozilla/5.0 (Linux; Android 13; SM-A346B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
/* From /trade to each page, by the link to it that a phone shows (the tab bar's, else the navbar's), and that page's marker. */
const TAPS = [
  { to: '/bots', ready: '.bots-page, .bots-list, .bots-empty, main' },
  { to: '/points', ready: '.sdx-market' },
  { to: '/portfolio', ready: '.pf' },
  { to: '/trade', ready: '.kc-legend-ohlc' },
];

const probe = `window.__tap = (href, ready) => new Promise((done) => {
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight; };
  const link = [...document.querySelectorAll('a[href="' + href + '"]')].find(vis);
  if (!link) return done({ missing: true });
  const r = link.getBoundingClientRect();
  const res = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  let t0 = 0, lit = 0, page = 0;
  const frame = (set) => requestAnimationFrame(() => set(performance.now() - t0));
  const check = () => {
    if (!t0) return;
    if (!lit && link.isConnected && link.getAttribute('aria-current') === 'page') { lit = -1; frame((v) => { lit = v; fin(); }); }
    if (!page && location.pathname === href && [...document.querySelectorAll(ready)].some(vis)) { page = -1; frame((v) => { page = v; fin(); }); }
  };
  const fin = () => { if (lit > 0 && page > 0) { mo.disconnect(); clearInterval(iv); clearTimeout(cap); done({ lit: Math.round(lit), page: Math.round(page) }); } };
  const mo = new MutationObserver(check);
  mo.observe(document, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['aria-current', 'class'] });
  const iv = setInterval(check, 16); // a marker whose text changes in place is seen too
  addEventListener('touchend', () => { t0 = performance.now(); check(); }, { once: true, capture: true });
  const cap = setTimeout(() => { mo.disconnect(); clearInterval(iv); done({ lit: lit > 0 ? Math.round(lit) : null, page: page > 0 ? Math.round(page) : null, timeout: true }); }, 20000);
  window.__tapAt = res;
});`;

const chrome = await launchChrome({ port: Number(flags.port ?? 9421), width: 375, height: 812, extraArgs: ['--ignore-certificate-errors'] });
const results = [];
try {
  for (let run = 0; run < RUNS; run++) {
    const page = await newPage(chrome.cdp, { width: 375, height: 812, dpr: 2 });
    await page.send('Page.enable');
    await page.send('Network.enable');
    await page.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 2, mobile: true });
    await page.send('Emulation.setUserAgentOverride', { userAgent: UA, platform: 'Android' });
    await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await page.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    if (NET) await page.send('Network.emulateNetworkConditions', NET);
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `try{localStorage.setItem('vd.site.terms.look', JSON.stringify('2026-11-14'))}catch{}` });
    await page.send('Page.navigate', { url: origin + '/trade' });
    await sleep(NET === NETS.slow4g ? 40000 : 20000); // the load event and the after-load prefetch of the other pages
    for (const t of TAPS) {
      await evaluate(page, probe);
      const pending = evaluate(page, `window.__tap(${JSON.stringify(t.to)}, ${JSON.stringify(t.ready)})`);
      await sleep(100);
      const at = JSON.parse(await evaluate(page, 'JSON.stringify(window.__tapAt || null)'));
      if (!at) { results.push({ label, run, to: t.to, missing: true }); console.log(`${label} r${run} ${t.to}: no link`); await pending.catch(() => {}); continue; }
      const point = [{ x: at.x, y: at.y }];
      await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point });
      await sleep(80);
      await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      const r = await pending;
      results.push({ label, run, to: t.to, ...r });
      console.log(`${label} r${run} ${t.to}: lit ${r.lit ?? '-'} ms, page ${r.page ?? '-'} ms${r.timeout ? ' (cap)' : ''}${r.missing ? ' (no link)' : ''}`);
      writeFileSync(out, JSON.stringify(results, null, 1));
      await sleep(2500);
    }
    await page.close();
  }
} finally {
  await chrome.close();
}
