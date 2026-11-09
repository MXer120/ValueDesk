/**
 * The indexer's fill writes inline (50-row steps on its one thread) against the writer thread (indexer/writerThread.ts).
 *
 *   node --import tsx tools/writeBench.ts [--fills=5000000] [--addrs=200000] [--rate=3000] [--secs=60] [--drain=300000]
 *        [--cacheMb=256] [--mode=inline,thread,thread-mmap] [--mmapMb=65536] [--mmapCacheMb=<cacheMb>] [--checkpointer=1]
 *        [--ownWrites=1] [--dir=<folder>]
 *
 * Builds a scratch index once (`--fills` rows over `--addrs` wallets and 30 days, random ids as Hyperliquid's are; kept in
 * `--dir` for the next run), then for each mode, through the real Indexer.flush every 5 s:
 *   steady  `--rate` stream rows a second for `--secs`, while this thread does a small write every 250 ms (as the day sums
 *           do) and 200 reads of a wallet's rows a second: this thread's busy share (eventLoopUtilization), its waits for
 *           the write lock (p50 / p99 / max), its reads' time, rows written a second and the backlog every 5 s;
 *           Once a second also a board-like pass: 50 wallets' windowStats (7d), realized (30d) and closeEvidence (30d), the
 *           reads a board build and the stats sweep make; the time per wallet is reported.
 *   drain   `--drain` rows in one flush: how long until all are written, and this thread's busy share meanwhile.
 * A mode with `-mmap` sets PRAGMA mmap_size = `--mmapMb` on this thread's connection and its page cache to `--mmapCacheMb`:
 * pages another connection's commit made stale are then read through the mapping, not copied by a read call.
 * `--cacheMb` sets the page cache of both connections: the production writer has 6 GB against a 50 GB file, so a laptop's
 * small file only behaves alike with a cache of a like share.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';

const arg = (name: string, dflt: string): string => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? dflt;
const FILLS = Number(arg('fills', '5000000'));
const ADDRS = Number(arg('addrs', '200000'));
const RATE = Number(arg('rate', '3000'));
const SECS = Number(arg('secs', '60'));
const DRAIN = Number(arg('drain', '300000'));
const CACHE_KB = Number(arg('cacheMb', '256')) * 1024;
const MODES = arg('mode', 'inline,thread,thread-mmap').split(',');
const MMAP_BYTES = Number(arg('mmapMb', '65536')) * 1024 * 1024;
const MMAP_CACHE_KB = Number(arg('mmapCacheMb', String(CACHE_KB / 1024))) * 1024;
/** The checkpoint thread as in production (checkpointer.ts); 0: each writer checkpoints for itself. */
const CHECKPOINTER = arg('checkpointer', '1') !== '0';
/** This thread's own small write every 250 ms; 0: none (each one empties the other connection's page cache). */
const OWN_WRITES = arg('ownWrites', '1') !== '0';
const DIR = arg('dir', join(tmpdir(), 'vs-write-bench'));
mkdirSync(DIR, { recursive: true });
const PATH = join(DIR, `index-${FILLS}-${ADDRS}.db`);
process.env.VALUESCAN_INDEX_DB = PATH;
process.env.VALUESCAN_INDEX_COHORTS = '0';
process.env.VALUESCAN_STALL_PROFILE = '0';

const { IndexStore } = await import('../src/indexer/store.js');
const { FILL_UPSERT } = await import('../src/indexer/writerThread.js');
const { Indexer } = await import('../src/indexer/engine.js');
type FillRow = import('../src/indexer/store.js').FillRow;

let seed = 11;
const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
const addr = (i: number) => `0x${i.toString(16).padStart(40, '0')}`;
const DAY = 86_400_000;

function build(): void {
  if (existsSync(PATH)) return;
  const t0 = Date.now();
  new IndexStore(PATH).close();
  const db = new DatabaseSync(PATH);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = OFF; PRAGMA cache_size = -1000000');
  const ins = db.prepare(FILL_UPSERT);
  const now = Date.now();
  for (let off = 0; off < FILLS; off += 100_000) {
    db.exec('BEGIN');
    for (let i = off; i < Math.min(FILLS, off + 100_000); i++) {
      const a = Math.floor(rnd() ** 2 * ADDRS);
      ins.run('hyperliquid', addr(a), String(Math.floor(rnd() * 1e15)), now - Math.floor(rnd() * 30 * DAY), 'BTC', rnd() < 0.5 ? 1 : -1, 100, 1, 0.01, null, `o${i}`, 1);
    }
    db.exec('COMMIT');
    if ((off / 100_000) % 10 === 9) console.log(`  built ${off + 100_000} rows, ${Math.round((Date.now() - t0) / 1000)} s`);
  }
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
  console.log(`scratch index: ${FILLS} fills over ${ADDRS} wallets in ${Math.round((Date.now() - t0) / 1000)} s`);
}

const pct = (xs: number[], p: number) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))]! : 0);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Ix { pendingFills: FillRow[]; flush(): void; writes: { backlog: number } }

