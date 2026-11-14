/**
 * SoDEX's own maintenance, as a notice on our status page and in the app (owner 2026-11-11:
 * "ensure our whole product handles that as good as possible + automatically alerts users
 * when sodex announces it on their site").
 *
 * Two sources, both SoDEX's own and both public:
 *  - the flag its trade page reads: GET {BIZ}/biz/v1/maintenance/status ->
 *    {code:0, data:{status:'NORMAL'|'ALL_MAINTENANCE'|'CHAIN_MAINTENANCE', maintenanceDuration:<hours>,
 *    updateTime:<unix s>}} (sodex.com's bundle maps ALL_ and CHAIN_MAINTENANCE to its maintenance
 *    screen, anything else to normal). On 2026-11-11 16:19 UTC it read CHAIN_MAINTENANCE, 1 hour,
 *    while the gateway answered HTTP 503 everywhere.
 *  - its announcements (GET {BIZ}/biz/announcements, .../detail/{id}): a maintenance is announced
 *    days ahead with the window in the text ("October 19, 2026, 15:00 UTC – October 19, 2026,
 *    21:00 UTC", "from 10:00 to 12:00 (UTC) on January 29, 2026").
 *
 * What it writes (statusNotices.ts, source 'sodex'):
 *  - an announced window becomes a scheduled maintenance once (the app announces it ANNOUNCE_AHEAD_MS
 *    ahead, statusModel.ts), with the announcement's link;
 *  - the flag off NORMAL twice in a row opens one in progress (or takes the announced one that is due),
 *    kept open past its estimate while the flag says so; NORMAL twice in a row completes it `ok`.
 * A reading that fails is no information: nothing opens or closes on it. Never `holdOpen`: a release's
 * ok must not fold SoDEX's notice (statusNotices.ts foldOlder), and its end is moved on instead.
 * The notice covers website/executor/indexer, so the probes' automatic incidents do not blame our
 * executor for SoDEX's maintenance (statusAuto.ts covered()).
 */
import type { NoticeStore } from './statusNotices.js';
import { noticePhase, type Notice, type NoticePart } from './statusModel.js';

export const SODEX_BIZ = process.env.SODEX_BIZ_API?.trim() || 'https://alpha-biz.sodex.dev';
const STATE_KEY = 'sodex_watch';
/** Readings in a row before it opens or closes (one per probe round, a minute apart). */
export const STREAK = 2;
/** How often the announcements are read. */
export const ANNOUNCE_EVERY_MS = 10 * 60_000;
/** Announcements older than this are not read for a window. */
const ANNOUNCE_MAX_AGE_MS = 21 * 86_400_000;
/** A window further ahead than this is not posted (statusNotices.ts allows 180 days; SoDEX posts days ahead). */
const ANNOUNCE_MAX_AHEAD_MS = 60 * 86_400_000;
/** An open one always ends at least this far ahead while SoDEX still says maintenance. */
const MIN_AHEAD_MS = 15 * 60_000;
/** An announced window counts as the one now running when it starts within this of the flag. */
const ANNOUNCED_NEAR_MS = 3 * 3_600_000;
const TIMEOUT_MS = 8_000;

export type FlagReading =
  | { kind: 'normal' }
  | { kind: 'maintenance'; status: string; hours: number | null; updatedAt: number | null }
  | { kind: 'unknown'; why: string };

