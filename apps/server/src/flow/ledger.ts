/**
 * THE COVERAGE LEDGER: how many SoDEX prints are held against how many SoDEX says there were, per market and 5-minute
 * slot. Without it a past candle read as whole however much the stream had lost: measured 2026-11-06, BTC held 17-60 % of
 * the venue's count on 11-02 to 11-05 while the flow said `final` with no gaps and the panel said "Every print".
 *
 * THE VENUE'S COUNT is the candle's `n`: one per trade, and it agrees with the prints print for print (measured
 * 2026-11-06: 280 of 796 closed 5-minute slots over BTC, ETH, SOL and spot BTC equal exactly, none above the count; and
 * 12,922 of 12,922 over all 148 markets in the one whole hour of the last 30).
 *
 * THE SLOT is 5 minutes, because that is both what a flow chunk holds (`flow_chunk.n`, no decoding) and a candle SoDEX
 * serves back to 2026-10-02 19:15 UTC, a thousand rows a call. A shorter candle (1m, 3m) cannot be judged on its own: it is
 * judged by the slots around it and says so, which is safe in the direction that matters, as a slot that is whole has every
 * shorter candle in it whole. SoDEX's 1m rows would need the chunks decoded per minute, which is more work than this file
 * should cost anyone.
 *
 * NO TOLERANCE: a slot is whole when held equals the count, exactly. The two count the same thing, so a difference of one is
 * one print we do not hold. Held above the count is off too (it would mean a print held twice) and is shown as what it is.
 *
 * ITS OWN FILE AND ITS OWN THREAD (ledgerWorker.ts): the indexer's loop can lag 14 s and its flow connection writes every
 * second, so nothing here runs on that thread or takes that file's write lock. The thread reads the flow file read-only and
 * writes only here; a lost ledger costs a day's refill, never a print.
 *
 * WHAT A SLOT ROW MEANS: venue_n is SoDEX's count (NULL when its row carries no count: its oldest rows say n = 0 under real
 * volume), held is the chunk's count when last looked at. Inside a market's checked span a slot with no row had no trades on
 * either side, so quiet markets cost nothing. Outside that span nothing is claimed either way.
 *
 * PACING: one kline call every TICK_MS, 360 calls an hour at most (weight 20 each, restCore.weightFor: 120 of the 1,200
 * weight a minute SoDEX documents, on top of the catch-up's ~300 calls an hour). 148 markets each read every 30 minutes take
 * 296 of them; the other 64 walk history backwards until it runs out (at most 10 calls a market, once). A 429 stops it for 5
 * minutes. Reading held counts needs no call at all, so a slot the catch-up fills later is seen on the next visit.
 */
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { CHUNK_MS, DAY_MS } from './codec.js';

export const SLOT_MS = CHUNK_MS;
export const TICK_MS = 10_000;
export const VISIT_EVERY_MS = 30 * 60_000;
/** A candle this long past its end has stopped counting; its chunk has had its last write too (recorder CLOSE_MS + FLUSH_MS). */
export const SETTLE_MS = 2 * 60_000;
/** Held counts looked at again on each visit: longer than the catch-up's reach (7.6 h on the quietest market measured). */
export const RECENT_MS = 12 * 3_600_000;
/** On a thread's first visit to a market, how far back held counts are looked at again. */
const RESCAN_MS = 35 * DAY_MS;
const SYMBOLS_EVERY_MS = 3_600_000;
const LIMITED_MS = 5 * 60_000;
const DAYS_EVERY_MS = 15 * 60_000;
/** Candle rows per call: SoDEX refuses more than this. */
export const PAGE = 1_000;
/** Re-read at the end of the span, in case a candle moved after we took it. */
const OVERLAP = 2;
/**
 * Activity against the venue's volume, one side, for a closed day: two sums of floats, so not exact to the cent, but close.
 * Measured 2026-11-06 over all 148 markets, the one hour with every print held (01:00 UTC, 12,922 of 12,922): $1,017,049
 * against $1,017,049. An hour with 95 % of its prints read 0.954, so a tenth of a percent cannot hide a lost print's worth.
 */
export const DAY_SHARE_TOLERANCE = 0.001;
/** Most holes one answer lists; the sums still count every slot. */
export const MAX_HOLES = 200;

