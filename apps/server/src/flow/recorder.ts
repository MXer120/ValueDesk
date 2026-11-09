/**
 * The indexer's side of the trade flow: every print of every streamed venue goes into its market's
 * 5-minute chunk, and each hour and day that has passed is summed per wallet (codec.ts, store.ts).
 *
 * Work per print is a map lookup and an array push. The rest runs on the indexer's 1 s tick, inside
 * a time budget (BUDGET_MS), so a busy hour never holds the loop:
 *   - a chunk that changed is packed and written again once FLUSH_MS has passed since its last
 *     write (the drill-down and a candle still forming read them; a candle is at most FLUSH_MS
 *     behind the stream), a few per tick: one flush of every open chunk at once held the loop
 *     130 ms at Hyperliquid's rate (600k prints an hour, measured 2026-11-01);
 *   - a chunk CLOSE_MS past its end is written a last time and leaves memory;
 *   - an hour READY_MS past its end is summed from its chunks, market by market; a day once all its
 *     hours are, from its hours.
 * A print for a chunk already closed (a stream that delivers late) reopens it from disk, and the
 * hour (and day) it falls in is summed again.
 *
 * On its own thread (thread.ts, the default in production since 2026-11-09) the same recorder also writes a forming chunk's
 * newest prints as its tail every TAIL_MS (store.ts flow_tail), so a candle is readable within about a second instead of
 * FLUSH_MS, and numbers its prints (`seq`) so the indexer's thread can tell what reached the file.
 *
 * What is recorded: every perp and SoDEX spot print. Hyperliquid's spot pairs (`@107`) are left out
 * - no chart shows them - and its `xyz:` prints are kept once, as trade.xyz (the engine hands them in
 * under both venues).
 */
import type { Venue } from '../valuedesk/types.js';
import type { Print } from '../indexer/streams.js';
import { coinOf } from '../valuedesk/cohorts/model.js';
import {
  CHUNK_MS, DAY_MS, HOUR_MS, TAKER_BUYER, TAKER_NONE, TAKER_SELLER,
  addPrints, chunkPrints, decodeChunk, decodeSums, encodeChunk, encodeSums, mergeSums,
  type FlowPrint, type WalletSums,
} from './codec.js';
import type { FlowStore } from './store.js';
import { ID_VENUES, Repeats, missingNearOf, missingOf, partyKey, type HeldView } from './held.js';

export const FLUSH_MS = 15_000;
export const CLOSE_MS = 20_000;
export const READY_MS = 60_000;
export const BUDGET_MS = 40;
/** The recorder's thread: a forming chunk's prints since its last full write go to its tail this often. */
export const TAIL_MS = 500;
/** How often the run log (meta `runs`: when the recorder was up) is moved forward. */
const RUN_MS = 60_000;

export interface RecorderOptions {
  /** Write a forming chunk's new prints as its tail this often (0, the default: never; every write is a full one). */
  tailMs?: number;
  /** The tick's time budget (BUDGET_MS on the indexer's thread). */
  budgetMs?: number;
  /** Prints come numbered (`add`'s seq): each write notes the newest one its slot holds under this name (flow_sent). */
  session?: string;
  /**
   * Every slot new to memory is looked up on disk, not only the ones begun before this run: a restarted thread is handed
   * prints the last one may already have written, of any slot.
   */
  reopenAll?: boolean;
}

interface Open {
  mid: number;
  t: number;
  prints: FlowPrint[];
  dirty: boolean;
  /** When it was last written in full (0: never). */
  at: number;
  /** How many of `prints` the last full write held (the rest is the tail's, or not written yet). */
  written: number;
  /** When its tail was last written, and whether one is on disk. */
  tailAt: number;
  tail: boolean;
  /** The newest print number in it, and the first one since it was last written (Infinity: none). */
  seq: number;
  dirtySeq: number;
}

export interface FlowStatus {
  prints: number;
  late: number;
  open: number;
  openPrints: number;
  parties: number;
  unresolved: number;
  hourThrough: number;
  dayThrough: number;
  lastFlushMs: number;
  lastError: string | null;
}

