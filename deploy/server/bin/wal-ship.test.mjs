// node --disable-warning=ExperimentalWarning --test deploy/server/bin/wal-ship.test.mjs
//   WALSHIP_TEST_SEED_MB (60) sizes the scratch database, WALSHIP_TEST_PHASE_MS (5000) each measured phase,
//   WALSHIP_TEST_REPORT=<file> writes the measured numbers, WALSHIP_TEST_STRICT=1 applies the tight timing bounds,
//   WRITER_GAP_MS=0 makes the writer write without pauses (the worst case for WAL restarts).
//
// The WAL shipper against a database that is written all the time, like the index: a writer process with the indexer's
// settings (WAL, synchronous NORMAL, autocheckpoint off, a checkpoint thread doing PASSIVE and, past a frame count, FULL
// with a 250 ms wait), transactions of every kind - small ones, ones larger than the page cache that spill frames into
// the WAL before their commit, ones that spill and then ROLL BACK, deletes and incremental vacuum that shrink the file.
// Every transaction keeps a totals row in step with the items table (triggers) and appends a ledger row, so any
// snapshot that is one committed instant has totals = count/sum of items = the last ledger row.
//
// It asserts: every read transaction the shipper held on the live file was short; the WAL stayed as small as without
// the shipper; snapshots taken while the writer runs are consistent and pass integrity_check; after kill -9 the shipper
// carries on; the final snapshot equals the source table by table, row by row.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createZstdCompress } from 'node:zlib';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHIP = join(HERE, 'wal-ship.mjs');
const CHECK = join(HERE, 'backup-index.mjs');
const DRILL = join(HERE, 'index-drill.mjs');
const NODE = process.execPath;
const SEED_MB = Number(process.env.WALSHIP_TEST_SEED_MB) || 60;
const PHASE_MS = Number(process.env.WALSHIP_TEST_PHASE_MS) || 5000;
// The tight timing bounds need a quiet machine (CI runners and a loaded laptop stretch every timer): WALSHIP_TEST_STRICT=1.
const STRICT = process.env.WALSHIP_TEST_STRICT === '1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const WRITER = `
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { statSync } from 'node:fs';
const file = process.argv[2];
const GAP = process.env.WRITER_GAP_MS === undefined ? -1 : Number(process.env.WRITER_GAP_MS);
const db = new DatabaseSync(file);
db.exec('PRAGMA busy_timeout = 5000');
db.exec('PRAGMA synchronous = NORMAL');
db.exec('PRAGMA journal_size_limit = 67108864');
db.exec('PRAGMA wal_autocheckpoint = 0');
db.exec('PRAGMA cache_size = -2000'); // 2 MB: a large transaction spills frames into the WAL before its commit
// The indexer's checkpoint thread (apps/server/src/indexer/checkpointer.ts), on a shorter clock.
const ck = new Worker(\`
  const { parentPort, workerData } = require('node:worker_threads');
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(workerData);
  db.exec('PRAGMA busy_timeout = 0');
  db.exec('PRAGMA wal_autocheckpoint = 0');
  const ask = db.prepare('PRAGMA wal_checkpoint(PASSIVE)');
  const full = db.prepare('PRAGMA wal_checkpoint(FULL)');
  let fullAt = 0, fulls = 0, fullsBusy = 0, fullMaxMs = 0, runs = 0, behindMax = 0, logMax = 0;
  parentPort.on('message', () => { fulls = 0; fullsBusy = 0; fullMaxMs = 0; runs = 0; behindMax = 0; logMax = 0; });
  setInterval(() => {
    try {
      const r = ask.get(); runs++;
      behindMax = Math.max(behindMax, r.log - r.checkpointed);
      logMax = Math.max(logMax, r.log);
      if (r.log >= 4000 && Date.now() - fullAt >= 2000) {
        ask.get();
        db.exec('PRAGMA busy_timeout = 250');
        const t = Date.now();
        try { const f = full.get(); fulls++; if (f.busy) fullsBusy++; } finally { db.exec('PRAGMA busy_timeout = 0'); }
        fullAt = Date.now(); fullMaxMs = Math.max(fullMaxMs, fullAt - t);
      }
    } catch {}
    parentPort.postMessage({ runs, fulls, fullsBusy, fullMaxMs, behindMax, logMax });
  }, 300);
\`, { eval: true, workerData: file });
let ckState = {};
ck.on('message', (m) => { ckState = m; });

const ins = db.prepare('INSERT INTO items (grp, val, body) VALUES (?, ?, randomblob(?))');
const upd = db.prepare('UPDATE items SET val = val + ?, body = randomblob(?) WHERE id = ?');
const del = db.prepare('DELETE FROM items WHERE id BETWEEN ? AND ?');
const maxId = db.prepare('SELECT max(id) AS m FROM items');
const led = db.prepare('INSERT INTO ledger (n, s, at) SELECT n, s, ? FROM totals');
let seq = 0, txns = 0, rolledBack = 0, big = 0, vacuums = 0, errors = 0;
let lat = [], bigLat = [], maxWal = 0, lastBig = Date.now(), lastRb = Date.now(), lastVac = Date.now();
const rnd = (n) => Math.floor(Math.random() * n);
setInterval(() => { try { maxWal = Math.max(maxWal, statSync(file + '-wal').size); } catch {} }, 20);
let stopped = false;
const tick = () => {
  if (stopped) return;
  const t = performance.now();
  let rollback = false;
  let isBig = false;
  try {
    db.exec('BEGIN IMMEDIATE');
    const top = Number(maxId.get().m) || 1;
    const now = Date.now();
    if (now - lastBig > 3000) {          // larger than the page cache: frames reach the WAL before the commit
      lastBig = now; big++; isBig = true;
      for (let i = 0; i < 4000; i++) ins.run(rnd(50), rnd(1000), 3000);
    } else if (now - lastRb > 5000) {    // the same, then thrown away
      lastRb = now; rollback = true;
      for (let i = 0; i < 4000; i++) ins.run(rnd(50), rnd(1000), 3000);
      for (let i = 0; i < 200; i++) upd.run(1, 500, 1 + rnd(top));
    } else {
      const r = Math.random();
      if (r < 0.6) for (let i = 0; i < 1 + rnd(20); i++) ins.run(rnd(50), rnd(1000), 200 + rnd(1800));
      else if (r < 0.9) for (let i = 0; i < 1 + rnd(20); i++) upd.run(rnd(10) - 5, 200 + rnd(1800), 1 + rnd(top));
      else { const a = 1 + rnd(top); del.run(a, a + rnd(400)); }
    }
    if (rollback) { db.exec('ROLLBACK'); rolledBack++; }
    else {
      led.run(now);
      db.exec('COMMIT');
      txns++;
      (isBig ? bigLat : lat).push(performance.now() - t);
    }
    if (now - lastVac > 2500) {          // hand freed pages back: the file shrinks, commits carry a smaller size
      lastVac = now; vacuums++;
      db.exec('PRAGMA incremental_vacuum(2000)');
    }
  } catch (e) { errors++; try { db.exec('ROLLBACK'); } catch {} if (errors < 5) console.error(String(e)); }
  // The indexer writes in batches with pauses between them; WRITER_GAP_MS=0 writes without a pause.
  setTimeout(tick, GAP >= 0 ? GAP : 2 + rnd(40));
};
const stats = () => {
  const s = [...lat].sort((a, b) => a - b);
  const q = (f) => s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(f * s.length))] * 10) / 10 : null;
  const over = (ms) => s.filter((x) => x > ms).length;
  return { txns, rolledBack, big, vacuums, errors, commitMs: { p50: q(0.5), p90: q(0.9), p99: q(0.99), max: q(1), over50: over(50), over100: over(100) }, bigCommitMaxMs: bigLat.length ? Math.round(Math.max(...bigLat)) : null, maxWalBytes: maxWal, checkpointer: ckState };
};
process.on('message', (m) => {
  if (m === 'phase') { process.send({ phase: stats() }); lat = []; bigLat = []; maxWal = 0; txns = 0; rolledBack = 0; big = 0; vacuums = 0; ck.postMessage('reset'); }
  if (m === 'stop') {
    stopped = true;
    setTimeout(() => { ck.terminate(); const s = stats(); db.close(); process.send({ stopped: s }); process.exit(0); }, 50);
  }
});
process.send('ready');
tick();
`;

function seed(file, mb) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA auto_vacuum = INCREMENTAL');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`
    CREATE TABLE items (id INTEGER PRIMARY KEY, grp INTEGER NOT NULL, val INTEGER NOT NULL, body BLOB NOT NULL);
    CREATE INDEX items_grp ON items (grp, val);
    CREATE TABLE totals (k INTEGER PRIMARY KEY CHECK (k = 1), n INTEGER NOT NULL, s INTEGER NOT NULL);
    INSERT INTO totals VALUES (1, 0, 0);
    CREATE TABLE ledger (seq INTEGER PRIMARY KEY, n INTEGER NOT NULL, s INTEGER NOT NULL, at INTEGER NOT NULL);
    CREATE TRIGGER items_i AFTER INSERT ON items BEGIN UPDATE totals SET n = n + 1, s = s + NEW.val; END;
    CREATE TRIGGER items_d AFTER DELETE ON items BEGIN UPDATE totals SET n = n - 1, s = s - OLD.val; END;
    CREATE TRIGGER items_u AFTER UPDATE OF val ON items BEGIN UPDATE totals SET s = s - OLD.val + NEW.val; END;
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT) WITHOUT ROWID;
    INSERT INTO meta VALUES ('schema', '1');
    CREATE TABLE board_meta (venue TEXT PRIMARY KEY) WITHOUT ROWID;
    CREATE TABLE coverage (venue TEXT PRIMARY KEY) WITHOUT ROWID;
  `);
  const rows = Math.round((mb * 1e6) / 1100);
  db.exec('BEGIN');
  db.prepare(`WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM c WHERE i < ?)
              INSERT INTO items (grp, val, body) SELECT i % 50, i % 1000, randomblob(1000) FROM c`).run(rows);
  db.exec('COMMIT');
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
}

/** One committed instant: the totals row, the items table and the last ledger row agree. */
function consistency(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const integrity = db.prepare('PRAGMA integrity_check').all().map((r) => Object.values(r)[0]).join('; ');
    const actual = db.prepare('SELECT count(*) AS n, coalesce(sum(val), 0) AS s FROM items').get();
    const totals = db.prepare('SELECT n, s FROM totals').get();
    const last = db.prepare('SELECT seq, n, s FROM ledger ORDER BY seq DESC LIMIT 1').get();
    const byIndex = db.prepare('SELECT count(*) AS n FROM items INDEXED BY items_grp').get();
    return { integrity, actual: { n: Number(actual.n), s: Number(actual.s) }, totals: { n: Number(totals.n), s: Number(totals.s) }, last: last && { seq: Number(last.seq), n: Number(last.n), s: Number(last.s) }, byIndex: Number(byIndex.n) };
  } finally {
    db.close();
  }
}

function tableHashes(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const out = {};
    for (const t of ['items', 'totals', 'ledger', 'meta']) {
      const h = createHash('sha256');
      let n = 0;
      for (const row of db.prepare(`SELECT * FROM ${t} ORDER BY 1`).iterate()) {
        for (const v of Object.values(row)) h.update(v instanceof Uint8Array ? v : String(v)), h.update('\x00');
        n++;
      }
      out[t] = { rows: n, sha256: h.digest('hex').slice(0, 16) };
    }
    return out;
  } finally {
    db.close();
  }
}

function startWriter(dir, file) {
  const w = join(dir, 'writer.mjs');
  writeFileSync(w, WRITER);
  const p = spawn(NODE, ['--disable-warning=ExperimentalWarning', w, file], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  const ask = (msg, key) => new Promise((res) => {
    const on = (m) => { if (m && m[key]) { p.off('message', on); res(m[key]); } };
    p.on('message', on);
    p.send(msg);
  });
  const ready = new Promise((res) => p.once('message', (m) => m === 'ready' && res()));
  return { p, ready, phase: () => ask('phase', 'phase'), stop: () => ask('stop', 'stopped') };
}

const ENV = {
  ...process.env,
  WALSHIP_BASE_MB_S: process.env.WALSHIP_BASE_MB_S ?? '60',
  WALSHIP_SNAP_MB_S: process.env.WALSHIP_SNAP_MB_S ?? '80',
  WALSHIP_SPOOL_MEM_MB: '4',
  WALSHIP_SYNC_MS: '500',
  WALSHIP_STATUS_MS: '200',
};

function startShipper(file, dir) {
  const p = spawn(NODE, ['--disable-warning=ExperimentalWarning', SHIP, 'run', '--db', file, '--dir', dir], { stdio: ['ignore', 'pipe', 'pipe'], env: ENV });
  let out = '';
  p.stdout.on('data', (d) => { out += d; if (process.env.WALSHIP_DEBUG) process.stdout.write(d); });
  p.stderr.on('data', (d) => { out += d; process.stderr.write(d); });
  return { p, log: () => out };
}

const status = (dir) => {
  try { return JSON.parse(readFileSync(join(dir, 'status.json'), 'utf8')); } catch { return null; }
};

async function until(fn, ms, what) {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

function run(args, env = ENV) {
  return new Promise((res) => {
    const p = spawn(NODE, ['--disable-warning=ExperimentalWarning', ...args], { env });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('exit', (code) => res({ code, out, err }));
  });
}

test('the WAL shipper keeps a consistent copy of a database written all the time, with short read transactions only', { timeout: 600_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'walship-'));
  const file = join(dir, 'live.db');
  const rdir = join(dir, 'replica');
  const report = { seedMb: SEED_MB };
  let writer, ship;
  try {
    let t = Date.now();
    seed(file, SEED_MB);
    report.seedBytes = statSync(file).size;
    report.seedSeconds = (Date.now() - t) / 1000;

    writer = startWriter(dir, file);
    await writer.ready;
    await sleep(1000);
    await writer.phase();
    await sleep(PHASE_MS);
    report.baseline = await writer.phase(); // the writer and its checkpointer alone

    // The shipper: the base copy while the writer runs, then the WAL.
    ship = startShipper(file, rdir);
    await until(() => status(rdir)?.mode === 'follow', 300_000, 'the base copy');
    report.duringBaseCopy = await writer.phase();
    report.baseCopy = status(rdir).lastBase;
    await sleep(PHASE_MS);
    report.following = await writer.phase();

    // Snapshot 1, while the writer runs.
    const snap1 = join(dir, 'snap1.db');
    let r = await run([SHIP, 'snapshot', '--dir', rdir, '--out', snap1, '--timeout', '300']);
    assert.equal(r.code, 0, `snapshot 1: ${r.err}`);
    report.duringSnapshot = await writer.phase();
    report.snapshot1 = JSON.parse(r.out);
    const c1 = consistency(snap1);
    report.snapshot1.check = c1;
    assert.equal(c1.integrity, 'ok');
    assert.deepEqual(c1.totals, c1.actual, 'snapshot 1: the totals row agrees with the items table');
    assert.deepEqual({ n: c1.last.n, s: c1.last.s }, c1.actual, 'snapshot 1: the last ledger row agrees');
    assert.equal(c1.byIndex, c1.actual.n, 'snapshot 1: the index has every row');
    r = await run([CHECK, '--check', snap1]);
    assert.equal(r.code, 0, `backup-index --check: ${r.err}`);
    report.snapshot1.checkReport = JSON.parse(r.out);

    // kill -9 and start again: it resumes when the WAL still holds its last frame, else it copies the file again.
    const before = status(rdir);
    ship.p.kill('SIGKILL');
    await new Promise((res) => ship.p.once('exit', res));
    ship = startShipper(file, rdir);
    await until(() => { const s = status(rdir); return s && s.pid === ship.p.pid && s.mode === 'follow' ? s : null; }, 300_000, 'the restart');
    const afterKill = status(rdir);
    report.afterKill9 = { resumed: afterKill.resumes === 1, rebased: afterKill.rebases === 1, lastBase: afterKill.lastBase };
    await sleep(PHASE_MS / 2);
    report.afterRestart = await writer.phase();

    // Stop the shipper (SIGTERM), then the old way for comparison, the writer alone: one read transaction held as long
    // as a phase (the old backup held it for its whole copy).
    const beforeStop = status(rdir);
    ship.p.kill('SIGTERM');
    await new Promise((res) => ship.p.once('exit', res));
    ship = null;
    await sleep(1000);
    await writer.phase();
    {
      const rd = new DatabaseSync(file, { readOnly: true });
      rd.exec('BEGIN');
      rd.prepare('SELECT count(*) FROM sqlite_master').get();
      await sleep(PHASE_MS);
      rd.exec('COMMIT');
      rd.close();
      report.heldReader = await writer.phase();
    }

    // The writer stops; the shipper starts again after being away (the WAL started over meanwhile: a new base copy, or a
    // resume if it did not) and catches up; snapshot 2 must equal the source.
    report.writerTotal = await writer.stop();
    writer = null;
    ship = startShipper(file, rdir);
    await until(() => {
      const s = status(rdir);
      return s && s.pid === ship.p.pid && s.mode === 'follow' && s.outstandingBytes === 0 && s.appliedFrame === s.frame && Date.parse(s.at) > Date.now() - 1000 ? s : null;
    }, 300_000, 'the shipper to catch up');
    report.afterAway = (({ resumes, rebases, lastBase }) => ({ resumes, rebases, lastBase }))(status(rdir));
    await sleep(1000);
    const snap2 = join(dir, 'snap2.db');
    r = await run([SHIP, 'snapshot', '--dir', rdir, '--out', snap2, '--timeout', '300']);
    assert.equal(r.code, 0, `snapshot 2: ${r.err}`);
    report.snapshot2 = JSON.parse(r.out);
    const c2 = consistency(snap2);
    assert.equal(c2.integrity, 'ok');
    const src = tableHashes(file);
    const cp = tableHashes(snap2);
    report.final = { source: src, snapshot: cp };
    assert.deepEqual(cp, src, 'snapshot 2 equals the source, table by table');

    // The restore drill on snapshot 2, packed as backup.sh packs it (zstd, .sha256 of the uncompressed file, .meta.json
    // from the check): restored into a scratch directory, checksum, integrity and figures compared.
    {
      r = await run([CHECK, '--check', snap2]);
      assert.equal(r.code, 0, r.err);
      const archive = join(dir, 'valuescan-index-20261109T000000Z.db.zst');
      await pipeline(createReadStream(snap2), createZstdCompress(), createWriteStream(archive));
      const sha = createHash('sha256').update(readFileSync(snap2)).digest('hex');
      writeFileSync(`${archive}.sha256`, `${sha}  valuescan-index-20261109T000000Z.db\n`);
      writeFileSync(`${archive}.meta.json`, JSON.stringify({ check: JSON.parse(r.out), snapshot: report.snapshot2 }));
      const scratch = join(dir, 'drill');
      mkdirSync(scratch);
      const d = await run([DRILL, archive, '--scratch', scratch, '--full']);
      assert.equal(d.code, 0, `drill: ${d.err}`);
      assert.match(d.err, /DRILL PASSED/);
      report.drill = JSON.parse(d.out);
      assert.equal(report.drill.sha256Matches, true);
      assert.equal(report.drill.matchesBackupTime, true);
      assert.deepEqual(readdirSync(scratch), [], 'the drill leaves nothing behind');
      // A figure that does not match fails the drill (and still cleans up).
      const meta = JSON.parse(readFileSync(`${archive}.meta.json`, 'utf8'));
      meta.check.counts.meta += 1;
      writeFileSync(`${archive}.meta.json`, JSON.stringify(meta));
      const bad = await run([DRILL, archive, '--scratch', scratch]);
      assert.equal(bad.code, 1);
      assert.match(bad.err, /rows in meta/);
      assert.deepEqual(readdirSync(scratch), []);
    }

    const st = status(rdir);
    const pick = (x) => ({ frames: x.frames, mb: Math.round(x.bytes / 1e6), commits: x.commits, walRestarts: x.walRestarts, rewinds: x.rewinds, stuck: x.stuck, paused: x.paused, startCatchUpMs: x.startCatchUpMs });
    report.shipper = { beforeKill: { pins: before.pins, ...pick(before) }, afterKill: { pins: beforeStop.pins, ...pick(beforeStop) } };
    ship.p.kill('SIGTERM');
    await new Promise((res) => ship.p.once('exit', res));
    ship = null;

    if (process.env.WALSHIP_TEST_REPORT) writeFileSync(process.env.WALSHIP_TEST_REPORT, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));

    // The bounds. A pin spans the sleep between two reads (WALSHIP_POLL_MS, 10 ms), so it follows the timer and the CPU:
    // Linux keeps timers to the millisecond, Windows' 15.6 ms clock and any loaded machine stretch them. Always: no pin
    // near a second (the old backup held one for 41 minutes), never stuck, the WAL bounded. STRICT (a quiet machine):
    // pins under 100 ms, 99% under 50 ms, and the writer's small commits under 250 ms (the FULL checkpoint's wait).
    for (const p of [before.pins, beforeStop.pins]) {
      assert.ok(p.maxMs < 1000, `longest read transaction ${p.maxMs} ms`);
      if (STRICT) {
        assert.ok(p.maxMs < 100, `longest read transaction ${p.maxMs} ms`);
        assert.ok(['<=5', '<=10', '<=20', '<=50'].includes(p.p99), `99% of read transactions under 50 ms (got ${p.p99})`);
      }
    }
    assert.equal(st.stuck + before.stuck + beforeStop.stuck, 0, 'never stuck');
    const cap = Math.max(4 * report.baseline.checkpointer.logMax, report.baseline.checkpointer.logMax + 16384);
    for (const k of ['duringBaseCopy', 'following', 'duringSnapshot', 'afterRestart']) {
      assert.ok(report[k].checkpointer.logMax <= cap, `WAL ${report[k].checkpointer.logMax} frames ${k} vs ${report.baseline.checkpointer.logMax} without the shipper`);
      if (STRICT) assert.ok(report[k].commitMs.max < 250, `the writer's longest small commit ${k}: ${report[k].commitMs.max} ms`);
    }
  } finally {
    if (ship) ship.p.kill('SIGKILL');
    if (writer) writer.p.kill('SIGKILL');
    await sleep(300);
    if (!process.env.WALSHIP_TEST_KEEP) rmSync(dir, { recursive: true, force: true });
    else console.log(`kept: ${dir}`);
  }
});
