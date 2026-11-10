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
  FRESH_TARGETS, IMPACT_TEXT, STAGE_TEXT, STATUS_SERVICES, dayToneWith, fmtAge, fmtUtc, fmtWindow, minutesExpected, noticeLive, noticePhase,
  noticeSpan, noticesOnDay, overallOf, overallShown, parseFreshness, parseNotice, shownState,
  type DayTone, type FreshId, type FreshItem, type FreshState, type Freshness, type DayToneShown, type DayTuple, type HealthNotice, type Notice, type NoticePhase, type ServiceId,
  type ServiceState, type StatusReport, type Overall, type OverallShown, type ShownState,
} from '@sign/ops/statusModel.js';
import { fmtFixed } from '../numStyle';

export type { Overall, OverallShown, ShownState };
export { overallOf, overallShown, shownState };
export type { FreshItem, FreshState, Freshness };
export type { DayTone, DayToneShown, DayTuple, HealthNotice, Notice, NoticePhase, ServiceState, StatusReport };
export { IMPACT_TEXT, STAGE_TEXT, fmtUtc, fmtWindow, noticeLive, noticePhase };

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
  if (r && r.status === 200 && isReport(r.body)) {
    // Checked one by one: a notice that is not one is left out, the rest still shows.
    const notices = (Array.isArray(r.body.notices) ? r.body.notices : []).map(parseNotice).filter((n): n is Notice => n !== null);
    // Checked too: a server older than the freshness figures sends none, and the page shows none.
    const { freshness: rawFresh, ...rest } = r.body;
    const freshness = parseFreshness(rawFresh);
    return { kind: 'report', report: { ...rest, notices, ...(freshness ? { freshness } : {}) } };
  }
  return { kind: 'unreachable', at: now(), executor: await checkExecutor(f, now) };
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


/** "99.982%", "100%" or "-" for no data. */
export function fmtUptime(pct: number | null): string {
  if (pct === null) return '–';
  if (pct >= 99.9995) return '100%';
  return `${fmtFixed(pct, pct >= 99 ? 3 : 2)}%`;
}

// --- incidents and maintenance on the page -------------------------------------------------

// What a service's pill says (shownState, overallShown) lives in @sign/ops/statusModel.ts: the admin
// suite's Status and Overview judge with the very same code, so the two pages never disagree.

export const SHOWN_TEXT: Record<ShownState, string> = { ...STATE_TEXT, partial: 'Partial outage', maintenance: 'Maintenance' };

export const OVERALL_SHOWN_TEXT: Record<OverallShown, string> = { ...OVERALL_TEXT, partial: 'Partial outage', maintenance: 'Maintenance in progress' };

/** The headline's icon: a check, a warning (degraded or partly down), an X (a service down, or this page's own service), maintenance, no data. */
export type HeroTone = 'ok' | 'warn' | 'down' | 'maintenance' | 'unknown';

export function heroTone(overall: OverallShown | 'unreachable'): HeroTone {
  switch (overall) {
    case 'operational': return 'ok';
    case 'degraded':
    case 'partial': return 'warn';
    case 'outage':
    case 'unreachable': return 'down';
    case 'maintenance': return 'maintenance';
    default: return 'unknown';
  }
}

/** How long it lasted, or has lasted so far: "12 min", "4 h 35 min". */
export function noticeDuration(n: Notice, now: number): string {
  const [from, to] = noticeSpan(n, now);
  return fmtMinutes(Math.max(1, Math.round((to - from) / 60_000)));
}

/** The incidents and maintenance the page's two lists show: current (open, in progress, scheduled) and past, newest first. */
export function splitNotices(notices: readonly Notice[], now: number): { current: Notice[]; past: Notice[] } {
  const phase = (n: Notice) => noticePhase(n, now);
  const live = notices.filter((n) => noticeLive(n, now)).sort((a, b) => (a.kind === b.kind ? b.startsAt - a.startsAt : a.kind === 'incident' ? -1 : 1));
  const upcoming = notices.filter((n) => phase(n) === 'upcoming').sort((a, b) => a.startsAt - b.startsAt);
  const past = notices.filter((n) => !live.includes(n) && !upcoming.includes(n)).sort((a, b) => noticeSpan(b, now)[0] - noticeSpan(a, now)[0]);
  return { current: [...live, ...upcoming], past };
}

const SERVICE_NAME = new Map<string, string>(STATUS_SERVICES.map((s) => [s.id, s.name]));
export const componentNames = (n: Notice): string => n.components.map((c) => SERVICE_NAME.get(c) ?? c).join(', ');

/** What an incident is called by its impact: never "major incident" (owner, 2026-11-07: "Its a partial outage so just say Partial Outage"). */
export const incidentTitle = (impact: 'minor' | 'major' | 'critical' | null | undefined): string =>
  impact === 'critical' ? 'Outage' : impact === 'major' ? 'Partial outage' : `${IMPACT_TEXT[impact ?? 'minor']} incident`;

/** "Partial outage", "Maintenance". */
export const noticeKindText = (n: Notice): string => (n.kind === 'incident' ? incidentTitle(n.impact) : 'Maintenance');

