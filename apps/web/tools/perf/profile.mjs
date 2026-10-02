// CPU-profile one page and attribute self time to the ORIGINAL source functions
// through the build's hidden sourcemaps (build with `--sourcemap hidden`).
//
//   node tools/perf/profile.mjs <url> <distDir> <out.json> [--cpu=4] [--warm=6] [--secs=10] [--action=ctrlk] [--port=9338]
//
// --cpu    CPU slowdown factor (1 = none).
// --warm   seconds to wait after navigation before recording; 0 records the load itself.
// --secs   seconds recorded.
// --action ctrlk: open the command palette half a second into the recording.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { launchChrome, newPage, parseArgs, sleep } from './cdp.mjs';
import { pressCtrlK } from './pages.mjs';

const { flags, positional } = parseArgs(process.argv.slice(2));
const [url, distDir, outFile] = positional;
if (!url || !distDir || !outFile) {
  console.error('usage: profile.mjs <url> <distDir> <out.json> [--cpu=4] [--warm=6] [--secs=10] [--action=ctrlk] [--port=9338]');
  process.exit(2);
}
const CPU = Number(flags.cpu ?? 4), WARM = Number(flags.warm ?? 6), SECS = Number(flags.secs ?? 10);

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64I = new Int16Array(128).fill(-1);
for (let i = 0; i < 64; i++) B64I[B64.charCodeAt(i)] = i;

/** file -> { lines: [[genCol, source, srcLine, srcCol, name]...] per generated line, sources, names } */
const maps = new Map();
function loadMap(file) {
  if (maps.has(file)) return maps.get(file);
  const p = join(distDir, 'assets', file + '.map');
  let m = null;
  if (existsSync(p)) {
    const raw = JSON.parse(readFileSync(p, 'utf8'));
    const lines = [];
    let src = 0, sl = 0, sc = 0, nm = 0, i = 0, cur = [], col = 0;
    const s = raw.mappings;
    while (i <= s.length) {
      const ch = i < s.length ? s.charCodeAt(i) : 59;
      if (ch === 59) { lines.push(cur); cur = []; col = 0; i++; continue; }
      if (ch === 44) { i++; continue; }
      const seg = [];
      while (i < s.length && s.charCodeAt(i) !== 44 && s.charCodeAt(i) !== 59) {
        let v = 0, sh = 0, d;
        do { d = B64I[s.charCodeAt(i++)]; v += (d & 31) << sh; sh += 5; } while (d & 32);
        seg.push(v & 1 ? -(v >>> 1) : v >>> 1);
      }
      col += seg[0];
      if (seg.length >= 4) {
        src += seg[1]; sl += seg[2]; sc += seg[3];
        if (seg.length >= 5) nm += seg[4];
        cur.push([col, src, sl, sc, seg.length >= 5 ? nm : -1]);
      }
    }
    m = { lines, sources: raw.sources, names: raw.names || [] };
  }
  maps.set(file, m);
  return m;
}
function original(scriptUrl, line, col) {
  const m = loadMap(basename(scriptUrl.split('?')[0]));
  if (!m) return null;
  const segs = m.lines[line];
  if (!segs || !segs.length) return null;
  let lo = 0, hi = segs.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segs[mid][0] <= col) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (best < 0) return null;
  const [, src, sl, , nm] = segs[best];
  return {
    src: m.sources[src].replace(/^.*?(?:apps\/web\/|node_modules\/)/, (x) => (x.includes('node_modules') ? 'nm:' : '')),
    line: sl + 1,
    name: nm >= 0 ? m.names[nm] : null,
  };
}

const chrome = await launchChrome({ port: Number(flags.port ?? 9338) });
let profile;
try {
  const page = await newPage(chrome.cdp);
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  if (CPU > 1) await page.send('Emulation.setCPUThrottlingRate', { rate: CPU });
  await page.send('Profiler.enable');
  await page.send('Profiler.setSamplingInterval', { interval: 200 });
  if (WARM === 0) await page.send('Profiler.start');
  await page.send('Page.navigate', { url });
  if (WARM > 0) { await sleep(WARM * 1000); await page.send('Profiler.start'); }
  if (flags.action === 'ctrlk') { await sleep(500); await pressCtrlK(page); }
  await sleep(SECS * 1000);
  ({ profile } = await page.send('Profiler.stop'));
  await page.close();
} finally {
  await chrome.close();
}

// Self time per call-tree node, then per source function and per source file.
const self = new Map();
const dt = profile.timeDeltas;
for (let i = 0; i < profile.samples.length; i++) self.set(profile.samples[i], (self.get(profile.samples[i]) || 0) + (dt[i] || 0));
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const byFn = new Map(), byFile = new Map();
let total = 0, idle = 0, gc = 0, program = 0;
for (const [id, us] of self) {
  const f = byId.get(id).callFrame;
  total += us;
  if (f.functionName === '(idle)') { idle += us; continue; }
  if (f.functionName === '(garbage collector)') { gc += us; continue; }
  if (f.functionName === '(program)') { program += us; continue; }
  let key, file;
  const o = f.url ? original(f.url, f.lineNumber, f.columnNumber) : null;
  if (o) { file = o.src; key = `${o.src}:${o.line} ${o.name || f.functionName || '(anon)'}`; }
  else { file = f.url ? basename(f.url) : '(native)'; key = `${file} ${f.functionName || '(anon)'}`; }
  byFn.set(key, (byFn.get(key) || 0) + us);
  byFile.set(file, (byFile.get(file) || 0) + us);
}

// Who calls the natives that force layout or style (and focus), mapped to source.
const parent = new Map();
for (const n of profile.nodes) for (const c of n.children || []) parent.set(c, n.id);
const callers = {};
for (const [id, us] of self) {
  const fnName = byId.get(id).callFrame.functionName;
  if (!/^(getBoundingClientRect|getComputedStyle|offsetWidth|offsetHeight|scrollHeight|clientWidth|measureText|focus)$/.test(fnName)) continue;
  const chain = [];
  for (let p = parent.get(id), d = 0; p && d < 4; p = parent.get(p), d++) {
    const f = byId.get(p).callFrame;
    const o = f.url ? original(f.url, f.lineNumber, f.columnNumber) : null;
    chain.push(o ? `${o.src.replace('../../src/', '')}:${o.line} ${o.name || f.functionName}` : f.functionName || '(anon)');
  }
  const k = `${fnName} <- ${chain.join(' <- ')}`;
  callers[k] = (callers[k] || 0) + us;
}

const top = (m, n) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => [k, +(v / 1000).toFixed(1)]);
const res = {
  url, cpu: CPU, warm: WARM, secs: SECS,
  totalMs: total / 1000, idleMs: idle / 1000, gcMs: gc / 1000, programMs: program / 1000, busyMs: (total - idle) / 1000,
  topFunctions: top(byFn, 80), topFiles: top(byFile, 50),
  nativeCallers: Object.entries(callers).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, v]) => [k, +(v / 1000).toFixed(1)]),
};
writeFileSync(outFile, JSON.stringify(res, null, 1));
console.log(`busy ${res.busyMs.toFixed(0)} ms of ${res.totalMs.toFixed(0)} (gc ${res.gcMs.toFixed(0)}, program ${res.programMs.toFixed(0)})`);
console.log('top files:');
for (const [k, v] of res.topFiles.slice(0, 25)) console.log(String(v).padStart(8), k);
console.log('native callers:');
for (const [k, v] of res.nativeCallers) console.log(String(v).padStart(8), k);
console.log('top functions:');
for (const [k, v] of res.topFunctions.slice(0, 40)) console.log(String(v).padStart(8), k);
