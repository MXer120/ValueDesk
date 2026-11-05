#!/usr/bin/env node
// A consistent copy of the ValueDesk index database, taken while the indexer runs.
//
//   node --disable-warning=ExperimentalWarning backup-index.mjs <source.db> <copy.db>
//   node --disable-warning=ExperimentalWarning backup-index.mjs --check <file.db>
//
// HOW. Where the filesystem can share blocks (XFS with reflink, as on the servers): a read
// transaction is opened on the source, so the WAL cannot restart, then the file and then its WAL
// are cloned, in that order, and the transaction ends: under two seconds on any size. Every page a
// checkpoint put in the cloned file came from a frame still in the cloned WAL, so opening the copy
// replays to one committed instant. Everywhere else: `VACUUM INTO`, one read transaction.
// The copy is then opened and checked (`PRAGMA quick_check`) before this exits 0.
//
// WHY THE CLONE (2026-11-05). VACUUM INTO on the 45 GB index held its read transaction for up to
// 170 minutes. Nothing in the WAL could be copied back meanwhile, it grew to about 25 GB, and the
// indexer stalled for up to 834 s at a time: 11 of its 12 worst stalls fell inside a backup, and
// the backup timed out twice. The clone holds nothing of the source's once it is taken.
//
// WHY NOT `sqlite3 .backup` or a file copy. The backup API restarts every time
// another connection writes, and the indexer writes every few seconds, so it may
// never finish. A plain copy of the .db file without its -wal is not a database.
//
// With VACUUM INTO, while it runs the WAL cannot be checkpointed past the copy's snapshot, so
// the -wal file grows by what the indexer writes in those minutes; it shrinks again
// afterwards. It needs as much free space as the database. A clone needs space only as the
// source changes, while the clone lasts.
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

/** The clone; false when this filesystem cannot, and nothing is left behind. */
function cloneInto() {
  if (process.env.BACKUP_NO_CLONE) return false;
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 30000');
    db.exec('BEGIN');
    db.prepare('SELECT count(*) FROM sqlite_master').get(); // the read transaction starts here
    const clone = (from, to) => execFileSync('cp', ['--reflink=always', from, to], { stdio: 'ignore' });
    clone(source, dest);
    if (existsSync(`${source}-wal`)) clone(`${source}-wal`, `${dest}-wal`);
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
let method = 'clone';
if (!cloneInto()) {
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
