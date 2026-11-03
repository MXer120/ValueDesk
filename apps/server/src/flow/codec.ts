/**
 * WHO TRADED A CANDLE (owner 2026-11-01: "Make it possible to get the following trade info & more
 * for each candle & every timeframe across all supported platforms. If possible backfill
 * historical."). The pure part: how prints and per-wallet sums are packed, merged and read.
 *
 * Every venue we stream names both parties of every print and which one took liquidity
 * (indexer/streams.ts): Hyperliquid and trade.xyz `users` + `side`, SoDEX `bi`/`si` + `S`, Lighter
 * `bid/ask_account_id` + `is_maker_ask`, Arcus maker/taker. So any window of any market can be
 * broken down by wallet - if the prints are kept. They are, in three layers (flow/store.ts):
 *
 *   CHUNK   the raw prints of one market in one 5-minute slot: time, price, size, buyer, seller,
 *           taker. The drill-down's fills and any candle under an hour come from these.
 *   HOUR    per wallet, the sums of one market's hour (WalletSums below).
 *   DAY     the same per UTC day: a 1W or 1M candle merges 7 or 31 day rows, not 744 hours.
 *
 * A wallet is a party id (flow_party: venue + the venue's own key - an address, or a SoDEX / Lighter
 * account id), so a chunk stores 4-byte ids, not 42-character addresses.
 *
 * Both blobs are columnar typed arrays, raw-deflated: prices repeat and sizes cluster, so a
 * Hyperliquid BTC chunk packs to about half its 25 bytes a print.
 */
import { deflateRawSync, inflateRawSync } from 'node:zlib';

/** One raw slot. */
export const CHUNK_MS = 5 * 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

/** Who took liquidity: the venue said the buyer, the seller, or nothing. */
export const TAKER_NONE = 0;
export const TAKER_BUYER = 1;
export const TAKER_SELLER = 2;

/** One print as a chunk keeps it. `t` is absolute ms; party ids are flow_party ids. */
export interface FlowPrint {
  t: number;
  px: number;
  sz: number;
  buyer: number;
  seller: number;
  taker: number;
}

/** A chunk's prints, column by column (what decodeChunk hands back: no object per print). */
export interface PrintCols {
  n: number;
  t: Float64Array;
  px: Float64Array;
  sz: Float64Array;
  buyer: Uint32Array;
  seller: Uint32Array;
  taker: Uint8Array;
}

const CHUNK_MAGIC = 0x46430001; // "FC" v1
const SUMS_MAGIC = 0x46530001; // "FS" v1

/** Pack prints of one slot (any order; they are sorted by time). `base` is the slot start. */
export function encodeChunk(base: number, prints: readonly FlowPrint[]): Buffer {
  const order = prints.map((_, i) => i).sort((a, b) => prints[a]!.t - prints[b]!.t);
  const n = prints.length;
  // Header: magic, n, base (two u32 halves). Then dt u32, px f64, sz f64, buyer u32, seller u32, taker u8 -
  // the f64 columns first so they sit 8-aligned once inflated.
  const head = 16;
  const size = head + n * (8 + 8 + 4 + 4 + 4 + 1);
  const buf = Buffer.alloc(size);
  buf.writeUInt32LE(CHUNK_MAGIC, 0);
  buf.writeUInt32LE(n, 4);
  buf.writeUInt32LE(Math.floor(base / 2 ** 32), 8);
  buf.writeUInt32LE(base % 2 ** 32, 12);
  let o = head;
  for (const i of order) { buf.writeDoubleLE(prints[i]!.px, o); o += 8; }
  for (const i of order) { buf.writeDoubleLE(prints[i]!.sz, o); o += 8; }
  for (const i of order) { buf.writeUInt32LE(Math.max(0, Math.min(2 ** 32 - 1, prints[i]!.t - base)), o); o += 4; }
  for (const i of order) { buf.writeUInt32LE(prints[i]!.buyer >>> 0, o); o += 4; }
  for (const i of order) { buf.writeUInt32LE(prints[i]!.seller >>> 0, o); o += 4; }
  for (const i of order) { buf.writeUInt8(prints[i]!.taker & 3, o); o += 1; }
  return deflateRawSync(buf, { level: 6 });
}

