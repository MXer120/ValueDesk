/**
 * All-time account history on the server: the on-disk cache, the gateway page
 * sources and the walk pacing, bound to the shared sync engine
 * (historySync.ts) and the shared totals (historyStats.ts). The browser runs
 * the very same engine against its own IndexedDB and its own IP's budget.
 *
 * Three things here are load-bearing and were each learned the hard way:
 *
 *  1. A FAILED PAGE IS NOT THE END OF HISTORY. Roughly one history page in twelve
 *     comes back HTTP 200 carrying an error envelope. `SodexClient.send` already
 *     refuses to read that as data and `request` already replays it, but the walk
 *     must also never wrap a page fetch in a try/catch that falls through to
 *     "no more rows" - that is precisely how a 50-page walk truncated in silence
 *     and reported a confidently wrong all-time total. A throw here aborts the
 *     walk, is recorded as an error, and leaves `complete = false` so the next
 *     run resumes instead of enshrining a partial number as final.
 *
 *  2. `endTime` IS INCLUSIVE. The next page is requested with
 *     `endTime = min(time)` of the page just read - NOT `min(time) - 1`.
 *     Same-millisecond fills are real and common on this venue, so subtracting a
 *     millisecond drops every trade that shared the boundary instant. The cost of
 *     the inclusive bound is that the boundary rows come back again, which is
 *     what the `seen` set is for.
 *
 *  3. FEES ARE PER-COIN, NOT DOLLARS. Over a thousand live spot fills, every BUY
 *     was charged in the base coin (WSOSO, vAVAX, vARB...) and every SELL in
 *     vUSDC. Summing those into a single "$" figure would be arithmetic on
 *     unrelated units. Every fee and funding total here is therefore a bucket
 *     keyed by coin, and stays one all the way to the screen.
 *
 * Amounts are accumulated as exact decimal strings (historyStats.ts DecimalSum),
 * not floats: these are money totals over tens of thousands of rows, and the repo
 * already pays for exact decimal handling everywhere else.
 */
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { deviceKeyPath } from './deviceKey.js';
import { isRateLimited, sodex, weightFor, unwrapList } from './sodex/rest.js';
import { enginePath, type Engine } from './config.js';
import { symbols } from './sodex/symbols.js';
import { asString, normaliseFunding, normaliseTrade, setRowHasher, type NormalRow, type PageQuery } from './historyRows.js';
import { aggregateTradeRows, quoteCoinMap, type TradeStats } from './historyStats.js';
import { EMPTY_STATE, createHistorySync, type HistoryStore, type ScopeKind, type ScopeState } from './historySync.js';

// Rows and the backward pager are pure and shared with the browser: historyRows.ts.
export { normaliseFunding, normaliseTrade, walkBackwards, type NormalRow, type PageQuery, type WalkResult } from './historyRows.js';
// So are the totals (historyStats.ts) and the sync engine (historySync.ts).
export { DecimalSum, aggregateFunding, type CoinTotal, type FundingStats, type SymbolTotal, type TradeStats } from './historyStats.js';
export { SCOPE_KINDS, type ScopeKind, type SyncProgress } from './historySync.js';

// The row id is sha1-hex of the row's JSON either way; node:crypto hashes natively.
setRowHasher((raw) => createHash('sha1').update(raw).digest('hex'));

// --- tunables ----------------------------------------------------------------

/** How long a completed sync is considered fresh before an auto re-sync. */
const RESYNC_AFTER_MS = 5 * 60_000;

// --- page sources ------------------------------------------------------------

const qsOf = (q: PageQuery): string => {
  const p = new URLSearchParams();
  if (q.startTime !== undefined) p.set('startTime', String(q.startTime));
  if (q.endTime !== undefined) p.set('endTime', String(q.endTime));
  p.set('limit', String(q.limit));
  return p.toString();
};

/**
 * Calls the gateway through `sodex.get`, not through our own HTTP routes.
 *
 * Same upstream path and same query contract as routes/account.ts, but going
 * through the client directly inherits its retry, its backoff and - critically -
 * its refusal to read an error envelope as an empty page. Looping back through
 * our own server would add a hop and lose the typed failure.
 *
 * The explicit weight is required: `request` would otherwise call `weightFor`
 * with no limit and bill a 1000-row page at the 20-weight floor, overdrawing the
 * shared budget and earning a 429 that looks like it came from nowhere.
 */
