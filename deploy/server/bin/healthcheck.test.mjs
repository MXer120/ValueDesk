// node --disable-warning=ExperimentalWarning --test deploy/server/bin/healthcheck.test.mjs
//
// The health check against a stand-in API on loopback and a stand-in index file
// (only its size is read).
// No alert topic is ever set here, so nothing is published anywhere. Telegram is a
// stand-in on loopback too (ALERT_TELEGRAM_API), with a token made up for each run.
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
  // Every request: its path and the origin secret it carried (the peer tests read this).
  const seen = [];
  const handler = (req, res) => {
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    const path = req.url.split('?')[0];
    seen.push({ path, secret: req.headers['x-origin-verify'] ?? null });
    if (path === '/site') {
      res.writeHead(o.siteStatus ?? 200, { 'content-type': 'text/html' });
      return res.end('<!doctype html><title>site</title>');
    }
    if (path === '/api/health') return send(200, { ok: true, network: 'mainnet', chainId: 286623, mainnetWritesAllowed: true, ...(o.loop ? { loop: o.loop } : {}) });
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
    if (bound) return { url: `http://127.0.0.1:${s.address().port}`, seen, close: () => new Promise((r) => { s.closeAllConnections?.(); s.close(r); }) };
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
    liq: o.liq === null ? null : { ready: o.liqReady ?? true, pending: 40, nowAt: o.liqAgeMs === undefined ? now - 60_000 : o.liqAgeMs === null ? null : now - o.liqAgeMs, since: now - (o.liqSinceMs ?? 3_600_000) },
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
      env: {
        ...process.env, ALERT_TOPIC_ARN: '', ORIGIN_DOMAIN: '', ALERT_TELEGRAM_TOKEN: '', ALERT_TELEGRAM_CHAT_ID: '', ALERT_TELEGRAM_API: '',
        // Never this machine's systemd (a CI runner has one): the units check is then a warning.
        HEALTH_SYSTEMCTL: '/nonexistent/systemctl',
        HEALTH_CHECKS: '', HEALTH_UNITS: '', HEALTH_PEERS_GATED: '', HEALTH_PEERS_PUBLIC: '', HEALTH_BACKUP_MARKERS: '', HEALTH_SERVER_NAME: '', HEALTH_REALERT_H: '',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
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

test("the API's thread stalls are named in the api line, a recent long one as a warning", async () => {
  const f = fixture();
  const a = await api({ loop: { stalls: 3, longestMs: 9_400, lastMinuteMs: 6_200, last: { ms: 6_200, at: Date.now() - 20_000, by: 'req:/api/vs/liquidations/history' }, slowRequests: 2 } });
  try {
    const r = await run(env(f, a));
    assert.equal(r.report.checks.api.ok, true);
    assert.equal(r.report.checks.api.warn, true);
    assert.match(r.report.checks.api.note, /thread stalled 3x since start, longest 9\.4 s, 6\.2 s in the last minute \(last by req:\/api\/vs\/liquidations\/history\)/);
  } finally {
    await a.close();
  }
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
    [{}, { health: indexerHealth({ buildAgeMs: 90 * 60_000 }) }, 'indexer', /last build \d+ s ago/],
    [{}, { health: indexerHealth({ liqAgeMs: 16 * 3_600_000, liqReady: false }) }, 'indexer', /heatmap levels \d+ s old, engine not ready/],
    [{}, { health: indexerHealth({ liqAgeMs: null, liqSinceMs: 20 * 60_000 }) }, 'indexer', /heatmap levels not written since the start \d+ s ago/],
    [{}, { boardAgeMs: 90 * 60_000 }, 'index', /the board is \d+ s old/],
    [{}, { secrets: [OTHER_SECRET] }, 'index', /refused the origin secret/],
    [{ backupAgeH: 50 }, {}, 'backup', /last-backup: the last one is 50 h old/],
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

// --- Telegram, roles, cross-watch -----------------------------------------------------------------

/** A stand-in for api.telegram.org: records each sendMessage; `fail` answers 500 instead. */
async function telegram(o = {}) {
  const token = `${100000 + Math.floor(Math.random() * 899999)}:${randomBytes(27).toString('base64url')}`;
  const sent = [];
  const handler = (req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const ok = req.url === `/bot${token}/sendMessage` && !o.fail;
      if (ok) sent.push(JSON.parse(body));
      res.writeHead(ok ? 200 : 500, { 'content-type': 'application/json' });
      res.end(JSON.stringify(ok ? { ok: true, result: { message_id: sent.length } } : { ok: false, description: 'stand-in refused' }));
    });
  };
  for (const port of PORTS) {
    const s = http.createServer(handler);
    const bound = await new Promise((ok) => {
      s.once('error', () => ok(false));
      s.listen(port, '127.0.0.1', () => ok(true));
    });
    if (bound) {
      return {
        token,
        sent,
        setFail: (v) => { o.fail = v; },
        env: { ALERT_TELEGRAM_TOKEN: token, ALERT_TELEGRAM_CHAT_ID: '123456789', ALERT_TELEGRAM_API: `http://127.0.0.1:${s.address().port}` },
        close: () => new Promise((r) => { s.closeAllConnections?.(); s.close(r); }),
      };
    }
  }
  throw new Error(`no free port in TEST_PORT_RANGE=${process.env.TEST_PORT_RANGE}`);
}

test('Telegram: an alert on the second failing pass names the server and the check, a recovery follows, the token and the secret are never printed', async () => {
  const f = fixture();
  const good = await api();
  const bad = await api({ notHosted: true });
  const tg = await telegram();
  try {
    const e = (a) => env(f, a, { ...tg.env, HEALTH_SERVER_NAME: 'server 1 (France, API)' });
    const r0 = await run(e(good));
    const r1 = await run(e(bad));
    assert.equal(tg.sent.length, 0, 'one failing pass is not an alert');
    const r2 = await run(e(bad));
    assert.equal(tg.sent.length, 1, 'the second is');
    assert.equal(tg.sent[0].chat_id, '123456789');
    assert.match(tg.sent[0].text, /^🚨 FAILURE · server 1 \(France, API\)\nfailing: lockdown\n- lockdown: a non-hosted route/);
    await run(e(bad));
    assert.equal(tg.sent.length, 1, 'no repeat on every pass');
    const r4 = await run(e(good));
    assert.equal(tg.sent.length, 2);
    assert.match(tg.sent[1].text, /^✅ RECOVERED · server 1 \(France, API\)\nevery check passes again \(was failing: lockdown; for \d+ min\)$/);
    for (const r of [r0, r1, r2, r4]) {
      const all = `${r.err}${JSON.stringify(r.report)}`;
      assert.ok(!all.includes(tg.token) && !all.includes(SECRET), 'neither the bot token nor the origin secret is ever printed');
    }
    for (const m of tg.sent) assert.ok(!m.text.includes(SECRET) && !m.text.includes(tg.token), 'nor sent');
  } finally {
    await good.close();
    await bad.close();
    await tg.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('Telegram: an alert that could not be delivered is tried again on the next pass', async () => {
  const f = fixture();
  const bad = await api({ notHosted: true });
  const tg = await telegram({ fail: true });
  try {
    const e = env(f, bad, tg.env);
    await run(e);
    const r = await run(e);
    assert.equal(tg.sent.length, 0);
    assert.match(r.err, /Telegram alert not sent: Telegram answered 500: stand-in refused/);
    assert.ok(!r.err.includes(tg.token), 'the token is scrubbed from the error');
    tg.setFail(false);
    await run(e);
    assert.equal(tg.sent.length, 1, 'delivered on the next pass');
    assert.match(tg.sent[0].text, /^🚨 FAILURE · /);
  } finally {
    await bad.close();
    await tg.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('Telegram: a check that newly fails while already alerted is news (after two passes), and a reminder comes after HEALTH_REALERT_H', async () => {
  const f = fixture();
  const bad = await api({ notHosted: true });
  const worse = await api({ notHosted: true, boardAgeMs: 90 * 60_000 });
  const tg = await telegram();
  try {
    await run(env(f, bad, tg.env));
    await run(env(f, bad, tg.env));
    assert.equal(tg.sent.length, 1);
    await run(env(f, worse, tg.env));
    assert.equal(tg.sent.length, 1, 'a new failure on one pass only is not news yet');
    await run(env(f, worse, tg.env));
    assert.equal(tg.sent.length, 2);
    assert.match(tg.sent[1].text, /now also failing: index\n/);
    await run(env(f, worse, { ...tg.env, HEALTH_REALERT_H: '0.000001' }));
    assert.equal(tg.sent.length, 3);
    assert.match(tg.sent[2].text, /^🚨 FAILURE · still failing \(\d+ min\) - /);
  } finally {
    await bad.close();
    await worse.close();
    await tg.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('maintenance: a window holds the failing checks of the parts it names; closed, they are a FAILURE "after it"', async () => {
  const f = fixture();
  const bad = await api({ notHosted: true }); // lockdown fails: a check of the API's
  const tg = await telegram();
  const maint = join(f.dir, 'state', 'maintenance.json');
  const e = () => env(f, bad, { ...tg.env, HEALTH_MAINT_FILE: maint });
  try {
    writeFileSync(maint, JSON.stringify({ what: 'v0.2.63', parts: ['indexer', 'api'], since: Date.now(), until: Date.now() + 3_600_000, by: 'test' }));
    const r1 = await run(e());
    assert.equal(r1.status, 1, 'the pass itself still fails');
    assert.equal(r1.report.maintenance, 'v0.2.63');
    assert.deepEqual(r1.report.held, ['lockdown']);
    await run(e());
    await run(e());
    assert.equal(tg.sent.length, 0, 'held: three failing passes, nothing sent');
    // maint.sh off: the window kept as maintenance.last.json, with its end.
    rmSync(maint);
    writeFileSync(join(f.dir, 'state', 'maintenance.last.json'), JSON.stringify({ what: 'v0.2.63', parts: ['indexer', 'api'], since: Date.now() - 600_000, until: Date.now() + 3_000_000, ended: Date.now() - 120_000 }));
    const r4 = await run(e());
    assert.equal(r4.report.held, undefined);
    assert.equal(tg.sent.length, 0, 'judged as any other from now on: one pass is not an alert');
    await run(e());
    assert.equal(tg.sent.length, 1);
    assert.match(tg.sent[0].text, /^🚨 FAILURE · .*\nfailing: lockdown\n[\s\S]*\n\(maintenance v0\.2\.63 ended 2 min ago: still failing after it\)$/);
  } finally {
    await bad.close();
    await tg.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('maintenance: a failure of a part the window does not name alerts as always and says so; a window whose time is up holds nothing', async () => {
  const f = fixture();
  const bad = await api({ notHosted: true });
  const tg = await telegram();
  const maint = join(f.dir, 'state', 'maintenance.json');
  const e = () => env(f, bad, { ...tg.env, HEALTH_MAINT_FILE: maint });
  try {
    writeFileSync(maint, JSON.stringify({ what: 'v0.2.63', parts: ['executor'], since: Date.now(), until: Date.now() + 3_600_000 }));
    const r1 = await run(e());
    assert.deepEqual(r1.report.held, [], 'lockdown is not the executor');
    await run(e());
    assert.equal(tg.sent.length, 1);
    assert.match(tg.sent[0].text, /^🚨 FAILURE · [\s\S]*\(maintenance v0\.2\.63 is running - executor - this is not part of it\)$/);
    rmSync(join(f.dir, 'state', 'health-state.json'));
    tg.sent.length = 0;
    writeFileSync(maint, JSON.stringify({ what: 'v0.2.64', parts: ['api'], since: Date.now() - 7_200_000, until: Date.now() - 60_000 }));
    const r3 = await run(e());
    assert.equal(r3.report.held, undefined, 'its time is up: as if closed then');
    await run(e());
    assert.equal(tg.sent.length, 1);
    assert.match(tg.sent[0].text, /\(maintenance v0\.2\.64 ended 1 min ago: still failing after it\)$/);
  } finally {
    await bad.close();
    await tg.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('roles: the copy executor server checks only its own things - no API, no index - and is healthy without them', async () => {
  const f = fixture();
  rmSync(f.db);
  const exec = await api();
  const apiDown = await api();
  const deadUrl = apiDown.url;
  await apiDown.close();
  try {
    const r = await run(env(f, exec, {
      API_URL: deadUrl,
      HEALTH_CHECKS: 'executor,disk,backup,tls,units',
      HEALTH_UNITS: 'valuescan-executor.service,caddy.service',
    }));
    assert.equal(r.status, 0, JSON.stringify(r.report));
    assert.deepEqual(Object.keys(r.report.checks).sort(), ['backup', 'disk', 'executor', 'tls', 'units']);
    assert.equal(r.report.checks.executor.note, '3 copies, 2 active');
  } finally {
    await exec.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('cross-watch: a gated peer gets the origin secret, a public one never does; a dead peer fails its own check', async () => {
  const f = fixture();
  const local = await api();
  const peer = await api();
  const site = await api();
  const gone = await api();
  const goneUrl = gone.url;
  await gone.close();
  try {
    const r = await run(env(f, local, {
      HEALTH_PEERS_GATED: `executor@server2=${peer.url}/api/copy/v1/health,api@server1=${peer.url}/api/health`,
      HEALTH_PEERS_PUBLIC: `site=${site.url}/site,site-api=${site.url}/api/health`,
    }));
    assert.equal(r.status, 0, JSON.stringify(r.report));
    assert.equal(r.report.checks['peer:executor@server2'].ok, true);
    assert.match(r.report.checks['peer:site'].note, /\/site 200, \d+ bytes/);
    assert.ok(peer.seen.length >= 2 && peer.seen.every((s) => s.secret === SECRET), 'the gated peer got the secret');
    assert.ok(site.seen.length >= 2 && site.seen.every((s) => s.secret === null), 'the public one never');

    const down = await run(env(f, local, { HEALTH_PEERS_GATED: `executor@server2=${goneUrl}/api/copy/v1/health`, HEALTH_PEERS_PUBLIC: `site=${site.url}/nope` }));
    assert.equal(down.status, 1);
    assert.deepEqual(down.report.failed.sort(), ['peer:executor@server2', 'peer:site']);
    assert.match(down.report.checks['peer:executor@server2'].note, /does not answer/);
    assert.match(down.report.checks['peer:site'].note, /\/nope answered 4\d\d$/);

    const clear = await run(env(f, local, { HEALTH_PEERS_GATED: 'other=http://192.0.2.10/api/health' }));
    assert.ok(clear.report.failed.includes('peer:other'));
    assert.match(clear.report.checks['peer:other'].note, /must be https/);
  } finally {
    await local.close();
    await peer.close();
    await site.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('backup markers: each listed marker must be recent; one not there yet only warns', async () => {
  const f = fixture();
  const a = await api();
  try {
    const offsite = join(f.dir, 'state', 'offsite-api-state.json');
    writeFileSync(offsite, '{}');
    const old = (Date.now() - 40 * 3_600_000) / 1000;
    utimesSync(offsite, old, old);
    const r = await run(env(f, a, { HEALTH_BACKUP_MARKERS: `${join(f.dir, 'state', 'last-backup.json')},${offsite}` }));
    assert.ok(r.report.failed.includes('backup'));
    assert.match(r.report.checks.backup.note, /offsite-api-state: the last one is 40 h old/);
    const r2 = await run(env(f, a, { HEALTH_BACKUP_MARKERS: `${join(f.dir, 'state', 'last-backup.json')},${join(f.dir, 'state', 'offsite-none.json')}` }));
    assert.ok(!r2.report.failed.includes('backup'));
    assert.ok(r2.report.warned.includes('backup'));
  } finally {
    await a.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});
