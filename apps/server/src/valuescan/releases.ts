/**
 * Official economic results at the release second: the numbers themselves,
 * read from the agency's own page the moment it goes up.
 *
 *   Federal Reserve  the FOMC statement (monetaryYYYYMMDDa.htm, which only
 *                    exists once released): the decision, the new target
 *                    range and the vote, dissents named.
 *   BLS              the release's summary page (news.release/<name>.nr0.htm):
 *                    CPI, the jobs report, PPI, JOLTS, the employment cost index.
 *   BEA              the release page linked from the current-releases list
 *                    (its slugs are not predictable): GDP and PCE inflation.
 *
 * A page counts as the new release only when the release date it prints
 * equals the event's date in New York. The watcher (startReleaseWatcher) runs
 * in the API process: once a minute it looks for an event due within three
 * minutes; from 15 s before it polls that event's page every 500 ms, one
 * request in flight, until the page is the new release; after 15 minutes every
 * 15 s; after two hours it gives up ('missed'). Outside those windows it reads
 * each kind's current page once at start-up (the `prior` values for the next
 * event) and nothing else. Results are kept in release-results.json next to
 * the device key, 60 days of them.
 *
 * The parsers are pure and covered by test/releases.test.ts on saved pages.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { deviceKeyPath } from '../deviceKey.js';
import { calendar, type CalendarEvent } from './calendar.js';

export type ReleaseUnit = '%' | 'k' | 'bp' | '';
export interface ReleaseField {
  key: string;
  label: string;
  unit: ReleaseUnit;
}
export type ReleaseState = 'scheduled' | 'watching' | 'released' | 'missed';
export interface ReleaseValue {
  /** As printed, a plain number for a change ("0.6", "-0.4", "29"), text for the Fed's ("Hold", "3.75–4.00", "11–1"). */
  value: string;
  note?: string;
}
export interface ParsedRelease {
  /** The release date the page prints, YYYY-MM-DD (New York). */
  releaseDate: string | null;
  /** What it covers: "September 2026", "Q2 2026 (third estimate)". */
  period: string | null;
  /** The release's first summary sentence. */
  headline: string | null;
  values: Record<string, ReleaseValue>;
  /** The page is the release of the event asked about (its date is the event's date in New York). */
  fresh: boolean;
}
export interface ReleaseResultField extends ReleaseField {
  value: string | null;
  /** The same figure from the release before. */
  prior: string | null;
  note?: string;
}
export interface ReleaseResult {
  id: string;
  state: ReleaseState;
  /** The scheduled release time (ms) once released. */
  releasedAt: number | null;
  /** When this server first saw the new page (ms); null when it was read later (after a restart). */
  seenAt: number | null;
  /** The scheduled release time (ms), when known. */
  scheduledAt: number | null;
  period: string | null;
  /** The period the prior values are for. */
  priorPeriod: string | null;
  headline: string | null;
  href: string;
  fields: ReleaseResultField[];
}

/** The figures an event card shows, by the calendar's `short`. */
export const RELEASE_FIELDS: Readonly<Record<string, readonly ReleaseField[]>> = {
  FOMC: [
    { key: 'decision', label: 'Decision', unit: '' },
    { key: 'range', label: 'Target range', unit: '%' },
    { key: 'votes', label: 'Vote', unit: '' },
  ],
  CPI: [
    { key: 'cpi_mm', label: 'CPI m/m', unit: '%' },
    { key: 'cpi_yy', label: 'CPI y/y', unit: '%' },
    { key: 'core_mm', label: 'Core CPI m/m', unit: '%' },
    { key: 'core_yy', label: 'Core CPI y/y', unit: '%' },
  ],
  NFP: [
    { key: 'payrolls', label: 'Nonfarm payrolls', unit: 'k' },
    { key: 'unemployment', label: 'Unemployment rate', unit: '%' },
    { key: 'ahe_mm', label: 'Avg hourly earnings m/m', unit: '%' },
    { key: 'ahe_yy', label: 'Avg hourly earnings y/y', unit: '%' },
  ],
  PPI: [
    { key: 'ppi_mm', label: 'PPI m/m', unit: '%' },
    { key: 'ppi_yy', label: 'PPI y/y', unit: '%' },
    // The note names the series the summary gives: less foods, energy and trade services (or less foods and energy).
    { key: 'core_mm', label: 'Core PPI m/m', unit: '%' },
    { key: 'core_yy', label: 'Core PPI y/y', unit: '%' },
  ],
  GDP: [
    { key: 'gdp', label: 'Real GDP (annual rate)', unit: '%' },
    { key: 'pce_price', label: 'PCE prices (annual rate)', unit: '%' },
    { key: 'core_pce', label: 'Core PCE prices (annual rate)', unit: '%' },
  ],
  PCE: [
    { key: 'pce_mm', label: 'PCE prices m/m', unit: '%' },
    { key: 'pce_yy', label: 'PCE prices y/y', unit: '%' },
    { key: 'core_mm', label: 'Core PCE m/m', unit: '%' },
    { key: 'core_yy', label: 'Core PCE y/y', unit: '%' },
  ],
  JOLTS: [{ key: 'openings', label: 'Job openings (millions)', unit: '' }],
  ECI: [
    { key: 'eci_qq', label: 'ECI q/q', unit: '%' },
    { key: 'eci_yy', label: 'ECI y/y', unit: '%' },
  ],
};

/** The kind in an event id ("bls:nfp:2026-11-06") -> its `short`. */
const KIND_BY_SLUG: Record<string, string> = Object.fromEntries(Object.keys(RELEASE_FIELDS).map((s) => [s.toLowerCase(), s]));
const ID_RE = /^(fed|bls|bea):([a-z]+):(\d{4}-\d{2}-\d{2})$/;

