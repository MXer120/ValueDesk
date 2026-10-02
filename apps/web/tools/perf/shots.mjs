// Deterministic screenshots for the pixel comparison: record the live data ONCE, then
// render any build from that recording.
//
//   node tools/perf/shots.mjs record   <origin> <fixtureDir> [--states=<regex>]
//   node tools/perf/shots.mjs replay   <origin> <fixtureDir> <outDir> [--states=<regex>] [--settle=300] [--gpu]
//   node tools/perf/shots.mjs compare  <dirA> <dirB> <diffDir>
//   node tools/perf/shots.mjs envelope <baseDir1,baseDir2,...> <afterDir> <diffDir>
//   node tools/perf/shots.mjs layout   <dirA> <dirB>
//
// record  walks the states against live data and keeps, per state, every answer of our
//         API and of every exchange host, and every WebSocket frame. The clock is
//         frozen at the moment the recording starts (written to meta.json) and
//         Math.random is seeded, so the app asks for the same URLs on every run.
// replay  serves a build's own files from <origin> and EVERYTHING else from the
//         recording: no request leaves the machine. A request is always answered
//         with the FIRST answer recorded for it and a socket subscription with the
//         first push, so a poll that fires just before the capture changes nothing.
//         CSS animations are finished and the text caret is hidden before the
//         capture; rasterising is done in software unless --gpu.
// compare / envelope  pixel diffs. A baseline is not perfectly reproducible on its own
//         (gradient dithering, raster logo downscaling, anti-aliased corners that are
//         re-rastered in a different order), so replay it a few times and use
//         `envelope`: a pixel passes when every channel lies within the range the
//         baseline runs took.
// layout  what the rasteriser cannot blur: every replay also writes <state>.dom.json -
//         each element's tag, classes, box (to 1/100 px) and own text, in document
//         order. `layout` passes when two runs' files are equal. Two states that are
//         equal here and differ by a grey level on a few edge pixels differ in how
//         they were painted, not in what is on the page.
//
// The exchange sockets normally live in a SharedWorker, which a page session cannot
// see or replace. Both modes switch SharedWorker off, so the app hosts its sockets in
// the page (its own fallback, exchange/ws/link.ts) - the same data on screen, through
// a path this harness can record and fake.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { evaluate, launchChrome, newPage, parseArgs, sleep } from './cdp.mjs';
import { pressCtrlK, scanAddresses } from './pages.mjs';
import { decodePng, diffPng, encodePng } from './png.mjs';

const MOBILE = [390, 844, 2, true];

/** Every state that is captured. `vp` = [width, height, dpr, mobile]. */
function statesFor(addr) {
  const scan = (v) => (addr[v] ? [{ id: `scan-${v}`, path: v === 'sodex' ? `/scan?address=${addr[v]}` : `/scan?address=${addr[v]}&venue=${v}` }] : []);
  return [
    { id: 'trade', path: '/trade' },
    { id: 'trade-mobile', path: '/trade', vp: MOBILE },
    { id: 'explore', path: '/explore' },
    { id: 'cohorts', path: '/explore?view=cohorts' },
    { id: 'marketmap', path: '/explore?view=cohorts&section=map' },
    { id: 'leaderboard', path: '/leaderboard' },
    { id: 'copy', path: '/copy' },
    { id: 'portfolio', path: '/portfolio' },
    { id: 'scan', path: '/scan' },
    ...scan('sodex'), ...scan('hyperliquid'), ...scan('tradexyz'), ...scan('lighter'), ...scan('arcus'),
    { id: 'palette', path: '/trade', action: 'ctrlk' },
    { id: 'palette-typed', path: '/trade', action: 'typeB' },
    { id: 'nav-trade-explore', path: '/trade', action: 'nav:Explore' },
    { id: 'nav-explore-leaderboard', path: '/explore', action: 'nav:Leaderboard' },
    { id: 'nav-leaderboard-portfolio', path: '/leaderboard', action: 'nav:Portfolio' },
    { id: 'explore-mobile', path: '/explore', vp: MOBILE },
    { id: 'legacy-account', path: '/account' },
  ];
}

