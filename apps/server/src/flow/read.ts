/**
 * The API's reads of the trade flow (store.ts): who traded in a window, and one wallet's fills.
 *
 * A window is put together from the coarsest rows that fit inside it: whole UTC days from
 * flow_day, whole hours from flow_hour, the rest (a candle under an hour, the hour still forming,
 * an hour not summed yet) from the 5-minute chunks, cut to the exact milliseconds. A 1D candle is
 * one day row per market; a 1M candle 31; a 1m candle one chunk.
 *
 * THE API THREAD (no stalls - the heatmap's tiles taught that): the loop is given back between
 * rows (YIELD_MS), decoded rows of slots that can no longer change are kept in an LRU bounded by
 * wallets (MAX_CACHED), and whole answers for windows that have passed are kept too (ANSWERS).
 */
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { Venue } from '../valuedesk/types.js';
import {
  CHUNK_MS, DAY_MS, HOUR_MS,
  addPrints, decodeChunk, decodeSums, emptyFills, mergeSums, tableOf, walletFillsOf,
  type FlowRole, type FlowRow, type FlowSide, type FlowSort, type FlowSummary, type PrintCols, type WalletFills, type WalletSums,
} from './codec.js';
import { CLOSE_MS, FLUSH_MS, READY_MS } from './recorder.js';
import { flowReader, type FlowMarket, type FlowStore } from './store.js';

/** The longest window one read sums (a 1M candle is 31 days). */
export const MAX_WINDOW_MS = 400 * DAY_MS;
/** The most fills one drill-down sends. */
export const MAX_FILLS = 200_000;
const YIELD_MS = 8;
/** Decoded rows kept, counted in wallets (an hour of BTC on Hyperliquid: a few thousand). */
const MAX_CACHED = 2_000_000;

export type MarketKind = 'perp' | 'spot';
/** Spot markets: SoDEX `vBTC_vUSDC`, anything with a slash or an `@` index. */
export const kindOf = (symbol: string): MarketKind => (/[_/@]/.test(symbol) ? 'spot' : 'perp');

// --- caches -----------------------------------------------------------------------------------------

class Lru<V> {
  private m = new Map<string, { v: V; w: number }>();
  private weight = 0;
  constructor(private readonly cap: number) {}
  get(k: string): V | undefined {
    const e = this.m.get(k);
    if (!e) return undefined;
    this.m.delete(k);
    this.m.set(k, e);
    return e.v;
  }
  set(k: string, v: V, w = 1): void {
    const old = this.m.get(k);
    if (old) { this.weight -= old.w; this.m.delete(k); }
    this.m.set(k, { v, w });
    this.weight += w;
    for (const [key, e] of this.m) {
      if (this.weight <= this.cap) break;
      this.m.delete(key);
      this.weight -= e.w;
    }
  }
  clear(): void { this.m.clear(); this.weight = 0; }
}

const sumsCache = new Lru<{ sums: WalletSums; prints: number }>(MAX_CACHED);
const chunkCache = new Lru<PrintCols>(MAX_CACHED);
const answers = new Lru<{ at: number; final: boolean; body: unknown }>(256);

/** Tests: forget everything kept. */
export function clearFlowCaches(): void {
  sumsCache.clear();
  chunkCache.clear();
  answers.clear();
}

/** A slot that can no longer change: its end passed long enough ago for the last flush. */
const settled = (end: number, now: number): boolean => end + CLOSE_MS + FLUSH_MS + 5_000 <= now;

function cachedSums(s: FlowStore, level: 'hour' | 'day', mid: number, t: number, now: number): { sums: WalletSums; prints: number } | null {
  const k = `${level}|${mid}|${t}`;
  const hit = sumsCache.get(k);
  if (hit) return hit;
  const blob = s.sums(level, mid, t);
  if (!blob) return null;
  const d = decodeSums(blob);
  // A summed row is written after its slot passed; a late print may sum it again, rarely.
  if (settled(t + (level === 'hour' ? HOUR_MS : DAY_MS) + READY_MS, now)) sumsCache.set(k, d, Math.max(1, d.sums.size));
  return d;
}

function cachedChunk(mid: number, t: number, n: number, data: Uint8Array, now: number): PrintCols {
  const k = `${mid}|${t}|${n}`;
  const hit = chunkCache.get(k);
  if (hit) return hit;
  const c = decodeChunk(data);
  if (settled(t + CHUNK_MS, now)) chunkCache.set(k, c, Math.max(1, Math.ceil(c.n / 4)));
  return c;
}

