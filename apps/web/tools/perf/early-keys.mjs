// Keys typed as soon as the page appears: does the search palette open with all of them?
//
//   node tools/perf/early-keys.mjs <label=origin[,label=origin...]> [loads=10] [--page=/trade] [--word=btc]
//        [--gap=40] [--delay=0] [--out=rows.json] [--port=9344]
//
// Each load is a new browser profile on a 1.5 Mbit/s, 150 ms link. The moment the shell
// is there (plus `--delay` ms) the word is typed, `--gap` ms between keys. The first key
// opens the palette; the search box gets the focus a frame later, and a key that lands
// before it has the focus is not typed into it (in every build - the app opens the
// palette again instead). So this reports, per build and interleaved load by load:
// how long after the first key the box had the focus, and how often the whole word
// arrived. A build that makes the main thread busier at that moment shows up as a
// later focus and fewer whole words.
import { writeFileSync } from 'node:fs';
import { evaluate, launchChrome, newPage, parseArgs, sleep } from './cdp.mjs';

const { flags, positional } = parseArgs(process.argv.slice(2));
if (!positional[0]) {
  console.error('usage: early-keys.mjs <label=origin[,label=origin...]> [loads] [--page=] [--word=] [--gap=] [--delay=] [--out=]');
  process.exit(2);
}
const builds = positional[0].split(',').map((x) => { const i = x.indexOf('='); return { label: x.slice(0, i), origin: x.slice(i + 1) }; });
const loads = Number(positional[1] ?? 10);
const path = flags.page ?? '/trade';
const word = String(flags.word ?? 'btc');
const gap = Number(flags.gap ?? 40);
const delay = Number(flags.delay ?? 0);

const INSTRUMENT = `
  window.__ek = { keys: [], focusAt: null, lt: [] };
  addEventListener('keydown', (e) => { window.__ek.keys.push([e.key, performance.now()]); }, true);
  document.addEventListener('focusin', (e) => {
    const t = e.target;
    if (window.__ek.focusAt === null && t && t.matches && t.matches('.cp input')) window.__ek.focusAt = performance.now();
  }, true);
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__ek.lt.push([e.startTime, e.duration]); }).observe({ type: 'longtask', buffered: true }); } catch {}
`;

const chrome = await launchChrome({ port: Number(flags.port ?? 9344) });
const rows = [];
try {
  for (let i = 0; i < loads; i++) {
    // Alternate which build goes first, so drift on the machine hits them alike.
    for (const b of i % 2 ? [...builds].reverse() : builds) {
      const page = await newPage(chrome.cdp);
      try {
        await page.send('Page.enable');
        await page.send('Network.enable', {});
        await page.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: 190_000, uploadThroughput: 90_000 });
        await page.send('Page.addScriptToEvaluateOnNewDocument', { source: INSTRUMENT });
        const navAt = Date.now();
        await page.send('Page.navigate', { url: b.origin + path });
        // The shell: the navigation bar's links.
        for (;;) {
          await sleep(20);
          if (await evaluate(page, '!!document.querySelector("a[href=\'/explore\']")', false).catch(() => false)) break;
          if (Date.now() - navAt > 90_000) throw new Error('the shell never appeared');
        }
        const shellMs = Date.now() - navAt;
        if (delay) await sleep(delay);
        for (const ch of word) {
          const vk = ch.toUpperCase().charCodeAt(0);
          await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, code: `Key${ch.toUpperCase()}`, text: ch, windowsVirtualKeyCode: vk });
          await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code: `Key${ch.toUpperCase()}`, windowsVirtualKeyCode: vk });
          await sleep(gap);
        }
        await sleep(1500);
        const r = JSON.parse(await evaluate(page, 'JSON.stringify({ ek: window.__ek, v: (document.querySelector(".cp input") || {}).value ?? null })', false));
        const k0 = r.ek.keys[0]?.[1] ?? null;
        const focusMs = k0 !== null && r.ek.focusAt !== null ? r.ek.focusAt - k0 : null;
        // The longest task that overlaps the 200 ms after the first key.
        const busy = k0 === null ? 0 : r.ek.lt.filter(([s, d]) => s < k0 + 200 && s + d > k0).reduce((a, [, d]) => Math.max(a, d), 0);
        rows.push({ build: b.label, load: i, shellMs, box: r.v, focusMs, busy });
        console.log(`${b.label} #${i}: shell after ${shellMs} ms, box "${r.v}", focus ${focusMs === null ? '-' : Math.round(focusMs)} ms after the first key, longest task around it ${Math.round(busy)} ms`);
      } catch (e) {
        console.log(`${b.label} #${i}: FAILED ${e.message}`);
      } finally {
        await page.close();
      }
    }
  }
} finally {
  await chrome.close();
}

const quantile = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; };
console.log(`\n${path}: "${word}" typed ${gap} ms apart, ${delay} ms after the shell appeared, ${loads} loads per build\n`);
console.log('| build | whole word | focus after the first key: median | p90 | max |');
console.log('|---|---|---|---|---|');
for (const b of builds) {
  const mine = rows.filter((r) => r.build === b.label);
  const f = mine.map((r) => r.focusMs).filter((x) => x !== null);
  console.log(`| ${b.label} | ${mine.filter((r) => r.box === word).length} of ${mine.length} | ${Math.round(quantile(f, 0.5))} ms | ${Math.round(quantile(f, 0.9))} ms | ${Math.round(Math.max(...f))} ms |`);
}
if (flags.out) writeFileSync(flags.out, JSON.stringify(rows, null, 1));
