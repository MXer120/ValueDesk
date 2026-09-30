/**
 * Local account statistics. Aggregates only — no trade ids.
 *
 * STORAGE (`vs.stats.<address>`, one JSON document)
 * -------------------------------------------------
 *   v     1
 *   addr  wallet
 *   u     ms this document was last folded
 *   c     per-stream cursors (see below)
 *   t     all-time totals
 *   xf    biggest funding payment { v, t } — signed, greatest absolute value
 *   xe    biggest fee actually paid { v, t }
 *   h     hourly buckets, key = hour-start epoch ms (UTC). Capped.
 *   d     daily buckets, key = UTC day-start epoch ms. Capped, kept longer.
 *
 * Totals `t` and both bucket sets use the same fields:
 *   f fee vol dep wd ord fil
 *   funding (signed: positive received, negative paid — the account-history
 *   convention, not the sodex-core comment), fees paid (positive fees only;
 *   a negative fee is a maker rebate and is not subtracted), notional volume,
 *   gross stablecoin deposits, gross stablecoin withdrawals, orders placed,
 *   fills.
 *
 * CURSOR
 * ------
 * Gateway history is newest-first and `endTime` is inclusive (accountData.ts).
 * There is no startTime, so each stream stores:
 *   h  newest ms already folded. A later run reads from the present and stops
 *      when it reaches this. Only rows with time > h are folded, so a second
 *      run does not double-count.
 *   b  oldest ms fully consumed. The next older page is requested with
 *      endTime = b. Rows with time >= b are the inclusive overlap and are
 *      not folded again. null = no page consumed yet (omit endTime).
 *   x  true once a short page, or a page with nothing older than b, ends
 *      the walk. Same-timestamp clusters bigger than a page cannot be split:
 *      the venue cursor is only a timestamp, and the history UI stops there
 *      too (countNew === 0).
 * The ledger (`l`) has no endTime. alpha-biz `account_flow` pages by `start`
 * offset, newest first, so `o` is the next offset. `h` / `b` / `x` mean the
 * same thing; rows with time >= b are skipped so a prepend does not double-count.
 *
 * Keys inside `c`: f funding, ts/tp spot and futures trades, os/op spot and
 * futures orders, l ledger.
 *
 * WEIGHT
 * ------
 * Documented gateway budget is 1,200 weight/minute (envelope.ts
 * REST_WEIGHT_PER_MINUTE). A history page costs 20 + floor(limit/20)
 * (weightFor on orders/history, trades, fundings, positions/history).
 * limit 100 → 25, so the budget is 48 pages/minute. A 1s pause at that
 * weight would be 1,500/minute and overdraws it, which is why Default is
 * 2.5s (600 weight, half the budget, two pages in flight) rather than 1s.
 * Giga Fast starts a page every 1,250ms — 48 × 25 = 1,200, the cap, spread
 * across the minute rather than burst. The runner will not start faster
 * than that. A 429 pushes the next start out (2s, doubled, cap 30s) and
 * never shrinks the gap.
 */
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;
/** Last 14 days of hours. Older hours fall off; all-time totals stay. */
export const HOURLY_KEEP = 14 * 24;
/** Daily buckets are kept much longer than hourly ones. */
export const DAILY_KEEP = 800;

/**
 * SoDEX REST budget, per IP, per minute. Matches envelope.ts
 * REST_WEIGHT_PER_MINUTE. The indexer treats this as a hard cap.
 */
export const WEIGHT_PER_MIN = 1200;

/** 20 + floor(limit/20). Same formula as weightFor() for paged history. */
export function historyWeight(limit: number): number {
  return 20 + Math.floor(Math.max(0, limit) / 20);
}

/** Minimum spacing so `limit`-sized history pages stay inside WEIGHT_PER_MIN. */
export function budgetGapMs(limit = 100): number {
  const pages = Math.max(1, Math.floor(WEIGHT_PER_MIN / historyWeight(limit)));
  return Math.ceil(60_000 / pages);
}

export type SpeedId = 'efficient' | 'default' | 'fast' | 'giga';

export interface SpeedPreset {
  id: SpeedId;
  label: string;
  /** Pages allowed in flight at once. */
  concurrency: number;
  /** Minimum ms between page starts. Never under budgetGapMs for this limit. */
  delayMs: number;
  limit: number;
}