/**
 * One caveat worth knowing about, recorded rather than worked around: the spot
 * `/trades` endpoint has been reported (mid-2026) to reject a `limit` sent
 * WITHOUT a `symbol`. It did not reproduce on re-testing - an unfiltered
 * limit=1000 page answers `code: 0` - so the walk sends the limit, which it needs
 * for the weight arithmetic to be honest. If the venue ever regresses, the page
 * throws and the walk records an error; it does NOT come back as an empty page
 * and quietly zero the spot totals, which is how that bug hid last time.
 */
function tradePage(engine: Engine, address: string) {
  return async (q: PageQuery): Promise<NormalRow[]> => {
    const path = `${enginePath(engine)}/accounts/${address}/trades?${qsOf(q)}`;
    const data = await sodex.get<unknown>(path, weightFor(path, q.limit));
    return unwrapList<Record<string, unknown>>(data, 'trades').map(normaliseTrade);
  };
}

function fundingPage(address: string) {
  return async (q: PageQuery): Promise<NormalRow[]> => {
    // `/fundings`, not the documented `/funding-history` - the latter 404s.
    const path = `${enginePath('perps')}/accounts/${address}/fundings?${qsOf(q)}`;
    const data = await sodex.get<unknown>(path, weightFor(path, q.limit));
    return unwrapList<Record<string, unknown>>(data, 'fundings').map(normaliseFunding);
  };
}

// --- aggregation -------------------------------------------------------------

/**
 * Map symbol -> quote coin, so notional can be bucketed by the unit it is
 * actually denominated in. A symbol we cannot resolve buckets under `null`
 * rather than being folded into whichever coin happens to be most common.
 */
async function quoteCoins(engine: Engine): Promise<Map<string, string>> {
  try {
    return quoteCoinMap(await symbols(engine));
  } catch {
    // Symbol metadata is a nicety here, not a prerequisite. Losing it costs the
    // volume bucket its label, which the panel shows as "unlabelled".
    return new Map();
  }
}

export async function aggregateTrades(engine: Engine, rows: NormalRow[]): Promise<TradeStats> {
  return aggregateTradeRows(await quoteCoins(engine), rows);
}

// --- on-disk cache -----------------------------------------------------------

/**
 * Cache location: the per-user data directory, NOT beside the source.
 *
 * This file holds the account's full order and trade history, and it used to
 * live at `server/.stats-cache.db` - inside the OneDrive-synced project folder,
 * where it grew past half a gigabyte and replicated every rewrite to Microsoft's
 * cloud and to every other machine on the account. `.gitignore` does not stop
 * cloud sync; only the path does.
 *
 * Same directory as the device key and the local API token, for the same
 * reason. It holds no secret material, so this is a privacy and sync-churn fix
 * rather than a key-compromise one - but the reasoning that put device.key
 * outside the project applies here just as directly.
 *
 * `node:sqlite` is a Node built-in on this runtime, so this adds no dependency -
 * which is the whole reason it is used instead of a real database driver.
 */
export const statsDbPath = (): string => {
  const override = process.env.VALUETRADE_STATS_DB?.trim();
  if (override) return override;
  const dir = dirname(deviceKeyPath());
  mkdirSync(dir, { recursive: true });
  return join(dir, 'stats-cache.db');
};

/**
 * Bumped whenever a change to the normalisers would make already-cached columns
 * mean something different. A mismatch wipes the cache and re-walks rather than
 * mixing two vintages of parsing into one total.
 */
const SCHEMA_VERSION = 1;

let db: DatabaseSync | null = null;
let dbError: string | null = null;
let dbTried = false;
/** Resolved on first open, so a late `.env` load still wins. */
let dbPath = '';

/**
 * Opens the cache lazily and never throws.
 *
 * A cache that cannot be opened must degrade to "walk every time", not to "the
 * Stats panel is broken", so every caller below treats `null` as simply having
 * no cache.
 */
