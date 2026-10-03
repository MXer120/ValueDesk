/**
 * Hyperliquid leaderboard: download, columnar snapshot, ranking, rank change.
 *
 * SOURCE. https://stats-data.hyperliquid.xyz/Mainnet/leaderboard, a public S3
 * file behind CloudFront. It is about 39 MB of pretty-printed JSON with about
 * 47k rows, regenerated hourly, served without compression. Rows aggregate a
 * master account with its sub-accounts. Research: docs/research/02 section 2.1.
 *
 * FETCH POLICY. At most one check per 60 s, and each check is a conditional
 * GET (If-None-Match / If-Modified-Since), so an unchanged file costs a 304
 * with no body instead of 39 MB. Verified: CloudFront answers 304 to both.
 * Callers never wait for a revalidation once a snapshot exists
 * (stale-while-revalidate); only the very first call waits for the download.
 * Concurrent callers share one in-flight download.
 *
 * MEMORY. The download is read as a stream and parsed ROW BY ROW (parseLeaderboardStream): the
 * 39 MB text and its 47k-object tree never exist at once. Parsed whole, the file needed more than the
 * 368 MB heap the API gets inside its unit's MemoryMax, and the process died on it (live, 2026-10-03:
 * five out-of-memory crashes, each the first Explore/Cohorts load after a restart or a new file).
 * What stays is columnar:
 * one address array plus 13 Float64Arrays (account value plus pnl, roi and
 * volume for 4 windows), about 5 MB per snapshot. Sort orders and rank arrays
 * are computed lazily per (sort, window) and cached on the snapshot.
 *
 * RANK CHANGE. The previous snapshot (the previous hourly file) is kept, and
 * rankChange = previous rank - current rank in the same ordering, so positive
 * means "moved up". It is null until a second distinct file has been seen by
 * this process (so for up to an hour after a restart), and for addresses that
 * were not on the previous file.
 */
import { envOf } from '../env.js';
import { labelMatches } from '../labels.js';
import type { LeaderboardPage, LeaderboardQuery, LeaderboardSort, TraderRow, Window } from '../types.js';
import { WINDOWS } from '../types.js';
import type { HlLeaderboardRaw, HlLeaderboardRowRaw, HlWindowName } from './raw.js';
import { normAddress, num, WINDOW_OF } from './mappers.js';

export const HL_LEADERBOARD_URL = (
  envOf('VALUESCAN_HL_LEADERBOARD_URL')?.trim() || 'https://stats-data.hyperliquid.xyz/Mainnet/leaderboard'
).replace(/\/+$/, '');

export const HL_LEADERBOARD_SOURCE = 'Hyperliquid leaderboard';

/** Minimum gap between two checks of the upstream file. */
export const LEADERBOARD_REVALIDATE_MS = 60_000;
/** After a failed check, try again sooner than a full interval but not in a loop. */
const RETRY_AFTER_FAILURE_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;

/**
 * ROI ranking only counts accounts holding at least this much. HL's file
 * lists accounts by volume too, so ROI on a near-empty account is noise:
 * live on 2026-09-25 the all-time ROI top 3 included an account worth $1
 * at about +15 million percent. Those rows stay in the list (and in
 * `total`), ranked after every account above the floor. HL's own roi values
 * are passed through unchanged.
 */
export const ROI_MIN_ACCOUNT_USD = 10_000;

type Metric = 'pnl' | 'roi' | 'volume';
type ColKey = `${Metric}:${Window}`;
const METRICS: readonly Metric[] = ['pnl', 'roi', 'volume'];

/** The parsed file, before it becomes a snapshot. Pure data, used by tests. */
export interface ParsedLeaderboard {
  addresses: string[];
  labels: Array<string | null>;
  accountValue: Float64Array;
  cols: Record<ColKey, Float64Array>;
}

const nanOr = (v: unknown): number => num(v) ?? Number.NaN;
const nullIfNaN = (v: number | undefined): number | null => (v === undefined || Number.isNaN(v) ? null : v);

/** Rows to columns, one row at a time. Rows without a valid address are dropped; duplicates keep the first. */
class LeaderboardBuilder {
  private readonly addresses: string[] = [];
  private readonly labels: Array<string | null> = [];
  private readonly av: number[] = [];
  private readonly cols = {} as Record<ColKey, number[]>;
  private readonly seen = new Set<string>();

  constructor() {
    for (const m of METRICS) for (const w of WINDOWS) this.cols[`${m}:${w}`] = [];
  }

