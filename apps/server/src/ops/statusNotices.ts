/**
 * The status page's incidents and scheduled maintenance (statusModel.ts Notice): kept
 * in status.db next to the probes' record (ops/status.ts), posted by the owner with
 * tools/status-post.ts on server 1 (deploy/server/bin/status.sh) or from the owner's
 * Telegram chat (ops/statusTelegram.ts), shown by GET /api/vs/status, its Atom feed
 * and, while one is open, the app's banner (/api/health).
 *
 * Each change is one SQLite transaction (BEGIN IMMEDIATE: read, change, write), so
 * the CLI and the API process can both write without losing either's change, and a
 * crash leaves the notice as it was or as it became - never half of it. Every notice
 * is checked on the way in (statusModel.ts parseNotice: the kinds, stages and services
 * that exist, the text cleaned and cut to NOTICE_LIMITS) and again on the way out.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  NOTICE_LIMITS, NOTICE_SHOW_DAYS, STATUS_SERVICES, cleanText, closingStage, healthNotices, noticePhase, parseNotice, stagesOf,
  type HealthNotice, type Impact, type Notice, type NoticeKind, type NoticeOutcome, type NoticePart, type NoticeStage, type ServiceId,
} from './statusModel.js';

export const NOTICE_SCHEMA = `
CREATE TABLE IF NOT EXISTS notices (
  id INTEGER PRIMARY KEY,
  body TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS status_meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
) WITHOUT ROWID;
`;

const LAST_ID_KEY = 'last_notice_id';

/** A notice the owner asked for that cannot be: the message says why, in words for the owner. */
export class NoticeError extends Error {}

/** How far a time may be from now: a maintenance up to this far ahead, an incident's start this far back. */
const MAX_AHEAD_MS = 180 * 86_400_000;
const MAX_BACK_MS = 7 * 86_400_000;
const MAX_WINDOW_MS = 7 * 86_400_000;

export interface NewNotice {
  kind: NoticeKind;
  title: string;
  components: readonly string[];
  impact?: Impact | null;
  /** An incident: when it began (default now). A maintenance: required. */
  startsAt?: number;
  /** A maintenance: required. */
  endsAt?: number;
  text?: string;
  stage?: NoticeStage;
  /** A maintenance: what it does to each service (statusModel.ts NoticePart). */
  parts?: readonly NoticePart[];
  /** A maintenance: in progress past its end until completed (statusModel.ts Notice.holdOpen). */
  holdOpen?: boolean;
}

/** A part's impact now; its words stay as they were while its impact does (they described the plan), unless given. */
export type PartChange = Pick<NoticePart, 'id' | 'impact'> & { text?: string };

export interface NoticeChange {
  /** A maintenance: what changed for some of its parts (merged into Notice.parts by service). */
  parts?: readonly PartChange[];
  /** A maintenance completed: how (statusModel.ts NoticeOutcome). */
  outcome?: NoticeOutcome;
  stage?: NoticeStage;
  text?: string;
  title?: string;
  impact?: Impact;
  components?: readonly string[];
  startsAt?: number;
  endsAt?: number;
}

/** The services a list names: ids, `all`, comma-separated or not; an unknown name is an error. */
export function componentsOf(list: readonly string[]): ServiceId[] {
  const out = new Set<ServiceId>();
  for (const raw of list.flatMap((s) => s.split(','))) {
    const s = raw.trim().toLowerCase();
    if (!s) continue;
    if (s === 'all') STATUS_SERVICES.forEach((x) => out.add(x.id));
    else {
      const hit = STATUS_SERVICES.find((x) => x.id === s);
      if (!hit) throw new NoticeError(`unknown component "${raw.trim()}" (${STATUS_SERVICES.map((x) => x.id).join(', ')} or all)`);
      out.add(hit.id);
    }
  }
  if (!out.size) throw new NoticeError(`name the affected components: --components=${STATUS_SERVICES.map((x) => x.id).join(',')} (or all)`);
  // In the page's order.
  return STATUS_SERVICES.map((x) => x.id).filter((id) => out.has(id));
}

export class NoticeStore {
  private readonly db: DatabaseSync;
  private readonly own: boolean;

