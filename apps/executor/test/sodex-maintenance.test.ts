/**
 * SoDEX's maintenance (venue.ts, owner 2026-11-11): the watch's hysteresis and what an unreachable flag means, the
 * gateway's 503s as a maintenance only while SoDEX does not say NORMAL, one INFO alert at the start and one at the
 * end, the client's words and its last gate, the guard, and what /info and /health say.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalRefusal, MAINTENANCE_UNKNOWN, OutcomeUnknownError, SodexClient, type FetchLike, type SodexReach, type VenueHold, type WebSocketLike } from '../../../packages/copy-engine/src/index.ts';
import { CLASS, ReachWatch, type AlertKind } from '../src/alerts.ts';
import { loadConfig } from '../src/config.ts';
import { ExecutorDb } from '../src/db.ts';
import { classifyRejection } from '../src/guard.ts';
import { Secrets } from '../src/secrets.ts';
import { ExecutorService } from '../src/service.ts';
import { MAINTENANCE_STATUS_URL, SodexMaintenanceWatch, readFlag } from '../src/venue.ts';

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const flag = (status: string, extra: Record<string, unknown> = {}) => JSON.stringify({ code: 0, data: { status, maintenanceDuration: 1, updateTime: 1_800_000_000, ...extra } });

/** The flag's answers in order: a body, or a number (that HTTP status), or 'throw' (no answer). */
function flagFetch(answers: Array<string | number | 'throw'>): { fetch: FetchLike; urls: string[] } {
  const urls: string[] = [];
  const fetch: FetchLike = async (url) => {
    urls.push(url);
    const a = answers.shift() ?? 'throw';
    if (a === 'throw') throw new Error('fetch failed');
    if (typeof a === 'number') return { status: a, ok: false, text: async () => 'nope' };
    return { status: 200, ok: true, text: async () => a };
  };
  return { fetch, urls };
}

function watch(answers: Array<string | number | 'throw'>, reach: SodexReach = { lastOkAt: 1, lastFailAt: 0, failingSince: 0, lastError: null }, now = () => Date.now()) {
  const raised: Array<{ kind: AlertKind; text: string }> = [];
  const changes: Array<VenueHold | null> = [];
  const f = flagFetch(answers);
  const w = new SodexMaintenanceWatch({ fetch: f.fetch, reach: () => reach, alerts: { raise: (kind, _s, text) => raised.push({ kind, text }) }, onChange: (h) => changes.push(h), now });
  return { w, raised, changes, urls: f.urls, reach };
}

test('readFlag: the documented shape, the expected end from updateTime + maintenanceDuration; anything else is no information', () => {
  assert.deepEqual(readFlag(flag('NORMAL')), { status: 'NORMAL', expectedEnd: null });
  assert.deepEqual(readFlag(flag('CHAIN_MAINTENANCE')), { status: 'CHAIN_MAINTENANCE', expectedEnd: 1_800_000_000_000 + 3_600_000 });
  assert.deepEqual(readFlag(flag('ALL_MAINTENANCE', { maintenanceDuration: 0 })), { status: 'ALL_MAINTENANCE', expectedEnd: null });
  assert.equal(readFlag('<html>502</html>'), null);
  assert.equal(readFlag(JSON.stringify({ code: 1, data: { status: 'NORMAL' } })), null);
  assert.equal(readFlag(JSON.stringify({ code: 0, data: {} })), null);
});

test('watch: in after 2 readings in a row that are not NORMAL, out after 2 NORMAL; one INFO alert each way; reads the documented URL', async () => {
  const { w, raised, changes, urls } = watch([flag('CHAIN_MAINTENANCE'), flag('NORMAL'), flag('CHAIN_MAINTENANCE'), flag('CHAIN_MAINTENANCE'), flag('CHAIN_MAINTENANCE'), flag('NORMAL'), flag('CHAIN_MAINTENANCE'), flag('NORMAL'), flag('NORMAL')]);
  await w.poll();
  assert.equal(w.active, false, 'one reading is not enough');
  await w.poll();
  await w.poll();
  assert.equal(w.active, false, 'a NORMAL in between starts the count again');
  await w.poll();
  assert.equal(w.active, true);
  assert.equal(w.view().state, 'maintenance');
  assert.equal(w.view().source, 'sodex');
  assert.equal(w.view().expectedEnd, 1_800_000_000_000 + 3_600_000);
  assert.match(w.hold()!.reason, /SoDEX is in maintenance/);
  await w.poll();
  await w.poll(); // one NORMAL
  assert.equal(w.active, true, 'one NORMAL is not enough to leave');
  await w.poll(); // maintenance again: the NORMAL run starts over
  await w.poll();
  assert.equal(w.active, true);
  await w.poll();
  assert.equal(w.active, false);
  assert.deepEqual(raised.map((r) => r.kind), ['sodex-maintenance', 'sodex-maintenance-end'], 'told once at the start, once at the end');
  assert.equal(CLASS['sodex-maintenance'], 'info');
  assert.equal(CLASS['sodex-maintenance-end'], 'info');
  assert.equal(changes.length, 2);
  assert.equal(changes[1], null);
  assert.ok(urls.every((u) => u === MAINTENANCE_STATUS_URL));
});