export class FlowRecorder {
  private markets = new Map<string, number>();
  private parties = new Map<string, number>();
  /** Party ids of SoDEX / Lighter accounts whose address is not known yet. */
  private unresolved = new Map<number, { venue: Venue; key: string }>();
  private open = new Map<string, Open>();
  private hourThrough: number;
  private dayThrough: number;
  /** Hours (mid|t) to sum again: a late print landed in them. */
  private redoHours = new Set<string>();
  private redoDays = new Set<string>();
  /** The hour being summed: its markets still to do. */
  private hourQueue: number[] | null = null;
  private dayQueue: number[] | null = null;
  private lastRun = 0;
  private repeats: Repeats;
  private runStart: number;
  private stats = { prints: 0, late: 0, lastFlushMs: 0 };
  /** The newest print number handed in (numbered prints only). */
  private lastSeq = 0;
  private readonly tailMs: number;
  private readonly budgetMs: number;
  lastError: string | null = null;

  constructor(
    readonly store: FlowStore,
    private readonly addressOf: (venue: Venue, acct: string) => string | null,
    private readonly now: () => number = Date.now,
    private readonly opts: RecorderOptions = {},
  ) {
    this.tailMs = opts.tailMs ?? 0;
    this.budgetMs = opts.budgetMs ?? BUDGET_MS;
    for (const m of store.markets()) this.markets.set(`${m.venue}|${m.symbol}`, m.id);
    for (const p of store.parties()) {
      this.parties.set(`${p.venue}|${p.key}`, p.id);
      if (!p.address && ID_VENUES.has(p.venue)) this.unresolved.set(p.id, { venue: p.venue, key: p.key });
    }
    const t = this.now();
    this.hourThrough = Number(store.getMeta('hour_through')) || Math.floor(t / HOUR_MS) * HOUR_MS;
    this.dayThrough = Number(store.getMeta('day_through')) || Math.floor(t / DAY_MS) * DAY_MS;
    this.runStart = t;
    this.repeats = new Repeats(t, this.now);
    if (!store.getMeta('since')) store.setMeta('since', String(t));
    this.foldTails();
  }

  /**
   * Tails left by a run that ended without its last full writes (a thread killed, a crash) go into their chunks: what is
   * on disk is then whole chunks again, which the hour sums and every slot reopened read.
   */
  private foldTails(): void {
    const tails = this.store.allTails();
    if (!tails.length) return;
    this.store.db.exec('BEGIN');
    try {
      for (const x of tails) {
        const old = this.store.chunk(x.mid, x.t);
        const prints = [...(old ? chunkPrints(decodeChunk(old)) : []), ...chunkPrints(decodeChunk(x.data))];
        this.store.putChunk(x.mid, x.t, prints.length, encodeChunk(x.t, prints));
        this.store.dropTail(x.mid, x.t);
      }
      this.store.db.exec('COMMIT');
    } catch (e) {
      try { this.store.db.exec('ROLLBACK'); } catch { /* not open */ }
      throw e;
    }
  }

  /** Whether a print belongs in the flow at all (the engine hands in more). */
  static keeps(p: Print): boolean {
    if (p.venue === 'hyperliquid' && (p.symbol.startsWith('xyz:') || p.symbol.startsWith('@') || p.symbol.includes('/'))) return false;
    return p.px > 0 && p.sz > 0 && Number.isFinite(p.t);
  }

  /**
   * A numbered print the slot already holds on disk (flow_sent of this run's session): a restarted thread is handed again
   * everything not confirmed, and the part its predecessor wrote must not go in twice. Prints of a slot are written in
   * number order, so one at or below the slot's newest written number is in it.
   */
  writtenBefore(p: Print, seq: number): boolean {
    if (!this.opts.session || !FlowRecorder.keeps(p)) return false;
    const mid = this.markets.get(`${p.venue}|${p.symbol}`);
    if (mid === undefined) return false;
    return this.store.sent(mid, Math.floor(p.t / CHUNK_MS) * CHUNK_MS, this.opts.session) >= seq;
  }

