#!/usr/bin/env node
// A consistent copy of the Valuescan index database, taken while the indexer runs.
//
//   node --disable-warning=ExperimentalWarning backup-index.mjs <source.db> <copy.db>
//   node --disable-warning=ExperimentalWarning backup-index.mjs --check <file.db>
//
// HOW. The source is opened READ-ONLY and copied with `VACUUM INTO`: one read
// transaction, so the copy is the database exactly as it was at one instant,
// whatever the indexer writes meanwhile (WAL: readers never block the writer).
// The copy is then opened and checked (`PRAGMA quick_check`) before this exits 0.
//
// WHY NOT `sqlite3 .backup` or a file copy. The backup API restarts every time
// another connection writes, and the indexer writes every few seconds, so it may
// never finish. A plain copy of the .db file without its -wal is not a database.
//
// While it runs the WAL cannot be checkpointed past the copy's snapshot, so the
// -wal file grows by what the indexer writes in those minutes; it shrinks again
// afterwards. The copy needs as much free space as the database.
//
// Runs on the instance (backup.sh) and on a developer machine alike (to seed a new
// instance from a local index: see docs/deploy/DEPLOY.md). Node 22.13+, no dependencies.
import { DatabaseSync } from 'node:sqlite';
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

const started = Date.now();
const db = new DatabaseSync(source, { readOnly: true });
try {
  // Wait for a checkpoint or a writer's commit rather than fail on a busy file.
  db.exec('PRAGMA busy_timeout = 30000');
  db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
} catch (e) {
  try { if (existsSync(dest)) unlinkSync(dest); } catch { /* reported below */ }
  fail(`copy failed: ${e?.message ?? e}`);
} finally {
  db.close();
}

const result = inspect(dest);
if (!result.ok) {
  try { unlinkSync(dest); } catch { /* keep the evidence if it cannot be removed */ }
  fail(`the copy failed its integrity check: ${result.verdict}`);
}
console.log(JSON.stringify({
  source,
  copy: dest,
  sourceBytes: statSync(source).size,
  seconds: Math.round((Date.now() - started) / 100) / 10,
  ...result,
}));
