#!/usr/bin/env node
// One health pass over the Valuescan instance. Prints one JSON line, exits 0 when
// everything is healthy and 1 when something is not.
//
//   /opt/node/current/bin/node --disable-warning=ExperimentalWarning /opt/valuescan/bin/healthcheck.mjs
//
// Run by valuescan-health.timer every minute; run it by hand for the same answer
// (as the valuescan user, or with the variables of /etc/valuescan/ops.env set).
//
// WHAT IT CHECKS
//   api        GET /api/health answers {ok:true}
//   lockdown   the server really is in hosted mode: a route that only a local
//              server answers (/api/vs/index/status) must be 404
//   index      one board read through the hosted gate (needs the origin secret):
//              200, ok, and rebuilt recently
//   indexer    /api/vs/index/health - the indexer's own status, which it
//              publishes every 30 s - is fresh, its last build is recent, its
//              streams are up. That route answers a caller on this instance only
//              and needs no secret (apps/server/src/hosted.ts ON_INSTANCE_ROUTES).
//              While the API does not answer it cannot be judged: a warning, the
//              `api` check already fails the pass and `units` says whether the
//              indexer runs.
//   disk       the data volume has room (the nightly backup needs the size of
//              the database free)
//   backup     the last successful backup is not older than 36 hours
//   tls        Caddy's certificate for the origin name is not about to expire
//   executor   the copy executor (EXECUTOR_URL, http://127.0.0.1:8799) answers
//              /api/copy/v1/health with ok - a public route, no secret needed.
//              Its SoDEX feed being down is a warning. Skipped (a warning) when
//              EXECUTOR_URL is empty.
//   units      systemd reports the services active (best effort): indexer, API,
//              Caddy, and the executor when EXECUTOR_URL is set
//
// ALERTS. With ALERT_TOPIC_ARN set it publishes to that SNS topic when the state
// changes (after two failing passes in a row, and again on recovery), and every
// six hours while it stays unhealthy. Nothing secret is ever in a message.
//
// It never opens the index: the file is only stat()ed for its size. So the unit
// needs no write access to the index directory (a WAL reader would: its -shm).
//
// THE SECRET. VALUESCAN_ORIGIN_SECRET may list two values while the secret is
// rotated ("current,next" - api.secret.env). The API accepts each of them; this
// check sends the FIRST, never the whole list (a header holds one value).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statfsSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { dirname, join } from 'node:path';
import tls from 'node:tls';

const env = (k, d = '') => (process.env[k] ?? '').trim() || d;
const num = (k, d) => {
  const n = Number(env(k));
  return Number.isFinite(n) && n > 0 ? n : d;
};

const API_URL = env('API_URL', 'http://127.0.0.1:8797').replace(/\/+$/, '');
// Empty, or not set: the executor is not checked (ops.env sets it).
const EXECUTOR_URL = env('EXECUTOR_URL').replace(/\/+$/, '');
const INDEX_DB = env('VALUESCAN_INDEX_DB', '/var/lib/valuescan/index/valuescan-index.db');
// The first entry of a rotation list ("current,next"): one value per header.
const SECRET = env('VALUESCAN_ORIGIN_SECRET').split(',')[0].trim();
const STATE_DIR = env('HEALTH_STATE_DIR', '/var/lib/valuescan/state');
const TOPIC = env('ALERT_TOPIC_ARN');
const ORIGIN_DOMAIN = env('ORIGIN_DOMAIN');
const INDEXER_STALE_S = num('HEALTH_INDEXER_STALE_S', 180);
const BOARD_STALE_S = num('HEALTH_BOARD_STALE_S', 900);
const DISK_PCT = num('HEALTH_DISK_PCT', 80);
const BACKUP_MAX_AGE_H = num('HEALTH_BACKUP_MAX_AGE_H', 36);
const CERT_MIN_DAYS = num('HEALTH_CERT_MIN_DAYS', 14);
const REALERT_MS = 6 * 3600_000;

const now = Date.now();
const age = (t) => Math.round((now - t) / 1000);

/** A check returns {ok, note} or throws; `warn` results never fail the pass. */
const results = {};
async function check(name, fn) {
  try {
    results[name] = await fn();
  } catch (e) {
    results[name] = { ok: false, note: String(e?.message ?? e).slice(0, 200) };
  }
}

