// node --disable-warning=ExperimentalWarning --test deploy/server/bin/healthcheck.test.mjs
//
// The health check against a stand-in API on loopback and a toy index file.
// No alert topic is ever set here, so nothing is published anywhere.
//
// The stand-in's port is assigned by the operating system; TEST_PORT_RANGE=8891-8899
// keeps it inside a range (then run the test files one at a time: --test-concurrency=1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import http from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'healthcheck.mjs');
// Made up for each run: no value that looks like a secret is written into the repository.
const SECRET = randomBytes(24).toString('hex');
const OTHER_SECRET = randomBytes(24).toString('hex');

const RANGE = /^(\d+)-(\d+)$/.exec(process.env.TEST_PORT_RANGE ?? '');
const PORTS = RANGE ? Array.from({ length: Number(RANGE[2]) - Number(RANGE[1]) + 1 }, (_, i) => Number(RANGE[1]) + i) : [0];

/** A stand-in for the hosted API. `o` bends it out of shape. */
async function api(o = {}) {
  const handler = (req, res) => {
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    const path = req.url.split('?')[0];
    if (path === '/api/health') return send(200, { ok: true, network: 'mainnet', chainId: 286623, mainnetWritesAllowed: true });
    if (req.headers['x-origin-verify'] !== (o.secret ?? SECRET)) return send(403, { error: 'forbidden' });
    if (path === '/api/vs/index/status') return o.notHosted ? send(200, { ok: true, status: {} }) : send(404, { error: 'not found' });
    if (path === '/api/vs/leaderboard') return send(200, { ok: true, total: 100, rows: [{}], index: { complete: true, pending: 0, updatedAt: Date.now() - (o.boardAgeMs ?? 20_000) } });
    return send(404, { error: 'not found' });
  };
  for (const port of PORTS) {
    const s = http.createServer(handler);
    const bound = await new Promise((ok) => {
      s.once('error', () => ok(false));
      s.listen(port, '127.0.0.1', () => ok(true));
    });
    if (bound) return { url: `http://127.0.0.1:${s.address().port}`, close: () => new Promise((r) => { s.closeAllConnections?.(); s.close(r); }) };
  }
  throw new Error(`no free port in TEST_PORT_RANGE=${process.env.TEST_PORT_RANGE}`);
}

function fixture(o = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'vs-health-'));
  mkdirSync(join(dir, 'index'));
  mkdirSync(join(dir, 'state'));
  const db = join(dir, 'index', 'valuescan-index.db');
  const d = new DatabaseSync(db);
  d.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT) WITHOUT ROWID');
  const now = Date.now();
  const status = {
    at: now - (o.statusAgeMs ?? 5_000), pid: 4242, lastBuildAt: now - (o.buildAgeMs ?? 30_000), lastBuildMs: 900, lastError: null,
    sockets: { sodex: now - 60_000, hyperliquid: now - 60_000, tradexyz: now - 60_000, lighter: o.lighterDown ? null : now - 60_000, arcus: now - 60_000 },
    loopLagMs: { lastMinute: 12, sinceStart: 80, spikes: [] },
  };
  if (!o.noStatus) d.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('indexer_status', JSON.stringify(status));
  d.close();
  if (!o.noBackup) {
    const marker = join(dir, 'state', 'last-backup.json');
    writeFileSync(marker, '{}');
    const t = (now - (o.backupAgeH ?? 2) * 3_600_000) / 1000;
    utimesSync(marker, t, t);
  }
  return { dir, db };
}

function run(env) {
  return new Promise((done) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', SCRIPT], {
      env: { ...process.env, ALERT_TOPIC_ARN: '', ORIGIN_DOMAIN: '', ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.once('exit', (status) => done({ status, err, report: JSON.parse(out.trim().split('\n').at(-1) || '{}') }));
  });
}

const env = (f, a, extra = {}) => ({
  API_URL: a.url, VALUESCAN_INDEX_DB: f.db, HEALTH_STATE_DIR: join(f.dir, 'state'), VALUESCAN_ORIGIN_SECRET: SECRET,
  HEALTH_DISK_PCT: '100', ...extra,
});

