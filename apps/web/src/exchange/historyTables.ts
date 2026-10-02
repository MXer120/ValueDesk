/**
 * The account history tables (orders, fills, funding, closed positions), kept
 * in this browser between visits: per network, wallet, engine and kind, the
 * newest KEEP_ROWS rows as SoDEX answered them, the "load more" cursor after
 * them, and when they were read.
 *
 * SoDEX allows two history reads a minute per IP, so a table that had to wait
 * for SoDEX on every visit would sit on "Loading..." for up to a minute. With
 * this copy a table opens at once with what it showed last time and asks SoDEX
 * only for what is new (AccountHistory.tsx usePagedHistory).
 *
 * Bounded: KEEP_TABLES tables, the least recently used dropped. Nothing secret
 * (any wallet's history is public on SoDEX), and it stays on this device. Every
 * call resolves: without IndexedDB the tables simply read SoDEX as before.
 */
import { logger } from '../log';

const log = logger('history');

export interface StoredTable {
  /** Newest first, exactly as the gateway returned them. */
  rows: unknown[];
  /** The next older page's `endTime`; null when the table reached its end (or it is not known). */
  next: number | null;
  /** When SoDEX answered for the newest of these rows (ms). */
  fetchedAt: number;
  /** When SoDEX was asked for them (ms; absent: not known). */
  askedAt?: number;
}

const DB_NAME = 'vs-account-history';
const DB_VERSION = 1;
const STORE = 'tables';

/** Rows kept per table - the newest; the table shows them 100 at a time. */
export const KEEP_ROWS = 500;
/** Tables kept; the least recently used go first. */
export const KEEP_TABLES = 64;
const WRITE_DELAY_MS = 800;

/**
 * What to store of a table: at most KEEP_ROWS newest rows. When rows are cut,
 * the cursor moves to the oldest row kept (`endTime` is inclusive, so that row
 * comes back once and dedupes), so "load more" still continues seamlessly.
 */
export function trimForStore<T>(t: { rows: T[]; next: number | null; fetchedAt: number; askedAt?: number }, timeOf: (r: T) => number): StoredTable {
  const asked = t.askedAt ? { askedAt: t.askedAt } : {};
  if (t.rows.length <= KEEP_ROWS) return { rows: t.rows, next: t.next, fetchedAt: t.fetchedAt, ...asked };
  const rows = t.rows.slice(0, KEEP_ROWS);
  let min = Infinity;
  for (const r of rows) {
    const at = timeOf(r);
    if (Number.isFinite(at) && at > 0 && at < min) min = at;
  }
  return { rows, next: Number.isFinite(min) ? min : t.next, fetchedAt: t.fetchedAt, ...asked };
}

// --- what the account stream says a table must hold ----------------------------------------

/**
 * What the account stream has reported since a history table was last checked
 * against it. A push does not always mean a read: the read made for the user's
 * own action usually brought the fill already, and an order that is still open
 * is not in the order history at all (SoDEX lists filled, canceled, rejected
 * and expired orders there). With two history reads a minute, reading only
 * when the table really lacks something leaves a slot for the next table.
 */
export interface StreamWants {
  /** Fills pushed, as the trade history keys its rows: `symbol:tradeID:orderID`. */
  trades: Set<string>;
  /** Orders that reached a final state: orderID -> status. */
  orders: Map<string, string>;
  /** A push this could not read: the table reads, as it always did. */
  unknown: boolean;
}

export const newWants = (): StreamWants => ({ trades: new Set(), orders: new Map(), unknown: false });

/** An order in one of these states is still open, so not in the order history. */
const OPEN_ORDER = new Set(['NEW', 'PARTIALLY_FILLED']);

const present = (v: unknown): v is string | number => (typeof v === 'string' && v !== '') || typeof v === 'number';

/**
 * Note one push of an account channel. The gateway's stream rows are terse:
 * a fill is { s: symbol, t: trade id, i: order id, ... }, an order update
 * { i: order id, X: status, ... } (schema: WsSpotUserTrade, WsSpotOrderUpdate).
 */
export function notePush(w: StreamWants, channel: string, data: unknown): void {
  const list: unknown[] | null = Array.isArray(data) ? data : data && typeof data === 'object' ? [data] : null;
  if (!list) {
    w.unknown = true;
    return;
  }
  for (const item of list) {
    const r = (item ?? {}) as Record<string, unknown>;
    if (channel === 'accountTrade') {
      if (present(r.s) && present(r.t) && present(r.i)) w.trades.add(`${r.s}:${r.t}:${r.i}`);
      else w.unknown = true;
    } else if (channel === 'accountOrderUpdate') {
      if (!present(r.i) || typeof r.X !== 'string') w.unknown = true;
      else if (!OPEN_ORDER.has(r.X.toUpperCase())) w.orders.set(String(r.i), r.X.toUpperCase());
    } else {
      w.unknown = true;
    }
  }
}

