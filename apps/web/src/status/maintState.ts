/**
 * The maintenance notification's logic (MaintNote.tsx). The owner, 2026-10-29: users see
 * maintenance as a BLUE notification with the expected time; hovering shows which parts
 * are fully down, partly down or not affected, and a countdown to the expected end. It
 * stays until the user clicks it away - that is the only way it goes - and when the
 * update is done and everything is back to normal it turns GREEN with a checkmark.
 *
 * What it reads: the maintenance on /api/health (the shell polls it every 30 s), which
 * lists maintenance in progress and, for DONE_LISTED_MS after, the completed ones
 * (apps/server/src/ops/statusModel.ts healthNotices). A release posts one with its parts
 * (ship.sh, ops/shipNotice.ts) and completes it when it is done.
 *
 * What it keeps, in this browser (MAINT_KEY): each maintenance it showed in progress,
 * when it saw it completed, and whether it was clicked away. So a reload keeps a green
 * one green, one clicked away stays away (in every tab), and a completed maintenance this
 * browser never saw in progress is not shown at all - there is nothing to turn green.
 */
import {
  STATUS_SERVICES, isServiceId, parseParts,
  type HealthNotice, type NoticePart, type PartImpact, type ServiceId,
} from '@sign/ops/statusModel.js';

export const MAINT_KEY = 'vs.maint.v1';
/** At most this many are remembered (one per release): the oldest seen goes first. */
export const MAINT_KEEP = 100;
/** The server lists at most this many open notices (healthNotices max): with fewer, a missing one is not open. */
const OPEN_LISTED = 3;

/** One maintenance as this browser remembers it. */
export interface MaintSeen {
  id: number;
  title: string;
  startsAt: number;
  endsAt: number | null;
  holdOpen: boolean;
  /** What it does to each part; null when it names only the parts it touches (`components`). */
  parts: NoticePart[] | null;
  components: ServiceId[];
  /** When this browser first saw it in progress. */
  seenAt: number;
  /** When it was completed (green from then); null while in progress. */
  doneAt: number | null;
  /** Clicked away: not shown again, in any tab. */
  dismissed: boolean;
}

export type MaintState = MaintSeen[];

/** The maintenance in progress or completed on a /api/health answer, checked one by one. */
export function maintNoticesOf(health: unknown): HealthNotice[] {
  const list = (health as { notices?: unknown } | null | undefined)?.notices;
  if (!Array.isArray(list)) return [];
  const out: HealthNotice[] = [];
  for (const v of list as Array<Partial<HealthNotice> | null>) {
    if (!v || v.kind !== 'maintenance' || typeof v.id !== 'number' || typeof v.title !== 'string' || !v.title) continue;
    if ((v.phase !== 'in_progress' && v.phase !== 'completed') || typeof v.startsAt !== 'number') continue;
    const parts = parseParts(v.parts);
    out.push({
      id: v.id, kind: 'maintenance', title: v.title.slice(0, 120), impact: null, phase: v.phase, startsAt: v.startsAt,
      endsAt: typeof v.endsAt === 'number' ? v.endsAt : null,
      components: Array.isArray(v.components) ? v.components.filter(isServiceId) : [],
      closedAt: typeof v.closedAt === 'number' ? v.closedAt : null,
      ...(parts ? { parts } : {}),
      ...(v.holdOpen === true ? { holdOpen: true } : {}),
    });
  }
  return out;
}

const openCount = (health: unknown): number => {
  const list = (health as { notices?: unknown[] }).notices ?? [];
  return list.filter((n) => ['active', 'upcoming', 'in_progress'].includes(String((n as { phase?: unknown } | null)?.phase))).length;
};

/**
 * One /api/health answer into what this browser remembers; the same array when nothing
 * changed. No answer (null, an error, no notices list): unchanged - the data service
 * being away is not the end of a maintenance.
 */
export function maintStep(prev: MaintState, health: unknown, now: number): MaintState {
  if (!Array.isArray((health as { notices?: unknown } | null | undefined)?.notices)) return prev;
  const listed = maintNoticesOf(health);
  const byId = new Map(prev.map((s) => [s.id, s]));
  let changed = false;
  const put = (s: MaintSeen) => {
    const had = byId.get(s.id);
    if (had && JSON.stringify(had) === JSON.stringify(s)) return;
    byId.set(s.id, s);
    changed = true;
  };
  for (const n of listed) {
    const had = byId.get(n.id);
    const facts = {
      id: n.id, title: n.title, startsAt: n.startsAt, endsAt: n.endsAt, holdOpen: n.holdOpen === true,
      parts: n.parts ?? null, components: n.components ?? [],
    };
    if (n.phase === 'in_progress') put({ ...facts, seenAt: had?.seenAt ?? now, doneAt: null, dismissed: had?.dismissed ?? false });
    // Completed: green - only where it was shown in progress.
    else if (had && had.doneAt === null) put({ ...had, ...facts, doneAt: n.closedAt ?? now });
  }
  // Shown in progress and gone from a complete answer: completed longer ago than it is listed, or taken off.
  if (openCount(health) < OPEN_LISTED) {
    for (const s of byId.values()) if (s.doneAt === null && !listed.some((n) => n.id === s.id)) put({ ...s, doneAt: now });
  }
  if (!changed) return prev;
  return [...byId.values()].sort((a, b) => a.seenAt - b.seenAt || a.id - b.id).slice(-MAINT_KEEP);
}

