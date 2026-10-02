// Loads pages headless and reports what a user would not see: console errors and
// warnings, uncaught exceptions, failed or 4xx/5xx requests - plus whether the page
// rendered at all. Exit code 1 when a page stayed empty or threw.
//
//   node tools/perf/smoke.mjs <origin> [--pages=<regex>] [--secs=8] [--port=9336]
//
// Works against the dev server (:5180) as well as a preview of a build.
import { evaluate, launchChrome, newPage, parseArgs, sleep } from './cdp.mjs';
import { pagesFor, pressCtrlK, scanAddresses, selectPages } from './pages.mjs';

const { flags, positional } = parseArgs(process.argv.slice(2));
const origin = (positional[0] ?? '').replace(/\/$/, '');
if (!origin) {
  console.error('usage: smoke.mjs <origin> [--pages=regex] [--secs=8] [--port=9336]');
  process.exit(2);
}
const SECS = Number(flags.secs ?? 8);
const pages = selectPages(pagesFor(await scanAddresses(origin)), flags.pages);
const chrome = await launchChrome({ port: Number(flags.port ?? 9336) });
let bad = 0;
try {
  for (const pg of pages) {
    const page = await newPage(chrome.cdp);
    const errors = [], failed = [];
    const urls = new Map();
    page.on('Runtime.consoleAPICalled', (p) => {
      if (p.type === 'error' || p.type === 'warning') errors.push(`${p.type}: ${p.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 220)}`);
    });
    page.on('Runtime.exceptionThrown', (p) => errors.push(`exception: ${(p.exceptionDetails.exception?.description || p.exceptionDetails.text).slice(0, 300)}`));
    page.on('Network.requestWillBeSent', (p) => urls.set(p.requestId, p.request.url));
    page.on('Network.loadingFailed', (p) => { if (!p.canceled && p.errorText !== 'net::ERR_ABORTED') failed.push(`${p.errorText} ${(urls.get(p.requestId) ?? '').slice(0, 120)}`); });
    page.on('Network.responseReceived', (p) => { if (p.response.status >= 400) failed.push(`${p.response.status} ${p.response.url.slice(0, 120)}`); });
    await page.send('Runtime.enable');
    await page.send('Network.enable', {});
    await page.send('Page.enable');
    await page.send('Page.navigate', { url: origin + pg.path });
    await sleep(SECS * 1000);
    if (pg.palette) { await pressCtrlK(page); await sleep(2500); }
    const info = await evaluate(page, 'JSON.stringify({ nodes: document.getElementsByTagName("*").length, text: document.body.innerText.slice(0, 90).replace(/\\s+/g, " "), palette: !!document.querySelector(".cp") })').then(JSON.parse);
    await page.close();
    const exceptions = errors.filter((e) => e.startsWith('exception'));
    const empty = info.nodes < 50 || (pg.palette && !info.palette);
    if (empty || exceptions.length) bad++;
    console.log(`${empty || exceptions.length ? 'FAIL' : 'ok  '} ${pg.id.padEnd(18)} ${String(info.nodes).padStart(5)} nodes  "${info.text}"`);
    for (const e of [...new Set(errors)].slice(0, 6)) console.log(`       ${e}`);
    for (const f of [...new Set(failed)].slice(0, 6)) console.log(`       request: ${f}`);
  }
} finally {
  await chrome.close();
}
process.exit(bad ? 1 : 0);
