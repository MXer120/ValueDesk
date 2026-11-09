/**
 * The status page's prober and its record (GET /api/vs/status, routes/status.ts;
 * the page is apps/web/src/status/).
 *
 * Every PROBE_EVERY_MS this process asks each service once:
 *   website   GET <site>/              200 and HTML (Vercel, the site's own files)
 *   api       GET <site>/api/health    200 and ok:true - the whole way a visitor's
 *                                      request goes: Vercel's function, Caddy, this API
 *   executor  GET <executor>/api/copy/v1/health  200 and ok:true; ok:false (its
 *                                      database or its SoDEX feed is not right) is
 *                                      `degraded`. <executor> is the site, so the probe
 *                                      takes the visitor's way to server 2, unless
 *                                      VALUESCAN_STATUS_EXECUTOR_URL names the executor's
 *                                      server itself (the health check's EXECUTOR_URL,
 *                                      deploy/server/bin/healthcheck.mjs, is the loopback
 *                                      address on the executor's own box - not this one).
 *                                      Asked again, or on VALUESCAN_STATUS_EXECUTOR_DIRECT_URL,
 *                                      before a bad answer counts: probeExecutor
 *   indexer   its own status, read in this process (hosted.ts indexerHealth): fresh, every
 *             stream up, boards under an hour old, and its lanes, reads and thread keeping up
 *             over the last minutes (ops/indexerJudge.ts), else `degraded` or `down` (stale)
 *
 * Each answer is one minute's sample in `status.db` (the server's data directory;
 * SQLite, WAL) and adds one minute to that UTC day's tally. Both are kept (about
 * 6k samples a day, a few hundred kilobytes a month); only with the owner's word,
 * VALUESCAN_PRUNE=status (retention.ts), samples go after two days and tallies
 * after STATUS_KEEP_DAYS. A minute the prober did not run - this server down, a
 * restart - has no sample: the page shows it as no data, never as up.
 *
 * The indexer's round also carries how current each of its datasets is (statusModel.ts FRESH_TARGETS,
 * indexerJudge.ts freshnessOf): the last round's figures go on the page (report().freshness), and each UTC
 * day keeps, per dataset, the minutes past half its target, the minutes past it and the worst figure
 * (freshDays: the admin suite's daily view). Past half a target is logged once as it starts, nothing more.
 *
 * Each round's samples also feed the automatic incidents (ops/statusAuto.ts): an
 * outage the probes see gets its entry on the page, in the feed and in the app's
 * banner without anyone posting it.
 *
 * The same file keeps the owner's incidents and maintenance (ops/statusNotices.ts).
 * After each round the finished days and the notices are written to
 * status-history.json next to it when they changed - about once a day - which the
 * off-server backup carries (backup-offsite.sh, api-state); a new, empty status.db
 * reads it back at start. Minutes from before the prober ran can be filled from the
 * health check's journal (tools/status-post.ts backfill), never over its own.
 *
 * Runs on a hosted server (VALUESCAN_HOSTED=1) unless VALUESCAN_STATUS_PROBE=0, and
 * locally only with VALUESCAN_STATUS_PROBE=1: a dev server has no reason to ask the
 * production site anything every minute.
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dataDir } from '../builder/paths.js';
import { indexerHealth } from '../hosted.js';
import {
  STATUS_DAYS, STATUS_SERVICES, isServiceId, lastDays, uptimeOf, utcDay,
  type DayTuple, type ServiceId, type ServiceState, type StatusReport,
} from './statusModel.js';
import { NoticeStore, healthNoticeReader } from './statusNotices.js';
import { AutoIncidents, REPLAYED_KEY } from './statusAuto.js';
import type { HealthNotice } from './statusModel.js';
import { mayPrune } from '../retention.js';
import { IndexerJudge, type FreshReading } from './indexerJudge.js';
import { FRESH_IDS, FRESH_TARGETS, freshItems, type FreshId, type Freshness } from './statusModel.js';

export const PROBE_EVERY_MS = 60_000;
export const PROBE_TIMEOUT_MS = 10_000;
export const STATUS_KEEP_DAYS = 120;
const SAMPLE_KEEP_MS = 2 * 86_400_000;
/** A last sample older than this: the prober has stopped, the state is unknown. */
const STALE_MS = 5 * 60_000;
/** The indexer publishes its status every 30 s (hosted.ts IndexerHealth.at). */
const INDEXER_STALE_MS = 180_000;
/** Boards last built longer ago than this: the indexer runs, but its figures are behind. */
const INDEXER_BOARDS_OLD_MS = 60 * 60_000;
/** The longest an indexer that said it is stopping counts as maintenance (stops on 11-06 took up to 19.5 min). */
const INDEXER_STOP_MAX_MS = 20 * 60_000;
export const DEFAULT_SITE = 'https://www.valuedesk.so';

