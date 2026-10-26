/**
 * The economic calendar: what is scheduled to move markets, from the people
 * who schedule it.
 *
 *   Federal Reserve  the FOMC's meetings (federalreserve.gov's own calendar
 *                    page): the rate decision at 2:00 pm ET on a meeting's
 *                    last day, with the economic projections where it says so.
 *   BLS              CPI, the jobs report, PPI, JOLTS and the employment cost
 *                    index (bls.gov's release calendar, ICS, Eastern time).
 *   BEA              GDP and PCE inflation (bea.gov's release calendar, ICS, UTC).
 *   SoSoValue        its macro calendar (/macro/events: names by date, no
 *                    time) for what the three do not publish - ISM, PMIs,
 *                    home sales - and nothing they already cover.
 *
 * Each source is read on its own, at most every 12 hours, and a source that
 * fails keeps its last good copy; the route says which ones answered. The
 * parsers below are pure and covered by test/econ-calendar.test.ts.
 */
import { sosoValueJson, newsKey } from './sosovalue/news.js';
// Used inside functions only: releases.ts imports this file too.
import { RELEASE_FIELDS, type ReleaseField } from './releases.js';

export type CalendarSource = 'fed' | 'bls' | 'bea' | 'sosovalue';
export type Importance = 'high' | 'medium' | 'low';

export interface CalendarEvent {
  /** Stable across reads: source, indicator and time. */
  id: string;
  /** When it is released, ms. For an all-day event, midday UTC of its date. */
  time: number;
  /** No time given (SoSoValue's events): only the date is known. */
  allDay: boolean;
  /** "CPI", "FOMC", "GDP"... */
  short: string;
  /** "CPI inflation, September 2026", "FOMC rate decision". */
  title: string;
  /** What it is, in a line ("Statement 2:00 pm ET, press conference 2:30 pm ET"). */
  detail: string | null;
  importance: Importance;
  country: 'US';
  source: CalendarSource;
  /** The publisher's page for it. */
  href: string;
  /** The figures its result card shows (releases.ts RELEASE_FIELDS); official releases only. */
  fields?: ReleaseField[];
  /**
   * The indicators (indicators.ts) its figures are, for an event with no official
   * card (SoSoValue's): the card shows their latest reading and history instead.
   */
  indicators?: string[];
}

const fieldsOf = (short: string): { fields?: ReleaseField[] } => (RELEASE_FIELDS[short] ? { fields: RELEASE_FIELDS[short]!.map((f) => ({ ...f })) } : {});

export const SOURCE_NAME: Record<CalendarSource, string> = {
  fed: 'Federal Reserve',
  bls: 'U.S. Bureau of Labor Statistics',
  bea: 'U.S. Bureau of Economic Analysis',
  sosovalue: 'SoSoValue',
};

const FED_URL = 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm';
const BLS_URL = 'https://www.bls.gov/schedule/news_release/bls.ics';
const BEA_URL = 'https://www.bea.gov/news/schedule/ics/online-calendar-subscription.ics';
const UA = 'ValueDesk economic calendar (+https://valuedeskapp.vercel.app)';
const REFRESH_MS = 12 * 60 * 60_000;
/** A source that failed is not asked again for this long. */
const RETRY_MS = 20 * 60_000;
const TIMEOUT_MS = 15_000;

// --- time ------------------------------------------------------------------------

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/** A wall-clock time in New York as a timestamp, summer time or not. */
export function easternToUtc(y: number, mo: number, d: number, h: number, mi: number): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const offset = (at: number) => {
    const p = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(new Date(at));
    const v = (t: string) => Number(p.find((x) => x.type === t)?.value);
    return Date.UTC(v('year'), v('month') - 1, v('day'), v('hour'), v('minute')) - at;
  };
  const first = guess - offset(guess);
  // Near a clock change the offset at the answer is the one that counts.
  return guess - offset(first);
}

const pad = (n: number) => String(n).padStart(2, '0');
const isoDay = (t: number) => {
  const d = new Date(t);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};

// --- Federal Reserve -------------------------------------------------------------------

/**
 * The FOMC's meetings from its calendar page: one panel per year, each meeting
 * a month ("April", "Apr/May") and days ("28-29", "30-1", "*" where the
 * economic projections come with it). The decision is announced at 2:00 pm ET
 * on the last day.
 */
