#!/usr/bin/env node
// One health pass over a ValueDesk server. Prints one JSON line, exits 0 when
// everything is healthy and 1 when something is not.
//
//   /opt/node/current/bin/node --disable-warning=ExperimentalWarning /opt/valuescan/bin/healthcheck.mjs
//
// Run by valuescan-health.timer every minute; run it by hand for the same answer
// (as the valuescan user, or with the variables of /etc/valuescan/ops.env and
// health.env set).
//
// WHAT IT CHECKS
//   api        GET /api/health answers {ok:true}
//   lockdown   the server really is in hosted mode: a route that only a local
//              server answers (/api/vs/index/status) must be 404
//   index      one board read through the hosted gate (needs the origin secret):
//              200, ok, and rebuilt recently
//   indexer    /api/vs/index/health - the indexer's own status, which it
//              publishes every 30 s - is fresh, its last build is recent, its
//              streams are up, and the liquidation heatmap's levels were written
//              within HEALTH_LIQ_STALE_S (900). That route answers a caller on this instance only
//              and needs no secret (apps/server/src/hosted.ts ON_INSTANCE_ROUTES).
//              While the API does not answer it cannot be judged: a warning, the
//              `api` check already fails the pass and `units` says whether the
//              indexer runs.
//   disk       the data volume has room (the nightly backup needs the size of
//              the database free)
//   backup     every backup marker (HEALTH_BACKUP_MARKERS, default the nightly
//              index backup's last-backup.json) is younger than 36 hours. The
//              off-server copies write theirs (backup-offsite.sh: offsite-<set>.json).
//   tls        Caddy's certificate for the origin name is not about to expire
//   executor   the copy executor (EXECUTOR_URL, http://127.0.0.1:8799) answers
//              /api/copy/v1/health with ok - a public route, no secret needed.
//              Its SoDEX feed being down is a warning. Skipped (a warning) when
//              EXECUTOR_URL is empty.
//   units      systemd reports the services active (best effort): HEALTH_UNITS, or
//              indexer, API, Caddy, and the executor when EXECUTOR_URL is set
//   peer:<n>   CROSS-WATCH: the other server (or the public site) answers. Each
//              entry of HEALTH_PEERS_GATED / HEALTH_PEERS_PUBLIC is name=url; a GET
//              must answer 2xx, and a JSON answer must not say ok:false. GATED peers
//              are origins behind a Caddy gate: they get the origin secret (only over
//              https, or http on loopback). PUBLIC ones (the site through Vercel) never
//              get it. So a server that is dead entirely is still reported - by the
//              other one.
//
// ROLES. HEALTH_CHECKS (comma-separated) picks the checks; unset = every one of the
// list above but the peers, as before. Server 1 (API + indexer) and server 2 (the
// copy executor only) each have their list in /etc/valuescan/health.env
// (deploy/contabo/server*/health.env).
//
// ALERTS on a change of state: after two failing passes in a row, again when a check
// that was not failing before has failed twice too, on recovery, and every six hours
// while it stays unhealthy. To Telegram (ALERT_TELEGRAM_TOKEN + ALERT_TELEGRAM_CHAT_ID,
// /etc/valuescan/alert.env, deploy/server/bin/telegram.mjs) and/or the SNS topic
// ALERT_TOPIC_ARN (AWS only). A message names the server (HEALTH_SERVER_NAME) and the
// failing checks with their notes; nothing secret is ever in one. When no channel
// takes the message it is tried again on the next pass. Its first line says what it is
// (telegram.mjs LABELS): "🚨 FAILURE · <server>" or "✅ RECOVERED · <server>".
//
// MAINTENANCE. While a maintenance window is open on this server (maint.sh on - ship.sh
// opens one on both servers before it restarts anything; HEALTH_MAINT_FILE, default
// /var/lib/valuescan/maintenance.json), a failing check of a part it names is expected:
// it is held - not alerted, not counted - and the JSON line lists it under `held`. Which
// part a check belongs to: api, lockdown -> api; index, indexer -> api and indexer;
// executor -> executor; units -> the parts among HEALTH_UNITS (valuescan-<part>.service);
// peer:<name> -> executor when the name says executor or copy, api when it says api;
// disk, backup, tls -> none (never held). A check that was alerted before the window
// opened stays alerted. Once the window is closed (or its time is up) a held check is
// judged as any other - two failing passes, then a FAILURE - and for 30 minutes the
// message says it came right after the maintenance. A failure of anything else alerts
// during a window as always, and says it is not part of it.
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
import { hostname } from 'node:os';
import { basename, dirname, join } from 'node:path';
import tls from 'node:tls';
import { labelled, sendTelegram } from './telegram.mjs';