/** One GET on its own connection (no keep-alive: the process must be able to end at once). */
function getJson(path, headers = {}, base = API_URL) {
  return new Promise((resolve, reject) => {
    const client = base.startsWith('https:') ? https : http;
    const req = client.get(base + path, { headers: { accept: 'application/json', ...headers }, agent: false, timeout: 8000 }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { if (text.length < 1_000_000) text += d; });
      res.on('end', () => {
        let body = null;
        try {
          body = JSON.parse(text);
        } catch { /* not JSON */ }
        resolve({ status: res.statusCode, body });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout after 8 s')));
    req.on('error', reject);
  });
}

await check('api', async () => {
  const { status, body } = await getJson('/api/health');
  if (status !== 200 || body?.ok !== true) return { ok: false, note: `/api/health answered ${status}` };
  return { ok: true, note: `${body.network}, trading ${body.mainnetWritesAllowed ? 'allowed' : 'OFF'}` };
});

await check('lockdown', async () => {
  // In hosted mode only the allow-list answers; this diagnostics route is not on it.
  const { status } = await getJson('/api/vs/index/status', SECRET ? { 'x-origin-verify': SECRET } : {});
  if (status === 404) return { ok: true, note: 'hosted mode' };
  if (status === 403 && !SECRET) return { ok: true, note: 'origin secret enforced (none given to this check)' };
  return { ok: false, note: `a non-hosted route answered ${status}: VALUESCAN_HOSTED is not in effect` };
});

await check('index', async () => {
  if (!SECRET) return { ok: true, warn: true, note: 'skipped: VALUESCAN_ORIGIN_SECRET is not available to this check' };
  const { status, body } = await getJson('/api/vs/leaderboard?venue=hyperliquid&window=1d&limit=1', { 'x-origin-verify': SECRET });
  if (status === 403) return { ok: false, note: 'the API refused the origin secret this check holds' };
  if (status !== 200 || body?.ok !== true) return { ok: false, note: `leaderboard answered ${status} ${body?.error ?? ''}`.trim() };
  const updated = body.index?.updatedAt ?? body.updatedAt ?? 0;
  if (!updated) return { ok: false, note: 'the board has never been built' };
  if (age(updated) > BOARD_STALE_S) return { ok: false, note: `the board is ${age(updated)} s old` };
  return { ok: true, note: `board ${age(updated)} s old, ${body.total ?? 0} rows` };
});

await check('indexer', async () => {
  if (!existsSync(INDEX_DB)) return { ok: false, note: `${INDEX_DB} does not exist` };
  // On-instance route: no origin secret (a monitor must not need the edge's credential).
  let r;
  try {
    r = await getJson('/api/vs/index/health');
  } catch (e) {
    return { ok: true, warn: true, note: `not judged: /api/vs/index/health did not answer (${String(e?.message ?? e).slice(0, 60)})` };
  }
  if (r.status !== 200 || r.body?.ok !== true) return { ok: true, warn: true, note: `not judged: /api/vs/index/health answered ${r.status}` };
  const s = r.body.status;
  if (!s || !s.at) return { ok: false, note: 'the indexer has not published a status yet' };
  if (age(s.at) > INDEXER_STALE_S) return { ok: false, note: `the indexer's status is ${age(s.at)} s old` };
  const down = Object.entries(s.streams ?? {}).filter(([, v]) => !v).map(([k]) => k);
  const lag = s.loopLagMs?.lastMinute ?? null;
  const build = s.lastBuildAt ? age(s.lastBuildAt) : null;
  const note = `status ${age(s.at)} s old, last build ${build ?? '?'} s ago in ${s.lastBuildMs ?? '?'} ms, loop lag ${lag ?? '?'} ms`
    + (down.length ? `, streams down: ${down.join(',')}` : '')
    + (s.errorSinceStart ? ', an error was logged since it started (journalctl -u valuescan-indexer)' : '');
  if (build !== null && build > BOARD_STALE_S) return { ok: false, note };
  // A stream that is down right after a restart is normal (Lighter needs minutes): a warning.
  return { ok: true, warn: down.length > 0, note };
});

await check('disk', async () => {
  const notes = [];
  let ok = true;
  for (const [label, path] of [['data', dirname(INDEX_DB)], ['root', '/']]) {
    if (!existsSync(path)) continue;
    const f = statfsSync(path);
    const used = Math.round((1 - f.bavail / f.blocks) * 100);
    const freeGb = Math.round((f.bavail * f.bsize) / 1e8) / 10;
    notes.push(`${label} ${used}% used, ${freeGb} GB free`);
    if (used > DISK_PCT) ok = false;
    if (label === 'data' && existsSync(INDEX_DB)) {
      const need = statSync(INDEX_DB).size * 1.1;
      if (f.bavail * f.bsize < need) {
        ok = false;
        notes.push('not enough room for the next backup copy');
      }
    }
  }
  return { ok, note: notes.join('; ') };
});

await check('backup', async () => {
  const marker = join(STATE_DIR, 'last-backup.json');
  if (!existsSync(marker)) return { ok: true, warn: true, note: 'no backup has completed yet' };
  const hours = Math.round((now - statSync(marker).mtimeMs) / 360_000) / 10;
  return hours > BACKUP_MAX_AGE_H ? { ok: false, note: `the last backup is ${hours} h old` } : { ok: true, note: `last backup ${hours} h ago` };
});

await check('executor', async () => {
  if (!EXECUTOR_URL) return { ok: true, warn: true, note: 'skipped: EXECUTOR_URL is not set' };
  let r;
  try {
    // A public route of the executor (apps/executor/src/server.ts): no origin secret.
    r = await getJson('/api/copy/v1/health', {}, EXECUTOR_URL);
  } catch (e) {
    return { ok: false, note: `the executor does not answer (${String(e?.message ?? e).slice(0, 80)}): journalctl -u valuescan-executor` };
  }
  if (r.status !== 200 || r.body?.ok !== true) return { ok: false, note: `/api/copy/v1/health answered ${r.status}` };
  const b = r.body;
  const note = `${b.copies ?? '?'} copies, ${b.active ?? '?'} active`;
  // A feed that is down right after a restart reconnects by itself: a warning.
  if (b.feeds?.sodex === false) return { ok: true, warn: true, note: `${note}, the SoDEX feed is down` };
  return { ok: true, note };
});

await check('tls', async () => {
  if (!ORIGIN_DOMAIN) return { ok: true, warn: true, note: 'skipped: ORIGIN_DOMAIN is not set' };
  const cert = await new Promise((resolve, reject) => {
    const s = tls.connect({ host: '127.0.0.1', port: 443, servername: ORIGIN_DOMAIN, rejectUnauthorized: false, timeout: 5000 }, () => {
      const c = s.getPeerCertificate();
      s.end();
      resolve(c);
    });
    s.on('error', reject);
    s.on('timeout', () => { s.destroy(); reject(new Error('timeout')); });
  });
  if (!cert?.valid_to) return { ok: false, note: 'Caddy presented no certificate' };
  const days = Math.floor((Date.parse(cert.valid_to) - now) / 86_400_000);
  const issuer = cert.issuer?.O ?? cert.issuer?.CN ?? '?';
  if (/caddy local authority/i.test(String(cert.issuer?.CN ?? ''))) return { ok: false, note: 'Caddy serves its internal certificate: ACME has not succeeded' };
  return days < CERT_MIN_DAYS ? { ok: false, note: `the certificate expires in ${days} days (renewal is failing)` } : { ok: true, note: `certificate from ${issuer}, ${days} days left` };
});

await check('units', async () => {
  const names = ['valuescan-indexer.service', 'valuescan-api.service', 'caddy.service'];
  if (EXECUTOR_URL) names.push('valuescan-executor.service');
  const out = spawnSync('systemctl', ['is-active', ...names], { encoding: 'utf8', timeout: 5000 });
  if (out.error || !out.stdout) return { ok: true, warn: true, note: 'systemd could not be asked' };
  const states = out.stdout.trim().split('\n');
  const bad = names.map((n, i) => [n, states[i] ?? 'unknown']).filter(([, s]) => s !== 'active').map(([n, s]) => `${n}=${s}`);
  return bad.length ? { ok: false, note: bad.join(', ') } : { ok: true, note: 'all active' };
});

const failed = Object.entries(results).filter(([, r]) => !r.ok).map(([k]) => k);
const warned = Object.entries(results).filter(([, r]) => r.ok && r.warn).map(([k]) => k);
const healthy = failed.length === 0;
console.log(JSON.stringify({ ok: healthy, failed, warned, checks: results }));

// --- alerts on a change of state ---------------------------------------------------------
try {
  mkdirSync(STATE_DIR, { recursive: true });
  const file = join(STATE_DIR, 'health-state.json');
  let prev = { alerted: false, streak: 0, lastAlertAt: 0 };
  try {
    prev = { ...prev, ...JSON.parse(readFileSync(file, 'utf8')) };
  } catch { /* first pass */ }
  const streak = healthy ? 0 : prev.streak + 1;
  let alerted = prev.alerted;
  let lastAlertAt = prev.lastAlertAt;
  let subject = null;
  if (!healthy && streak >= 2 && (!prev.alerted || now - prev.lastAlertAt > REALERT_MS)) {
    subject = `Valuescan UNHEALTHY: ${failed.join(', ')}`;
    alerted = true;
    lastAlertAt = now;
  } else if (healthy && prev.alerted) {
    subject = 'Valuescan recovered';
    alerted = false;
  }
  writeFileSync(file, JSON.stringify({ alerted, streak, lastAlertAt, at: now }));
  if (subject && TOPIC) {
    const lines = Object.entries(results).map(([k, r]) => `${r.ok ? (r.warn ? 'warn' : 'ok  ') : 'FAIL'}  ${k}: ${r.note ?? ''}`);
    const sent = spawnSync('aws', ['sns', 'publish', '--topic-arn', TOPIC, '--subject', subject.slice(0, 99), '--message', lines.join('\n')], {
      encoding: 'utf8', timeout: 20_000,
    });
    if (sent.status !== 0) console.error(`healthcheck: alert not sent: ${(sent.stderr || sent.error?.message || '').trim().slice(0, 200)}`);
  }
} catch (e) {
  console.error(`healthcheck: could not record state: ${e?.message ?? e}`);
}

// Not process.exit(): let the last socket close by itself, then end with this code.
process.exitCode = healthy ? 0 : 1;