export function parseFomc(html: string): CalendarEvent[] {
  const out: CalendarEvent[] = [];
  const years = [...html.matchAll(/(\d{4}) FOMC Meetings/g)];
  for (let i = 0; i < years.length; i++) {
    const year = Number(years[i]![1]);
    const block = html.slice(years[i]!.index!, years[i + 1]?.index ?? html.length);
    for (const m of block.matchAll(/fomc-meeting__month[^>]*>\s*<strong>([^<]+)<\/strong>[\s\S]*?fomc-meeting__date[^>]*>([^<]+)</g)) {
      const monthText = m[1]!.trim().toLowerCase();
      const dateText = m[2]!.replace(/\s+/g, '');
      const sep = dateText.includes('*');
      const days = /^(\d{1,2})(?:-(\d{1,2}))?/.exec(dateText.replace(/\*/g, ''));
      if (!days) continue;
      // "Apr/May 30-1": the last day is in the second month.
      const names = monthText.split('/').map((s) => s.trim());
      const start = Number(days[1]);
      const end = days[2] ? Number(days[2]) : start;
      const monthName = end < start && names[1] ? names[1] : names[0]!;
      const month = MONTHS.findIndex((n) => n.startsWith(monthName.slice(0, 3))) + 1;
      if (month < 1 || end < 1 || end > 31) continue;
      const time = easternToUtc(year, month, end, 14, 0);
      out.push({
        id: `fed:fomc:${isoDay(time)}`,
        time,
        allDay: false,
        short: 'FOMC',
        title: sep ? 'FOMC rate decision and projections' : 'FOMC rate decision',
        detail: `Statement 2:00 pm ET, press conference 2:30 pm ET${sep ? '; with the Summary of Economic Projections' : ''}`,
        importance: 'high',
        country: 'US',
        source: 'fed',
        href: FED_URL,
        ...fieldsOf('FOMC'),
      });
    }
  }
  return out;
}

// --- ICS (BLS, BEA) -----------------------------------------------------------------------

interface IcsEvent {
  summary: string;
  time: number;
  allDay: boolean;
}

/** The events of an iCalendar file: folded lines unfolded, times read in UTC, US Eastern or as a date. */
export function parseIcs(text: string): IcsEvent[] {
  const lines = text.replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  const out: IcsEvent[] = [];
  let cur: { summary?: string; start?: string; tzid?: string } | null = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') cur = {};
    else if (line === 'END:VEVENT') {
      if (cur?.summary && cur.start) {
        const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(cur.start);
        if (m) {
          const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
          const allDay = !m[4];
          const time = allDay ? Date.UTC(y, mo - 1, d, 12) : m[7] ? Date.UTC(y, mo - 1, d, Number(m[4]), Number(m[5])) : /eastern|new_york/i.test(cur.tzid ?? '') ? easternToUtc(y, mo, d, Number(m[4]), Number(m[5])) : Date.UTC(y, mo - 1, d, Number(m[4]), Number(m[5]));
          out.push({ summary: cur.summary, time, allDay });
        }
      }
      cur = null;
    } else if (cur) {
      const at = line.indexOf(':');
      if (at < 0) continue;
      const [name, ...params] = line.slice(0, at).split(';');
      const value = line.slice(at + 1);
      if (name === 'SUMMARY') cur.summary = value.replace(/\\([,;\\])/g, '$1').replace(/\\n/gi, ' ').trim();
      else if (name === 'DTSTART') {
        cur.start = value.trim();
        cur.tzid = params.find((p) => p.startsWith('TZID='))?.slice(5);
      }
    }
  }
  return out;
}

interface Pick {
  match: RegExp;
  short: string;
  title: (summary: string) => string;
  importance: Importance;
  href: string;
  /** Months between the month a release covers and the month it comes out (BLS names neither). */
  lag?: number;
}