type Engine = 'perps' | 'spot';

export function ledgerPathFor(flowPath: string): string {
  return process.env.VALUESCAN_LEDGER_DB?.trim() || join(dirname(flowPath), 'valuescan-sodex-ledger.db');
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ledger_market (
  symbol TEXT PRIMARY KEY, engine TEXT NOT NULL, checked_from INTEGER NOT NULL, checked_to INTEGER NOT NULL, back_done INTEGER NOT NULL
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS ledger_slot (
  symbol TEXT NOT NULL, t INTEGER NOT NULL, venue_n INTEGER, held INTEGER NOT NULL, venue_usd REAL NOT NULL,
  PRIMARY KEY (symbol, t)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS ledger_slot_off ON ledger_slot (symbol, t) WHERE venue_n IS NULL OR held <> venue_n;
CREATE TABLE IF NOT EXISTS ledger_day (
  day INTEGER PRIMARY KEY, venue_prints INTEGER NOT NULL, held_prints INTEGER, venue_usd REAL NOT NULL, activity_usd REAL, known INTEGER NOT NULL, at INTEGER NOT NULL
) WITHOUT ROWID;
`;

export interface LedgerMarket {
  symbol: string;
  engine: Engine;
  checkedFrom: number;
  checkedTo: number;
  backDone: boolean;
}

export interface SlotRow {
  t: number;
  venueN: number | null;
  held: number;
  venueUsd: number;
}

/** One market's slots inside a span: what was compared, and the slots that are off. */
export interface MarketWindow {
  market: LedgerMarket | null;
  held: number;
  expected: number;
  off: Array<{ t: number; held: number; venue: number | null }>;
}

/** One UTC day, as written by the thread. */
export interface DayRow {
  day: number;
  venuePrints: number;
  /** Null before the flow began: no prints to compare. */
  heldPrints: number | null;
  venueUsd: number;
  /** Activity's volume, one side (each print is written to both its parties). */
  activityUsd: number | null;
  /** Every market's candles cover this day (a day still forming: as far as they have been read). */
  known: boolean;
  at: number;
}

export class LedgerStore {
  readonly db: DatabaseSync;
  private st = new Map<string, StatementSync>();

  constructor(readonly path: string, opts: { readOnly?: boolean } = {}) {
    this.db = new DatabaseSync(path, opts.readOnly ? { readOnly: true } : {});
    if (opts.readOnly) {
      this.db.exec('PRAGMA busy_timeout = 2000;');
    } else {
      this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');
      this.db.exec(SCHEMA);
    }
  }

  /** The writer has made its tables (a reader may open the file first). */
  ready(): boolean {
    return !!this.db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ledger_day'`).get();
  }

  private q(sql: string): StatementSync {
    let s = this.st.get(sql);
    if (!s) { s = this.db.prepare(sql); this.st.set(sql, s); }
    return s;
  }

  close(): void {
    this.db.close();
  }

  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch { /* not open */ }
      throw e;
    }
  }

  markets(): LedgerMarket[] {
    return (this.q('SELECT symbol, engine, checked_from AS f, checked_to AS o, back_done AS d FROM ledger_market').all() as Array<{ symbol: string; engine: Engine; f: number; o: number; d: number }>)
      .map((r) => ({ symbol: r.symbol, engine: r.engine, checkedFrom: r.f, checkedTo: r.o, backDone: r.d === 1 }));
  }

  market(symbol: string): LedgerMarket | null {
    const r = this.q('SELECT engine, checked_from AS f, checked_to AS o, back_done AS d FROM ledger_market WHERE symbol = ?').get(symbol) as { engine: Engine; f: number; o: number; d: number } | undefined;
    return r ? { symbol, engine: r.engine, checkedFrom: r.f, checkedTo: r.o, backDone: r.d === 1 } : null;
  }

  putMarket(m: LedgerMarket): void {
    this.q(`INSERT INTO ledger_market (symbol, engine, checked_from, checked_to, back_done) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (symbol) DO UPDATE SET engine = excluded.engine, checked_from = excluded.checked_from, checked_to = excluded.checked_to, back_done = excluded.back_done`)
      .run(m.symbol, m.engine, m.checkedFrom, m.checkedTo, m.backDone ? 1 : 0);
  }

  putSlot(symbol: string, s: SlotRow): void {
    this.q(`INSERT INTO ledger_slot (symbol, t, venue_n, held, venue_usd) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (symbol, t) DO UPDATE SET venue_n = excluded.venue_n, held = excluded.held, venue_usd = excluded.venue_usd`)
      .run(symbol, s.t, s.venueN, s.held, s.venueUsd);
  }

  hasSlots(symbol: string): boolean {
    return !!this.q('SELECT 1 FROM ledger_slot WHERE symbol = ? LIMIT 1').get(symbol);
  }

  slots(symbol: string, from: number, to: number): SlotRow[] {
    return (this.q('SELECT t, venue_n AS n, held, venue_usd AS u FROM ledger_slot WHERE symbol = ? AND t >= ? AND t < ?').all(symbol, from, to) as Array<{ t: number; n: number | null; held: number; u: number }>)
      .map((r) => ({ t: r.t, venueN: r.n, held: r.held, venueUsd: r.u }));
  }

  /** The slots of [from, to) compared for one market. Indexed; the slots that are off come from their own short index. */
  window(symbol: string, from: number, to: number): MarketWindow {
    const sum = this.q('SELECT COALESCE(SUM(held), 0) AS h, COALESCE(SUM(venue_n), 0) AS v FROM ledger_slot WHERE symbol = ? AND t >= ? AND t < ? AND venue_n IS NOT NULL').get(symbol, from, to) as { h: number; v: number };
    const off = this.q('SELECT t, held, venue_n AS v FROM ledger_slot WHERE symbol = ? AND t >= ? AND t < ? AND (venue_n IS NULL OR held <> venue_n) ORDER BY t').all(symbol, from, to) as Array<{ t: number; held: number; v: number | null }>;
    return { market: this.market(symbol), held: sum.h, expected: sum.v, off: off.map((r) => ({ t: r.t, held: r.held, venue: r.v })) };
  }

  daySums(symbol: string, from: number, to: number): { prints: number; held: number; usd: number } {
    const r = this.q('SELECT COALESCE(SUM(venue_n), 0) AS p, COALESCE(SUM(held), 0) AS h, COALESCE(SUM(venue_usd), 0) AS u FROM ledger_slot WHERE symbol = ? AND t >= ? AND t < ?').get(symbol, from, to) as { p: number; h: number; u: number };
    return { prints: r.p, held: r.h, usd: r.u };
  }

  putDay(d: DayRow): void {
    this.q(`INSERT INTO ledger_day (day, venue_prints, held_prints, venue_usd, activity_usd, known, at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (day) DO UPDATE SET venue_prints = excluded.venue_prints, held_prints = excluded.held_prints, venue_usd = excluded.venue_usd, activity_usd = excluded.activity_usd, known = excluded.known, at = excluded.at`)
      .run(d.day, d.venuePrints, d.heldPrints, d.venueUsd, d.activityUsd, d.known ? 1 : 0, d.at);
  }

  days(fromDay: number, toDay: number): DayRow[] {
    return (this.q('SELECT day, venue_prints AS p, held_prints AS h, venue_usd AS u, activity_usd AS a, known AS k, at FROM ledger_day WHERE day >= ? AND day <= ? ORDER BY day').all(fromDay, toDay) as Array<{ day: number; p: number; h: number | null; u: number; a: number | null; k: number; at: number }>)
      .map((r) => ({ day: r.day, venuePrints: r.p, heldPrints: r.h, venueUsd: r.u, activityUsd: r.a, known: r.k === 1, at: r.at }));
  }
}