/** Date frozen at t0, Math.random seeded, no SharedWorker. Runs before the page's first script. */
const prelude = (t0) => `(() => {
  const T0 = ${t0};
  const RD = Date;
  function FD(...a) { if (!new.target) return new RD(T0).toString(); return a.length ? new RD(...a) : new RD(T0); }
  FD.prototype = RD.prototype; FD.now = () => T0; FD.parse = RD.parse; FD.UTC = RD.UTC;
  Object.setPrototypeOf(FD, RD);
  window.Date = FD;
  const desc = Object.getOwnPropertyDescriptor(Intl.DateTimeFormat.prototype, 'format');
  if (desc && desc.get) Object.defineProperty(Intl.DateTimeFormat.prototype, 'format', { configurable: true, get() { const f = desc.get.call(this); return (d) => f(d === undefined ? T0 : d); } });
  let s = 1234567;
  Math.random = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  try { Object.defineProperty(window, 'SharedWorker', { configurable: true, value: undefined }); } catch {}
})();`;

/**
 * window.WebSocket, answered from the recording: `frames` maps a socket URL to the
 * frames received on it. A subscription gets the first recorded push that belongs to
 * it (same channel; one of its symbols; its interval), a ping gets a pong, and a URL
 * that was never recorded closes at once.
 */
function fakeSockets(frames) {
  return `(() => {
  const REC = ${JSON.stringify(frames)};
  const symbolsOf = (m) => { const d = m && m.data; return Array.isArray(d) ? d.map((e) => e && e.s).filter(Boolean) : d && d.s ? [d.s] : []; };
  const belongs = (m, p) => {
    if (!m || m.channel !== p.channel) return false;
    const want = [p.symbol, ...(p.symbols || [])].filter(Boolean);
    if (want.length) { const got = symbolsOf(m); if (got.length && !got.some((s) => want.includes(s))) return false; }
    if (p.interval && m.data && !Array.isArray(m.data) && m.data.i && m.data.i !== p.interval) return false;
    return true;
  };
  class FakeWS extends EventTarget {
    constructor(url) {
      super();
      this.url = String(url); this.readyState = 0; this.bufferedAmount = 0; this.protocol = ''; this.extensions = ''; this.binaryType = 'blob';
      this.onopen = this.onmessage = this.onclose = this.onerror = null;
      this._rec = (REC[this.url] || []).map((t) => { try { return JSON.parse(t); } catch { return null; } }).filter(Boolean);
      if (!REC[this.url]) { setTimeout(() => { this.readyState = 3; this._emit('close', { code: 1006 }); }, 0); return; }
      setTimeout(() => { if (this.readyState === 0) { this.readyState = 1; this._emit('open'); } }, 5);
    }
    send(data) {
      let m; try { m = JSON.parse(data); } catch { return; }
      if (m.op === 'ping') { setTimeout(() => this._msg({ op: 'pong' }), 5); return; }
      if (m.op !== 'subscribe' || !m.params) return;
      const all = this._rec.filter((x) => belongs(x, m.params));
      const hit = all.find((x) => x.type === 'snapshot') || all[0];
      if (hit) setTimeout(() => this._msg(hit), 5);
    }
    close() { this.readyState = 3; }
    _msg(o) { if (this.readyState === 1) this._emit('message', { data: JSON.stringify(o) }); }
    _emit(type, init) {
      const ev = type === 'message' ? new MessageEvent('message', init) : type === 'close' ? new CloseEvent('close', init) : new Event(type);
      const h = this['on' + type]; if (typeof h === 'function') h.call(this, ev);
      this.dispatchEvent(ev);
    }
  }
  FakeWS.CONNECTING = 0; FakeWS.OPEN = 1; FakeWS.CLOSING = 2; FakeWS.CLOSED = 3;
  window.WebSocket = FakeWS;
})();`;
}

const keyOf = (method, url, post) => `${method} ${url}${post ? ' ' + post : ''}`;

