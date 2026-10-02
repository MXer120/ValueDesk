// How a page's index reads are answered: its first read, its polls, and its first read
// again when the page is reopened (a client-side navigation away and back).
//
//   node tools/perf/revisit.mjs <label=origin[,label=origin...]> [--page=/leaderboard] [--sel=.lbp-trader]
//        [--api=/api/vs/leaderboard] [--away=/explore] [--polls=2] [--gap=5] [--latency=60] [--port=9346]
//
// What it should print (serverFetch.ts, apps/server/src/perf.ts):
//   - the first read: the network;
//   - every poll: the network, as a conditional request (a 304 when nothing changed) -
//     never "HTTP cache", which would be the copy the poll before it left behind;
//   - reopened within 30 s of the server's last answer: "HTTP cache", rows on screen
//     as fast as the page renders (10-30 s: the browser also refreshes its copy
//     behind it); later than that: the network.
// `--gap` is the seconds spent on the other page, `--latency` an emulated round trip
// in ms (on localhost a round trip is too short to see).
import { evaluate, launchChrome, newPage, parseArgs, sleep } from './cdp.mjs';

const { flags, positional } = parseArgs(process.argv.slice(2));
if (!positional[0]) {
  console.error('usage: revisit.mjs <label=origin[,label=origin...]> [--page=] [--sel=] [--api=] [--away=] [--polls=] [--gap=] [--latency=]');
  process.exit(2);
}
const builds = positional[0].split(',').map((x) => { const i = x.indexOf('='); return { label: x.slice(0, i), origin: x.slice(i + 1) }; });
const path = flags.page ?? '/leaderboard';
const sel = flags.sel ?? '.lbp-trader';
const api = flags.api ?? '/api/vs/leaderboard';
const away = flags.away ?? '/explore';
const polls = Number(flags.polls ?? 2);
const gap = Number(flags.gap ?? 5);
const latency = Number(flags.latency ?? 0);

/** The page's data is on screen: the first match of the selector, with a digit in it. */
const shown = `(() => { const e = document.querySelector(${JSON.stringify(sel)}); return !!e && /[0-9]/.test(e.textContent || ''); })()`;

const chrome = await launchChrome({ port: Number(flags.port ?? 9346) });
try {
  for (const b of builds) {
    const page = await newPage(chrome.cdp);
    try {
      /** Every request to `api`, in the order sent (the curve read of the leaderboard left out). */
      const reads = [];
      const byId = new Map();
      page.on('Network.requestWillBeSent', (p) => {
        if (!p.request.url.startsWith(b.origin + api) || /[?&]curves=1/.test(p.request.url)) return;
        const r = { t: p.timestamp, cached: false, net: null, status: null, bytes: 0, done: null, conditional: false, cacheControl: null };
        byId.set(p.requestId, r);
        reads.push(r);
      });
      page.on('Network.requestWillBeSentExtraInfo', (p) => {
        const r = byId.get(p.requestId);
        if (!r) return;
        r.cacheControl = p.headers['Cache-Control'] ?? p.headers['cache-control'] ?? null;
        r.conditional = !!(p.headers['If-None-Match'] ?? p.headers['if-none-match']);
      });
      page.on('Network.responseReceived', (p) => { const r = byId.get(p.requestId); if (r) { r.status = p.response.status; if (p.response.fromDiskCache) r.cached = true; } });
      page.on('Network.requestServedFromCache', (p) => { const r = byId.get(p.requestId); if (r) r.cached = true; });
      // What the NETWORK answered: for a revalidated copy responseReceived says 200, this says 304.
      page.on('Network.responseReceivedExtraInfo', (p) => { const r = byId.get(p.requestId); if (r) r.net = p.statusCode; });
      page.on('Network.loadingFinished', (p) => { const r = byId.get(p.requestId); if (r) { r.bytes = p.encodedDataLength; r.done = p.timestamp; } });
      page.on('Network.loadingFailed', (p) => { const r = byId.get(p.requestId); if (r) r.done = p.timestamp; });
      await page.send('Page.enable');
      await page.send('Network.enable', {});
      if (latency) await page.send('Network.emulateNetworkConditions', { offline: false, latency, downloadThroughput: -1, uploadThroughput: -1 });

      const fromCache = (r) => r.cached && r.net === null;
      const how = (r) => (fromCache(r)
        ? 'HTTP cache, no request'
        : `network ${r.net ?? r.status ?? '(no answer yet)'}${r.conditional ? ', conditional' : ''}${r.cacheControl ? `, sent Cache-Control: ${r.cacheControl}` : ''}`);
      /** The reads the PAGE made: a request the browser sends by itself behind a cache answer leaves at the same moment. */
      const pageReads = () => { const out = []; let last = -Infinity; for (const r of reads) { if (r.t - last > 2) { out.push(r); last = r.t; } } return out; };
      const settled = () => reads.every((r) => fromCache(r) || r.done !== null);

      await page.send('Page.navigate', { url: b.origin + path });
      const t0 = Date.now();
      while (!(await evaluate(page, shown, false).catch(() => false))) {
        if (Date.now() - t0 > 60_000) throw new Error(`${path} never showed ${sel}`);
        await sleep(50);
      }
      while (pageReads().length < 1 + polls || !settled()) {
        if (Date.now() - t0 > 60_000 + polls * 70_000) throw new Error(`fewer than ${polls} polls of ${api}`);
        await sleep(50);
      }
      await sleep(1500);
      const first = reads[0];
      console.log(`\n${b.label}  ${path}  (${api}${latency ? `, ${latency} ms latency` : ''})`);
      for (const r of reads) console.log(`  +${(r.t - first.t).toFixed(1).padStart(5)} s  ${how(r)}  ${(r.bytes / 1024).toFixed(1)} kB`);

      const lastAnswer = Math.max(...reads.filter((r) => r.net !== null && r.done !== null).map((r) => r.done));
      const links = await evaluate(page, `[!!document.querySelector('a[href="${away}"]'), !!document.querySelector('a[href="${path}"]')]`, false);
      if (!links[0] || !links[1]) {
        console.log(`  (no link to ${links[0] ? path : away} in the page: the reopen is not measured)`);
        continue;
      }
      await evaluate(page, `document.querySelector('a[href="${away}"]').click()`, false);
      await sleep(gap * 1000);
      const before = reads.length;
      const ms = await evaluate(page, `(async () => {
        const t0 = performance.now();
        document.querySelector('a[href="${path}"]').click();
        for (;;) {
          if (${shown}) return performance.now() - t0;
          if (performance.now() - t0 > 20000) return -1;
          await new Promise((r) => requestAnimationFrame(r));
        }
      })()`);
      await sleep(1500);
      const again = reads.slice(before);
      console.log(`  reopened ${again[0] ? (again[0].t - lastAnswer).toFixed(1) : '?'} s after the server last answered: rows on screen ${Math.round(ms)} ms after the click; ${again.map(how).join('  +  ') || 'no read'}`);
    } finally {
      await page.close();
    }
  }
} finally {
  await chrome.close();
}
