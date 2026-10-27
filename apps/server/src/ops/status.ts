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
 *                                      address on the executor's own box - not this one)
 *   indexer   its own status, read in this process (hosted.ts indexerHealth): fresh
 *             and every stream up, else `degraded` (a stream down) or `down` (stale)
 *
 * Each answer is one minute's sample in `status.db` (the server's data directory;
 * SQLite, WAL) and adds one minute to that UTC day's tally. Samples are kept two
 * days, tallies STATUS_KEEP_DAYS, so the file stays a few hundred kilobytes. A
 * minute the prober did not run - this server down, a restart - has no sample: the
 * page shows it as no data, never as up.
 *
 * Runs on a hosted server (VALUESCAN_HOSTED=1) unless VALUESCAN_STATUS_PROBE=0, and
 * locally only with VALUESCAN_STATUS_PROBE=1: a dev server has no reason to ask the
 * production site anything every minute.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dataDir } from '../builder/paths.js';
import { indexerHealth } from '../hosted.js';
import {
  STATUS_DAYS, STATUS_SERVICES, lastDays, uptimeOf, utcDay,
  type DayTuple, type ServiceId, type ServiceState, type StatusReport,
} from './statusModel.js';

export const PROBE_EVERY_MS = 60_000;
export const PROBE_TIMEOUT_MS = 10_000;
export const STATUS_KEEP_DAYS = 120;
const SAMPLE_KEEP_MS = 2 * 86_400_000;
/** A last sample older than this: the prober has stopped, the state is unknown. */
const STALE_MS = 5 * 60_000;
/** The indexer publishes its status every 30 s (hosted.ts IndexerHealth.at). */
const INDEXER_STALE_MS = 180_000;
export const DEFAULT_SITE = 'https://www.valuedesk.so';

const STATE_CODE: Record<Exclude<ServiceState, 'unknown'>, number> = { down: 0, degraded: 1, up: 2 };
const CODE_STATE: Record<number, Exclude<ServiceState, 'unknown'>> = { 0: 'down', 1: 'degraded', 2: 'up' };

export interface Sample {
  service: ServiceId;
  state: Exclude<ServiceState, 'unknown'>;
  ms: number | null;
}

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

  constructor(path = statusDbPath()) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA busy_timeout = 2000');
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec(SCHEMA);
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
      }
      this.db.prepare('DELETE FROM samples WHERE minute < ?').run(Math.floor((now - SAMPLE_KEEP_MS) / 60_000));
      this.db.prepare('DELETE FROM days WHERE day < ?').run(utcDay(now - STATUS_KEEP_DAYS * 86_400_000));
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** What the page shows: every service's last sample and its last STATUS_DAYS days. */
  report(now = Date.now()): StatusReport {
    const days = lastDays(now, STATUS_DAYS);
    const tallies = this.db.prepare('SELECT day, up, degraded, down FROM days WHERE service = ? AND day >= ?');
    const last = this.db.prepare('SELECT minute, state, ms FROM samples WHERE service = ? ORDER BY minute DESC LIMIT 1');
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
    };
  }

  close(): void {
    this.db.close();
  }
}

// --- the probes ------------------------------------------------------------------------

export interface ProbeTargets {
  site: string;
  executor: string;
  /** Sent as X-Origin-Verify to the executor - only when VALUESCAN_STATUS_EXECUTOR_URL names it directly. */
  executorSecret: string | null;
}

const trimSlash = (s: string): string => s.replace(/\/+$/, '');

/** Where to probe, from the environment. */
export function probeTargetsFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): ProbeTargets {
  const get = (k: string): string => env[k]?.trim() ?? '';
  const site = trimSlash(get('VALUESCAN_STATUS_SITE_URL') || DEFAULT_SITE);
  const direct = trimSlash(get('VALUESCAN_STATUS_EXECUTOR_URL'));
  return {
    site,
    executor: direct || site,
    // Caddy on the executor's server refuses a request without the origin secret; the site's edge adds it itself.
    executorSecret: direct && direct !== site ? get('VALUESCAN_ORIGIN_SECRET').split(',')[0]?.trim() || null : null,
  };
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

/** Probe every service once. Never throws: a failed probe is a `down` sample. */
export async function probeAll(o: { targets: ProbeTargets; fetch?: Fetch; indexerStatus?: () => unknown; now?: () => number }): Promise<Sample[]> {
  const f = o.fetch ?? fetch;
  const now = o.now ?? Date.now;
  const { site, executor, executorSecret } = o.targets;
  const [web, api, exec] = await Promise.all([
    timed(f, `${site}/`),
    timed(f, `${site}/api/health`, { Accept: 'application/json' }),
    timed(f, `${executor}/api/copy/v1/health`, { Accept: 'application/json', ...(executorSecret ? { 'X-Origin-Verify': executorSecret } : {}) }),
  ]);
  const out: Sample[] = [];
  out.push({
    service: 'website',
    state: web && web.res.status === 200 && /text\/html/i.test(web.res.headers.get('content-type') ?? '') ? 'up' : 'down',
    ms: web?.ms ?? null,
  });
  out.push({ service: 'api', state: api && api.res.status === 200 && jsonOk(api.body) === true ? 'up' : 'down', ms: api?.ms ?? null });
  const execOk = exec && exec.res.status === 200 ? jsonOk(exec.body) : null;
  out.push({ service: 'executor', state: execOk === true ? 'up' : execOk === false ? 'degraded' : 'down', ms: exec?.ms ?? null });
  if (o.indexerStatus) {
    let h = null;
    try {
      h = indexerHealth(o.indexerStatus());
    } catch {
      /* no index file: down */
    }
    const fresh = h?.at !== null && h?.at !== undefined && now() - h.at <= INDEXER_STALE_MS;
    const streams = Object.values(h?.streams ?? {});
    out.push({ service: 'indexer', state: !fresh ? 'down' : streams.length && streams.every(Boolean) ? 'up' : 'degraded', ms: null });
  }
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
}): StatusProber {
  const store = o.store ?? new StatusStore();
  const targets = o.targets ?? probeTargetsFromEnv();
  let running = false;
  const tick = async (): Promise<void> => {
    // One round at a time: a slow round is never overlapped by the next.
    if (running) return;
    running = true;
    try {
      const samples = await probeAll({ targets, fetch: o.fetch, indexerStatus: o.indexerStatus });
      store.record(samples);
    } catch (e) {
      o.log?.warn({ err: e instanceof Error ? e.message : String(e) }, 'status probe round failed');
    } finally {
      running = false;
    }
  };
  const first = setTimeout(() => void tick(), o.firstAfterMs ?? 10_000);
  const every = setInterval(() => void tick(), o.everyMs ?? PROBE_EVERY_MS);
  first.unref();
  every.unref();
  return {
    store,
    tick,
    stop: () => {
      clearTimeout(first);
      clearInterval(every);
    },
  };
}

/** Whether this process runs the prober (see the header). */
export function proberEnabled(env: Readonly<Record<string, string | undefined>>, hosted: boolean): boolean {
  const v = env.VALUESCAN_STATUS_PROBE?.trim();
  if (v === '0') return false;
  return hosted || v === '1';
}