/** Wait until no request has been in flight for 1.5 s (at least minMs, at most maxMs). */
async function settle(pending, minMs = 3500, maxMs = 25000) {
  const t0 = Date.now();
  let quietSince = Date.now();
  for (;;) {
    await sleep(200);
    if (pending.size > 0) quietSince = Date.now();
    const el = Date.now() - t0;
    if (el > maxMs) break;
    if (el > minMs && Date.now() - quietSince > 1500) break;
  }
}

/** Fonts and images in, every finite animation at its end, no blinking caret, two frames drawn. */
async function finalize(page, settleMs) {
  await evaluate(page, `(async () => {
    await document.fonts.ready;
    const still = document.createElement('style');
    still.textContent = '*{caret-color:transparent!important}';
    document.head.append(still);
    const imgs = [...document.images];
    await Promise.race([Promise.all(imgs.map((i) => i.complete ? 0 : new Promise((r) => { i.onload = i.onerror = r; }))), new Promise((r) => setTimeout(r, 5000))]);
    for (const a of document.getAnimations()) {
      try { const t = a.effect && a.effect.getComputedTiming(); if (t && t.endTime !== Infinity) a.finish(); else a.cancel(); } catch {}
    }
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return true;
  })()`);
  await sleep(settleMs);
}

async function doAction(page, action) {
  if (action === 'ctrlk') { await pressCtrlK(page); return; }
  if (action === 'typeB') {
    // Typing outside a field opens the palette seeded with the key.
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'b', code: 'KeyB', text: 'b', windowsVirtualKeyCode: 66 });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'b', code: 'KeyB', windowsVirtualKeyCode: 66 });
    return;
  }
  if (action.startsWith('nav:')) {
    const label = action.slice(4);
    const box = await evaluate(page, `(() => { const a = [...document.querySelectorAll('a[href]')].find((x) => x.textContent.trim() === ${JSON.stringify(label)}); if (!a) return null; const r = a.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
    if (!box) throw new Error(`nav link not found: ${label}`);
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box[0], y: box[1] });
    await sleep(150);
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box[0], y: box[1], button: 'left', clickCount: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box[0], y: box[1], button: 'left', clickCount: 1 });
  }
}

const misses = [];

async function runState(cdp, mode, origin, meta, fixDir, outDir, st, settleMs) {
  const [w, h, dpr, mobile] = st.vp || [1920, 1080, 1, false];
  const page = await newPage(cdp, { width: w, height: h, dpr });
  if (mobile) {
    await page.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: dpr, mobile: true });
    await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  }
  await page.send('Page.enable');
  await page.send('Network.enable', { maxPostDataSize: 65536 });
  await page.send('Runtime.enable');
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: prelude(meta.t0) });
  const pending = new Set();
  const http = {};
  const sockets = {};
  const errors = [];
  page.on('Runtime.exceptionThrown', (p) => errors.push(p.exceptionDetails?.exception?.description?.slice(0, 200) || p.exceptionDetails?.text));
  page.on('Network.requestWillBeSent', (p) => { if (p.type !== 'WebSocket') pending.add(p.requestId); });
  page.on('Network.loadingFailed', (p) => pending.delete(p.requestId));

  if (mode === 'record') {
    const reqMeta = new Map();
    const socketUrl = new Map();
    page.on('Network.requestWillBeSent', (p) => reqMeta.set(p.requestId, { method: p.request.method, url: p.request.url, post: p.request.postData || '' }));
    page.on('Network.responseReceived', (p) => {
      const m = reqMeta.get(p.requestId);
      if (m) { m.status = p.response.status; m.ct = p.response.headers['content-type'] || p.response.headers['Content-Type'] || p.response.mimeType; }
    });
    page.on('Network.loadingFinished', async (p) => {
      const m = reqMeta.get(p.requestId);
      try {
        if (m && /^https?:/.test(m.url) && (m.url.startsWith(`${origin}/api/`) || !m.url.startsWith(origin))) {
          const b = await page.send('Network.getResponseBody', { requestId: p.requestId });
          (http[keyOf(m.method, m.url, m.post)] ||= []).push({ status: m.status, ct: m.ct, body: b.body, b64: b.base64Encoded });
        }
      } catch { /* a body the browser no longer holds */ }
      pending.delete(p.requestId);
    });
    page.on('Network.webSocketCreated', (p) => { socketUrl.set(p.requestId, p.url); sockets[p.url] ||= []; });
    page.on('Network.webSocketFrameReceived', (p) => {
      const url = socketUrl.get(p.requestId);
      if (url && p.response.opcode === 1) sockets[url].push(p.response.payloadData);
    });
  } else {
    page.on('Network.loadingFinished', (p) => pending.delete(p.requestId));
    const fix = JSON.parse(readFileSync(join(fixDir, `${st.id}.json`), 'utf8'));
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: fakeSockets(fix.sockets) });
    await page.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
    page.on('Fetch.requestPaused', (p) => {
      const url = p.request.url;
      const own = url.startsWith(origin) && !url.startsWith(`${origin}/api/`);
      if (own || !/^https?:/.test(url)) { page.send('Fetch.continueRequest', { requestId: p.requestId }).catch(() => {}); return; }
      const cors = [
        { name: 'access-control-allow-origin', value: origin }, { name: 'access-control-allow-credentials', value: 'true' },
        { name: 'access-control-allow-headers', value: '*' }, { name: 'access-control-allow-methods', value: 'GET,POST,OPTIONS' },
      ];
      if (p.request.method === 'OPTIONS') { page.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 204, responseHeaders: cors }).catch(() => {}); return; }
      // Our API was recorded on the origin the recording was made against.
      const recUrl = url.startsWith(origin) ? meta.origin + url.slice(origin.length) : url;
      const k = keyOf(p.request.method, recUrl, p.request.postData || '');
      const list = fix.http[k];
      if (!list) {
        misses.push(`${st.id}: ${k.slice(0, 170)}`);
        page.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 503, responseHeaders: [{ name: 'content-type', value: 'application/json' }, ...cors], body: Buffer.from('{"ok":false,"error":"not recorded"}').toString('base64') }).catch(() => {});
        return;
      }
      // Always the first recorded answer: polls then repeat it, whenever they happen to fire.
      const r = list[0];
      const body = r.b64 ? r.body : Buffer.from(r.body, 'utf8').toString('base64');
      page.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: r.status || 200, responseHeaders: [{ name: 'content-type', value: r.ct || 'application/json' }, ...cors], body }).catch(() => {});
    });
  }

  await page.send('Page.navigate', { url: origin + st.path });
  await settle(pending, 4000);
  if (st.action) {
    await doAction(page, st.action);
    await settle(pending, 2500);
  }
  await finalize(page, settleMs);
  const shot = await page.send('Page.captureScreenshot', { format: 'png' });
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, `${st.id}.png`), Buffer.from(shot.data, 'base64'));
  if (mode === 'replay') writeFileSync(join(outDir, `${st.id}.dom.json`), await evaluate(page, DOM_SNAPSHOT));
  if (mode === 'record') writeFileSync(join(fixDir, `${st.id}.json`), JSON.stringify({ state: st, http, sockets }));
  const info = await evaluate(page, 'JSON.stringify({ url: location.pathname + location.search, nodes: document.getElementsByTagName("*").length })').then(JSON.parse);
  await page.close();
  return {
    ...info,
    errors: errors.slice(0, 3),
    ...(mode === 'record' ? { answers: Object.keys(http).length, sockets: Object.keys(sockets).length, frames: Object.values(sockets).reduce((s, f) => s + f.length, 0) } : {}),
  };
}

/** Between the fields of a snapshot line: a character no class name or number holds. */
const SEP = String.fromCharCode(9);

/** Every rendered element: tag, classes, box and own text, one line each, in document order. */
const DOM_SNAPSHOT = `(() => {
  const SEP = String.fromCharCode(9);
  const out = [];
  const r2 = (n) => Math.round(n * 100) / 100;
  for (const el of document.body.querySelectorAll('*')) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'script' || tag === 'style') continue;
    const b = el.getBoundingClientRect();
    let text = '';
    for (const n of el.childNodes) if (n.nodeType === 3) text += n.nodeValue;
    const cls = typeof el.className === 'string' ? el.className : el.getAttribute('class') || '';
    out.push([tag, cls, r2(b.x), r2(b.y), r2(b.width), r2(b.height), text.trim(), 'value' in el && typeof el.value === 'string' ? el.value : ''].join(SEP));
  }
  return JSON.stringify(out);
})()`;

/** Two replays are the same page when every element has the same box, classes and text. */
function layout(dirA, dirB) {
  let bad = 0;
  for (const f of readdirSync(dirA).filter((x) => x.endsWith('.dom.json')).sort()) {
    const name = f.replace('.dom.json', '');
    if (!existsSync(join(dirB, f))) continue;
    const a = JSON.parse(readFileSync(join(dirA, f), 'utf8'));
    const b = JSON.parse(readFileSync(join(dirB, f), 'utf8'));
    const n = Math.max(a.length, b.length);
    const diffs = [];
    const show = (line) => String(line).split(SEP).join(' | ');
    for (let i = 0; i < n && diffs.length < 4; i++) {
      if (a[i] !== b[i]) diffs.push([`    #${i}`, `      ${show(a[i])}`, `      ${show(b[i])}`].join(String.fromCharCode(10)));
    }
    if (diffs.length) bad++;
    console.log(`${name.padEnd(30)} ${diffs.length ? `DIFFERS (${a.length} vs ${b.length} elements)` : `same layout (${a.length} elements)`}`);
    for (const d of diffs) console.log(d);
  }
  console.log(bad ? `${bad} state(s) differ in layout` : 'SAME LAYOUT in every state: the same elements, boxes and text');
  return bad;
}