// --- reading: what a window's slots say ---------------------------------------------------------------

export const slotDown = (t: number): number => Math.floor(t / SLOT_MS) * SLOT_MS;
export const slotUp = (t: number): number => Math.ceil(t / SLOT_MS) * SLOT_MS;

export interface CoverageHole {
  from: number;
  to: number;
  held: number;
  venue: number;
}

export interface VenueCoverage {
  venue: 'sodex';
  /** The whole slots compared: wider than a window under 5 minutes, or not on the 5-minute marks. */
  from: number;
  to: number;
  /** Prints held and SoDEX's count, over the slots with a count. */
  held: number;
  expected: number;
  /** Slots that are off, joined where they touch. At most MAX_HOLES, oldest first. */
  holes: CoverageHole[];
  /** Slots that are off, all of them. */
  holeSlots: number;
  /** Closed slots with no count from SoDEX yet: nothing is claimed for them. */
  unchecked: Array<[number, number]>;
}

/** Add one span to a sorted, non-touching list. */
function addSpan(list: Array<[number, number]>, a: number, b: number): void {
  if (b <= a) return;
  list.push([a, b]);
}

/** Sorted, with touching spans joined. */
export function joinSpans(list: ReadonlyArray<readonly [number, number]>): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const [a, b] of [...list].sort((x, y) => x[0] - y[0])) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** `list` with `cut` taken out of it. */
export function subtractSpans(list: ReadonlyArray<readonly [number, number]>, cut: ReadonlyArray<readonly [number, number]>): Array<[number, number]> {
  const c = joinSpans(cut);
  const out: Array<[number, number]> = [];
  for (const [from, to] of list) {
    let t = from;
    for (const [a, b] of c) {
      if (b <= t) continue;
      if (a >= to) break;
      if (a > t) out.push([t, a]);
      t = Math.max(t, b);
      if (t >= to) break;
    }
    if (t < to) out.push([t, to]);
  }
  return out;
}