function store(): DatabaseSync | null {
  if (dbTried) return db;
  dbTried = true;
  dbPath = statsDbPath();
  try {
    const d = new DatabaseSync(dbPath);
    d.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    const got = d.prepare(`SELECT value FROM meta WHERE key = 'schema'`).get() as
      | { value?: string }
      | undefined;
    if (got?.value !== String(SCHEMA_VERSION)) {
      d.exec(`DROP TABLE IF EXISTS rows_; DROP TABLE IF EXISTS sync_state;`);
      d.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('schema', ?)`).run(
        String(SCHEMA_VERSION),
      );
    }
    d.exec(`
      CREATE TABLE IF NOT EXISTS rows_ (
        scope TEXT NOT NULL,
        id TEXT NOT NULL,
        time INTEGER NOT NULL,
        symbol TEXT,
        side TEXT,
        price TEXT,
        qty TEXT,
        quote TEXT,
        fee TEXT,
        fee_coin TEXT,
        is_maker INTEGER,
        raw TEXT NOT NULL,
        PRIMARY KEY (scope, id)
      );
      CREATE INDEX IF NOT EXISTS rows_scope_time ON rows_ (scope, time);
      CREATE TABLE IF NOT EXISTS sync_state (
        scope TEXT PRIMARY KEY,
        oldest INTEGER,
        newest INTEGER,
        complete INTEGER NOT NULL DEFAULT 0,
        pages INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL DEFAULT 0,
        last_error TEXT
      );
    `);
    db = d;
  } catch (e) {
    dbError = (e as Error).message;
    db = null;
  }
  return db;
}

export const cacheStatus = (): { path: string; ok: boolean; error: string | null } => {
  store();
  return { path: dbPath, ok: db !== null, error: dbError };
};

function readState(scope: string): ScopeState {
  const d = store();
  if (!d) return { ...EMPTY_STATE };
  const r = d.prepare(`SELECT * FROM sync_state WHERE scope = ?`).get(scope) as
    | Record<string, unknown>
    | undefined;
  if (!r) return { ...EMPTY_STATE };
  return {
    oldest: typeof r.oldest === 'number' ? r.oldest : null,
    newest: typeof r.newest === 'number' ? r.newest : null,
    complete: Number(r.complete ?? 0) === 1,
    pages: Number(r.pages ?? 0),
    updatedAt: Number(r.updated_at ?? 0),
    lastError: typeof r.last_error === 'string' ? r.last_error : null,
  };
}

function writeState(scope: string, s: ScopeState): void {
  const d = store();
  if (!d) return;
  d.prepare(
    `INSERT OR REPLACE INTO sync_state (scope, oldest, newest, complete, pages, updated_at, last_error)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(scope, s.oldest, s.newest, s.complete ? 1 : 0, s.pages, s.updatedAt, s.lastError);
}

function saveRows(scope: string, rows: NormalRow[]): number {
  const d = store();
  if (!d || rows.length === 0) return 0;
  const stmt = d.prepare(
    `INSERT OR REPLACE INTO rows_ (scope, id, time, symbol, side, price, qty, quote, fee, fee_coin, is_maker, raw)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  // One transaction: tens of thousands of individual commits would make a long
  // walk disk-bound rather than network-bound.
  d.exec('BEGIN');
  try {
    for (const r of rows) {
      stmt.run(
        scope,
        r.id,
        Number.isFinite(r.time) ? r.time : 0,
        r.symbol,
        r.side,
        r.price,
        r.qty,
        r.quote,
        r.fee,
        r.feeCoin,
        // node:sqlite binds only null/number/bigint/string/Uint8Array - a boolean
        // would throw and abort the whole transaction.
        r.isMaker === null ? null : r.isMaker ? 1 : 0,
        r.raw,
      );
    }
    d.exec('COMMIT');
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
  return rows.length;
}

function loadRows(scope: string): NormalRow[] {
  const d = store();
  if (!d) return [];
  const out: NormalRow[] = [];
  for (const r of d.prepare(`SELECT * FROM rows_ WHERE scope = ? ORDER BY time DESC`).all(scope)) {
    const o = r as Record<string, unknown>;
    out.push({
      id: String(o.id ?? ''),
      time: Number(o.time ?? 0),
      symbol: asString(o.symbol),
      side: asString(o.side),
      price: asString(o.price),
      qty: asString(o.qty),
      quote: asString(o.quote),
      fee: asString(o.fee),
      feeCoin: asString(o.fee_coin),
      isMaker: o.is_maker === null || o.is_maker === undefined ? null : Number(o.is_maker) === 1,
      raw: String(o.raw ?? ''),
    });
  }
  return out;
}

function dropScope(scope: string): void {
  const d = store();
  if (!d) return;
  d.prepare(`DELETE FROM rows_ WHERE scope = ?`).run(scope);
  d.prepare(`DELETE FROM sync_state WHERE scope = ?`).run(scope);
}

// --- sync jobs ---------------------------------------------------------------

function cachedCount(scope: string): number {
  const d = store();
  if (!d) return 0;
  const r = d.prepare(`SELECT COUNT(*) AS n FROM rows_ WHERE scope = ?`).get(scope) as
    | { n?: number }
    | undefined;
  return Number(r?.n ?? 0);
}

function pageSource(kind: ScopeKind, address: string): (q: PageQuery) => Promise<NormalRow[]> {
  if (kind === 'trades-spot') return tradePage('spot', address);
  if (kind === 'trades-perps') return tradePage('perps', address);
  return fundingPage(address);
}

/**
 * BACKGROUND WALKS ARE THE LOWEST PRIORITY TRAFFIC. A market maker's history is
 * thousands of pages; walked flat out it spent the shared budget and got this
 * IP rate-limited by SoDEX's Cloudflare, so every panel on every page stopped
 * loading. Now every walk page (all scopes together) waits:
 *   - at least WALK_GAP_MS after the previous one,
 *   - while the shared budget is more than half spent (interactive reads first),
 *   - while a rate-limit cooldown is running (and gives up if it is long - the
 *     next sync resumes from the checkpoint).
 */
const WALK_GAP_MS = 6_000;
/** After SoDEX rate-limits a walk page, every background walk stays off this long. */
const WALK_PAUSE_AFTER_429_MS = 30 * 60_000;
let lastWalkPage = 0;
let walksPausedUntil = 0;
function paced<Q, R>(fetchPage: (q: Q) => Promise<R>): (q: Q) => Promise<R> {
  return async (q: Q) => {
    for (;;) {
      if (Date.now() < walksPausedUntil) throw new Error('SoDEX rate-limited this server - background history walks are paused.');
      const cool = sodex.cooldownLeft();
      // Any endpoint cooling down: a background walk does not add to it.
      if (cool > 0) {
        walksPausedUntil = Math.max(walksPausedUntil, Date.now() + Math.min(WALK_PAUSE_AFTER_429_MS, cool * 4));
        throw new Error('SoDEX is rate limiting this server - the walk resumes later.');
      }
      const gap = lastWalkPage + WALK_GAP_MS - Date.now();
      const wait = Math.max(gap, sodex.budgetSpent() > sodex.weightLimit() / 2 ? 3_000 : 0);
      if (wait <= 0) break;
      await new Promise((r) => setTimeout(r, wait));
    }
    lastWalkPage = Date.now();
    try {
      return await fetchPage(q);
    } catch (e) {
      if (isRateLimited(e)) walksPausedUntil = Date.now() + WALK_PAUSE_AFTER_429_MS;
      throw e;
    }
  };
}

const sqliteStore: HistoryStore = { readState, writeState, saveRows, loadRows, dropScope, cachedCount };

const engine = createHistorySync({ store: sqliteStore, pageSource, paced, resyncAfterMs: RESYNC_AFTER_MS });

/**
 * Start a sync for one scope if one is not already running and the cache is
 * stale, incomplete, or absent. Returns immediately - the walk continues in the
 * background and the caller polls `progressOf`.
 */
export function ensureSync(kind: ScopeKind, address: string, rebuild = false): void {
  engine.ensureSync(kind, address, rebuild);
}

/** Current progress for one scope, whether or not a walk is in flight. */
export const progressOf = engine.progressOf;

export const isSyncing = engine.isSyncing;

/** Everything cached for one scope, newest first. */
export const rowsFor = engine.rowsFor;

/** Test/maintenance hook: forget everything cached for an address. */
export const clearAddress = engine.clearAddress;