/** SoDEX's flag, read as its own site reads it; anything else is no information. */
export function readFlag(body: unknown): FlagReading {
  const b = body as { code?: unknown; data?: { status?: unknown; maintenanceDuration?: unknown; updateTime?: unknown } } | null;
  if (!b || typeof b !== 'object' || b.code !== 0 || !b.data || typeof b.data !== 'object') return { kind: 'unknown', why: 'not an answer' };
  const status = typeof b.data.status === 'string' ? b.data.status.toUpperCase() : '';
  if (status === 'NORMAL') return { kind: 'normal' };
  if (status !== 'ALL_MAINTENANCE' && status !== 'CHAIN_MAINTENANCE') return { kind: 'unknown', why: `status ${status || 'missing'}` };
  const h = b.data.maintenanceDuration;
  const u = b.data.updateTime;
  return {
    kind: 'maintenance', status,
    hours: typeof h === 'number' && Number.isFinite(h) && h > 0 && h <= 168 ? h : null,
    updatedAt: typeof u === 'number' && Number.isFinite(u) && u > 1_500_000_000 && u < 4_000_000_000 ? u * 1000 : null,
  };
}

// --- announcements -------------------------------------------------------------------------

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MON = '(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\.?';
const TIME = '(\\d{1,2}):(\\d{2})';
const ZONE = '\\(?\\s*UTC\\s*([+-]\\s*\\d{1,2})?\\s*\\)?';
const DASH = '\\s*(?:[–—-]|to|until)\\s*';

const month = (m: string | undefined): number => m === undefined ? NaN : MONTHS.indexOf(m.slice(0, 3).toLowerCase());
const at = (y: number, mo: number, d: number, h: number, mi: number, off: number): number => Date.UTC(y, mo, d, h - off, mi);
const offOf = (z: string | undefined): number => (z ? Number(z.replace(/\s/g, '')) : 0);

/** Plain text of an announcement's HTML body. */
export function plainText(html: string): string {
  return html
    .replace(/<(br|\/p|\/div|\/li|\/h\d)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&ndash;/g, '–').replace(/&mdash;/g, '—')
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim();
}

/**
 * The maintenance window an announcement names, in UTC ms; null when it names none this reads.
 * The forms SoDEX has used: "October 19, 2026, 15:00 UTC – October 19, 2026, 21:00 UTC",
 * "from 10:00 to 12:00 (UTC) on January 29, 2026", "Nov 12, 2026 08:00 – 10:00 (UTC+8)".
 */
export function parseWindow(text: string): { start: number; end: number } | null {
  const t = text.replace(/\s+/g, ' ');
  const sane = (start: number, end: number): { start: number; end: number } | null => {
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    if (end <= start) end += 86_400_000;
    return end > start && end - start <= 7 * 86_400_000 ? { start, end } : null;
  };
  // Both ends dated, or the second end only a time: "Month D, YYYY, HH:MM [UTC] – [Month D, YYYY,] HH:MM UTC[+h]".
  let m = new RegExp(`${MON} (\\d{1,2}),? (\\d{4}),? (?:at )?${TIME}(?: ?${ZONE})?${DASH}(?:${MON} (\\d{1,2}),? (\\d{4}),? (?:at )?)?${TIME} ?${ZONE}`, 'i').exec(t);
  if (m) {
    const off = offOf(m[12] ?? m[6]);
    const y = Number(m[3]);
    const start = at(y, month(m[1]), Number(m[2]), Number(m[4]), Number(m[5]), off);
    const end = m[7]
      ? at(Number(m[9]), month(m[7]), Number(m[8]), Number(m[10]), Number(m[11]), off)
      : at(y, month(m[1]), Number(m[2]), Number(m[10]), Number(m[11]), off);
    return sane(start, end);
  }
  // "from HH:MM to HH:MM (UTC) on Month D, YYYY".
  m = new RegExp(`${TIME}${DASH}${TIME} ?${ZONE},? on ${MON} (\\d{1,2}),? (\\d{4})`, 'i').exec(t);
  if (m) {
    const off = offOf(m[5]);
    const mo = month(m[6]);
    const d = Number(m[7]);
    const y = Number(m[8]);
    return sane(at(y, mo, d, Number(m[1]), Number(m[2]), off), at(y, mo, d, Number(m[3]), Number(m[4]), off));
  }
  // ISO dates: "2026-11-12 08:00 – 2026-11-12 10:00 UTC" or "2026-11-12 08:00 – 10:00 UTC".
  m = new RegExp(`(\\d{4})-(\\d{2})-(\\d{2}),? ${TIME}(?: ?${ZONE})?${DASH}(?:(\\d{4})-(\\d{2})-(\\d{2}),? )?${TIME} ?${ZONE}`, 'i').exec(t);
  if (m) {
    const off = offOf(m[12] ?? m[6]);
    const start = at(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), off);
    const end = m[7]
      ? at(Number(m[7]), Number(m[8]) - 1, Number(m[9]), Number(m[10]), Number(m[11]), off)
      : at(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[10]), Number(m[11]), off);
    return sane(start, end);
  }
  return null;
}