/** A pixel passes when every channel of `after` lies within [min, max] of the baseline runs. */
function envelope(bases, afterDir, diffDir) {
  mkdirSync(diffDir, { recursive: true });
  let bad = 0;
  for (const f of readdirSync(bases[0]).filter((x) => x.endsWith('.png')).sort()) {
    const bs = bases.filter((d) => existsSync(join(d, f))).map((d) => decodePng(readFileSync(join(d, f))));
    if (!existsSync(join(afterDir, f))) { console.log(`${f}: MISSING in after`); bad++; continue; }
    const af = decodePng(readFileSync(join(afterDir, f)));
    if (bs.some((x) => x.width !== af.width || x.height !== af.height)) { console.log(`${f}: SIZE differs`); bad++; continue; }
    const n = af.width * af.height * 4;
    let noisy = 0, out = 0, maxd = 0;
    const outImg = Buffer.alloc(n);
    let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
    for (let i = 0; i < n; i += 4) {
      let isNoisy = false, isOut = false;
      for (let k = 0; k < 4; k++) {
        let lo = 255, hi = 0;
        for (const x of bs) { const v = x.data[i + k]; if (v < lo) lo = v; if (v > hi) hi = v; }
        if (hi > lo) isNoisy = true;
        const v = af.data[i + k];
        if (v < lo || v > hi) { isOut = true; maxd = Math.max(maxd, v < lo ? lo - v : v - hi); }
      }
      if (isNoisy) noisy++;
      if (isOut) {
        const p = i / 4, xx = p % af.width, yy = (p / af.width) | 0;
        out++;
        outImg[i] = 255; outImg[i + 1] = 0; outImg[i + 2] = 255; outImg[i + 3] = 255;
        if (xx < x0) x0 = xx; if (yy < y0) y0 = yy; if (xx > x1) x1 = xx; if (yy > y1) y1 = yy;
      } else {
        const g = af.data[i] * 0.3;
        outImg[i] = outImg[i + 1] = outImg[i + 2] = g; outImg[i + 3] = 255;
      }
    }
    if (out) { bad++; writeFileSync(join(diffDir, f), encodePng({ width: af.width, height: af.height, data: outImg })); }
    console.log(`${f.padEnd(34)} ${out ? `OUTSIDE BASELINE: ${out} px (max excess ${maxd}), bbox ${[x0, y0, x1, y1]}` : 'identical to baseline'}${noisy ? `  [baseline run-to-run noise: ${noisy} px]` : ''}`);
  }
  console.log(bad ? `${bad} state(s) outside the baseline envelope` : 'ALL WITHIN BASELINE (pixel-identical up to the baseline run-to-run noise)');
  return bad;
}

