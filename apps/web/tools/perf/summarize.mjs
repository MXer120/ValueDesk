// Markdown tables from a metrics.mjs result: one build, or the first two as before -> after.
//   node tools/perf/summarize.mjs metrics.json [--profile=fast|slow]
import { readFileSync } from 'node:fs';
import { parseArgs } from './cdp.mjs';

const { flags, positional } = parseArgs(process.argv.slice(2));
const r = JSON.parse(readFileSync(positional[0], 'utf8'));
const [A, B] = Object.keys(r.origins);
const pages = [...new Set(Object.keys(r.pages).map((k) => k.split('|').slice(1).join('|')))]
  .filter((p) => !flags.profile || p.endsWith(`|${flags.profile}`));

const f0 = (x) => (x == null ? '-' : String(Math.round(x)));
const kb = (x) => (x == null ? '-' : (x / 1024).toFixed(0));
const mb = (x) => (x == null ? '-' : (x / 1048576).toFixed(1));
const med = (label, p) => r.pages[`${label}|${p}`]?.median;
const cell = (p, k, fmt) => {
  const a = med(A, p);
  const b = B ? med(B, p) : null;
  return b ? `${fmt(a?.[k])} → ${fmt(b[k])}` : fmt(a?.[k]);
};
const name = (p) => `${p.replace('|', ' [')}]`;

const visits = r.visit === 'return' ? 'return visits (warm HTTP cache and storage)' : 'cold loads';
console.log(`${B ? `${A} → ${B}` : A}, median of ${r.runs} ${visits} (${r.when})\n`);
console.log('| page [profile] | FCP ms | LCP ms | data shown ms | TBT ms | TBT incl. load ms | TTI ms | long tasks ms | JS heap MB |');
console.log('|---|---|---|---|---|---|---|---|---|');
for (const p of pages) {
  if (!med(A, p)) continue;
  console.log(`| ${name(p)} | ${cell(p, 'fcp', f0)} | ${cell(p, 'lcp', f0)} | ${cell(p, 'ready', f0)} | ${cell(p, 'tbt', f0)} | ${cell(p, 'tbtFromStart', f0)} | ${cell(p, 'tti', f0)} | ${cell(p, 'longTaskMs', f0)} | ${cell(p, 'heapUsed', mb)} |`);
}

const windows = Object.entries(r.profiles ?? {}).map(([n, p]) => `${n}: first ${p.windowSeconds} s`).join(', ');
console.log(`\nRequests started after navigation (${windows}); kB on the wire.\n`);
console.log('| page [profile] | site files | site kB | our API requests | our API kB | exchange requests | exchange kB | WebSockets | WS frames |');
console.log('|---|---|---|---|---|---|---|---|---|');
for (const p of pages) {
  if (!med(A, p)) continue;
  console.log(`| ${name(p)} | ${cell(p, 'siteRequests', f0)} | ${cell(p, 'siteBytes', kb)} | ${cell(p, 'apiRequests', f0)} | ${cell(p, 'apiBytes', kb)} | ${cell(p, 'directRequests', f0)} | ${cell(p, 'directBytes', kb)} | ${cell(p, 'sockets', f0)} | ${cell(p, 'socketFrames', f0)} |`);
}