/** A packed chunk, column by column. Throws on a blob that is not one. */
export function decodeChunk(blob: Uint8Array): PrintCols {
  const raw = inflateRawSync(blob);
  if (raw.length < 16 || raw.readUInt32LE(0) !== CHUNK_MAGIC) throw new Error('not a flow chunk');
  const n = raw.readUInt32LE(4);
  const base = raw.readUInt32LE(8) * 2 ** 32 + raw.readUInt32LE(12);
  // Copy into fresh, aligned buffers (an inflated Buffer may sit at any offset of a pool).
  const ab = new ArrayBuffer(raw.length - 16);
  new Uint8Array(ab).set(raw.subarray(16));
  let o = 0;
  const px = new Float64Array(ab, o, n); o += 8 * n;
  const sz = new Float64Array(ab, o, n); o += 8 * n;
  const dt = new Uint32Array(ab, o, n); o += 4 * n;
  const buyer = new Uint32Array(ab, o, n); o += 4 * n;
  const seller = new Uint32Array(ab, o, n); o += 4 * n;
  const taker = new Uint8Array(ab, o, n);
  const t = new Float64Array(n);
  for (let i = 0; i < n; i++) t[i] = base + dt[i]!;
  return { n, t, px, sz, buyer, seller, taker };
}

/** The prints of a chunk as objects (tests, the late-print merge). */
export function chunkPrints(c: PrintCols): FlowPrint[] {
  const out: FlowPrint[] = [];
  for (let i = 0; i < c.n; i++) out.push({ t: c.t[i]!, px: c.px[i]!, sz: c.sz[i]!, buyer: c.buyer[i]!, seller: c.seller[i]!, taker: c.taker[i]! });
  return out;
}

// --- per-wallet sums -------------------------------------------------------------------------------

/**
 * A wallet's sums over some time: for each ROLE (it took liquidity, it made it, the venue did not
 * say) and SIDE (bought, sold), the notional in USD, the size in the coin and the fill count.
 * 3 x 2 x 3 = 18 numbers. Average price = notional / size; net = bought size - sold size.
 */
export const ROLE_TAKER = 0;
export const ROLE_MAKER = 1;
export const ROLE_NONE = 2;
export const SIDE_BUY = 0;
export const SIDE_SELL = 1;
export const F_NTL = 0;
export const F_SZ = 1;
export const F_N = 2;
export const SUM_W = 18;
export const cell = (role: number, side: number, f: number): number => role * 6 + side * 3 + f;

export type WalletSums = Map<number, Float64Array>;

function sumsOf(m: WalletSums, pid: number): Float64Array {
  let a = m.get(pid);
  if (!a) { a = new Float64Array(SUM_W); m.set(pid, a); }
  return a;
}

/** Add the prints of `c` with from <= t < to into `into` (both parties of each). */
export function addPrints(into: WalletSums, c: PrintCols, from = -Infinity, to = Infinity): number {
  let added = 0;
  for (let i = 0; i < c.n; i++) {
    const t = c.t[i]!;
    if (t < from || t >= to) continue;
    const px = c.px[i]!;
    const sz = c.sz[i]!;
    const ntl = px * sz;
    const tk = c.taker[i]!;
    const bRole = tk === TAKER_BUYER ? ROLE_TAKER : tk === TAKER_SELLER ? ROLE_MAKER : ROLE_NONE;
    const sRole = tk === TAKER_SELLER ? ROLE_TAKER : tk === TAKER_BUYER ? ROLE_MAKER : ROLE_NONE;
    const b = sumsOf(into, c.buyer[i]!);
    let k = cell(bRole, SIDE_BUY, 0);
    b[k] = b[k]! + ntl; b[k + 1] = b[k + 1]! + sz; b[k + 2] = b[k + 2]! + 1;
    const s = sumsOf(into, c.seller[i]!);
    k = cell(sRole, SIDE_SELL, 0);
    s[k] = s[k]! + ntl; s[k + 1] = s[k + 1]! + sz; s[k + 2] = s[k + 2]! + 1;
    added++;
  }
  return added;
}