/**
 * Whether a history already holds everything the stream reported for it, so
 * that no read is needed. `idOf` is the table's own row key.
 */
export function holdsAll(kind: 'orders' | 'trades' | 'funding' | 'positions', w: StreamWants, rows: readonly unknown[], idOf: (r: any) => string): boolean {
  if (w.unknown) return false;
  if (kind === 'trades') {
    if (w.trades.size === 0) return true;
    const have = new Set(rows.map(idOf));
    for (const id of w.trades) if (!have.has(id)) return false;
    return true;
  }
  if (kind === 'orders') {
    // Every fill comes with an update of its order, and only an order that
    // reached a final state enters the history: the fills themselves say nothing more.
    if (w.orders.size === 0) return true;
    const byId = new Map(rows.map((r) => [idOf(r), r as { status?: unknown }]));
    for (const [id, status] of w.orders) {
      if (String(byId.get(id)?.status ?? '').toUpperCase() !== status) return false;
    }
    return true;
  }
  // Closed positions and funding have no id a push names: any fill means read
  // (those two are not rate-limited the way orders and fills are).
  return w.trades.size === 0;
}

// --- the store --------------------------------------------------------------------------------

interface Record_ extends StoredTable {
  key: string;
  usedAt: number;
}

const done = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });

const result = <T>(r: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('IndexedDB request failed'));
  });

export class TableStore {
  private db: Promise<IDBDatabase | null> | null = null;
  private readonly pending = new Map<string, { value: StoredTable; timer: ReturnType<typeof setTimeout> }>();
  private broken = false;

  constructor(private readonly factory: IDBFactory | null = (globalThis as { indexedDB?: IDBFactory }).indexedDB ?? null) {}

  private open(): Promise<IDBDatabase | null> {
    if (this.db) return this.db;
    this.db = new Promise<IDBDatabase | null>((resolve) => {
      if (!this.factory || this.broken) return resolve(null);
      let req: IDBOpenDBRequest;
      try {
        req = this.factory.open(DB_NAME, DB_VERSION);
      } catch {
        this.broken = true;
        return resolve(null);
      }
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const name of Array.from(db.objectStoreNames)) db.deleteObjectStore(name);
        db.createObjectStore(STORE, { keyPath: 'key' }).createIndex('usedAt', 'usedAt');
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => {
          db.close();
          this.db = null;
        };
        resolve(db);
      };
      req.onerror = () => {
        this.broken = true;
        resolve(null);
      };
    });
    return this.db;
  }

  /** The stored table, or null (none, or no IndexedDB). A write still waiting is returned as it will be. */
  async get(key: string): Promise<StoredTable | null> {
    const queued = this.pending.get(key);
    if (queued) return queued.value;
    const db = await this.open();
    if (!db) return null;
    try {
      const r = await result(db.transaction(STORE, 'readonly').objectStore(STORE).get(key) as IDBRequest<Record_ | undefined>);
      return r ? { rows: r.rows, next: r.next, fetchedAt: r.fetchedAt, ...(r.askedAt ? { askedAt: r.askedAt } : {}) } : null;
    } catch (e) {
      log.debug('history table read failed', { error: String(e) });
      return null;
    }
  }

  /** Keep a table (written shortly after, the latest value wins). */
  put(key: string, value: StoredTable): void {
    const prev = this.pending.get(key);
    if (prev) clearTimeout(prev.timer);
    const timer = setTimeout(() => {
      this.pending.delete(key);
      void this.write(key, value);
    }, WRITE_DELAY_MS);
    this.pending.set(key, { value, timer });
  }

  private async write(key: string, value: StoredTable): Promise<void> {
    const db = await this.open();
    if (!db) return;
    try {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      store.put({ key, ...value, usedAt: Date.now() } satisfies Record_);
      // Over the cap: the least recently used tables go (keys only - no rows are read).
      const n = await result(store.count());
      if (n > KEEP_TABLES) {
        const oldest = await result(store.index('usedAt').getAllKeys(null, n - KEEP_TABLES));
        for (const k of oldest) store.delete(k);
      }
      await done(tx);
    } catch (e) {
      log.debug('history table write failed', { error: String(e) });
    }
  }
}

export const tableStore = new TableStore();
