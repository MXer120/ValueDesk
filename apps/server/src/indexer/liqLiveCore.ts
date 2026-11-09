/**
 * The live heatmap's engine and everything that reads its positions, in one piece that runs on either thread
 * (liqLiveThread.ts): the engine (valuedesk/liquidations/live.ts), the feed to the API (liqFeed.ts), the beat that
 * prices what changed and sends it, and the computing half of the 15-minute liquidation step (liq_now rows, the history
 * snapshot and fine bands, the change log's diff). The writes stay with the caller (store.ts), which is the indexer.
 *
 * Why it moved (2026-11-08): on the indexer's one thread, 99.7% busy, the beat took 29.5% of a 60 s profile (reprice
 * 19%, work 13.7%) and the heatmap stood still through every SQLite stall (10-30 s, every ~30 s that night); the step's
 * diff and layers waited in the same queue and one step took 54 minutes. Here the same code runs on a worker that owns
 * the engine and the feed socket, fed by the indexer with the books' changes (MirrorSource), so deltas reach the API
 * while the indexer's thread is held. VALUESCAN_LIQ_LIVE_THREAD=0 and the tests run it on the indexer's thread as
 * before, reading the books in place (no copy).
 */
import { deflateRawSync } from 'node:zlib';
import { VENUES, type Venue } from '../valuedesk/types.js';
import type { Tiers } from '../valuedesk/liquidations/math.js';
import { LiqLive, type LiveAccount, type LivePosition } from '../valuedesk/liquidations/live.js';
import { fineBandWidth, fineBands, fineSnapOf, snapOfNow } from '../valuedesk/liquidations/levels.js';
import { LiqFeedServer, LIQ_FEED_PORT } from './liqFeed.js';
import type { LiqLogExtra } from './store.js';

/** A position's level is logged again once it moved this much (relative), or its USD this much: the history draws 0.25% cells. */
export const LIQ_LOG_MOVE = 0.0005;
export const USD_LOG_MOVE = 0.002;
/** A step's computing gives the thread back this often (the beat and the feed go on between slices). */
const STEP_SLICE_MS = 30;
/** Every coin whole this often: the deltas leave out moves under 1% (live.ts SEND_MOVE), this puts the API's copy back to exact. */
const WHOLE_EVERY_MS = 60_000;
/** A tick frame at least this often, deltas or not (the API's `live` wants a frame within 10 s). */
const TICK_EVERY_MS = 1_000;
/** A refused feed port is tried again this often (a restarted thread whose old socket is not closed yet). */
const FEED_RETRY_MS = 5_000;

/** What the engine reads, from the indexer's books in place (inline) or from the heatmap thread's copy (MirrorSource). */
export interface LiveSource {
  account: (venue: Venue, address: string, key: string) => LiveAccount | undefined;
  priceOf: (venue: Venue, symbol: string) => number | null;
  tiersOf: (venue: Venue, symbol: string) => Tiers | null;
  priceOfCoin: (coin: string) => number | null;
  wanted: (coin: string) => boolean;
  /** The change log's extra fields for a position (store LiqLogExtra), from the account's book now. */
  extra: (venue: Venue, address: string, coin: string) => LiqLogExtra;
}

/** A position as logExtraOf reads it (cohortTracker.ts Book.pos values). */
export interface ExtraPos { szi: number; entry: number | null; iso?: number | null; lev?: number | null }

/**
 * What the change log keeps of a position besides its level (store LiqLogExtra), from the
 * account's book now: its symbol (the largest of the coin's, as the level keeps), signed size,
 * entry, the mark, isolated or cross and the leverage, the account's equity and cross cash, and
 * when the book was read.
 */
