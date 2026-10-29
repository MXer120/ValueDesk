/**
 * The maintenance notification's logic (MaintNote.tsx). The owner, 2026-10-29: users see
 * maintenance as a BLUE notification with the expected time; hovering shows which parts
 * are fully down, partly down or not affected, and a countdown to the expected end. It
 * stays until the user clicks it away - that is the only way it goes - and when the
 * update is done and everything is back to normal it turns GREEN with a checkmark. Later the
 * same day: the time is an ESTIMATE ("expected by 14:32", "about 4 min"), past it the card
 * says it takes longer and stays blue; and it turns green ONLY when the server says the
 * maintenance was completed `ok` - by ship.sh after its health checks, or by hand - never on
 * a timer or its end time. A rollback, or a maintenance that ended without that word, is
 * amber (the incident style), with what is still affected; green goes by itself.
 *
 * What it reads: the maintenance on /api/health (the shell polls it every 30 s), which
 * lists maintenance in progress and, for DONE_LISTED_MS after, the completed ones
 * (apps/server/src/ops/statusModel.ts healthNotices). A release posts one with its parts
 * (ship.sh, ops/shipNotice.ts) and completes it when it is done.
 *
 * What it keeps, in this browser (MAINT_KEY): each maintenance it showed in progress,
 * how and when it saw it end, and whether it was clicked away. So a reload keeps the card
 * as it was, one clicked away stays away (in every tab), and a completed maintenance this
 * browser never saw in progress is not shown at all.
 */
import {
  STATUS_SERVICES, isServiceId, parseParts,
  type HealthNotice, type NoticeOutcome, type NoticePart, type PartImpact, type ServiceId,
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
  /** Its latest words from the server (what is still affected, how it ended); null for none. */
  note: string | null;
  /** When this browser first saw it in progress. */
  seenAt: number;
  /** When it ended; null while in progress. */
  doneAt: number | null;
  /**
   * How it ended, as this browser saw it: `ok` completed ok by the server (green), `rolled_back`
   * (amber), `unconfirmed` - a release's maintenance that ended without its word, by the clock
   * (amber) - or `ended`: any other end (a window that ran out, gone from the list), not shown.
   */
  end: MaintEnd | null;
  /** Clicked away: not shown again, in any tab. */
  dismissed: boolean;
}

export type MaintEnd = 'ok' | 'rolled_back' | 'unconfirmed' | 'ended';
const ENDS: readonly MaintEnd[] = ['ok', 'rolled_back', 'unconfirmed', 'ended'];