/** Add every wallet of `from` into `into`. */
export function mergeSums(into: WalletSums, from: WalletSums): void {
  for (const [pid, a] of from) {
    const b = sumsOf(into, pid);
    for (let k = 0; k < SUM_W; k++) b[k] = b[k]! + a[k]!;
  }
}

/** Pack per-wallet sums (an hour or a day of one market). */
export function encodeSums(m: WalletSums, prints: number): Buffer {
  const n = m.size;
  const buf = Buffer.alloc(16 + n * SUM_W * 8 + n * 4);
  buf.writeUInt32LE(SUMS_MAGIC, 0);
  buf.writeUInt32LE(n, 4);
  buf.writeDoubleLE(prints, 8);
  let o = 16;
  const ids = [...m.keys()].sort((a, b) => a - b);
  for (const pid of ids) {
    const a = m.get(pid)!;
    for (let k = 0; k < SUM_W; k++) { buf.writeDoubleLE(a[k]!, o); o += 8; }
  }
  for (const pid of ids) { buf.writeUInt32LE(pid >>> 0, o); o += 4; }
  return deflateRawSync(buf, { level: 6 });
}

/** Packed sums back to a map, with the print count they were built from. */
export function decodeSums(blob: Uint8Array): { sums: WalletSums; prints: number } {
  const raw = inflateRawSync(blob);
  if (raw.length < 16 || raw.readUInt32LE(0) !== SUMS_MAGIC) throw new Error('not flow sums');
  const n = raw.readUInt32LE(4);
  const prints = raw.readDoubleLE(8);
  const ab = new ArrayBuffer(raw.length - 16);
  new Uint8Array(ab).set(raw.subarray(16));
  const vals = new Float64Array(ab, 0, n * SUM_W);
  const ids = new Uint32Array(ab, n * SUM_W * 8, n);
  const sums: WalletSums = new Map();
  for (let i = 0; i < n; i++) sums.set(ids[i]!, vals.slice(i * SUM_W, (i + 1) * SUM_W));
  return { sums, prints };
}

// --- reading a window ------------------------------------------------------------------------------

export type FlowRole = 'all' | 'taker' | 'maker';
export type FlowSide = 'all' | 'buy' | 'sell';
export type FlowSort = 'volume' | 'fills' | 'net' | 'buy' | 'sell';

const rolesOf = (r: FlowRole): number[] => (r === 'taker' ? [ROLE_TAKER] : r === 'maker' ? [ROLE_MAKER] : [ROLE_TAKER, ROLE_MAKER, ROLE_NONE]);

/** One wallet's figures under a role filter (sides kept apart: the table shows both). */
export interface WalletFigures {
  buyNtl: number;
  sellNtl: number;
  buySz: number;
  sellSz: number;
  buyN: number;
  sellN: number;
  /** Notional it took liquidity with (both sides), and made. */
  takerNtl: number;
  makerNtl: number;
}

export function figuresOf(a: Float64Array, role: FlowRole): WalletFigures {
  const f: WalletFigures = { buyNtl: 0, sellNtl: 0, buySz: 0, sellSz: 0, buyN: 0, sellN: 0, takerNtl: 0, makerNtl: 0 };
  for (const r of rolesOf(role)) {
    f.buyNtl += a[cell(r, SIDE_BUY, F_NTL)]!;
    f.buySz += a[cell(r, SIDE_BUY, F_SZ)]!;
    f.buyN += a[cell(r, SIDE_BUY, F_N)]!;
    f.sellNtl += a[cell(r, SIDE_SELL, F_NTL)]!;
    f.sellSz += a[cell(r, SIDE_SELL, F_SZ)]!;
    f.sellN += a[cell(r, SIDE_SELL, F_N)]!;
  }
  f.takerNtl = a[cell(ROLE_TAKER, SIDE_BUY, F_NTL)]! + a[cell(ROLE_TAKER, SIDE_SELL, F_NTL)]!;
  f.makerNtl = a[cell(ROLE_MAKER, SIDE_BUY, F_NTL)]! + a[cell(ROLE_MAKER, SIDE_SELL, F_NTL)]!;
  return f;
}

/**
 * What a wallet did in the window, as one word the table draws as an icon:
 *   long   it bought more than it sold (net over 10% of what it traded, in size)
 *   short  the reverse
 *   round  both sides, net within 10%: it round-tripped (market making, arbitrage)
 *   flat   nothing under this filter
 */