const env = (k, d = '') => (process.env[k] ?? '').trim() || d;
const num = (k, d) => {
  const n = Number(env(k));
  return Number.isFinite(n) && n > 0 ? n : d;
};
const list = (k) => env(k).split(',').map((s) => s.trim()).filter(Boolean);

const API_URL = env('API_URL', 'http://127.0.0.1:8797').replace(/\/+$/, '');
// Empty, or not set: the executor is not checked (ops.env sets it; health.env may empty it).
const EXECUTOR_URL = env('EXECUTOR_URL').replace(/\/+$/, '');
const INDEX_DB = env('VALUESCAN_INDEX_DB', '/var/lib/valuescan/index/valuescan-index.db');
// The first entry of a rotation list ("current,next"): one value per header.
const SECRET = env('VALUESCAN_ORIGIN_SECRET').split(',')[0].trim();
const STATE_DIR = env('HEALTH_STATE_DIR', '/var/lib/valuescan/state');
const TOPIC = env('ALERT_TOPIC_ARN');
const TG_TOKEN = env('ALERT_TELEGRAM_TOKEN');
const TG_CHAT = env('ALERT_TELEGRAM_CHAT_ID');
const TG_API = env('ALERT_TELEGRAM_API');
const ORIGIN_DOMAIN = env('ORIGIN_DOMAIN');
const SERVER_NAME = env('HEALTH_SERVER_NAME', ORIGIN_DOMAIN || hostname());
const INDEXER_STALE_S = num('HEALTH_INDEXER_STALE_S', 180);
// An hour, as on the status page: 15 min failed 92% of the passes on 2026-11-04, so a real failure was lost in the noise.
const BOARD_STALE_S = num('HEALTH_BOARD_STALE_S', 3600);
const LIQ_STALE_S = num('HEALTH_LIQ_STALE_S', 900);
const DISK_PCT = num('HEALTH_DISK_PCT', 80);
const BACKUP_MAX_AGE_H = num('HEALTH_BACKUP_MAX_AGE_H', 36);
const CERT_MIN_DAYS = num('HEALTH_CERT_MIN_DAYS', 14);
const REALERT_MS = num('HEALTH_REALERT_H', 6) * 3600_000;
const MAINT_FILE = env('HEALTH_MAINT_FILE', '/var/lib/valuescan/maintenance.json');
// How long after a window a failure is said to have come right after it.
const AFTER_MAINT_MS = 30 * 60_000;

const ALL_CHECKS = ['api', 'lockdown', 'index', 'indexer', 'disk', 'backup', 'executor', 'tls', 'units'];
const CHECKS = list('HEALTH_CHECKS').length ? list('HEALTH_CHECKS') : ALL_CHECKS;
for (const c of CHECKS) if (!ALL_CHECKS.includes(c)) console.error(`healthcheck: HEALTH_CHECKS names an unknown check "${c}" (known: ${ALL_CHECKS.join(', ')})`);
const MARKERS = list('HEALTH_BACKUP_MARKERS').length ? list('HEALTH_BACKUP_MARKERS') : [join(STATE_DIR, 'last-backup.json')];

