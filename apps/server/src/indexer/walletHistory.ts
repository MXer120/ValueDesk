/**
 * Every SoDEX wallet's own history, read ahead on the server, so a user who connects sees their volume, trades, fees and
 * funding for every timeframe at once (owner 2026-11-06). Market makers are left out for now.
 *
 * WHY NOT THE INDEX. The streams lost most prints before 2026-11-06 and much of that has no source, and they carry no fee
 * and no funding. A wallet's own rows from SoDEX do, and exactly: this is the same walk the browser runs (historySync.ts),
 * so the rows it stores are the rows the browser would have read, with the same ids, and the browser takes them as its
 * starting point and only reads what is newer.
 *
 * WHAT IT COSTS. SoDEX allows about 2 `/trades` reads a minute per IP (SODEX_HISTORY_PAIR_PER_MIN), shared with the
 * wallet trade checks. Every wallet needs at least 2 (perps, spot), so 18,000 wallets are weeks of reads, whatever the code
 * does. Hence the order: a wallet asking now, then the most recently active. Funding has no such limit.
 *
 * Off unless VALUESCAN_WALLET_BACKFILL sets a rate. Its own file, so the index's writer and its stalls are not involved;
 * the API process reads rows from it and writes only the demand table.
 */
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { defaultDbPath } from './store.js';
import type { NormalRow, PageQuery } from '../historyRows.js';
import {
  EMPTY_STATE,
  SCOPE_KINDS,
  createHistorySync,
  scopeKey,
  type HistoryStore,
  type HistorySync,
  type PageFetcher,
  type ScopeKind,
  type ScopeState,
} from '../historySync.js';

export const walletHistoryPath = (): string =>
  process.env.VALUESCAN_WALLET_HISTORY_DB?.trim() || join(dirname(defaultDbPath()), 'valuescan-wallet-history.db');

/** [id, time, symbol, side, price, qty, quote, fee, feeCoin, isMaker]: what the browser's own cache stores. */
export type PackedRow = [string, number, string | null, string | null, string | null, string | null, string | null, string | null, string | null, 0 | 1 | null];

export class WalletHistoryDb implements HistoryStore {
  private readonly db: DatabaseSync;

