// node --disable-warning=ExperimentalWarning --test deploy/server/bin/healthcheck.test.mjs
//
// The health check against a stand-in API on loopback and a stand-in index file
// (only its size is read).
// No alert topic is ever set here, so nothing is published anywhere.
//
// The stand-in's port is assigned by the operating system; TEST_PORT_RANGE=8891-8899
// keeps it inside a range (then run the test files one at a time: --test-concurrency=1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
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

/**
 * A stand-in for the hosted API. `o` bends it out of shape; `o.health` is what
 * /api/vs/index/health reports (null: the indexer has not published a status).
 * Like the real gate, that on-instance route needs no origin secret; every other
 * route but /api/health does, and exactly one value of it.
 * It also plays the copy executor's public /api/copy/v1/health (apps/executor
 * server.ts): `o.executor` is what that answers (a status and a body).
 */
async function api(o = {}) {
  const handler = (req, res) => {
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    const path = req.url.split('?')[0];
    if (path === '/api/health') return send(200, { ok: true, network: 'mainnet', chainId: 286623, mainnetWritesAllowed: true });
    if (path === '/api/copy/v1/health') {
      const e = o.executor ?? { status: 200, body: { ok: true, copies: 3, active: 2, feeds: { sodex: true } } };
      return send(e.status, e.body);
    }
    if (path === '/api/vs/index/health') return send(200, { ok: true, status: o.health === undefined ? indexerHealth() : o.health });
    if (!(o.secrets ?? [SECRET]).includes(req.headers['x-origin-verify'])) return send(403, { error: 'forbidden' });
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

/** What /api/vs/index/health answers (apps/server/src/hosted.ts indexerHealth): numbers and booleans. */
function indexerHealth(o = {}) {
  const now = Date.now();
  return {
    at: now - (o.statusAgeMs ?? 5_000),
    streams: { sodex: true, hyperliquid: true, tradexyz: true, lighter: !o.lighterDown, arcus: true },
    loopLagMs: { lastMinute: 12, sinceStart: 80 },
    lanes: {},
    lastBuildAt: now - (o.buildAgeMs ?? 30_000),
    lastBuildMs: 900,
    errorSinceStart: false,
  };
}

/** A data directory: an index file (only its size is read) and the state directory. */
function fixture(o = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'vs-health-'));
  mkdirSync(join(dir, 'index'));
  mkdirSync(join(dir, 'state'));
  const db = join(dir, 'index', 'valuescan-index.db');
  writeFileSync(db, 'not a database: the health check must never open it');
  const now = Date.now();
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
  API_URL: a.url, EXECUTOR_URL: a.url, VALUESCAN_INDEX_DB: f.db, HEALTH_STATE_DIR: join(f.dir, 'state'), VALUESCAN_ORIGIN_SECRET: SECRET,
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
    assert.equal(r.report.checks.executor.note, '3 copies, 2 active');
    const after = statSync(f.db);
    assert.equal(after.size, before.size, 'the index file is never written');
    assert.equal(after.mtimeMs, before.mtimeMs, 'the index file is never written');
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
    [{}, { health: indexerHealth({ statusAgeMs: 10 * 60_000 }) }, 'indexer', /status is \d+ s old/],
    [{}, { health: null }, 'indexer', /has not published a status/],
    [{}, { health: indexerHealth({ buildAgeMs: 30 * 60_000 }) }, 'indexer', /last build \d+ s ago/],
    [{}, { boardAgeMs: 30 * 60_000 }, 'index', /the board is \d+ s old/],
    [{}, { secrets: [OTHER_SECRET] }, 'index', /refused the origin secret/],
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

test('during a rotation the check sends the FIRST value of the secret list, never the list', async () => {
  const f = fixture();
  // The API accepts only the first value here: a check that sent "a,b" or the second would fail.
  const a = await api({ secrets: [SECRET] });
  try {
    const r = await run(env(f, a, { VALUESCAN_ORIGIN_SECRET: `${SECRET},${OTHER_SECRET}` }));
    assert.equal(r.status, 0, JSON.stringify(r.report));
    assert.match(r.report.checks.index.note, /board \d+ s old/);
    assert.match(r.report.checks.lockdown.note, /hosted mode/);
  } finally {
    await a.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('the copy executor: down or unhealthy fails the pass, a feed that is down warns, no EXECUTOR_URL skips it', async () => {
  const f = fixture();
  const sick = await api({ executor: { status: 500, body: { ok: false, code: 'internal' } } });
  const feedDown = await api({ executor: { status: 200, body: { ok: true, copies: 1, active: 1, feeds: { sodex: false } } } });
  const fine = await api();
  const closed = await api();
  const closedUrl = closed.url;
  await closed.close();
  try {
    const r1 = await run(env(f, sick));
    assert.equal(r1.status, 1);
    assert.deepEqual(r1.report.failed, ['executor'], 'only the executor fails: the API is fine');
    assert.match(r1.report.checks.executor.note, /answered 500/);

    // The API answers, nothing listens where the executor should: the executor alone fails.
    const r2 = await run(env(f, fine, { EXECUTOR_URL: closedUrl }));
    assert.equal(r2.status, 1);
    assert.deepEqual(r2.report.failed, ['executor']);
    assert.match(r2.report.checks.executor.note, /does not answer/);

    const r3 = await run(env(f, feedDown));
    assert.equal(r3.status, 0, JSON.stringify(r3.report));
    assert.ok(r3.report.warned.includes('executor'));
    assert.match(r3.report.checks.executor.note, /SoDEX feed is down/);

    const r4 = await run(env(f, fine, { EXECUTOR_URL: '' }));
    assert.equal(r4.status, 0, JSON.stringify(r4.report));
    assert.ok(r4.report.warned.includes('executor'));
    assert.match(r4.report.checks.executor.note, /skipped/);
  } finally {
    await sick.close();
    await feedDown.close();
    await fine.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('a stream that is down and a backup that has not run yet are warnings, not failures', async () => {
  const f = fixture({ noBackup: true });
  const a = await api({ health: indexerHealth({ lighterDown: true }) });
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
    assert.ok(!down.report.failed.includes('indexer'), 'an API that is down does not also fail the indexer');
    assert.ok(down.report.warned.includes('indexer'), 'the indexer cannot be judged without the API: a warning');
    assert.match(down.report.checks.indexer.note, /not judged/);
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