  add(r: HlLeaderboardRowRaw | null | undefined): void {
    const address = normAddress(r?.ethAddress);
    if (!r || !address || this.seen.has(address)) return;
    this.seen.add(address);
    this.addresses.push(address);
    const label = typeof r.displayName === 'string' && r.displayName.trim() ? r.displayName.trim() : null;
    this.labels.push(label);
    this.av.push(nanOr(r.accountValue));
    const perf = new Map<string, { pnl: string; roi: string; vlm: string }>();
    for (const wp of Array.isArray(r.windowPerformances) ? r.windowPerformances : []) {
      if (Array.isArray(wp) && typeof wp[0] === 'string' && wp[1]) perf.set(wp[0], wp[1]);
    }
    for (const [hl, w] of Object.entries(WINDOW_OF) as Array<[HlWindowName, Window]>) {
      const p = perf.get(hl);
      this.cols[`pnl:${w}`].push(nanOr(p?.pnl));
      this.cols[`roi:${w}`].push(nanOr(p?.roi));
      this.cols[`volume:${w}`].push(nanOr(p?.vlm));
    }
  }

  finish(): ParsedLeaderboard {
    const typed = {} as Record<ColKey, Float64Array>;
    for (const k of Object.keys(this.cols) as ColKey[]) typed[k] = Float64Array.from(this.cols[k]);
    return { addresses: this.addresses, labels: this.labels, accountValue: Float64Array.from(this.av), cols: typed };
  }
}

/** Raw file to columns. Rows without a valid address are dropped; duplicates keep the first. */
export function parseLeaderboard(raw: HlLeaderboardRaw): ParsedLeaderboard {
  const b = new LeaderboardBuilder();
  for (const r of Array.isArray(raw?.leaderboardRows) ? raw.leaderboardRows : []) b.add(r);
  return b.finish();
}

/**
 * The file as it arrives, to columns - without ever holding it whole. The text is scanned once for the
 * objects directly inside the array under the root object (`{"leaderboardRows":[ {row}, {row}, ... ]}`);
 * each row is parsed on its own and handed to the builder, then dropped. Only the row being read is
 * kept as text. A file that ends early (a cut download) is an error, never a short leaderboard.
 */
export async function parseLeaderboardStream(body: ReadableStream<Uint8Array> | null): Promise<ParsedLeaderboard> {
  if (!body) throw new Error('leaderboard: the answer has no body');
  const b = new LeaderboardBuilder();
  const decoder = new TextDecoder();
  const reader = body.getReader();
  // The containers we are inside ('{' or '['), whether we are in a string, and the text of the row being read.
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  let carry = '';
  let rowStart = -1;
  let rows = 0;
  const scan = (text: string): void => {
    const s = carry + text;
    for (let i = carry.length; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (inString) {
        if (escaped) escaped = false;
        else if (c === 92 /* \\ */) escaped = true;
        else if (c === 34 /* " */) inString = false;
        continue;
      }
      if (c === 34) inString = true;
      else if (c === 123 /* { */ || c === 91 /* [ */) {
        // A row: an object opened directly inside the array that sits inside the root object.
        if (c === 123 && stack.length === 2 && stack[0] === '{' && stack[1] === '[') rowStart = i;
        stack.push(c === 123 ? '{' : '[');
      } else if (c === 125 /* } */ || c === 93 /* ] */) {
        if (!stack.length) throw new Error('leaderboard: the file is not valid JSON (unbalanced)');
        stack.pop();
        if (c === 125 && stack.length === 2 && rowStart >= 0) {
          b.add(JSON.parse(s.slice(rowStart, i + 1)) as HlLeaderboardRowRaw);
          rows += 1;
          rowStart = -1;
        }
      }
    }
    if (rowStart >= 0) {
      carry = s.slice(rowStart);
      rowStart = 0;
    } else carry = '';
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    scan(decoder.decode(value, { stream: true }));
  }
  scan(decoder.decode());
  if (stack.length || inString) throw new Error(`leaderboard: the file ended early (after ${rows} rows)`);
  return b.finish();
}

const orderKey = (sort: LeaderboardSort, window: Window): string => (sort === 'accountValue' ? 'accountValue' : `${sort}:${window}`);

export class LbSnapshot {
  readonly n: number;
  private readonly index = new Map<string, number>();
  private readonly orders = new Map<string, Int32Array>();
  private readonly ranks = new Map<string, Int32Array>();

  constructor(
    readonly data: ParsedLeaderboard,
    /** Upstream Last-Modified (ms), 0 if unknown. */
    readonly lastModified: number,
    readonly etag: string | null,
    readonly fetchedAt: number,
  ) {
    this.n = data.addresses.length;
    data.addresses.forEach((a, i) => this.index.set(a, i));
  }

  /** When the numbers were produced: upstream Last-Modified, else our fetch time. */
  get updatedAt(): number {
    return this.lastModified || this.fetchedAt;
  }

