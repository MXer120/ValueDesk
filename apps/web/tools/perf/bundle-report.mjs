// Bundle composition of a Vite dist/ built with `--sourcemap hidden`.
// No dependencies: decodes the source-map VLQ itself and attributes every generated
// byte to its original source file, then groups by npm package / app folder.
//
//   node tools/perf/bundle-report.mjs <distDir> <out.json> [label]
//
// Prints: the JS a first render waits for (the entry, its static imports and the
// modulepreloads of index.html), what each landing page adds to it, the totals, and
// where the first-render bytes come from.
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { gzipSync, brotliCompressSync, constants } from 'node:zlib';

const [, , distDir, outJson, label = ''] = process.argv;
if (!distDir || !outJson) { console.error('usage: bundle-report.mjs <dist> <out.json> [label]'); process.exit(2); }
const assets = join(distDir, 'assets');

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64I = new Int16Array(128).fill(-1);
for (let i = 0; i < B64.length; i++) B64I[B64.charCodeAt(i)] = i;

/** Decode one mappings line into segments [genCol, src?, ...]. State is carried in `st`. */
function decodeMappings(mappings) {
  const lines = [];
  let src = 0, sl = 0, sc = 0, nm = 0;
  let i = 0;
  const n = mappings.length;
  let cur = [];
  let col = 0;
  while (i <= n) {
    const ch = i < n ? mappings.charCodeAt(i) : 59; // ';' at end
    if (ch === 59) { lines.push(cur); cur = []; col = 0; i++; if (i > n) break; continue; }
    if (ch === 44) { i++; continue; }
    // read a segment
    const seg = [];
    while (i < n) {
      const c = mappings.charCodeAt(i);
      if (c === 44 || c === 59) break;
      let value = 0, shift = 0, digit;
      do {
        digit = B64I[mappings.charCodeAt(i++)];
        value += (digit & 31) << shift;
        shift += 5;
      } while (digit & 32);
      seg.push(value & 1 ? -(value >>> 1) : value >>> 1);
    }
    col += seg[0];
    if (seg.length >= 4) {
      src += seg[1]; sl += seg[2]; sc += seg[3];
      if (seg.length >= 5) nm += seg[4];
      cur.push([col, src]);
    } else {
      cur.push([col, -1]);
    }
  }
  return lines;
}

function groupOf(source) {
  const s = source.replace(/\\/g, '/');
  const nm = s.lastIndexOf('node_modules/');
  if (nm >= 0) {
    const rest = s.slice(nm + 'node_modules/'.length).split('/');
    return rest[0].startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0];
  }
  if (s.includes('/apps/server/src/')) return 'app:server-shared(@sign)';
  if (s.includes('/packages/sodex-core/')) return 'app:@sodex-core';
  const m = s.match(/\/apps\/web\/src\/(.*)$/) || s.match(/(?:^|\/)src\/(.*)$/);
  if (m) {
    const parts = m[1].split('/');
    return 'app:src/' + (parts.length > 1 ? parts.slice(0, parts[0] === 'components' && parts.length > 2 ? 2 : 1).join('/') : '(root)');
  }
  if (s.startsWith('\0') || s.includes('vite/') || s.includes('commonjsHelpers') || s.includes('preload-helper')) return 'vite-runtime';
  return 'other:' + s.split('/').slice(-2).join('/');
}

function attribute(js, map) {
  const bySource = new Map();
  const lines = js.split('\n');
  const decoded = decodeMappings(map.mappings);
  let mapped = 0;
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const segs = decoded[li] || [];
    if (!segs.length) { bySource.set(-1, (bySource.get(-1) || 0) + Buffer.byteLength(line) + 1); continue; }
    // leading unmapped
    if (segs[0][0] > 0) bySource.set(-1, (bySource.get(-1) || 0) + Buffer.byteLength(line.slice(0, segs[0][0])));
    for (let k = 0; k < segs.length; k++) {
      const start = segs[k][0];
      const end = k + 1 < segs.length ? segs[k + 1][0] : line.length;
      if (end <= start) continue;
      const bytes = Buffer.byteLength(line.slice(start, end));
      bySource.set(segs[k][1], (bySource.get(segs[k][1]) || 0) + bytes);
      if (segs[k][1] >= 0) mapped += bytes;
    }
    bySource.set(-1, (bySource.get(-1) || 0) + 1); // newline
  }
  const out = {};
  for (const [idx, bytes] of bySource) {
    const name = idx < 0 ? '(unmapped)' : map.sources[idx];
    out[name] = (out[name] || 0) + bytes;
  }
  return out;
}

