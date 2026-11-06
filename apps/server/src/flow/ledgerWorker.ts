/**
 * The coverage ledger's own thread (ledger.ts). The indexer only starts it and reads its status: the calls to SoDEX, the
 * read-only looks at the flow and index files and every write to the ledger's file all happen here, so its loop can lag as
 * it likes and nothing waits on this. A thread that dies is started again a minute later.
 */
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { CoverageLedger, LedgerStore, TICK_MS, ledgerPathFor, type Kline, type LedgerStatus } from './ledger.js';
import { RestReader } from '../indexer/sodexCatchup.js';

export interface LedgerPaths {
  flow: string;
  index: string;
  /** Tests: a local fake of SoDEX, and a faster tick. */
  base?: string;
  tickMs?: number;
}

const RESTART_MS = 60_000;
const STATUS_MS = 30_000;

function run(paths: LedgerPaths): void {
  const store = new LedgerStore(ledgerPathFor(paths.flow));
  const reader = paths.base ? new RestReader(paths.base) : new RestReader();
  // Read-only, small caches: these are short indexed reads, a few every 15 minutes.
  let flow: DatabaseSync | null = null;
  const flowDb = (): DatabaseSync => {
    if (flow) return flow;
    flow = new DatabaseSync(paths.flow, { readOnly: true });
    flow.exec('PRAGMA busy_timeout = 2000; PRAGMA cache_size = -4000;');
    return flow;
  };
  let index: DatabaseSync | null = null;
  const indexDb = (): DatabaseSync => {
    if (index) return index;
    index = new DatabaseSync(paths.index, { readOnly: true });
    index.exec('PRAGMA busy_timeout = 2000; PRAGMA cache_size = -4000; PRAGMA mmap_size = 0;');
    return index;
  };
  const ledger = new CoverageLedger({
    store,
    symbols: reader.symbols,
    klines: async (engine, symbol, q) => {
      const r = await reader.klines(engine, symbol, q);
      return { rows: r.rows as Kline[], ...(r.limited ? { limited: true } : {}) };
    },
    heldOf: (symbol, from, to) => {
      const m = flowDb().prepare(`SELECT id FROM flow_market WHERE venue = 'sodex' AND symbol = ?`).get(symbol) as { id: number } | undefined;
      if (!m) return [];
      return flowDb().prepare('SELECT t, n FROM flow_chunk WHERE mid = ? AND t >= ? AND t < ?').all(m.id, from, to) as Array<{ t: number; n: number }>;
    },
    flowSince: () => {
      const r = flowDb().prepare(`SELECT value FROM meta WHERE key = 'since'`).get() as { value: string } | undefined;
      return Number(r?.value) || null;
    },
    activityOf: (day) => {
      // The primary key's range for one venue and day.
      const r = indexDb().prepare(`SELECT COUNT(*) AS c, COALESCE(SUM(volume), 0) AS v FROM activity_day WHERE venue = 'sodex' AND day = ?`).get(day) as { c: number; v: number };
      return r.v;
    },
  });
  setInterval(() => { void ledger.tick(); }, paths.tickMs ?? TICK_MS);
  const report = () => {
    try { parentPort?.postMessage({ type: 'status', status: ledger.status() }); } catch { /* the next one */ }
  };
  setInterval(report, paths.tickMs ? Math.max(50, paths.tickMs * 5) : STATUS_MS);
  void ledger.tick();
}

if (!isMainThread && (workerData as { coverageLedger?: LedgerPaths } | null)?.coverageLedger) {
  run((workerData as { coverageLedger: LedgerPaths }).coverageLedger);
}

export interface LedgerThread {
  status(): LedgerStatus | null;
  stop(): void;
}

export function startLedgerThread(paths: LedgerPaths, log: (line: string) => void = () => {}): LedgerThread {
  let status: LedgerStatus | null = null;
  let stopped = false;
  let worker: Worker | null = null;
  let timer: NodeJS.Timeout | undefined;
  const start = () => {
    if (stopped) return;
    const w = new Worker(new URL('./ledgerWorker.ts', import.meta.url), { workerData: { coverageLedger: paths }, resourceLimits: { maxOldGenerationSizeMb: 256 } });
    w.unref();
    worker = w;
    w.on('message', (m: { type?: string; status?: LedgerStatus }) => { if (m.type === 'status' && m.status) status = m.status; });
    w.on('error', (e) => log(`coverage ledger: ${String(e)}`));
    w.on('exit', () => {
      if (worker === w) worker = null;
      if (stopped) return;
      timer = setTimeout(start, RESTART_MS);
      timer.unref?.();
    });
  };
  start();
  return {
    status: () => status,
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      void worker?.terminate();
      worker = null;
    },
  };
}
