#!/usr/bin/env node
// THE INDEX RESTORE DRILL: restore a backup into a scratch directory, verify it, throw it away. Touches nothing that runs.
//
//   node index-drill.mjs latest                       the newest valuescan-index-*.db.zst in BACKUP_DIR
//   node index-drill.mjs <file.db.zst | file.db>      that one
//     --scratch <dir>   where to restore (default BACKUP_STAGING_DIR, /var/lib/valuescan/backup): needs the database's size free
//     --full            PRAGMA integrity_check instead of quick_check (hours on 50 GB)
//     --keep            leave the restored file (prints its path) - e.g. to hand it to restore.sh
//
// Checks, in order: the SHA-256 of the restored bytes against the .sha256 next to the backup; the integrity check;
// the restored file's figures (page count, schema, freelist, table count, row counts of the small tables) against the
// .meta.json backup.sh wrote from the same check at backup time. Prints DRILL PASSED and exits 0, or names what
// differs and exits 1. Node 22.15+ (zstd in node:zlib), no zstd binary: runs on the laptop too.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve, dirname, basename } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { createZstdDecompress } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const fail = (msg) => {
  console.error(`[drill] FAILED: ${msg}`);
  process.exit(1);
};
const log = (msg) => console.error(`[drill] ${msg}`);

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
};
const flags = new Set(args.filter((a) => a === '--full' || a === '--keep'));
const positional = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--scratch');
let src = positional[0] ?? fail('usage: index-drill.mjs latest|<file.db.zst>|<file.db> [--scratch <dir>] [--full] [--keep]');

if (src === 'latest') {
  const dir = process.env.BACKUP_DIR || '/var/lib/valuescan/backup/archive';
  const newest = (existsSync(dir) ? readdirSync(dir) : []).filter((f) => /^valuescan-index-[0-9TZ]+\.db\.zst$/.test(f)).sort().pop();
  if (!newest) fail(`no valuescan-index-*.db.zst in ${dir}`);
  src = join(dir, newest);
}
src = resolve(src);
if (!existsSync(src)) fail(`${src} does not exist`);

const scratchRoot = resolve(opt('--scratch') ?? process.env.BACKUP_STAGING_DIR ?? '/var/lib/valuescan/backup');
const scratch = mkdtempSync(join(scratchRoot, 'drill-'));
const out = join(scratch, basename(src).replace(/\.zst$/, ''));
const t0 = Date.now();
const bad = (msg) => { throw new Error(msg); };
let ok = false;
try {
  log(`restoring ${src} (${Math.round(statSync(src).size / 1e6)} MB) into ${scratch}`);
  const hash = createHash('sha256');
  const tap = new Transform({ transform(chunk, _e, cb) { hash.update(chunk); cb(null, chunk); } });
  const stages = [createReadStream(src)];
  if (src.endsWith('.zst')) stages.push(createZstdDecompress());
  await pipeline(...stages, tap, createWriteStream(out));
  const sha = hash.digest('hex');
  const result = { source: src, restored: out, bytes: statSync(out).size, sha256: sha, restoreSeconds: Math.round((Date.now() - t0) / 100) / 10 };

  if (existsSync(`${src}.sha256`)) {
    const want = readFileSync(`${src}.sha256`, 'utf8').trim().split(/\s+/)[0];
    if (want !== sha) bad(`SHA-256 ${sha} is not the ${want} recorded at backup time`);
    result.sha256Matches = true;
  } else log('no .sha256 next to the backup: relying on the checks below');

  const t1 = Date.now();
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', join(HERE, 'backup-index.mjs'), '--check', out, ...(flags.has('--full') ? ['--full'] : [])], { encoding: 'utf8' });
  if (r.status !== 0) bad(`the integrity check failed: ${r.stdout}${r.stderr}`);
  const check = JSON.parse(r.stdout);
  result.check = check;
  result.checkSeconds = Math.round((Date.now() - t1) / 100) / 10;

  const meta = existsSync(`${src}.meta.json`) ? JSON.parse(readFileSync(`${src}.meta.json`, 'utf8')) : null;
  if (meta?.check) {
    const diffs = [];
    for (const k of ['pages', 'schema', 'boards', 'coverage', 'freelist', 'tables']) {
      if (k in meta.check && JSON.stringify(meta.check[k]) !== JSON.stringify(check[k])) diffs.push(`${k}: ${meta.check[k]} at backup, ${check[k]} restored`);
    }
    for (const [t, n] of Object.entries(meta.check.counts ?? {})) {
      if (check.counts?.[t] !== n) diffs.push(`rows in ${t}: ${n} at backup, ${check.counts?.[t]} restored`);
    }
    if (diffs.length) bad(diffs.join('; '));
    result.matchesBackupTime = true;
    result.snapshot = meta.snapshot ?? null;
  } else log('no .meta.json next to the backup (made before 2026-11-09): figures not compared');

  ok = true;
  console.log(JSON.stringify(result));
  log(`DRILL PASSED in ${Math.round((Date.now() - t0) / 1000)} s`);
} catch (e) {
  console.error(`[drill] FAILED: ${e.message}`);
  process.exitCode = 1;
} finally {
  if (flags.has('--keep') && ok) log(`kept: ${out}`);
  else rmSync(scratch, { recursive: true, force: true });
}