  /** On an open status.db (StatusStore shares its connection), or a path of its own. */
  constructor(db: DatabaseSync | string) {
    if (typeof db === 'string') {
      mkdirSync(dirname(db), { recursive: true });
      this.db = new DatabaseSync(db);
      this.db.exec('PRAGMA busy_timeout = 2000');
      this.db.exec('PRAGMA journal_mode = WAL');
      this.own = true;
    } else {
      this.db = db;
      this.own = false;
    }
    this.db.exec(NOTICE_SCHEMA);
  }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  private write(n: Notice, now: number): Notice {
    const checked = parseNotice(n);
    if (!checked) throw new NoticeError('that notice is not valid');
    this.db.prepare('INSERT INTO notices (id, body, updated_at) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at')
      .run(checked.id, JSON.stringify(checked), now);
    return checked;
  }

  get(id: number): Notice | null {
    const r = this.db.prepare('SELECT body FROM notices WHERE id = ?').get(id) as { body: string } | undefined;
    if (!r) return null;
    try {
      return parseNotice(JSON.parse(r.body));
    } catch {
      return null;
    }
  }

  /** Every notice, newest first (by start). */
  all(): Notice[] {
    const out: Notice[] = [];
    for (const r of this.db.prepare('SELECT body FROM notices').all() as Array<{ body: string }>) {
      try {
        const n = parseNotice(JSON.parse(r.body));
        if (n) out.push(n);
      } catch {
        /* a row that is not a notice is not shown */
      }
    }
    return out.sort((a, b) => b.startsAt - a.startsAt || b.id - a.id);
  }

  /** What the page shows: open and upcoming, and closed within NOTICE_SHOW_DAYS. */
  shown(now: number): Notice[] {
    const since = now - NOTICE_SHOW_DAYS * 86_400_000;
    return this.all().filter((n) => {
      const p = noticePhase(n, now);
      if (p === 'active' || p === 'in_progress' || p === 'upcoming') return true;
      return (n.closedAt ?? n.endsAt ?? n.startsAt) >= since;
    }).slice(0, 100);
  }

  /** Changes to the notices, for the backup export and the caches: their count and last write. */
  version(): string {
    const r = this.db.prepare('SELECT COUNT(*) AS n, COALESCE(MAX(updated_at), 0) AS t FROM notices').get() as { n: number; t: number };
    return `${Number(r.n)}:${Number(r.t)}`;
  }

  create(o: NewNotice, now = Date.now()): Notice {
    const title = cleanText(o.title, NOTICE_LIMITS.title);
    if (!title) throw new NoticeError('a title is needed');
    const components = componentsOf(o.components);
    const text = cleanText(o.text ?? '', NOTICE_LIMITS.text);
    let n: Omit<Notice, 'id'>;
    if (o.kind === 'incident') {
      const startsAt = o.startsAt ?? now;
      if (startsAt > now + 60_000) throw new NoticeError('an incident cannot start in the future (schedule a maintenance instead)');
      if (startsAt < now - MAX_BACK_MS) throw new NoticeError('an incident can be dated back at most 7 days');
      const stage = o.stage ?? 'investigating';
      if (!stagesOf('incident').includes(stage)) throw new NoticeError(`an incident's stage is one of: ${stagesOf('incident').join(', ')}`);
      n = {
        kind: 'incident', title, impact: o.impact ?? 'minor', components, startsAt, endsAt: null,
        closedAt: stage === 'resolved' ? now : null,
        updates: [{ at: now, stage, text: text || 'We are looking into it.' }],
      };
    } else {
      if (o.startsAt === undefined || o.endsAt === undefined) throw new NoticeError('a maintenance needs --start and --end');
      checkWindow(o.startsAt, o.endsAt, now);
      const stage = o.stage ?? (o.startsAt <= now ? 'in_progress' : 'scheduled');
      if (!stagesOf('maintenance').includes(stage)) throw new NoticeError(`a maintenance's stage is one of: ${stagesOf('maintenance').join(', ')}`);
      n = {
        kind: 'maintenance', title, impact: null, components, startsAt: o.startsAt, endsAt: o.endsAt,
        closedAt: stage === 'completed' ? now : null,
        updates: [{ at: now, stage, text }],
        ...(o.parts?.length ? { parts: [...o.parts] } : {}),
        ...(o.holdOpen ? { holdOpen: true } : {}),
      };
    }
    return this.tx(() => {
      // Never a number used before, even one deleted since: a feed reader keeps its entries by it.
      const r = this.db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM notices').get() as { id: number };
      const id = Math.max(Number(r.id), Number(this.getMeta(LAST_ID_KEY) ?? 0) || 0) + 1;
      this.setMeta(LAST_ID_KEY, String(id));
      return this.write({ id, ...n }, now);
    });
  }