const HISTORY_LIMIT = 100;

export const SPEEDS: Record<SpeedId, SpeedPreset> = {
  efficient: { id: 'efficient', label: 'Efficient', concurrency: 1, delayMs: 6_000, limit: HISTORY_LIMIT },
  default: { id: 'default', label: 'Default', concurrency: 2, delayMs: 2_500, limit: HISTORY_LIMIT },
  fast: { id: 'fast', label: 'Fast', concurrency: 3, delayMs: 1_500, limit: HISTORY_LIMIT },
  giga: { id: 'giga', label: 'Giga Fast', concurrency: 4, delayMs: budgetGapMs(HISTORY_LIMIT), limit: HISTORY_LIMIT },
};

export const SPEED_ORDER: readonly SpeedId[] = ['efficient', 'default', 'fast', 'giga'];

export function readSpeed(getItem: (key: string) => string | null): SpeedId {
  const v = getItem('vs.setup.indexSpeed');
  return v === 'efficient' || v === 'fast' || v === 'giga' || v === 'default' ? v : 'default';
}

export type ProfileId = 'beginner' | 'default' | 'advanced';

/**
 * Beginner: no open position, and below every "some history" line.
 * Advanced: many markets, high volume, or many orders / fills.
 * Anything in between is Default. Advanced wins over Beginner.
 */
export const PROFILE = {
  beginnerFills: 5,
  beginnerOrders: 10,
  beginnerVolume: 1_000,
  advancedMarkets: 4,
  advancedVolume: 100_000,
  advancedOrders: 100,
  advancedFills: 200,
} as const;

export interface ActivitySnapshot {
  openPositions: number;
  fills: number;
  orders: number;
  volume: number;
  markets: number;
}

export function recommendProfile(a: ActivitySnapshot): ProfileId {
  if (
    a.markets >= PROFILE.advancedMarkets
    || a.volume >= PROFILE.advancedVolume
    || a.orders >= PROFILE.advancedOrders
    || a.fills >= PROFILE.advancedFills
  ) return 'advanced';
  if (
    a.openPositions <= 0
    && a.fills < PROFILE.beginnerFills
    && a.orders < PROFILE.beginnerOrders
    && a.volume < PROFILE.beginnerVolume
  ) return 'beginner';
  return 'default';
}

export function profileBlurb(p: ProfileId): string {
  if (p === 'beginner') return 'Little or no trading history yet.';
  if (p === 'advanced') return 'Several markets, high volume, or a lot of orders.';
  return 'Some fills, or a moderate amount of volume.';
}

export type GwStream = 'funding' | 'trades-spot' | 'trades-perps' | 'orders-spot' | 'orders-perps';

/** Newest-first gateway cursor. `h`/`b` are ms; `b` null means "not started". */
export interface GwCursor {
  h: number;
  b: number | null;
  x: boolean;
}

/** Ledger cursor. `o` is the next alpha-biz `start` offset. */
export interface LedgerCursor {
  h: number;
  b: number | null;
  o: number;
  x: boolean;
}

export interface Extreme {
  v: number;
  t: number;
}

type Metric = 'f' | 'fee' | 'vol' | 'dep' | 'wd' | 'ord' | 'fil';
const METRICS: readonly Metric[] = ['f', 'fee', 'vol', 'dep', 'wd', 'ord', 'fil'];

export type BucketSet = Record<Metric, Record<string, number>>;
export type Totals = Record<Metric, number>;

export interface StoredIndex {
  v: 1;
  addr: string;
  u: number;
  c: {
    f: GwCursor;
    ts: GwCursor;
    tp: GwCursor;
    os: GwCursor;
    op: GwCursor;
    l: LedgerCursor;
  };
  t: Totals;
  xf: Extreme | null;
  xe: Extreme | null;
  h: BucketSet;
  d: BucketSet;
}

const CURSOR_FIELD = {
  funding: 'f',
  'trades-spot': 'ts',
  'trades-perps': 'tp',
  'orders-spot': 'os',
  'orders-perps': 'op',
} as const;

export type Pass = 'newer' | 'older';

export function indexKey(address: string): string {
  return `vs.stats.${address.trim().toLowerCase()}`;
}

export function hourStart(t: number): number {
  return Math.floor(t / HOUR_MS) * HOUR_MS;
}