  private column(sort: LeaderboardSort, window: Window): Float64Array {
    if (sort === 'accountValue') return this.data.accountValue;
    return this.data.cols[`${sort}:${window}`];
  }

  /**
   * Row indices, best first. Missing values sort last; ties keep file order.
   * For sort=roi, rows under ROI_MIN_ACCOUNT_USD also sort last (see there).
   */
  order(sort: LeaderboardSort, window: Window): Int32Array {
    const key = orderKey(sort, window);
    let o = this.orders.get(key);
    if (!o) {
      const col = this.column(sort, window);
      const av = this.data.accountValue;
      const value = (i: number): number =>
        sort === 'roi' && !(av[i]! >= ROI_MIN_ACCOUNT_USD) ? Number.NaN : col[i]!;
      const idx = Array.from({ length: this.n }, (_, i) => i);
      idx.sort((a, b) => {
        const va = value(a);
        const vb = value(b);
        const na = Number.isNaN(va);
        const nb = Number.isNaN(vb);
        if (na !== nb) return na ? 1 : -1;
        return (na ? 0 : vb - va) || a - b;
      });
      o = Int32Array.from(idx);
      this.orders.set(key, o);
    }
    return o;
  }

  /** 1-based rank per row index in the given ordering. */
  private rankArray(sort: LeaderboardSort, window: Window): Int32Array {
    const key = orderKey(sort, window);
    let r = this.ranks.get(key);
    if (!r) {
      const o = this.order(sort, window);
      r = new Int32Array(this.n);
      for (let k = 0; k < o.length; k++) r[o[k]!] = k + 1;
      this.ranks.set(key, r);
    }
    return r;
  }

  indexOf(address: string): number | undefined {
    return this.index.get(address.toLowerCase());
  }

  rankOfIndex(i: number, sort: LeaderboardSort, window: Window): number {
    return this.rankArray(sort, window)[i] ?? 0;
  }

  rankOf(address: string, sort: LeaderboardSort, window: Window): number | null {
    const i = this.indexOf(address);
    return i === undefined ? null : this.rankOfIndex(i, sort, window);
  }

  /** The row at index i, without rank fields. */
  row(i: number): TraderRow {
    const d = this.data;
    const pnl: TraderRow['pnl'] = {};
    const roi: TraderRow['roi'] = {};
    const volume: TraderRow['volume'] = {};
    for (const w of WINDOWS) {
      pnl[w] = nullIfNaN(d.cols[`pnl:${w}`][i]);
      roi[w] = nullIfNaN(d.cols[`roi:${w}`][i]);
      volume[w] = nullIfNaN(d.cols[`volume:${w}`][i]);
    }
    return {
      venue: 'hyperliquid',
      address: d.addresses[i]!,
      label: d.labels[i] ?? null,
      accountValue: nullIfNaN(d.accountValue[i]),
      pnl,
      roi,
      volume,
    };
  }

  /** Row with rank and rankChange for one ordering, or null if the address is not listed. */
  rowFor(address: string, sort: LeaderboardSort, window: Window, prev: LbSnapshot | null): TraderRow | null {
    const i = this.indexOf(address);
    if (i === undefined) return null;
    return withRank(this.row(i), this.rankOfIndex(i, sort, window), sort, window, prev);
  }
}

function withRank(row: TraderRow, rank: number, sort: LeaderboardSort, window: Window, prev: LbSnapshot | null): TraderRow {
  row.rank = rank;
  const before = prev ? prev.rankOf(row.address, sort, window) : null;
  row.rankChange = before === null ? null : before - rank;
  return row;
}

/**
 * Case-insensitive search: an address prefix ("0x8c62", or "8c62" without the
 * 0x) or a substring of the display name.
 */
export function matchesQuery(address: string, label: string | null, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  if (address.startsWith(needle)) return true;
  if (/^[0-9a-f]+$/.test(needle) && address.startsWith(`0x${needle}`)) return true;
  // A hidden name (source off, or the address opted out) never matches (valuescan/labels.ts).
  return labelMatches(address, label, needle);
}

/**
 * One page of the leaderboard. `rank` is the trader's position in the FULL
 * ordering even when `q` filters the list, so a search result still says
 * "#1,204 by 30d PnL". `total` counts the rows that match `q`.
 */