// --- composing a window -----------------------------------------------------------------------------

export interface Piece {
  level: 'day' | 'hour' | 'chunk';
  t: number;
  /** For chunks: the cut [from, to) inside the slot. */
  from: number;
  to: number;
}

/**
 * The rows that make up [from, to) for one market, coarsest first: a day where a day row exists and
 * the window holds the whole day, else hours likewise, else chunk spans. Pure (tests).
 */
export function plan(from: number, to: number, days: ReadonlySet<number>, hours: ReadonlySet<number>): Piece[] {
  const out: Piece[] = [];
  let t = from;
  while (t < to) {
    if (t % DAY_MS === 0 && t + DAY_MS <= to && days.has(t)) {
      out.push({ level: 'day', t, from: t, to: t + DAY_MS });
      t += DAY_MS;
    } else if (t % HOUR_MS === 0 && t + HOUR_MS <= to && hours.has(t)) {
      out.push({ level: 'hour', t, from: t, to: t + HOUR_MS });
      t += HOUR_MS;
    } else {
      // Raw prints up to the next hour boundary (or the window's end).
      const end = Math.min(to, Math.floor(t / HOUR_MS) * HOUR_MS + HOUR_MS);
      out.push({ level: 'chunk', t: Math.floor(t / CHUNK_MS) * CHUNK_MS, from: t, to: end });
      t = end;
    }
  }
  return out;
}

async function sumWindow(s: FlowStore, m: FlowMarket, from: number, to: number, into: WalletSums, now: number, budget: { at: number }): Promise<number> {
  const days = new Set(from + DAY_MS <= to ? s.sumTimes('day', m.id, from, to) : []);
  const hours = new Set(from + HOUR_MS <= to ? s.sumTimes('hour', m.id, from, to) : []);
  let prints = 0;
  for (const p of plan(from, to, days, hours)) {
    if (p.level === 'chunk') {
      for (const c of s.chunks(m.id, Math.floor(p.from / CHUNK_MS) * CHUNK_MS, p.to)) {
        prints += addPrints(into, cachedChunk(m.id, c.t, c.n, c.data, now), p.from, p.to);
        if (Date.now() - budget.at > YIELD_MS) { await nextTurn(); budget.at = Date.now(); }
      }
    } else {
      const d = cachedSums(s, p.level, m.id, p.t, now);
      if (d) { mergeSums(into, d.sums); prints += d.prints; }
    }
    if (Date.now() - budget.at > YIELD_MS) { await nextTurn(); budget.at = Date.now(); }
  }
  return prints;
}

// --- the window's table -----------------------------------------------------------------------------

export interface FlowAsk {
  coin: string;
  venues: readonly Venue[];
  kind: MarketKind;
  from: number;
  to: number;
  role: FlowRole;
  side: FlowSide;
  sort: FlowSort;
  limit: number;
  /** An address (or SoDEX / Lighter account id) to look for: only matching rows. */
  q?: string;
}

export interface FlowWallet {
  venue: Venue;
  /** The wallet's address, when known; else null and `key` is the venue's account id. */
  address: string | null;
  key: string;
}

export interface FlowWindowRow extends Omit<FlowRow, 'pid'>, FlowWallet {}

export interface FlowCoverage {
  venue: Venue;
  symbol: string;
  /** The first print recorded for the market. */
  since: number;
}

export interface FlowWindow {
  coin: string;
  from: number;
  to: number;
  /** The window has passed and every slot in it is final (cached a day). */
  final: boolean;
  summary: FlowSummary;
  rows: FlowWindowRow[];
  markets: FlowCoverage[];
  /** When the recorder was down inside the window: [from, to) spans with no prints recorded. */
  gaps: Array<[number, number]>;
  /** The recorder's first start (how far back any flow goes). */
  since: number | null;
}

/** Spans inside [from, to) the recorder was not running (meta `runs`). */
export function gapsOf(runs: ReadonlyArray<[number, number]>, from: number, to: number, slack = 2 * 60_000): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  // A run is noted every minute: its last note may be up to a minute behind (slack).
  let t = from;
  for (const [a, b] of [...runs].sort((x, y) => x[0] - y[0])) {
    if (b + slack <= t) continue;
    if (a > t && a < to) out.push([t, a]);
    t = Math.max(t, b + slack);
    if (t >= to) break;
  }
  if (t < to) out.push([t, to]);
  return out.filter(([a, b]) => b > a);
}