  /** A new stage and/or words on the timeline, and/or a corrected title, impact, components or window. */
  update(id: number, c: NoticeChange, now = Date.now()): Notice {
    return this.tx(() => {
      const n = this.get(id);
      if (!n) throw new NoticeError(`there is no notice #${id}`);
      const text = c.text === undefined ? undefined : cleanText(c.text, NOTICE_LIMITS.text);
      if (c.stage !== undefined && !stagesOf(n.kind).includes(c.stage)) {
        throw new NoticeError(`#${id} is ${n.kind === 'incident' ? 'an incident' : 'a maintenance'}: its stages are ${stagesOf(n.kind).join(', ')}`);
      }
      const next: Notice = { ...n, updates: [...n.updates] };
      if (c.title !== undefined) {
        next.title = cleanText(c.title, NOTICE_LIMITS.title);
        if (!next.title) throw new NoticeError('a title cannot be empty');
      }
      if (c.components !== undefined) next.components = componentsOf(c.components);
      if (c.parts !== undefined) {
        if (n.kind !== 'maintenance') throw new NoticeError('only a maintenance has parts');
        const byId = new Map((n.parts ?? []).map((p) => [p.id, p]));
        for (const p of c.parts) {
          const was = byId.get(p.id);
          byId.set(p.id, { id: p.id, impact: p.impact, text: cleanText(p.text ?? (was?.impact === p.impact ? was.text : ''), NOTICE_LIMITS.partText) });
        }
        next.parts = STATUS_SERVICES.flatMap((s) => (byId.has(s.id) ? [byId.get(s.id)!] : []));
      }
      if (c.impact !== undefined) {
        if (n.kind !== 'incident') throw new NoticeError('only an incident has an impact');
        next.impact = c.impact;
      }
      if (c.startsAt !== undefined || c.endsAt !== undefined) {
        if (n.kind === 'incident') {
          if (c.endsAt !== undefined) throw new NoticeError('an incident has no planned end: resolve it');
          if (c.startsAt! > now + 60_000 || c.startsAt! < now - MAX_BACK_MS) throw new NoticeError('an incident starts at most 7 days back and not in the future');
          next.startsAt = c.startsAt!;
        } else {
          next.startsAt = c.startsAt ?? n.startsAt;
          next.endsAt = c.endsAt ?? n.endsAt;
          checkWindow(next.startsAt, next.endsAt!, now, true);
        }
      }
      if (c.stage !== undefined || text) {
        if (next.updates.length >= NOTICE_LIMITS.updates) throw new NoticeError(`#${id} has ${NOTICE_LIMITS.updates} updates already: post a new one`);
        const stage = c.stage ?? n.updates.at(-1)!.stage;
        next.updates.push({ at: now, stage, text: text ?? '' });
        // Closing it closes it; any other stage after that opens it again (and forgets how it was closed).
        next.closedAt = stage === closingStage(n.kind) ? n.closedAt ?? now : null;
        if (next.closedAt === null) delete next.outcome;
      }
      if (c.outcome !== undefined) {
        if (n.kind !== 'maintenance' || next.closedAt === null) throw new NoticeError('an outcome is how a maintenance was completed: resolve it with --outcome');
        next.outcome = c.outcome;
      }
      return this.write(next, now);
    });
  }

  /**
   * Resolve an incident, or complete a maintenance (early, or on time). A maintenance is
   * completed `ok` - done, its parts healthy: the app turns it green - unless `outcome` says
   * otherwise (a release that was rolled back).
   */
  resolve(id: number, text: string | undefined, now = Date.now(), outcome?: NoticeOutcome): Notice {
    const n = this.get(id);
    if (!n) throw new NoticeError(`there is no notice #${id}`);
    const fallback = n.kind === 'incident' ? 'This incident has been resolved.' : outcome === 'rolled_back' ? 'The update was rolled back; everything runs as before.' : 'The maintenance is complete.';
    if (n.kind === 'incident' && outcome !== undefined) throw new NoticeError('an incident is resolved; only a maintenance has an outcome');
    const done = this.update(id, {
      stage: closingStage(n.kind), text: cleanText(text ?? '', NOTICE_LIMITS.text) || fallback,
      ...(n.kind === 'maintenance' ? { outcome: outcome ?? 'ok' } : {}),
    }, now);
    if (done.outcome === 'ok' && done.holdOpen) this.foldOlder(done, now);
    return done;
  }

