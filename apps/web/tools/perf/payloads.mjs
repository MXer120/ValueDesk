// Index API payloads: bytes per endpoint (raw, gzip, brotli as the server would send
// them) and, with --web, the fields no web source file ever names (trimming candidates;
// nothing is changed).
//
//   node tools/perf/payloads.mjs <origin> out.json [--web=src]
//   node tools/perf/payloads.mjs --compare before.json after.json
//
// The URLs are the ones the pages really request (rates.mjs --paths shows them).
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
import { parseArgs } from './cdp.mjs';

const { flags, positional } = parseArgs(process.argv.slice(2));
const kb = (n) => (n / 1024).toFixed(1);

if (flags.compare) {
  const [a, b] = positional.map((f) => JSON.parse(readFileSync(f, 'utf8')));
  console.log('| endpoint | raw kB | gzip kB | brotli kB |');
  console.log('|---|---|---|---|');
  for (const [name, x] of Object.entries(a.endpoints)) {
    const y = b.endpoints[name];
    if (!y) continue;
    const pct = x.raw ? ` (${Math.round(((y.raw - x.raw) / x.raw) * 100)} %)` : '';
    console.log(`| \`${name}\` | ${kb(x.raw)} → ${kb(y.raw)}${pct} | ${kb(x.gzip)} → ${kb(y.gzip)} | ${kb(x.br)} → ${kb(y.br)} |`);
  }
  process.exit(0);
}

const [originArg, outFile] = positional;
if (!originArg || !outFile) {
  console.error('usage: payloads.mjs <origin> out.json [--web=src] | payloads.mjs --compare before.json after.json');
  process.exit(2);
}
const origin = originArg.replace(/\/$/, '');
const ALL = 'sodex%2Chyperliquid%2Ctradexyz%2Clighter%2Carcus';
const top = async (venue) => {
  try {
    const r = await (await fetch(`${origin}/api/vs/leaderboard?venue=${venue}&window=30d&sort=pnl&limit=1`)).json();
    return r?.rows?.[0]?.address ?? null;
  } catch { return null; }
};
const hl = process.env.PERF_ADDR_HYPERLIQUID || (await top('hyperliquid'));

/** [name shown in the table, path] */
const ENDPOINTS = [
  ['leaderboard (page: 5 venues netted, 100 rows)', `/api/vs/leaderboard?venues=${ALL}&view=net&window=30d&sort=pnl&limit=100&offset=0&side=top&minTrades=2`],
  ['leaderboard (same, curves=1)', `/api/vs/leaderboard?venues=${ALL}&view=net&window=30d&sort=pnl&limit=100&offset=0&side=top&minTrades=2&curves=1`],
  ['leaderboard (copy: hyperliquid, 8 rows)', '/api/vs/leaderboard?venue=hyperliquid&window=30d&sort=pnl&limit=8'],
  ['leaderboard (palette: one venue, 12 rows)', '/api/vs/leaderboard?venue=tradexyz&window=1d&sort=pnl&limit=12'],
  ['explore', '/api/vs/explore'],
  ['whales (40)', '/api/vs/whales?venue=all&minUsd=100000&limit=40'],
  ['positioning', '/api/vs/positioning?venue=all'],
  ['cohorts', `/api/vs/cohorts?venues=${ALL}`],
  ['cohorts/map', `/api/vs/cohorts/map?venues=${ALL}`],
  ['cohorts/detail', `/api/vs/cohorts/detail?venues=${ALL}&cohort=whale&range=7d`],
  ['cohorts/focus', `/api/vs/cohorts/focus?venues=${ALL}&coin=BTC&range=7d`],
  ['cohorts/wallets (50)', `/api/vs/cohorts/wallets?venues=${ALL}&cohort=whale&sort=equity&dir=desc&offset=0&limit=50`],
  ['screener (palette: 12 rows)', '/api/vs/screener?limit=12&sort=pnl&venue=sodex&window=1d'],
  ['screener (50 rows)', '/api/vs/screener?venue=all&limit=50'],
  ...(hl ? [['lbrow', `/api/vs/lbrow?venue=hyperliquid&address=${hl}`]] : []),
  ['health', '/api/health'],
  ['maintenance status', '/api/external/maintenance/status'],
];

function walk(dir, out = []) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f)) out.push(readFileSync(p, 'utf8'));
  }
  return out;
}
const web = typeof flags.web === 'string' ? walk(flags.web).join('\n') : null;
const mentioned = (k) => new RegExp(`(?:\\.|\\[\\s*['"\`]|\\b)${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(web);

/** key path (with [] for array elements) -> serialized bytes under it, and occurrences */
function fields(v, path = '', acc = new Map()) {
  if (Array.isArray(v)) { for (const x of v) fields(x, `${path}[]`, acc); return acc; }
  if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      // Keys that are data (addresses, coins, timestamps) rather than field names.
      const key = /^(0x[0-9a-f]{6,}|\d+[a-z]?|[A-Z0-9:_./-]{1,20})$/.test(k) && !/^[a-z]/.test(k) ? '<key>' : k;
      const p = `${path}.${key}`;
      const bytes = Buffer.byteLength(JSON.stringify(x) ?? '') + Buffer.byteLength(k) + 4;
      const e = acc.get(p) || { bytes: 0, n: 0, name: key };
      e.bytes += bytes; e.n++;
      acc.set(p, e);
      fields(x, p, acc);
    }
  }
  return acc;
}

const out = { origin, when: new Date().toISOString(), endpoints: {} };
console.log('| endpoint | raw kB | gzip kB | brotli kB | Cache-Control |');
console.log('|---|---|---|---|---|');
const candidates = [];
for (const [name, path] of ENDPOINTS) {
  let res, body;
  try {
    res = await fetch(origin + path, { headers: { 'Accept-Encoding': 'identity' } });
    body = Buffer.from(await res.arrayBuffer());
  } catch (e) {
    console.log(`| \`${name}\` | failed: ${e.message} | | | |`);
    continue;
  }
  // What perf.ts sends: brotli quality 5, gzip level 6.
  const gzip = gzipSync(body, { level: 6 }).length;
  const br = brotliCompressSync(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } }).length;
  const cc = res.headers.get('cache-control') ?? '';
  out.endpoints[name] = { path, status: res.status, raw: body.length, gzip, br, cacheControl: cc, etag: Boolean(res.headers.get('etag')) };
  console.log(`| \`${name}\` | ${kb(body.length)} | ${kb(gzip)} | ${kb(br)} | ${cc}${res.headers.get('etag') ? ' + ETag' : ''} |`);
  if (!web) continue;
  let json;
  try { json = JSON.parse(body.toString('utf8')); } catch { continue; }
  const unused = [...fields(json).entries()].filter(([, e]) => e.name !== '<key>' && !mentioned(e.name)).sort((a, b) => b[1].bytes - a[1].bytes);
  // Only the outermost unread paths: a child of an unread parent says nothing new.
  const outer = unused.filter(([p]) => !unused.some(([q]) => q !== p && (p.startsWith(`${q}.`) || p.startsWith(`${q}[]`))));
  for (const [p, e] of outer.slice(0, 12)) candidates.push(`  ${kb(e.bytes).padStart(7)} kB ${String(e.n).padStart(5)}x  ${name}: ${p}`);
}
writeFileSync(outFile, JSON.stringify(out, null, 1));
if (web) {
  console.log('\nFields no web source names (by field name; a name used anywhere counts as read):');
  console.log(candidates.length ? candidates.join('\n') : '  none');
}
