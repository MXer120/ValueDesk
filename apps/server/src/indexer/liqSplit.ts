/**
 * The level change log (liq_addr, liq_log, liq_cur) moved from the index file into its own (store.ts liqDbPath), once,
 * with the INDEXER STOPPED (the API may keep running: it reads the new file once it is there):
 *
 *   npx tsx --disable-warning=ExperimentalWarning src/indexer/liqSplit.ts [index path] [--force]
 *   npx tsx --disable-warning=ExperimentalWarning src/indexer/liqSplit.ts [index path] --undo
 *
 * Why: store.ts LIQ_SCHEMA. What it does, in order:
 *   1. takes the index's writer lock (writerLock.ts): a running indexer refuses it, and none can start meanwhile;
 *   2. copies the three tables into `<liq file>.part` in key order (liq_log a range of wallet ids at a time), then builds
 *      the cell index there;
 *   3. checks the copy against the index, table by table: row count and a sum over every column (an exact copy or a stop);
 *   4. turns the copy's WAL on, syncs it to the disk and renames it to the liq file;
 *   5. renames the index's tables liq_addr_old / liq_log_old / liq_cur_old in one transaction (meta liq_split says when).
 * A stop anywhere before 5 leaves the index as it was (a .part left over is made again by the next run). Nothing is
 * deleted: the old tables stay in the index until the owner says they can go.
 *
 * --undo: the old tables back under their names, with every row the new file got since the split added to them, and the
 * liq file renamed `<liq file>.undone-<time>` (kept). For a release rolled back to code from before the split.
 */
import { DatabaseSync } from 'node:sqlite';
import { closeSync, existsSync, fsyncSync, openSync, renameSync, rmSync, statSync, statfsSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LIQ_LOG_COLS, LIQ_SCHEMA, defaultDbPath, hasTable, liqDbPath } from './store.js';
import { tryWriterLock } from './writerLock.js';

const TABLES = ['liq_addr', 'liq_log', 'liq_cur'] as const;
/** What the check sums per table: every column (null-safe; text by its length). */
const SUMS: Record<(typeof TABLES)[number], string> = {
  liq_addr: 'COUNT(*), TOTAL(id), TOTAL(LENGTH(address)), TOTAL(UNICODE(SUBSTR(address, -1)))',
  liq_log: `COUNT(*), TOTAL(aid), TOTAL(LENGTH(coin)), TOTAL(venue), TOTAL(t), TOTAL(side), TOTAL(liq), TOTAL(usd), TOTAL(LENGTH(sym)), COUNT(sym),
    TOTAL(sz), TOTAL(entry), TOTAL(mark), TOTAL(iso), TOTAL(lev), TOTAL(eq), TOTAL(cash), TOTAL(read_at), COUNT(sz), COUNT(mark), COUNT(read_at)`,
  liq_cur: 'COUNT(*), TOTAL(aid), TOTAL(LENGTH(coin)), TOTAL(venue), TOTAL(side), TOTAL(liq), TOTAL(usd), TOTAL(t)',
};
/** liq_log rows per transaction of the copy, by wallet id range: a progress line each. */
const AID_STEP = 5_000;

export interface LiqSplitResult {
  file: string;
  rows: Record<string, number>;
  ms: { copy: number; index: number; check: number; total: number };
  bytes: number;
}

const sums = (db: DatabaseSync, schema: string, table: (typeof TABLES)[number]): number[] =>
  Object.values(db.prepare(`SELECT ${SUMS[table]} FROM ${schema}.${table}`).get() as Record<string, number>).map(Number);

function lockOrThrow(path: string) {
  const lock = tryWriterLock(path, 'liq-split');
  if (!lock) throw new Error(`the index's writer lock is held (${path}.writer-lock): stop the indexer first`);
  return lock;
}