  constructor(path = walletHistoryPath()) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 2000;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS wrow (
        scope TEXT NOT NULL, id TEXT NOT NULL, time INTEGER NOT NULL, symbol TEXT, side TEXT, price TEXT, qty TEXT,
        quote TEXT, fee TEXT, fee_coin TEXT, is_maker INTEGER, PRIMARY KEY (scope, id)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS wstate (scope TEXT PRIMARY KEY, state TEXT NOT NULL) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS wdemand (address TEXT PRIMARY KEY, at INTEGER NOT NULL) WITHOUT ROWID;
    `);
  }

  close(): void {
    this.db.close();
  }

  readState(scope: string): ScopeState {
    const r = this.db.prepare('SELECT state FROM wstate WHERE scope = ?').get(scope) as { state: string } | undefined;
    return r ? (JSON.parse(r.state) as ScopeState) : { ...EMPTY_STATE };
  }

  writeState(scope: string, s: ScopeState): void {
    this.db.prepare('INSERT OR REPLACE INTO wstate (scope, state) VALUES (?, ?)').run(scope, JSON.stringify(s));
  }

  saveRows(scope: string, rows: NormalRow[]): number {
    if (rows.length === 0) return 0;
    const q = this.db.prepare('INSERT OR REPLACE INTO wrow (scope, id, time, symbol, side, price, qty, quote, fee, fee_coin, is_maker) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
    this.db.exec('BEGIN');
    try {
      for (const r of rows) q.run(scope, r.id, Number.isFinite(r.time) ? r.time : 0, r.symbol, r.side, r.price, r.qty, r.quote, r.fee, r.feeCoin, r.isMaker === null ? null : r.isMaker ? 1 : 0);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return rows.length;
  }

  loadRows(scope: string): NormalRow[] {
    return this.packed(scope).map((p) => ({
      id: p[0], time: p[1], symbol: p[2], side: p[3], price: p[4], qty: p[5], quote: p[6], fee: p[7], feeCoin: p[8],
      isMaker: p[9] === null ? null : p[9] === 1, raw: '',
    }));
  }

  /** The rows as the browser stores them, newest first. */
  packed(scope: string): PackedRow[] {
    const rows = this.db.prepare('SELECT id, time, symbol, side, price, qty, quote, fee, fee_coin, is_maker FROM wrow WHERE scope = ? ORDER BY time DESC').all(scope) as Array<Record<string, unknown>>;
    return rows.map((r) => [
      String(r.id), Number(r.time), r.symbol as string | null, r.side as string | null, r.price as string | null, r.qty as string | null,
      r.quote as string | null, r.fee as string | null, r.fee_coin as string | null, r.is_maker as 0 | 1 | null,
    ]);
  }

  dropScope(scope: string): void {
    this.db.prepare('DELETE FROM wrow WHERE scope = ?').run(scope);
    this.db.prepare('DELETE FROM wstate WHERE scope = ?').run(scope);
  }

  cachedCount(scope: string): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM wrow WHERE scope = ?').get(scope) as { n: number }).n);
  }

  /** A wallet someone is waiting for: it goes first. */
  demand(address: string, at = Date.now()): void {
    this.db.prepare('INSERT OR IGNORE INTO wdemand (address, at) VALUES (?, ?)').run(address.toLowerCase(), at);
  }

  takeDemand(): string | null {
    const r = this.db.prepare('SELECT address FROM wdemand ORDER BY at LIMIT 1').get() as { address: string } | undefined;
    if (!r) return null;
    this.db.prepare('DELETE FROM wdemand WHERE address = ?').run(r.address);
    return r.address;
  }

  /** Every scope of the wallet reached the end of what SoDEX keeps. */
  isDone(address: string): boolean {
    return SCOPE_KINDS.every((k) => this.readState(scopeKey(k, address)).complete);
  }

  doneCount(): number {
    const r = this.db.prepare(`SELECT COUNT(*) AS n FROM wstate WHERE scope LIKE 'funding|%' AND json_extract(state, '$.complete') = 1`).get() as { n: number };
    return Number(r.n);
  }
}

export interface BackfillAccount { address: string; trades: number; lastDay: number | null }

/**
 * Who is read when. Most recently active first, so the people likely to connect are ready soonest; wallets with no
 * recorded activity last. A market maker is left out: SoDEX keeps only its latest ~10,000 rows anyway.
 */
export function backfillOrder(accounts: readonly BackfillAccount[], marketMakerAt: number): string[] {
  return accounts
    .filter((a) => a.trades < marketMakerAt)
    .sort((a, b) => (b.lastDay ?? -1) - (a.lastDay ?? -1) || b.trades - a.trades)
    .map((a) => a.address.toLowerCase());
}

/** Held trades from here up (an undercount, the index lost prints): a market maker. 58 accounts on 2026-11-06. */
export const MARKET_MAKER_TRADES = 10_000;

const RESYNC_AFTER_MS = 15 * 60_000;
const RATE_LIMIT_PAUSE_MS = 30 * 60_000;
const FUNDING_PER_MIN = 60;

export interface BackfillDeps {
  db: WalletHistoryDb;
  /** The page reader for a scope of a wallet. */
  pageSource(kind: ScopeKind, address: string): PageFetcher;
  /** `/trades` reads a minute. */
  tradesPerMin: number;
  /** Who to read, in order. Called whenever the list ran out. */
  accounts(): BackfillAccount[];
  /** How long to stand back now (a cooldown, the weight budget). */
  gate(): number;
  isRateLimited(e: unknown): boolean;
  log(line: string): void;
  now?(): number;
  sleep?(ms: number): Promise<void>;
}

export class WalletBackfill {
  private stopped = false;
  private lastTrades = 0;
  private lastFunding = 0;
  private pausedUntil = 0;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly sync: HistorySync;
  private queue: string[] = [];
  private loop: Promise<void> | null = null;
  private lastLog = 0;
  /** Wallets read in this process (tests and the log). */
  walked = 0;

  constructor(private readonly d: BackfillDeps) {
    this.now = d.now ?? Date.now;
    this.sleep = d.sleep ?? ((ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); }));
    this.sync = createHistorySync({
      store: d.db,
      pageSource: (kind, address) => this.paced(kind, d.pageSource(kind, address)),
      paced: (f) => f,
      resyncAfterMs: RESYNC_AFTER_MS,
      now: this.now,
      // Each wallet costs a read per scope, not two: this is what makes the whole list possible at 2 reads a minute. A
      // page shorter than the limit already means nothing older exists; the browser's all-time perps check against
      // SoDEX's lifetime volume is what would catch one that lied.
      shortPageEnds: true,
    });
  }

  private paced(kind: ScopeKind, read: PageFetcher): PageFetcher {
    return async (q: PageQuery) => {
      const trades = kind !== 'funding';
      const gap = 60_000 / (trades ? this.d.tradesPerMin : FUNDING_PER_MIN);
      for (;;) {
        if (this.stopped) throw new Error('stopping');
        const wait = Math.max(this.pausedUntil - this.now(), this.d.gate(), (trades ? this.lastTrades : this.lastFunding) + gap - this.now());
        if (wait <= 0) break;
        await this.sleep(Math.min(wait, 5_000));
      }
      if (trades) this.lastTrades = this.now();
      else this.lastFunding = this.now();
      try {
        return await read(q);
      } catch (e) {
        if (this.d.isRateLimited(e)) this.pausedUntil = this.now() + RATE_LIMIT_PAUSE_MS;
        throw e;
      }
    };
  }

  /** One wallet, all three scopes. */
  async walk(address: string): Promise<void> {
    for (const kind of SCOPE_KINDS) {
      if (this.stopped) return;
      this.sync.ensureSync(kind, address);
      await this.sync.settled(kind, address);
    }
    this.walked++;
  }

  /** The next wallet: someone waiting, else the list. null: nobody left for now. */
  next(): string | null {
    const asked = this.d.db.takeDemand();
    if (asked) return asked;
    if (this.queue.length === 0) this.queue = backfillOrder(this.d.accounts(), MARKET_MAKER_TRADES).reverse();
    while (this.queue.length > 0) {
      const a = this.queue.pop()!;
      if (!this.d.db.isDone(a)) return a;
    }
    return null;
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      const address = this.next();
      if (!address) { await this.sleep(60_000); continue; }
      try {
        await this.walk(address);
      } catch (e) {
        this.d.log(`wallet backfill: ${address.slice(0, 10)}: ${String((e as Error)?.message ?? e).slice(0, 160)}`);
      }
      if (this.now() - this.lastLog > 10 * 60_000) {
        this.lastLog = this.now();
        this.d.log(`wallet backfill: ${this.d.db.doneCount()} wallets done, ${this.queue.length} left in this pass`);
      }
    }
  }

  start(): void {
    this.loop ??= this.run();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.loop?.catch(() => {});
  }
}

// --- the API's side ----------------------------------------------------------------------

let reader: WalletHistoryDb | null = null;

/** What the server holds for a wallet's scope; asks for the wallet if it is not there yet. null: no file to read. */
export function walletHistoryFor(address: string, kind: ScopeKind): { state: ScopeState | null; rows: PackedRow[] } | null {
  try {
    reader ??= new WalletHistoryDb();
  } catch {
    return null;
  }
  const scope = scopeKey(kind, address);
  const state = reader.readState(scope);
  if (!state.complete) reader.demand(address);
  if (state.updatedAt === 0) return { state: null, rows: [] };
  return { state, rows: reader.packed(scope) };
}