const UA = 'ValueDesk economic calendar (+https://valuedeskapp.vercel.app)';
const BLS_PAGE: Record<string, string> = { CPI: 'cpi', NFP: 'empsit', PPI: 'ppi', JOLTS: 'jolts', ECI: 'eci' };
const BEA_LIST = 'https://www.bea.gov/news/current-releases';
const BEA_TITLE: Record<string, RegExp> = {
  // "GDP (Advance Estimate), 3rd Quarter 2026", not "GDP by County".
  GDP: /^(GDP|Gross Domestic Product)( \((Advance|Second|Third)|,)/i,
  PCE: /^Personal Income and Outlays/i,
};

// --- text ---------------------------------------------------------------------------

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const pad = (n: number) => String(n).padStart(2, '0');

/** A day in New York, YYYY-MM-DD. */
export function easternDay(t: number): string {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(t));
  const v = (k: string) => p.find((x) => x.type === k)?.value ?? '';
  return `${v('year')}-${v('month')}-${v('day')}`;
}

/** "September", "Sept", "Sep." + day + year -> YYYY-MM-DD. */
function isoDate(month: string, day: string, year: string): string | null {
  const m = MONTHS.findIndex((n) => n.startsWith(month.toLowerCase().slice(0, 3))) + 1;
  return m > 0 ? `${year}-${pad(m)}-${pad(Number(day))}` : null;
}

/**
 * A page's bytes as text. BLS sends no charset and writes Windows-1252
 * (its dashes are byte 0x96), so anything that is not valid UTF-8 is read as that.
 */
