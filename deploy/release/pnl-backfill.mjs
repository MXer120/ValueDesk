#!/usr/bin/env node
// One-off perp PnL backfill from a second server's own Hyperliquid budget (2026-10-28: the
// cohorts moved to perp PnL and ~138k holders needed one portfolio read each - 20 weight - at
// ~24 a minute on server 1 alone). Reads Hyperliquid's public info API only; no key, no write.
//
//   node pnl-backfill.mjs --list addresses.txt --out DIR [--per-min 40]
//
// `addresses.txt`: one 0x address per line, in the order to read them (server 1 reads the
// largest first, so give this one the list from the small end). Each read becomes a line in
// DIR/part-<n>.jsonl - {address, pnl, pnl1d, pnl7d, pnl30d, at}, the portfolio's perpAllTime /
// perpDay / perpWeek / perpMonth - closed every 500 lines. Copy the closed parts to server 1's
// `pnl-import/` beside the index; its indexer takes them (cohortTracker.ts importPnlDrops).
// Restartable: an address already in any part (DIR or DIR/sent) is not read again.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const LIST = arg('--list');
const OUT = arg('--out');
const PER_MIN = Math.max(1, Math.min(55, Number(arg('--per-min', '40')) || 40));
if (!LIST || !OUT) {
  console.error('usage: node pnl-backfill.mjs --list addresses.txt --out DIR [--per-min 40]');
  process.exit(2);
}
mkdirSync(join(OUT, 'sent'), { recursive: true });

const done = new Set();
for (const d of [OUT, join(OUT, 'sent')]) {
  for (const f of readdirSync(d).filter((x) => x.endsWith('.jsonl') || x.endsWith('.open'))) {
    for (const line of readFileSync(join(d, f), 'utf8').split('\n')) {
      const m = /"address":"(0x[0-9a-f]{40})"/.exec(line);
      if (m) done.add(m[1]);
    }
  }
}
const list = readFileSync(LIST, 'utf8').split('\n').map((x) => x.trim().toLowerCase()).filter((x) => /^0x[0-9a-f]{40}$/.test(x) && !done.has(x));
console.log(`pnl-backfill: ${list.length} to read (${done.size} done before), ${PER_MIN}/min`);

const last = (p, w) => {
  const x = Array.isArray(p) ? p.find((e) => e[0] === w) : null;
  const h = x?.[1]?.pnlHistory;
  if (!Array.isArray(h) || !h.length) return null;
  const v = Number(h[h.length - 1][1]);
  return Number.isFinite(v) ? v : null;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let part = null;
let inPart = 0;
const close = () => {
  if (!part) return;
  renameSync(part, part.replace(/\.open$/, '.jsonl'));
  part = null;
  inPart = 0;
};
const gap = 60_000 / PER_MIN;
let n = 0;
let failed = 0;
for (const address of list) {
  const t0 = Date.now();
  let p = null;
  for (let attempt = 0; attempt < 4 && p === null; attempt++) {
    try {
      const r = await fetch('https://api.hyperliquid.xyz/info', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'portfolio', user: address }),
        signal: AbortSignal.timeout(20_000),
      });
      if (r.status === 429) { await sleep(60_000); continue; }
      if (!r.ok) { await sleep(5_000); continue; }
      p = await r.json();
    } catch {
      await sleep(5_000);
    }
  }
  if (!Array.isArray(p)) { failed++; continue; }
  if (!part) part = join(OUT, `part-${Date.now()}.open`);
  appendFileSync(part, `${JSON.stringify({ address, pnl: last(p, 'perpAllTime'), pnl1d: last(p, 'perpDay'), pnl7d: last(p, 'perpWeek'), pnl30d: last(p, 'perpMonth'), at: Date.now() })}\n`);
  n++;
  if (++inPart >= 500) close();
  if (n % 500 === 0) console.log(`pnl-backfill: ${n} read, ${failed} failed, ${list.length - n - failed} left`);
  const wait = gap - (Date.now() - t0);
  if (wait > 0) await sleep(wait);
}
close();
console.log(`pnl-backfill: done - ${n} read, ${failed} failed`);
if (existsSync(join(OUT, 'DONE'))) process.exit(0);
appendFileSync(join(OUT, 'DONE'), `${new Date().toISOString()} ${n} ${failed}\n`);
