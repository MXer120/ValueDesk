// Steady-state traffic of every page: requests per minute to OUR server (per path) and
// to the exchanges (per host), what a hidden tab still sends, and what it catches up on
// when it is shown again.
//
//   node tools/perf/rates.mjs <origin> out.json [--pages=<regex>] [--visible=120] [--hidden=45]
//        [--back=5] [--access-log=<file>] [--port=9350]
//
// Each page: a fresh browser profile, VISIBLE seconds in the foreground (reported per
// minute; the first minute includes the load), HIDDEN seconds as a background tab, then
// BACK seconds shown again. "Hidden" flips document.visibilityState and fires
// `visibilitychange`, which is what the app's polls listen to; Chrome's own timer
// throttling of background tabs is not emulated.
//
// Two views of the traffic to our server:
//   browser   every /api request the page made (traffic.mjs): cache hits and 304s told apart
//   server    --access-log: the preview proxy's log (preview.config.mjs ACCESS_LOG), i.e.
//             what actually reached the API, with the bytes it answered. Run ONE page
//             walk per log file, or the walks cannot be told apart.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { evaluate, launchChrome, newPage, parseArgs, sleep, watchSharedWorkers } from './cdp.mjs';
import { pagesFor, pressCtrlK, scanAddresses, selectPages } from './pages.mjs';
import { createTraffic } from './traffic.mjs';

const { flags, positional } = parseArgs(process.argv.slice(2));
const [originArg, outFile] = positional;
if (!originArg || !outFile) {
  console.error('usage: rates.mjs <origin> out.json [--pages=regex] [--visible=120] [--hidden=45] [--back=5] [--access-log=file] [--port=9350]');
  process.exit(2);
}
const origin = originArg.replace(/\/$/, '');
const VISIBLE = Number(flags.visible ?? 120), HIDDEN = Number(flags.hidden ?? 45), BACK = Number(flags.back ?? 5);
const accessLog = typeof flags['access-log'] === 'string' ? flags['access-log'] : '';

// Lets the harness flip document.visibilityState the way a background tab does.
const VIS = `(() => {
  let hidden = false;
  Object.defineProperty(Document.prototype, 'visibilityState', { configurable: true, get() { return hidden ? 'hidden' : 'visible'; } });
  Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get() { return hidden; } });
  window.__setHidden = (h) => { hidden = h; document.dispatchEvent(new Event('visibilitychange')); };
})();`;

/** [name, from, to) in seconds after navigation. */
const minutes = Math.max(1, Math.round(VISIBLE / 60));
const PHASES = [
  ...Array.from({ length: minutes }, (_, i) => [`min${i + 1}`, i * 60, i + 1 === minutes ? VISIBLE : (i + 1) * 60]),
  ['hidden', VISIBLE, VISIBLE + HIDDEN],
  ['back', VISIBLE + HIDDEN, VISIBLE + HIDDEN + BACK],
];

const foldPath = (path) => path.replace(/([?&](address|q|coin|id|account|accountId)=)[^&]+/g, '$1*');
function serverView(t0) {
  if (!accessLog || !existsSync(accessLog)) return null;
  const out = Object.fromEntries(PHASES.map(([name]) => [name, { n: 0, bytes: 0, n304: 0, byPath: {} }]));
  for (const line of readFileSync(accessLog, 'utf8').split('\n')) {
    if (!line) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const s = (e.t - t0) / 1000;
    const phase = PHASES.find(([, from, to]) => s >= from && s < to);
    if (!phase) continue;
    const p = out[phase[0]];
    p.n++; p.bytes += e.bytes;
    if (e.status === 304) p.n304++;
    const row = (p.byPath[foldPath(e.url)] ??= { n: 0, bytes: 0, n304: 0 });
    row.n++; row.bytes += e.bytes;
    if (e.status === 304) row.n304++;
  }
  return out;
}

let current = null;
const addr = await scanAddresses(origin);
const pages = selectPages(pagesFor(addr), flags.pages);
const out = { origin, when: new Date().toISOString(), seconds: { visible: VISIBLE, hidden: HIDDEN, back: BACK }, phases: PHASES.map(([n]) => n), scanAddresses: addr, pages: {} };
const chrome = await launchChrome({ port: Number(flags.port ?? 9350) });
try {
  await watchSharedWorkers(chrome.cdp, async (session) => { if (current) await current.attach(session, 'worker'); });
  for (const pg of pages) {
    const page = await newPage(chrome.cdp);
    const traffic = createTraffic(origin);
    current = traffic;
    await page.send('Page.enable');
    await traffic.attach(page, 'page');
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: VIS });
    const t0 = Date.now();
    await page.send('Page.navigate', { url: origin + pg.path });
    if (pg.palette) {
      await sleep(6000);
      await pressCtrlK(page);
    }
    await sleep(Math.max(0, VISIBLE * 1000 - (Date.now() - t0)));
    await evaluate(page, 'window.__setHidden(true), 1');
    await sleep(HIDDEN * 1000);
    await evaluate(page, 'window.__setHidden(false), 1');
    await sleep(BACK * 1000);
    // The proxy logs an answer when it ENDS: give the last ones a moment.
    await sleep(300);
    const browser = Object.fromEntries(PHASES.map(([name, from, to]) => [name, traffic.summary(from, to)]));
    const server = serverView(t0);
    await page.close();
    current = null;
    out.pages[pg.id] = { browser, server };
    writeFileSync(outFile, JSON.stringify(out, null, 1));

    const api = PHASES.map(([name]) => {
      const b = browser[name].api;
      return `${name} ${String(b.n - b.cached).padStart(3)}${server ? `/${String(server[name].n).padStart(3)}` : ''}`;
    }).join('  ');
    const steady = browser[PHASES[minutes - 1][0]];
    const bytes = PHASES.reduce((s, [name]) => s + (server ? server[name].bytes : browser[name].api.bytes), 0);
    console.log(`${pg.id.padEnd(18)} api ${api}  (${(bytes / 1024).toFixed(0)} kB)  exchanges/min ${String(steady.direct.n).padStart(3)}  sockets ${steady.ws.open} (${steady.ws.frames} frames/min)`);
  }
} finally {
  await chrome.close();
}
console.log(`api columns: requests the browser sent over the network${accessLog ? ' / requests the API answered' : ''}\ndone -> ${outFile}`);