/**
 * What the ledger says about [from, to) over these markets: pure over `read`. Only closed slots are looked at: a candle
 * still forming has no count to compare, and is not "unchecked" either. A market the ledger has not reached is unchecked
 * whole, and so is the part of one whose walk back has not got there; once it has run out, older slots are before the
 * market traded.
 */
export function coverageOf(symbols: readonly string[], from: number, to: number, now: number, read: (symbol: string, from: number, to: number) => MarketWindow): VenueCoverage {
  const a = slotDown(from);
  const b = Math.min(slotUp(to), slotDown(now - SETTLE_MS));
  const off = new Map<number, { held: number; venue: number }>();
  const unchecked: Array<[number, number]> = [];
  let held = 0;
  let expected = 0;
  if (a < b) {
    for (const symbol of symbols) {
      const w = read(symbol, a, b);
      held += w.held;
      expected += w.expected;
      const m = w.market;
      if (!m) { addSpan(unchecked, a, b); continue; }
      addSpan(unchecked, Math.max(a, m.checkedTo), b);
      if (!m.backDone) addSpan(unchecked, a, Math.min(b, m.checkedFrom));
      for (const s of w.off) {
        if (s.venue === null) { addSpan(unchecked, s.t, s.t + SLOT_MS); continue; }
        const o = off.get(s.t) ?? { held: 0, venue: 0 };
        o.held += s.held;
        o.venue += s.venue;
        off.set(s.t, o);
      }
    }
  }
  const holes: CoverageHole[] = [];
  for (const t of [...off.keys()].sort((x, y) => x - y)) {
    const s = off.get(t)!;
    const last = holes[holes.length - 1];
    if (last && last.to === t) { last.to = t + SLOT_MS; last.held += s.held; last.venue += s.venue; }
    else holes.push({ from: t, to: t + SLOT_MS, held: s.held, venue: s.venue });
  }
  return { venue: 'sodex', from: a, to: Math.max(a, b), held, expected, holes: holes.slice(0, MAX_HOLES), holeSlots: off.size, unchecked: joinSpans(unchecked) };
}

/** A span the ledger has proved whole: compared, and neither a hole nor unchecked. */
export function provenSpans(c: VenueCoverage): Array<[number, number]> {
  if (c.holeSlots > c.holes.reduce((s, h) => s + (h.to - h.from) / SLOT_MS, 0)) return [];
  return subtractSpans([[c.from, c.to]], [...c.holes.map((h) => [h.from, h.to] as [number, number]), ...c.unchecked]);
}

export type DayState = 'complete' | 'short' | 'unchecked';

/**
 * A day of activity: whole, short or not known. A day still forming is judged on prints alone, as the two volumes are read
 * at different moments and only the closed slots have a count.
 */