test('watch: an unreachable flag (no answer, an HTTP error, a body of another shape) is no information - it neither counts nor resets, and the state stays', async () => {
  const { w, raised } = watch([flag('ALL_MAINTENANCE'), 'throw', 503, '<html/>', flag('ALL_MAINTENANCE'), 'throw', 'throw', 500, flag('NORMAL'), 'throw', flag('NORMAL')]);
  await w.poll();
  await w.poll();
  await w.poll();
  await w.poll();
  assert.equal(w.active, false, 'three failed reads in between: still one reading');
  await w.poll();
  assert.equal(w.active, true, 'the second reading not NORMAL, gaps ignored');
  await w.poll();
  await w.poll();
  await w.poll();
  assert.equal(w.active, true, 'unreachable keeps it in maintenance');
  assert.equal(w.view().flag, null);
  await w.poll();
  await w.poll();
  await w.poll();
  assert.equal(w.active, false, 'two NORMAL readings, a failed read between them');
  assert.equal(raised.length, 2);
});

test("watch: the gateway's 503s for 3 min count only while the flag does not say NORMAL (or cannot be read); they end when the gateway answers", async () => {
  let t = 1_000_000;
  const now = () => t;
  const reach: SodexReach = { lastOkAt: 0, lastFailAt: t, failingSince: t, lastError: 'HTTP 503' };
  // The flag says NORMAL: a 503 is an outage, not a maintenance (the unreachable alert covers it).
  const a = watch([flag('NORMAL'), flag('NORMAL'), flag('NORMAL')], reach, now);
  t += 4 * 60_000;
  await a.w.poll();
  assert.equal(a.w.active, false);
  // The flag cannot be read: 2 min of 503s are not enough, 3 are.
  t = 1_000_000;
  const b = watch(['throw', 'throw', 'throw', 'throw', 'throw', 'throw'], { ...reach }, now);
  t += 2 * 60_000;
  await b.w.poll();
  assert.equal(b.w.active, false);
  t += 60_000;
  await b.w.poll();
  assert.equal(b.w.active, true);
  assert.equal(b.w.view().source, 'gateway');
  assert.match(b.raised[0]!.text, /HTTP 503/);
  // Still failing: stays. A failure that is not a 503 (a timeout) never starts one.
  t += 60_000;
  await b.w.poll();
  assert.equal(b.w.active, true);
  b.reach.failingSince = 0;
  b.reach.lastOkAt = t;
  await b.w.poll();
  assert.equal(b.w.active, false, 'the gateway answers again');
  t = 1_000_000;
  const c = watch(['throw', 'throw'], { lastOkAt: 0, lastFailAt: t, failingSince: t, lastError: 'fetch failed' }, now);
  t += 10 * 60_000;
  await c.w.poll();
  assert.equal(c.w.active, false, 'no answer at all is not a maintenance');
});

test('watch: while the gateway alone holds, it is probed so its answer (not a stale failure) ends the maintenance', async () => {
  let t = 1_000_000;
  const reach: SodexReach = { lastOkAt: 0, lastFailAt: t, failingSince: t, lastError: 'HTTP 503' };
  let probes = 0;
  const w = new SodexMaintenanceWatch({
    fetch: flagFetch(['throw', 'throw', 'throw']).fetch,
    reach: () => reach,
    probe: async () => {
      probes++;
      reach.failingSince = 0;
    },
    now: () => t,
  });
  t += 3 * 60_000;
  await w.poll();
  assert.equal(w.active, true);
  assert.equal(probes, 0, 'not probed before it holds');
  await w.poll();
  assert.equal(probes, 1);
  assert.equal(w.active, false);
});

test('ReachWatch: no "SoDEX unreachable" FAILURE while SoDEX is in its maintenance', () => {
  const raised: string[] = [];
  const r = new ReachWatch({ raise: (k: string) => raised.push(k) } as never, 1_000);
  r.check({ lastOkAt: 0, failingSince: 1, lastError: 'HTTP 503' }, 10_000, true);
  assert.deepEqual(raised, []);
  r.check({ lastOkAt: 0, failingSince: 1, lastError: 'HTTP 503' }, 10_000, false);
  assert.deepEqual(raised, ['sodex-down']);
});

