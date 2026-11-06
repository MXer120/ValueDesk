#!/usr/bin/env node
// A consistent copy of the ValueDesk index database, taken while the indexer runs.
//
//   node --disable-warning=ExperimentalWarning backup-index.mjs <source.db> <copy.db>
//   node --disable-warning=ExperimentalWarning backup-index.mjs --check <file.db>
//
// HOW. Where `dd` is there (the servers): a read transaction is opened on the source, so the WAL
// cannot restart, then the file and then its WAL are copied byte for byte, in that order, at
// BACKUP_COPY_MB_S (150 MB/s: 45 GB in 5 minutes), past the page cache, and the transaction ends.
// Every page a checkpoint writes to the file meanwhile comes from a frame still in the WAL, which is
// copied after it, so opening the copy replays to one committed instant, torn pages included.
// Everywhere else: `VACUUM INTO`, one read transaction.
// The copy is then opened and checked (`PRAGMA quick_check`) before this exits 0.
//
// WHY THE COPY (2026-11-05). VACUUM INTO on the 45 GB index held its read transaction for up to
// 170 minutes. Nothing in the WAL could be copied back meanwhile, it grew to about 25 GB, and the
// indexer stalled for up to 834 s at a time: 11 of its 12 worst stalls fell inside a backup, and
// the backup timed out twice.
//
// NOT A REFLINK CLONE. Tried the same day: instant, but while it lasted (the check and the upload,
// over 36 min) every page the indexer overwrote went to a new place: the live file went from 61
// extents to 1,172,730 and took 24 GB more, for good.
//
// WHY NOT `sqlite3 .backup` or a file copy. The backup API restarts every time
// another connection writes, and the indexer writes every few seconds, so it may
// never finish. A plain copy of the .db file without its -wal is not a database.
//
// With VACUUM INTO, while it runs the WAL cannot be checkpointed past the copy's snapshot, so
// the -wal file grows by what the indexer writes in those minutes; it shrinks again
// afterwards. Either way it needs as much free space as the database, and the copy holds the
// WAL back for its 5 minutes only.
//
// Runs on the instance (backup.sh) and on a developer machine alike (to seed a new
// instance from a local index: see docs/deploy/DEPLOY.md). Node 22.13+, no dependencies.
//
// Any SQLite database: backup.sh --executor copies the copy executor's executor.db
// with it the same way. The index-only facts in the report (schema, boards,
// coverage) are null for a database without those tables.
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { existsSync, statSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';

const fail = (msg) => {
  console.error(`backup-index: ${msg}`);
  process.exit(1);
};

/** Open read-only, run the quick integrity check, describe what is inside. */
function inspect(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 30000');
    // SQLite's 2 MB page cache read the 46 GB copy's pages over and over: over 70 GB read, past 90 min, in the first run
    // of the byte copy (2026-11-05). This connection reads only the copy, so 4 GB costs nothing else.
    db.exec('PRAGMA cache_size = -4000000');
    const rows = db.prepare('PRAGMA quick_check').all();
    const verdict = rows.map((r) => Object.values(r)[0]).join('; ');
    if (verdict !== 'ok') return { ok: false, verdict };
    const one = (sql) => {
      try {
        return Object.values(db.prepare(sql).get() ?? {})[0] ?? null;
      } catch {
        return null; // a table of a later or earlier schema
      }
    };
    return {
      ok: true,
      verdict,
      bytes: statSync(file).size,
      pages: one('PRAGMA page_count'),
      schema: one("SELECT value FROM meta WHERE key = 'schema'"),
      boards: one('SELECT count(*) FROM board_meta'),
      // Small tables only: counting the fills of a multi-gigabyte index would take minutes.
      coverage: one('SELECT count(*) FROM coverage'),
    };
  } finally {
    db.close();
  }
}

