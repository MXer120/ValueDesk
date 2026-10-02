// Markdown tables from rates.mjs results: one walk, or two as before -> after.
//   node tools/perf/rates-compare.mjs before.json [after.json] [--paths] [--server]
//
// "Requests" are the ones that went over the network: the browser's requests minus the
// ones its HTTP cache answered. --server takes the API's own count instead (walks run
// with --access-log; attribution is by time, so a slow answer can land in the next phase).
// --paths adds the per-path breakdown of the steady minute.
import { readFileSync } from 'node:fs';
import { parseArgs } from './cdp.mjs';

const { flags, positional } = parseArgs(process.argv.slice(2));
if (!positional.length) {
  console.error('usage: rates-compare.mjs before.json [after.json] [--paths] [--server]');
  process.exit(2);
}
const runs = positional.slice(0, 2).map((f) => JSON.parse(readFileSync(f, 'utf8')));
const [A, B] = runs;
const phases = A.phases;
const steadyName = phases.filter((p) => p.startsWith('min')).at(-1);

/** One phase of one page: network requests to our API, their bytes and 304s. */
function api(page, phase) {
  if (!page) return null;
  const s = flags.server ? page.server?.[phase] : null;
  if (s) return { n: s.n, bytes: s.bytes, n304: s.n304, byPath: s.byPath };
  const b = page.browser[phase].api;
  return {
    n: b.n - b.cached,
    bytes: b.bytes,
    n304: b.n304,
    byPath: Object.fromEntries(Object.entries(b.byPath).map(([k, v]) => [k, { n: v.n - v.cached, bytes: v.bytes, n304: v.n304 }])),
  };
}
const sum = (page, f) => (page ? phases.reduce((s, p) => s + f(api(page, p)), 0) : null);
const cell = (a, b, fmt = String) => (B ? `${a == null ? '-' : fmt(a)} → ${b == null ? '-' : fmt(b)}` : a == null ? '-' : fmt(a));
const kb = (x) => (x / 1024).toFixed(1);

const ids = [...new Set(runs.flatMap((r) => Object.keys(r.pages)))];
console.log(`${B ? 'before → after' : 'one walk'}: ${A.seconds.visible} s visible, ${A.seconds.hidden} s hidden, ${A.seconds.back} s shown again (${runs.map((r) => r.when).join(' / ')})\n`);
console.log(`| page | our API, first minute | our API, steady minute | while hidden (${A.seconds.hidden} s) | on return (${A.seconds.back} s) | 304s in the walk | our API kB in the walk | exchanges, steady minute | exchange sockets |`);
console.log('|---|---|---|---|---|---|---|---|---|');
for (const id of ids) {
  const a = A.pages[id], b = B?.pages[id];
  const n = (p, phase) => (p ? api(p, phase).n : null);
  const direct = (p) => (p ? p.browser[steadyName].direct.n : null);
  const sockets = (p) => (p ? p.browser[steadyName].ws.open : null);
  console.log(`| ${id} | ${cell(n(a, phases[0]), n(b, phases[0]))} | ${cell(n(a, steadyName), n(b, steadyName))} | ${cell(n(a, 'hidden'), n(b, 'hidden'))} | ${cell(n(a, 'back'), n(b, 'back'))} | ${cell(sum(a, (x) => x.n304), sum(b, (x) => x.n304))} | ${cell(sum(a, (x) => x.bytes), sum(b, (x) => x.bytes), kb)} | ${cell(direct(a), direct(b))} | ${cell(sockets(a), sockets(b))} |`);
}

if (flags.paths) {
  console.log(`\nPer path, steady minute (${steadyName}): requests (304s), kB.\n`);
  console.log('| page | path | requests | kB |');
  console.log('|---|---|---|---|');
  for (const id of ids) {
    const pa = api(A.pages[id], steadyName)?.byPath ?? {};
    const pb = B ? api(B.pages[id], steadyName)?.byPath ?? {} : {};
    for (const path of [...new Set([...Object.keys(pa), ...Object.keys(pb)])].sort()) {
      const f = (e) => (e ? `${e.n}${e.n304 ? ` (${e.n304})` : ''}` : '0');
      const short = path.length > 70 ? `${path.slice(0, 67)}...` : path;
      console.log(`| ${id} | \`${short}\` | ${B ? `${f(pa[path])} → ${f(pb[path])}` : f(pa[path])} | ${cell(pa[path]?.bytes ?? 0, pb[path]?.bytes ?? 0, kb)} |`);
    }
  }
}