export function dayStart(t: number): number {
  return Math.floor(t / DAY_MS) * DAY_MS;
}

function emptyCursor(): GwCursor {
  return { h: 0, b: null, x: false };
}

function emptyBuckets(): BucketSet {
  return { f: {}, fee: {}, vol: {}, dep: {}, wd: {}, ord: {}, fil: {} };
}

function emptyTotals(): Totals {
  return { f: 0, fee: 0, vol: 0, dep: 0, wd: 0, ord: 0, fil: 0 };
}

export function emptyIndex(address: string): StoredIndex {
  return {
    v: 1,
    addr: address.trim().toLowerCase(),
    u: 0,
    c: {
      f: emptyCursor(),
      ts: emptyCursor(),
      tp: emptyCursor(),
      os: emptyCursor(),
      op: emptyCursor(),
      l: { h: 0, b: null, o: 0, x: false },
    },
    t: emptyTotals(),
    xf: null,
    xe: null,
    h: emptyBuckets(),
    d: emptyBuckets(),
  };
}

function asNum(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : NaN;
  }
  return NaN;
}

function asMap(v: unknown): Record<string, number> {
  if (!v || typeof v !== 'object') return {};
  const out: Record<string, number> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    const t = Number(k);
    const n = typeof val === 'number' ? val : Number(val);
    if (!Number.isFinite(t) || !Number.isFinite(n)) continue;
    out[String(Math.trunc(t))] = n;
  }
  return out;
}

function asBuckets(v: unknown): BucketSet {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const out = emptyBuckets();
  for (const k of METRICS) out[k] = asMap(o[k]);
  return out;
}

function asTotals(v: unknown): Totals {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const out = emptyTotals();
  for (const k of METRICS) {
    const n = asNum(o[k]);
    if (Number.isFinite(n)) out[k] = n;
  }
  return out;
}

function asGw(v: unknown): GwCursor {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const b = asNum(o.b);
  const h = asNum(o.h);
  return {
    h: Number.isFinite(h) && h > 0 ? h : 0,
    b: Number.isFinite(b) && b > 0 ? b : null,
    x: o.x === true,
  };
}

function asLedger(v: unknown): LedgerCursor {
  const g = asGw(v);
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const off = asNum(o.o);
  return { h: g.h, b: g.b, x: g.x, o: Number.isFinite(off) && off > 0 ? Math.trunc(off) : 0 };
}

function asExtreme(v: unknown): Extreme | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const n = asNum(o.v);
  const t = asNum(o.t);
  if (!Number.isFinite(n) || !Number.isFinite(t) || t <= 0) return null;
  return { v: n, t };
}

export function parseIndex(raw: string | null, address: string): StoredIndex {
  if (!raw) return emptyIndex(address);
  try {
    const p = JSON.parse(raw) as unknown;
    if (!p || typeof p !== 'object' || (p as { v?: unknown }).v !== 1) return emptyIndex(address);
    const o = p as Record<string, unknown>;
    const c = (o.c && typeof o.c === 'object' ? o.c : {}) as Record<string, unknown>;
    const idx = emptyIndex(address);
    idx.u = Math.max(0, asNum(o.u) || 0);
    idx.c = {
      f: asGw(c.f), ts: asGw(c.ts), tp: asGw(c.tp), os: asGw(c.os), op: asGw(c.op), l: asLedger(c.l),
    };
    idx.t = asTotals(o.t);
    idx.xf = asExtreme(o.xf);
    idx.xe = asExtreme(o.xe);
    idx.h = asBuckets(o.h);
    idx.d = asBuckets(o.d);
    capBuckets(idx);
    return idx;
  } catch {
    return emptyIndex(address);
  }
}

function capMap(map: Record<string, number>, keep: number): Record<string, number> {
  const keys = Object.keys(map);
  if (keys.length <= keep) return map;
  keys.sort((a, b) => Number(a) - Number(b));
  const next: Record<string, number> = {};
  const start = keys.length - keep;
  for (let i = start; i < keys.length; i++) {
    const key = keys[i];
    if (key === undefined) continue;
    const v = map[key];
    if (v !== undefined) next[key] = v;
  }
  return next;
}

function capBuckets(index: StoredIndex): void {
  for (const k of METRICS) {
    index.h[k] = capMap(index.h[k], HOURLY_KEEP);
    index.d[k] = capMap(index.d[k], DAILY_KEEP);
  }
}

