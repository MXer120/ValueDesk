/**
 * ValueDesk's own product analytics, kept on this server (POST /api/vs/a,
 * routes/analytics.ts; the admin suite reads it, routes/admin.ts). What a browser
 * may send, and that it sends only after consent: ops/analyticsModel.ts.
 *
 * Everything is checked and cut down here, whatever the browser sent: a route is
 * scrubbed (addresses and ids replaced), a feature name must be one of FEATURES,
 * a detail is a few short words or numbers, text fields are short plain words.
 * The country and region come from Vercel's edge (the proxy's X-Viewer-Country /
 * X-Viewer-Region), never from the browser. No IP address is stored.
 *
 * `analytics.db` in the data directory (SQLite, WAL):
 *   visitors  one row per visitor id: first and last seen, the first visit's
 *             country, source and landing page, how many visits
 *   visits    one row per visit: its context (ctx), country/region, pages, active time
 *   events    one row per event (view, time, feature, vital)
 *   wallets   which visitor ids connected which wallet, first and last time
 * Nothing is pruned (retention.ts): the owner decides when old rows may go.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dataDir } from '../builder/paths.js';
import { scrubRoute, scrubShort } from './scrub.js';
import {
  ANALYTICS_ID, ANALYTICS_MAX_EVENTS, DEVICES, EVENT_KINDS, FEATURES, VISIT_IDLE_MS, VITALS, type AnalyticsEvent, type EventKind,
} from './analyticsModel.js';

export const analyticsDbPath = (): string => process.env.VALUESCAN_ANALYTICS_DB?.trim() || join(dataDir(), 'analytics.db');

const DAY = 86_400_000;
/** The browser's clock may be off; an event further from the server's than this is dropped. */
const CLOCK_SLACK_MS = 6 * 3_600_000;
const MAX_MS = 6 * 3_600_000;

export interface CleanBatch {
  visitor: string;
  visit: string;
  ctx: {
    lang: string | null; tz: string | null; screen: string | null; device: string | null; browser: string | null; os: string | null;
    theme: string | null; ref: string | null; utmSource: string | null; utmMedium: string | null; utmCampaign: string | null;
    landing: string | null; build: string | null;
  };
  wallet: string | null;
  events: Array<{ t: number; k: EventKind; p: string; n: string | null; ms: number | null; d: string | null }>;
}

const word = (v: unknown, max = 40): string | null => {
  const s = scrubShort(v, max);
  return s ? s : null;
};
/** An external site the visit came from: its host only, lower case. */
const hostOf = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const h = v.trim().toLowerCase().replace(/^www\./, '');
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(h) && h.length <= 80 ? h : null;
};
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A feature's details: up to 6 keys of short words, small numbers or booleans. No text that could carry an address. */
function details(v: unknown): string | null {
  if (!isRecord(v)) return null;
  const out: Record<string, string | number | boolean> = {};
  for (const [k, x] of Object.entries(v).slice(0, 6)) {
    if (!/^[a-z][a-zA-Z0-9_]{0,23}$/.test(k)) continue;
    if (typeof x === 'boolean') out[k] = x;
    else if (typeof x === 'number' && Number.isFinite(x) && Math.abs(x) <= 1e6) out[k] = Math.round(x * 100) / 100;
    else if (typeof x === 'string' && /^[a-zA-Z0-9_.:-]{1,32}$/.test(x) && !/^0x[0-9a-f]{8,}/i.test(x)) out[k] = x;
  }
  return Object.keys(out).length ? JSON.stringify(out) : null;
}