export function decodePage(bytes: ArrayBuffer | Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…', minus: '−',
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Visible text: blocks on their own lines, entities decoded, odd hyphens and spaces made plain. */
export function htmlText(html: string): string {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, '')
      .replace(/<(br|\/p|\/div|\/tr|\/h\d|\/li|\/td|\/th|\/caption)\b[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/\r/g, '')
    .replace(/[   ]/g, ' ')
    .replace(/[‐‑‒]/g, '-');
}

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

const ABBREV = /^(Mr|Ms|Mrs|Dr|St|No|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|vs|etc|Inc|Co)$/i;

/** The first sentence: up to a full stop before a capital, not the one in "U.S." or "a.m." or "Jerome H. Powell". */
export function firstSentence(text: string): string | null {
  const s = flat(text);
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '.') continue;
    if (i < s.length - 1 && !/^\s["“(]?[A-Z]/.test(s.slice(i + 1, i + 4))) continue;
    const word = /(\S+)$/.exec(s.slice(0, i))?.[1] ?? '';
    const token = word.split('.').pop() ?? '';
    if (/^[A-Za-z]$/.test(token) || ABBREV.test(token)) continue;
    return s.slice(0, i + 1);
  }
  return s || null;
}

const NEGATIVE = /\b(fell|falls?|declined?|declining|decreased?|decreasing|dropped|drops?|down|slipped|contracted|lower)\b/i;

/**
 * The percent change said right after `subject` in the same sentence: "rose 0.3
 * percent", "moved down 0.2 percent", "was unchanged" (0.0). Signed by the verb
 * before the number, or a minus printed with it.
 */
function changeAfter(text: string, subject: RegExp, from = 0): { value: string; end: number; match: RegExpExecArray } | null {
  const re = new RegExp(subject.source, subject.flags.includes('g') ? subject.flags : `${subject.flags}g`);
  re.lastIndex = from;
  const m = re.exec(text);
  if (!m) return null;
  const end = m.index + m[0].length;
  const clause = firstSentence(text.slice(end, end + 400)) ?? '';
  const num = /([-−–]?)(\d+(?:\.\d+)?)[- ]percent/.exec(clause);
  const unchanged = /\b(unchanged|no change)\b/i.exec(clause);
  if (unchanged && (!num || unchanged.index < num.index)) return { value: '0.0', end, match: m };
  if (!num) return null;
  const neg = !!num[1] || NEGATIVE.test(clause.slice(0, num.index));
  return { value: `${neg ? '-' : ''}${num[2]}`, end: end + num.index + num[0].length, match: m };
}

/** The release date an agency prints: "embargoed until 8:30 a.m. (ET) Friday, October 2, 2026", "For release 10:00 a.m. (ET) Tuesday, ...". */
function printedReleaseDate(text: string): string | null {
  const m =
    /(?:embargoed until|for release)[\s\S]{0,120}?\d{1,2}:\d{2}\s*[ap]\.?\s?m\.?\s*(?:\(ET\)|\(?E[DS]?T\)?)?,?\s*(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+([A-Za-z]+)\.?\s+(\d{1,2}),?\s*(\d{4})/i.exec(
      text,
    );
  return m ? isoDate(m[1]!, m[2]!, m[3]!) : null;
}

const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

/** A table's rows: the row's heading and its cells' text. */
function tableRows(html: string): Array<{ label: string; values: string[] }> {
  return [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) => {
    const th = /<th\b[^>]*>([\s\S]*?)<\/th>/i.exec(m[1]!);
    const values = [...m[1]!.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => flat(htmlText(c[1]!)));
    return { label: th ? flat(htmlText(th[1]!)) : '', values };
  });
}

const numberIn = (cell: string | undefined) => (cell ? /[-−]?\d+(?:\.\d+)?/.exec(cell)?.[0]?.replace('−', '-') ?? null : null);

// --- BLS --------------------------------------------------------------------------------

interface BlsText {
  /** The summary as laid out (line breaks kept). */
  pre: string;
  /** The same on one line. */
  flat: string;
  releaseDate: string | null;
  period: string | null;
  headline: string | null;
}

/** A BLS summary page: its <pre> text, the printed release date, the title's month and the first sentence after it. */
function blsText(html: string): BlsText {
  const pre = htmlText(/<pre\b[^>]*>([\s\S]*?)<\/pre>/i.exec(html)?.[1] ?? html);
  const title = /\b(JANUARY|FEBRUARY|MARCH|APRIL|MAY|JUNE|JULY|AUGUST|SEPTEMBER|OCTOBER|NOVEMBER|DECEMBER) (\d{4})\b/.exec(pre);
  let headline: string | null = null;
  if (title) {
    const after = pre.slice(pre.indexOf('\n', title.index) + 1);
    const para = after.split(/\n\s*\n/).find((p) => p.trim());
    headline = para ? firstSentence(para) : null;
  }
  return {
    pre,
    flat: flat(pre),
    releaseDate: printedReleaseDate(flat(pre)),
    period: title ? `${titleCase(title[1]!)} ${title[2]}` : null,
    headline,
  };
}

function parseCpi(html: string, t: BlsText): Record<string, ReleaseValue> {
  const out: Record<string, ReleaseValue> = {};
  // Table A: the seasonally adjusted month-on-month changes, then the unadjusted 12 months.
  const rows = tableRows(html);
  const row = (label: string) => rows.find((r) => r.label === label && r.values.length >= 2);
  for (const [label, mm, yy] of [['All items', 'cpi_mm', 'cpi_yy'], ['All items less food and energy', 'core_mm', 'core_yy']] as const) {
    const r = row(label);
    const a = numberIn(r?.values[r.values.length - 2]);
    const b = numberIn(r?.values[r.values.length - 1]);
    if (a) out[mm] = { value: a };
    if (b) out[yy] = { value: b };
  }
  // The summary says the same in words, should the table move.
  const say = (key: string, re: RegExp) => {
    const c = out[key] ? null : changeAfter(t.flat, re);
    if (c) out[key] = { value: c.value };
  };
  say('cpi_mm', /Consumer Price Index for All Urban Consumers \(CPI-U\)/);
  say('cpi_yy', /Over the last 12 months, the all items index/);
  say('core_mm', /The index for all items less food and energy/);
  say('core_yy', /The all items less food and energy index/);
  return out;
}

function parseNfp(t: BlsText): Record<string, ReleaseValue> {
  const out: Record<string, ReleaseValue> = {};
  const s = t.flat;
  const pay =
    /Total nonfarm payroll employment([^.]{0,160}?)\(?([+−–-]?)(\d{1,3}(?:,\d{3})+)\)?/.exec(s) ??
    /nonfarm payroll employment([^.]{0,160}?)\(?([+−–-]?)(\d{1,3}(?:,\d{3})+)\)?/i.exec(s);
  if (pay) {
    const neg = pay[2] ? pay[2] !== '+' : NEGATIVE.test(pay[1]!);
    const k = Number(pay[3]!.replace(/,/g, '')) / 1000;
    out.payrolls = { value: `${neg && k ? '-' : ''}${k}` };
  }
  const ur = /unemployment rate[^.]{0,60}?(\d+\.\d) percent/i.exec(s);
  if (ur) out.unemployment = { value: ur[1]! };
  const mm = changeAfter(s, /average hourly earnings for all employees on private nonfarm payrolls/i);
  if (mm) out.ahe_mm = { value: mm.value };
  const yy = changeAfter(s, /Over the (?:past|last) 12 months, average hourly earnings have/i);
  if (yy) out.ahe_yy = { value: yy.value };
  return out;
}

function parsePpi(t: BlsText): Record<string, ReleaseValue> {
  const out: Record<string, ReleaseValue> = {};
  const s = t.flat;
  const mm = changeAfter(s, /Producer Price Index for final demand/);
  if (mm) out.ppi_mm = { value: mm.value };
  const yy = changeAfter(s, /index for final demand(?= [a-z]+(?: [a-z]+)? [-−–]?\d+(?:\.\d+)? percent for the 12 months)/);
  if (yy) out.ppi_yy = { value: yy.value };
  const core = /final demand less (foods, energy,? and trade services|foods and energy)/;
  const cm = changeAfter(s, core);
  if (cm) out.core_mm = { value: cm.value, note: `Final demand less ${cm.match[1]}` };
  const cy = changeAfter(s, /12 months ended in [A-Za-z]+, the index for final demand less (foods, energy,? and trade services|foods and energy)/);
  if (cy) out.core_yy = { value: cy.value, note: `Final demand less ${cy.match[1]}` };
  return out;
}

function parseJolts(t: BlsText): Record<string, ReleaseValue> {
  const m = /job openings[^.]{0,100}?\b(?:at|to) (\d+(?:\.\d+)?) million/i.exec(t.flat);
  return m ? { openings: { value: m[1]! } } : {};
}

function parseEci(t: BlsText): Record<string, ReleaseValue> {
  const out: Record<string, ReleaseValue> = {};
  const qq = changeAfter(t.flat, /Compensation costs for civilian workers(?= [a-z]+(?: [a-z]+)? [-−–]?\d+(?:\.\d+)? percent, seasonally adjusted)/);
  if (qq) out.eci_qq = { value: qq.value };
  const yy = changeAfter(t.flat, /Compensation costs for civilian workers(?= [a-z]+(?: [a-z]+)? [-−–]?\d+(?:\.\d+)? percent, not seasonally adjusted)/);
  if (yy) out.eci_yy = { value: yy.value };
  return out;
}

// --- Federal Reserve ------------------------------------------------------------------------

/** "3-3/4" -> 3.75, "1/4" -> 0.25, "4" -> 4. */
function fraction(s: string): number {
  const m = /^(?:(\d+)-)?(\d+)\/(\d+)$/.exec(s);
  if (m) return Number(m[1] ?? 0) + Number(m[2]) / Number(m[3]);
  return Number(s);
}

const FED_NUM = '(\\d+-\\d\\/\\d|\\d\\/\\d|\\d+(?:\\.\\d+)?)';

/** The FOMC statement: the decision, the target range after it and the vote, with the dissenters and what they wanted. */
function parseFomcStatement(html: string, eventTime: number): ParsedRelease {
  const date = /article__time[^>]*>\s*([A-Za-z]+)\.?\s+(\d{1,2}),\s*(\d{4})/.exec(html);
  const releaseDate = date ? isoDate(date[1]!, date[2]!, date[3]!) : null;
  const paras = [...html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => flat(htmlText(m[1]!))).filter(Boolean);
  const all = paras.join('\n');
  const values: Record<string, ReleaseValue> = {};

  const decisionPara = paras.find((p) => /decided to (raise|lower|maintain)[^.]*target range for the federal funds rate/i.test(p));
  let headline: string | null = null;
  if (decisionPara) {
    // The whole sentence, "In support of its goals ..., the Committee decided to lower ..." included.
    const start = decisionPara.lastIndexOf('. ', decisionPara.search(/decided to (raise|lower|maintain)/i));
    headline = firstSentence(decisionPara.slice(start < 0 ? 0 : start + 2)) ?? decisionPara;
    const what = (/decided to (raise|lower|maintain)/i.exec(headline) ?? /decided to (raise|lower|maintain)/i.exec(decisionPara))![1]!.toLowerCase();
    const by = new RegExp(`by ${FED_NUM} percentage points?`).exec(headline);
    const bp = by ? Math.round(fraction(by[1]!) * 100) : null;
    values.decision = { value: what === 'maintain' ? 'Hold' : `${what === 'raise' ? 'Hike' : 'Cut'}${bp ? ` ${bp} bp` : ''}` };
    const range = new RegExp(`(?:to|at) ${FED_NUM} to ${FED_NUM} percent`).exec(headline);
    if (range) values.range = { value: `${fraction(range[1]!).toFixed(2)}–${fraction(range[2]!).toFixed(2)}` };
  }

  // Who voted against, and for what.
  const againstPara = paras.find((p) => /Voting against/i.test(p));
  let against: string[] = [];
  let preferred: string | null = null;
  if (againstPara) {
    const m = /Voting against (?:this|the)(?: monetary policy)? action (?:was|were) ([\s\S]+?)(?:, who (?:preferred|would have preferred) ([\s\S]+?)(?: at this meeting)?\.?$|\.$|$)/i.exec(
      againstPara.slice(againstPara.search(/Voting against/i)),
    );
    if (m) {
      against = m[1]!.split(/,\s*(?:and\s+)?|\s+and\s+/).map((n) => n.trim().replace(/\.$/, '')).filter(Boolean);
      preferred = m[2]?.trim() ?? null;
    }
  }
  const forPara = paras.find((p) => /^Voting for/i.test(p));
  const forNames = forPara
    ? forPara
        .replace(/^Voting for (?:this|the)(?: monetary policy)? action (?:was|were) /i, '')
        .split(/Voting against/i)[0]!
        .split(';')
        .map((n) => n.replace(/^\s*and\s+/, '').replace(/,\s*(Chair|Vice Chair)\s*$/i, '').replace(/\.\s*$/, '').trim())
        .filter(Boolean)
    : [];
  const tally = /by an? (\d+)\s*[–—-]\s*(\d+) vote/i.exec(all);
  const votes = tally ? `${tally[1]}–${tally[2]}` : forNames.length ? `${forNames.length}–${against.length}` : null;
  if (votes) {
    values.votes = { value: votes };
    if (against.length) values.votes.note = `Against: ${against.join(', ')}${preferred ? ` (preferred ${preferred})` : ''}`;
  }
  return {
    releaseDate,
    period: date ? `${titleCase(date[1]!)} ${date[3]}` : null,
    headline,
    values,
    fresh: !!releaseDate && releaseDate === easternDay(eventTime),
  };
}

// --- BEA --------------------------------------------------------------------------------------

export interface BeaListed {
  title: string;
  /** Absolute. */
  href: string;
  /** YYYY-MM-DD as BEA dates it (Eastern). */
  date: string;
}

/** BEA's current-releases list: title, link and release date per row, newest first. */
export function parseBeaListing(html: string): BeaListed[] {
  const out: BeaListed[] = [];
  for (const m of html.matchAll(/<a href="(\/news\/\d{4}\/[^"#?]+)"[^>]*>([^<]+)<\/a>((?:(?!<a href)[\s\S]){0,800}?)<time datetime="(\d{4}-\d{2}-\d{2})T/g)) {
    out.push({ title: flat(decodeEntities(m[2]!)), href: `https://www.bea.gov${m[1]}`, date: m[4]! });
  }
  return out.sort((a, b) => b.date.localeCompare(a.date));
}

const ORDINAL: Record<string, string> = { '1st': 'Q1', '2nd': 'Q2', '3rd': 'Q3', '4th': 'Q4' };

function parseBea(short: 'GDP' | 'PCE', html: string, eventTime: number): ParsedRelease {
  const page = flat(htmlText(html));
  const releaseDate = printedReleaseDate(page);
  // The release's own heading (the page's first is the section's, "News Release").
  const title = [...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)].map((m) => flat(htmlText(m[1]!))).find((h) => h && !/^News Releases?$/i.test(h)) ?? '';
  const at = html.indexOf('release-body');
  const body = flat(htmlText(at >= 0 ? html.slice(at) : html).replace(/^[^>]*>/, ''));
  const values: Record<string, ReleaseValue> = {};
  let period: string | null = null;
  if (short === 'GDP') {
    const q = /(\d(?:st|nd|rd|th)) Quarter(?: and Year)? (\d{4})/i.exec(title);
    const est = /\((Advance|Second|Third)[^)]*\)/i.exec(title)?.[1]?.toLowerCase();
    period = q ? `${ORDINAL[q[1]!.toLowerCase()] ?? q[1]} ${q[2]}${est ? ` (${est} estimate)` : ''}` : null;
    const gdp = changeAfter(body, /Real gross domestic product \(GDP\)/);
    if (gdp) values.gdp = { value: gdp.value };
    const pce = changeAfter(body, /The personal consumption expenditures \(PCE\) price index/);
    if (pce) values.pce_price = { value: pce.value };
    const core = changeAfter(body, /PCE price index excluding food and energy|Excluding food and energy(?: prices)?, the PCE price index/, pce?.end ?? 0);
    if (core) values.core_pce = { value: core.value };
  } else {
    const p = /, ([A-Z][a-z]+ \d{4})\s*$/.exec(title);
    period = p ? p[1]! : null;
    const mm = changeAfter(body, /From the preceding month, the PCE price index(?: for [A-Z][a-z]+)?/);
    if (mm) values.pce_mm = { value: mm.value };
    const cm = mm ? changeAfter(body, /Excluding food and energy, the PCE price index/, mm.end) : null;
    if (cm) values.core_mm = { value: cm.value };
    const yy = changeAfter(body, /From the same month (?:one|a) year ago, the PCE price index(?: for [A-Z][a-z]+)?/);
    if (yy) values.pce_yy = { value: yy.value };
    const cy = yy ? changeAfter(body, /Excluding food and energy, the PCE price index/, yy.end) : null;
    if (cy) values.core_yy = { value: cy.value };
  }
  return { releaseDate, period, headline: firstSentence(body), values, fresh: !!releaseDate && releaseDate === easternDay(eventTime) };
}