const STATE_CODE: Record<Exclude<ServiceState, 'unknown'>, number> = { down: 0, degraded: 1, up: 2 };
const CODE_STATE: Record<number, Exclude<ServiceState, 'unknown'>> = { 0: 'down', 1: 'degraded', 2: 'up' };

export interface Sample {
  service: ServiceId;
  state: Exclude<ServiceState, 'unknown'>;
  ms: number | null;
  /**
   * What made it not up, as codes (indexer only: indexerJudge.ts whyText) - for the automatic
   * incident's words. Not kept in the record.
   */
  why?: string[];
  /** How current the indexer's datasets are (indexer only, when its status was fresh enough to judge). */
  fresh?: FreshReading;
}

/** One UTC day's freshness tally per dataset: minutes past half its target, minutes past it, the worst figure (ms). */
export type FreshDay = { day: string; items: Partial<Record<FreshId, { warnMin: number; overMin: number; worstMs: number }>> };
const LAST_FRESH_KEY = 'last_fresh';
const FRESH_DAY_KEY = 'fresh_day:';

/** The last probe round as the admin suite reads it (StatusStore.lastChecks). */
export interface LastChecks {
  at: number;
  checks: Array<{ service: ServiceId; state: Exclude<ServiceState, 'unknown'>; ms: number | null; why: string[] }>;
}
const LAST_CHECKS_KEY = 'last_checks';

