/**
 * The trade chart's kept series across a reload, in IndexedDB (seriesCache.ts keeps them for the
 * page's life). An Android tab restored or pulled to refresh gets its JavaScript from the HTTP
 * cache, and the 500-bar read became the wait for the first candle; the closed bars it showed a
 * moment ago are here, and a reload within KEPT_GAP_BARS bars (three minutes on 1m) draws them as
 * soon as the chart is up, under the same "As of" treatment as any kept series (Chart.tsx).
 *
 * Public market data only, at most STORED_SERIES series, the closed bars as one Float64Array per
 * series ([t, o, h, l, c, v, q] per bar, NaN for a missing number). Written every 30 s while the
 * page is shown, when something changed, and when it goes out of view (earlyBars.ts
 * installKeptPersistence: a write started as the page unloads is not reliably committed).
 * Every call resolves, never rejects: no IndexedDB (a private window, blocked storage, no quota)
 * means the chart loads from the network, as before.
 */
import type { KLineData } from 'klinecharts';
import type { KeptSeries } from './seriesCache';

const DB_NAME = 'vs-chart';
const DB_VERSION = 1;
const STORE = 'kept';
const RECORD = 'series';
/** Bump when the packed layout changes: an old record is then ignored, never misread. */
export const SERIES_SCHEMA = 1;
/** How many series survive a reload: the one on screen and the last two left. */
export const STORED_SERIES = 3;
/** Numbers per packed bar. */
const STRIDE = 7;

interface StoredSeries {
  key: string;
  at: number;
  more: boolean;
  unverifiedFrom: number | null;
  bars: Float64Array;
}

interface StoredRecord {
  schema: number;
  series: StoredSeries[];
}

const num = (v: number | undefined): number => (typeof v === 'number' && Number.isFinite(v) ? v : Number.NaN);

/** Closed bars into one typed array (structured clone copies it in one piece). */
export function packBars(bars: readonly KLineData[]): Float64Array {
  const out = new Float64Array(bars.length * STRIDE);
  bars.forEach((b, i) => {
    const o = i * STRIDE;
    out[o] = b.timestamp;
    out[o + 1] = b.open;
    out[o + 2] = b.high;
    out[o + 3] = b.low;
    out[o + 4] = b.close;
    out[o + 5] = num(b.volume);
    out[o + 6] = num(b.turnover);
  });
  return out;
}

/** The bars back, oldest first; a bar with a missing price is dropped (as toRows drops one). */
export function unpackBars(packed: Float64Array): KLineData[] {
  const out: KLineData[] = [];
  for (let o = 0; o + STRIDE <= packed.length; o += STRIDE) {
    const bar: KLineData = { timestamp: packed[o]!, open: packed[o + 1]!, high: packed[o + 2]!, low: packed[o + 3]!, close: packed[o + 4]! };
    if (![bar.timestamp, bar.open, bar.high, bar.low, bar.close].every(Number.isFinite)) continue;
    const v = packed[o + 5]!;
    const q = packed[o + 6]!;
    if (Number.isFinite(v)) bar.volume = v;
    if (Number.isFinite(q)) bar.turnover = q;
    out.push(bar);
  }
  return out;
}

export function toRecord(list: readonly KeptSeries[]): StoredRecord {
  return {
    schema: SERIES_SCHEMA,
    series: list.slice(0, STORED_SERIES).map((s) => ({ key: s.key, at: s.at, more: s.more, unverifiedFrom: s.unverifiedFrom, bars: packBars(s.bars) })),
  };
}

export function fromRecord(r: unknown): KeptSeries[] {
  const rec = r as Partial<StoredRecord> | null | undefined;
  if (!rec || rec.schema !== SERIES_SCHEMA || !Array.isArray(rec.series)) return [];
  const out: KeptSeries[] = [];
  for (const s of rec.series) {
    if (!s || typeof s.key !== 'string' || !(s.bars instanceof Float64Array) || !Number.isFinite(s.at)) continue;
    const bars = unpackBars(s.bars);
    if (!bars.length) continue;
    out.push({ key: s.key, at: s.at, more: s.more !== false, unverifiedFrom: typeof s.unverifiedFrom === 'number' ? s.unverifiedFrom : null, bars });
  }
  return out;
}

export class SeriesStore {
  private db: Promise<IDBDatabase | null> | null = null;

  constructor(private readonly factory: IDBFactory | null = (globalThis as { indexedDB?: IDBFactory }).indexedDB ?? null) {}

  private open(): Promise<IDBDatabase | null> {
    this.db ??= new Promise<IDBDatabase | null>((resolve) => {
      if (!this.factory) return resolve(null);
      try {
        const req = this.factory.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
    return this.db;
  }

  /** The kept series from the last page, newest first ([] when there are none or no IndexedDB). */
  async read(): Promise<KeptSeries[]> {
    const db = await this.open();
    if (!db) return [];
    try {
      return await new Promise<KeptSeries[]>((resolve) => {
        const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(RECORD);
        req.onsuccess = () => resolve(fromRecord(req.result));
        req.onerror = () => resolve([]);
      });
    } catch {
      return [];
    }
  }

  /** Replace what is stored with `list` (newest first; only the first STORED_SERIES are kept). */
  async write(list: readonly KeptSeries[]): Promise<void> {
    const db = await this.open();
    if (!db) return;
    try {
      await new Promise<void>((resolve) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(toRecord(list), RECORD);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
      });
    } catch {
      /* out of quota or storage blocked: the next load reads from the network */
    }
  }
}

export const seriesStore = new SeriesStore();