function runsOf(s: FlowStore): Array<[number, number]> {
  try { return JSON.parse(s.getMeta('runs') ?? '[]') as Array<[number, number]>; } catch { return []; }
}

/** The span the Hyperliquid archive was imported for (backfillHl.ts), or null. */
function backfillOf(s: FlowStore): [number, number] | null {
  try { return JSON.parse(s.getMeta('backfill:hyperliquid') ?? 'null') as [number, number] | null; } catch { return null; }
}

/** What covers a window of these venues: the recorder's runs, and the archive when every venue is in it. */
function coverOf(s: FlowStore, venues: readonly Venue[]): { runs: Array<[number, number]>; since: number | null } {
  const runs = runsOf(s);
  let since = Number(s.getMeta('since')) || null;
  const fill = backfillOf(s);
  if (fill && venues.length && venues.every((v) => v === 'hyperliquid' || v === 'tradexyz')) {
    runs.push(fill);
    since = since === null ? fill[0] : Math.min(since, fill[0]);
  }
  return { runs, since };
}

export function marketsOf(s: FlowStore, coin: string, venues: readonly Venue[], kind: MarketKind): FlowMarket[] {
  const want = new Set(venues);
  return s.marketsOfCoin(coin.toUpperCase()).filter((m) => want.has(m.venue) && kindOf(m.symbol) === kind);
}

export async function flowWindow(ask: FlowAsk, now = Date.now()): Promise<FlowWindow | null> {
  const s = flowReader();
  if (!s) return null;
  const key = JSON.stringify(['w', ask]);
  const hit = answers.get(key);
  if (hit && (hit.final || now - hit.at < 5_000)) return hit.body as FlowWindow;
  const markets = marketsOf(s, ask.coin, ask.venues, ask.kind);
  const sums: WalletSums = new Map();
  const budget = { at: Date.now() };
  // One map for every market: a party id is per venue, so wallets on two venues stay two rows.
  for (const m of markets) await sumWindow(s, m, ask.from, ask.to, sums, now, budget);
  const keep = ask.q ? matcher(s, ask.q) : undefined;
  const { summary, rows } = tableOf(sums, { role: ask.role, side: ask.side, sort: ask.sort, limit: ask.limit, ...(keep ? { keep } : {}) });
  const who = s.partiesById(rows.map((r) => r.pid));
  const final = settled(ask.to + READY_MS, now);
  const cover = coverOf(s, ask.venues);
  const since = cover.since;
  const body: FlowWindow = {
    coin: ask.coin.toUpperCase(),
    from: ask.from,
    to: ask.to,
    final,
    summary,
    rows: rows.map(({ pid, ...r }) => {
      const p = who.get(pid);
      return { ...r, venue: p?.venue ?? 'hyperliquid', address: p?.address ?? null, key: p?.key ?? String(pid) };
    }),
    markets: markets.map((m) => ({ venue: m.venue, symbol: m.symbol, since: m.firstT })),
    gaps: gapsOf(cover.runs, Math.max(ask.from, since ?? ask.from), Math.min(ask.to, now)),
    since,
  };
  answers.set(key, { at: now, final, body });
  return body;
}

/** Party ids whose address or account id contains `q` (at most a few thousand). */
function matcher(s: FlowStore, q: string): (pid: number) => boolean {
  const needle = q.trim().toLowerCase();
  const ids = new Set(
    (s.db.prepare('SELECT id FROM flow_party WHERE address LIKE ? OR key LIKE ? LIMIT 5000').all(`%${needle}%`, `%${needle}%`) as Array<{ id: number }>).map((r) => r.id),
  );
  return (pid) => ids.has(pid);
}

// --- one wallet's fills -----------------------------------------------------------------------------

export interface WalletAsk {
  coin: string;
  venues: readonly Venue[];
  kind: MarketKind;
  from: number;
  to: number;
  /** Its address, or a SoDEX / Lighter account id. */
  wallet: string;
  /** Only this venue's account under that address (a row of the table names one). */
  venue?: Venue;
}

export interface WalletFillsBody {
  coin: string;
  from: number;
  to: number;
  final: boolean;
  wallets: FlowWallet[];
  /** Column per field, oldest first: time (ms), price, size, 1 bought / -1 sold, 0 taker / 1 maker / 2 not said, venue index (into `venues`), counterparty index (into `others`). */
  fills: { t: number[]; px: number[]; sz: number[]; side: number[]; role: number[]; venue: number[]; other: number[] };
  venues: Venue[];
  others: Array<{ address: string | null; key: string }>;
  /** More fills than MAX_FILLS: the oldest MAX_FILLS were sent. */
  capped: boolean;
}