// --- one parser for every kind ------------------------------------------------------------------

/**
 * The figures on a release page. `html` is the page resultUrl leads to (for
 * BEA, the release page the current-releases list links to). Null when the
 * page is not one of these releases at all.
 */
export function parseRelease(short: string, html: string, eventTime: number): ParsedRelease | null {
  if (short === 'FOMC') {
    const r = parseFomcStatement(html, eventTime);
    return r.releaseDate || Object.keys(r.values).length ? r : null;
  }
  if (short === 'GDP' || short === 'PCE') {
    const r = parseBea(short, html, eventTime);
    return r.releaseDate || Object.keys(r.values).length ? r : null;
  }
  if (!BLS_PAGE[short]) return null;
  const t = blsText(html);
  const values = short === 'CPI' ? parseCpi(html, t) : short === 'NFP' ? parseNfp(t) : short === 'PPI' ? parsePpi(t) : short === 'JOLTS' ? parseJolts(t) : parseEci(t);
  if (!t.releaseDate && !Object.keys(values).length) return null;
  return { releaseDate: t.releaseDate, period: t.period, headline: t.headline, values, fresh: !!t.releaseDate && t.releaseDate === easternDay(eventTime) };
}

type EventRef = Pick<CalendarEvent, 'id' | 'short' | 'time'>;