export function logExtraOf(
  acct: { equity: number | null; cash: number | null; at: number },
  positions: Iterable<[string, ExtraPos]>,
  coinOf: (symbol: string) => string,
  coin: string,
  markOf: (symbol: string) => number | null,
): LiqLogExtra {
  let sym: string | null = null;
  let p: ExtraPos | null = null;
  for (const [s, q] of positions) if (q.szi && coinOf(s) === coin && (p === null || Math.abs(q.szi) > Math.abs(p.szi))) { sym = s; p = q; }
  const base = { eq: acct.equity, cash: acct.cash, readAt: acct.at };
  if (sym === null || !p) return base;
  // LiqPos: `iso` present (a number, or null when not known) is isolated; absent is cross.
  return { ...base, sym, sz: p.szi, entry: p.entry, mark: markOf(sym), iso: p.iso !== undefined, lev: p.lev ?? null };
}

/** The change log's last logged state, as store.liqCur gives it. */
export interface LevelCurRow { aid: number; coin: string; venue: number; side: number; liq: number; usd: number }

export type ChangedRow = { aid: number | string; coin: string; venue: number; side: number; liq: number; usd: number; address: string; v: Venue } & LiqLogExtra;
export type ClosedRow = { aid: number; coin: string; venue: number; mark: number | null };

/** A liquidation pass asked of the engine (cohortTracker.ts recordLiq). */
export interface StepAsk {
  /** The pass's time (liq_now's `at`). */
  now: number;
  /** The 15-minute step to compute too, or null (liq_now only). */
  t: number | null;
  /** The coins kept (SoDEX's list). */
  coins: string[];
  /** Per coin, SoDEX's price tick (the history's finest step). */
  ticks: Map<string, number>;
  /** Every open position logged in full this step (LIQ_LOG_FULL_META not set yet). */
  full: boolean;
  /** The change log's state, read from the store once per engine (needsLevelInit). */
  init?: { cur: LevelCurRow[]; addrs: Map<string, number> };
}

export interface StepOut {
  /** False until every book is priced once since the start: the last rows stand. */
  ready: boolean;
  /** liq_now rows, deflated. */
  now?: Array<[string, Uint8Array]>;
  step?: {
    hist: Array<[string, string]>;
    fine: Array<[string, number, number, Uint8Array]>;
    /** The change log's rows, or null when nothing changed; written, then `commit` with the new address ids. */
    log: { fresh: string[]; changed: ChangedRow[]; closed: ClosedRow[] } | null;
    positionsMs: number;
    layersMs: number;
    diffMs: number;
  };
}

export interface LiveStatus {
  ready: boolean;
  pending: number;
  ms: number;
  readers: number;
  error: string | null;
  /** Positions open in the change log's state (null before the first step). */
  levels: number | null;
}

/** An own-buffer copy (a Buffer from zlib may be a view of a larger one, all of which a structured clone would copy). */
const own = (b: Uint8Array): Uint8Array => new Uint8Array(b);

export class LiveCore {
  readonly live: LiqLive;
  readonly feed: LiqFeedServer;
  ready = false;
  /** Set when every book the indexer holds has been handed in once (the thread: after the first resend; inline: from the start). */
  primed: boolean;
  private barrier: number | null = null;
  private wholeAt = 0;
  private sentAt = 0;
  private feedTriedAt = 0;
  ms = 0;
  /** The change log's last logged state per position (aid|coin|venue), and the address ids; null until the first step. */
  private levelState: Map<string, { side: number; liq: number; usd: number }> | null = null;
  private levelAddr: Map<string, number> | null = null;
  /** The last step's diff, until it is written (commit) or replaced by the next step's. */
  private pendingLog: { changed: ChangedRow[]; closed: ClosedRow[] } | null = null;

  constructor(private readonly src: LiveSource, o: {
    crossed?: (venue: Venue, address: string, usd: number) => void;
    port?: number;
    primed?: boolean;
    now?: () => number;
  } = {}) {
    this.primed = o.primed ?? true;
    this.now = o.now ?? Date.now;
    this.live = new LiqLive({
      account: src.account,
      priceOf: src.priceOf,
      tiersOf: src.tiersOf,
      priceOfCoin: src.priceOfCoin,
      wanted: src.wanted,
      crossed: o.crossed,
    });
    this.feed = new LiqFeedServer(() => this.live.resendAll(), o.port ?? LIQ_FEED_PORT);
  }

