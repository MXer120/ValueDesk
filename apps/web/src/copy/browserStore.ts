/**
 * The browser copier's books, in this browser only (IndexedDB 'vd-copy'):
 * its copies, their runtime state and activity, and the last views the
 * running tab published for the other tabs. Nothing here leaves the browser.
 * Without IndexedDB (some private windows) it is kept in memory, and copies
 * end with the tab.
 */
import { MemoryStore, structuredCopy, type ActivityEntry, type CopyStore, type CopyView, type SubState, type Subscription } from '@copy-engine';

const DB = 'vd-copy';
const VERSION = 1;
const ACTIVITY_CAP = 5_000;

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
      if (!db.objectStoreNames.contains('subs')) db.createObjectStore('subs', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('states')) db.createObjectStore('states', { keyPath: 'subId' });
      if (!db.objectStoreNames.contains('activity')) {
        const a = db.createObjectStore('activity', { keyPath: 'id' });
        a.createIndex('sub_at', ['subId', 'at']);
      }
      if (!db.objectStoreNames.contains('views')) db.createObjectStore('views', { keyPath: 'subscription.id' });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('IndexedDB unavailable'));
    r.onblocked = () => reject(new Error('IndexedDB is blocked by another tab'));
  });
}

export interface BrowserStore extends CopyStore {
  readonly persistent: boolean;
  /** Views the running tab published (for the other tabs). */
  views(): Promise<CopyView[]>;
  putViews(views: CopyView[]): Promise<void>;
}

class IdbStore implements BrowserStore {
  readonly persistent = true;
  private added = 0;
  constructor(private readonly db: IDBDatabase) {}

  private store(name: string, mode: IDBTransactionMode = 'readonly'): IDBObjectStore {
    return this.db.transaction(name, mode).objectStore(name);
  }

  async subscriptions(): Promise<Subscription[]> {
    return (await req(this.store('subs').getAll())) as Subscription[];
  }

  async subscription(id: string): Promise<Subscription | null> {
    return ((await req(this.store('subs').get(id))) as Subscription | undefined) ?? null;
  }

  async saveSubscription(s: Subscription): Promise<void> {
    await req(this.store('subs', 'readwrite').put(structuredCopy(s)));
  }

  async state(subId: string): Promise<SubState | null> {
    return ((await req(this.store('states').get(subId))) as SubState | undefined) ?? null;
  }

  async saveState(s: SubState): Promise<void> {
    await req(this.store('states', 'readwrite').put(structuredCopy(s)));
  }

  async addActivity(e: ActivityEntry): Promise<void> {
    await req(this.store('activity', 'readwrite').put(e));
    if (++this.added % 200 === 0) void this.trim();
  }

  async activity(q: { subId?: string; owner?: string; limit?: number; before?: number }): Promise<ActivityEntry[]> {
    const limit = q.limit ?? 200;
    const out: ActivityEntry[] = [];
    const s = this.store('activity');
    const range = q.subId ? IDBKeyRange.bound([q.subId, 0], [q.subId, q.before ?? Number.MAX_SAFE_INTEGER], false, true) : undefined;
    const source = q.subId ? s.index('sub_at') : s;
    await new Promise<void>((resolve, reject) => {
      const c = source.openCursor(range ?? null, 'prev');
      c.onerror = () => reject(c.error);
      c.onsuccess = () => {
        const cur = c.result;
        if (!cur || out.length >= limit) return resolve();
        const e = cur.value as ActivityEntry;
        if ((!q.owner || e.owner === q.owner) && (q.before === undefined || e.at < q.before)) out.push(e);
        cur.continue();
      };
    });
    return q.subId ? out : out.sort((a, b) => b.at - a.at);
  }

  async views(): Promise<CopyView[]> {
    return (await req(this.store('views').getAll())) as CopyView[];
  }

  async putViews(views: CopyView[]): Promise<void> {
    const s = this.store('views', 'readwrite');
    await req(s.clear());
    for (const v of views) await req(s.put(structuredCopy(v)));
  }

  /** Keep the newest ACTIVITY_CAP entries. */
  private async trim(): Promise<void> {
    const s = this.store('activity', 'readwrite');
    const n = await req(s.count());
    if (n <= ACTIVITY_CAP) return;
    let drop = n - ACTIVITY_CAP;
    const all = (await req(s.getAll())) as ActivityEntry[];
    all.sort((a, b) => a.at - b.at);
    const w = this.store('activity', 'readwrite');
    for (const e of all) {
      if (drop-- <= 0) break;
      w.delete(e.id);
    }
  }
}

class MemoryBrowserStore extends MemoryStore implements BrowserStore {
  readonly persistent = false;
  private v: CopyView[] = [];
  async views(): Promise<CopyView[]> {
    return structuredCopy(this.v);
  }
  async putViews(views: CopyView[]): Promise<void> {
    this.v = structuredCopy(views);
  }
}

let opened: Promise<BrowserStore> | null = null;

export function openBrowserStore(): Promise<BrowserStore> {
  return (opened ??= (async () => {
    try {
      if (typeof indexedDB === 'undefined') return new MemoryBrowserStore();
      return new IdbStore(await open());
    } catch {
      return new MemoryBrowserStore();
    }
  })());
}