/** Which releases count, and what they are called: the rest of the calendars are left out. */
const BLS_PICKS: Pick[] = [
  { match: /^Consumer Price Index/i, short: 'CPI', title: () => 'CPI inflation', importance: 'high', href: 'https://www.bls.gov/cpi/', lag: 1 },
  { match: /^Employment Situation/i, short: 'NFP', title: () => 'Jobs report (nonfarm payrolls, unemployment)', importance: 'high', href: 'https://www.bls.gov/ces/', lag: 1 },
  { match: /^Producer Price Index/i, short: 'PPI', title: () => 'PPI inflation', importance: 'medium', href: 'https://www.bls.gov/ppi/', lag: 1 },
  { match: /^Job Openings and Labor Turnover/i, short: 'JOLTS', title: () => 'JOLTS job openings', importance: 'medium', href: 'https://www.bls.gov/jlt/', lag: 2 },
  { match: /^Employment Cost Index/i, short: 'ECI', title: () => 'Employment cost index', importance: 'medium', href: 'https://www.bls.gov/eci/' },
];
const BEA_PICKS: Pick[] = [
  {
    // "GDP (Advance Estimate), 3rd Quarter 2026" - the national release, not "GDP by County".
    match: /^(GDP|Gross Domestic Product)( \((Advance|Second|Third)|,)/i,
    short: 'GDP',
    title: (s) => {
      const q = /(\d)(?:st|nd|rd|th) Quarter(?: and Year)? (\d{4})/i.exec(s);
      const est = /\((Advance|Second|Third)[^)]*\)/i.exec(s)?.[1]?.toLowerCase();
      return `GDP${q ? ` Q${q[1]} ${q[2]}` : ''}${est ? ` (${est})` : ''}`;
    },
    importance: 'high',
    href: 'https://www.bea.gov/data/gdp/gross-domestic-product',
  },
  {
    match: /^Personal Income and Outlays/i,
    short: 'PCE',
    title: (s) => `PCE inflation${/, (\w+ \d{4})/.exec(s)?.[1] ? `, ${/, (\w+ \d{4})/.exec(s)![1]}` : ''}`,
    importance: 'high',
    href: 'https://www.bea.gov/data/personal-consumption-expenditures-price-index',
  },
];

/** The releases of an ICS calendar that count, named. */
export function pickReleases(events: readonly IcsEvent[], source: 'bls' | 'bea'): CalendarEvent[] {
  const picks = source === 'bls' ? BLS_PICKS : BEA_PICKS;
  const out: CalendarEvent[] = [];
  for (const e of events) {
    const p = picks.find((x) => x.match.test(e.summary));
    if (!p) continue;
    // The month it covers, where the calendar does not say: October's CPI is September's.
    const at = new Date(e.time);
    const covers = p.lag ? new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() - p.lag, 1)) : null;
    const title = covers ? `${p.title(e.summary)}, ${covers.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' })} ${covers.getUTCFullYear()}` : p.title(e.summary);
    out.push({
      id: `${source}:${p.short.toLowerCase()}:${isoDay(e.time)}`,
      time: e.time,
      allDay: e.allDay,
      short: p.short,
      title,
      detail: e.summary,
      importance: p.importance,
      country: 'US',
      source,
      href: p.href,
      ...fieldsOf(p.short),
    });
  }
  return out;
}

// --- SoSoValue ---------------------------------------------------------------------------

/** What SoSoValue's event names are, so an official copy of the same release is kept instead. */
const SOSO_KINDS: Array<{ match: RegExp; short: string; importance: Importance }> = [
  { match: /PCE/i, short: 'PCE', importance: 'high' },
  { match: /GDP/i, short: 'GDP', importance: 'high' },
  { match: /CPI|Consumer Price/i, short: 'CPI', importance: 'high' },
  { match: /Non-?Farm|Payroll|Unemployment Rate/i, short: 'NFP', importance: 'high' },
  { match: /PPI|Producer Price/i, short: 'PPI', importance: 'medium' },
  { match: /JOLTS|Job Openings/i, short: 'JOLTS', importance: 'medium' },
  { match: /FOMC|Fed Interest Rate|Rate Decision/i, short: 'FOMC', importance: 'high' },
  { match: /ISM/i, short: 'ISM', importance: 'medium' },
  { match: /Retail Sales/i, short: 'Retail', importance: 'medium' },
  { match: /Jobless Claims/i, short: 'Claims', importance: 'low' },
  { match: /PMI/i, short: 'PMI', importance: 'low' },
  { match: /Home Sales|Housing Starts|Building Permits/i, short: 'Housing', importance: 'low' },
  { match: /Michigan|Consumer Sentiment/i, short: 'Sentiment', importance: 'low' },
  { match: /Industrial Production/i, short: 'IP', importance: 'low' },
  { match: /Durable Goods/i, short: 'Durables', importance: 'low' },
];

/**
 * Which indicators a SoSoValue event's name is, most specific first: "Core PCE
 * Price Index YoY" is core_pce_yy alone, "PCE" both PCE gauges. None for a
 * release with no free history (ISM, S&P Global PMIs) or a name not matched.
 */