/** When it was (or is): "27 Oct 14:02 – 15:10 UTC", "since 27 Oct 14:02 UTC", a maintenance's window. */
export function noticeTimes(n: Notice, now: number): string {
  // Completed early - or, held open (a release's), whenever it was: its real end.
  if (n.kind === 'maintenance') return fmtWindow(n.startsAt, n.closedAt !== null && (n.closedAt < n.endsAt! || n.holdOpen) ? Math.max(n.closedAt, n.startsAt + 60_000) : n.endsAt!);
  if (n.closedAt === null) return `since ${fmtUtc(n.startsAt)}`;
  const [from, to] = noticeSpan(n, now);
  return fmtWindow(from, to);
}

export interface DayDetail {
  day: string;
  tone: DayToneShown;
  /** "27 Oct 2026". */
  date: string;
  /** "99.86% up", or null for no data. */
  uptime: string | null;
  /** "2 min down", "15 min degraded", "3 h no data". */
  facts: string[];
  /** That day's incidents and maintenance on this service. */
  notices: Array<{ id: number; label: string; title: string; times: string }>;
}

/** Everything one day bar's tooltip says. */
export function dayDetail(d: DayTuple, service: ServiceId, notices: readonly Notice[], now: number): DayDetail {
  const [day, up, deg, down] = d;
  const onDay = noticesOnDay(notices, service, day, now);
  const probed = up + deg + down;
  const pct = probed ? ((up + deg) / probed) * 100 : null;
  const facts: string[] = [];
  if (down) facts.push(`${fmtMinutes(down)} down`);
  if (deg) facts.push(`${fmtMinutes(deg)} degraded`);
  const missing = Math.max(0, minutesExpected(day, now) - probed);
  if (probed && missing >= 5) facts.push(`${fmtMinutes(missing)} no data`);
  return {
    day,
    tone: dayToneWith(d, onDay),
    date: new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }),
    uptime: pct === null ? null : `${pct >= 99.995 ? '100' : fmtFixed(pct, 2)}% up`,
    facts,
    notices: onDay.map((n) => ({ id: n.id, label: noticeKindText(n), title: n.title, times: noticeTimes(n, now) })),
  };
}

/** The open incidents and maintenance /api/health carries (the app's banner); [] for anything else. */
export function healthNoticesOf(health: unknown): HealthNotice[] {
  const list = (health as { notices?: unknown } | null | undefined)?.notices;
  if (!Array.isArray(list)) return [];
  const phases: readonly string[] = ['active', 'upcoming', 'in_progress'];
  return list.filter((n): n is HealthNotice => {
    const v = n as HealthNotice | null;
    return !!v && typeof v.id === 'number' && (v.kind === 'incident' || v.kind === 'maintenance') && typeof v.title === 'string'
      && v.title.length > 0 && phases.includes(v.phase) && typeof v.startsAt === 'number';
  }).slice(0, 3);
}

/** The app banner's line for one notice. */
export function healthNoticeText(n: HealthNotice): string {
  const title = n.title.length > 120 ? `${n.title.slice(0, 119)}…` : n.title;
  if (n.kind === 'incident') return `${n.impact === 'critical' ? 'Outage' : 'Incident'}: ${title}`;
  if (n.phase === 'in_progress') return `Maintenance in progress: ${title}${typeof n.endsAt === 'number' ? `, until ${fmtUtc(n.endsAt, { date: false })}` : ''}`;
  return `Scheduled maintenance: ${title}, ${typeof n.endsAt === 'number' ? fmtWindow(n.startsAt, n.endsAt) : fmtUtc(n.startsAt)}`;
}

// --- how current the indexer's data is (under the Indexer, StatusPage.tsx FreshList) -------------

const FRESH_BY_ID = new Map(FRESH_TARGETS.map((t) => [t.id, t]));

/** A dataset's name for visitors. */
export const freshName = (id: FreshId): string => FRESH_BY_ID.get(id)?.name ?? id;

/** What a dataset's figure says: "On time", "None waiting", "Moving", "3 min late", "12 s behind", or "No data". */
export function freshValue(i: FreshItem): string {
  if (i.ms === null) return 'No data';
  const measure = FRESH_BY_ID.get(i.id)?.measure ?? 'old';
  const zero = ZERO_TEXT[measure];
  if (i.ms < 1_000 && zero) return zero;
  return `${fmtAge(i.ms)} ${measure}`;
}

/** Under a second of a figure that counts lateness, a wait or a stall: said in words, not "0 s late". */
const ZERO_TEXT: Record<string, string> = { late: 'On time', waiting: 'None waiting', 'without progress': 'Moving' };

/** "Target: at most 2 min late". */
export function freshTarget(i: FreshItem): string {
  const measure = FRESH_BY_ID.get(i.id)?.measure ?? 'old';
  return `Target: at most ${fmtAge(i.budgetMs)} ${measure}`;
}

export const FRESH_STATE_TEXT: Record<FreshState, string> = { ok: 'Within target', behind: 'Behind target', unknown: 'No data' };
