/**
 * Read the shared feed's ring for a while and say what is in it (the trading box's `--feed-tap`):
 *
 *   node --import tsx tools/feed-tap.ts [path] [seconds]
 *
 * Per symbol: ticks, and the delay from Binance's event time to the producer's receipt (wall clock, ms); for the
 * whole ring: this reader's delay behind the producer (monotonic, polling every 2 ms), ticks lost, the heartbeat.
 */
import { DEFAULT_FEED_PATH, RingReader, monoNs } from '../src/feed/ring.ts';

const path = process.argv[2] || DEFAULT_FEED_PATH;
const seconds = Number(process.argv[3] || 10);
const r = new RingReader(path);
const per = new Map<number, { n: number; lag: number[] }>();
const behind: number[] = [];
const pct = (xs: number[], p: number) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))]! : NaN);
console.log(`${path}: ${r.symbols.length} symbols, feeds ${r.feeds.join(',')}, alive ${r.alive()}`);
const t = setInterval(() => {
  const now = monoNs();
  const wall = Date.now();
  for (const k of r.drain()) {
    const e = per.get(k.symbol) ?? { n: 0, lag: [] };
    e.n++;
    // The producer's receipt in wall-clock ms, minus Binance's event time.
    if (k.eventMs > 0) e.lag.push(wall - Number((now - k.rxNs) / 1_000_000n) - k.eventMs);
    per.set(k.symbol, e);
    behind.push(Number(now - k.rxNs) / 1e6);
  }
}, 2);
setTimeout(() => {
  clearInterval(t);
  const rows = [...per.entries()].sort((a, b) => b[1].n - a[1].n);
  for (const [i, e] of rows.slice(0, 20)) console.log(`${r.symbols[i]!.market.padEnd(12)} ticks ${String(e.n).padStart(6)}  Binance event -> feed p50 ${pct(e.lag, 0.5).toFixed(1)} p90 ${pct(e.lag, 0.9).toFixed(1)} ms`);
  console.log(`${rows.length} symbols ticked; reader behind the feed p50 ${pct(behind, 0.5).toFixed(2)} p90 ${pct(behind, 0.9).toFixed(2)} p99 ${pct(behind, 0.99).toFixed(2)} ms; lost ${r.lost}; alive ${r.alive()}`);
  r.close();
}, seconds * 1000);