  /**
   * A release completed `ok` checked its parts healthy, so an older release's notice that
   * was never completed (ship.sh left it open, or it ran out on the clock - the app then
   * keeps an amber "partly down" card) is completed too when every part it left affected
   * is one this release restarted and checked. #66 (v0.2.133, 2026-11-02) stayed so for
   * 14 h while v0.2.134 and v0.2.136 restarted the same parts and closed only their own.
   */
  private foldOlder(by: Notice, now: number): void {
    const affected = (m: Notice): ServiceId[] => (m.parts ? m.parts.filter((p) => p.impact !== 'none').map((p) => p.id) : m.components);
    const checked = new Set(affected(by));
    for (const o of this.all()) {
      if (o.id >= by.id || o.kind !== 'maintenance' || !o.holdOpen || o.closedAt !== null) continue;
      const parts = affected(o);
      if (!parts.length || !parts.every((p) => checked.has(p))) continue;
      try {
        this.update(o.id, { stage: 'completed', text: `Done: everything is back to normal (checked by ${by.title}).`, outcome: 'ok' }, now);
      } catch {
        /* one that cannot take another update stays as it is */
      }
    }
  }

  /** Take a notice off the page entirely (posted by mistake). */
  remove(id: number): boolean {
    return this.tx(() => Number(this.db.prepare('DELETE FROM notices WHERE id = ?').run(id).changes) > 0);
  }

  /**
   * Put notices back from a backup export (status-history.json): only ids that are
   * not here. What is here is never overwritten. How many were added.
   */
  restore(list: readonly unknown[], now = Date.now()): number {
    return this.tx(() => {
      let added = 0;
      const ins = this.db.prepare('INSERT OR IGNORE INTO notices (id, body, updated_at) VALUES (?, ?, ?)');
      for (const v of list) {
        const n = parseNotice(v);
        if (n && Number(ins.run(n.id, JSON.stringify(n), now).changes) > 0) added += 1;
      }
      return added;
    });
  }

  getMeta(k: string): string | null {
    const r = this.db.prepare('SELECT v FROM status_meta WHERE k = ?').get(k) as { v: string } | undefined;
    return r ? r.v : null;
  }

  setMeta(k: string, v: string): void {
    this.db.prepare('INSERT INTO status_meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v').run(k, v);
  }

  close(): void {
    if (this.own) this.db.close();
  }
}

function checkWindow(startsAt: number, endsAt: number, now: number, editing = false): void {
  if (!(endsAt > startsAt)) throw new NoticeError('the end must be after the start');
  if (endsAt - startsAt > MAX_WINDOW_MS) throw new NoticeError('a maintenance window is at most 7 days');
  if (startsAt > now + MAX_AHEAD_MS) throw new NoticeError('a maintenance can be scheduled at most 180 days ahead');
  if (!editing && endsAt <= now) throw new NoticeError('that window is already over');
}

/**
 * The notices for /api/health, read at most every `everyMs` (the app asks every 30 s,
 * per visitor: this keeps it one small read per 30 s for all of them). Never throws:
 * a status.db that cannot be read is no banner.
 */
export function healthNoticeReader(open: () => NoticeStore, o: { everyMs?: number; now?: () => number } = {}): () => HealthNotice[] {
  const everyMs = o.everyMs ?? 30_000;
  const now = o.now ?? Date.now;
  let store: NoticeStore | null = null;
  let cached: { at: number; list: HealthNotice[] } | null = null;
  return () => {
    const t = now();
    if (cached && t - cached.at < everyMs) return cached.list;
    let list: HealthNotice[] = [];
    try {
      store ??= open();
      list = healthNotices(store.shown(t), t);
    } catch {
      list = cached?.list ?? [];
    }
    cached = { at: t, list };
    return list;
  };
}