/**
 * Where an event's result is published. With `bust` (a time, ms) a query is
 * added so a CDN edge that keys on it asks the origin (Cloudflare in front of
 * federalreserve.gov answered a HIT through one in testing; Akamai on bls.gov
 * and bea.gov do not cache these pages). For GDP and PCE it is BEA's list of
 * current releases, which links the release page.
 */
export function resultUrl(event: EventRef, bust?: number): string | null {
  const q = bust ? `?_=${bust}` : '';
  if (event.short === 'FOMC') return `https://www.federalreserve.gov/newsevents/pressreleases/monetary${easternDay(event.time).replace(/-/g, '')}a.htm${q}`;
  if (BLS_PAGE[event.short]) return `https://www.bls.gov/news.release/${BLS_PAGE[event.short]}.nr0.htm${q}`;
  if (BEA_TITLE[event.short]) return `${BEA_LIST}${q}`;
  return null;
}

// --- reading ----------------------------------------------------------------------------------

async function getPage(url: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { headers: { 'user-agent': UA, accept: 'text/html,*/*', 'cache-control': 'no-cache' }, signal: ctrl.signal });
    if (!res.ok) throw Object.assign(new Error(`${new URL(url).hostname} HTTP ${res.status}`), { status: res.status });
    return decodePage(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read an event's page. `latest` (BEA only differs): the newest release of that
 * kind rather than the one dated on the event's day.
 */
async function readEventPage(e: EventRef, fetchImpl: typeof fetch, mode: 'event' | 'latest', bust: number, timeoutMs: number): Promise<{ href: string; parsed: ParsedRelease } | null> {
  const url = resultUrl(e, bust);
  if (!url) return null;
  if (BEA_TITLE[e.short]) {
    const day = easternDay(e.time);
    const listed = parseBeaListing(await getPage(url, fetchImpl, timeoutMs)).filter((r) => BEA_TITLE[e.short]!.test(r.title));
    const hit = mode === 'latest' ? listed[0] : listed.find((r) => r.date === day);
    if (!hit) return null;
    const parsed = parseRelease(e.short, await getPage(`${hit.href}?_=${bust}`, fetchImpl, timeoutMs), e.time);
    return parsed ? { href: hit.href, parsed } : null;
  }
  const parsed = parseRelease(e.short, await getPage(url, fetchImpl, timeoutMs), e.time);
  return parsed ? { href: resultUrl(e)!, parsed } : null;
}

// --- the store ----------------------------------------------------------------------------------

interface StoredResult {
  id: string;
  short: string;
  state: ReleaseState;
  scheduledAt: number;
  releasedAt: number | null;
  seenAt: number | null;
  period: string | null;
  headline: string | null;
  href: string;
  values: Record<string, ReleaseValue>;
  prior: Record<string, ReleaseValue> | null;
  priorPeriod: string | null;
}
interface Latest {
  releaseDate: string;
  period: string | null;
  headline: string | null;
  values: Record<string, ReleaseValue>;
  href: string;
  readAt: number;
}
interface Store {
  version: 1;
  results: Record<string, StoredResult>;
  /** Per kind, the newest release read: the prior values of the next one. */
  latest: Record<string, Latest>;
}

const DAY = 86_400_000;
const KEEP_MS = 60 * DAY;
/** An event due within this long gets its watcher. */
const AHEAD_MS = 3 * 60_000;
/** Polling starts this long before the release. */
const LEAD_MS = 15_000;
/** Every 500 ms for this long after the release, then every 15 s. */
const FAST_FOR_MS = 15 * 60_000;
const GIVE_UP_MS = 2 * 60 * 60_000;
/** A kind whose current page could not be read is tried again after this long. */
const PRIME_RETRY_MS = 20 * 60_000;
const FILE = 'release-results.json';

const emptyStore = (): Store => ({ version: 1, results: {}, latest: {} });
let store: Store = emptyStore();
/** The calendar's release events, by id, from the watcher's last look. */
let known = new Map<string, CalendarEvent>();

/** Tests only. */
export function resetReleases(): void {
  store = emptyStore();
  known = new Map();
}

function loadStore(path: string): Store {
  try {
    const s = JSON.parse(readFileSync(path, 'utf8')) as Store;
    if (s?.version === 1 && s.results && s.latest) return s;
  } catch {
    /* first start, or a damaged file: start empty */
  }
  return emptyStore();
}

function saveStore(path: string, now: number): void {
  for (const [id, r] of Object.entries(store.results)) if (now - r.scheduledAt > KEEP_MS) delete store.results[id];
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(store));
  renameSync(tmp, path);
}