  private readonly now: () => number;

  start(): void {
    this.feedTriedAt = Date.now();
    this.feed.start();
  }

  stop(): void {
    this.feed.stop();
  }

  /**
   * One beat (the indexer's, inline): price up to `slice` changed accounts within `budgetMs`, then send what changed
   * (and a tick frame at least every second). Returns how many accounts still wait.
   */
  tick(slice: number, budgetMs: number): number {
    const t0 = Date.now();
    const left = this.work(slice, budgetMs);
    this.send();
    this.ms = Date.now() - t0;
    return left;
  }

  /** Price up to `slice` changed accounts within `budgetMs`; returns how many still wait. */
  work(slice: number, budgetMs: number): number {
    // Ready once the books waiting at the first beat (every book: the start touches them all) are
    // priced. Waiting for nothing to be left never came on a busy day: prints touch books faster
    // than a beat's budget prices them, and from 2026-10-27 23:16 UTC no liq_now row was written
    // for 16 hours (the heatmap answered from that one).
    if (this.barrier === null && this.primed) this.barrier = this.live.processed + this.live.pending;
    const left = this.live.work(slice, budgetMs);
    if (!this.ready && this.barrier !== null && (!left || this.live.processed >= this.barrier)) this.ready = true;
    return left;
  }

  /** What changed since the last send, to the feed's readers; a tick frame at least every second regardless. */
  send(): void {
    const t0 = Date.now();
    if (!this.feed.listening && t0 - this.feedTriedAt >= FEED_RETRY_MS) this.start();
    if (t0 - this.wholeAt >= WHOLE_EVERY_MS) { this.wholeAt = t0; this.live.resendAll(); }
    const deltas = this.live.flush();
    // 100 ms of slack: the indexer's beat is a 1 s interval, and one a little early must still send its frame.
    if (deltas.length || t0 - this.sentAt >= TICK_EVERY_MS - 100) {
      this.feed.send(deltas, { at: this.now(), ready: this.ready });
      this.sentAt = t0;
    }
  }

  status(): LiveStatus {
    return { ready: this.ready, pending: this.live.pending, ms: this.ms, readers: this.feed.readers, error: this.feed.lastError, levels: this.levelState?.size ?? null };
  }

  get needsLevelInit(): boolean {
    return this.levelState === null;
  }

  /**
   * A liquidation pass: every coin's rows (liq_now) and, at a 15-minute step, its snapshot, fine bands and the change
   * log's diff - everything that needs the live positions, computed here; the caller writes it. `breathe` gives the
   * thread back between slices.
   */
  async step(ask: StepAsk, breathe: () => Promise<void>): Promise<StepOut> {
    // Until every book is priced into the engine once (seconds after a start), the last rows stand.
    if (!this.ready) return { ready: false };
    this.pendingLog = null;
    if (ask.init) {
      this.levelAddr = ask.init.addrs;
      this.levelState = new Map();
      for (const r of ask.init.cur) this.levelState.set(`${r.aid}|${r.coin}|${r.venue}`, { side: r.side, liq: r.liq, usd: r.usd });
    }
    const rows = this.live.rows();
    let sliceAt = Date.now();
    const pause = async () => {
      if (Date.now() - sliceAt <= STEP_SLICE_MS) return;
      await breathe();
      sliceAt = Date.now();
    };
    const now: Array<[string, Uint8Array]> = [];
    for (const [coin, row] of rows) {
      now.push([coin, own(deflateRawSync(JSON.stringify(row)))]);
      await pause();
    }
    if (ask.t === null) return { ready: true, now };
    const keep = new Set(ask.coins);
    // One instant of every position, copied here: the slices below all read this same moment.
    const stepAt = Date.now();
    const byCoin = this.live.positionsByCoin(0, NO_WALLETS);
    const positionsMs = Date.now() - stepAt;
    const hist: Array<[string, string]> = [];
    const fine: Array<[string, number, number, Uint8Array]> = [];
    for (const coin of keep) {
      const row = rows.get(coin);
      if (!row) continue;
      const snap = snapOfNow(row);
      hist.push([coin, JSON.stringify(snap)]);
      // Its fine layers over the whole range, down to the coin's tick, in price bands (levels.ts fineBands).
      const f = fineSnapOf(row.p, snap.st, byCoin.get(coin) ?? [], ask.ticks.get(coin) ?? 0);
      if (f) for (const b of fineBands(f, fineBandWidth(row.p))) fine.push([coin, b.lo, b.hi, own(deflateRawSync(JSON.stringify(b.f)))]);
      await pause();
    }
    const layersAt = Date.now();
    const log = this.levelDiff(keep, byCoin, ask.full);
    this.pendingLog = log ? { changed: log.changed, closed: log.closed } : null;
    return { ready: true, now, step: { hist, fine, log, positionsMs, layersMs: layersAt - stepAt - positionsMs, diffMs: Date.now() - layersAt } };
  }