/** A batch as stored, or why not. */
export function parseAnalytics(raw: unknown, now = Date.now()): { ok: true; batch: CleanBatch } | { ok: false; error: string } {
  if (!isRecord(raw)) return { ok: false, error: 'not an analytics batch' };
  if (raw.consent !== 'analytics') return { ok: false, error: 'analytics was not allowed' };
  if (typeof raw.visitor !== 'string' || !ANALYTICS_ID.test(raw.visitor)) return { ok: false, error: 'visitor must be 16 random bytes, base64url' };
  if (typeof raw.visit !== 'string' || !ANALYTICS_ID.test(raw.visit)) return { ok: false, error: 'visit must be 16 random bytes, base64url' };
  if (!Array.isArray(raw.events) || raw.events.length === 0) return { ok: false, error: 'no events' };
  if (raw.events.length > ANALYTICS_MAX_EVENTS) return { ok: false, error: `at most ${ANALYTICS_MAX_EVENTS} events a batch` };
  const c = isRecord(raw.ctx) ? raw.ctx : {};
  const utm = isRecord(c.utm) ? c.utm : {};
  const device = typeof c.device === 'string' && (DEVICES as readonly string[]).includes(c.device) ? c.device : null;
  const screen = typeof c.screen === 'string' && /^\d{2,5}x\d{2,5}$/.test(c.screen) ? c.screen : null;
  const wallet = typeof raw.wallet === 'string' && /^0x[0-9a-fA-F]{40}$/.test(raw.wallet) ? raw.wallet.toLowerCase() : null;
  const events: CleanBatch['events'] = [];
  for (const e of raw.events) {
    if (!isRecord(e)) continue;
    const k = e.k as EventKind;
    if (!(EVENT_KINDS as readonly string[]).includes(k)) continue;
    const t = typeof e.t === 'number' && Number.isSafeInteger(e.t) ? e.t : NaN;
    if (!(Math.abs(t - now) <= CLOCK_SLACK_MS)) continue;
    const p = scrubRoute(e.p);
    let n: string | null = null;
    let ms: number | null = null;
    if (k === 'feature') {
      if (typeof e.n !== 'string' || !Object.hasOwn(FEATURES, e.n)) continue;
      n = e.n;
    } else if (k === 'vital') {
      if (typeof e.n !== 'string' || !(VITALS as readonly string[]).includes(e.n)) continue;
      n = e.n;
    }
    if (k === 'time' || k === 'vital') {
      if (typeof e.ms !== 'number' || !Number.isFinite(e.ms) || e.ms < 0 || e.ms > MAX_MS) continue;
      ms = Math.round(e.ms);
    }
    events.push({ t, k, p, n, ms, d: k === 'feature' ? details(e.d) : null });
  }
  if (!events.length) return { ok: false, error: 'no event could be read' };
  return {
    ok: true,
    batch: {
      visitor: raw.visitor,
      visit: raw.visit,
      ctx: {
        lang: typeof c.lang === 'string' && /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(c.lang) ? c.lang : null,
        tz: typeof c.tz === 'string' && /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/.test(c.tz) && c.tz.length <= 40 ? c.tz : null,
        screen,
        device,
        browser: word(c.browser, 24),
        os: word(c.os, 24),
        theme: c.theme === 'dark' || c.theme === 'light' ? c.theme : null,
        ref: hostOf(c.ref),
        utmSource: word(utm.source), utmMedium: word(utm.medium), utmCampaign: word(utm.campaign, 60),
        landing: c.landing === undefined ? null : scrubRoute(c.landing),
        build: word(c.build, 24),
      },
      wallet,
      events,
    },
  };
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS visitors (
  visitor TEXT PRIMARY KEY,
  first_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL,
  country TEXT,
  ref TEXT,
  utm_source TEXT,
  landing TEXT,
  visits INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS visits (
  visit TEXT PRIMARY KEY,
  visitor TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL,
  country TEXT, region TEXT,
  device TEXT, browser TEXT, os TEXT, lang TEXT, tz TEXT, screen TEXT, theme TEXT,
  ref TEXT, utm_source TEXT, utm_medium TEXT, utm_campaign TEXT, landing TEXT, build TEXT,
  wallet TEXT,
  pages INTEGER NOT NULL DEFAULT 0,
  active_ms INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS visits_started ON visits (started_at);
CREATE INDEX IF NOT EXISTS visits_visitor ON visits (visitor);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  visit TEXT NOT NULL,
  visitor TEXT NOT NULL,
  kind TEXT NOT NULL,
  path TEXT NOT NULL,
  name TEXT,
  ms INTEGER,
  data TEXT
);
CREATE INDEX IF NOT EXISTS events_at ON events (at);
CREATE INDEX IF NOT EXISTS events_kind ON events (kind, at);
CREATE TABLE IF NOT EXISTS wallets (
  wallet TEXT NOT NULL,
  visitor TEXT NOT NULL,
  first_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL,
  PRIMARY KEY (wallet, visitor)
) WITHOUT ROWID;
`;

type Row = Record<string, unknown>;
const num = (v: unknown): number => Number(v ?? 0) || 0;
const counts = (rows: Row[], key = 'k'): Array<{ key: string; n: number; visitors?: number }> =>
  rows.map((r) => ({ key: String(r[key] ?? '(none)'), n: num(r.n), ...(r.u !== undefined ? { visitors: num(r.u) } : {}) }));

export interface AnalyticsSummary {
  from: number;
  to: number;
  totals: { visitors: number; newVisitors: number; visits: number; views: number; bounceRate: number | null; avgVisitMs: number | null; pagesPerVisit: number | null; wallets: number; liveVisits: number };
  days: Array<{ day: number; visitors: number; visits: number; views: number }>;
  pages: Array<{ path: string; views: number; visitors: number; avgMs: number | null }>;
  countries: Array<{ key: string; n: number }>;
  regions: Array<{ key: string; n: number }>;
  sources: Array<{ key: string; n: number }>;
  campaigns: Array<{ key: string; n: number }>;
  landing: Array<{ key: string; n: number }>;
  devices: Array<{ key: string; n: number }>;
  browsers: Array<{ key: string; n: number }>;
  os: Array<{ key: string; n: number }>;
  langs: Array<{ key: string; n: number }>;
  screens: Array<{ key: string; n: number }>;
  features: Array<{ key: string; label: string; n: number; visitors: number }>;
  vitals: Array<{ name: string; n: number; p50: number; p75: number }>;
  returning: { visitors: number; returning: number };
  /** From a visit to a first real action, in distinct visitors (2026-11-14, owner: "measure activation"). */
  funnel: Array<{ key: string; label: string; visitors: number }>;
  welcome: Welcome;
}

/** The first-signup welcome flow (apps/web/src/onboarding): who opened it, finished it, skipped it, and where. */
export interface Welcome {
  opened: number;
  finished: number;
  skipped: number;
  /** In flow order: visitors who reached the step, and who pressed Skip on it. */
  steps: Array<{ step: string; reached: number; skipped: number }>;
}

/** The flow's order (onboarding/model.ts STEPS), for the table; a step not listed goes last. */
const WELCOME_ORDER = ['username', 'referral', 'traders', 'copy', 'heatmap', 'flow', 'overview', 'theme'];

export class AnalyticsStore {
  private readonly db: DatabaseSync;

  constructor(path = analyticsDbPath()) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA busy_timeout = 2000');
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  /** Store one batch; `geo` is the edge's, never the browser's. */
  add(b: CleanBatch, geo: { country: string | null; region: string | null }, now = Date.now()): void {
    const views = b.events.filter((e) => e.k === 'view').length;
    const active = b.events.reduce((s, e) => s + (e.k === 'time' ? e.ms ?? 0 : 0), 0);
    const c = b.ctx;
    this.db.exec('BEGIN');
    try {
      const prev = this.db.prepare('SELECT last_at FROM visits WHERE visit = ?').get(b.visit) as Row | undefined;
      // A visit id idle past VISIT_IDLE_MS is not continued: the browser starts a new one, and an old id is only ever its own visit.
      const newVisit = !prev;
      if (newVisit) {
        this.db.prepare(
          `INSERT INTO visits (visit, visitor, started_at, last_at, country, region, device, browser, os, lang, tz, screen, theme, ref, utm_source, utm_medium, utm_campaign, landing, build, wallet, pages, active_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(b.visit, b.visitor, now, now, geo.country, geo.region, c.device, c.browser, c.os, c.lang, c.tz, c.screen, c.theme, c.ref, c.utmSource, c.utmMedium, c.utmCampaign, c.landing, c.build, b.wallet, views, active);
      } else {
        this.db.prepare('UPDATE visits SET last_at = ?, pages = pages + ?, active_ms = active_ms + ?, wallet = coalesce(?, wallet) WHERE visit = ?').run(now, views, active, b.wallet, b.visit);
      }
      this.db.prepare(
        `INSERT INTO visitors (visitor, first_at, last_at, country, ref, utm_source, landing, visits) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (visitor) DO UPDATE SET last_at = excluded.last_at, visits = visits + excluded.visits`,
      ).run(b.visitor, now, now, geo.country, c.ref, c.utmSource, c.landing, newVisit ? 1 : 0);
      const put = this.db.prepare('INSERT INTO events (at, visit, visitor, kind, path, name, ms, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      // Stored at the server's time: the browser's clock only orders a batch's own events.
      for (const e of b.events) put.run(Math.min(now, Math.max(now - VISIT_IDLE_MS, e.t)), b.visit, b.visitor, e.k, e.p, e.n, e.ms, e.d);
      if (b.wallet) {
        this.db.prepare('INSERT INTO wallets (wallet, visitor, first_at, last_at) VALUES (?, ?, ?, ?) ON CONFLICT (wallet, visitor) DO UPDATE SET last_at = excluded.last_at')
          .run(b.wallet, b.visitor, now, now);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** Everything the analytics page shows, for [from, to). */
  summary(from: number, to: number, now = Date.now()): AnalyticsSummary {
    const q = (sql: string, ...args: Array<string | number | null>) => this.db.prepare(sql).all(...args) as Row[];
    const one = (sql: string, ...args: Array<string | number | null>) => (this.db.prepare(sql).get(...args) ?? {}) as Row;
    const v = one(
      `SELECT COUNT(*) AS visits, COUNT(DISTINCT visitor) AS visitors, SUM(pages) AS views, SUM(pages <= 1) AS bounced, AVG(active_ms) AS avg_ms,
         COUNT(DISTINCT wallet) AS wallets FROM visits WHERE started_at >= ? AND started_at < ?`, from, to,
    );
    const visits = num(v.visits);
    const newVisitors = num(one('SELECT COUNT(*) AS n FROM visitors WHERE first_at >= ? AND first_at < ?', from, to).n);
    const live = num(one('SELECT COUNT(*) AS n FROM visits WHERE last_at >= ?', now - 5 * 60_000).n);
    const days = q(
      `SELECT started_at / ${DAY} AS day, COUNT(DISTINCT visitor) AS u, COUNT(*) AS n, SUM(pages) AS views FROM visits
       WHERE started_at >= ? AND started_at < ? GROUP BY day ORDER BY day`, from, to,
    ).map((r) => ({ day: num(r.day), visitors: num(r.u), visits: num(r.n), views: num(r.views) }));
    const viewsBy = q(`SELECT path, COUNT(*) AS n, COUNT(DISTINCT visitor) AS u FROM events WHERE kind = 'view' AND at >= ? AND at < ? GROUP BY path ORDER BY n DESC LIMIT 50`, from, to);
    const timeBy = new Map(q(`SELECT path, SUM(ms) AS ms FROM events WHERE kind = 'time' AND at >= ? AND at < ? GROUP BY path`, from, to).map((r) => [String(r.path), num(r.ms)]));
    const pages = viewsBy.map((r) => ({ path: String(r.path), views: num(r.n), visitors: num(r.u), avgMs: timeBy.has(String(r.path)) ? Math.round(timeBy.get(String(r.path))! / Math.max(1, num(r.n))) : null }));
    const by = (col: string, limit = 25) => counts(q(`SELECT ${col} AS k, COUNT(*) AS n FROM visits WHERE started_at >= ? AND started_at < ? GROUP BY k ORDER BY n DESC LIMIT ${limit}`, from, to));
    const features = q(
      `SELECT name AS k, COUNT(*) AS n, COUNT(DISTINCT visitor) AS u FROM events WHERE kind = 'feature' AND at >= ? AND at < ? GROUP BY name ORDER BY n DESC`, from, to,
    ).map((r) => ({ key: String(r.k), label: FEATURES[String(r.k)] ?? String(r.k), n: num(r.n), visitors: num(r.u) }));
    const vitals = VITALS.map((name) => {
      const ms = q(`SELECT ms FROM events WHERE kind = 'vital' AND name = ? AND at >= ? AND at < ? ORDER BY ms LIMIT 20000`, name, from, to).map((r) => num(r.ms));
      const pick = (f: number) => (ms.length ? ms[Math.min(ms.length - 1, Math.floor(f * ms.length))]! : 0);
      return { name, n: ms.length, p50: pick(0.5), p75: pick(0.75) };
    }).filter((x) => x.n > 0);
    const ret = one(
      `SELECT COUNT(*) AS u, SUM(first_at < ?) AS back FROM (SELECT DISTINCT v.visitor, w.first_at FROM visits v JOIN visitors w ON w.visitor = v.visitor WHERE v.started_at >= ? AND v.started_at < ?)`,
      from, from, to,
    );
    return {
      from, to,
      totals: {
        visitors: num(v.visitors), newVisitors, visits, views: num(v.views),
        bounceRate: visits ? num(v.bounced) / visits : null,
        avgVisitMs: visits ? Math.round(num(v.avg_ms)) : null,
        pagesPerVisit: visits ? num(v.views) / visits : null,
        wallets: num(v.wallets), liveVisits: live,
      },
      days,
      pages,
      countries: by('country'),
      regions: by("country || '-' || coalesce(region, '?')"),
      sources: by("coalesce(ref, CASE WHEN utm_source IS NULL THEN '(direct)' ELSE NULL END, 'utm:' || utm_source)"),
      campaigns: by("coalesce(utm_source, '-') || ' / ' || coalesce(utm_medium, '-') || ' / ' || coalesce(utm_campaign, '-')"),
      landing: by('landing'),
      devices: by('device'),
      browsers: by('browser'),
      os: by('os'),
      langs: by('lang'),
      screens: by('screen'),
      features,
      vitals,
      returning: { visitors: num(ret.u), returning: num(ret.back) },
      funnel: this.funnel(from, to, num(v.visitors)),
      welcome: this.welcome(from, to),
    };
  }

  /**
   * The activation funnel for [from, to): distinct visitors who reached each step. A step counts a visitor who did it
   * in the range, whatever they did before; "Did any of them" is a visitor with at least one of the four actions.
   */
  funnel(from: number, to: number, visitors: number): Array<{ key: string; label: string; visitors: number }> {
    const did = (names: string[]) => num((this.db.prepare(
      `SELECT COUNT(DISTINCT visitor) AS u FROM events WHERE kind = 'feature' AND at >= ? AND at < ? AND name IN (${names.map(() => '?').join(', ')})`,
    ).get(from, to, ...names) as Row | undefined)?.u);
    const wallet = num((this.db.prepare(
      `SELECT COUNT(DISTINCT visitor) AS u FROM (SELECT visitor FROM visits WHERE started_at >= ? AND started_at < ? AND wallet IS NOT NULL
         UNION SELECT visitor FROM events WHERE kind = 'feature' AND name = 'wallet.connect' AND at >= ? AND at < ?)`,
    ).get(from, to, from, to) as Row | undefined)?.u);
    const actions = ['order.place', 'copy.start', 'algo.start', 'bot.start'];
    return [
      { key: 'visit', label: 'Visited', visitors },
      { key: 'wallet', label: 'Connected a wallet', visitors: wallet },
      { key: 'trading', label: 'Enabled trading', visitors: did(['trading.enable']) },
      { key: 'action', label: 'Placed an order, started a copy, an algo or a bot', visitors: did(actions) },
      ...actions.map((n) => ({ key: n, label: FEATURES[n] ?? n, visitors: did([n]) })),
    ];
  }

  /** The welcome flow for [from, to), as distinct visitors. "Finished" and "skipped" are counted apart: one who skipped and later finished on another wallet is in both. */
  welcome(from: number, to: number): Welcome {
    const count = (name: string) => num((this.db.prepare(
      `SELECT COUNT(DISTINCT visitor) AS u FROM events WHERE kind = 'feature' AND name = ? AND at >= ? AND at < ?`,
    ).get(name, from, to) as Row | undefined)?.u);
    const per = (name: string) => new Map((this.db.prepare(
      `SELECT json_extract(data, '$.step') AS s, COUNT(DISTINCT visitor) AS u FROM events
       WHERE kind = 'feature' AND name = ? AND at >= ? AND at < ? AND json_valid(data) GROUP BY s`,
    ).all(name, from, to) as Row[]).filter((r) => typeof r.s === 'string').map((r) => [String(r.s), num(r.u)]));
    const reached = per('onboarding.step');
    const skipped = per('onboarding.skip');
    const names = [...new Set([...reached.keys(), ...skipped.keys()])];
    const rank = (s: string) => (WELCOME_ORDER.indexOf(s) + 1 || 99);
    names.sort((a, b) => rank(a) - rank(b));
    return {
      opened: count('onboarding.open'),
      finished: count('onboarding.done'),
      skipped: count('onboarding.skip'),
      steps: names.map((step) => ({ step, reached: reached.get(step) ?? 0, skipped: skipped.get(step) ?? 0 })),
    };
  }

  /** Per wallet: visits, active time, last seen, the countries seen, the features used most. */
  walletActivity(): Map<string, { visits: number; activeMs: number; lastSeen: number; countries: string[]; features: Array<{ key: string; n: number }> }> {
    const out = new Map<string, { visits: number; activeMs: number; lastSeen: number; countries: string[]; features: Array<{ key: string; n: number }> }>();
    for (const r of this.db.prepare(
      `SELECT w.wallet AS wallet, COUNT(v.visit) AS visits, SUM(v.active_ms) AS ms, MAX(v.last_at) AS last, group_concat(DISTINCT v.country) AS c
       FROM wallets w JOIN visits v ON v.visitor = w.visitor GROUP BY w.wallet`,
    ).all() as Row[]) {
      out.set(String(r.wallet), { visits: num(r.visits), activeMs: num(r.ms), lastSeen: num(r.last), countries: String(r.c ?? '').split(',').filter(Boolean), features: [] });
    }
    for (const r of this.db.prepare(
      `SELECT w.wallet AS wallet, e.name AS k, COUNT(*) AS n FROM wallets w JOIN events e ON e.visitor = w.visitor AND e.kind = 'feature' GROUP BY w.wallet, e.name ORDER BY n DESC`,
    ).all() as Row[]) {
      const a = out.get(String(r.wallet));
      if (a && a.features.length < 5) a.features.push({ key: String(r.k), n: num(r.n) });
    }
    return out;
  }

  /** The newest visits, for the live view. */
  recentVisits(limit = 50): Row[] {
    return this.db.prepare(
      'SELECT started_at, last_at, country, region, device, browser, os, ref, landing, pages, active_ms, wallet FROM visits ORDER BY last_at DESC LIMIT ?',
    ).all(Math.max(1, Math.min(200, limit))) as Row[];
  }
}