const SOSO_INDICATORS: Array<{ match: RegExp; ids: string[] }> = [
  { match: /Core PCE.*(YoY|Y.Y|Year)/i, ids: ['core_pce_yy'] },
  { match: /Core PCE.*(MoM|M.M|Month)/i, ids: ['core_pce_mm'] },
  { match: /Core PCE/i, ids: ['core_pce_mm', 'core_pce_yy'] },
  { match: /PCE.*(YoY|Y.Y|Year)/i, ids: ['pce_yy'] },
  { match: /PCE.*(MoM|M.M|Month)/i, ids: ['pce_mm'] },
  { match: /PCE/i, ids: ['pce_mm', 'pce_yy', 'core_pce_mm', 'core_pce_yy'] },
  { match: /GDP/i, ids: ['gdp'] },
  { match: /Core CPI.*(YoY|Y.Y|Year)/i, ids: ['core_cpi_yy'] },
  { match: /Core CPI.*(MoM|M.M|Month)/i, ids: ['core_cpi_mm'] },
  { match: /Core CPI/i, ids: ['core_cpi_mm', 'core_cpi_yy'] },
  { match: /(CPI|Consumer Price).*(YoY|Y.Y|Year)/i, ids: ['cpi_yy'] },
  { match: /(CPI|Consumer Price).*(MoM|M.M|Month)/i, ids: ['cpi_mm'] },
  { match: /CPI|Consumer Price/i, ids: ['cpi_mm', 'cpi_yy', 'core_cpi_mm', 'core_cpi_yy'] },
  { match: /Unemployment Rate/i, ids: ['unemployment'] },
  { match: /Average Hourly Earnings|Hourly Earnings/i, ids: ['ahe_mm', 'ahe_yy'] },
  { match: /Non-?Farm|Payroll/i, ids: ['payrolls', 'unemployment', 'ahe_mm'] },
  { match: /(PPI|Producer Price).*(YoY|Y.Y|Year)/i, ids: ['ppi_yy'] },
  { match: /(PPI|Producer Price).*(MoM|M.M|Month)/i, ids: ['ppi_mm'] },
  { match: /PPI|Producer Price/i, ids: ['ppi_mm', 'ppi_yy'] },
  { match: /JOLTS|Job Openings/i, ids: ['jolts'] },
  { match: /FOMC|Fed Interest Rate|Rate Decision/i, ids: ['fed_upper'] },
  { match: /Retail Sales.*(Ex|Excl).*Auto/i, ids: ['retail_ex_auto_mm'] },
  { match: /Retail Sales/i, ids: ['retail_mm', 'retail_ex_auto_mm'] },
  { match: /Continuing.*Claims/i, ids: ['continuing_claims'] },
  { match: /Jobless Claims/i, ids: ['initial_claims', 'continuing_claims'] },
  { match: /New Home Sales/i, ids: ['new_home_sales'] },
  { match: /Existing Home Sales/i, ids: ['existing_home_sales'] },
  { match: /Housing Starts/i, ids: ['housing_starts', 'building_permits'] },
  { match: /Building Permits/i, ids: ['building_permits', 'housing_starts'] },
  { match: /Michigan|Consumer Sentiment/i, ids: ['umich_sentiment'] },
  { match: /Industrial Production/i, ids: ['ip_mm'] },
  { match: /Durable Goods/i, ids: ['durables_mm'] },
];

export const sosoIndicators = (name: string): string[] => SOSO_INDICATORS.find((k) => k.match.test(name))?.ids ?? [];

/** SoSoValue's /macro/events ({date, events: [name]}): one all-day event per name. */
export function parseSosoEvents(body: unknown): CalendarEvent[] {
  const days = body && typeof body === 'object' && Array.isArray((body as { data?: unknown }).data) ? ((body as { data: unknown[] }).data) : Array.isArray(body) ? body : [];
  const out: CalendarEvent[] = [];
  for (const d of days) {
    const row = d as { date?: unknown; events?: unknown } | null;
    const m = typeof row?.date === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(row.date) : null;
    if (!m || !Array.isArray(row!.events)) continue;
    for (const raw of row!.events) {
      const name = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
      if (!name) continue;
      const kind = SOSO_KINDS.find((k) => k.match.test(name));
      const time = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12);
      out.push({
        id: `sosovalue:${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}:${row!.date}`,
        time,
        allDay: true,
        short: kind?.short ?? name.split(' ')[0]!,
        title: name,
        detail: null,
        importance: kind?.importance ?? 'low',
        country: 'US',
        source: 'sosovalue',
        href: 'https://sosovalue.com',
        ...(sosoIndicators(name).length ? { indicators: sosoIndicators(name) } : {}),
      });
    }
  }
  return out;
}