  /**
   * The change log against its last logged state (store liq_cur, read once at the first step): a row only when a
   * position opens, flips, closes, or its level moves past LIQ_LOG_MOVE or its size past USD_LOG_MOVE since its last
   * row - the history draws 0.25% cells, the level is the live engine's 0.02% bucket, so nothing it shows is lost. A
   * restart neither repeats every position nor misses what closed while it was down. The state moves only in `commit`,
   * once all of it is written: a step that fails is written again from the same comparison.
   */
  private levelDiff(coins: ReadonlySet<string>, byCoin: Map<string, LivePosition[]>, full: boolean): { fresh: string[]; changed: ChangedRow[]; closed: ClosedRow[] } | null {
    const state = this.levelState;
    const addr = this.levelAddr;
    if (!state || !addr) throw new Error('the change log state was not handed in (StepAsk.init)');
    // One state per address, coin and venue: two symbols of one coin on one venue keep the larger.
    const now = new Map<string, ChangedRow>();
    const fresh = new Set<string>();
    for (const coin of coins) {
      for (const x of byCoin.get(coin) ?? []) {
        const vi = VENUES.indexOf(x.venue);
        let id: number | string | undefined = addr.get(x.address);
        if (id === undefined) { fresh.add(x.address); id = x.address; }
        const key = `${id}|${coin}|${vi}`;
        const usd = Math.round(x.usd);
        const prev = now.get(key);
        if (prev && prev.usd >= usd) continue;
        now.set(key, { aid: id, coin, venue: vi, side: x.long ? 1 : -1, liq: +x.liq.toPrecision(8), usd, address: x.address, v: x.venue });
      }
    }
    // `full` once: every open position written in full, so each carries the fields the log keeps since 2026-10-29
    // (size, entry, margin, account) - not only the ones that changed since. About 170k rows, one step.
    const changed: ChangedRow[] = [];
    for (const [key, x] of now) {
      const was = state.get(key);
      if (!full && was && was.side === x.side && Math.abs(x.liq - was.liq) <= LIQ_LOG_MOVE * was.liq && Math.abs(x.usd - was.usd) <= USD_LOG_MOVE * Math.max(1, was.usd)) continue;
      // The rest of the position as it stands, from its book (only for the rows written).
      changed.push(Object.assign(x, this.src.extra(x.v, x.address, x.coin)));
    }
    const closed: ClosedRow[] = [];
    for (const key of state.keys()) {
      if (now.has(key)) continue;
      const [aid, coin, venue] = key.split('|');
      if (!coins.has(coin!)) continue;
      closed.push({ aid: Number(aid), coin: coin!, venue: Number(venue), mark: this.src.priceOfCoin(coin!) });
    }
    if (!changed.length && !closed.length) return null;
    return { fresh: [...fresh], changed, closed };
  }

