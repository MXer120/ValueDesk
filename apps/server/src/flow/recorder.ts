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

export const FLUSH_MS = 15_000;
export const CLOSE_MS = 20_000;
export const READY_MS = 60_000;
export const BUDGET_MS = 40;
/** How often the run log (meta `runs`: when the recorder was up) is moved forward. */
const RUN_MS = 60_000;
const REPEATS_MS = 10 * 60_000;

/** Venues whose prints name account ids, not addresses (the address comes from the index). */
const ID_VENUES: ReadonlySet<Venue> = new Set(['sodex', 'lighter']);

interface Open {
  mid: number;
  t: number;
  prints: FlowPrint[];
  dirty: boolean;
  /** When it was last written (0: never). */
  at: number;
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
  /** The newest trade time added (ms; 0: none since the start): how far the trade flow is behind (statusModel.ts FRESH_TARGETS). */
  newestT: number;
}

export class FlowRecorder {
  private markets = new Map<string, number>();
  private parties = new Map<string, number>();
  /** Party ids of SoDEX / Lighter accounts whose address is not known yet. */
  private unresolved = new Map<number, { venue: Venue; key: string }>();
  private open = new Map<string, Open>();
  private newestT = 0;
  private hourThrough: number;
  private dayThrough: number;
  /** Hours (mid|t) to sum again: a late print landed in them. */
  private redoHours = new Set<string>();
  private redoDays = new Set<string>();
  /** The hour being summed: its markets still to do. */
  private hourQueue: number[] | null = null;
  private dayQueue: number[] | null = null;
  private lastRun = 0;
  private repeats = new Map<string, Map<string, number>>();
  private repeatsAt = 0;
  private runStart: number;
  private stats = { prints: 0, late: 0, lastFlushMs: 0 };
  lastError: string | null = null;

  constructor(
    readonly store: FlowStore,
    private readonly addressOf: (venue: Venue, acct: string) => string | null,
    private readonly now: () => number = Date.now,
  ) {
    for (const m of store.markets()) this.markets.set(`${m.venue}|${m.symbol}`, m.id);
    for (const p of store.parties()) {
      this.parties.set(`${p.venue}|${p.key}`, p.id);
      if (!p.address && ID_VENUES.has(p.venue)) this.unresolved.set(p.id, { venue: p.venue, key: p.key });
    }
    const t = this.now();
    this.hourThrough = Number(store.getMeta('hour_through')) || Math.floor(t / HOUR_MS) * HOUR_MS;
    this.dayThrough = Number(store.getMeta('day_through')) || Math.floor(t / DAY_MS) * DAY_MS;
    this.runStart = t;
    this.repeatsAt = t;
    if (!store.getMeta('since')) store.setMeta('since', String(t));
  }