export function dayState(d: DayRow | undefined, today: number): DayState {
  if (!d || !d.known) return 'unchecked';
  const printsOff = d.heldPrints !== null && d.heldPrints !== d.venuePrints;
  if (d.day >= today) return printsOff ? 'short' : d.heldPrints === null ? 'unchecked' : 'complete';
  if (d.activityUsd === null) return printsOff ? 'short' : 'unchecked';
  if (printsOff) return 'short';
  if (d.venueUsd <= 0) return d.activityUsd > 0 ? 'short' : 'complete';
  return Math.abs(d.activityUsd / d.venueUsd - 1) <= DAY_SHARE_TOLERANCE ? 'complete' : 'short';
}

export interface ActivityDay {
  /** UTC midnight, ms. */
  t: number;
  state: DayState;
  /** Activity's one-side volume over the venue's. Null when either is not known or the venue did nothing. */
  share: number | null;
  venueUsd: number | null;
  activityUsd: number | null;
  venuePrints: number | null;
  heldPrints: number | null;
}

/** Per day for [fromDay, toDay]: a day the ledger holds nothing for is there too, as not checked. */
export function activityDays(rows: readonly DayRow[], fromDay: number, toDay: number, today: number): ActivityDay[] {
  const by = new Map(rows.map((r) => [r.day, r]));
  const out: ActivityDay[] = [];
  for (let day = fromDay; day <= toDay; day++) {
    const r = by.get(day);
    out.push({
      t: day * DAY_MS,
      state: dayState(r, today),
      share: r && r.known && r.activityUsd !== null && r.venueUsd > 0 ? r.activityUsd / r.venueUsd : null,
      venueUsd: r?.venueUsd ?? null,
      activityUsd: r?.activityUsd ?? null,
      venuePrints: r?.venuePrints ?? null,
      heldPrints: r?.heldPrints ?? null,
    });
  }
  return out;
}

// --- writing: the thread's loop ---------------------------------------------------------------------------

export interface Kline {
  t: number;
  n?: unknown;
  v?: unknown;
  q?: unknown;
}

export interface LedgerDeps {
  store: LedgerStore;
  symbols: (engine: Engine) => Promise<string[]>;
  klines: (engine: Engine, symbol: string, q: { limit: number; startTime?: number; endTime?: number }) => Promise<{ rows: Kline[]; limited?: boolean }>;
  /** The flow's chunks of a market in [from, to): prints per slot. Empty for a market it has never seen. */
  heldOf: (symbol: string, from: number, to: number) => Array<{ t: number; n: number }>;
  /** The flow's first start: before it there are no prints to compare. */
  flowSince: () => number | null;
  /** Activity's volume of a UTC day, both sides as written. Null when it cannot be read. */
  activityOf: (day: number) => number | null;
  now?: () => number;
  log?: (line: string) => void;
}

export interface LedgerStatus {
  markets: number;
  backLeft: number;
  calls: number;
  errors: number;
  limited: number;
  lastError: string | null;
  lastAt: number;
}

/** SoDEX's count of a candle, or null where its row carries none (the oldest rows say 0 under real volume). */
function countOf(r: Kline): number | null {
  const n = r.n;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) return null;
  return n === 0 && Number(r.v) > 0 ? null : n;
}

export class CoverageLedger {
  private readonly now: () => number;
  private markets = new Map<string, { engine: Engine; nextAt: number; rescanned: boolean }>();
  private symbolsAt = -Infinity;
  private daysAt = -Infinity;
  private limitedUntil = 0;
  private busy = false;
  private stats = { calls: 0, errors: 0, limited: 0, lastError: null as string | null, lastAt: 0 };

  constructor(private readonly d: LedgerDeps) {
    this.now = d.now ?? Date.now;
  }

  status(): LedgerStatus {
    return { markets: this.markets.size, backLeft: this.d.store.markets().filter((m) => !m.backDone).length, ...this.stats };
  }

  /** One step: at most one call to SoDEX. Public for tests. */
  async tick(): Promise<void> {
    const now = this.now();
    if (this.busy) return;
    this.busy = true;
    try {
      if (now >= this.limitedUntil) await this.step(now);
      if (now - this.daysAt >= DAYS_EVERY_MS) this.refreshDays(now);
    } catch (e) {
      this.stats.errors++;
      this.stats.lastError = String((e as Error)?.message ?? e).slice(0, 160);
    } finally {
      this.busy = false;
    }
  }