  /** The last step's change log is written: its state moves, with the ids the new addresses were given. */
  commit(ids: ReadonlyMap<string, number>): void {
    const log = this.pendingLog;
    this.pendingLog = null;
    const state = this.levelState;
    const addr = this.levelAddr;
    if (!log || !state || !addr) return;
    for (const [a, id] of ids) addr.set(a, id);
    for (const x of log.changed) {
      const aid = typeof x.aid === 'number' ? x.aid : ids.get(x.aid)!;
      state.set(`${aid}|${x.coin}|${x.venue}`, { side: x.side, liq: x.liq, usd: x.usd });
    }
    for (const c of log.closed) state.delete(`${c.aid}|${c.coin}|${c.venue}`);
  }
}

const NO_WALLETS: ReadonlySet<string> = new Set();

/** How many positions the heatmap sees of an account (none of a venue's own). */
const visible = (a: MirrorAcct): number => (a.n[3]! & A_NO_LIVE ? 0 : a.s.length);

type PosFields = { szi: number; entry: number | null; iso?: number | null; lev?: number | null; fix?: number | null };

/** A position from an account's numbers at `o` (MirrorSource), every field as the indexer's book holds it. */
function posOf(n: number[], o: number): PosFields {
  const f = n[o + 5]!;
  const p: PosFields = { szi: n[o]!, entry: f & P_ENTRY_NULL ? null : n[o + 1]! };
  if (f & P_ISO) p.iso = f & P_ISO_NULL ? null : n[o + 2]!;
  if (f & P_LEV) p.lev = f & P_LEV_NULL ? null : n[o + 3]!;
  if (f & P_FIX) p.fix = f & P_FIX_NULL ? null : n[o + 4]!;
  return p;
}

// --- the heatmap thread's copy of the books --------------------------------------------------------

/**
 * The books as the indexer hands them over, kept as lean as the engine, the change log and the cohorts' passes
 * (cohortCore.ts) allow: per account its symbols and one array of numbers - [cash, equity, read at, flags, collateral,
 * spot read at, filled at, then per position szi, entry, iso, lev, fix, flags] - with positions made as objects only
 * when the engine prices the account or a pass reads it (the indexer's own account() makes them afresh each time too).
 * Every book is here since 2026-11-09, empty ones and a venue's own accounts too (flagged out of the heatmap:
 * internalWallets.ts), as the cohorts count them.
 */
interface MirrorAcct { k: string; s: string[]; n: number[] }

// Account flags: cash / equity not known; collateral / spot read not known; never filled in this process; a market
// opened since the read; a read the margin rules could not price; out of the heatmap (a venue's own account).
const A_CASH_NULL = 1;
const A_EQ_NULL = 2;
const A_COLL_NULL = 4;
const A_SPOT_NULL = 8;
const A_FILLED_NONE = 16;
const A_OPENED = 32;
const A_LIQ_MISS = 64;
const A_NO_LIVE = 128;
// Position flags: entry null; iso / lev / fix present (absent = undefined) and null.
const P_ENTRY_NULL = 1;
const P_ISO = 2;
const P_ISO_NULL = 4;
const P_LEV = 8;
const P_LEV_NULL = 16;
const P_FIX = 32;
const P_FIX_NULL = 64;
const HEAD = 7;
const PER_POS = 6;

/** A book as the indexer holds it (cohortTracker.ts Book): what the encoding reads. */
export interface BookLike {
  equity: number | null;
  cash?: number | null;
  at: number;
  pos: ReadonlyMap<string, { szi: number; entry: number | null; iso?: number | null; lev?: number | null; fix?: number | null }>;
  /** What the cohorts' passes read besides (cohortTracker.ts Book). */
  collateral?: number | null;
  spotAt?: number | null;
  filledAt?: number;
  opened?: boolean;
  liqMiss?: boolean;
}

/** Accounts on the wire: keys, then every account's symbols and numbers back to back (an account of -1 positions is gone). */
export interface AccountsWire { k: string[]; s: string[]; n: Float64Array }

/** Accounts as the wire carries them (the indexer's side): `book` undefined = gone; `noLive` = kept for the cohorts, out of the heatmap. */
export class AccountsEncoder {
  k: string[] = [];
  s: string[] = [];
  n: number[] = [];