export async function flowWalletFills(ask: WalletAsk, now = Date.now()): Promise<WalletFillsBody | null> {
  const s = flowReader();
  if (!s) return null;
  const key = JSON.stringify(['f', ask]);
  const hit = answers.get(key);
  if (hit && (hit.final || now - hit.at < 5_000)) return hit.body as WalletFillsBody;
  const parties = s.partiesOf(ask.wallet).filter((p) => ask.venues.includes(p.venue) && (!ask.venue || p.venue === ask.venue));
  const markets = marketsOf(s, ask.coin, ask.venues, ask.kind);
  const venues: Venue[] = [];
  const merged: Array<{ fills: WalletFills; venue: number }> = [];
  let capped = false;
  const budget = { at: Date.now() };
  for (const p of parties) {
    for (const m of markets.filter((x) => x.venue === p.venue)) {
      const out = emptyFills();
      // Hours the wallet did not trade in are skipped by their sums (no chunk is opened).
      const hours = new Set(s.sumTimes('hour', m.id, Math.floor(ask.from / HOUR_MS) * HOUR_MS, ask.to));
      for (let h = Math.floor(ask.from / HOUR_MS) * HOUR_MS; h < ask.to && !capped; h += HOUR_MS) {
        if (hours.has(h)) {
          const d = cachedSums(s, 'hour', m.id, h, now);
          if (d && !d.sums.has(p.id)) continue;
        }
        for (const c of s.chunks(m.id, Math.max(h, Math.floor(ask.from / CHUNK_MS) * CHUNK_MS), Math.min(h + HOUR_MS, ask.to))) {
          if (!walletFillsOf(out, cachedChunk(m.id, c.t, c.n, c.data, now), p.id, ask.from, ask.to, MAX_FILLS)) { capped = true; break; }
          if (Date.now() - budget.at > YIELD_MS) { await nextTurn(); budget.at = Date.now(); }
        }
      }
      if (out.t.length) {
        let vi = venues.indexOf(p.venue);
        if (vi < 0) { venues.push(p.venue); vi = venues.length - 1; }
        merged.push({ fills: out, venue: vi });
      }
    }
  }
  // One time-ordered list across the wallet's markets.
  const idx: Array<[number, number]> = [];
  for (let a = 0; a < merged.length; a++) for (let i = 0; i < merged[a]!.fills.t.length; i++) idx.push([a, i]);
  idx.sort((x, y) => merged[x[0]]!.fills.t[x[1]]! - merged[y[0]]!.fills.t[y[1]]!);
  const fills: WalletFillsBody['fills'] = { t: [], px: [], sz: [], side: [], role: [], venue: [], other: [] };
  const otherIdx = new Map<number, number>();
  const otherIds: number[] = [];
  for (const [a, i] of idx.slice(0, MAX_FILLS)) {
    const f = merged[a]!.fills;
    fills.t.push(f.t[i]!);
    fills.px.push(f.px[i]!);
    fills.sz.push(f.sz[i]!);
    fills.side.push(f.side[i]!);
    fills.role.push(f.role[i]!);
    fills.venue.push(merged[a]!.venue);
    let o = otherIdx.get(f.other[i]!);
    if (o === undefined) { o = otherIds.length; otherIds.push(f.other[i]!); otherIdx.set(f.other[i]!, o); }
    fills.other.push(o);
  }
  const who = s.partiesById(otherIds);
  const final = settled(ask.to + READY_MS, now);
  const body: WalletFillsBody = {
    coin: ask.coin.toUpperCase(),
    from: ask.from,
    to: ask.to,
    final,
    wallets: parties.map((p) => ({ venue: p.venue, address: p.address, key: p.key })),
    fills,
    venues,
    others: otherIds.map((id) => ({ address: who.get(id)?.address ?? null, key: who.get(id)?.key ?? String(id) })),
    capped: capped || idx.length > MAX_FILLS,
  };
  answers.set(key, { at: now, final, body }, 1);
  return body;
}

/** What the flow holds, for the health route and the report: rows, bytes, how far back. */
export function flowFacts(): { since: number | null; sizes: Record<string, { rows: number; bytes: number }>; markets: number } | null {
  const s = flowReader();
  if (!s) return null;
  return { since: Number(s.getMeta('since')) || null, sizes: s.sizes(), markets: s.markets().length };
}