const gz = (buf) => gzipSync(buf, { level: 9 }).length;
const br = (buf) => brotliCompressSync(buf, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length;

// ---- chunk graph -------------------------------------------------------------
const files = readdirSync(assets);
const chunks = {};
for (const f of files) {
  if (extname(f) !== '.js') continue;
  const code = readFileSync(join(assets, f), 'utf8');
  const statics = new Set();
  const dynamics = new Set();
  // static:  import{a as b}from"./x.js";  import"./x.js";  export{..}from"./x.js"
  for (const m of code.matchAll(/(?:import|export)\s*(?:[\w${},*\s]+?from\s*)?["']\.\/([\w.$-]+\.js)["']/g)) statics.add(m[1]);
  // dynamic: import("./x.js")
  for (const m of code.matchAll(/import\(\s*["']\.\/([\w.$-]+\.js)["']\s*\)/g)) dynamics.add(m[1]);
  // vite preload map deps: const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["assets/x.js",...])))
  const mapDeps = [];
  const md = code.match(/m\.f\|\|\(m\.f=\[([^\]]*)\]\)/);
  if (md) for (const m of md[1].matchAll(/["']assets\/([^"']+)["']/g)) mapDeps.push(m[1]);
  chunks[f] = { bytes: Buffer.byteLength(code), statics: [...statics], dynamics: [...dynamics], mapDeps };
}

// entry from index.html
const html = readFileSync(join(distDir, 'index.html'), 'utf8');
const entry = [...html.matchAll(/<script[^>]+src="\/assets\/([^"]+\.js)"/g)].map((m) => m[1]);
const preloads = [...html.matchAll(/<link[^>]+rel="modulepreload"[^>]+href="\/assets\/([^"]+)"/g)].map((m) => m[1]);
const cssInitial = [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="\/assets\/([^"]+\.css)"/g)].map((m) => m[1]);

function closure(roots) {
  const seen = new Set();
  const stack = [...roots];
  while (stack.length) {
    const c = stack.pop();
    if (seen.has(c) || !chunks[c]) continue;
    seen.add(c);
    for (const s of chunks[c].statics) stack.push(s);
  }
  return [...seen];
}
const initial = closure([...entry, ...preloads.filter((p) => p.endsWith('.js'))]);

// What each landing page adds: its chunk (App.tsx's lazyPage table and SODEX_DOCS) and that chunk's static imports.
const ROUTES = {
  trade: 'TradeDashboard', explore: 'Explore', copy: 'CopyPage', leaderboard: 'LeaderboardPage', portfolio: 'PortfolioDashboard',
  scan: 'ScanDashboard', bots: 'BotsPage', referrals: 'ReferralsPage', points: 'SoPointsPage',
};

// ---- sizes -----------------------------------------------------------------
function sizes(list) {
  let raw = 0, g = 0, b = 0;
  for (const f of list) {
    const buf = readFileSync(join(assets, f));
    raw += buf.length; g += gz(buf); b += br(buf);
  }
  return { files: list.length, raw, gzip: g, brotli: b };
}

const allJs = Object.keys(chunks);
const allCss = files.filter((f) => f.endsWith('.css'));
const fonts = files.filter((f) => /\.(woff2?|ttf|otf)$/.test(f));

// composition of initial JS and of all JS
function composition(list) {
  const bySrc = {};
  const byGroup = {};
  for (const f of list) {
    const mp = join(assets, f + '.map');
    if (!existsSync(mp)) continue;
    const js = readFileSync(join(assets, f), 'utf8');
    const map = JSON.parse(readFileSync(mp, 'utf8'));
    const a = attribute(js, map);
    for (const [src, bytes] of Object.entries(a)) {
      bySrc[src] = (bySrc[src] || 0) + bytes;
      const g = src === '(unmapped)' ? '(unmapped)' : groupOf(src);
      byGroup[g] = (byGroup[g] || 0) + bytes;
    }
  }
  const sortObj = (o, n) => Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n));
  return { byGroup: sortObj(byGroup, 80), topSources: sortObj(bySrc, 60) };
}

// per-chunk top groups (for naming the big chunks)
const perChunk = {};
for (const f of allJs) {
  const mp = join(assets, f + '.map');
  let top = [];
  if (existsSync(mp)) {
    const js = readFileSync(join(assets, f), 'utf8');
    const map = JSON.parse(readFileSync(mp, 'utf8'));
    const a = attribute(js, map);
    const g = {};
    for (const [src, bytes] of Object.entries(a)) {
      const k = src === '(unmapped)' ? '(unmapped)' : groupOf(src);
      g[k] = (g[k] || 0) + bytes;
    }
    top = Object.entries(g).sort((x, y) => y[1] - x[1]).slice(0, 4).map(([k, v]) => `${k}:${(v / 1024).toFixed(0)}k`);
  }
  perChunk[f] = { bytes: chunks[f].bytes, initial: initial.includes(f), top };
}

// public/ assets (logos etc.) that ship alongside
function walk(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, acc); else acc.push({ p, bytes: st.size });
  }
  return acc;
}
const logoFiles = walk(join(distDir, 'logos'));
const logoBy = {};
for (const { p, bytes } of logoFiles) {
  const rel = p.slice(join(distDir, 'logos').length + 1).replace(/\\/g, '/');
  const dir = rel.split('/').slice(0, -1).join('/') || '.';
  const ext = extname(rel);
  const k = `${dir} ${ext}`;
  logoBy[k] = logoBy[k] || { files: 0, bytes: 0 };
  logoBy[k].files++; logoBy[k].bytes += bytes;
}
const biggestLogos = logoFiles.sort((a, b) => b.bytes - a.bytes).slice(0, 25)
  .map(({ p, bytes }) => ({ file: p.slice(distDir.length + 1).replace(/\\/g, '/'), bytes }));

/** Bytes per original source file of a chunk list (for a before/after diff of what a route's first render holds). */
function sourcesOf(list) {
  const out = {};
  for (const f of list) {
    const mp = join(assets, f + '.map');
    if (!existsSync(mp)) continue;
    const a = attribute(readFileSync(join(assets, f), 'utf8'), JSON.parse(readFileSync(mp, 'utf8')));
    for (const [src, bytes] of Object.entries(a)) {
      const k = src === '(unmapped)' ? src : src.replace(/\\/g, '/').replace(/^.*?\/(apps|packages|node_modules)\//, '$1/');
      out[k] = (out[k] || 0) + bytes;
    }
  }
  return Object.fromEntries(Object.entries(out).sort((x, y) => y[1] - x[1]));
}
const routes = {};
for (const [route, name] of Object.entries(ROUTES)) {
  const chunk = allJs.find((f) => f.startsWith(`${name}-`));
  if (!chunk) continue;
  const extra = closure([chunk]).filter((f) => !initial.includes(f));
  const first = [...initial, ...extra];
  routes[route] = { chunk, extra: sizes(extra), firstRender: sizes(first), chunks: first, sources: sourcesOf(first) };
}

const report = {
  label,
  entry, preloads, cssInitial,
  initialJs: { chunks: initial, ...sizes(initial) },
  routes,
  initialCss: sizes(cssInitial),
  allJs: sizes(allJs),
  allCss: sizes(allCss),
  fonts: { files: fonts.length, raw: fonts.reduce((s, f) => s + statSync(join(assets, f)).size, 0) },
  logos: { files: logoFiles.length, bytes: logoFiles.reduce((s, x) => s + x.bytes, 0), byDir: logoBy, biggest: biggestLogos },
  initialComposition: composition(initial),
  allComposition: composition(allJs),
  chunks: Object.fromEntries(Object.entries(perChunk).sort((a, b) => b[1].bytes - a[1].bytes)),
};
writeFileSync(outJson, JSON.stringify(report, null, 2));

const kb = (n) => (n / 1024).toFixed(1) + ' kB';
console.log(`== ${label} ==`);
console.log(`entry: ${entry.join(', ')}  preloads: ${preloads.length}  css: ${cssInitial.join(', ')}`);
console.log(`initial JS : ${initial.length} chunks  raw ${kb(report.initialJs.raw)}  gzip ${kb(report.initialJs.gzip)}  br ${kb(report.initialJs.brotli)}`);
for (const [route, r] of Object.entries(routes)) {
  console.log(`  + ${route.padEnd(11)} ${String(r.extra.files).padStart(2)} chunks ${kb(r.extra.raw).padStart(9)} raw ${kb(r.extra.gzip).padStart(9)} gzip  => first render ${kb(r.firstRender.raw)} raw / ${kb(r.firstRender.gzip)} gzip / ${kb(r.firstRender.brotli)} br`);
}
console.log(`initial CSS: raw ${kb(report.initialCss.raw)}  gzip ${kb(report.initialCss.gzip)}`);
console.log(`all JS     : ${allJs.length} chunks  raw ${kb(report.allJs.raw)}  gzip ${kb(report.allJs.gzip)}`);
console.log(`all CSS    : ${allCss.length} files raw ${kb(report.allCss.raw)}`);
console.log(`fonts      : ${fonts.length} files raw ${kb(report.fonts.raw)}`);
console.log(`logos      : ${logoFiles.length} files ${kb(report.logos.bytes)}`);
console.log('initial composition (top groups):');
for (const [g, b] of Object.entries(report.initialComposition.byGroup).slice(0, 40)) console.log(`  ${kb(b).padStart(10)}  ${g}`);
console.log('biggest chunks:');
for (const [f, c] of Object.entries(report.chunks).slice(0, 25)) console.log(`  ${kb(c.bytes).padStart(10)} ${c.initial ? '*' : ' '} ${f}  ${c.top.join(' ')}`);