/** "name=url,name=url" -> [{name, url}]; a bad entry is reported as a failing check of its own. */
function peers(k, gated) {
  return list(k).map((entry) => {
    const i = entry.indexOf('=');
    const name = i > 0 ? entry.slice(0, i).trim() : '';
    const url = i > 0 ? entry.slice(i + 1).trim() : '';
    return { name: /^[A-Za-z0-9@._-]{1,40}$/.test(name) ? name : `bad-entry-in-${k}`, url, gated };
  });
}
const PEERS = [...peers('HEALTH_PEERS_GATED', true), ...peers('HEALTH_PEERS_PUBLIC', false)];

const now = Date.now();
const age = (t) => Math.round((now - t) / 1000);

/** A check returns {ok, note} or throws; `warn` results never fail the pass. */
const results = {};
async function check(name, fn) {
  if (!CHECKS.includes(name)) return;
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
        resolve({ status: res.statusCode, body, bytes: text.length, type: String(res.headers['content-type'] ?? '') });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout after 8 s')));
    req.on('error', reject);
  });
}

await check('api', async () => {
  const { status, body } = await getJson('/api/health');
  if (status !== 200 || body?.ok !== true) return { ok: false, note: `/api/health answered ${status}` };
  const loop = loopNote(body.loop);
  return { ok: true, ...(loop.warn ? { warn: true } : {}), note: `${body.network}, trading ${body.mainnetWritesAllowed ? 'allowed' : 'OFF'}${loop.text}` };
});

/**
 * The API's own thread (apps/server/src/loopWatch.ts): its stalls since the start, and a warning when one in the last
 * minute reached 5 s - named by what started it, so an alert says which route or timer held the API (2026-11-07).
 */
function loopNote(loop) {
  if (!loop || typeof loop !== 'object' || !loop.stalls) return { warn: false, text: '' };
  const s = (ms) => `${(Number(ms) / 1000).toFixed(1)} s`;
  const by = loop.last?.by ? ` (last by ${String(loop.last.by).slice(0, 80)})` : '';
  const warn = Number(loop.lastMinuteMs) >= 5_000;
  return { warn, text: `; thread stalled ${loop.stalls}x since start, longest ${s(loop.longestMs)}${warn ? `, ${s(loop.lastMinuteMs)} in the last minute` : ''}${by}` };
}

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
  // The liquidation heatmap: its levels are written every 2 minutes once the engine has priced
  // every book. Not written for LIQ_STALE_S (counted from the start when not yet since it) is
  // a heatmap answering from old levels - as for 16 hours from 2026-10-27 23:16 UTC, unalerted.
  const liq = s.liq;
  if (liq) {
    const liqAge = age(liq.nowAt ?? liq.since ?? s.at);
    const liqNote = `${note}, heatmap levels ${liq.nowAt ? `${liqAge} s old` : `not written since the start ${liqAge} s ago`}`
      + `${liq.ready ? '' : ', engine not ready'}, ${liq.pending ?? '?'} accounts waiting`;
    if (liqAge > LIQ_STALE_S) return { ok: false, note: liqNote };
    return { ok: true, warn: down.length > 0, note: liqNote };
  }
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
  const notes = [];
  let ok = true;
  let missing = 0;
  for (const marker of MARKERS) {
    const label = basename(marker).replace(/\.json$/, '');
    if (!existsSync(marker)) {
      missing++;
      notes.push(`${label}: none completed yet`);
      continue;
    }
    const hours = Math.round((now - statSync(marker).mtimeMs) / 360_000) / 10;
    if (hours > BACKUP_MAX_AGE_H) {
      ok = false;
      notes.push(`${label}: the last one is ${hours} h old`);
    } else notes.push(`${label}: ${hours} h ago`);
  }
  // A marker that does not exist yet (a new server, before its first night) is a warning.
  return { ok, warn: ok && missing > 0, note: notes.join('; ') };
});