test('a healthy instance passes every check', async () => {
  const f = fixture();
  const a = await api();
  try {
    const before = statSync(f.db);
    const r = await run(env(f, a));
    assert.equal(r.status, 0, JSON.stringify(r.report));
    assert.equal(r.report.ok, true);
    assert.deepEqual(r.report.failed, []);
    assert.match(r.report.checks.lockdown.note, /hosted mode/);
    assert.match(r.report.checks.index.note, /board \d+ s old/);
    assert.match(r.report.checks.indexer.note, /loop lag 12 ms/);
    const after = statSync(f.db);
    assert.equal(after.size, before.size, 'the index is opened read-only');
    assert.equal(after.mtimeMs, before.mtimeMs, 'the index is opened read-only');
  } finally {
    await a.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('a server that is not in hosted mode is an alarm', async () => {
  const f = fixture();
  const a = await api({ notHosted: true });
  try {
    const r = await run(env(f, a));
    assert.equal(r.status, 1);
    assert.deepEqual(r.report.failed, ['lockdown']);
    assert.match(r.report.checks.lockdown.note, /VALUESCAN_HOSTED is not in effect/);
  } finally {
    await a.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('an indexer that stopped publishing, a stale board, an old backup and a wrong secret are each found', async () => {
  const cases = [
    [{ statusAgeMs: 10 * 60_000 }, {}, 'indexer', /status is \d+ s old/],
    [{ noStatus: true }, {}, 'indexer', /has not published a status/],
    [{ buildAgeMs: 30 * 60_000 }, {}, 'indexer', /last build \d+ s ago/],
    [{}, { boardAgeMs: 30 * 60_000 }, 'index', /the board is \d+ s old/],
    [{}, { secret: OTHER_SECRET }, 'index', /refused the origin secret/],
    [{ backupAgeH: 50 }, {}, 'backup', /the last backup is 50 h old/],
  ];
  for (const [fx, ax, name, note] of cases) {
    const f = fixture(fx);
    const a = await api(ax);
    try {
      const r = await run(env(f, a));
      assert.equal(r.status, 1, `${name}: ${JSON.stringify(r.report)}`);
      assert.ok(r.report.failed.includes(name), `${name} should fail: ${JSON.stringify(r.report.failed)}`);
      assert.match(r.report.checks[name].note, note);
    } finally {
      await a.close();
      rmSync(f.dir, { recursive: true, force: true });
    }
  }
});

test('a stream that is down and a backup that has not run yet are warnings, not failures', async () => {
  const f = fixture({ lighterDown: true, noBackup: true });
  const a = await api();
  try {
    const r = await run(env(f, a));
    assert.equal(r.status, 0, JSON.stringify(r.report));
    assert.ok(r.report.warned.includes('indexer') && r.report.warned.includes('backup'));
    assert.match(r.report.checks.indexer.note, /streams down: lighter/);
  } finally {
    await a.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('a full disk and an API that is down fail the pass', async () => {
  const f = fixture();
  const a = await api();
  try {
    const full = await run(env(f, a, { HEALTH_DISK_PCT: '0.0001' }));
    assert.ok(full.report.failed.includes('disk'));
    await a.close();
    const down = await run(env(f, a));
    assert.equal(down.status, 1);
    for (const c of ['api', 'lockdown', 'index']) assert.ok(down.report.failed.includes(c), `${c}: ${JSON.stringify(down.report.failed)}`);
    assert.ok(!down.report.failed.includes('indexer'), 'the indexer is judged from the index file, not through the API');
  } finally {
    await a.close().catch(() => {});
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('alerts fire on the second failing pass and again on recovery, never on a single blip', async () => {
  const f = fixture();
  const good = await api();
  const bad = await api({ notHosted: true });
  const state = () => JSON.parse(readFileSync(join(f.dir, 'state', 'health-state.json'), 'utf8'));
  try {
    await run(env(f, good));
    assert.deepEqual([state().alerted, state().streak], [false, 0]);
    await run(env(f, bad));
    assert.deepEqual([state().alerted, state().streak], [false, 1], 'one failing pass is not an alert yet');
    await run(env(f, bad));
    assert.deepEqual([state().alerted, state().streak], [true, 2], 'the second in a row is');
    const firstAlert = state().lastAlertAt;
    await run(env(f, bad));
    assert.equal(state().lastAlertAt, firstAlert, 'no repeat alert on every pass');
    await run(env(f, good));
    assert.deepEqual([state().alerted, state().streak], [false, 0], 'recovery clears it');
  } finally {
    await good.close();
    await bad.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});