/** How a completed maintenance ended for the card: green only on the server's `ok`. */
export function endOf(n: { outcome?: NoticeOutcome; closedAt?: number | null; holdOpen?: boolean }, holdOpen: boolean): MaintEnd {
  if (n.outcome === 'ok' && typeof n.closedAt === 'number') return 'ok';
  if (n.outcome === 'rolled_back') return 'rolled_back';
  return holdOpen || n.holdOpen ? 'unconfirmed' : 'ended';
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
      ...(v.outcome === 'ok' || v.outcome === 'rolled_back' ? { outcome: v.outcome } : {}),
      ...(typeof v.note === 'string' && v.note.trim() ? { note: v.note.trim().slice(0, 200) } : {}),
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
      parts: n.parts ?? null, components: n.components ?? [], note: n.note ?? null,
    };
    if (n.phase === 'in_progress') put({ ...facts, seenAt: had?.seenAt ?? now, doneAt: null, end: null, dismissed: had?.dismissed ?? false });
    // Completed - only where it was shown in progress: green on the server's `ok` alone (endOf).
    else if (had && had.end === null) put({ ...had, ...facts, doneAt: n.closedAt ?? now, end: endOf(n, had.holdOpen) });
  }
  // Shown in progress and gone from a complete answer (completed longer ago than it is listed, or
  // taken off): how it ended is not known here, so the card just goes - never green.
  if (openCount(health) < OPEN_LISTED) {
    for (const s of byId.values()) if (s.end === null && !listed.some((n) => n.id === s.id)) put({ ...s, doneAt: now, end: 'ended' });
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

/** What is shown: not clicked away nor ended unseen, the first seen first (two at most). */
export function maintShown(state: MaintState): MaintSeen[] {
  return state.filter((s) => !s.dismissed && s.end !== 'ended').slice(0, 2);
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
      const doneAt = typeof s.doneAt === 'number' ? s.doneAt : null;
      // Kept before `end` existed (v0.2.71-73): ended then meant completed by the server.
      const end = ENDS.includes(s.end as MaintEnd) ? (s.end as MaintEnd) : doneAt !== null ? 'ok' : null;
      return [{
        id: s.id, title: s.title, startsAt: s.startsAt, endsAt: typeof s.endsAt === 'number' ? s.endsAt : null, holdOpen: s.holdOpen === true,
        parts: parseParts(s.parts), components: Array.isArray(s.components) ? s.components.filter(isServiceId) : [],
        note: typeof s.note === 'string' && s.note ? s.note.slice(0, 200) : null,
        seenAt: s.seenAt, doneAt: end === null ? null : doneAt ?? s.seenAt, end, dismissed: s.dismissed === true,
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

/**
 * What is left of the ESTIMATE, as an estimate: "about 4 min", "about 1 h 05 min", "under a
 * minute"; null once the estimate is past - never 0, never negative.
 */
export function leftText(ms: number): string | null {
  if (!(ms > 0)) return null;
  if (ms < 60_000) return 'under a minute';
  const min = Math.ceil(ms / 60_000);
  if (min >= 60) return `about ${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min`;
  return `about ${min} min`;
}

/** "14:32" on the viewer's clock (or `timeZone`'s). */
export function clockOf(ms: number, timeZone?: string): string {
  return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', ...(timeZone ? { timeZone } : {}) }).format(ms);
}

export interface MaintView {
  /** live: blue, in progress; done: green, completed ok; warn: amber - rolled back, or ended unconfirmed. */
  tone: 'live' | 'done' | 'warn';
  title: string;
  /** The line under the title. */
  line: string;
  /** What is left of the estimate ("about 4 min"), while there is any. */
  left: string | null;
  /** The line on hover about the time: the estimate, or when it ended. */
  eta: string | null;
}

/** What the card says at `now`. */
export function maintView(s: MaintSeen, now: number, timeZone?: string): MaintView {
  const at = (ms: number) => {
    const local = clockOf(ms, timeZone);
    const utc = clockOf(ms, 'UTC');
    return local === utc ? `${utc} UTC` : `${local} (${utc} UTC)`;
  };
  const ended = s.doneAt ?? now;
  if (s.end === 'ok') return { tone: 'done', title: 'Maintenance complete', line: 'Everything runs normally again.', left: null, eta: `Completed ${at(ended)}.` };
  if (s.end === 'rolled_back') return { tone: 'warn', title: 'Update rolled back', line: 'Everything runs as before.', left: null, eta: `Rolled back ${at(ended)}.` };
  if (s.end === 'unconfirmed') {
    return { tone: 'warn', title: 'Maintenance ended', line: 'Not confirmed: some parts may not work normally.', left: null, eta: `Ended ${at(ended)} without the word that all is well again.` };
  }
  if (s.endsAt === null) return { tone: 'live', title: 'Maintenance', line: 'In progress', left: null, eta: null };
  const left = leftText(s.endsAt - now);
  return left
    ? { tone: 'live', title: 'Maintenance', line: `Expected by ${clockOf(s.endsAt, timeZone)}`, left, eta: `Expected by ${at(s.endsAt)}, ${left} left - an estimate, not a promise.` }
    : { tone: 'live', title: 'Maintenance', line: 'Taking longer than expected', left: null, eta: `It was expected by ${at(s.endsAt)}; it is taking longer than expected.` };
}