export function queryLeaderboard(cur: LbSnapshot, prev: LbSnapshot | null, q: LeaderboardQuery): LeaderboardPage {
  const order = cur.order(q.sort, q.window);
  const limit = Math.max(0, Math.trunc(q.limit));
  const offset = Math.max(0, Math.trunc(q.offset));
  const rows: TraderRow[] = [];
  let total: number;

  if (q.side === 'worst') {
    const pnlOrder = cur.order('pnl', q.window);
    const picked: number[] = [];
    for (let k = pnlOrder.length - 1; k >= 0 && picked.length < offset + limit; k--) {
      const i = pnlOrder[k]!;
      const v = cur.data.cols[`pnl:${q.window}`][i];
      if (!(typeof v === 'number' && Number.isFinite(v))) continue;
      picked.push(i);
    }
    total = picked.length;
    for (const i of picked.slice(offset, offset + limit)) {
      rows.push(withRank(cur.row(i), picked.indexOf(i) + 1, 'pnl', q.window, prev));
    }
    return { rows, total, updatedAt: cur.updatedAt, source: `${HL_LEADERBOARD_SOURCE} (lowest PnL)` };
  }

  if (q.q && q.q.trim()) {
    const hits: number[] = [];
    for (let k = 0; k < order.length; k++) {
      const i = order[k]!;
      if (matchesQuery(cur.data.addresses[i]!, cur.data.labels[i] ?? null, q.q)) hits.push(i);
    }
    total = hits.length;
    for (const i of hits.slice(offset, offset + limit)) {
      rows.push(withRank(cur.row(i), cur.rankOfIndex(i, q.sort, q.window), q.sort, q.window, prev));
    }
  } else {
    total = order.length;
    for (let k = offset; k < Math.min(total, offset + limit); k++) {
      rows.push(withRank(cur.row(order[k]!), k + 1, q.sort, q.window, prev));
    }
  }
  return { rows, total, updatedAt: cur.updatedAt, source: HL_LEADERBOARD_SOURCE };
}

// --- store ---------------------------------------------------------------------

export class HlLeaderboardStore {
  private cur: LbSnapshot | null = null;
  private prev: LbSnapshot | null = null;
  /** When the next upstream check may happen. */
  private nextCheckAt = 0;
  private refreshing: Promise<void> | null = null;
  lastError: string | null = null;

  constructor(
    private readonly url: string = HL_LEADERBOARD_URL,
    private readonly fetchImpl: typeof fetch = (...a) => fetch(...a),
    private readonly now: () => number = Date.now,
  ) {}

  /** The current snapshot. Waits only when there is none yet. */
  async snapshot(): Promise<LbSnapshot> {
    if (!this.cur) {
      await this.refresh(true);
      if (!this.cur) throw new Error(`Hyperliquid leaderboard unavailable${this.lastError ? `: ${this.lastError}` : ''}`);
      return this.cur;
    }
    if (this.now() >= this.nextCheckAt) void this.refresh(false).catch(() => {});
    return this.cur;
  }

  /** The current snapshot if one is loaded, without any I/O. */
  peek(): LbSnapshot | null {
    return this.cur;
  }

  previous(): LbSnapshot | null {
    return this.prev;
  }

  /** Check upstream once (shared by concurrent callers). `force` ignores the interval. */
  refresh(force = false): Promise<void> {
    if (this.refreshing) return this.refreshing;
    if (!force && this.now() < this.nextCheckAt) return Promise.resolve();
    this.refreshing = this.check()
      .then(() => {
        this.lastError = null;
        this.nextCheckAt = this.now() + LEADERBOARD_REVALIDATE_MS;
      })
      .catch((e: unknown) => {
        this.lastError = e instanceof Error ? e.message : String(e);
        this.nextCheckAt = this.now() + RETRY_AFTER_FAILURE_MS;
        throw e;
      })
      .finally(() => {
        this.refreshing = null;
      });
    return this.refreshing;
  }

  private async check(): Promise<void> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.cur?.etag) headers['If-None-Match'] = this.cur.etag;
    if (this.cur?.lastModified) headers['If-Modified-Since'] = new Date(this.cur.lastModified).toUTCString();

    const res = await this.fetchImpl(this.url, { headers, signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (res.status === 304 && this.cur) return;
    if (!res.ok) throw new Error(`leaderboard HTTP ${res.status}`);

    const etag = res.headers.get('etag');
    const lm = Date.parse(res.headers.get('last-modified') ?? '');
    const lastModified = Number.isFinite(lm) ? lm : 0;
    // Same file again (a CDN that ignored the conditional headers): keep the
    // current snapshot, so rank changes stay relative to the real previous file.
    if (this.cur && ((etag && etag === this.cur.etag) || (lastModified && lastModified === this.cur.lastModified))) {
      await res.body?.cancel().catch(() => {});
      return;
    }

    const parsed = await parseLeaderboardStream(res.body);
    if (!parsed.addresses.length) throw new Error('leaderboard file had no rows');
    const next = new LbSnapshot(parsed, lastModified, etag, this.now());
    if (this.cur) this.prev = this.cur;
    this.cur = next;
  }
}