export type Lean = 'long' | 'short' | 'round' | 'flat';
export const ROUND_SHARE = 0.1;

export function leanOf(f: Pick<WalletFigures, 'buySz' | 'sellSz'>): Lean {
  const gross = f.buySz + f.sellSz;
  if (!(gross > 0)) return 'flat';
  const net = f.buySz - f.sellSz;
  if (Math.abs(net) <= gross * ROUND_SHARE) return 'round';
  return net > 0 ? 'long' : 'short';
}

/** One row of the window's table. */
export interface FlowRow {
  pid: number;
  /** Volume under the role and side filter (USD), and its share of all wallets' volume so filtered. */
  vol: number;
  share: number;
  buyNtl: number;
  sellNtl: number;
  buySz: number;
  sellSz: number;
  buyN: number;
  sellN: number;
  /** Average buy and sell price (null: no fill that side). */
  buyPx: number | null;
  sellPx: number | null;
  /** Net size bought (sold < 0) and its USD at the window's average price. */
  net: number;
  lean: Lean;
  /** Share of its notional it took liquidity for (0..1; null: the venue does not say). */
  takerShare: number | null;
}

export interface FlowSummary {
  /** Notional traded in the window, each print once (USD), and the print count. */
  total: number;
  prints: number;
  /** Bought / sold by takers (the aggressors): the window's real buy/sell split. */
  takerBuy: number;
  takerSell: number;
  /** Prints whose taker the venue did not name (counted in neither). */
  untaken: number;
  /** Wallets under the role and side filter, and the top three's / ten's share of their volume. */
  wallets: number;
  top3: number;
  top10: number;
  /** Size-weighted average price of the window, and the volume-weighted buy / sell averages of takers. */
  vwap: number | null;
}

/** Sum a window's wallets into the table: totals, then rows ranked by `sort`, with an optional pid filter. */
export function tableOf(
  sums: WalletSums,
  opts: { role: FlowRole; side: FlowSide; sort: FlowSort; limit: number; keep?: (pid: number) => boolean },
): { summary: FlowSummary; rows: FlowRow[] } {
  let total = 0;
  let totalSz = 0;
  let prints = 0;
  let takerBuy = 0;
  let takerSell = 0;
  let untaken = 0;
  const rows: FlowRow[] = [];
  let all = 0;
  for (const [pid, a] of sums) {
    // Each print has one buyer: summing every wallet's buys counts it once.
    const bNtl = a[cell(ROLE_TAKER, SIDE_BUY, F_NTL)]! + a[cell(ROLE_MAKER, SIDE_BUY, F_NTL)]! + a[cell(ROLE_NONE, SIDE_BUY, F_NTL)]!;
    total += bNtl;
    totalSz += a[cell(ROLE_TAKER, SIDE_BUY, F_SZ)]! + a[cell(ROLE_MAKER, SIDE_BUY, F_SZ)]! + a[cell(ROLE_NONE, SIDE_BUY, F_SZ)]!;
    prints += a[cell(ROLE_TAKER, SIDE_BUY, F_N)]! + a[cell(ROLE_MAKER, SIDE_BUY, F_N)]! + a[cell(ROLE_NONE, SIDE_BUY, F_N)]!;
    takerBuy += a[cell(ROLE_TAKER, SIDE_BUY, F_NTL)]!;
    takerSell += a[cell(ROLE_TAKER, SIDE_SELL, F_NTL)]!;
    untaken += a[cell(ROLE_NONE, SIDE_BUY, F_N)]!;
    const f = figuresOf(a, opts.role);
    const vol = opts.side === 'buy' ? f.buyNtl : opts.side === 'sell' ? f.sellNtl : f.buyNtl + f.sellNtl;
    if (!(vol > 0)) continue;
    all += vol;
    if (opts.keep && !opts.keep(pid)) continue;
    const net = f.buySz - f.sellSz;
    const known = f.takerNtl + f.makerNtl;
    rows.push({
      pid,
      vol,
      share: 0,
      buyNtl: f.buyNtl,
      sellNtl: f.sellNtl,
      buySz: f.buySz,
      sellSz: f.sellSz,
      buyN: f.buyN,
      sellN: f.sellN,
      buyPx: f.buySz > 0 ? f.buyNtl / f.buySz : null,
      sellPx: f.sellSz > 0 ? f.sellNtl / f.sellSz : null,
      net,
      lean: leanOf(f),
      takerShare: known > 0 ? f.takerNtl / known : null,
    });
  }
  const vwap = totalSz > 0 ? total / totalSz : null;
  const key: (r: FlowRow) => number =
    opts.sort === 'fills' ? (r) => r.buyN + r.sellN
    : opts.sort === 'net' ? (r) => Math.abs(r.net) * (vwap ?? 1)
    : opts.sort === 'buy' ? (r) => r.buyNtl
    : opts.sort === 'sell' ? (r) => r.sellNtl
    : (r) => r.vol;
  rows.sort((a, b) => key(b) - key(a) || b.vol - a.vol || a.pid - b.pid);
  const wallets = opts.keep ? rows.length : countPositive(sums, opts);
  // Top three and ten of the whole field (not of a search).
  let top3 = 0;
  let top10 = 0;
  if (all > 0) {
    const best = opts.keep ? topVols(sums, opts, 10) : rows.slice().sort((a, b) => b.vol - a.vol).slice(0, 10).map((r) => r.vol);
    top3 = best.slice(0, 3).reduce((s, v) => s + v, 0) / all;
    top10 = best.reduce((s, v) => s + v, 0) / all;
  }
  for (const r of rows) r.share = all > 0 ? r.vol / all : 0;
  return {
    summary: { total, prints, takerBuy, takerSell, untaken, wallets, top3, top10, vwap },
    rows: rows.slice(0, Math.max(0, opts.limit)),
  };
}