async function run(name: string): Promise<void> {
  const mode = name.startsWith('thread') ? 'thread' : 'inline';
  const mmap = name.endsWith('-mmap');
  const store = new IndexStore(PATH, { aggRefreshMs: 600_000 });
  store.db.exec(`PRAGMA cache_size = -${mmap ? MMAP_CACHE_KB : CACHE_KB}`);
  store.db.exec(`PRAGMA mmap_size = ${mmap ? MMAP_BYTES : 0}`);
  if (CHECKPOINTER) store.startCheckpointer();
  if (mode === 'thread') store.startWriter({ force: true, cacheKb: CACHE_KB });
  const ix = new Indexer(store, () => Date.now()) as unknown as Ix;
  // Rows the file holds of this run: putFills returns once written (inline); the thread counts what it committed.
  let inlineDone = 0;
  const put = store.putFills.bind(store);
  store.putFills = (rows) => { put(rows); inlineDone += rows.length; };
  const done = () => (mode === 'thread' ? store.writerStatus!.rows : inlineDone);
  const tag = `${name}${Date.now()}-`;
  let made = 0;
  const make = (n: number) => {
    const now = Date.now();
    for (let k = 0; k < n; k++, made++) {
      ix.pendingFills.push({
        venue: 'hyperliquid', address: addr(Math.floor(rnd() ** 2 * ADDRS)), id: `${tag}${made}`, t: now - 2_000, symbol: 'BTC',
        side: rnd() < 0.5 ? 1 : -1, px: 100, sz: 1, fee: null, closedPnl: null, oid: null, src: 0,
      });
    }
  };
  const flusher = setInterval(() => ix.flush(), 5_000);
  // This thread's own small writes, as the day sums' every 250 ms.
  store.lockWaits.samples = [];
  const own = setInterval(() => { if (OWN_WRITES) store.tx(() => store.setMeta('bench_probe', String(Date.now()))); }, 250);
  // Steady.
  const elu0 = performance.eventLoopUtilization();
  const t0 = Date.now();
  const backlog: string[] = [];
  const reads: number[] = [];
  const probe = store.db.prepare("SELECT COUNT(*) AS n, MAX(px) AS p FROM fills WHERE venue = 'hyperliquid' AND address = ?");
  let next = t0;
  // Sampled halfway between flushes (they run every 5 s from the start), so a sample is not just the rows still unflushed.
  let lastSample = t0 - 2_500;
  const board: number[] = [];
  let boardAt = t0;
  const from7 = Date.now() - 7 * DAY;
  const from30 = Date.now() - 30 * DAY;
  while (Date.now() - t0 < SECS * 1_000) {
    next += 100;
    make(Math.round(RATE / 10));
    // This thread's own reads (a wallet's rows, as the day sums and board reads do): another connection's commit empties
    // a connection's page cache, so with the thread they are read back from the OS after each of its commits.
    for (let k = 0; k < 20; k++) {
      const r0 = performance.now();
      probe.get(addr(Math.floor(rnd() ** 2 * ADDRS)));
      reads.push(performance.now() - r0);
    }
    if (Date.now() - boardAt >= 1_000) {
      boardAt = Date.now();
      for (let k = 0; k < 50; k++) {
        const a = addr(Math.floor(rnd() ** 2 * ADDRS));
        const b0 = performance.now();
        store.windowStats('hyperliquid', a, from7);
        store.realized('hyperliquid', a, from30);
        store.closeEvidence('hyperliquid', a, from30);
        board.push(performance.now() - b0);
      }
    }
    if (Date.now() - lastSample >= 5_000) { lastSample = Date.now(); backlog.push(String(made - done())); }
    await sleep(Math.max(0, next - Date.now()));
  }
  const elu = performance.eventLoopUtilization(elu0);
  const secs = (Date.now() - t0) / 1_000;
  const waits = store.lockWaits.samples;
  store.lockWaits.samples = null;
  console.log(`${name} steady: ${RATE} rows/s offered for ${SECS} s; written ${Math.round(done() / secs)} rows/s; this thread busy ${(elu.utilization * 100).toFixed(1)}%;` +
    ` its lock wait p50 ${pct(waits, 0.5).toFixed(1)} ms, p99 ${pct(waits, 0.99).toFixed(1)} ms, max ${pct(waits, 1).toFixed(1)} ms (${waits.length} writes);` +
    ` its reads (a wallet's rows) p50 ${(pct(reads, 0.5) * 1000).toFixed(0)} us, p99 ${(pct(reads, 0.99) * 1000).toFixed(0)} us;` +
    ` board reads a wallet p50 ${pct(board, 0.5).toFixed(2)} ms, p99 ${pct(board, 0.99).toFixed(2)} ms, mean ${(board.reduce((x, y) => x + y, 0) / Math.max(1, board.length)).toFixed(2)} ms;` +
    ` backlog every 5 s: ${backlog.join(' ')}`);
  // Let the steady rows finish, then the drain.
  while (made - done() > 0) { ix.flush(); await sleep(200); }
  clearInterval(flusher);
  const before = done();
  make(DRAIN);
  const d0 = Date.now();
  const e0 = performance.eventLoopUtilization();
  ix.flush();
  while (done() - before < DRAIN) await sleep(20);
  const dms = Date.now() - d0;
  const de = performance.eventLoopUtilization(e0);
  console.log(`${name} drain: ${DRAIN} rows in ${(dms / 1000).toFixed(1)} s = ${Math.round(DRAIN / (dms / 1000))} rows/s; this thread busy ${(de.utilization * 100).toFixed(1)}%` +
    (mode === 'thread' ? `; transactions ${store.writerStatus!.txs}, longest ${store.writerStatus!.maxTxMs} ms` : ''));
  clearInterval(own);
  store.close();
}

build();
for (const m of MODES) await run(m);
process.exit(0);
