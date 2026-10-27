/**
 * The status page's data (StatusPage.tsx): the server's report, or - when the
 * status service itself does not answer - what this browser can still find out.
 *
 * GET /api/vs/status is answered by the API on server 1 (apps/server
 * routes/status.ts), which probes everything every minute. If that does not
 * answer, server 1 or its API is down, and the page says so; it then asks the
 * copy executor's own health (/api/copy/v1/health) from here, so whether copies
 * and algos run is still shown. The website itself is up by definition: this
 * page came from it.
 */
import {
  STATUS_SERVICES, dayTone, minutesExpected, type DayTone, type DayTuple, type ServiceState, type StatusReport,
} from '@sign/ops/statusModel.js';

export type { DayTone, DayTuple, ServiceState, StatusReport };

const TIMEOUT_MS = 8_000;

export interface DirectCheck {
  state: Exclude<ServiceState, 'unknown'>;
  ms: number | null;
  at: number;
}

export type StatusView =
  | { kind: 'report'; report: StatusReport }
  | { kind: 'unreachable'; at: number; executor: DirectCheck };

const isReport = (v: unknown): v is StatusReport => {
  const r = v as StatusReport | null;
  return !!r && r.ok === true && Array.isArray(r.services) && r.services.every((s) => typeof s?.id === 'string' && Array.isArray(s.days));
};

async function getJson(f: typeof fetch, url: string): Promise<{ status: number; body: unknown; ms: number } | null> {
  const t0 = Date.now();
  try {
    const res = await f(url, { headers: { Accept: 'application/json' }, cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT_MS) });
    const body = await res.json().catch(() => null);
    return { status: res.status, body, ms: Date.now() - t0 };
  } catch {
    return null;
  }
}

/** The executor's health, asked from this browser: up, degraded (it answers, not ok) or down. */
export async function checkExecutor(f: typeof fetch = fetch, now = Date.now): Promise<DirectCheck> {
  const r = await getJson(f, '/api/copy/v1/health');
  const ok = r && r.status === 200 ? (r.body as { ok?: unknown } | null)?.ok : undefined;
  return { state: ok === true ? 'up' : ok === false ? 'degraded' : 'down', ms: r?.ms ?? null, at: now() };
}

/** What the page shows next. Never throws. */
export async function loadStatus(f: typeof fetch = fetch, now = Date.now): Promise<StatusView> {
  const r = await getJson(f, '/api/vs/status');
  if (r && r.status === 200 && isReport(r.body)) return { kind: 'report', report: r.body };
  return { kind: 'unreachable', at: now(), executor: await checkExecutor(f, now) };
}

export type Overall = 'operational' | 'degraded' | 'outage' | 'unknown';

/** The headline: every known service up, any degraded, or any down. */
export function overallOf(states: readonly ServiceState[]): Overall {
  const known = states.filter((s) => s !== 'unknown');
  if (!known.length) return 'unknown';
  if (known.includes('down')) return 'outage';
  if (known.includes('degraded')) return 'degraded';
  return 'operational';
}

export const OVERALL_TEXT: Record<Overall, string> = {
  operational: 'All systems operational',
  degraded: 'Some systems are degraded',
  outage: 'Some systems are down',
  unknown: 'No current data',
};

export const STATE_TEXT: Record<ServiceState, string> = {
  up: 'Operational',
  degraded: 'Degraded',
  down: 'Down',
  unknown: 'No data',
};

/** What each service is, in a line, for the visitor. */
export const SERVICE_LINE: Record<(typeof STATUS_SERVICES)[number]['id'], string> = {
  website: 'www.valuedesk.so and the app itself',
  api: 'Leaderboards, cohorts, news and the calendar',
  executor: 'Hosted copy trading and algo orders',
  indexer: 'Keeps the leaderboards and cohorts current',
};

const fmtMinutes = (m: number): string => (m < 60 ? `${m} min` : m % 60 === 0 ? `${m / 60} h` : `${Math.floor(m / 60)} h ${m % 60} min`);

/** One day bar's tone and its tooltip: the date, the uptime, the minutes down and without data. */
export function dayBar(d: DayTuple, now: number): { tone: DayTone; title: string } {
  const [day, up, deg, down] = d;
  const tone = dayTone(d);
  const date = new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const probed = up + deg + down;
  if (!probed) return { tone, title: `${date} · no data` };
  const pct = ((up + deg) / probed) * 100;
  const parts = [`${date}`, `${pct >= 99.995 ? '100' : pct.toFixed(2)}% up`];
  if (down) parts.push(`${fmtMinutes(down)} down`);
  if (deg) parts.push(`${fmtMinutes(deg)} degraded`);
  const missing = Math.max(0, minutesExpected(day, now) - probed);
  if (missing >= 5) parts.push(`${fmtMinutes(missing)} no data`);
  return { tone, title: parts.join(' · ') };
}

/** "99.982%", "100%" or "-" for no data. */
export function fmtUptime(pct: number | null): string {
  if (pct === null) return '–';
  if (pct >= 99.9995) return '100%';
  return `${pct.toFixed(pct >= 99 ? 3 : 2)}%`;
}