const shortOf = (id: string) => KIND_BY_SLUG[ID_RE.exec(id)?.[2] ?? ''] ?? null;

/** The prior values for an event: the newest release of its kind from before its day. */
function priorFor(short: string, day: string): Latest | null {
  const l = store.latest[short];
  return l && l.releaseDate < day ? l : null;
}

/** Results for the route: every id that is a fed/bls/bea release; `hot` while one is being watched or within five minutes of its time. */
export function releaseResults(ids: readonly string[], now = Date.now()): { results: Record<string, ReleaseResult>; hot: boolean } {
  const results: Record<string, ReleaseResult> = {};
  let hot = false;
  for (const id of ids) {
    const short = shortOf(id);
    if (!short) continue;
    const day = ID_RE.exec(id)![3]!;
    const rec = store.results[id];
    const ev = known.get(id);
    const scheduledAt = rec?.scheduledAt ?? ev?.time ?? null;
    // Nothing recorded and past the watcher's two hours: there will be no result from here.
    const state: ReleaseState = rec?.state ?? (scheduledAt !== null && now > scheduledAt + GIVE_UP_MS ? 'missed' : 'scheduled');
    if (state === 'watching' || (scheduledAt !== null && Math.abs(now - scheduledAt) <= 5 * 60_000)) hot = true;
    const prior = rec ? (rec.prior ? { values: rec.prior, period: rec.priorPeriod } : null) : (() => {
      const l = priorFor(short, day);
      return l ? { values: l.values, period: l.period } : null;
    })();
    const ref = { id, short, time: scheduledAt ?? Date.parse(`${day}T17:00:00Z`) };
    results[id] = {
      id,
      state,
      releasedAt: rec?.releasedAt ?? null,
      seenAt: rec?.seenAt ?? null,
      scheduledAt,
      period: rec?.period ?? null,
      priorPeriod: prior?.period ?? null,
      headline: rec?.headline ?? null,
      href: rec?.href ?? (BEA_TITLE[short] ? ev?.href ?? BEA_LIST : resultUrl(ref)!),
      fields: (RELEASE_FIELDS[short] ?? []).map((f) => {
        const v = rec?.values[f.key];
        const note = v?.note;
        return { ...f, value: v?.value ?? null, prior: prior?.values[f.key]?.value ?? null, ...(note ? { note } : {}) };
      }),
    };
  }
  return { results, hot };
}

// --- the watcher -------------------------------------------------------------------------------

export interface ReleaseWatcherOptions {
  fetchImpl?: typeof fetch;
  /** The calendar to watch (default calendar.ts calendar()). */
  calendarImpl?: (from: number, to: number) => Promise<{ events: CalendarEvent[] }>;
  /** Where release-results.json lives (default: the device key's directory). */
  dir?: string;
  now?: () => number;
  log?: { warn: (obj: object, msg: string) => void; info: (obj: object, msg: string) => void };
  /** Read each kind's current page at start-up (default true). */
  prime?: boolean;
  /** Tests: the minute tick, the 500 ms and 15 s polls, the 4 s request timeout. */
  tickMs?: number;
  fastMs?: number;
  slowMs?: number;
  timeoutMs?: number;
}

export interface ReleaseWatcher {
  stop(): void;
  /** One look at the calendar now (also run every minute). */
  tick(): Promise<void>;
  /** Settles when every event being polled is done (tests). */
  idle(): Promise<void>;
}

