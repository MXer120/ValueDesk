/**
 * The browser's algo books, in this browser only (IndexedDB 'vd-algo'): the
 * algos, their logs, and the last views the running tab published for the
 * other tabs. Nothing here leaves the browser. Without IndexedDB (some
 * private windows) they are kept in memory and end with the tab.
 */
import { MemoryAlgoStore, structuredCopy, type AlgoEvent, type AlgoRecord, type AlgoStore, type AlgoView } from '@copy-engine';

const DB = 'vd-algo';
const VERSION = 1;
const EVENTS_CAP = 20_000;

const req = <T>(r: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('IndexedDB request failed'));
  });

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('algos')) db.createObjectStore('algos', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('events')) {
        const e = db.createObjectStore('events', { keyPath: 'id' });
        e.createIndex('algo_at', ['algoId', 'at']);
      }
      if (!db.objectStoreNames.contains('views')) db.createObjectStore('views', { keyPath: 'algo.id' });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('IndexedDB unavailable'));
    r.onblocked = () => reject(new Error('IndexedDB is blocked by another tab'));
  });
}

export interface BrowserAlgoStore extends AlgoStore {
  readonly persistent: boolean;
  views(): Promise<AlgoView[]>;
  putViews(views: AlgoView[]): Promise<void>;
}

class IdbAlgoStore implements BrowserAlgoStore {
  readonly persistent = true;
  private added = 0;
  constructor(private readonly db: IDBDatabase) {}

  private store(name: string, mode: IDBTransactionMode = 'readonly'): IDBObjectStore {
    return this.db.transaction(name, mode).objectStore(name);
  }

  async algos(): Promise<AlgoRecord[]> {
    return (await req(this.store('algos').getAll())) as AlgoRecord[];
  }

  async saveAlgo(a: AlgoRecord): Promise<void> {
    await req(this.store('algos', 'readwrite').put(structuredCopy(a)));
  }

  async addAlgoEvent(e: AlgoEvent): Promise<void> {
    await req(this.store('events', 'readwrite').put(e));
    if (++this.added % 500 === 0) void this.trim();
  }

  private async trim(): Promise<void> {
    const s = this.store('events', 'readwrite');
    const n = await req(s.count());
    if (n <= EVENTS_CAP) return;
    let drop = n - EVENTS_CAP;
    await new Promise<void>((resolve) => {
      const cur = s.openCursor();
      cur.onsuccess = () => {
        const c = cur.result;
        if (!c || drop <= 0) return resolve();
        c.delete();
        drop--;
        c.continue();
      };
      cur.onerror = () => resolve();
    });
  }

  async algoEvents(q: { algoId?: string; owner?: string; limit?: number; before?: number }): Promise<AlgoEvent[]> {
    const limit = q.limit ?? 200;
    const out: AlgoEvent[] = [];
    if (!q.algoId) {
      const all = ((await req(this.store('events').getAll())) as AlgoEvent[]).filter((e) => (!q.owner || e.owner === q.owner) && (q.before === undefined || e.at < q.before));
      return all.sort((a, b) => b.at - a.at).slice(0, limit);
    }
    const range = IDBKeyRange.bound([q.algoId, 0], [q.algoId, q.before === undefined ? Number.MAX_SAFE_INTEGER : q.before - 1]);
    await new Promise<void>((resolve, reject) => {
      const cur = this.store('events').index('algo_at').openCursor(range, 'prev');
      cur.onsuccess = () => {
        const c = cur.result;
        if (!c || out.length >= limit) return resolve();
        out.push(c.value as AlgoEvent);
        c.continue();
      };
      cur.onerror = () => reject(cur.error);
    });
    return out;
  }

  async views(): Promise<AlgoView[]> {
    return (await req(this.store('views').getAll())) as AlgoView[];
  }

  async putViews(views: AlgoView[]): Promise<void> {
    const s = this.store('views', 'readwrite');
    await req(s.clear());
    for (const v of views) s.put(structuredCopy(v));
  }
}

class MemoryBrowserAlgoStore extends MemoryAlgoStore implements BrowserAlgoStore {
  readonly persistent = false;
  private v: AlgoView[] = [];
  async views(): Promise<AlgoView[]> {
    return this.v;
  }
  async putViews(views: AlgoView[]): Promise<void> {
    this.v = structuredCopy(views);
  }
}

let shared: Promise<BrowserAlgoStore> | null = null;

export function openAlgoStore(): Promise<BrowserAlgoStore> {
  return (shared ??= (typeof indexedDB === 'undefined' ? Promise.reject(new Error('no IndexedDB')) : open())
    .then((db) => new IdbAlgoStore(db) as BrowserAlgoStore)
    .catch(() => new MemoryBrowserAlgoStore()));
}
