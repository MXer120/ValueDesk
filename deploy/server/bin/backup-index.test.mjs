// node --disable-warning=ExperimentalWarning --test deploy/server/bin/backup-index.test.mjs
//
// The backup must be a consistent copy of a database that is being written to,
// must not disturb the writer, and must never touch the source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'backup-index.mjs');
const NODE = [process.execPath, '--disable-warning=ExperimentalWarning'];
const run = (...args) => spawnSync(NODE[0], [NODE[1], SCRIPT, ...args], { encoding: 'utf8' });

/**
 * A writer in its own process, like the indexer: WAL, one transaction per tick
 * that inserts a row AND bumps a counter. In any consistent snapshot the counter
 * equals the number of rows.
 */
const WRITER = `
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.argv[2]);
db.exec('PRAGMA busy_timeout = 5000');
let n = 0, errors = 0;
const tick = () => {
  try {
    db.exec('BEGIN IMMEDIATE');
    for (let i = 0; i < 20; i++) db.prepare('INSERT INTO fills (id, payload) VALUES (?, ?)').run(++n + '-' + process.pid, 'x'.repeat(400));
    db.prepare("UPDATE meta SET value = CAST(value AS INTEGER) + 20 WHERE key = 'count'").run();
    db.exec('COMMIT');
  } catch (e) { errors++; try { db.exec('ROLLBACK'); } catch {} }
};
const t = setInterval(tick, 2);
process.on('message', (m) => { if (m === 'stop') { clearInterval(t); db.close(); process.send({ n, errors }); process.exit(0); } });
process.send('ready');
`;

function seed(file, rows = 0) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT) WITHOUT ROWID');
  db.exec('CREATE TABLE fills (id TEXT PRIMARY KEY, payload TEXT NOT NULL) WITHOUT ROWID');
  db.exec('CREATE TABLE board_meta (venue TEXT PRIMARY KEY) WITHOUT ROWID');
  db.exec('CREATE TABLE accounts (venue TEXT, address TEXT, PRIMARY KEY (venue, address)) WITHOUT ROWID');
  db.exec('CREATE TABLE coverage (venue TEXT PRIMARY KEY) WITHOUT ROWID');
  db.prepare("INSERT INTO meta (key, value) VALUES ('schema', '1'), ('count', ?)").run(String(rows));
  const ins = db.prepare('INSERT INTO fills (id, payload) VALUES (?, ?)');
  db.exec('BEGIN');
  for (let i = 0; i < rows; i++) ins.run(`seed-${i}`, 'x'.repeat(400));
  db.exec('COMMIT');
  db.close();
}

const counts = (file) => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return {
      rows: db.prepare('SELECT count(*) AS n FROM fills').get().n,
      counter: Number(db.prepare("SELECT value FROM meta WHERE key = 'count'").get().value),
    };
  } finally {
    db.close();
  }
};

test('copies a database that is being written to, consistently, without disturbing the writer', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vs-backup-'));
  try {
    const source = join(dir, 'index.db');
    const copy = join(dir, 'copy.db');
    seed(source, 20_000);
    const writerFile = join(dir, 'writer.mjs');
    writeFileSync(writerFile, WRITER);
    const writer = spawn(NODE[0], [NODE[1], writerFile, source], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    await new Promise((res, rej) => { writer.once('message', res); writer.once('error', rej); });
    await new Promise((r) => setTimeout(r, 200)); // the writer is mid-stream

    const before = statSync(source).mtimeMs;
    const out = run(source, copy);
    assert.equal(out.status, 0, out.stderr);
    const report = JSON.parse(out.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.schema, '1');

    const done = new Promise((res) => writer.once('message', res));
    writer.send('stop');
    const { n, errors } = await done;
    assert.equal(errors, 0, 'the writer must never see the backup (no busy error)');
    assert.ok(n > 0, 'the writer wrote during the test');

    // The copy is one instant of the source: rows and counter agree.
    const c = counts(copy);
    assert.equal(c.rows, c.counter, 'the copy is transactionally consistent');
    assert.ok(c.rows >= 20_000);
    // ... and the source carried on beyond it.
    const s = counts(source);
    assert.equal(s.rows, s.counter);
    assert.ok(s.rows >= c.rows);
    assert.ok(statSync(source).mtimeMs >= before);
    assert.equal(run('--check', copy).status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('never overwrites an existing copy and never copies onto the source', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vs-backup-'));
  try {
    const source = join(dir, 'index.db');
    seed(source, 10);
    const copy = join(dir, 'copy.db');
    assert.equal(run(source, copy).status, 0);
    const again = run(source, copy);
    assert.equal(again.status, 1);
    assert.match(again.stderr, /already exists/);
    const self = run(source, source);
    assert.equal(self.status, 1);
    assert.match(self.stderr, /cannot be the source/);
    const missing = run(join(dir, 'nope.db'), join(dir, 'x.db'));
    assert.equal(missing.status, 1);
    assert.equal(existsSync(join(dir, 'x.db')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--check refuses a file that is not a healthy database', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vs-backup-'));
  try {
    const good = join(dir, 'good.db');
    seed(good, 5);
    assert.equal(run('--check', good).status, 0);
    const bad = join(dir, 'bad.db');
    writeFileSync(bad, Buffer.alloc(8192, 7));
    assert.notEqual(run('--check', bad).status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the source is opened read-only: its schema and data are untouched', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vs-backup-'));
  try {
    const source = join(dir, 'index.db');
    seed(source, 50);
    const before = counts(source);
    assert.equal(run(source, join(dir, 'copy.db')).status, 0);
    assert.deepEqual(counts(source), before);
    const db = new DatabaseSync(source, { readOnly: true });
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name);
    db.close();
    assert.deepEqual(tables, ['accounts', 'board_meta', 'coverage', 'fills', 'meta']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