function volOf(a: Float64Array, role: FlowRole, side: FlowSide): number {
  const f = figuresOf(a, role);
  return side === 'buy' ? f.buyNtl : side === 'sell' ? f.sellNtl : f.buyNtl + f.sellNtl;
}

function countPositive(sums: WalletSums, o: { role: FlowRole; side: FlowSide }): number {
  let n = 0;
  for (const a of sums.values()) if (volOf(a, o.role, o.side) > 0) n++;
  return n;
}

function topVols(sums: WalletSums, o: { role: FlowRole; side: FlowSide }, k: number): number[] {
  const best: number[] = [];
  for (const a of sums.values()) {
    const v = volOf(a, o.role, o.side);
    if (!(v > 0)) continue;
    if (best.length < k) { best.push(v); best.sort((x, y) => y - x); } else if (v > best[k - 1]!) { best[k - 1] = v; best.sort((x, y) => y - x); }
  }
  return best;
}

/** One wallet's fills in a chunk, appended column-wise (the drill-down). */
export interface WalletFills {
  t: number[];
  px: number[];
  sz: number[];
  /** 1 bought, -1 sold. */
  side: number[];
  /** 0 taker, 1 maker, 2 not said. */
  role: number[];
  /** The other party's id. */
  other: number[];
}

export const emptyFills = (): WalletFills => ({ t: [], px: [], sz: [], side: [], role: [], other: [] });

/** Append `pid`'s prints of `c` in [from, to) to `out`; stops at `cap` rows. Returns false when capped. */
export function walletFillsOf(out: WalletFills, c: PrintCols, pid: number, from: number, to: number, cap: number): boolean {
  for (let i = 0; i < c.n; i++) {
    const t = c.t[i]!;
    if (t < from || t >= to) continue;
    const b = c.buyer[i] === pid;
    const s = c.seller[i] === pid;
    if (!b && !s) continue;
    const tk = c.taker[i]!;
    // A self-trade (both sides one wallet) is listed twice: once bought, once sold.
    for (const buys of b && s ? [true, false] : [b]) {
      if (out.t.length >= cap) return false;
      out.t.push(t);
      out.px.push(c.px[i]!);
      out.sz.push(c.sz[i]!);
      out.side.push(buys ? 1 : -1);
      out.role.push(tk === TAKER_NONE ? ROLE_NONE : (tk === TAKER_BUYER) === buys ? ROLE_TAKER : ROLE_MAKER);
      out.other.push(buys ? c.seller[i]! : c.buyer[i]!);
    }
  }
  return true;
}
