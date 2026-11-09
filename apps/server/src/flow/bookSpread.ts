/**
 * SoDEX's real spreads, sampled from its book tickers (owner 2026-11-09: the bots' market data said KORU's spread was
 * 0 bp and that a 20 bp limit would quote 100% of the time, while its book was ~29 bp wide). The print-based estimate
 * (botMarkets.ts spreadOf: the gap between consecutive opposite-side prints) has almost no pairs on a thin market, so
 * it reads 0. This samples every perp's best bid and ask with ONE request (markets/bookTickers) every SAMPLE_MS while
 * someone asks for the bots' market data, and keeps KEEP_MS of samples in memory per market.
 *
 *   typicalBps(symbol, from)   the median spread since `from` (null under MIN_SAMPLES)
 *   shareUnder(symbol, maxBps, from)  the share of time the spread was at or under maxBps (null under MIN_SAMPLES)
 *
 * In memory only: a restart starts over, and until MIN_SAMPLES are in the print-based figures stand.
 */
import { sodex } from '../sodex/rest.js';
import { enginePath } from '../config.js';

export const SAMPLE_MS = 30_000;
export const KEEP_MS = 7 * 24 * 3_600_000;
export const MIN_SAMPLES = 20;

type Sample = [t: number, bps: number];
const samples = new Map<string, Sample[]>();
let timer: ReturnType<typeof setInterval> | null = null;
let busy = false;

/** One sample of every market's spread now: a row's (ask - bid) / mid in bp. */
export function spreadsOf(rows: unknown): Map<string, number> {
  const out = new Map<string, number>();
  const list = Array.isArray(rows) ? rows : ((rows as { data?: unknown[] } | null)?.data ?? []);
  for (const r of list as Array<Record<string, unknown>>) {
    const s = typeof r.symbol === 'string' ? r.symbol.toUpperCase() : typeof r.s === 'string' ? r.s.toUpperCase() : null;
    const bid = Number(r.bidPx ?? r.bidPrice ?? r.b);
    const ask = Number(r.askPx ?? r.askPrice ?? r.a);
    if (!s || !(bid > 0) || !(ask >= bid)) continue;
    out.set(s, ((ask - bid) / ((ask + bid) / 2)) * 1e4);
  }
  return out;
}

/** Add one round of samples (exported for tests). */
export function addSamples(spreads: Map<string, number>, at: number): void {
  for (const [s, bps] of spreads) {
    let a = samples.get(s);
    if (!a) samples.set(s, (a = []));
    a.push([at, bps]);
    while (a.length && a[0]![0] < at - KEEP_MS) a.shift();
  }
}

async function sampleOnce(): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    addSamples(spreadsOf(await sodex.get<unknown>(`${enginePath('perps')}/markets/bookTickers`)), Date.now());
  } catch {
    /* a missed round: the next one comes */
  } finally {
    busy = false;
  }
}

/** Sample from now on (idempotent); the caller stops it when nobody asks any more. */
export function startSampling(): void {
  if (timer) return;
  void sampleOnce();
  timer = setInterval(() => void sampleOnce(), SAMPLE_MS);
  (timer as { unref?: () => void }).unref?.();
}

export function stopSampling(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

function since(symbol: string, from: number): number[] {
  return (samples.get(symbol.toUpperCase()) ?? []).filter((x) => x[0] >= from).map((x) => x[1]);
}

export function typicalBps(symbol: string, from: number): number | null {
  const a = since(symbol, from).sort((x, y) => x - y);
  if (a.length < MIN_SAMPLES) return null;
  return a.length % 2 ? a[(a.length - 1) >> 1]! : (a[a.length / 2 - 1]! + a[a.length / 2]!) / 2;
}

export function shareUnder(symbol: string, maxBps: number, from: number): number | null {
  const a = since(symbol, from);
  if (a.length < MIN_SAMPLES) return null;
  return a.filter((x) => x <= maxBps + 1e-9).length / a.length;
}

/** For tests. */
export function clearSamples(): void {
  samples.clear();
}
