/**
 * Offline compaction of the index file. Run it with the indexer AND the API
 * STOPPED (it needs the file to itself):
 *
 *   npx tsx --disable-warning=ExperimentalWarning src/indexer/compact.ts [path] [--prune] [--force]
 *
 * What it does, in order:
 *   --prune   first runs one whole retention sweep (store.pruneNow), so the
 *             rewrite below does not copy rows that are about to go;
 *   then      `PRAGMA auto_vacuum = INCREMENTAL` + `VACUUM`: the file is
 *             rewritten without its free pages, and from then on the running
 *             indexer hands freed pages back by itself, 1 MB at a time
 *             (store.reclaimStep);
 *   then      the WAL is checkpointed and truncated.
 *
 * WHY THIS IS A SEPARATE, OFFLINE STEP. A file created before 2026-10-02 has
 * `auto_vacuum = 0`. SQLite can only switch that on by rewriting the whole
 * file (VACUUM), which holds an exclusive lock for as long as it takes -
 * about a minute per 1-2 GB - and needs free disk space of about the file's
 * size. The running indexer never does that: without this step it simply
 * reuses the pages retention frees, so the file stops growing but keeps its
 * size. A file created by the current code needs none of this.
 *
 * Read-only on everything except the index file itself. Nothing is fetched.
 */
import { existsSync, statSync, statfsSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { IndexStore, defaultDbPath } from './store.js';

const size = (p: string): number => (existsSync(p) ? statSync(p).size : 0);
const mb = (n: number): string => `${(n / 1_048_576).toFixed(1)} MB`;

export interface CompactResult {
  before: { db: number; wal: number; pages: number; free: number; autoVacuum: number };
  after: { db: number; wal: number; pages: number; free: number; autoVacuum: number };
  pruned: { days: number; fills: number; closes: number; dropped: number } | null;
  ms: number;
}

export function compact(path: string, o: { prune?: boolean; force?: boolean; now?: number } = {}): CompactResult {
  if (!existsSync(path)) throw new Error(`no index file at ${path}`);
  const t0 = Date.now();
  const store = new IndexStore(path);
  try {
    const pragma = (name: string): number => Number(Object.values(store.db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown>)[0]);
    const snap = () => ({ db: size(path), wal: size(`${path}-wal`), pages: pragma('page_count'), free: pragma('freelist_count'), autoVacuum: pragma('auto_vacuum') });
    const before = snap();
    if (!o.force) {
      // VACUUM writes a full copy next to the file before it replaces it.
      const fs = statfsSync(dirname(path));
      const room = Number(fs.bavail) * Number(fs.bsize);
      if (room < before.db * 1.1) throw new Error(`not enough free disk: ${mb(room)} free, the rewrite needs about ${mb(before.db * 1.1)} (--force to try anyway)`);
    }
    let pruned: CompactResult['pruned'] = null;
    if (o.prune) {
      const a = store.retention(o.now).totals;
      const b = store.pruneNow(o.now).totals;
      pruned = { days: b.days - a.days, fills: b.fills - a.fills, closes: b.closes - a.closes, dropped: b.dropped - a.dropped };
    }
    // Another connection (a running indexer or API) makes this fail with "database is locked": stop them first.
    store.db.exec('PRAGMA auto_vacuum = INCREMENTAL');
    store.db.exec('VACUUM');
    store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    return { before, after: snap(), pruned, ms: Date.now() - t0 };
  } finally {
    store.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const path = args.find((a) => !a.startsWith('--')) ?? defaultDbPath();
  try {
    const r = compact(path, { prune: args.includes('--prune'), force: args.includes('--force') });
    console.log(`[compact] ${path}`);
    if (r.pruned) console.log(`[compact] pruned: ${r.pruned.days} days frozen, ${r.pruned.fills} fills and ${r.pruned.closes} closes deleted behind them, ${r.pruned.dropped} rows dropped`);
    console.log(`[compact] before: ${mb(r.before.db)} + WAL ${mb(r.before.wal)}, ${r.before.free} free pages, auto_vacuum ${r.before.autoVacuum}`);
    console.log(`[compact] after:  ${mb(r.after.db)} + WAL ${mb(r.after.wal)}, ${r.after.free} free pages, auto_vacuum ${r.after.autoVacuum} (${Math.round(r.ms / 1000)} s)`);
  } catch (e) {
    console.error(`[compact] ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
