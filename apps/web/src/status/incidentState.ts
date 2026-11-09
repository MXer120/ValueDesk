/**
 * The incident notification's logic (IncidentNote.tsx): which open incidents /api/health
 * carries, what each card says, and which ones this browser has clicked away.
 *
 * An incident shows while it is open and goes when the server no longer lists it
 * (resolved), as the bar it replaces did (owner, 2026-10-29: "this shouldnt be a bar but a
 * normal notification"). Clicked away, it stays away - unless it gets worse (minor to
 * major, major to critical): that is news again. The data service not answering at all is
 * a card of its own, from this tab's polls (SiteNoticeBanner.tsx useHealthDown).
 */
import { fmtUtc, healthNoticesOf, incidentTitle, type HealthNotice } from './statusData';
import { STATUS_SERVICES, type ServiceId } from '@sign/ops/statusModel.js';
import { clockOf } from './maintState';

/** What this browser remembers: the incidents clicked away, as incidentKey()s. */
export const INCIDENT_KEY = 'vs.incident.v1';
const MAX_KEPT = 20;

export const incidentsOf = (health: unknown): HealthNotice[] => healthNoticesOf(health).filter((n) => n.kind === 'incident');

/** One incident at one impact: a worse impact is a new key, so it shows again. */
export const incidentKey = (n: Pick<HealthNotice, 'id' | 'impact'>): string => `${n.id}:${n.impact ?? 'minor'}`;

export function parseDismissed(raw: string | null): string[] {
  try {
    const v = JSON.parse(raw ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((k): k is string => typeof k === 'string' && /^\d+:(minor|major|critical)$/.test(k)).slice(-MAX_KEPT) : [];
  } catch {
    return [];
  }
}

/** Clicked away: remembered (the newest MAX_KEPT). */
export const dismissIncident = (d: readonly string[], key: string): string[] => (d.includes(key) ? [...d] : [...d, key].slice(-MAX_KEPT));

/**
 * The clicked-away keys still worth keeping: those of incidents the server still lists.
 * Only from an answer that carries a list - a failed poll forgets nothing.
 */
export function pruneDismissed(d: readonly string[], health: unknown): readonly string[] {
  if (!Array.isArray((health as { notices?: unknown } | null | undefined)?.notices)) return d;
  const ids = new Set(incidentsOf(health).map((n) => String(n.id)));
  const kept = d.filter((k) => ids.has(k.split(':')[0]!));
  return kept.length === d.length ? d : kept;
}

/** The cards to show: open incidents not clicked away, worst first. */
export function incidentsShown(health: unknown, dismissed: readonly string[]): HealthNotice[] {
  const rank = { critical: 0, major: 1, minor: 2 } as const;
  return incidentsOf(health)
    .filter((n) => !dismissed.includes(incidentKey(n)))
    .sort((a, b) => rank[a.impact ?? 'minor'] - rank[b.impact ?? 'minor'] || b.startsAt - a.startsAt);
}

export type IncidentTone = 'warn' | 'down';

export interface IncidentView {
  tone: IncidentTone;
  /** "Minor incident", "Outage". */
  title: string;
  /** The incident's own title. */
  line: string;
  /** "Since 21:00 (22:00 local)": when it started. */
  since: string;
  /** What each service it touches goes through. */
  rows: Array<{ id: ServiceId; name: string; state: string; impact: 'partial' | 'down' }>;
  /** Its latest words, when there is more than the first. */
  note: string | null;
}

const NAME = new Map<string, string>(STATUS_SERVICES.map((s) => [s.id, s.name]));
/** A service under an incident of this impact (statusData.ts IMPACT_STATE: minor degraded, major partial outage, critical down). */
const STATE_OF = { minor: 'Degraded', major: 'Partly down', critical: 'Down' } as const;

export function incidentView(n: HealthNotice, timeZone?: string): IncidentView {
  const impact = n.impact ?? 'minor';
  const local = clockOf(n.startsAt, timeZone);
  const utc = fmtUtc(n.startsAt);
  const utcClock = clockOf(n.startsAt, 'UTC');
  return {
    tone: impact === 'critical' ? 'down' : 'warn',
    title: incidentTitle(impact),
    line: n.title.length > 120 ? `${n.title.slice(0, 119)}…` : n.title,
    since: local === utcClock ? `Since ${utc}` : `Since ${utc} (${local} your time)`,
    rows: (n.components ?? []).map((id) => ({ id, name: NAME.get(id) ?? id, state: STATE_OF[impact], impact: impact === 'critical' ? 'down' : 'partial' })),
    note: typeof n.note === 'string' && n.note ? n.note : null,
  };
}

/** The card for /api/health itself not answering (no notice can reach the app then). */
export const DOWN_VIEW: IncidentView = {
  tone: 'down',
  title: 'Data service not answering',
  line: 'Prices, positions and other figures may be out of date.',
  since: '',
  rows: [],
  note: null,
};