  get size(): number {
    return this.k.length;
  }

  add(key: string, b: BookLike | undefined, noLive = false): void {
    this.k.push(key);
    if (!b) { this.n.push(-1); return; }
    const n = this.n;
    const f = (b.cash == null ? A_CASH_NULL : 0) | (b.equity == null ? A_EQ_NULL : 0) | (b.collateral == null ? A_COLL_NULL : 0)
      | (b.spotAt == null ? A_SPOT_NULL : 0) | (b.filledAt === undefined ? A_FILLED_NONE : 0) | (b.opened ? A_OPENED : 0)
      | (b.liqMiss ? A_LIQ_MISS : 0) | (noLive ? A_NO_LIVE : 0);
    n.push(b.pos.size, b.cash ?? 0, b.equity ?? 0, b.at, f, b.collateral ?? 0, b.spotAt ?? 0, b.filledAt ?? 0);
    for (const [sym, p] of b.pos) {
      this.s.push(sym);
      let f = 0;
      if (p.entry == null) f |= P_ENTRY_NULL;
      if (p.iso !== undefined) f |= p.iso === null ? P_ISO | P_ISO_NULL : P_ISO;
      if (p.lev !== undefined) f |= p.lev === null ? P_LEV | P_LEV_NULL : P_LEV;
      if (p.fix !== undefined) f |= p.fix === null ? P_FIX | P_FIX_NULL : P_FIX;
      n.push(p.szi, p.entry ?? 0, p.iso ?? 0, p.lev ?? 0, p.fix ?? 0, f);
    }
  }

  take(): AccountsWire {
    const out = { k: this.k, s: this.s, n: Float64Array.from(this.n) };
    this.k = [];
    this.s = [];
    this.n = [];
    return out;
  }
}

export class MirrorSource implements LiveSource {
  readonly accounts = new Map<string, MirrorAcct>();
  /** The same accounts per venue by address, in the order the indexer handed them in (the cohorts' passes go venue by venue). */
  readonly byVenue = new Map<Venue, Map<string, MirrorAcct>>();
  readonly marks = new Map<string, number>();
  readonly coinPx = new Map<string, number>();
  readonly tiers = new Map<Venue, Map<string, Tiers>>();
  wantedSet: ReadonlySet<string> = new Set();
  /** Symbol strings shared by every account that holds them. */
  private syms = new Map<string, string>();

  constructor(private readonly coinOf: (symbol: string) => string) {}

  /**
   * Accounts in, each touched in the engine by the key string this map holds for it (one string per account, not two) -
   * unless the heatmap sees nothing of it before or after (an empty book, a venue's own account): nothing to price.
   */
  applyAccounts(w: AccountsWire, touch: (key: string) => void): void {
    let si = 0;
    let ni = 0;
    for (const k of w.k) {
      const np = w.n[ni++]!;
      const had = this.accounts.get(k);
      const key = had ? had.k : k;
      const before = had ? visible(had) : 0;
      if (np < 0) {
        if (had) {
          this.accounts.delete(key);
          const j = key.indexOf('|');
          this.byVenue.get(key.slice(0, j) as Venue)?.delete(key.slice(j + 1));
        }
        if (before) touch(key);
        continue;
      }
      const s = new Array<string>(np);
      const n = new Array<number>(HEAD + np * PER_POS);
      for (let j = 0; j < HEAD; j++) n[j] = w.n[ni++]!;
      for (let i = 0; i < np; i++) {
        const sym = w.s[si++]!;
        let shared = this.syms.get(sym);
        if (shared === undefined) { shared = sym; this.syms.set(sym, sym); }
        s[i] = shared;
        for (let j = 0; j < PER_POS; j++) n[HEAD + i * PER_POS + j] = w.n[ni++]!;
      }
      let a = had;
      if (a) { a.s = s; a.n = n; } else {
        a = { k: key, s, n };
        this.accounts.set(key, a);
        const j = key.indexOf('|');
        const v = key.slice(0, j) as Venue;
        let m = this.byVenue.get(v);
        if (!m) { m = new Map(); this.byVenue.set(v, m); }
        m.set(key.slice(j + 1), a);
      }
      if (before || visible(a)) touch(key);
    }
  }