  /** One print from the streams; `seq`, its number, on the recorder's thread (`resent`: handed in again after a restart). */
  add(p: Print, seq?: number, resent = false): void {
    if (seq !== undefined && seq > this.lastSeq) this.lastSeq = seq;
    if (!FlowRecorder.keeps(p)) return;
    if (resent && seq !== undefined && this.writtenBefore(p, seq)) return;
    try {
      const mid = this.marketOf(p.venue, p.symbol, p.t);
      const buyer = this.partyOf(p.venue, p.buyer);
      const seller = this.partyOf(p.venue, p.seller);
      const taker = p.taker === 'buyer' ? TAKER_BUYER : p.taker === 'seller' ? TAKER_SELLER : TAKER_NONE;
      const ct = Math.floor(p.t / CHUNK_MS) * CHUNK_MS;
      const k = `${mid}|${ct}`;
      let o = this.open.get(k);
      if (!o) {
        o = { mid, t: ct, prints: [], dirty: false, at: 0, written: 0, tailAt: 0, tail: false, seq: 0, dirtySeq: Infinity };
        // A slot already closed, or begun before this run: reopen it with what is on disk. A slot begun before a
        // restart used to start empty here, and its next write replaced what the last run held.
        const closed = ct + CHUNK_MS + CLOSE_MS <= this.now();
        if (closed || ct < this.runStart || this.opts.reopenAll) {
          const old = this.store.chunk(mid, ct);
          if (old) o.prints = chunkPrints(decodeChunk(old));
          o.written = o.prints.length;
        }
        if (closed) {
          this.stats.late++;
          this.markLate(mid, ct);
        }
        this.open.set(k, o);
      }
      o.prints.push({ t: p.t, px: p.px, sz: p.sz, buyer, seller, taker });
      if (seq !== undefined) {
        if (!o.dirty) o.dirtySeq = seq;
        o.seq = seq;
      }
      o.dirty = true;
      this.stats.prints++;
    } catch (e) {
      this.lastError = `add: ${String(e)}`;
    }
  }

  /**
   * Of these prints, the ones not held: exact on time, price, size and both parties, and counted, as one wallet can fill
   * the same counterparty twice at one price in one millisecond. Chunks keep no trade id. If a chunk cannot be read,
   * nothing counts as missing: a print left out can be fetched again, one added twice cannot be taken out.
   */
  missing(prints: readonly Print[]): Print[] {
    try {
      return missingOf(this.view, prints);
    } catch (e) {
      this.lastError = `missing: ${String(e)}`;
      return [];
    }
  }

  /**
   * As `missing`, for a venue whose REST time is not its stream's (Arcus, 2 to 16 ms apart on every row, see
   * indexer/arcusCatchup.ts): price, size and both parties exact, the time within `nearMs`, and one held print answers for one
   * row, the nearest, so of two like trades with one held the other still counts as missing. The margin errs towards "held":
   * a print left out can be fetched again, one added twice cannot be taken out.
   */
  missingNear(prints: readonly Print[], nearMs: number): Print[] {
    try {
      return missingNearOf(this.view, prints, nearMs);
    } catch (e) {
      this.lastError = `missing: ${String(e)}`;
      return [];
    }
  }

  /**
   * A print older than this run, that the run before already holds: the first frame after subscribing is a snapshot of recent
   * prints, and the streams' memory of ids died with the last process. Measured 2026-11-06: Hyperliquid slots held 2 to 6 times
   * their count, one more each restart (DYDX 12:05 17 of 9, para:NET 09:35 24 of 4), in activity and cohorts as well. Exact
   * and counted as in `missing`. Only prints older than the run come here, a chunk is read once, and the counts go after 10
   * minutes, when the snapshots are in.
   */
  repeatOfHeld(p: Print): boolean {
    try {
      return this.repeats.check(this.view, p);
    } catch (e) {
      this.lastError = `repeatOfHeld: ${String(e)}`;
      return false;
    }
  }

  /** What this recorder holds: its open slots, else the file. */
  private readonly view: HeldView = {
    market: (venue, symbol) => this.markets.get(`${venue}|${symbol}`),
    party: (venue, acct) => this.parties.get(`${venue}|${partyKey(venue, acct)}`) ?? -1,
    slot: (mid, ct) => {
      const open = this.open.get(`${mid}|${ct}`);
      if (open) return open.prints;
      const blob = this.store.chunk(mid, ct);
      return blob ? chunkPrints(decodeChunk(blob)) : [];
    },
  };

  private markLate(mid: number, ct: number): void {
    const h = Math.floor(ct / HOUR_MS) * HOUR_MS;
    if (h < this.hourThrough) this.redoHours.add(`${mid}|${h}`);
    const d = Math.floor(ct / DAY_MS) * DAY_MS;
    if (d < this.dayThrough) this.redoDays.add(`${mid}|${d}`);
  }

  private marketOf(venue: Venue, symbol: string, t: number): number {
    const k = `${venue}|${symbol}`;
    let id = this.markets.get(k);
    if (id === undefined) {
      id = this.store.marketId(venue, symbol, coinOf(symbol), t);
      this.markets.set(k, id);
    }
    return id;
  }