  /** One print from the streams. */
  add(p: Print): void {
    if (p.venue === 'hyperliquid' && (p.symbol.startsWith('xyz:') || p.symbol.startsWith('@') || p.symbol.includes('/'))) return;
    if (!(p.px > 0) || !(p.sz > 0) || !Number.isFinite(p.t)) return;
    try {
      const mid = this.marketOf(p.venue, p.symbol, p.t);
      const buyer = this.partyOf(p.venue, p.buyer);
      const seller = this.partyOf(p.venue, p.seller);
      const taker = p.taker === 'buyer' ? TAKER_BUYER : p.taker === 'seller' ? TAKER_SELLER : TAKER_NONE;
      const ct = Math.floor(p.t / CHUNK_MS) * CHUNK_MS;
      const k = `${mid}|${ct}`;
      let o = this.open.get(k);
      if (!o) {
        o = { mid, t: ct, prints: [], dirty: false, at: 0 };
        // A slot already closed, or begun before this run: reopen it with what is on disk. A slot begun before a
        // restart used to start empty here, and its next write replaced what the last run held.
        const closed = ct + CHUNK_MS + CLOSE_MS <= this.now();
        if (closed || ct < this.runStart) {
          const old = this.store.chunk(mid, ct);
          if (old) o.prints = chunkPrints(decodeChunk(old));
        }
        if (closed) {
          this.stats.late++;
          this.markLate(mid, ct);
        }
        this.open.set(k, o);
      }
      o.prints.push({ t: p.t, px: p.px, sz: p.sz, buyer, seller, taker });
      o.dirty = true;
      this.stats.prints++;
      if (p.t > this.newestT) this.newestT = p.t;
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
    const out: Print[] = [];
    const held = new Map<string, Map<string, number>>();
    try {
      for (const p of prints) {
        const mid = this.markets.get(`${p.venue}|${p.symbol}`);
        if (mid === undefined) { out.push(p); continue; }
        const party = (acct: string): number =>
          this.parties.get(`${p.venue}|${ID_VENUES.has(p.venue) ? acct : acct.toLowerCase()}`) ?? -1;
        const ct = Math.floor(p.t / CHUNK_MS) * CHUNK_MS;
        const k = `${mid}|${ct}`;
        let counts = held.get(k);
        if (!counts) {
          counts = new Map();
          const open = this.open.get(k);
          let list: readonly FlowPrint[] = open?.prints ?? [];
          if (!open) {
            const blob = this.store.chunk(mid, ct);
            if (blob) list = chunkPrints(decodeChunk(blob));
          }
          for (const f of list) {
            const key = `${f.t}|${f.px}|${f.sz}|${f.buyer}|${f.seller}`;
            counts.set(key, (counts.get(key) ?? 0) + 1);
          }
          held.set(k, counts);
        }
        const key = `${p.t}|${p.px}|${p.sz}|${party(p.buyer)}|${party(p.seller)}`;
        const n = counts.get(key) ?? 0;
        if (n > 0) counts.set(key, n - 1);
        else out.push(p);
      }
    } catch (e) {
      this.lastError = `missing: ${String(e)}`;
      return [];
    }
    return out;
  }

  /**
   * As `missing`, for a venue whose REST time is not its stream's (Arcus, 2 to 16 ms apart on every row, see
   * indexer/arcusCatchup.ts): price, size and both parties exact, the time within `nearMs`, and one held print answers for one
   * row, the nearest, so of two like trades with one held the other still counts as missing. The margin errs towards "held":
   * a print left out can be fetched again, one added twice cannot be taken out.
   */
  missingNear(prints: readonly Print[], nearMs: number): Print[] {
    const out: Print[] = [];
    const held = new Map<string, number[]>();
    const read = new Set<string>();
    try {
      for (const p of [...prints].sort((a, b) => a.t - b.t)) {
        const mid = this.markets.get(`${p.venue}|${p.symbol}`);
        if (mid === undefined) { out.push(p); continue; }
        for (let ct = Math.floor((p.t - nearMs) / CHUNK_MS) * CHUNK_MS; ct <= p.t + nearMs; ct += CHUNK_MS) {
          const k = `${mid}|${ct}`;
          if (read.has(k)) continue;
          read.add(k);
          const open = this.open.get(k);
          let list: readonly FlowPrint[] = open?.prints ?? [];
          if (!open) {
            const blob = this.store.chunk(mid, ct);
            if (blob) list = chunkPrints(decodeChunk(blob));
          }
          for (const f of list) {
            const key = `${mid}|${f.px}|${f.sz}|${f.buyer}|${f.seller}`;
            const times = held.get(key);
            if (times) times.push(f.t);
            else held.set(key, [f.t]);
          }
        }
        const party = (acct: string): number =>
          this.parties.get(`${p.venue}|${ID_VENUES.has(p.venue) ? acct : acct.toLowerCase()}`) ?? -1;
        const times = held.get(`${mid}|${p.px}|${p.sz}|${party(p.buyer)}|${party(p.seller)}`);
        let best = -1;
        let bestBy = nearMs;
        for (let i = 0; times && i < times.length; i++) {
          const by = Math.abs(times[i]! - p.t);
          if (by <= bestBy) { best = i; bestBy = by; }
        }
        if (best >= 0) times!.splice(best, 1);
        else out.push(p);
      }
    } catch (e) {
      this.lastError = `missing: ${String(e)}`;
      return [];
    }
    return out;
  }

  /**
   * A print older than this run, that the run before already holds: the first frame after subscribing is a snapshot of recent
   * prints, and the streams' memory of ids died with the last process. Measured 2026-11-06: Hyperliquid slots held 2 to 6 times
   * their count, one more each restart (DYDX 12:05 17 of 9, para:NET 09:35 24 of 4), in activity and cohorts as well. Exact
   * and counted as in `missing`. Only prints older than the run come here, a chunk is read once, and the counts go after 10
   * minutes, when the snapshots are in.
   */
  repeatOfHeld(p: Print): boolean {
    if (p.t >= this.runStart) return false;
    try {
      const venue: Venue = p.venue === 'hyperliquid' && p.symbol.startsWith('xyz:') ? 'tradexyz' : p.venue;
      const mid = this.markets.get(`${venue}|${p.symbol}`);
      if (mid === undefined) return false;
      if (this.now() - this.repeatsAt > REPEATS_MS) { this.repeats.clear(); this.repeatsAt = this.now(); }
      const party = (acct: string): number => this.parties.get(`${venue}|${ID_VENUES.has(venue) ? acct : acct.toLowerCase()}`) ?? -1;
      const ct = Math.floor(p.t / CHUNK_MS) * CHUNK_MS;
      const k = `${mid}|${ct}`;
      let counts = this.repeats.get(k);
      if (!counts) {
        counts = new Map();
        const open = this.open.get(k);
        let list: readonly FlowPrint[] = open?.prints ?? [];
        if (!open) {
          const blob = this.store.chunk(mid, ct);
          if (blob) list = chunkPrints(decodeChunk(blob));
        }
        for (const f of list) {
          const key = `${f.t}|${f.px}|${f.sz}|${f.buyer}|${f.seller}`;
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        this.repeats.set(k, counts);
      }
      const key = `${p.t}|${p.px}|${p.sz}|${party(p.buyer)}|${party(p.seller)}`;
      const n = counts.get(key) ?? 0;
      if (n > 0) counts.set(key, n - 1);
      return n > 0;
    } catch (e) {
      this.lastError = `repeatOfHeld: ${String(e)}`;
      return false;
    }
  }

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
    const until = Date.now() + BUDGET_MS;
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
   * `until` Infinity); drop the closed ones from memory once written.
   */
  flush(now = this.now(), until = Infinity): void {
    const t0 = Date.now();
    const done: string[] = [];
    let wrote = 0;
    this.store.db.exec('BEGIN');
    try {
      for (const [k, o] of this.open) {
        const closed = o.t + CHUNK_MS + CLOSE_MS <= now;
        if (o.dirty && (closed || until === Infinity || now - o.at >= FLUSH_MS)) {
          if (wrote > 0 && Date.now() > until) break;
          this.store.putChunk(o.mid, o.t, o.prints.length, encodeChunk(o.t, o.prints));
          o.dirty = false;
          o.at = now;
          wrote++;
        }
        if (closed && !o.dirty) done.push(k);
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
      for (const o of this.open.values()) if (o.dirty && o.t < this.hourThrough + HOUR_MS) return;
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
      newestT: this.newestT,
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