  private async step(now: number): Promise<void> {
    if (now - this.symbolsAt >= SYMBOLS_EVERY_MS) {
      this.symbolsAt = now;
      for (const engine of ['perps', 'spot'] as const) {
        for (const symbol of await this.d.symbols(engine)) {
          if (!this.markets.has(symbol)) this.markets.set(symbol, { engine, nextAt: now, rescanned: false });
        }
      }
      return;
    }
    let due: string | null = null;
    let dueAt = Infinity;
    for (const [symbol, m] of this.markets) if (m.nextAt <= now && m.nextAt < dueAt) { due = symbol; dueAt = m.nextAt; }
    if (due) { await this.visit(due, now); return; }
    await this.walkBack();
  }

  /** Read a market's new closed slots and look again at its recent held counts. */
  private async visit(symbol: string, now: number): Promise<void> {
    const entry = this.markets.get(symbol)!;
    // Whatever happens, this market waits its turn.
    entry.nextAt = now + VISIT_EVERY_MS;
    const { store } = this.d;
    const closedEnd = slotDown(now - SETTLE_MS);
    const st = store.market(symbol);
    let next: LedgerMarket;
    let rows: Kline[] = [];
    if (!st) {
      const got = await this.read(entry.engine, symbol, { limit: PAGE, endTime: closedEnd - SLOT_MS });
      if (!got) return;
      rows = got;
      const oldest = rows.reduce((t, r) => Math.min(t, r.t), closedEnd);
      next = { symbol, engine: entry.engine, checkedFrom: oldest, checkedTo: this.provedTo(symbol, rows, oldest, closedEnd), backDone: rows.length < PAGE };
    } else if (st.checkedTo < closedEnd) {
      // A long absence comes back a page a visit, oldest first, so the span never has a hole in it.
      const start = Math.max(st.checkedFrom, st.checkedTo - OVERLAP * SLOT_MS);
      const end = Math.min(closedEnd, start + PAGE * SLOT_MS);
      const got = await this.read(entry.engine, symbol, { limit: PAGE, startTime: start, endTime: end - SLOT_MS });
      if (!got) return;
      rows = got;
      next = { ...st, checkedTo: this.provedTo(symbol, rows, st.checkedTo, end) };
      // Still behind: its next page does not wait half an hour (unless SoDEX has nothing further yet).
      if (next.checkedTo === end && end < closedEnd) entry.nextAt = now;
    } else {
      next = st;
    }
    const from = entry.rescanned ? now - RECENT_MS : now - RESCAN_MS;
    this.write(next, rows, Math.max(next.checkedFrom, slotDown(from)), next.checkedTo);
    entry.rescanned = true;
  }

  /**
   * How far a read proves. An idle market's candles say n = 0, so a missing row is not a quiet slot: SoDEX's candles may just
   * not have got there, and a slot called empty for that reason would read as whole. Only a market that has never had a
   * candle (they stay empty for good) goes by the clock.
   */
  private provedTo(symbol: string, rows: readonly Kline[], from: number, end: number): number {
    const newest = rows.reduce((t, r) => (r.t < end ? Math.max(t, r.t + SLOT_MS) : t), -Infinity);
    if (newest > -Infinity) return Math.max(from, newest);
    return this.d.store.hasSlots(symbol) ? from : end;
  }

  /** One page further back, for the market that is least far back, so all reach the flow's start before any goes beyond it. */
  private async walkBack(): Promise<void> {
    let m: LedgerMarket | null = null;
    for (const x of this.d.store.markets()) if (!x.backDone && (!m || x.checkedFrom > m.checkedFrom)) m = x;
    if (!m) return;
    const got = await this.read(m.engine, m.symbol, { limit: PAGE, endTime: m.checkedFrom - SLOT_MS });
    if (!got) return;
    const oldest = got.reduce((t, r) => Math.min(t, r.t), m.checkedFrom);
    const next: LedgerMarket = { ...m, checkedFrom: oldest, backDone: got.length < PAGE };
    this.write(next, got, oldest, m.checkedFrom);
  }