function compare(dirA, dirB, diffDir) {
  mkdirSync(diffDir, { recursive: true });
  let bad = 0;
  for (const f of readdirSync(dirA).filter((x) => x.endsWith('.png')).sort()) {
    if (!existsSync(join(dirB, f))) { console.log(`${f}: MISSING in B`); bad++; continue; }
    const r = diffPng(decodePng(readFileSync(join(dirA, f))), decodePng(readFileSync(join(dirB, f))));
    if (r.sizeMismatch) { console.log(`${f}: SIZE ${r.a} vs ${r.b}`); bad++; continue; }
    if (r.differing) { bad++; writeFileSync(join(diffDir, f), encodePng(r.image)); }
    console.log(`${f.padEnd(34)} ${r.differing ? `DIFF ${r.differing} px, max delta ${r.maxDelta}, bbox ${r.bbox}` : 'identical'}`);
  }
  console.log(bad ? `${bad} state(s) differ` : 'ALL IDENTICAL');
  return bad;
}

const { flags, positional } = parseArgs(process.argv.slice(2));
const [mode, a, b, c] = positional;
if (mode === 'envelope' && a && b && c) process.exit(envelope(a.split(','), b, c) ? 1 : 0);
if (mode === 'compare' && a && b && c) process.exit(compare(a, b, c) ? 1 : 0);
if (mode === 'layout' && a && b) process.exit(layout(a, b) ? 1 : 0);
if ((mode !== 'record' && mode !== 'replay') || !a || !b || (mode === 'replay' && !c)) {
  console.error('usage: shots.mjs record <origin> <fixtureDir> | replay <origin> <fixtureDir> <outDir> | compare <dirA> <dirB> <diffDir> | envelope <base1,base2,..> <afterDir> <diffDir> | layout <dirA> <dirB>');
  process.exit(2);
}

