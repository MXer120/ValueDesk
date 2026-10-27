/**
 * The status page's data: what GET /api/vs/status answers (ops/status.ts) and how
 * the page reads a day of it (apps/web/src/status/). Pure, shared through the
 * web's @sign alias, so the two cannot disagree about what a bar means.
 */

export const STATUS_SERVICES = [
  { id: 'website', name: 'Website' },
  { id: 'api', name: 'Data API' },
  { id: 'executor', name: 'Copy & algo executor' },
  { id: 'indexer', name: 'Indexer' },
] as const;
export type ServiceId = (typeof STATUS_SERVICES)[number]['id'];

export type ServiceState = 'up' | 'degraded' | 'down' | 'unknown';

/** One UTC day of one service: [YYYY-MM-DD, up minutes, degraded minutes, down minutes]. */
export type DayTuple = [day: string, up: number, degraded: number, down: number];

export interface ServiceStatus {
  id: ServiceId;
  name: string;
  /** The last probe's verdict; `unknown` when there is none from the last few minutes. */
  state: ServiceState;
  checkedAt: number | null;
  latencyMs: number | null;
  /** Up or degraded over the minutes probed in the window, percent; null without a sample. */
  uptime: number | null;
  /** The last STATUS_DAYS UTC days, oldest first, today last. */
  days: DayTuple[];
}

export interface StatusReport {
  ok: true;
  at: number;
  probeEveryS: number;
  services: ServiceStatus[];
}

export const STATUS_DAYS = 90;
export const MINUTES_PER_DAY = 1440;

export const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** The last `n` UTC days up to the one `now` falls in, oldest first. */
export function lastDays(now: number, n = STATUS_DAYS): string[] {
  const out: string[] = [];
  const today = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
  for (let i = n - 1; i >= 0; i--) out.push(utcDay(today - i * 86_400_000));
  return out;
}

/** Up or degraded over the probed minutes, percent (null: nothing probed). */
export function uptimeOf(days: readonly DayTuple[]): number | null {
  let ok = 0;
  let all = 0;
  for (const [, up, deg, down] of days) {
    ok += up + deg;
    all += up + deg + down;
  }
  return all ? Math.round((ok / all) * 100_000) / 1000 : null;
}

export type DayTone = 'up' | 'degraded' | 'partial' | 'down' | 'nodata';

/**
 * What one day's bar shows. `nodata`: not a minute of it was probed (the status
 * service itself was down, or did not exist yet). `down` when a tenth or more of
 * the probed minutes were down, `partial` for any down minute below that,
 * `degraded` for degraded minutes alone.
 */
export function dayTone([, up, deg, down]: DayTuple): DayTone {
  const all = up + deg + down;
  if (!all) return 'nodata';
  if (down / all >= 0.1) return 'down';
  if (down > 0) return 'partial';
  if (deg > 0) return 'degraded';
  return 'up';
}

/** Minutes of a day that have passed by `now` (all of it for a past day): how many probes there could have been. */
export function minutesExpected(day: string, now: number): number {
  const start = Date.parse(`${day}T00:00:00Z`);
  if (now >= start + 86_400_000) return MINUTES_PER_DAY;
  return Math.max(0, Math.floor((now - start) / 60_000));
}