/** Whether an announcement is about a maintenance or downtime at all (its title). */
export const isMaintenanceTitle = (title: string): boolean => /maint[ae]n|upgrade|downtime|suspen/i.test(title);

export type Scope = 'wealth' | 'funds' | 'trading';

/** What it stops: SoDEX Wealth only, deposits and withdrawals only, or trading. */
export function scopeOf(title: string, text: string): Scope {
  if (/wealth/i.test(title)) return 'wealth';
  if (/deposit|withdraw/i.test(title)) return 'funds';
  // A body that says trading is unaffected names a narrower thing.
  if (/trading[^.]{0,80}(remain|stay|will be)[^.]{0,20}(unaffected|available|normal)/i.test(text)) return /wealth/i.test(text) ? 'wealth' : 'funds';
  return 'trading';
}

export function partsOf(scope: Scope): { components: Array<'website' | 'executor' | 'indexer'>; parts: NoticePart[] } {
  if (scope === 'wealth') {
    return { components: ['website'], parts: [{ id: 'website', impact: 'partial', text: 'SoDEX Wealth (savings) pauses on SoDEX. Trading works as usual.' }] };
  }
  if (scope === 'funds') {
    return { components: ['website'], parts: [{ id: 'website', impact: 'partial', text: 'Deposits and withdrawals pause on SoDEX. Trading works as usual.' }] };
  }
  return {
    components: ['website', 'executor', 'indexer'],
    parts: [
      { id: 'website', impact: 'partial', text: 'Orders, deposits and withdrawals pause on SoDEX. Your funds stay in your SoDEX account.' },
      { id: 'executor', impact: 'partial', text: 'Copies, algos and bots wait, and pick up again when SoDEX is back.' },
      { id: 'indexer', impact: 'partial', text: 'SoDEX data pauses; boards and charts catch up after.' },
    ],
  };
}

export const announcementLink = (id: number): string => `https://sodex.com/announcement?id=${id}`;

// --- the watch -------------------------------------------------------------------------------

interface State {
  /** The open notice the flag holds (null: none). */
  live: number | null;
  bad: number;
  ok: number;
  /** The flag left maintenance while the owner had closed ours by hand: no new one until NORMAL. */
  quiet: boolean;
  /** Announcements read: id -> the notice made of it (0: none - no window, past, not maintenance). */
  ann: Record<string, number>;
  annAt: number;
}

const fresh = (): State => ({ live: null, bad: 0, ok: 0, quiet: false, ann: {}, annAt: 0 });

export interface WatchLog {
  warn(o: object, msg: string): void;
  info?(o: object, msg: string): void;
}

type Fetch = typeof fetch;