const origin = a.replace(/\/$/, '');
const fixDir = b;
const outDir = mode === 'record' ? join(fixDir, 'live') : c;
const metaFile = join(fixDir, 'meta.json');
let meta;
if (mode === 'record') {
  mkdirSync(fixDir, { recursive: true });
  // Kept across partial re-records, so every state of one recording shares one clock.
  meta = existsSync(metaFile) ? JSON.parse(readFileSync(metaFile, 'utf8')) : { t0: Date.now(), origin, addresses: await scanAddresses(origin) };
  writeFileSync(metaFile, JSON.stringify(meta, null, 1));
} else {
  meta = JSON.parse(readFileSync(metaFile, 'utf8'));
}
const states = statesFor(meta.addresses).filter((st) => typeof flags.states !== 'string' || new RegExp(flags.states).test(st.id));
const chrome = await launchChrome({ port: Number(flags.port ?? 9335), software: mode === 'replay' && !flags.gpu });
try {
  for (const st of states) {
    try {
      const r = await runState(chrome.cdp, mode, origin, meta, fixDir, outDir, st, Number(flags.settle ?? 300));
      console.log(`${mode} ${st.id}: ${JSON.stringify(r)}`);
    } catch (e) {
      console.log(`${mode} ${st.id}: FAILED ${e.message}`);
    }
  }
} finally {
  await chrome.close();
}
if (misses.length) {
  console.log(`requests the recording has no answer for (${misses.length}):`);
  for (const m of [...new Set(misses)].slice(0, 40)) console.log(`  ${m}`);
}