/** Clicked away. */
export function maintDismiss(prev: MaintState, id: number): MaintState {
  return prev.map((s) => (s.id === id && !s.dismissed ? { ...s, dismissed: true } : s));
}

/** Another tab's dismissals into this one's (the storage event): one click is enough for every tab. */
export function withDismissals(mine: MaintState, theirs: MaintState): MaintState {
  const gone = new Set(theirs.filter((s) => s.dismissed).map((s) => s.id));
  if (!mine.some((s) => gone.has(s.id) && !s.dismissed)) return mine;
  return mine.map((s) => (gone.has(s.id) ? { ...s, dismissed: true } : s));
}

/** What is shown: not clicked away, the first seen first (two at most). */
export function maintShown(state: MaintState): MaintSeen[] {
  return state.filter((s) => !s.dismissed).slice(0, 2);
}

/** The stored state, checked; [] for anything else. */
export function parseMaint(raw: string | null): MaintState {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return [];
    return v.flatMap((x): MaintSeen[] => {
      const s = x as Partial<MaintSeen> | null;
      if (!s || typeof s.id !== 'number' || typeof s.title !== 'string' || typeof s.startsAt !== 'number' || typeof s.seenAt !== 'number') return [];
      return [{
        id: s.id, title: s.title, startsAt: s.startsAt, endsAt: typeof s.endsAt === 'number' ? s.endsAt : null, holdOpen: s.holdOpen === true,
        parts: parseParts(s.parts), components: Array.isArray(s.components) ? s.components.filter(isServiceId) : [],
        seenAt: s.seenAt, doneAt: typeof s.doneAt === 'number' ? s.doneAt : null, dismissed: s.dismissed === true,
      }];
    }).slice(-MAINT_KEEP);
  } catch {
    return [];
  }
}

// --- what it says ---------------------------------------------------------------------------

export type PartShown = PartImpact | 'affected';

export const PART_TEXT: Record<PartShown, string> = { down: 'Down', partial: 'Partly down', none: 'Not affected', affected: 'Affected' };

const NAME = new Map<string, string>(STATUS_SERVICES.map((s) => [s.id, s.name]));

/** The rows on hover: every part a release names (down first, then partly down, then not affected); else the parts it touches. */
export function maintParts(s: MaintSeen): Array<{ id: ServiceId; name: string; impact: PartShown; text: string }> {
  const rank: Record<PartShown, number> = { down: 0, partial: 1, affected: 1, none: 2 };
  const rows = s.parts
    ? s.parts.map((p) => ({ id: p.id, name: NAME.get(p.id) ?? p.id, impact: p.impact as PartShown, text: p.text }))
    : s.components.map((id) => ({ id, name: NAME.get(id) ?? id, impact: 'affected' as PartShown, text: '' }));
  return rows.sort((a, b) => rank[a.impact] - rank[b.impact]);
}

/** "4:05" under an hour, "1 h 05 min" above; null once it is over. */
export function leftText(ms: number): string | null {
  if (!(ms > 0)) return null;
  const sec = Math.ceil(ms / 1000);
  if (sec >= 3600) return `${Math.floor(sec / 3600)} h ${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')} min`;
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

/** "14:32" on the viewer's clock (or `timeZone`'s). */
export function clockOf(ms: number, timeZone?: string): string {
  return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', ...(timeZone ? { timeZone } : {}) }).format(ms);
}

export interface MaintView {
  tone: 'live' | 'done';
  title: string;
  /** The line under the title. */
  line: string;
  /** The countdown, while there is one ("4:05"). */
  left: string | null;
  /** The expected end, or when it was completed: "14:32" and, where the viewer's clock is not UTC, "(13:32 UTC)". */
  when: string | null;
}

/** What the card says at `now`. */
export function maintView(s: MaintSeen, now: number, timeZone?: string): MaintView {
  const at = (ms: number) => {
    const local = clockOf(ms, timeZone);
    const utc = clockOf(ms, 'UTC');
    return local === utc ? `${utc} UTC` : `${local} (${utc} UTC)`;
  };
  if (s.doneAt !== null) {
    return { tone: 'done', title: 'Maintenance complete', line: 'Everything runs normally again.', left: null, when: at(s.doneAt) };
  }
  const left = s.endsAt === null ? null : leftText(s.endsAt - now);
  const line = s.endsAt === null
    ? 'In progress'
    : left
      ? `Back by ${clockOf(s.endsAt, timeZone)}`
      : 'Taking a little longer than planned';
  return { tone: 'live', title: 'Maintenance', line, left, when: s.endsAt === null ? null : at(s.endsAt) };
}