/** Start the watcher in this process. Only one should run. */
export function startReleaseWatcher(opts: ReleaseWatcherOptions = {}): ReleaseWatcher {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const calendarImpl = opts.calendarImpl ?? ((from: number, to: number) => calendar(from, to));
  const now = opts.now ?? Date.now;
  const path = join(opts.dir ?? dirname(deviceKeyPath()), FILE);
  const fastMs = opts.fastMs ?? 500;
  const slowMs = opts.slowMs ?? 15_000;
  const timeoutMs = opts.timeoutMs ?? 4_000;
  const pollers = new Map<string, Promise<void>>();
  const primed = new Map<string, { at: number; ok: boolean }>();
  let stopped = false;
  const timers = new Set<ReturnType<typeof setTimeout>>();

  store = loadStore(path);
  const save = () => {
    try {
      saveStore(path, now());
    } catch (err) {
      opts.log?.warn({ err: (err as Error).message, path }, 'release results not saved');
    }
  };
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        timers.delete(t);
        resolve();
      }, Math.max(0, ms));
      t.unref?.();
      timers.add(t);
    });

  const record = (e: CalendarEvent): StoredResult => {
    let r = store.results[e.id];
    if (!r) {
      const prior = priorFor(e.short, easternDay(e.time));
      r = store.results[e.id] = {
        id: e.id,
        short: e.short,
        state: 'scheduled',
        scheduledAt: e.time,
        releasedAt: null,
        seenAt: null,
        period: null,
        headline: null,
        href: (BEA_TITLE[e.short] ? e.href : resultUrl(e)) ?? e.href,
        values: {},
        prior: prior?.values ?? null,
        priorPeriod: prior?.period ?? null,
      };
    }
    r.scheduledAt = e.time;
    return r;
  };

  const released = (r: StoredResult, e: EventRef, got: { href: string; parsed: ParsedRelease }, seenAt: number | null) => {
    Object.assign(r, { state: 'released', releasedAt: e.time, seenAt, period: got.parsed.period, headline: got.parsed.headline, values: got.parsed.values, href: got.href });
    const cur = store.latest[e.short];
    if (got.parsed.releaseDate && (!cur || cur.releaseDate <= got.parsed.releaseDate)) {
      store.latest[e.short] = { releaseDate: got.parsed.releaseDate, period: got.parsed.period, headline: got.parsed.headline, values: got.parsed.values, href: got.href, readAt: now() };
    }
  };

  /** One event: from 15 s before its time until its page is the new release, or two hours. */
  const watch = async (e: CalendarEvent) => {
    await sleep(e.time - LEAD_MS - now());
    if (stopped) return;
    const r = record(e);
    r.state = 'watching';
    save();
    while (!stopped) {
      const started = now();
      if (started > e.time + GIVE_UP_MS) {
        r.state = 'missed';
        save();
        opts.log?.warn({ id: e.id }, 'release not found on the publisher page within two hours');
        return;
      }
      try {
        const got = await readEventPage(e, fetchImpl, 'event', started, timeoutMs);
        if (got?.parsed.fresh && Object.keys(got.parsed.values).length) {
          released(r, e, got, now());
          save();
          opts.log?.info({ id: e.id, lateMs: now() - e.time, values: got.parsed.values }, 'release read');
          return;
        }
      } catch {
        /* not up yet (the Fed's statement is a 404 until then), slow or refused: next round */
      }
      await sleep(started + (now() < e.time + FAST_FOR_MS ? fastMs : slowMs) - now());
    }
  };

  /** A kind's current page: the prior values for its next event, and its last release if this server missed it. */
  const prime = async (short: string, t: number) => {
    let ref: EventRef = { id: '', short, time: t };
    if (short === 'FOMC') {
      const past = [...known.values()].filter((e) => e.short === 'FOMC' && e.time <= t).sort((a, b) => a.time - b.time).pop();
      if (!past) return;
      ref = past;
    }
    const got = await readEventPage(ref, fetchImpl, 'latest', t, 15_000);
    if (!got?.parsed.releaseDate) throw new Error(`${short}: no release date on the current page`);
    const day = got.parsed.releaseDate;
    const cur = store.latest[short];
    if (!cur || cur.releaseDate <= day) store.latest[short] = { releaseDate: day, period: got.parsed.period, headline: got.parsed.headline, values: got.parsed.values, href: got.href, readAt: now() };
    const ev = [...known.values()].find((e) => e.short === short && easternDay(e.time) === day && e.time <= t);
    if (ev && !pollers.has(ev.id) && store.results[ev.id]?.state !== 'released' && Object.keys(got.parsed.values).length) {
      released(record(ev), ev, got, null);
    }
  };

  const tick = async () => {
    if (stopped) return;
    const t = now();
    let events: CalendarEvent[];
    try {
      events = (await calendarImpl(t - KEEP_MS, t + KEEP_MS)).events;
    } catch (err) {
      opts.log?.warn({ err: (err as Error).message }, 'release watcher: no calendar');
      return;
    }
    known = new Map(events.filter((e) => e.source !== 'sosovalue' && RELEASE_FIELDS[e.short] && !e.allDay).map((e) => [e.id, e]));
    let dirty = false;
    for (const e of known.values()) {
      const r = store.results[e.id];
      if (r?.state === 'released' || r?.state === 'missed' || pollers.has(e.id)) continue;
      if (e.time - t <= AHEAD_MS && t - e.time < GIVE_UP_MS) {
        pollers.set(e.id, watch(e).finally(() => pollers.delete(e.id)));
      } else if (r && t - e.time >= GIVE_UP_MS) {
        r.state = 'missed';
        dirty = true;
      }
    }
    if (opts.prime !== false) {
      for (const short of Object.keys(RELEASE_FIELDS)) {
        const p = primed.get(short);
        if (p && (p.ok || t - p.at < PRIME_RETRY_MS)) continue;
        try {
          await prime(short, t);
          primed.set(short, { at: t, ok: true });
        } catch (err) {
          primed.set(short, { at: t, ok: false });
          opts.log?.warn({ kind: short, err: (err as Error).message }, 'release watcher: current page not read');
        }
        dirty = true;
      }
    }
    if (dirty) save();
  };

  const loop = async () => {
    while (!stopped) {
      await tick().catch((err) => opts.log?.warn({ err: (err as Error).message }, 'release watcher tick failed'));
      await sleep(opts.tickMs ?? 60_000);
    }
  };
  void loop();

  return {
    stop() {
      stopped = true;
      for (const t of timers) clearTimeout(t);
      timers.clear();
    },
    tick,
    async idle() {
      while (pollers.size) await Promise.all([...pollers.values()]);
    },
  };
}

// --- the Fed's live broadcast ------------------------------------------------------------------

export interface FedLive {
  videoId: string | null;
  name: string | null;
  /** The playback API calls it a live stream (no positive duration). */
  live: boolean;
  /** The HLS master playlist (https; its token expires). */
  hls: string | null;
  /** The audio-only rendition from the master playlist. */
  audioOnly?: string;
  /** The subtitles rendition from the master playlist, else the captions file (WebVTT). */
  captions?: string;
  poster: string | null;
}

const FED_LIVE_PAGE = 'https://www.federalreserve.gov/live-broadcast.htm';
const FED_ACCOUNT = '66043936001';