/** Drop the oldest half of every hourly map (at least one key). For a quota retry. */
export function dropOldestHours(index: StoredIndex): StoredIndex {
  const next = clone(index);
  for (const k of METRICS) {
    const keys = Object.keys(next.h[k]).sort((a, b) => Number(a) - Number(b));
    if (keys.length === 0) continue;
    const cut = Math.min(keys.length, Math.max(1, Math.floor(keys.length / 2)));
    const kept: Record<string, number> = {};
    for (let i = cut; i < keys.length; i++) {
      const key = keys[i];
      if (key === undefined) continue;
      const v = next.h[k][key];
      if (v !== undefined) kept[key] = v;
    }
    next.h[k] = kept;
  }
  return next;
}

export function saveIndex(storage: Pick<Storage, 'setItem'>, index: StoredIndex): StoredIndex {
  const key = indexKey(index.addr);
  try {
    storage.setItem(key, JSON.stringify(index));
    return index;
  } catch {
    const trimmed = dropOldestHours(index);
    try { storage.setItem(key, JSON.stringify(trimmed)); } catch { /* still over quota */ }
    return trimmed;
  }
}

function clone(index: StoredIndex): StoredIndex {
  const copyBuckets = (b: BucketSet): BucketSet => {
    const out = emptyBuckets();
    for (const k of METRICS) out[k] = { ...b[k] };
    return out;
  };
  return {
    v: 1,
    addr: index.addr,
    u: index.u,
    c: {
      f: { ...index.c.f },
      ts: { ...index.c.ts },
      tp: { ...index.c.tp },
      os: { ...index.c.os },
      op: { ...index.c.op },
      l: { ...index.c.l },
    },
    t: { ...index.t },
    xf: index.xf ? { ...index.xf } : null,
    xe: index.xe ? { ...index.xe } : null,
    h: copyBuckets(index.h),
    d: copyBuckets(index.d),
  };
}

function addBucket(map: Record<string, number>, time: number, size: number, value: number): void {
  const key = String(Math.floor(time / size) * size);
  map[key] = (map[key] ?? 0) + value;
}

function bump(index: StoredIndex, metric: Metric, time: number, value: number): void {
  index.t[metric] += value;
  addBucket(index.h[metric], time, HOUR_MS, value);
  addBucket(index.d[metric], time, DAY_MS, value);
}

function rowTime(stream: GwStream, row: any): number {
  if (stream === 'funding') return asNum(row?.timestamp);
  if (stream === 'orders-spot' || stream === 'orders-perps') return asNum(row?.createdAt);
  return asNum(row?.time);
}

function absorb(index: StoredIndex, stream: GwStream, row: any, time: number): void {
  if (stream === 'funding') {
    const amount = asNum(row?.fundingFee);
    if (!Number.isFinite(amount) || amount === 0) return;
    bump(index, 'f', time, amount);
    const abs = Math.abs(amount);
    if (!index.xf || abs > Math.abs(index.xf.v)) index.xf = { v: amount, t: time };
    return;
  }
  if (stream === 'orders-spot' || stream === 'orders-perps') {
    bump(index, 'ord', time, 1);
    return;
  }
  const price = asNum(row?.price);
  const qty = asNum(row?.quantity);
  if (Number.isFinite(price) && Number.isFinite(qty)) {
    const notional = Math.abs(price * qty);
    if (notional > 0) bump(index, 'vol', time, notional);
  }
  const fee = asNum(row?.fee);
  if (Number.isFinite(fee) && fee > 0) {
    bump(index, 'fee', time, fee);
    if (!index.xe || fee > index.xe.v) index.xe = { v: fee, t: time };
  }
  bump(index, 'fil', time, 1);
}

export interface FoldResult {
  index: StoredIndex;
  stop: boolean;
  /** Next gateway `endTime`, or null when this pass should stop. */
  nextEndTime: number | null;
}

/**
 * Fold one gateway page into aggregates.
 *
 * `pass: 'older'` walks backward. `endTime` is what this page was requested
 * with (null = the present). Rows at or after that time are the inclusive
 * overlap and are skipped.
 * `pass: 'newer'` keeps only rows strictly after `c.h` and stops when a row
 * at or before `c.h` shows up. It does not move `b` or `x`.
 * Call `newer` only once `h > 0`. The first walk is `older`.
 */
