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
  /**
   * How current each of the indexer's datasets is, from the last probe round (FRESH_TARGETS). Absent when that round
   * is older than a few minutes, or the prober is older than this field.
   */
  freshness?: Freshness;
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
 * Bad minutes a day may hold and still show green: the same counts that open an automatic incident (statusAuto.ts AUTO
 * uses these), so a day without an incident does not turn yellow over a one- or two-minute blip (owner 2026-11-16: "0
 * incidents yesterday and the day before ... it still shows yellow"). The hover still lists every minute.
 */
export const DAY_MIN = { down: 3, degraded: 10 } as const;

/**
 * What one day's bar shows. `nodata`: not a minute of it was probed (the status
 * service itself was down, or did not exist yet). `down` when a tenth or more of
 * the probed minutes were down, `partial` for DAY_MIN.down down minutes or more below that,
 * `degraded` for DAY_MIN.degraded bad minutes or more. An incident on the day colours it anyway (dayToneWith).
 */
export function dayTone([, up, deg, down]: DayTuple): DayTone {
  const all = up + deg + down;
  if (!all) return 'nodata';
  if (down / all >= 0.1) return 'down';
  if (down >= DAY_MIN.down) return 'partial';
  if (deg + down >= DAY_MIN.degraded) return 'degraded';
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

/**
 * What a maintenance does to one service while it runs, as the app's notification
 * names it: down (it does not work meanwhile), partial (it works, but paused for a
 * moment or behind), none (not affected).
 */
export const PART_IMPACTS = ['down', 'partial', 'none'] as const;
export type PartImpact = (typeof PART_IMPACTS)[number];

export interface NoticePart {
  id: ServiceId;
  impact: PartImpact;
  /** One line for the visitor: what they notice there (may be empty). */
  text: string;
}

/**
 * How a maintenance was completed, by hand or by a release (deploy/release/ship.sh): `ok` -
 * done, and every part it restarted checked healthy again; `rolled_back` - the update was
 * undone, everything runs as before. Absent: completed by the clock (its window ended), or
 * by a server older than this. Only `ok` is "back to normal" in the app (maintState.ts).
 */
export const OUTCOMES = ['ok', 'rolled_back'] as const;
export type NoticeOutcome = (typeof OUTCOMES)[number];

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
  /** A maintenance: what it does to each service, in the page's order (a release's: ops/shipNotice.ts). Absent: only `components` are known. */
  parts?: NoticePart[];
  /**
   * A maintenance that stays in progress past its planned end until it is completed by
   * hand - a release completes its own when it is done (deploy/release/ship.sh) - and
   * by the clock HOLD_OPEN_MS after the planned end at the latest.
   */
  holdOpen?: boolean;
  /** A maintenance completed by hand or by a release: how (NoticeOutcome). */
  outcome?: NoticeOutcome;
  /**
   * Whose it is: absent - ours (a release, the owner's, the probes'); `sodex` - SoDEX's own
   * maintenance, written by the SoDEX watch (ops/sodexWatch.ts) from SoDEX's maintenance flag
   * or one of its announcements. The app words it as SoDEX's, not ours.
   */
  source?: NoticeSource;
  /** SoDEX's announcement it was read from (https://sodex.com/...), when there is one. */
  link?: string;
}

export const NOTICE_SOURCES = ['sodex'] as const;
export type NoticeSource = (typeof NOTICE_SOURCES)[number];
/** A link a notice may carry: SoDEX's own pages only (it is shown as a link in the app). */
export const isNoticeLink = (v: unknown): v is string => typeof v === 'string' && v.length <= 300 && /^https:\/\/sodex\.com\/[\w\-./?=&%#]*$/.test(v);

export const NOTICE_LIMITS = { title: 120, text: 1000, updates: 50, partText: 200 } as const;
/** How long a held-open maintenance may run past its planned end (ship.sh's maintenance window: maint.sh on 60). */
export const HOLD_OPEN_MS = 60 * 60_000;
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

/** A maintenance's parts, checked one by one, each service once, in the page's order; null when none is one. */
export function parseParts(v: unknown): NoticePart[] | null {
  if (!Array.isArray(v)) return null;
  const byId = new Map<ServiceId, NoticePart>();
  for (const p of v as Array<Partial<NoticePart> | null>) {
    if (!p || !isServiceId(p.id) || !(PART_IMPACTS as readonly unknown[]).includes(p.impact) || byId.has(p.id)) continue;
    byId.set(p.id, { id: p.id, impact: p.impact as PartImpact, text: cleanText(p.text, NOTICE_LIMITS.partText) });
  }
  const out = STATUS_SERVICES.flatMap((s) => (byId.has(s.id) ? [byId.get(s.id)!] : []));
  return out.length ? out : null;
}

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
  const parts = n.kind === 'maintenance' ? parseParts(n.parts) : null;
  return {
    id: n.id, kind: n.kind, title, impact, components, startsAt: n.startsAt, endsAt, closedAt: isTime(n.closedAt) ? n.closedAt : null, updates,
    ...(parts ? { parts } : {}),
    ...(n.kind === 'maintenance' && n.holdOpen === true ? { holdOpen: true } : {}),
    ...(n.kind === 'maintenance' && isTime(n.closedAt) && (OUTCOMES as readonly unknown[]).includes(n.outcome) ? { outcome: n.outcome } : {}),
    ...((NOTICE_SOURCES as readonly unknown[]).includes(n.source) ? { source: n.source as NoticeSource } : {}),
    ...(isNoticeLink(n.link) ? { link: n.link } : {}),
  };
}

/** When a maintenance completes by the clock: its planned end, or - held open - HOLD_OPEN_MS after it. Null for an incident. */
export function clockEnd(n: Notice): number | null {
  if (n.kind !== 'maintenance' || n.endsAt === null) return null;
  return n.holdOpen ? n.endsAt + HOLD_OPEN_MS : n.endsAt;
}

export type NoticePhase = 'active' | 'resolved' | 'upcoming' | 'in_progress' | 'completed';

/** Where a notice stands at `now`. A maintenance runs by its window unless completed by hand (or started early). */
export function noticePhase(n: Notice, now: number): NoticePhase {
  if (n.kind === 'incident') return n.closedAt !== null && n.closedAt <= now ? 'resolved' : 'active';
  if (n.closedAt !== null && n.closedAt <= now) return 'completed';
  const end = clockEnd(n);
  if (end !== null && now >= end) return 'completed';
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
  const end = n.closedAt ?? clockEnd(n) ?? now;
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

/** One notice as /api/health carries it (the app's banner and its maintenance notification). */
export interface HealthNotice {
  id: number;
  kind: NoticeKind;
  title: string;
  impact: Impact | null;
  phase: NoticePhase;
  startsAt: number;
  endsAt: number | null;
  /** The services it touches (absent from an older server). */
  components?: ServiceId[];
  /** A maintenance: when it was completed by hand; null while open (absent from an older server). */
  closedAt?: number | null;
  /** A maintenance's parts (Notice.parts), when it names them. */
  parts?: NoticePart[];
  /** In progress past its planned end until it is completed (Notice.holdOpen). */
  holdOpen?: boolean;
  /** How it was completed (Notice.outcome); absent while open, or completed by the clock. */
  outcome?: NoticeOutcome;
  /** Its latest words, once there is more than the first (what is still affected, how it ended); at most 200 characters. */
  note?: string;
  /** Whose it is (Notice.source): absent ours, `sodex` SoDEX's own maintenance. */
  source?: NoticeSource;
  /** SoDEX's announcement (Notice.link). */
  link?: string;
}

/** How soon an upcoming maintenance is announced in the app. */
export const ANNOUNCE_AHEAD_MS = 24 * 3_600_000;
/**
 * How long a completed maintenance is still listed, after the open ones: a tab that
 * showed it in progress turns its notification green from it.
 */
export const DONE_LISTED_MS = 2 * 3_600_000;
/**
 * A maintenance completed `ok` only after it had run out on the clock (by hand, or folded in by
 * the next release - statusNotices.ts foldOlder) stays listed this long: a browser that showed it
 * amber and was not open in the DONE_LISTED_MS after the late ok still turns it green (#66,
 * 2026-11-02: completed at 15:51, the owner's app still showed "Data API and Indexer partly down" at 20:15).
 */
export const LATE_OK_LISTED_MS = 7 * 86_400_000;

/**
 * What the app shows: open incidents (the worst first), maintenance in progress, then
 * maintenance starting within ANNOUNCE_AHEAD_MS - at most `max` of these - and after
 * them the maintenance completed within DONE_LISTED_MS (at most 3), the latest first, and those
 * completed ok after their clock end within LATE_OK_LISTED_MS (at most 3).
 * The banner reads only the open and upcoming ones (an older app too).
 */
export function healthNotices(notices: readonly Notice[], now: number, max = 3): HealthNotice[] {
  const rank = (n: Notice): number => {
    const p = noticePhase(n, now);
    if (p === 'active') return n.impact === 'critical' ? 0 : n.impact === 'major' ? 1 : 2;
    if (p === 'in_progress') return 3;
    if (p === 'upcoming' && n.startsAt - now <= ANNOUNCE_AHEAD_MS) return 4;
    return -1;
  };
  const doneAt = (n: Notice): number => n.closedAt ?? clockEnd(n) ?? n.startsAt;
  const open = notices
    .map((n) => ({ n, r: rank(n) }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r || a.n.startsAt - b.n.startsAt)
    .slice(0, max)
    .map(({ n }) => n);
  const done = notices
    .filter((n) => n.kind === 'maintenance' && n.startsAt <= now && noticePhase(n, now) === 'completed' && doneAt(n) >= now - DONE_LISTED_MS)
    .sort((a, b) => doneAt(b) - doneAt(a))
    .slice(0, 3);
  const late = notices
    .filter((n) => !done.includes(n) && n.kind === 'maintenance' && n.outcome === 'ok' && n.closedAt !== null && n.closedAt <= now
      && n.closedAt > (clockEnd(n) ?? Infinity) && n.closedAt >= now - LATE_OK_LISTED_MS)
    .sort((a, b) => b.closedAt! - a.closedAt!)
    .slice(0, 3);
  return [...open, ...done, ...late].map((n) => ({
    id: n.id, kind: n.kind, title: n.title, impact: n.impact, phase: noticePhase(n, now), startsAt: n.startsAt, endsAt: n.endsAt,
    components: n.components,
    ...(n.kind === 'maintenance' ? { closedAt: n.closedAt } : {}),
    ...(n.parts ? { parts: n.parts } : {}),
    ...(n.holdOpen ? { holdOpen: true } : {}),
    ...(n.outcome ? { outcome: n.outcome } : {}),
    ...(n.kind === 'maintenance' && n.updates.length > 1 && n.updates.at(-1)!.text ? { note: cleanText(n.updates.at(-1)!.text, 200) } : {}),
    ...(n.source ? { source: n.source } : {}),
    ...(n.link ? { link: n.link } : {}),
  }));
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

// --- what a service's pill says: the public page and the admin suite alike ---------------------

export type Overall = 'operational' | 'degraded' | 'outage' | 'unknown';

/** The headline: every known service up, any degraded, or any down. */
export function overallOf(states: readonly ServiceState[]): Overall {
  const known = states.filter((s) => s !== 'unknown');
  if (!known.length) return 'unknown';
  if (known.includes('down')) return 'outage';
  if (known.includes('degraded')) return 'degraded';
  return 'operational';
}

/** What a service's pill says: the probe's verdict, made worse by an open incident, or maintenance. */
export type ShownState = ServiceState | 'partial' | 'maintenance';

const STATE_RANK: Record<ShownState, number> = { unknown: 0, up: 1, maintenance: 2, degraded: 3, partial: 4, down: 5 };
const IMPACT_STATE: Record<Impact, ShownState> = { minor: 'degraded', major: 'partial', critical: 'down' };

/**
 * A service's state with the owner's notices: an open incident on it is at least its
 * impact (minor degraded, major partial outage, critical down); maintenance in
 * progress shows as maintenance unless an incident is open on it too.
 *
 * The public Status page and the admin suite (dev.valuedesk.so) both judge with this: the dev page
 * once showed the raw probe ("Indexer: Degraded") during a release the public page called
 * maintenance (owner 2026-11-07).
 */
export function shownState(probe: ServiceState, service: ServiceId, notices: readonly Notice[], now: number): ShownState {
  let state: ShownState = probe;
  let incident = false;
  let maintenance = false;
  for (const n of notices) {
    if (!n.components.includes(service) || !noticeLive(n, now)) continue;
    if (n.kind === 'maintenance') maintenance = true;
    else if (n.impact) {
      incident = true;
      const s = IMPACT_STATE[n.impact];
      if (STATE_RANK[s] > STATE_RANK[state]) state = s;
    }
  }
  return maintenance && !incident ? 'maintenance' : state;
}

export type OverallShown = Overall | 'partial' | 'maintenance';

/** The headline over the shown states: a service down outranks one partly down, then degraded, then maintenance. */
export function overallShown(states: readonly ShownState[]): OverallShown {
  if (states.includes('down')) return 'outage';
  if (states.includes('partial')) return 'partial';
  if (states.includes('degraded')) return 'degraded';
  if (states.includes('maintenance')) return 'maintenance';
  return overallOf(states.filter((s): s is ServiceState => s !== 'maintenance' && s !== 'partial'));
}

// --- how current the indexer's data is: targets per dataset ------------------------------------
//
// Production 2026-11-08: incidents fired only once the boards were over an hour old, while the write backlog
// reached 883,699 rows and one liquidation step took 54 minutes with nothing said. Each dataset has a target
// here; past it the indexer is degraded (ops/indexerJudge.ts `fresh:<id>`), past half of it the prober only
// logs it and counts it in the day's tally (ops/status.ts StatusStore.freshDays), never on the public page.

export const FRESH_IDS = ['liqNow', 'liqStep', 'flow', 'writes', 'cohorts', 'boards', 'hl'] as const;
export type FreshId = (typeof FRESH_IDS)[number];

export interface FreshTarget {
  id: FreshId;
  /** The dataset, for visitors. */
  name: string;
  /** What the number is, for visitors. */
  measure: string;
  budgetMs: number;
}

const FRESH_MIN = 60_000;
/**
 * The targets. What each number is (hosted.ts indexerHealth `fresh`, the judge for `hl`):
 *   liqNow   how late the heatmap's levels are past their 2-minute write (cohortTracker.ts LIQ_NOW_MS): its age
 *            minus 2 min. The owner's "60 s old" cannot hold with a write every 2 min by design.
 *   liqStep  how late the liquidation history's 15-minute step is: its mark plus the 2 min until the write it
 *            rides on (recordLiq), to now, while the step is not stored.
 *   flow     the newest trade the trade flow recorded, to now.
 *   writes   how long the oldest row handed to the index's writes has waited (slicedWork.ts oldestWaitMs).
 *   cohorts  how late the cohorts' 15-minute series is: its mark to now, minus the 15 min until the next is due.
 *   boards   the last board build, to now (over an hour stays the hard `boards` reason, ops/status.ts).
 *   hl       how long the Hyperliquid wallet lane has had work queued and finished none (ops/indexerJudge.ts).
 *            No held-end figure is published to judge by; `lane:hl` already calls it degraded at 15 min.
 */
export const FRESH_TARGETS: readonly FreshTarget[] = [
  { id: 'liqNow', name: 'Liquidation heatmap', measure: 'late', budgetMs: FRESH_MIN },
  { id: 'liqStep', name: 'Liquidation history', measure: 'late', budgetMs: 2 * FRESH_MIN },
  { id: 'flow', name: 'Who traded', measure: 'behind', budgetMs: FRESH_MIN },
  { id: 'writes', name: 'Wallet trades saved', measure: 'waiting', budgetMs: 10_000 },
  { id: 'cohorts', name: 'Cohorts', measure: 'late', budgetMs: 5 * FRESH_MIN },
  { id: 'boards', name: 'Leaderboards', measure: 'old', budgetMs: 15 * FRESH_MIN },
  { id: 'hl', name: 'Hyperliquid wallet reads', measure: 'without progress', budgetMs: 30 * FRESH_MIN },
];

/** Past this share of its target a dataset is early-warned: logged and tallied, never shown or alerted. */
export const FRESH_WARN_SHARE = 0.5;

/** ok: within its target; behind: past it; unknown: no figure (an indexer that does not publish it yet, a start). */
export type FreshState = 'ok' | 'behind' | 'unknown';

export interface FreshItem {
  id: FreshId;
  /** The figure (ms), or null when there is none. */
  ms: number | null;
  budgetMs: number;
  state: FreshState;
}

export interface Freshness {
  /** The probe round it is from. */
  at: number;
  items: FreshItem[];
}

export const freshState = (ms: number | null, budgetMs: number): FreshState => (ms === null ? 'unknown' : ms > budgetMs ? 'behind' : 'ok');

/** The page's items from one round's figures, in FRESH_TARGETS order. */
export function freshItems(values: Partial<Record<FreshId, number | null>>): FreshItem[] {
  return FRESH_TARGETS.map(({ id, budgetMs }) => {
    const v = values[id];
    const ms = typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.round(v)) : null;
    return { id, ms, budgetMs, state: freshState(ms, budgetMs) };
  });
}

/** Freshness as GET /api/vs/status sent it, checked field by field; null for anything else. */
export function parseFreshness(v: unknown): Freshness | null {
  const f = v as { at?: unknown; items?: unknown } | null;
  if (!f || typeof f.at !== 'number' || !Array.isArray(f.items)) return null;
  const known = new Set<string>(FRESH_IDS);
  const items = f.items.filter((x): x is FreshItem => {
    const i = x as FreshItem | null;
    return !!i && known.has(i.id) && (i.ms === null || (typeof i.ms === 'number' && Number.isFinite(i.ms)))
      && typeof i.budgetMs === 'number' && (i.state === 'ok' || i.state === 'behind' || i.state === 'unknown');
  });
  return items.length ? { at: f.at, items } : null;
}

/** "8 s", "2 min", "1 h 5 min": a freshness figure as the page writes it. */
export function fmtAge(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m} min`;
  return m % 60 === 0 ? `${m / 60} h` : `${Math.floor(m / 60)} h ${m % 60} min`;
}