  private async read(engine: Engine, symbol: string, q: { limit: number; startTime?: number; endTime?: number }): Promise<Kline[] | null> {
    this.stats.calls++;
    const { rows, limited } = await this.d.klines(engine, symbol, q);
    if (limited) {
      this.limitedUntil = this.now() + LIMITED_MS;
      this.stats.limited++;
      this.stats.lastError = 'SoDEX said 429';
      return null;
    }
    return rows;
  }

  /**
   * The candles read, and every held count of [from, to), in one transaction with the span they prove. A slot with nothing
   * on either side stays out: an idle market's candles say n = 0 for days.
   */
  private write(m: LedgerMarket, rows: readonly Kline[], from: number, to: number): void {
    const { store } = this.d;
    const fresh = rows.filter((r) => Number.isFinite(r.t) && r.t < m.checkedTo && r.t % SLOT_MS === 0);
    const low = fresh.reduce((t, r) => Math.min(t, r.t), from);
    const held = new Map(this.d.heldOf(m.symbol, low, to).map((c) => [c.t, c.n]));
    store.tx(() => {
      const have = new Map(store.slots(m.symbol, low, to).map((s) => [s.t, s]));
      const seen = new Set<number>();
      for (const r of fresh) {
        seen.add(r.t);
        const slot: SlotRow = { t: r.t, venueN: countOf(r), held: held.get(r.t) ?? 0, venueUsd: Number(r.q) || 0 };
        if (slot.venueN === 0 && slot.held === 0 && slot.venueUsd === 0 && !have.has(r.t)) continue;
        store.putSlot(m.symbol, slot);
      }
      // Slots with no candle in this read: only the held count can have moved. One held with no row: SoDEX counted nothing.
      for (const [t, n] of held) {
        if (seen.has(t)) continue;
        const s = have.get(t);
        if (!s) store.putSlot(m.symbol, { t, venueN: 0, held: n, venueUsd: 0 });
        else if (s.held !== n) store.putSlot(m.symbol, { ...s, held: n });
      }
      for (const s of have.values()) {
        if (!seen.has(s.t) && !held.has(s.t) && s.held !== 0) store.putSlot(m.symbol, { ...s, held: 0 });
      }
      store.putMarket(m);
    });
    this.stats.lastAt = this.now();
  }

  /** The day rows: the last week each time, the days before it until each is known (a few at a time, none of them urgent). */
  refreshDays(now: number): void {
    this.daysAt = now;
    const { store } = this.d;
    const markets = store.markets();
    if (!markets.length) return;
    const today = Math.floor(now / DAY_MS);
    const firstDay = Math.floor(Math.min(...markets.map((m) => m.checkedFrom)) / DAY_MS);
    const stored = new Map(store.days(firstDay, today).map((d) => [d.day, d]));
    // The last week is done over each time: a thread's first visits look at 35 days of held counts again.
    const redoFrom = today - 7;
    let older = 0;
    for (let day = today; day >= firstDay; day--) {
      const done = stored.get(day)?.known === true;
      if (day < redoFrom && (done || older >= 20)) continue;
      if (day < redoFrom) older++;
      store.putDay(this.dayOf(day, markets, today, now));
    }
  }

  private dayOf(day: number, markets: readonly LedgerMarket[], today: number, now: number): DayRow {
    const start = day * DAY_MS;
    const end = start + DAY_MS;
    let prints = 0;
    let held = 0;
    let usd = 0;
    let known = true;
    for (const m of markets) {
      if (!m.backDone && m.checkedFrom > start) known = false;
      if (m.checkedTo < (day >= today ? start : end)) known = false;
      const s = this.d.store.daySums(m.symbol, start, end);
      prints += s.prints;
      held += s.held;
      usd += s.usd;
    }
    const since = this.d.flowSince();
    const both = day >= today ? null : this.d.activityOf(day);
    return {
      day,
      venuePrints: prints,
      heldPrints: since !== null && start >= since ? held : null,
      venueUsd: usd,
      activityUsd: both === null ? null : both / 2,
      known,
      at: now,
    };
  }
}
