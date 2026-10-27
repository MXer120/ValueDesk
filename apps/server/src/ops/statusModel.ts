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
  /** Open and upcoming incidents and maintenance, and those closed in the last NOTICE_SHOW_DAYS days; newest first. */
  notices?: Notice[];
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

// --- incidents and maintenance -------------------------------------------------------
//
// What the owner posts (ops/statusNotices.ts keeps them in status.db; tools/status-post.ts
// and Telegram, ops/statusTelegram.ts, post them), the way common status pages do: an
// incident has an impact and a timeline of updates (investigating, identified,
// monitoring, resolved); a maintenance has a planned window and is upcoming, in progress
// or completed by the clock (or completed early by hand). Both name the services they
// touch. Every text is plain text: the page renders it as text, never as markup.

export type NoticeKind = 'incident' | 'maintenance';
export const IMPACTS = ['minor', 'major', 'critical'] as const;
export type Impact = (typeof IMPACTS)[number];
export const INCIDENT_STAGES = ['investigating', 'identified', 'monitoring', 'resolved'] as const;
export const MAINTENANCE_STAGES = ['scheduled', 'in_progress', 'verifying', 'completed'] as const;
export type IncidentStage = (typeof INCIDENT_STAGES)[number];
export type MaintenanceStage = (typeof MAINTENANCE_STAGES)[number];
export type NoticeStage = IncidentStage | MaintenanceStage;

export interface NoticeUpdate {
  at: number;
  stage: NoticeStage;
  /** Plain text; may be empty for a maintenance stage that needs no words. */
  text: string;
}

export interface Notice {
  id: number;
  kind: NoticeKind;
  title: string;
  /** An incident's impact; null for maintenance. */
  impact: Impact | null;
  components: ServiceId[];
  /** An incident: when it began. A maintenance: the planned start. */
  startsAt: number;
  /** A maintenance: the planned end. An incident: null. */
  endsAt: number | null;
  /** Resolved (incident) or completed by hand (maintenance); null while open. */
  closedAt: number | null;
  /** Oldest first. */
  updates: NoticeUpdate[];
}

export const NOTICE_LIMITS = { title: 120, text: 1000, updates: 50 } as const;
/** How long a closed notice stays on the page (and in the report). */
export const NOTICE_SHOW_DAYS = STATUS_DAYS;

export const STAGE_TEXT: Record<NoticeStage, string> = {
  investigating: 'Investigating',
  identified: 'Identified',
  monitoring: 'Monitoring',
  resolved: 'Resolved',
  scheduled: 'Scheduled',
  in_progress: 'In progress',
  verifying: 'Verifying',
  completed: 'Completed',
};

export const IMPACT_TEXT: Record<Impact, string> = { minor: 'Minor', major: 'Major', critical: 'Critical' };

const SERVICE_IDS = new Set<string>(STATUS_SERVICES.map((s) => s.id));
export const isServiceId = (v: unknown): v is ServiceId => typeof v === 'string' && SERVICE_IDS.has(v);
export const stagesOf = (kind: NoticeKind): readonly NoticeStage[] => (kind === 'incident' ? INCIDENT_STAGES : MAINTENANCE_STAGES);
export const closingStage = (kind: NoticeKind): NoticeStage => (kind === 'incident' ? 'resolved' : 'completed');

/**
 * Text as stored and shown: control and direction-override characters out (newlines
 * stay), runs of spaces and blank lines squeezed, trimmed, at most `max` characters.
 */