  /** An account as the cohorts' passes read it (cohortTracker.ts Book), made afresh from its numbers. */
  bookOf(x: unknown): BookLike | undefined {
    const a = x as MirrorAcct | undefined;
    if (!a) return undefined;
    const n = a.n;
    const f = n[3]!;
    const pos = new Map<string, { szi: number; entry: number | null; iso?: number | null; lev?: number | null; fix?: number | null }>();
    for (let i = 0; i < a.s.length; i++) pos.set(a.s[i]!, posOf(n, HEAD + i * PER_POS));
    const b: BookLike = {
      equity: f & A_EQ_NULL ? null : n[1]!, cash: f & A_CASH_NULL ? null : n[0]!, at: n[2]!, pos,
      collateral: f & A_COLL_NULL ? null : n[4]!, spotAt: f & A_SPOT_NULL ? null : n[5]!,
    };
    if (!(f & A_FILLED_NONE)) b.filledAt = n[6]!;
    if (f & A_OPENED) b.opened = true;
    if (f & A_LIQ_MISS) b.liqMiss = true;
    return b;
  }

  account = (_venue: Venue, _address: string, key: string): LiveAccount | undefined => {
    const a = this.accounts.get(key);
    if (!a || a.n[3]! & A_NO_LIVE) return undefined;
    const n = a.n;
    const positions = a.s.map((symbol, i) => {
      const o = HEAD + i * PER_POS;
      const f = n[o + 5]!;
      const p: { symbol: string; szi: number; iso?: number | null; lev?: number | null; fix?: number | null } = { symbol, szi: n[o]! };
      if (f & P_ISO) p.iso = f & P_ISO_NULL ? null : n[o + 2]!;
      if (f & P_LEV) p.lev = f & P_LEV_NULL ? null : n[o + 3]!;
      if (f & P_FIX) p.fix = f & P_FIX_NULL ? null : n[o + 4]!;
      return p;
    });
    const cash = n[3]! & A_CASH_NULL ? null : n[0]!;
    // cohortTracker.ts liqKnown: the cash, or any position the venue margins on its own or prices for us.
    const priced = cash !== null || positions.some((p) => p.iso !== undefined || p.fix != null);
    return { cash, priced, positions, equity: n[3]! & A_EQ_NULL ? null : n[1]! };
  };

  priceOf = (venue: Venue, symbol: string): number | null => this.marks.get(`${venue}|${symbol}`) ?? null;
  tiersOf = (venue: Venue, symbol: string): Tiers | null => this.tiers.get(venue)?.get(symbol) ?? null;
  priceOfCoin = (coin: string): number | null => this.coinPx.get(coin) ?? null;
  wanted = (coin: string): boolean => this.wantedSet.has(coin);

  extra = (venue: Venue, address: string, coin: string): LiqLogExtra => {
    const a = this.accounts.get(`${venue}|${address}`);
    if (!a) return {};
    const n = a.n;
    const acct = { cash: n[3]! & A_CASH_NULL ? null : n[0]!, equity: n[3]! & A_EQ_NULL ? null : n[1]!, at: n[2]! };
    const positions: Array<[string, ExtraPos]> = a.s.map((sym, i) => {
      const o = HEAD + i * PER_POS;
      const f = n[o + 5]!;
      const p: ExtraPos = { szi: n[o]!, entry: f & P_ENTRY_NULL ? null : n[o + 1]! };
      if (f & P_ISO) p.iso = f & P_ISO_NULL ? null : n[o + 2]!;
      if (f & P_LEV) p.lev = f & P_LEV_NULL ? null : n[o + 3]!;
      return [sym, p];
    });
    return logExtraOf(acct, positions, this.coinOf, coin, (sym) => this.marks.get(`${venue}|${sym}`) ?? null);
  };
}