async function getJson(f: Fetch, url: string): Promise<unknown> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await f(url, { signal: ctl.signal, headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

export class SodexWatch {
  constructor(
    private readonly notices: NoticeStore,
    private readonly o: { fetch?: Fetch; log?: WatchLog; biz?: string } = {},
  ) {}

  private load(): State {
    try {
      return { ...fresh(), ...(JSON.parse(this.notices.getMeta(STATE_KEY) ?? '{}') as Partial<State>) };
    } catch {
      return fresh();
    }
  }

  private save(s: State): void {
    // Keep the last 200 announcements read.
    const ids = Object.keys(s.ann).map(Number).sort((a, b) => b - a);
    if (ids.length > 200) for (const id of ids.slice(200)) delete s.ann[String(id)];
    this.notices.setMeta(STATE_KEY, JSON.stringify(s));
  }

  /** One round: the flag every time, the announcements every ANNOUNCE_EVERY_MS. Never throws. */
  async step(now = Date.now()): Promise<void> {
    const f = this.o.fetch ?? fetch;
    const biz = this.o.biz ?? SODEX_BIZ;
    const s = this.load();
    if (now - s.annAt >= ANNOUNCE_EVERY_MS) {
      try {
        await this.readAnnouncements(s, f, biz, now);
        s.annAt = now;
      } catch (e) {
        this.o.log?.warn({ err: e instanceof Error ? e.message : String(e) }, 'sodex watch: the announcements could not be read');
      }
    }
    let reading: FlagReading;
    try {
      reading = readFlag(await getJson(f, `${biz}/biz/v1/maintenance/status`));
    } catch (e) {
      reading = { kind: 'unknown', why: e instanceof Error ? e.message : String(e) };
    }
    try {
      this.apply(s, reading, now);
    } catch (e) {
      this.o.log?.warn({ err: e instanceof Error ? e.message : String(e) }, 'sodex watch: the notice could not be written');
    }
    this.save(s);
  }

  /** The flag's reading against the notices. */
  private apply(s: State, r: FlagReading, now: number): void {
    // Closed by hand meanwhile (the owner's status.sh): leave it closed until SoDEX is NORMAL again.
    if (s.live !== null) {
      const n = this.notices.get(s.live);
      if (!n || n.closedAt !== null) {
        s.live = null;
        s.quiet = true;
      }
    }
    if (r.kind === 'unknown') return;
    if (r.kind === 'normal') {
      s.bad = 0;
      s.ok += 1;
      if (s.ok < STREAK) return;
      s.quiet = false;
      if (s.live !== null) {
        this.notices.update(s.live, { stage: 'completed', outcome: 'ok', text: 'SoDEX is back. Trading works as usual again; copies, algos and bots pick up where they waited.' }, now);
        this.o.log?.info?.({ id: s.live }, 'sodex watch: SoDEX maintenance over');
        s.live = null;
      }
      return;
    }
    s.ok = 0;
    s.bad += 1;
    if (s.bad < STREAK || s.quiet) return;
    const estimate = r.hours !== null ? (r.updatedAt ?? now) + r.hours * 3_600_000 : null;
    const endBy = Math.max(estimate ?? 0, now + MIN_AHEAD_MS);
    const word = r.status === 'CHAIN_MAINTENANCE' ? 'network upgrade' : 'maintenance';
    if (s.live === null) {
      const due = this.dueAnnounced(s, now);
      if (due) {
        this.notices.update(due.id, {
          stage: 'in_progress', startsAt: Math.min(due.startsAt, now), endsAt: Math.max(due.endsAt ?? 0, endBy),
          text: `SoDEX's ${word} has started.${r.hours !== null ? ` SoDEX expects it to take about ${fmtHours(r.hours)}.` : ''}`,
        }, now);
        s.live = due.id;
      } else {
        const { components, parts } = partsOf('trading');
        const startsAt = Math.min(now, Math.max(r.updatedAt ?? now, now - 6 * 3_600_000));
        const n = this.notices.create({
          kind: 'maintenance', source: 'sodex', title: `SoDEX ${word}`, components, parts,
          startsAt, endsAt: Math.max(endBy, startsAt + MIN_AHEAD_MS), stage: 'in_progress',
          text: `SoDEX is in ${word} (SoDEX's own, not ValueDesk's).${r.hours !== null ? ` SoDEX expects it to take about ${fmtHours(r.hours)}.` : ''} Orders on SoDEX pause meanwhile; your funds stay in your SoDEX account.`,
        }, now);
        s.live = n.id;
      }
      this.o.log?.info?.({ id: s.live, status: r.status, hours: r.hours }, 'sodex watch: SoDEX maintenance');
      return;
    }
    // Still in it: its end moves on with SoDEX's estimate, never into the past.
    const n = this.notices.get(s.live);
    if (n && n.endsAt !== null && Math.abs(n.endsAt - endBy) > 60_000 && (endBy > n.endsAt || (estimate !== null && n.endsAt - now > MIN_AHEAD_MS))) {
      this.notices.update(s.live, { endsAt: Math.max(endBy, n.startsAt + 60_000) }, now);
    }
  }

  /** An announced trading maintenance of SoDEX's that is due now (not closed, starts within ANNOUNCED_NEAR_MS). */
  private dueAnnounced(s: State, now: number): Notice | null {
    const mine = new Set(Object.values(s.ann));
    return this.notices.all().find((n) => n.source === 'sodex' && mine.has(n.id) && n.closedAt === null && n.kind === 'maintenance'
      && n.components.includes('executor') && Math.abs(n.startsAt - now) <= ANNOUNCED_NEAR_MS && noticePhase(n, now) !== 'completed') ?? null;
  }

  private async readAnnouncements(s: State, f: Fetch, biz: string, now: number): Promise<void> {
    const list = (await getJson(f, `${biz}/biz/announcements?page=1&size=20&lang=en`)) as { code?: number; data?: { articles?: Array<{ id?: unknown; title?: unknown; createdAt?: unknown }> } };
    if (list?.code !== 0 || !Array.isArray(list.data?.articles)) throw new Error('not an announcements list');
    for (const a of list.data!.articles!) {
      const id = typeof a.id === 'number' && Number.isSafeInteger(a.id) ? a.id : null;
      const title = typeof a.title === 'string' ? a.title : '';
      const created = typeof a.createdAt === 'number' ? a.createdAt * 1000 : 0;
      if (id === null || String(id) in s.ann) continue;
      if (!isMaintenanceTitle(title) || now - created > ANNOUNCE_MAX_AGE_MS) {
        s.ann[String(id)] = 0;
        continue;
      }
      const d = (await getJson(f, `${biz}/biz/announcements/detail/${id}?lang=en`)) as { code?: number; data?: { body?: unknown } };
      if (d?.code !== 0 || typeof d.data?.body !== 'string') continue; // read again next round
      const text = plainText(d.data.body);
      const w = parseWindow(text);
      if (!w || w.end <= now || w.start - now > ANNOUNCE_MAX_AHEAD_MS) {
        this.o.log?.warn({ id, title, window: w }, w ? 'sodex watch: an announced maintenance is past or far ahead' : 'sodex watch: an announced maintenance names no window this reads');
        s.ann[String(id)] = 0;
        continue;
      }
      const scope = scopeOf(title, text);
      const { components, parts } = partsOf(scope);
      const n = this.notices.create({
        kind: 'maintenance', source: 'sodex', link: announcementLink(id), title: title.slice(0, 120), components, parts,
        startsAt: Math.max(w.start, now - 6 * 86_400_000), endsAt: w.end,
        text: `Announced by SoDEX (SoDEX's own maintenance, not ValueDesk's).${scope === 'trading' ? ' Copies, algos and bots wait meanwhile and pick up again after.' : ''}`,
      }, now);
      s.ann[String(id)] = n.id;
      this.o.log?.info?.({ id, notice: n.id, scope, start: new Date(w.start).toISOString(), end: new Date(w.end).toISOString() }, 'sodex watch: SoDEX announced a maintenance');
    }
  }
}

export function fmtHours(h: number): string {
  if (h < 1) return `${Math.round(h * 60)} minutes`;
  return h === 1 ? '1 hour' : `${Number(h.toFixed(1))} hours`;
}