  private partyOf(venue: Venue, acct: string): number {
    const key = ID_VENUES.has(venue) ? acct : acct.toLowerCase();
    const k = `${venue}|${key}`;
    let id = this.parties.get(k);
    if (id === undefined) {
      const address = ID_VENUES.has(venue) ? this.addressOf(venue, acct)?.toLowerCase() ?? null : key;
      id = this.store.partyId(venue, key, address);
      this.parties.set(k, id);
      if (!address && ID_VENUES.has(venue)) this.unresolved.set(id, { venue, key });
    }
    return id;
  }

  /** The 1 s tick: flush, close, resolve, sum - within BUDGET_MS. */
  tick(): void {
    const now = this.now();
    const until = Date.now() + this.budgetMs;
    try {
      this.flush(now, until);
      if (now - this.lastRun >= RUN_MS) this.noteRun(now);
      this.resolve(until);
      this.sumHours(now, until);
      this.sumDays(until);
    } catch (e) {
      this.lastError = `tick: ${String(e)}`;
    }
  }

  /**
   * Write the chunks that changed and were last written FLUSH_MS ago (every changed one with
   * `until` Infinity); drop the closed ones from memory once written. With a tail cadence, a chunk
   * changed since its last write that is not due in full gets its new prints written as its tail.
   */
  flush(now = this.now(), until = Infinity): void {
    const t0 = Date.now();
    const done: string[] = [];
    let wrote = 0;
    const session = this.opts.session;
    this.store.db.exec('BEGIN');
    try {
      for (const [k, o] of this.open) {
        const closed = o.t + CHUNK_MS + CLOSE_MS <= now;
        const full = o.prints.length > o.written;
        if (full && (closed || until === Infinity || now - o.at >= FLUSH_MS)) {
          if (wrote > 0 && Date.now() > until) break;
          this.store.putChunk(o.mid, o.t, o.prints.length, encodeChunk(o.t, o.prints));
          if (o.tail) this.store.dropTail(o.mid, o.t);
          if (session && o.seq) this.store.putSent(o.mid, o.t, session, o.seq);
          o.dirty = false;
          o.dirtySeq = Infinity;
          o.at = now;
          o.written = o.prints.length;
          o.tail = false;
          wrote++;
        } else if (this.tailMs > 0 && o.dirty && now - o.tailAt >= this.tailMs) {
          if (wrote > 0 && Date.now() > until) break;
          const fresh = o.prints.slice(o.written);
          this.store.putTail(o.mid, o.t, fresh.length, encodeChunk(o.t, fresh));
          if (session && o.seq) this.store.putSent(o.mid, o.t, session, o.seq);
          o.dirty = false;
          o.dirtySeq = Infinity;
          o.tailAt = now;
          o.tail = true;
          wrote++;
        }
        if (closed && !o.dirty && o.prints.length === o.written) done.push(k);
      }
      this.store.db.exec('COMMIT');
    } catch (e) {
      try { this.store.db.exec('ROLLBACK'); } catch { /* not open */ }
      throw e;
    }
    for (const k of done) this.open.delete(k);
    if (wrote) this.stats.lastFlushMs = Date.now() - t0;
  }

  /** Keep meta `runs` ([start, last seen] per run, newest last): the gaps between runs are hours with no prints recorded. */
  private noteRun(now: number): void {
    this.lastRun = now;
    let runs: Array<[number, number]> = [];
    try { runs = JSON.parse(this.store.getMeta('runs') ?? '[]') as Array<[number, number]>; } catch { runs = []; }
    const last = runs[runs.length - 1];
    if (last && last[0] === this.runStart) last[1] = now;
    else runs.push([this.runStart, now]);
    this.store.setMeta('runs', JSON.stringify(runs.slice(-500)));
  }

  /** SoDEX / Lighter accounts with no address yet (the recorder's thread asks the indexer's for them). */
  unresolvedKeys(limit: number): Array<[Venue, string]> {
    const out: Array<[Venue, string]> = [];
    for (const p of this.unresolved.values()) {
      if (out.length >= limit) break;
      out.push([p.venue, p.key]);
    }
    return out;
  }