/**
 * One calendar from the sources: the official releases as they are, and
 * SoSoValue's only where no official release of the same kind falls within a
 * day of it; by time.
 */
export function mergeCalendar(official: readonly CalendarEvent[], soso: readonly CalendarEvent[]): CalendarEvent[] {
  const DAY = 86_400_000;
  const covered = (e: CalendarEvent) => official.some((o) => o.short === e.short && Math.abs(o.time - e.time) <= 1.5 * DAY);
  const seen = new Set<string>();
  return [...official, ...soso.filter((e) => !covered(e))]
    .filter((e) => !seen.has(e.id) && !!seen.add(e.id))
    .sort((a, b) => a.time - b.time || a.short.localeCompare(b.short));
}

// --- reading the sources -------------------------------------------------------------------

type SourceState = { at: number; failedAt: number; events: CalendarEvent[] };
const state = new Map<CalendarSource, SourceState>();
const inflight = new Map<CalendarSource, Promise<void>>();

/** Tests only. */
export function resetCalendar(): void {
  state.clear();
  inflight.clear();
}

async function getText(url: string, fetchImpl: typeof fetch): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { headers: { 'user-agent': UA, accept: 'text/html,text/calendar,*/*' }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`${new URL(url).hostname} HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

const READERS: Record<CalendarSource, (f: typeof fetch) => Promise<CalendarEvent[]>> = {
  fed: async (f) => parseFomc(await getText(FED_URL, f)),
  bls: async (f) => pickReleases(parseIcs(await getText(BLS_URL, f)), 'bls'),
  bea: async (f) => pickReleases(parseIcs(await getText(BEA_URL, f)), 'bea'),
  sosovalue: async (f) => (newsKey() ? parseSosoEvents(await sosoValueJson('/macro/events?language=en', f)) : []),
};

async function refresh(source: CalendarSource, fetchImpl: typeof fetch): Promise<void> {
  const s = state.get(source);
  const now = Date.now();
  if (s && now - s.at < REFRESH_MS) return;
  if (s && now - s.failedAt < RETRY_MS) return;
  let flight = inflight.get(source);
  if (!flight) {
    flight = (async () => {
      try {
        const events = await READERS[source](fetchImpl);
        // An empty read of a calendar that had events is a page that changed, not a quiet month.
        if (events.length === 0 && s?.events.length) throw new Error('no events read');
        state.set(source, { at: Date.now(), failedAt: 0, events });
      } catch {
        state.set(source, { at: s?.at ?? 0, failedAt: Date.now(), events: s?.events ?? [] });
      }
    })().finally(() => inflight.delete(source));
    inflight.set(source, flight);
  }
  await flight;
}

export interface CalendarPage {
  events: CalendarEvent[];
  /** Per source: answered on its last read ('ok'), its last good copy ('stale'), or nothing yet ('none'). */
  sources: Record<CalendarSource, 'ok' | 'stale' | 'none'>;
}

const SOURCES: CalendarSource[] = ['fed', 'bls', 'bea', 'sosovalue'];

/** The calendar between two times (ms); every source read at most twice a day. */
export async function calendar(from: number, to: number, fetchImpl: typeof fetch = fetch): Promise<CalendarPage> {
  await Promise.all(SOURCES.map((s) => refresh(s, fetchImpl)));
  const of = (s: CalendarSource) => state.get(s)?.events ?? [];
  const official = [...of('fed'), ...of('bls'), ...of('bea')];
  const events = mergeCalendar(official, of('sosovalue')).filter((e) => e.time >= from && e.time <= to);
  const sources = Object.fromEntries(
    SOURCES.map((s) => {
      const st = state.get(s);
      return [s, !st || (!st.events.length && st.failedAt) ? 'none' : st.failedAt > st.at ? 'stale' : 'ok'];
    }),
  ) as CalendarPage['sources'];
  return { events, sources };
}

/** The route's window: from a week back to two months ahead by default, at most a year. */
export function parseCalendarQuery(raw: Record<string, unknown>, now = Date.now()): { from: number; to: number } {
  const n = (v: unknown) => (typeof v === 'string' && /^\d{10,14}$/.test(v) ? Number(v) : typeof v === 'number' && Number.isFinite(v) ? v : null);
  const DAY = 86_400_000;
  const from = n(raw.from) ?? now - 7 * DAY;
  const to = n(raw.to) ?? now + 60 * DAY;
  return { from, to: Math.min(Math.max(to, from), from + 400 * DAY) };
}
