#!/usr/bin/env node
// Sum a .cpuprofile (the indexer's SIGUSR2 profile: apps/server/src/indexer/cpuProfile.ts) on the box,
// so only a few lines come back over the laptop's capped link instead of the file.
//
//   node profile-top.mjs <file.cpuprofile> [N]     the N (default 40) costliest functions by self time,
//                                                  then the same summed per source file, then the
//                                                  heaviest call paths (inclusive time) from our code
import { readFileSync } from 'node:fs';

const [file, nArg] = process.argv.slice(2);
if (!file) {
  console.error('usage: node profile-top.mjs <file.cpuprofile> [N]');
  process.exit(2);
}
const N = Number(nArg) || 40;
const p = JSON.parse(readFileSync(file, 'utf8'));
const byId = new Map(p.nodes.map((n) => [n.id, n]));
const parent = new Map();
for (const n of p.nodes) for (const c of n.children ?? []) parent.set(c, n.id);

// Self time per node from the samples and their time deltas (microseconds).
const self = new Map();
for (let i = 0; i < p.samples.length; i++) self.set(p.samples[i], (self.get(p.samples[i]) ?? 0) + (p.timeDeltas[i] ?? 0));
const total = [...self.values()].reduce((a, b) => a + b, 0);

const short = (url) => (url ? url.replace(/^.*\/(apps|packages|node_modules)\//, '$1/') : '(native)');
const key = (n) => `${n.callFrame.functionName || '(anonymous)'}  ${short(n.callFrame.url)}:${n.callFrame.lineNumber + 1}`;
const pct = (us) => `${((100 * us) / total).toFixed(1).padStart(5)}%  ${(us / 1e6).toFixed(2).padStart(7)} s`;

const fn = new Map();
const files = new Map();
for (const [id, us] of self) {
  const n = byId.get(id);
  fn.set(key(n), (fn.get(key(n)) ?? 0) + us);
  const f = short(n.callFrame.url);
  files.set(f, (files.get(f) ?? 0) + us);
}
console.log(`${file}: ${(total / 1e6).toFixed(1)} s sampled`);
console.log('\n== self time by function');
for (const [k, us] of [...fn].sort((a, b) => b[1] - a[1]).slice(0, N)) console.log(`${pct(us)}  ${k}`);
console.log('\n== self time by file');
for (const [k, us] of [...files].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`${pct(us)}  ${k}`);

// Inclusive time per function of our own code (apps/, packages/): which of our passes the time is under.
const incl = new Map();
for (const [id, us] of self) {
  const seen = new Set();
  for (let cur = id; cur !== undefined; cur = parent.get(cur)) {
    const n = byId.get(cur);
    if (!/\/(apps|packages)\//.test(n.callFrame.url)) continue;
    const k = key(n);
    if (seen.has(k)) continue;
    seen.add(k);
    incl.set(k, (incl.get(k) ?? 0) + us);
  }
}
console.log('\n== inclusive time, our code');
for (const [k, us] of [...incl].sort((a, b) => b[1] - a[1]).slice(0, N)) console.log(`${pct(us)}  ${k}`);
