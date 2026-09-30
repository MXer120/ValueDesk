/**
 * The browser's copy of a wallet's walked history, in IndexedDB.
 *
 * The all-time Stats walk reads a wallet's whole fill and funding history, a
 * page every few seconds. The server kept what it had walked in SQLite; the
 * browser keeps it here, so a re-open is instant and a walk that was cut short
 * (tab closed, rate limit) resumes from its checkpoint instead of starting over.
 *
 * Nothing in here is secret - any wallet's fills are public on SoDEX - but it is
 * a record of which wallets this browser looked at, so it is bounded to the
 * WALLET_CAP most recently used wallets, and it stays on this device.
 *
 * Rows are stored per page (one record per write, not per row) as compact
 * tuples without the raw JSON; the id (a hash of that JSON) is what dedupes.
 * Every call resolves, never rejects: a browser without IndexedDB (or out of
 * quota) degrades to "walk again on every load", exactly like the server did
 * when its cache file could not be opened.
 */
import type { NormalRow } from '@sign/historyRows.js';
import type { ScopeState } from '@sign/historySync.js';
import { logger } from '../log';

const log = logger('history');

const DB_NAME = 'vs-history';
/**
 * Bumped whenever a change to the normalisers would make already-cached
 * columns mean something different: an upgrade wipes and re-walks rather than
 * mixing two vintages of parsing into one total (the server's SCHEMA_VERSION).
 */
const DB_VERSION = 1;
const STATE = 'state';
const CHUNKS = 'chunks';
const WALLETS = 'wallets';

/** Wallets whose history is kept; the least recently used beyond this is dropped. */
export const WALLET_CAP = 6;
/** More records than this for one scope get merged into a few big ones. */
const COMPACT_OVER = 64;
const COMPACT_ROWS = 5_000;

/** A row as stored: [id, time, symbol, side, price, qty, quote, fee, feeCoin, isMaker]. */
type Packed = [string, number, string | null, string | null, string | null, string | null, string | null, string | null, string | null, 0 | 1 | null];

const pack = (r: NormalRow): Packed => [
  r.id, Number.isFinite(r.time) ? r.time : 0, r.symbol, r.side, r.price, r.qty, r.quote, r.fee, r.feeCoin,
  r.isMaker === null ? null : r.isMaker ? 1 : 0,
];

const unpack = (p: Packed): NormalRow => ({
  id: p[0], time: p[1], symbol: p[2], side: p[3], price: p[4], qty: p[5], quote: p[6], fee: p[7], feeCoin: p[8],
  isMaker: p[9] === null ? null : p[9] === 1,
  raw: '',
});

interface ChunkRecord {
  scope: string;
  rows: Packed[];
}

interface StateRecord extends ScopeState {
  scope: string;
}

/** What the all-time walk needs from persistence (allTime.ts; tests pass an in-memory one). */
export interface HistoryPersistence {
  status(): { path: string; ok: boolean; error: string | null };
  /** The checkpoint alone (cheap): has another tab moved this scope on? */
  readState(scope: string): Promise<ScopeState | null>;
  /** Checkpoint and rows; null when persistence is unavailable. */
  readScope(scope: string): Promise<{ state: ScopeState | null; rows: NormalRow[] } | null>;
  appendRows(scope: string, rows: NormalRow[]): Promise<void>;
  putState(scope: string, state: ScopeState): Promise<void>;
  dropScope(scope: string): Promise<void>;
  /** Mark a wallet as used now; resolves with the wallets that fell out of the cap. */
  touchWallet(address: string): Promise<string[]>;
  forgetWallet(address: string): Promise<void>;
  /** Merge a scope's records (call with the scope held). */
  compact(scope: string): Promise<void>;
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

function stateOf(r: StateRecord | undefined): ScopeState | null {
  if (!r) return null;
  return { oldest: r.oldest, newest: r.newest, complete: r.complete, pages: r.pages, updatedAt: r.updatedAt, lastError: r.lastError };
}

export class IdbHistory implements HistoryPersistence {
  private db: Promise<IDBDatabase | null> | null = null;
  private error: string | null = null;
  /** Writes run one after another, in the order they were asked for. */
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly factory: IDBFactory | null = (globalThis as { indexedDB?: IDBFactory }).indexedDB ?? null) {}

  status() {
    return { path: `IndexedDB ${DB_NAME} (this browser)`, ok: this.error === null && this.factory !== null, error: this.factory ? this.error : 'IndexedDB is not available in this browser' };
  }