export function foldPage(
  prev: StoredIndex,
  stream: GwStream,
  rows: readonly any[],
  opts: { limit: number; pass: Pass; endTime: number | null },
): FoldResult {
  const index = clone(prev);
  const field = CURSOR_FIELD[stream];
  const cursor = index.c[field];
  const headBefore = cursor.h;
  const times: number[] = [];
  let maxKept = 0;

  for (const row of rows) {
    const t = rowTime(stream, row);
    if (!Number.isFinite(t) || t <= 0) continue;
    times.push(t);
    const overlap = opts.endTime !== null && t >= opts.endTime;
    if (overlap) continue;
    if (opts.pass === 'newer' && !(t > headBefore)) continue;
    const before = index.t.fil + index.t.ord + index.t.f;
    absorb(index, stream, row, t);
    const after = index.t.fil + index.t.ord + index.t.f;
    // A zero funding row is deliberately not folded; don't treat it as kept.
    if (stream === 'funding' ? after !== before : true) {
      if (t > maxKept) maxKept = t;
    }
  }

  const oldest = times.length ? Math.min(...times) : null;
  const short = rows.length < opts.limit;
  let stop = false;
  let nextEndTime: number | null = null;

  if (opts.pass === 'newer') {
    if (maxKept > cursor.h) cursor.h = maxKept;
    const hit = headBefore > 0 && times.some((t) => t <= headBefore);
    if (hit || short || oldest === null) stop = true;
    else nextEndTime = oldest;
  } else {
    if (maxKept > cursor.h) cursor.h = maxKept;
    const progressed = oldest !== null && (opts.endTime === null || oldest < opts.endTime);
    if (progressed && oldest !== null && (cursor.b === null || oldest < cursor.b)) cursor.b = oldest;
    if (!progressed || short || oldest === null) {
      cursor.x = true;
      stop = true;
    } else {
      nextEndTime = oldest;
    }
  }

  capBuckets(index);
  index.u = Date.now();
  return { index, stop, nextEndTime };
}

export interface FlowRow {
  time: number;
  /** `mark` moves the cursor only (failed, refunded). Open rows are omitted by the caller. */
  kind: 'deposit' | 'withdraw' | 'mark';
  amount: number;
}

export interface FlowFold {
  index: StoredIndex;
  stop: boolean;
  nextOffset: number;
}

/**
 * Fold one ledger page. `rawCount` is the page size before filtering, which
 * is what the offset cursor advances by. `newer` does not move `o` / `b` / `x`.
 */
export function foldFlows(
  prev: StoredIndex,
  rows: readonly FlowRow[],
  rawCount: number,
  opts: { limit: number; pass: Pass; offset: number },
): FlowFold {
  const index = clone(prev);
  const cursor = index.c.l;
  const headBefore = cursor.h;
  const times: number[] = [];
  let maxKept = 0;
  let minKept = Infinity;

  for (const row of rows) {
    const t = row.time;
    if (!Number.isFinite(t) || t <= 0) continue;
    times.push(t);
    if (opts.pass === 'older' && cursor.b !== null && t >= cursor.b) continue;
    if (opts.pass === 'newer' && !(t > headBefore)) continue;
    if (row.kind === 'deposit' && row.amount > 0) bump(index, 'dep', t, row.amount);
    else if (row.kind === 'withdraw' && row.amount > 0) bump(index, 'wd', t, row.amount);
    if (t > maxKept) maxKept = t;
    if (t < minKept) minKept = t;
  }

  const short = rawCount < opts.limit;
  let stop = false;
  const nextOffset = opts.offset + Math.max(0, rawCount);

  if (opts.pass === 'newer') {
    if (maxKept > cursor.h) cursor.h = maxKept;
    const hit = headBefore > 0 && times.some((t) => t <= headBefore);
    stop = hit || short || rawCount === 0;
  } else {
    if (maxKept > cursor.h) cursor.h = maxKept;
    const progressed = minKept < Infinity && (cursor.b === null || minKept < cursor.b);
    if (progressed) cursor.b = minKept;
    cursor.o = nextOffset;
    if (!progressed || short || rawCount === 0) {
      cursor.x = true;
      stop = true;
    }
  }

  capBuckets(index);
  index.u = Date.now();
  return { index, stop, nextOffset };
}