  /** Addresses for SoDEX / Lighter accounts the index learned since. */
  private resolve(until: number): void {
    if (!this.unresolved.size) return;
    let n = 0;
    for (const [id, p] of this.unresolved) {
      const a = this.addressOf(p.venue, p.key);
      if (a) {
        this.store.setPartyAddress(id, a.toLowerCase());
        this.unresolved.delete(id);
      }
      if (++n % 256 === 0 && Date.now() > until) return;
    }
  }

  private sumOne(level: 'hour' | 'day', mid: number, t: number): void {
    const sums: WalletSums = new Map();
    let prints = 0;
    if (level === 'hour') {
      for (const c of this.store.chunks(mid, t, t + HOUR_MS)) prints += addPrints(sums, decodeChunk(c.data));
    } else {
      for (let h = t; h < t + DAY_MS; h += HOUR_MS) {
        const blob = this.store.sums('hour', mid, h);
        // An hour before the first run's first summed hour has chunks only.
        if (!blob) {
          for (const c of this.store.chunks(mid, h, h + HOUR_MS)) prints += addPrints(sums, decodeChunk(c.data));
          continue;
        }
        const d = decodeSums(blob);
        mergeSums(sums, d.sums);
        prints += d.prints;
      }
    }
    if (sums.size) this.store.putSums(level, mid, t, sums.size, prints, encodeSums(sums, prints));
  }

  private sumHours(now: number, until: number): void {
    for (const k of this.redoHours) {
      if (Date.now() > until) return;
      const [mid, t] = k.split('|').map(Number) as [number, number];
      this.redoHours.delete(k);
      this.sumOne('hour', mid, t);
    }
    while (this.hourThrough + HOUR_MS + READY_MS <= now) {
      // Chunks of this hour not written yet (the flush is behind, or a late print reopened one) go first.
      for (const o of this.open.values()) if ((o.dirty || o.prints.length > o.written) && o.t < this.hourThrough + HOUR_MS) return;
      if (!this.hourQueue) this.hourQueue = this.store.marketsWithChunks(this.hourThrough, this.hourThrough + HOUR_MS);
      while (this.hourQueue.length) {
        if (Date.now() > until) return;
        this.sumOne('hour', this.hourQueue.pop()!, this.hourThrough);
      }
      this.hourQueue = null;
      this.hourThrough += HOUR_MS;
      this.store.setMeta('hour_through', String(this.hourThrough));
    }
  }

  private sumDays(until: number): void {
    for (const k of this.redoDays) {
      if (Date.now() > until) return;
      const [mid, t] = k.split('|').map(Number) as [number, number];
      // Its hours first: the redo of the hour may still be queued.
      if ([...this.redoHours].some((h) => h.startsWith(`${mid}|`) && Number(h.split('|')[1]) < t + DAY_MS)) continue;
      this.redoDays.delete(k);
      this.sumOne('day', mid, t);
    }
    while (this.dayThrough + DAY_MS <= this.hourThrough) {
      if (!this.dayQueue) this.dayQueue = this.store.marketsWithChunks(this.dayThrough, this.dayThrough + DAY_MS);
      while (this.dayQueue.length) {
        if (Date.now() > until) return;
        this.sumOne('day', this.dayQueue.pop()!, this.dayThrough);
      }
      this.dayQueue = null;
      this.dayThrough += DAY_MS;
      this.store.setMeta('day_through', String(this.dayThrough));
    }
  }

  /** Every numbered print at or below this is on disk (in its chunk or tail): the oldest one changed since its slot's last write, less one. */
  durable(): number {
    let low = Infinity;
    for (const o of this.open.values()) if (o.dirty && o.dirtySeq < low) low = o.dirtySeq;
    return low === Infinity ? this.lastSeq : low - 1;
  }

  status(): FlowStatus {
    let openPrints = 0;
    for (const o of this.open.values()) openPrints += o.prints.length;
    return {
      prints: this.stats.prints,
      late: this.stats.late,
      open: this.open.size,
      openPrints,
      parties: this.parties.size,
      unresolved: this.unresolved.size,
      hourThrough: this.hourThrough,
      dayThrough: this.dayThrough,
      lastFlushMs: this.stats.lastFlushMs,
      lastError: this.lastError,
    };
  }

  /** On stop: everything open is written (the next run sums what is due). */
  stop(): void {
    try {
      this.flush(this.now());
      this.noteRun(this.now());
    } catch (e) {
      this.lastError = `stop: ${String(e)}`;
    }
  }
}