export function liqSplit(path: string, o: { force?: boolean; log?: (line: string) => void } = {}): LiqSplitResult {
  const log = o.log ?? ((l: string) => console.log(`[liq-split] ${l}`));
  if (!existsSync(path)) throw new Error(`no index file at ${path}`);
  const file = liqDbPath(path);
  const part = `${file}.part`;
  const lock = lockOrThrow(path);
  const t0 = Date.now();
  try {
    const idx = new DatabaseSync(path);
    try {
      idx.exec('PRAGMA busy_timeout = 30000');
      if (!hasTable(idx, 'liq_log')) throw new Error('the index holds no liq_log: split already (or a new index)');
      for (const t of TABLES) if (hasTable(idx, `${t}_old`)) throw new Error(`the index has ${t}_old already: an earlier split's tables are still there`);
      if (existsSync(file)) throw new Error(`${file} exists: move it aside first (the split never overwrites it)`);
      if (!o.force) {
        const fs = statfsSync(dirname(file));
        const room = Number(fs.bavail) * Number(fs.bsize);
        const need = statSync(path).size * 0.5;
        if (room < need) throw new Error(`${Math.round(room / 1e9)} GB free, want ${Math.round(need / 1e9)} GB (half the index) for the copy (--force to try anyway)`);
      }
      for (const f of [part, `${part}-wal`, `${part}-shm`, `${part}-journal`]) rmSync(f, { force: true });

      // 2. The copy: no journal while it is made (a stop leaves only the .part, made again), its cell index after the rows.
      const lq = new DatabaseSync(part);
      const rows: Record<string, number> = {};
      let tCopy = 0;
      let tIndex = 0;
      let tCheck = 0;
      try {
        lq.exec('PRAGMA auto_vacuum = INCREMENTAL');
        lq.exec('PRAGMA journal_mode = OFF');
        lq.exec('PRAGMA synchronous = OFF');
        lq.exec('PRAGMA cache_size = -2000000');
        lq.exec('PRAGMA temp_store = MEMORY');
        lq.exec(LIQ_SCHEMA);
        lq.exec('DROP INDEX liq_log_cell');
        lq.prepare('ATTACH DATABASE ? AS src').run(path);
        const c0 = Date.now();
        lq.exec('INSERT INTO liq_addr (id, address) SELECT id, address FROM src.liq_addr ORDER BY id');
        lq.exec('INSERT INTO liq_cur (aid, coin, venue, side, liq, usd, t) SELECT aid, coin, venue, side, liq, usd, t FROM src.liq_cur');
        const maxAid = Number((lq.prepare('SELECT MAX(aid) AS m FROM src.liq_log').get() as { m: number | null }).m ?? -1);
        const step = lq.prepare(`INSERT INTO liq_log (${LIQ_LOG_COLS}) SELECT ${LIQ_LOG_COLS} FROM src.liq_log WHERE aid >= ? AND aid < ?`);
        let copied = 0;
        let said = Date.now();
        for (let lo = Number((lq.prepare('SELECT MIN(aid) AS m FROM src.liq_log').get() as { m: number | null }).m ?? 0); lo <= maxAid; lo += AID_STEP) {
          lq.exec('BEGIN');
          copied += Number(step.run(lo, lo + AID_STEP).changes);
          lq.exec('COMMIT');
          if (Date.now() - said > 10_000) {
            said = Date.now();
            log(`liq_log: ${copied.toLocaleString('en-US')} rows, wallet ids up to ${lo + AID_STEP} of ${maxAid} (${Math.round((Date.now() - c0) / 1000)} s)`);
          }
        }
        tCopy = Date.now() - c0;
        log(`copied ${copied.toLocaleString('en-US')} log rows in ${Math.round(tCopy / 1000)} s; building the cell index`);
        const i0 = Date.now();
        lq.exec('CREATE INDEX liq_log_cell ON liq_log (coin, liq, t)');
        tIndex = Date.now() - i0;

        // 3. The check: every column of every row, summed on both sides.
        const k0 = Date.now();
        for (const t of TABLES) {
          const a = sums(lq, 'src', t);
          const b = sums(lq, 'main', t);
          if (a.length !== b.length || a.some((v, i) => v !== b[i])) throw new Error(`${t}: the copy differs from the index (index ${a.join(',')} / copy ${b.join(',')})`);
          rows[t] = a[0]!;
        }
        tCheck = Date.now() - k0;
        log(`checked: ${TABLES.map((t) => `${t} ${rows[t]!.toLocaleString('en-US')}`).join(', ')} rows identical (${Math.round(tCheck / 1000)} s)`);
        lq.exec('DETACH DATABASE src');
        // 4. A database like the writer makes it: WAL, synced to the disk before it gets its name.
        lq.exec('PRAGMA journal_mode = WAL');
        lq.exec('PRAGMA synchronous = NORMAL');
      } finally {
        lq.close();
      }
      const fd = openSync(part, 'r+');
      try { fsyncSync(fd); } finally { closeSync(fd); }
      for (const f of [`${part}-wal`, `${part}-shm`]) rmSync(f, { force: true });
      renameSync(part, file);

      // 5. The index's tables out of the way, kept.
      idx.exec('BEGIN IMMEDIATE');
      try {
        for (const t of TABLES) idx.exec(`ALTER TABLE ${t} RENAME TO ${t}_old`);
        idx.prepare("INSERT INTO meta (key, value) VALUES ('liq_split', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
          .run(JSON.stringify({ at: Date.now(), file, rows }));
        idx.exec('COMMIT');
      } catch (e) {
        idx.exec('ROLLBACK');
        // The new file must not be taken for the log while the index still has it: kept under another name.
        renameSync(file, `${file}.unused-${Date.now()}`);
        throw e;
      }
      log(`done: ${file}; the index's tables are now liq_addr_old, liq_log_old, liq_cur_old (kept)`);
      return { file, rows, ms: { copy: tCopy, index: tIndex, check: tCheck, total: Date.now() - t0 }, bytes: statSync(file).size };
    } finally {
      idx.close();
    }
  } finally {
    lock.release();
  }
}

/** The split taken back: the index's old tables under their names again, with what the liq file got since. */
export function liqUnsplit(path: string, o: { log?: (line: string) => void; now?: number } = {}): { added: Record<string, number>; keptAs: string } {
  const log = o.log ?? ((l: string) => console.log(`[liq-split] ${l}`));
  const file = liqDbPath(path);
  if (!existsSync(file)) throw new Error(`no liq file at ${file}`);
  const lock = lockOrThrow(path);
  try {
    const idx = new DatabaseSync(path);
    const added: Record<string, number> = {};
    try {
      idx.exec('PRAGMA busy_timeout = 30000');
      for (const t of TABLES) if (!hasTable(idx, `${t}_old`)) throw new Error(`the index has no ${t}_old: nothing to take back`);
      if (hasTable(idx, 'liq_log')) throw new Error('the index has liq_log already');
      idx.prepare('ATTACH DATABASE ? AS lq').run(file);
      idx.exec('BEGIN IMMEDIATE');
      try {
        for (const t of TABLES) idx.exec(`ALTER TABLE ${t}_old RENAME TO ${t}`);
        const maxId = Number((idx.prepare('SELECT MAX(id) AS m FROM main.liq_addr').get() as { m: number | null }).m ?? 0);
        const maxT = Number((idx.prepare('SELECT MAX(t) AS m FROM main.liq_log').get() as { m: number | null }).m ?? 0);
        added.liq_addr = Number(idx.prepare('INSERT OR IGNORE INTO main.liq_addr (id, address) SELECT id, address FROM lq.liq_addr WHERE id > ?').run(maxId).changes);
        added.liq_log = Number(idx.prepare(`INSERT OR REPLACE INTO main.liq_log (${LIQ_LOG_COLS}) SELECT ${LIQ_LOG_COLS} FROM lq.liq_log WHERE t > ?`).run(maxT).changes);
        // The current state is the new file's: the latest of every position.
        idx.exec('DELETE FROM main.liq_cur');
        added.liq_cur = Number(idx.prepare('INSERT INTO main.liq_cur (aid, coin, venue, side, liq, usd, t) SELECT aid, coin, venue, side, liq, usd, t FROM lq.liq_cur').run().changes);
        idx.exec("DELETE FROM main.meta WHERE key = 'liq_split'");
        idx.exec('COMMIT');
      } catch (e) {
        idx.exec('ROLLBACK');
        throw e;
      }
      idx.exec('DETACH DATABASE lq');
    } finally {
      idx.close();
    }
    const keptAs = `${file}.undone-${o.now ?? Date.now()}`;
    for (const sfx of ['', '-wal', '-shm']) if (existsSync(`${file}${sfx}`)) renameSync(`${file}${sfx}`, `${keptAs}${sfx}`);
    log(`taken back: ${Object.entries(added).map(([t, n]) => `${t} +${n}`).join(', ')}; the liq file kept as ${keptAs}`);
    return { added, keptAs };
  } finally {
    lock.release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const path = args.find((a) => !a.startsWith('--')) ?? defaultDbPath();
  try {
    if (args.includes('--undo')) liqUnsplit(path);
    else {
      const r = liqSplit(path, { force: args.includes('--force') });
      console.log(`[liq-split] ${(r.bytes / 1e9).toFixed(2)} GB; copy ${Math.round(r.ms.copy / 1000)} s, index ${Math.round(r.ms.index / 1000)} s, check ${Math.round(r.ms.check / 1000)} s, total ${Math.round(r.ms.total / 1000)} s`);
    }
  } catch (e) {
    console.error(`[liq-split] ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