test('client: in maintenance nothing that opens leaves (refused here, nothing sent); a close that meets a 503 says "most likely not placed", flagged', async () => {
  const sent: string[] = [];
  const fetch: FetchLike = async (url, init) => {
    sent.push(`${init?.method} ${url}`);
    return { status: 503, ok: false, text: async () => '<html>503 Service Temporarily Unavailable</html>' };
  };
  const c = new SodexClient({ network: 'mainnet', fetch });
  const open = { method: 'POST' as const, gatewayPath: '/api/v1/perps/trade/orders', headers: {}, body: '{"accountID":42,"orders":[{"reduceOnly":false}]}' };
  const close = { ...open, body: '{"accountID":42,"orders":[{"reduceOnly":true}]}' };
  // Before the watch says so: a 503 is still "may have executed", but flagged.
  await assert.rejects(c.send(open), (e: unknown) => e instanceof OutcomeUnknownError && e.maintenance && /may still have executed/.test(e.message));
  c.maintenance = { reason: 'SoDEX is in maintenance.', since: Date.now(), expectedEnd: null };
  const before = sent.length;
  await assert.rejects(c.send(open), (e: unknown) => e instanceof LocalRefusal && e.reason === 'maintenance' && /^Not sent: SoDEX is in maintenance/.test(e.message));
  assert.equal(sent.length, before, 'the opening order never left');
  await assert.rejects(c.send(close), (e: unknown) => e instanceof OutcomeUnknownError && e.maintenance && e.message === MAINTENANCE_UNKNOWN);
  assert.equal(sent.length, before + 1, 'a close still goes (SoDEX may answer again)');
  // A 502 outside maintenance: unknown as before, not flagged.
  c.maintenance = null;
  const d = new SodexClient({ network: 'mainnet', fetch: async () => ({ status: 502, ok: false, text: async () => 'bad gateway' }) });
  await assert.rejects(d.send(close), (e: unknown) => e instanceof OutcomeUnknownError && !e.maintenance);
});

test('guard: a maintenance refusal is no strike and no "unknown refusal" alert', () => {
  assert.equal(classifyRejection('order rejected: system maintenance in progress'), 'maintenance');
  assert.equal(classifyRejection('Not sent: SoDEX is in maintenance; nothing new is sent until it is back'), 'local');
  assert.equal(classifyRejection('position not found: 1'), 'gone');
});

test('service: in maintenance /info and /health say so, health stays ok (SoDEX\'s fault, not ours), the client and the audit log know', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vd-venue-'));
  const answers = [flag('CHAIN_MAINTENANCE'), flag('CHAIN_MAINTENANCE'), flag('NORMAL'), flag('NORMAL')];
  const fetch: FetchLike = async (url) => {
    if (url === MAINTENANCE_STATUS_URL) return { status: 200, ok: true, text: async () => answers.shift() ?? flag('NORMAL') };
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    if (path.endsWith('/markets/symbols') || path.endsWith('/markets/mark-prices')) return { status: 200, ok: true, text: async () => JSON.stringify({ code: 0, data: [] }) };
    return { status: 404, ok: false, text: async () => '{"code":404}' };
  };
  const noWs = (): WebSocketLike => ({ readyState: 0, send() {}, close() {}, onopen: null, onmessage: null, onclose: null, onerror: null });
  const cfg = loadConfig({ EXECUTOR_PRACTICE_BOTS: '1', EXECUTOR_DATA_DIR: dir, EXECUTOR_KIND: 'hosted', EXECUTOR_EDGE: 'none' });
  const db = new ExecutorDb(':memory:');
  const svc = new ExecutorService(cfg, db, new Secrets(dir), { fetch, factory: noWs, log: silent });
  assert.deepEqual(svc.info({ viewerCountry: null }).venue, { state: 'normal', since: null, expectedEnd: null });
  await svc.venue.poll();
  await svc.venue.poll();
  const info = svc.info({ viewerCountry: null }).venue!;
  assert.equal(info.state, 'maintenance');
  assert.equal(info.expectedEnd, 1_800_000_000_000 + 3_600_000);
  const h = svc.health();
  assert.equal(h.ok, true);
  assert.equal(h.venue?.state, 'maintenance');
  assert.ok(svc.sodex.maintenance, 'the client refuses opening orders now');
  assert.ok(db.auditRows({ kind: 'venue', limit: 5 }).length >= 1);
  await svc.venue.poll();
  await svc.venue.poll();
  assert.equal(svc.health().venue?.state, 'normal');
  assert.equal(svc.sodex.maintenance, null);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