/** The Brightcove video the Fed's live-broadcast page embeds. */
export function parseFedLivePage(html: string): { videoId: string; account: string; player: string; embed: string } | null {
  const tag = /<video\b[^>]*\bdata-video-id="(\d+)"[^>]*>/i.exec(html);
  if (!tag) return null;
  const attr = (name: string) => new RegExp(`\\b${name}="([^"]+)"`).exec(tag[0])?.[1];
  return { videoId: tag[1]!, account: attr('data-account') ?? FED_ACCOUNT, player: attr('data-player') ?? 'default', embed: attr('data-embed') ?? 'default' };
}

const httpsOf = (srcs: Array<{ src?: unknown }> | undefined) => srcs?.map((s) => (typeof s.src === 'string' ? s.src : '')).find((s) => s.startsWith('https://')) ?? null;

/** The playback API's video: name, live or not, the https HLS master, poster, captions file. */
export function parseBrightcoveVideo(body: unknown): { name: string | null; live: boolean; hls: string | null; poster: string | null; vtt: string | null } {
  const v = (body ?? {}) as {
    name?: unknown;
    duration?: unknown;
    poster?: unknown;
    sources?: Array<{ src?: unknown; type?: unknown }>;
    text_tracks?: Array<{ kind?: unknown; src?: unknown; sources?: Array<{ src?: unknown }> | null }>;
  };
  const hls = httpsOf((v.sources ?? []).filter((s) => s.type === 'application/x-mpegURL'));
  const track = (v.text_tracks ?? []).find((t) => t.kind === 'captions' || t.kind === 'subtitles');
  const vtt = track ? httpsOf([...(track.sources ?? []), { src: track.src }]) : null;
  const poster = typeof v.poster === 'string' ? v.poster.replace(/^http:\/\//, 'https://') : null;
  return { name: typeof v.name === 'string' ? v.name : null, live: !(typeof v.duration === 'number' && v.duration > 0), hls, poster, vtt };
}

/** From an HLS master playlist: the audio-only and subtitles renditions (the default one of each). */
export function parseMasterPlaylist(text: string, base: string): { audioOnly?: string; captions?: string } {
  const media = text.split(/\r?\n/).filter((l) => l.startsWith('#EXT-X-MEDIA:'));
  const pick = (type: string) => {
    const lines = media.filter((l) => new RegExp(`TYPE=${type}\\b`).test(l) && /URI="/.test(l));
    const line = lines.find((l) => /DEFAULT=YES/.test(l)) ?? lines[0];
    const uri = line ? /URI="([^"]+)"/.exec(line)?.[1] : undefined;
    return uri ? new URL(uri, base).href : undefined;
  };
  const audioOnly = pick('AUDIO');
  const captions = pick('SUBTITLES');
  return { ...(audioOnly ? { audioOnly } : {}), ...(captions ? { captions } : {}) };
}

let fedPage: { at: number; embed: ReturnType<typeof parseFedLivePage> } | null = null;
let policyKey: { at: number; account: string; key: string } | null = null;
let fedVideo: { at: number; id: string; live: FedLive } | null = null;
let fedFlight: Promise<FedLive> | null = null;

/** Tests only. */
export function resetFedLive(): void {
  fedPage = policyKey = fedVideo = null;
  fedFlight = null;
}

async function getJson(url: string, fetchImpl: typeof fetch, headers: Record<string, string> = {}): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8_000);
  try {
    const res = await fetchImpl(url, { headers: { 'user-agent': UA, accept: 'application/json', ...headers }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`${new URL(url).hostname} HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The Fed's current broadcast: the live-broadcast page (read every 20 s) names
 * a Brightcove video; its player's public policy key (hourly) opens the
 * playback API (every 15 s - the manifest URLs carry expiring tokens).
 */
export async function fedLive(fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<FedLive> {
  if (fedFlight) return fedFlight;
  fedFlight = (async () => {
    if (!fedPage || now - fedPage.at > 20_000) fedPage = { at: now, embed: parseFedLivePage(await getPage(FED_LIVE_PAGE, fetchImpl, 8_000)) };
    const embed = fedPage.embed;
    if (!embed) return { videoId: null, name: null, live: false, hls: null, poster: null };
    if (fedVideo && fedVideo.id === embed.videoId && now - fedVideo.at <= 15_000) return fedVideo.live;
    if (!policyKey || policyKey.account !== embed.account || now - policyKey.at > 60 * 60_000) {
      const cfg = (await getJson(`https://players.brightcove.net/${embed.account}/${embed.player}_${embed.embed}/config.json`, fetchImpl)) as { video_cloud?: { policy_key?: unknown } };
      const key = cfg?.video_cloud?.policy_key;
      if (typeof key !== 'string' || !key) throw new Error('no policy key in the Brightcove player config');
      policyKey = { at: now, account: embed.account, key };
    }
    const video = parseBrightcoveVideo(
      await getJson(`https://edge.api.brightcove.com/playback/v1/accounts/${embed.account}/videos/${embed.videoId}`, fetchImpl, { accept: `application/json;pk=${policyKey.key}` }),
    );
    let renditions: { audioOnly?: string; captions?: string } = {};
    if (video.hls) {
      try {
        renditions = parseMasterPlaylist(await getPage(video.hls, fetchImpl, 8_000), video.hls);
      } catch {
        /* the master itself still plays */
      }
    }
    const captions = renditions.captions ?? video.vtt ?? undefined;
    const live: FedLive = {
      videoId: embed.videoId,
      name: video.name,
      live: video.live,
      hls: video.hls,
      ...(renditions.audioOnly ? { audioOnly: renditions.audioOnly } : {}),
      ...(captions ? { captions } : {}),
      poster: video.poster,
    };
    fedVideo = { at: now, id: embed.videoId, live };
    return live;
  })().finally(() => {
    fedFlight = null;
  });
  return fedFlight;
}