const args = process.argv.slice(2);
if (args[0] === '--check') {
  const file = resolve(args[1] ?? fail('usage: backup-index.mjs --check <file.db>'));
  if (!existsSync(file)) fail(`${file} does not exist`);
  const r = inspect(file);
  console.log(JSON.stringify({ file, ...r }));
  process.exit(r.ok ? 0 : 1);
}

if (args.length !== 2) fail('usage: backup-index.mjs <source.db> <copy.db>   |   backup-index.mjs --check <file.db>');
const source = resolve(args[0]);
const dest = resolve(args[1]);
if (!existsSync(source)) fail(`${source} does not exist`);
if (source === dest) fail('the copy cannot be the source');
if (existsSync(dest)) fail(`${dest} already exists - a backup never overwrites`);

const clean = () => {
  for (const f of [dest, `${dest}-wal`, `${dest}-shm`]) {
    try { if (existsSync(f)) unlinkSync(f); } catch { /* reported by what follows */ }
  }
};

const SLICE_BLOCKS = 16; // of 4 MiB: 64 MiB, then a pause to hold the rate
const BLOCK = 4 * 1024 * 1024;

/** `from` to `to` byte for byte, paced. Past the page cache where the filesystem can, so what the indexer has in memory stays. */
function pacedCopy(from, to, mbPerS) {
  const size = statSync(from).size;
  let flags = ['iflag=direct', 'oflag=direct'];
  for (let block = 0; block * BLOCK < size; block += SLICE_BLOCKS) {
    const t0 = Date.now();
    const args = [`if=${from}`, `of=${to}`, `bs=${BLOCK}`, `skip=${block}`, `seek=${block}`, `count=${SLICE_BLOCKS}`, 'conv=notrunc'];
    try {
      execFileSync('dd', [...args, ...flags], { stdio: 'ignore' });
    } catch (e) {
      if (!flags.length) throw e;
      flags = []; // a filesystem without direct I/O, or a length it will not write directly
      execFileSync('dd', args, { stdio: 'ignore' });
    }
    const wait = (SLICE_BLOCKS * BLOCK) / (mbPerS * 1e6) * 1000 - (Date.now() - t0);
    if (wait > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
  }
}

/** The byte copy; false where it cannot be made, and nothing is left behind. */
function copyInto() {
  if (process.env.BACKUP_NO_COPY) return false;
  const rate = Number(process.env.BACKUP_COPY_MB_S) || 150;
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 30000');
    db.exec('BEGIN');
    db.prepare('SELECT count(*) FROM sqlite_master').get(); // the read transaction starts here
    pacedCopy(source, dest, rate);
    // A plain copy: it is at most a few GB, the tail still being written is cut by its checksums.
    if (existsSync(`${source}-wal`)) execFileSync('cp', ['--reflink=never', `${source}-wal`, `${dest}-wal`], { stdio: 'ignore' });
    db.exec('COMMIT');
  } catch {
    clean();
    return false;
  } finally {
    db.close();
  }
  // The WAL goes into the copy, so that it is one file and whatever reads it next reads only it.
  const copy = new DatabaseSync(dest);
  try {
    copy.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    copy.exec('PRAGMA journal_mode = DELETE');
  } finally {
    copy.close();
  }
  return true;
}

const started = Date.now();
let method = 'copy';
if (!copyInto()) {
  method = 'vacuum';
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    // Wait for a checkpoint or a writer's commit rather than fail on a busy file.
    db.exec('PRAGMA busy_timeout = 30000');
    db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
  } catch (e) {
    clean();
    fail(`copy failed: ${e?.message ?? e}`);
  } finally {
    db.close();
  }
}

const result = inspect(dest);
if (!result.ok) {
  try { unlinkSync(dest); } catch { /* keep the evidence if it cannot be removed */ }
  fail(`the copy failed its integrity check: ${result.verdict}`);
}
console.log(JSON.stringify({
  source,
  copy: dest,
  method,
  sourceBytes: statSync(source).size,
  seconds: Math.round((Date.now() - started) / 100) / 10,
  ...result,
}));