export function cleanText(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
  const s = v
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/[ \u00a0]{2,}/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 1_500_000_000_000 && v < 4_000_000_000_000;

/** A notice read from storage or the network, checked field by field; null when it is not one. */
export function parseNotice(v: unknown): Notice | null {
  const n = v as Partial<Notice> | null;
  if (!n || typeof n !== 'object') return null;
  if (typeof n.id !== 'number' || !Number.isSafeInteger(n.id) || n.id <= 0) return null;
  if (n.kind !== 'incident' && n.kind !== 'maintenance') return null;
  const title = cleanText(n.title, NOTICE_LIMITS.title);
  if (!title || !isTime(n.startsAt)) return null;
  const impact = n.kind === 'incident' && (IMPACTS as readonly unknown[]).includes(n.impact) ? (n.impact as Impact) : null;
  if (n.kind === 'incident' && !impact) return null;
  const components = Array.isArray(n.components) ? [...new Set(n.components.filter(isServiceId))] : [];
  if (!components.length) return null;
  const endsAt = n.kind === 'maintenance' && isTime(n.endsAt) ? n.endsAt : null;
  if (n.kind === 'maintenance' && (endsAt === null || endsAt <= n.startsAt)) return null;
  const stages = stagesOf(n.kind);
  const updates: NoticeUpdate[] = [];
  for (const u of Array.isArray(n.updates) ? n.updates.slice(-NOTICE_LIMITS.updates) : []) {
    if (!u || !isTime(u.at) || !stages.includes(u.stage)) continue;
    updates.push({ at: u.at, stage: u.stage, text: cleanText(u.text, NOTICE_LIMITS.text) });
  }
  if (!updates.length) return null;
  return { id: n.id, kind: n.kind, title, impact, components, startsAt: n.startsAt, endsAt, closedAt: isTime(n.closedAt) ? n.closedAt : null, updates };
}

export type NoticePhase = 'active' | 'resolved' | 'upcoming' | 'in_progress' | 'completed';

/** Where a notice stands at `now`. A maintenance runs by its window unless completed by hand (or started early). */
export function noticePhase(n: Notice, now: number): NoticePhase {
  if (n.kind === 'incident') return n.closedAt !== null && n.closedAt <= now ? 'resolved' : 'active';
  if (n.closedAt !== null && n.closedAt <= now) return 'completed';
  if (n.endsAt !== null && now >= n.endsAt) return 'completed';
  if (now >= n.startsAt) return 'in_progress';
  const last = n.updates.at(-1)?.stage;
  return last === 'in_progress' || last === 'verifying' ? 'in_progress' : 'upcoming';
}

/** Open now: an incident not resolved, a maintenance in progress. */
export const noticeLive = (n: Notice, now: number): boolean => {
  const p = noticePhase(n, now);
  return p === 'active' || p === 'in_progress';
};

/** The time a notice covers: [from, to], `to` being `now` while it is open. A maintenance started early counts from then. */
export function noticeSpan(n: Notice, now: number): [number, number] {
  let from = n.startsAt;
  if (n.kind === 'maintenance') {
    const early = n.updates.find((u) => u.stage === 'in_progress' || u.stage === 'verifying');
    if (early && early.at < from) from = early.at;
  }
  const end = n.closedAt ?? n.endsAt ?? now;
  return [from, Math.max(from, Math.min(end, now))];
}

/** The notices that touched `service` on the UTC `day` and had begun by `now`, oldest first. */
export function noticesOnDay(notices: readonly Notice[], service: ServiceId, day: string, now: number): Notice[] {
  const start = Date.parse(`${day}T00:00:00Z`);
  const end = start + 86_400_000;
  return notices
    .filter((n) => n.components.includes(service))
    .filter((n) => {
      const [from, to] = noticeSpan(n, now);
      return from <= now && from < end && to >= start;
    })
    .sort((a, b) => a.startsAt - b.startsAt || a.id - b.id);
}

export type DayToneShown = DayTone | 'maintenance';

const TONE_RANK: Record<DayTone, number> = { nodata: 0, up: 1, degraded: 2, partial: 3, down: 4 };
const IMPACT_TONE: Record<Impact, DayTone> = { minor: 'degraded', major: 'partial', critical: 'down' };

/**
 * A day bar's colour with that day's notices: an incident makes the day at least as
 * bad as its impact (minor degraded, major partly down, critical down); a day with
 * maintenance and no incident is a maintenance day, whatever the probes saw.
 */
export function dayToneWith(d: DayTuple, onDay: readonly Notice[]): DayToneShown {
  let tone = dayTone(d);
  let incident = false;
  for (const n of onDay) {
    if (n.kind !== 'incident' || !n.impact) continue;
    incident = true;
    const t = IMPACT_TONE[n.impact];
    if (TONE_RANK[t] > TONE_RANK[tone]) tone = t;
  }
  if (!incident && onDay.some((n) => n.kind === 'maintenance')) return 'maintenance';
  return tone;
}

/** One open notice as /api/health carries it (the app's one-line banner). */
export interface HealthNotice {
  id: number;
  kind: NoticeKind;
  title: string;
  impact: Impact | null;
  phase: NoticePhase;
  startsAt: number;
  endsAt: number | null;
}

/** How soon an upcoming maintenance is announced in the app. */
export const ANNOUNCE_AHEAD_MS = 24 * 3_600_000;

/**
 * What the app's banner shows: open incidents (the worst first), maintenance in
 * progress, then maintenance starting within ANNOUNCE_AHEAD_MS; at most `max`.
 */
export function healthNotices(notices: readonly Notice[], now: number, max = 3): HealthNotice[] {
  const rank = (n: Notice): number => {
    const p = noticePhase(n, now);
    if (p === 'active') return n.impact === 'critical' ? 0 : n.impact === 'major' ? 1 : 2;
    if (p === 'in_progress') return 3;
    if (p === 'upcoming' && n.startsAt - now <= ANNOUNCE_AHEAD_MS) return 4;
    return -1;
  };
  return notices
    .map((n) => ({ n, r: rank(n) }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r || a.n.startsAt - b.n.startsAt)
    .slice(0, max)
    .map(({ n }) => ({ id: n.id, kind: n.kind, title: n.title, impact: n.impact, phase: noticePhase(n, now), startsAt: n.startsAt, endsAt: n.endsAt }));
}

// --- times, as the page, the feed and the owner's commands write them (always UTC) ---

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number): string => String(n).padStart(2, '0');

/** "27 Oct 14:02 UTC". */
export function fmtUtc(ms: number, o: { date?: boolean } = {}): string {
  const d = new Date(ms);
  const clock = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  return o.date === false ? `${clock} UTC` : `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${clock} UTC`;
}

const sameDay = (a: number, b: number): boolean => new Date(a).toISOString().slice(0, 10) === new Date(b).toISOString().slice(0, 10);

/** "28 Oct 02:00 – 03:00 UTC", or both dates when it spans midnight. */
export function fmtWindow(from: number, to: number): string {
  return `${fmtUtc(from).replace(/ UTC$/, '')} – ${sameDay(from, to) ? fmtUtc(to, { date: false }) : fmtUtc(to)}`;
}