export const statusDbPath = (): string => process.env.VALUESCAN_STATUS_DB?.trim() || join(dataDir(), 'status.db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS samples (
  service TEXT NOT NULL,
  minute INTEGER NOT NULL,
  state INTEGER NOT NULL,
  ms INTEGER,
  PRIMARY KEY (service, minute)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS days (
  service TEXT NOT NULL,
  day TEXT NOT NULL,
  up INTEGER NOT NULL DEFAULT 0,
  degraded INTEGER NOT NULL DEFAULT 0,
  down INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (service, day)
) WITHOUT ROWID;
`;

export class StatusStore {
  private readonly db: DatabaseSync;
  /** The incidents and maintenance (ops/statusNotices.ts), in the same file. */
  readonly notices: NoticeStore;
  /** The incidents the probes open and resolve themselves (ops/statusAuto.ts). */
  readonly auto: AutoIncidents;

  constructor(readonly path = statusDbPath()) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA busy_timeout = 2000');
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec(SCHEMA);
    this.notices = new NoticeStore(this.db);
    this.auto = new AutoIncidents(this.notices);
  }

  /**
   * Once per status.db: the record already here played through the automatic incidents
   * (statusAuto.ts), at most 7 days back, so outages from before them get their entries.
   * How many minutes were played (0 when done before).
   */
  replayAuto(now = Date.now()): number {
    if (this.notices.getMeta(REPLAYED_KEY)) return 0;
    const from = Math.floor((now - 7 * 86_400_000) / 60_000) + 1;
    const rows = this.db.prepare('SELECT minute, service, state FROM samples WHERE minute >= ? ORDER BY minute, service').all(from) as Array<{ minute: number; service: string; state: number }>;
    let played = 0;
    for (let i = 0; i < rows.length; ) {
      const minute = Number(rows[i]!.minute);
      const list: Array<{ service: ServiceId; state: Exclude<ServiceState, 'unknown'> }> = [];
      for (; i < rows.length && Number(rows[i]!.minute) === minute; i++) {
        const r = rows[i]!;
        const state = CODE_STATE[Number(r.state)];
        if (isServiceId(r.service) && state) list.push({ service: r.service, state });
      }
      this.auto.observe(minute, list, minute * 60_000);
      played += 1;
    }
    this.notices.setMeta(REPLAYED_KEY, String(now));
    return played;
  }

  /**
   * One minute's samples. A service already sampled in that minute (two probers,
   * a restart within the minute) is not counted twice: the day's tally moves
   * only when the sample is new.
   */
  record(samples: readonly Sample[], now = Date.now()): void {
    const minute = Math.floor(now / 60_000);
    const day = utcDay(now);
    const add = this.db.prepare('INSERT OR IGNORE INTO samples (service, minute, state, ms) VALUES (?, ?, ?, ?)');
    const tally = this.db.prepare(
      `INSERT INTO days (service, day, up, degraded, down) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (service, day) DO UPDATE SET up = up + excluded.up, degraded = degraded + excluded.degraded, down = down + excluded.down`,
    );
    this.db.exec('BEGIN');
    try {
      for (const s of samples) {
        if (Number(add.run(s.service, minute, STATE_CODE[s.state], s.ms).changes) === 0) continue;
        tally.run(s.service, day, s.state === 'up' ? 1 : 0, s.state === 'degraded' ? 1 : 0, s.state === 'down' ? 1 : 0);
        if (s.fresh) this.tallyFresh(day, s.fresh);
      }
      // The page's freshness: this round's, or none when the indexer's status could not be judged.
      const ix = samples.find((s) => s.service === 'indexer');
      if (ix) this.notices.setMeta(LAST_FRESH_KEY, JSON.stringify(ix.fresh ? { at: minute * 60_000, items: freshItems(ix.fresh.values) } : null));
      // The round's verdicts with their reasons, for the admin suite only (lastChecks): never on the public page.
      this.notices.setMeta(LAST_CHECKS_KEY, JSON.stringify({ at: minute * 60_000, checks: samples.map((s) => ({ service: s.service, state: s.state, ms: s.ms, why: s.why ?? [] })) }));
      if (mayPrune('status')) this.db.prepare('DELETE FROM samples WHERE minute < ?').run(Math.floor((now - SAMPLE_KEEP_MS) / 60_000));
      if (mayPrune('status')) this.db.prepare('DELETE FROM days WHERE day < ?').run(utcDay(now - STATUS_KEEP_DAYS * 86_400_000));
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  private tallyFresh(day: string, f: FreshReading): void {
    const key = FRESH_DAY_KEY + day;
    let items: FreshDay['items'] = {};
    try {
      items = (JSON.parse(this.notices.getMeta(key) ?? '{}') as FreshDay['items']) ?? {};
    } catch {
      /* a broken tally starts again */
    }
    for (const id of FRESH_IDS) {
      const v = f.values[id];
      if (v === null || v === undefined) continue;
      const t = (items[id] ??= { warnMin: 0, overMin: 0, worstMs: 0 });
      if (f.over.includes(id)) t.overMin += 1;
      else if (f.warn.includes(id)) t.warnMin += 1;
      t.worstMs = Math.max(t.worstMs, Math.round(v));
    }
    this.notices.setMeta(key, JSON.stringify(items));
  }

  /** The last `days` UTC days' freshness tallies, newest first (days without one left out): the daily view. */
  freshDays(days = 7, now = Date.now()): FreshDay[] {
    const out: FreshDay[] = [];
    for (const day of lastDays(now, days).reverse()) {
      const raw = this.notices.getMeta(FRESH_DAY_KEY + day);
      if (!raw) continue;
      try {
        out.push({ day, items: JSON.parse(raw) as FreshDay['items'] });
      } catch {
        /* left out */
      }
    }
    return out;
  }

  /** The last round's freshness, when that round is recent (STALE_MS). */
  private lastFresh(now: number): Freshness | null {
    try {
      const v = JSON.parse(this.notices.getMeta(LAST_FRESH_KEY) ?? 'null') as Freshness | null;
      return v && typeof v.at === 'number' && Array.isArray(v.items) && now - v.at <= STALE_MS ? v : null;
    } catch {
      return null;
    }
  }

  /**
   * The last probe round: each service's verdict and what made it not up (indexer: indexerJudge.ts codes,
   * e.g. `stream:arcus`, `lane:hl`, `lag`, `stopping`). The admin suite shows which check failed; the
   * public report never carries it. Null before the first round of a prober that writes it.
   */
  lastChecks(): LastChecks | null {
    try {
      const v = JSON.parse(this.notices.getMeta(LAST_CHECKS_KEY) ?? 'null') as LastChecks | null;
      return v && typeof v.at === 'number' && Array.isArray(v.checks) ? v : null;
    } catch {
      return null;
    }
  }

  /** What the page shows: every service's last sample and its last STATUS_DAYS days. */
  report(now = Date.now()): StatusReport {
    const days = lastDays(now, STATUS_DAYS);
    const tallies = this.db.prepare('SELECT day, up, degraded, down FROM days WHERE service = ? AND day >= ?');
    const last = this.db.prepare('SELECT minute, state, ms FROM samples WHERE service = ? ORDER BY minute DESC LIMIT 1');
    const fresh = this.lastFresh(now);
    return {
      ok: true,
      at: now,
      probeEveryS: PROBE_EVERY_MS / 1000,
      services: STATUS_SERVICES.map(({ id, name }) => {
        const byDay = new Map<string, DayTuple>();
        for (const r of tallies.all(id, days[0]!) as Array<{ day: string; up: number; degraded: number; down: number }>) {
          byDay.set(r.day, [r.day, Number(r.up), Number(r.degraded), Number(r.down)]);
        }
        const series = days.map((d): DayTuple => byDay.get(d) ?? [d, 0, 0, 0]);
        const s = last.get(id) as { minute: number; state: number; ms: number | null } | undefined;
        const checkedAt = s ? Number(s.minute) * 60_000 : null;
        const fresh = checkedAt !== null && now - checkedAt <= STALE_MS;
        return {
          id,
          name,
          state: fresh ? (CODE_STATE[Number(s!.state)] ?? 'unknown') : 'unknown',
          checkedAt,
          latencyMs: s?.ms === null || s?.ms === undefined ? null : Number(s.ms),
          uptime: uptimeOf(series),
          days: series,
        };
      }),
      notices: this.notices.shown(now),
      ...(fresh ? { freshness: fresh } : {}),
    };
  }

  // --- what came before the prober, and the backup ----------------------------------

  /** No day and no notice recorded: a new file. */
  isEmpty(): boolean {
    const r = this.db.prepare('SELECT (SELECT COUNT(*) FROM days) + (SELECT COUNT(*) FROM notices) AS n').get() as { n: number };
    return Number(r.n) === 0;
  }

  /**
   * Minutes from another record of the same checks (tools/status-post.ts backfill:
   * the health check's journal), for the time BEFORE this record begins for each
   * service - never over a minute the prober has counted, and never twice: once a
   * minute is in, the record begins there. Within the record's first day that is
   * the first sample's minute; when the samples of the first day are gone (kept
   * two days), only whole days before it. What was added, per service and day.
   */
  backfill(samples: ReadonlyArray<Sample & { minute: number }>, now = Date.now(), o: { dryRun?: boolean } = {}): Record<string, Record<string, [number, number, number]>> {
    const keepFrom = mayPrune('status') ? Math.floor(Date.parse(`${utcDay(now - STATUS_KEEP_DAYS * 86_400_000)}T00:00:00Z`) / 60_000) : 0;
    const nowMin = Math.floor(now / 60_000);
    const firstSample = this.db.prepare('SELECT MIN(minute) AS m FROM samples WHERE service = ?');
    const firstDay = this.db.prepare('SELECT MIN(day) AS d FROM days WHERE service = ?');
    const add = this.db.prepare('INSERT OR IGNORE INTO samples (service, minute, state, ms) VALUES (?, ?, ?, ?)');
    const tally = this.db.prepare(
      `INSERT INTO days (service, day, up, degraded, down) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (service, day) DO UPDATE SET up = up + excluded.up, degraded = degraded + excluded.degraded, down = down + excluded.down`,
    );
    const added: Record<string, Record<string, [number, number, number]>> = {};
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const cutoff = new Map<ServiceId, number>();
      for (const { id } of STATUS_SERVICES) {
        const d = (firstDay.get(id) as { d: string | null }).d;
        const m = (firstSample.get(id) as { m: number | null }).m;
        if (d === null) cutoff.set(id, nowMin);
        else if (m !== null && utcDay(Number(m) * 60_000) === d) cutoff.set(id, Number(m));
        else cutoff.set(id, Math.floor(Date.parse(`${d}T00:00:00Z`) / 60_000));
      }
      const seen = new Set<string>();
      for (const s of [...samples].sort((a, b) => a.minute - b.minute)) {
        if (!isServiceId(s.service) || !(s.state in STATE_CODE)) continue;
        if (s.minute < keepFrom || s.minute >= (cutoff.get(s.service) ?? 0) || s.minute > nowMin) continue;
        const key = `${s.service}:${s.minute}`;
        if (seen.has(key)) continue;
        seen.add(key);
        // A sample already there (an earlier run whose first day is still in the samples) is not counted again.
        if (Number(add.run(s.service, s.minute, STATE_CODE[s.state], s.ms).changes) === 0) continue;
        const day = utcDay(s.minute * 60_000);
        tally.run(s.service, day, s.state === 'up' ? 1 : 0, s.state === 'degraded' ? 1 : 0, s.state === 'down' ? 1 : 0);
        const t = ((added[s.service] ??= {})[day] ??= [0, 0, 0]);
        t[s.state === 'up' ? 0 : s.state === 'degraded' ? 1 : 2] += 1;
      }
      // A dry run: what would be added, and nothing kept.
      this.db.exec(o.dryRun ? 'ROLLBACK' : 'COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return added;
  }

  /**
   * The finished days and every notice, as one JSON text that changes only when
   * they do (a day ends, a notice is posted) - what the off-server backup carries
   * (status-history.json; backup-offsite.sh api-state). status.db itself changes
   * every minute: in the backup it would send a new copy every 15 minutes.
   */
  history(now = Date.now()): string {
    const today = utcDay(now);
    const rows = this.db.prepare('SELECT service, day, up, degraded, down FROM days WHERE day < ? ORDER BY service, day').all(today) as Array<{ service: string; day: string; up: number; degraded: number; down: number }>;
    const days: Record<string, DayTuple[]> = {};
    for (const r of rows) (days[r.service] ??= []).push([r.day, Number(r.up), Number(r.degraded), Number(r.down)]);
    const notices = this.notices.all().sort((a, b) => a.id - b.id);
    return `${JSON.stringify({ kind: 'valuedesk-status-history', v: 1, days, notices })}\n`;
  }

  /**
   * Put a history back (a restored server: status.db new, status-history.json from the
   * backup): the days this record does not have, the notices it does not have. Never
   * changes a day or a notice that is here.
   */
  restoreHistory(text: string, now = Date.now()): { days: number; notices: number } {
    let v: { kind?: unknown; days?: unknown; notices?: unknown };
    try {
      v = JSON.parse(text) as typeof v;
    } catch {
      throw new Error('not a status history (not JSON)');
    }
    if (v?.kind !== 'valuedesk-status-history') throw new Error('not a status history');
    const oldest = mayPrune('status') ? utcDay(now - STATUS_KEEP_DAYS * 86_400_000) : '0000-00-00';
    const ins = this.db.prepare('INSERT OR IGNORE INTO days (service, day, up, degraded, down) VALUES (?, ?, ?, ?, ?)');
    const n = (x: unknown): number => (typeof x === 'number' && Number.isInteger(x) && x >= 0 && x <= 1440 ? x : -1);
    let days = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const [service, list] of Object.entries((v.days ?? {}) as Record<string, unknown>)) {
        if (!isServiceId(service) || !Array.isArray(list)) continue;
        for (const d of list as unknown[]) {
          if (!Array.isArray(d) || typeof d[0] !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d[0]) || d[0] < oldest || d[0] >= utcDay(now)) continue;
          const [up, deg, down] = [n(d[1]), n(d[2]), n(d[3])];
          if (up < 0 || deg < 0 || down < 0 || up + deg + down > 1440) continue;
          if (Number(ins.run(service, d[0], up, deg, down).changes) > 0) days += 1;
        }
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    const notices = this.notices.restore(Array.isArray(v.notices) ? v.notices : [], now);
    return { days, notices };
  }

  close(): void {
    this.db.close();
  }
}

/**
 * The open incidents and maintenance for /api/health (index.ts): what the app's
 * banner shows. Read at most every 30 s. A server without a status.db yet (a dev
 * server that never probed) has none - the file is not made for this.
 */
export function siteNoticeReader(hosted: boolean, path = statusDbPath()): () => HealthNotice[] {
  return healthNoticeReader(() => {
    if (!hosted && !existsSync(path)) throw new Error('no status.db');
    return new NoticeStore(path);
  });
}

export const historyPath = (dbPath = statusDbPath()): string => join(dirname(dbPath), 'status-history.json');

/**
 * Write status-history.json when what it holds has changed (atomically: a
 * temporary file, then a rename). Never throws; whether it wrote.
 */
export function writeHistory(store: StatusStore, path = historyPath(store.path), now = Date.now()): boolean {
  try {
    const text = store.history(now);
    if (existsSync(path) && readFileSync(path, 'utf8') === text) return false;
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, text, { mode: 0o640 });
    renameSync(tmp, path);
    return true;
  } catch {
    return false;
  }
}

// --- the probes ------------------------------------------------------------------------

export interface ProbeTargets {
  site: string;
  executor: string;
  /** Sent as X-Origin-Verify to the executor - only when VALUESCAN_STATUS_EXECUTOR_URL names it directly. */
  executorSecret: string | null;
  /** The executor's own server, asked only when the visitor's way fails (VALUESCAN_STATUS_EXECUTOR_DIRECT_URL). */
  executorDirect?: string | null;
  /** Sent as X-Origin-Verify to executorDirect: its Caddy refuses a request without it. */
  directSecret?: string | null;
}

const trimSlash = (s: string): string => s.replace(/\/+$/, '');

/** Where to probe, from the environment. */
export function probeTargetsFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): ProbeTargets {
  const get = (k: string): string => env[k]?.trim() ?? '';
  const site = trimSlash(get('VALUESCAN_STATUS_SITE_URL') || DEFAULT_SITE);
  const direct = trimSlash(get('VALUESCAN_STATUS_EXECUTOR_URL'));
  const fallback = trimSlash(get('VALUESCAN_STATUS_EXECUTOR_DIRECT_URL'));
  const secret = get('VALUESCAN_ORIGIN_SECRET').split(',')[0]?.trim() || null;
  const targets: ProbeTargets = {
    site,
    executor: direct || site,
    // Caddy on the executor's server refuses a request without the origin secret; the site's edge adds it itself.
    executorSecret: direct && direct !== site ? secret : null,
  };
  if (fallback) {
    targets.executorDirect = fallback;
    targets.directSecret = secret;
  }
  return targets;
}

type Fetch = typeof fetch;

async function timed(fetchImpl: Fetch, url: string, headers: Record<string, string> = {}): Promise<{ res: Response; ms: number; body: string } | null> {
  const t0 = Date.now();
  try {
    const res = await fetchImpl(url, { headers: { 'User-Agent': 'ValueDesk-status/1', ...headers }, redirect: 'follow', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    // A capped read: a health answer is small, a page's HTML a few kilobytes.
    const body = (await res.text()).slice(0, 64 * 1024);
    return { res, ms: Date.now() - t0, body };
  } catch {
    return null;
  }
}

const jsonOk = (body: string): boolean | null => {
  try {
    const v = JSON.parse(body) as { ok?: unknown };
    return typeof v?.ok === 'boolean' ? v.ok : null;
  } catch {
    return null;
  }
};

/**
 * No answer at all is asked once more, PROBE_RETRY_MS later, before it counts: a single dropped
 * connection on the way to the executor in Tokyo made a "down" minute (three on 2026-11-01, the
 * executor fine and its own checks green) - an incident on the status page for nothing.
 * An answer, good or bad, is not asked again here (the executor's own rules: probeExecutor).
 */
export const PROBE_RETRY_MS = 2_000;

/**
 * The executor's `ok:false` is asked once more this much later: a SoDEX feed reconnecting takes
 * seconds and was a whole degraded day bar (2026-11-05 07:41, one sample, every check of the
 * executor's own box green). Still not ok after this: a degraded minute.
 */
export const EXECUTOR_RECHECK_MS = 15_000;

/**
 * One minute's sample of the copy & algo executor.
 *
 * The visitor's way crosses Vercel, server 1 and the France-Japan link, so it can fail while the
 * executor runs: on 2026-11-04 three "down" minutes came with all 25 of the executor's own checks
 * green and a 1 MiB backup between the servers taking 32 s instead of about 7. When that way gives
 * no good answer, the executor's own server is asked over a new connection:
 *   - it answers ok: `degraded`, not `down`. Copies and algos run; a visitor may have waited.
 *   - it answers not ok: `degraded`, as the executor says.
 *   - no answer there either: `down`.
 */
async function probeExecutor(
  f: Fetch,
  t: ProbeTargets,
  retryMs: number | undefined,
  recheckMs: number,
): Promise<{ state: Exclude<ServiceState, 'unknown'>; ms: number | null }> {
  const headers = { Accept: 'application/json', ...(t.executorSecret ? { 'X-Origin-Verify': t.executorSecret } : {}) };
  const url = `${t.executor}/api/copy/v1/health`;
  const okOf = (a: Awaited<ReturnType<typeof timed>>): boolean | null => (a && a.res.status === 200 ? jsonOk(a.body) : null);
  const first = await timedRetry(f, url, headers, retryMs);
  const said = okOf(first);
  if (said === true) return { state: 'up', ms: first!.ms };
  if (said === false) {
    if (recheckMs > 0) await new Promise((r) => setTimeout(r, recheckMs));
    const again = await timed(f, url, headers);
    return { state: okOf(again) === true ? 'up' : 'degraded', ms: again?.ms ?? first!.ms };
  }
  if (t.executorDirect) {
    const direct = await timed(f, `${t.executorDirect}/api/copy/v1/health`, {
      Accept: 'application/json',
      ...(t.directSecret ? { 'X-Origin-Verify': t.directSecret } : {}),
    });
    if (okOf(direct) !== null) return { state: 'degraded', ms: first?.ms ?? null };
  }
  return { state: 'down', ms: first?.ms ?? null };
}

async function timedRetry(fetchImpl: Fetch, url: string, headers: Record<string, string> = {}, retryMs = PROBE_RETRY_MS): Promise<{ res: Response; ms: number; body: string } | null> {
  const first = await timed(fetchImpl, url, headers);
  if (first) return first;
  if (retryMs > 0) await new Promise((r) => setTimeout(r, retryMs));
  return timed(fetchImpl, url, headers);
}

/**
 * The indexer publishes its status every 30 s, so one socket reconnecting at that moment read as a
 * stream down for the next 30 s (arcus and SoDEX reconnect about ten times an hour, in seconds).
 * A stream that reads as down is read once more after the next publish: down in both is a degraded
 * minute. A stale status is not asked again: the indexer has stopped publishing.
 */
export const INDEXER_RECHECK_MS = 35_000;

type IndexerSeen = { state: 'up' | 'degraded' | 'down'; why: string[]; fresh?: FreshReading };

function indexerState(status: () => unknown, now: () => number, judge: IndexerJudge): IndexerSeen {
  let h = null;
  let raw: unknown = null;
  try {
    raw = status();
    h = indexerHealth(raw);
  } catch {
    /* no index file: down */
  }
  const age = h?.at ? now() - h.at : null;
  // The indexer says it is stopping (a release, a restart): maintenance, not an incident (statusAuto.ts),
  // for as long as a stop takes at most (11-06: 36 s to 19.5 min). A handover (indexer/handover.ts) publishes
  // `handover` instead: the standby's sockets hold every print while the old process stops, so its row (the last
  // status before the stop, the standby's sockets as streams) is judged as it is, and goes stale like any other.
  if (h && age !== null && age <= INDEXER_STOP_MAX_MS && (raw as { stopping?: unknown }).stopping === true) return { state: 'degraded', why: ['stopping'] };
  if (!h || age === null || age > INDEXER_STALE_MS) {
    // Not publishing, but the boards it wrote are under an hour old: what users see is still recent.
    // The stops of 11-06 (36 s to 19.5 min) made most of that day's 39 down minutes.
    const written = (raw as { boardsAt?: unknown } | null)?.boardsAt;
    const boards = Math.max(h?.lastBuildAt ?? 0, typeof written === 'number' && Number.isFinite(written) ? written : 0);
    return boards > 0 && now() - boards <= INDEXER_BOARDS_OLD_MS ? { state: 'degraded', why: ['paused'] } : { state: 'down', why: [] };
  }
  const why: string[] = [];
  const streams = Object.entries(h.streams);
  if (!streams.length) why.push('stream:');
  for (const [venue, up] of streams) if (!up) why.push(`stream:${venue}`);
  // Boards hours old under a green page: 11.3 h on 2026-11-04 with most of that day counted as up. Until a new process's
  // first build ends (15-90 min after the restarts of 2026-11-08) the boards shown are the last process's: their age is
  // that build's (prevBuildAt, engine.ts loadWarm), else the newest board on disk - not "no build yet, so fine".
  // (h.lastBuildAt already falls back to boardsAt: hosted.ts indexerHealth. The process's own build comes first here.)
  const { lastBuildAt: own, prevBuildAt: prev } = raw as { lastBuildAt?: unknown; prevBuildAt?: unknown };
  const builtAt = typeof own === 'number' && own > 0 ? own
    : typeof prev === 'number' && prev > 0 ? prev
    : typeof h.lastBuildAt === 'number' ? h.lastBuildAt : 0;
  if (builtAt > 0 && now() - builtAt > INDEXER_BOARDS_OLD_MS) why.push('boards');
  // Lanes that have work and finish none, reads failing, the thread far behind (ops/indexerJudge.ts).
  // Over an hour old is said as `boards` already: not twice.
  for (const code of judge.judge(h, now())) if (!(code === 'fresh:boards' && why.includes('boards'))) why.push(code);
  return { state: why.length ? 'degraded' : 'up', why, ...(judge.lastFresh ? { fresh: judge.lastFresh } : {}) };
}

async function probeIndexer(status: () => unknown, now: () => number, recheckMs: number, judge: IndexerJudge): Promise<IndexerSeen> {
  const first = indexerState(status, now, judge);
  if (first.state !== 'degraded') return first;
  if (recheckMs > 0) await new Promise((r) => setTimeout(r, recheckMs));
  return indexerState(status, now, judge);
}

/** Probe every service once. Never throws: a failed probe is a `down` sample. */
export async function probeAll(o: {
  targets: ProbeTargets; fetch?: Fetch; indexerStatus?: () => unknown; now?: () => number; retryMs?: number; recheckMs?: number; indexerRecheckMs?: number;
  /** The indexer's readings across rounds (startStatusProber keeps one); none: this round alone. */
  indexerJudge?: IndexerJudge;
}): Promise<Sample[]> {
  const f = o.fetch ?? fetch;
  const now = o.now ?? Date.now;
  const { site } = o.targets;
  const [web, api, exec, indexer] = await Promise.all([
    timedRetry(f, `${site}/`, {}, o.retryMs),
    timedRetry(f, `${site}/api/health`, { Accept: 'application/json' }, o.retryMs),
    probeExecutor(f, o.targets, o.retryMs, o.recheckMs ?? EXECUTOR_RECHECK_MS),
    o.indexerStatus ? probeIndexer(o.indexerStatus, now, o.indexerRecheckMs ?? INDEXER_RECHECK_MS, o.indexerJudge ?? new IndexerJudge()) : null,
  ]);
  const out: Sample[] = [];
  out.push({
    service: 'website',
    state: web && web.res.status === 200 && /text\/html/i.test(web.res.headers.get('content-type') ?? '') ? 'up' : 'down',
    ms: web?.ms ?? null,
  });
  out.push({ service: 'api', state: api && api.res.status === 200 && jsonOk(api.body) === true ? 'up' : 'down', ms: api?.ms ?? null });
  out.push({ service: 'executor', state: exec.state, ms: exec.ms });
  if (indexer) out.push({ service: 'indexer', state: indexer.state, ms: null, ...(indexer.why.length ? { why: indexer.why } : {}), ...(indexer.fresh ? { fresh: indexer.fresh } : {}) });
  return out;
}

export interface StatusProber {
  store: StatusStore;
  stop(): void;
  /** One round now (tests). */
  tick(): Promise<void>;
}

export interface ProberLog {
  warn(o: object, msg: string): void;
}

/** Start probing every PROBE_EVERY_MS; the first round shortly after the start. */
export function startStatusProber(o: {
  store?: StatusStore;
  targets?: ProbeTargets;
  fetch?: Fetch;
  indexerStatus?: () => unknown;
  log?: ProberLog;
  everyMs?: number;
  firstAfterMs?: number;
  /** The backup export (writeHistory); null: none (tests). Default next to status.db. */
  historyFile?: string | null;
}): StatusProber {
  const store = o.store ?? new StatusStore();
  const targets = o.targets ?? probeTargetsFromEnv();
  const historyFile = o.historyFile === undefined ? historyPath(store.path) : o.historyFile;
  // A restored server: status.db is new and the backup put status-history.json back.
  if (historyFile && store.isEmpty() && existsSync(historyFile)) {
    try {
      store.restoreHistory(readFileSync(historyFile, 'utf8'));
    } catch (e) {
      o.log?.warn({ err: e instanceof Error ? e.message : String(e) }, 'status: status-history.json could not be read back');
    }
  }
  try {
    store.replayAuto();
  } catch (e) {
    o.log?.warn({ err: e instanceof Error ? e.message : String(e) }, 'status: the record could not be played through the automatic incidents');
  }
  let running = false;
  const indexerJudge = new IndexerJudge();
  // The datasets past half their target in the last round: each is logged once, as it gets there.
  let warned = new Set<FreshId>();
  const tick = async (): Promise<void> => {
    // One round at a time: a slow round is never overlapped by the next.
    if (running) return;
    running = true;
    // The minute is the one the round STARTED in: taken when the probes finished (up to 2 x 10 s
    // later), a round near a minute's end landed in the next one and left a minute with no sample
    // (three on 2026-10-31 with nothing down - owner 2026-11-01: the checker must not go blind).
    const started = Date.now();
    try {
      const samples = await probeAll({ targets, fetch: o.fetch, indexerStatus: o.indexerStatus, indexerJudge });
      const fresh = samples.find((s) => s.service === 'indexer')?.fresh;
      const now = new Set<FreshId>(fresh ? [...fresh.warn, ...fresh.over] : []);
      for (const id of now) {
        if (warned.has(id)) continue;
        const target = FRESH_TARGETS.find((t) => t.id === id)!;
        o.log?.warn({ dataset: id, ms: fresh!.values[id], targetMs: target.budgetMs, over: fresh!.over.includes(id) }, `status: indexer ${id} past ${fresh!.over.includes(id) ? 'its' : 'half its'} freshness target`);
      }
      warned = now;
      const at = started;
      store.record(samples, at);
      store.auto.observe(Math.floor(at / 60_000), samples, Date.now());
      if (historyFile) writeHistory(store, historyFile);
    } catch (e) {
      o.log?.warn({ err: e instanceof Error ? e.message : String(e) }, 'status probe round failed');
    } finally {
      running = false;
    }
  };
  // A round soon after the start, then one at the start of every minute (a second in, so a
  // timer that fires a hair early is still in its minute): each minute gets exactly one round.
  const everyMs = o.everyMs ?? PROBE_EVERY_MS;
  const first = setTimeout(() => void tick(), o.firstAfterMs ?? 10_000);
  first.unref();
  let next: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const schedule = () => {
    if (stopped) return;
    const wait = everyMs - (Date.now() % everyMs) + 1_000;
    next = setTimeout(() => {
      void tick();
      schedule();
    }, wait);
    next.unref();
  };
  schedule();
  return {
    store,
    tick,
    stop: () => {
      stopped = true;
      clearTimeout(first);
      if (next) clearTimeout(next);
    },
  };
}

/** Whether this process runs the prober (see the header). */
export function proberEnabled(env: Readonly<Record<string, string | undefined>>, hosted: boolean): boolean {
  const v = env.VALUESCAN_STATUS_PROBE?.trim();
  if (v === '0') return false;
  return hosted || v === '1';
}