  private open(): Promise<IDBDatabase | null> {
    if (this.db) return this.db;
    this.db = new Promise<IDBDatabase | null>((resolve) => {
      if (!this.factory) return resolve(null);
      let req: IDBOpenDBRequest;
      try {
        req = this.factory.open(DB_NAME, DB_VERSION);
      } catch (e) {
        this.fail('open', e);
        return resolve(null);
      }
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const name of Array.from(db.objectStoreNames)) db.deleteObjectStore(name);
        db.createObjectStore(STATE, { keyPath: 'scope' });
        db.createObjectStore(CHUNKS, { autoIncrement: true }).createIndex('scope', 'scope');
        db.createObjectStore(WALLETS, { keyPath: 'address' });
      };
      req.onsuccess = () => {
        const db = req.result;
        // A newer tab upgrading the schema: step aside, reopen on next use.
        db.onversionchange = () => {
          db.close();
          this.db = null;
        };
        resolve(db);
      };
      req.onerror = () => {
        this.fail('open', req.error);
        resolve(null);
      };
    });
    return this.db;
  }

  private fail(what: string, e: unknown): void {
    this.error = `history cache ${what} failed: ${(e as Error)?.message ?? String(e)}`;
    log.warn(this.error);
  }

  /** Queue a write; it never rejects (a failure marks the cache unavailable). */
  private write(what: string, fn: (db: IDBDatabase) => Promise<void>): Promise<void> {
    const run = this.chain.then(async () => {
      const db = await this.open();
      if (!db) return;
      try {
        await fn(db);
      } catch (e) {
        this.fail(what, e);
      }
    });
    this.chain = run;
    return run;
  }

  async readState(scope: string): Promise<ScopeState | null> {
    await this.chain;
    const db = await this.open();
    if (!db) return null;
    try {
      return stateOf(await result(db.transaction(STATE, 'readonly').objectStore(STATE).get(scope) as IDBRequest<StateRecord | undefined>));
    } catch (e) {
      this.fail('read', e);
      return null;
    }
  }

  async readScope(scope: string): Promise<{ state: ScopeState | null; rows: NormalRow[] } | null> {
    await this.chain;
    const db = await this.open();
    if (!db) return null;
    try {
      // One transaction: the checkpoint and the rows it describes, as of the same moment.
      const tx = db.transaction([STATE, CHUNKS], 'readonly');
      const [st, chunks] = await Promise.all([
        result(tx.objectStore(STATE).get(scope) as IDBRequest<StateRecord | undefined>),
        result(tx.objectStore(CHUNKS).index('scope').getAll(IDBKeyRange.only(scope)) as IDBRequest<ChunkRecord[]>),
      ]);
      const rows: NormalRow[] = [];
      for (const c of chunks) for (const p of c.rows) rows.push(unpack(p));
      return { state: stateOf(st), rows };
    } catch (e) {
      this.fail('read', e);
      return null;
    }
  }

  appendRows(scope: string, rows: NormalRow[]): Promise<void> {
    if (rows.length === 0) return Promise.resolve();
    const record: ChunkRecord = { scope, rows: rows.map(pack) };
    return this.write('write', (db) => {
      const tx = db.transaction(CHUNKS, 'readwrite');
      tx.objectStore(CHUNKS).add(record);
      return done(tx);
    });
  }

  putState(scope: string, state: ScopeState): Promise<void> {
    const record: StateRecord = { scope, ...state };
    return this.write('write', (db) => {
      const tx = db.transaction(STATE, 'readwrite');
      tx.objectStore(STATE).put(record);
      return done(tx);
    });
  }

  dropScope(scope: string): Promise<void> {
    return this.write('drop', (db) => {
      const tx = db.transaction([STATE, CHUNKS], 'readwrite');
      tx.objectStore(STATE).delete(scope);
      const chunks = tx.objectStore(CHUNKS);
      const keys = chunks.index('scope').getAllKeys(IDBKeyRange.only(scope));
      keys.onsuccess = () => {
        for (const k of keys.result) chunks.delete(k);
      };
      return done(tx);
    });
  }

  async touchWallet(address: string): Promise<string[]> {
    const key = address.toLowerCase();
    let evicted: string[] = [];
    await this.write('write', async (db) => {
      const tx = db.transaction(WALLETS, 'readwrite');
      const wallets = tx.objectStore(WALLETS);
      wallets.put({ address: key, usedAt: Date.now() });
      const all = await result(wallets.getAll() as IDBRequest<Array<{ address: string; usedAt: number }>>);
      evicted = all
        .filter((w) => w.address !== key)
        .sort((a, b) => b.usedAt - a.usedAt)
        .slice(WALLET_CAP - 1)
        .map((w) => w.address);
      await done(tx);
    });
    return evicted;
  }

  forgetWallet(address: string): Promise<void> {
    return this.write('drop', (db) => {
      const tx = db.transaction(WALLETS, 'readwrite');
      tx.objectStore(WALLETS).delete(address.toLowerCase());
      return done(tx);
    });
  }

  compact(scope: string): Promise<void> {
    return this.write('compact', async (db) => {
      const tx = db.transaction(CHUNKS, 'readwrite');
      const chunks = tx.objectStore(CHUNKS);
      const index = chunks.index('scope');
      const n = await result(index.count(IDBKeyRange.only(scope)));
      if (n <= COMPACT_OVER) {
        await done(tx);
        return;
      }
      const [keys, records] = await Promise.all([
        result(index.getAllKeys(IDBKeyRange.only(scope))),
        result(index.getAll(IDBKeyRange.only(scope)) as IDBRequest<ChunkRecord[]>),
      ]);
      const seen = new Set<string>();
      const rows: Packed[] = [];
      for (const c of records) {
        for (const p of c.rows) {
          if (seen.has(p[0])) continue;
          seen.add(p[0]);
          rows.push(p);
        }
      }
      for (const k of keys) chunks.delete(k);
      for (let i = 0; i < rows.length; i += COMPACT_ROWS) chunks.add({ scope, rows: rows.slice(i, i + COMPACT_ROWS) } satisfies ChunkRecord);
      await done(tx);
    });
  }
}