await check('executor', async () => {
  if (!EXECUTOR_URL) return { ok: true, warn: true, note: 'skipped: EXECUTOR_URL is not set' };
  let r;
  try {
    // A public route of the executor (apps/executor/src/server.ts): no origin secret.
    r = await getJson('/api/copy/v1/health', {}, EXECUTOR_URL);
  } catch (e) {
    return { ok: false, note: `the executor does not answer (${String(e?.message ?? e).slice(0, 80)}): journalctl --namespace=pii -u valuescan-executor` };
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

/** The units the `units` check asks systemd about. */
function unitNames() {
  const names = list('HEALTH_UNITS');
  if (names.length) return names;
  return ['valuescan-indexer.service', 'valuescan-api.service', 'caddy.service', ...(EXECUTOR_URL ? ['valuescan-executor.service'] : [])];
}

await check('units', async () => {
  const names = unitNames();
  const out = spawnSync(env('HEALTH_SYSTEMCTL', 'systemctl'), ['is-active', ...names], { encoding: 'utf8', timeout: 5000 });
  if (out.error || !out.stdout) return { ok: true, warn: true, note: 'systemd could not be asked' };
  const states = out.stdout.trim().split('\n');
  const bad = names.map((n, i) => [n, states[i] ?? 'unknown']).filter(([, s]) => s !== 'active').map(([n, s]) => `${n}=${s}`);
  return bad.length ? { ok: false, note: bad.join(', ') } : { ok: true, note: `all active (${names.length})` };
});

// The cross-watch: all peers at once (each has its own 8 s limit).
await Promise.all(PEERS.map(async (p) => {
  const name = `peer:${p.name}`;
  try {
    let u;
    try {
      u = new URL(p.url);
    } catch {
      results[name] = { ok: false, note: 'not a URL (health.env)' };
      return;
    }
    const loopback = u.hostname === '127.0.0.1' || u.hostname === 'localhost';
    if (p.gated && u.protocol !== 'https:' && !loopback) {
      results[name] = { ok: false, note: 'a gated peer must be https:// - the origin secret never travels in clear text' };
      return;
    }
    const headers = p.gated && SECRET ? { 'x-origin-verify': SECRET } : {};
    const r = await getJson(u.pathname + u.search, headers, `${u.protocol}//${u.host}`);
    if (r.status < 200 || r.status > 299) results[name] = { ok: false, note: `${u.host}${u.pathname} answered ${r.status}` };
    else if (r.body && r.body.ok === false) results[name] = { ok: false, note: `${u.host}${u.pathname} answered ok:false` };
    else results[name] = { ok: true, note: `${u.host}${u.pathname} ${r.status}${r.body ? '' : `, ${r.bytes} bytes`}` };
  } catch (e) {
    results[name] = { ok: false, note: `${p.name} does not answer (${String(e?.code ?? e?.message ?? e).slice(0, 80)})` };
  }
}));

const failed = Object.entries(results).filter(([, r]) => !r.ok).map(([k]) => k);
const warned = Object.entries(results).filter(([, r]) => r.ok && r.warn).map(([k]) => k);
const healthy = failed.length === 0;

// --- maintenance (the header: MAINTENANCE) ------------------------------------------------

const readJson = (f) => {
  try {
    return JSON.parse(readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
};
/** A window as maint.sh writes it, or null for anything else. */
function asWindow(w) {
  if (!w || typeof w !== 'object' || !Number.isFinite(Number(w.until))) return null;
  const at = (v) => (Number.isFinite(Number(v)) && v !== null ? Number(v) : null);
  return {
    what: String(w.what ?? 'maintenance').slice(0, 80),
    parts: Array.isArray(w.parts) ? w.parts.filter((p) => typeof p === 'string') : [],
    until: Number(w.until),
    ended: at(w.ended),
  };
}
const openOrNot = asWindow(readJson(MAINT_FILE));
/** The window open now, or null. */
const MAINT = openOrNot && openOrNot.until > now ? openOrNot : null;
/** The last window, once closed: maint.sh off keeps it (with `ended`); one whose time ran out ended then. */
const MAINT_LAST = MAINT ? null : openOrNot ? { ...openOrNot, ended: openOrNot.until } : asWindow(readJson(MAINT_FILE.replace(/\.json$/, '.last.json')));

/** The parts a check belongs to (the header lists them). */
function partsOfCheck(k) {
  if (k === 'api' || k === 'lockdown') return ['api'];
  if (k === 'index' || k === 'indexer') return ['api', 'indexer'];
  if (k === 'executor') return ['executor'];
  if (k === 'units') return unitNames().map((u) => /^valuescan-(api|indexer|executor)\.service$/.exec(u)?.[1]).filter(Boolean);
  if (k.startsWith('peer:')) {
    const n = k.slice(5);
    if (/executor|copy/i.test(n)) return ['executor'];
    if (/api/i.test(n)) return ['api'];
  }
  return [];
}

const STATE_FILE = join(STATE_DIR, 'health-state.json');
let prev = {};
try {
  prev = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
} catch { /* first pass */ }
// Expected while the window is open - unless it was alerted before it opened.
const held = MAINT ? failed.filter((k) => partsOfCheck(k).some((p) => MAINT.parts.includes(p)) && !(prev.alertedFailed ?? []).includes(k)) : [];
const alerting = failed.filter((k) => !held.includes(k));
console.log(JSON.stringify({ ok: healthy, server: SERVER_NAME, failed, warned, ...(MAINT ? { maintenance: MAINT.what, held } : {}), checks: results }));

// --- alerts on a change of state ---------------------------------------------------------

/**
 * What to say, from the previous state and this pass (pure; the tests drive it pass by pass):
 * returns { kind: null | 'alert' | 'more' | 'reminder' | 'recovered', next }.
 * `next` is the state to keep IF the message reached somebody (or no channel is set);
 * when it could not be delivered, only streak/prevFailed advance and it is tried again.
 */
function decide(prev, { healthy, failed, now }) {
  const p = { alerted: false, streak: 0, lastAlertAt: 0, alertedFailed: [], prevFailed: [], since: 0, ...prev };
  const streak = healthy ? 0 : p.streak + 1;
  const since = healthy ? 0 : (p.streak > 0 && p.since ? p.since : now);
  const base = { streak, since, prevFailed: failed, at: now };
  if (healthy) {
    if (p.alerted) return { kind: 'recovered', was: p.alertedFailed, sinceAt: p.since, next: { ...base, alerted: false, lastAlertAt: p.lastAlertAt, alertedFailed: [] } };
    return { kind: null, next: { ...base, alerted: false, lastAlertAt: p.lastAlertAt, alertedFailed: [] } };
  }
  if (streak < 2) return { kind: null, next: { ...base, alerted: p.alerted, lastAlertAt: p.lastAlertAt, alertedFailed: p.alertedFailed } };
  if (!p.alerted) return { kind: 'alert', next: { ...base, alerted: true, lastAlertAt: now, alertedFailed: failed } };
  // Already alerted: a check that newly failed on two passes in a row is news.
  const fresh = failed.filter((f) => p.prevFailed.includes(f) && !p.alertedFailed.includes(f));
  if (fresh.length) return { kind: 'more', fresh, next: { ...base, alerted: true, lastAlertAt: now, alertedFailed: [...new Set([...p.alertedFailed, ...failed])] } };
  if (now - p.lastAlertAt > REALERT_MS) return { kind: 'reminder', next: { ...base, alerted: true, lastAlertAt: now, alertedFailed: [...new Set([...p.alertedFailed, ...failed])] } };
  return { kind: null, next: { ...base, alerted: true, lastAlertAt: p.lastAlertAt, alertedFailed: p.alertedFailed } };
}

const mins = (ms) => (ms < 3600_000 ? `${Math.max(1, Math.round(ms / 60_000))} min` : `${Math.round(ms / 360_000) / 10} h`);

/** A failure's last line: during a window it is not part of, or right after one. */
function maintNote() {
  if (MAINT) return `\n(maintenance ${MAINT.what} is running - ${MAINT.parts.join(', ')} - this is not part of it)`;
  if (MAINT_LAST?.ended && now - MAINT_LAST.ended >= 0 && now - MAINT_LAST.ended < AFTER_MAINT_MS) {
    return `\n(maintenance ${MAINT_LAST.what} ended ${mins(now - MAINT_LAST.ended)} ago: still failing after it)`;
  }
  return '';
}

function message(d) {
  const failLines = alerting.map((k) => `- ${k}: ${results[k]?.note ?? ''}`);
  switch (d.kind) {
    case 'alert':
      return `${labelled('failure', SERVER_NAME)}\nfailing: ${alerting.join(', ')}\n${failLines.join('\n')}${maintNote()}`;
    case 'more':
      return `${labelled('failure', SERVER_NAME)}\nnow also failing: ${d.fresh.join(', ')}\n${failLines.join('\n')}${maintNote()}`;
    case 'reminder':
      return `${labelled('failure', `still failing (${mins(now - d.next.since)}) - ${SERVER_NAME}`)}\nfailing: ${alerting.join(', ')}\n${failLines.join('\n')}${maintNote()}`;
    case 'recovered': {
      const parts = [];
      if (d.was?.length) parts.push(`was failing: ${d.was.join(', ')}`);
      if (d.sinceAt) parts.push(`for ${mins(now - d.sinceAt)}`);
      const which = held.length ? `every check passes again but those of maintenance ${MAINT.what} (${held.join(', ')})` : 'every check passes again';
      return `${labelled('recovered', SERVER_NAME)}\n${which}${parts.length ? ` (${parts.join('; ')})` : ''}`;
    }
    default:
      return '';
  }
}

try {
  mkdirSync(STATE_DIR, { recursive: true });
  const file = STATE_FILE;
  const d = decide(prev, { healthy: alerting.length === 0, failed: alerting, now });
  let next = d.next;
  if (d.kind) {
    const text = message(d);
    const channels = [];
    let delivered = 0;
    if (TG_TOKEN || TG_CHAT) {
      channels.push('telegram');
      const r = await sendTelegram({ token: TG_TOKEN, chatId: TG_CHAT, text, api: TG_API || undefined });
      if (r.ok) delivered++;
      else console.error(`healthcheck: Telegram alert not sent: ${r.error}`);
    }
    if (TOPIC) {
      channels.push('sns');
      const subject = text.split('\n')[0].slice(0, 99);
      const sent = spawnSync('aws', ['sns', 'publish', '--topic-arn', TOPIC, '--subject', subject, '--message', text], { encoding: 'utf8', timeout: 20_000 });
      if (sent.status === 0) delivered++;
      else console.error(`healthcheck: SNS alert not sent: ${(sent.stderr || sent.error?.message || '').trim().slice(0, 200)}`);
    }
    if (!channels.length) {
      console.error(`healthcheck: ${d.kind} (no alert channel is set: ALERT_TELEGRAM_TOKEN / ALERT_TELEGRAM_CHAT_ID in /etc/valuescan/alert.env)`);
    } else if (!delivered) {
      // Nobody heard it: keep the old alert state so the next pass tries again.
      next = { ...prev, streak: d.next.streak, since: d.next.since, prevFailed: d.next.prevFailed, at: now, undelivered: d.kind };
    } else {
      console.error(`healthcheck: ${d.kind} sent (${channels.join(', ')})`);
    }
  }
  writeFileSync(file, JSON.stringify(next));
} catch (e) {
  console.error(`healthcheck: could not record state: ${e?.message ?? e}`);
}

// Not process.exit(): let the last socket close by itself, then end with this code.
process.exitCode = healthy ? 0 : 1;
