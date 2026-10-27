/**
 * The history behind the calendar's figures: each indicator a release card
 * shows, as a series, from FRED (the St. Louis Fed's database, which carries
 * the agencies' own series).
 *
 *   FRED  fredgraph.csv?id=SERIES (no key): `observation_date,SERIES`, one
 *         row per period, '.' where there is no value. The level as the agency
 *         publishes it - an index, a count, a rate.
 *
 * The figures the agencies print are changes of those levels, computed here
 * the way they compute them: the percent change on the period before (m/m,
 * q/q) or on the same period a year before (y/y), to one decimal; the jobs
 * report's payrolls as the change in thousands; JOLTS in millions. The Fed's
 * target range is daily and kept only where it changes.
 *
 * Two things differ from the printed release by a tenth now and then: BLS
 * gives CPI's 12-month change from the unadjusted index (FRED's CPIAUCSL is
 * the adjusted one), and BEA computes PCE's changes from unrounded indexes
 * (FRED's have three decimals). The ECI's 12-month change is likewise from the
 * adjusted series. For September 2026 every figure matched.
 *
 * Each series is read at most every 6 hours. When the release watcher reads a
 * release of a kind (releases.ts onRelease), that kind's series are read again
 * every 15 minutes until FRED has the new period (FRED posts it a little after
 * the agency), for a day at most. The parsers are pure and covered by
 * test/indicators.test.ts on saved files.
 */
import { calendar } from './calendar.js';
import { onRelease } from './releases.js';

/** '%'; 'k' a change in thousands (+177k); 'K' a level in thousands (684k); 'M' millions; '' as is. */
export type IndicatorUnit = '%' | 'k' | 'K' | 'M' | '';
export type IndicatorFrequency = 'monthly' | 'quarterly' | 'weekly' | 'daily';
/**
 * `level` as published; `mm`/`qq` percent change on the observation before;
 * `yy` on the observation a year before; `diff` the change on the observation
 * before; `thousandths` a count in thousands as millions (or units as thousands);
 * `millionths` a count as millions; `steps` a daily level kept where it changes.
 */
export type IndicatorTransform = 'level' | 'mm' | 'qq' | 'yy' | 'diff' | 'thousandths' | 'millionths' | 'steps';

export interface Indicator {
  id: string;
  name: string;
  unit: IndicatorUnit;
  frequency: IndicatorFrequency;
  /** FRED's series id. */
  series: string;
  transform: IndicatorTransform;
  /** The calendar kind (CalendarEvent.short) whose release publishes it. */
  kind: string;
  /** Its figure on the release card (releases.ts RELEASE_FIELDS key). */
  field: string;
  /** Who publishes the series FRED carries. */
  agency: 'BLS' | 'BEA' | 'Federal Reserve' | 'Census' | 'DOL' | 'NAR' | 'University of Michigan';
  /** Decimals kept. */
  decimals: number;
}

const ind = (
  id: string,
  name: string,
  unit: IndicatorUnit,
  frequency: IndicatorFrequency,
  series: string,
  transform: IndicatorTransform,
  kind: string,
  field: string,
  agency: Indicator['agency'],
  decimals = 1,
): Indicator => ({ id, name, unit, frequency, series, transform, kind, field, agency, decimals });

/** Every indicator, by a stable id. */
export const INDICATORS: Readonly<Record<string, Indicator>> = Object.fromEntries(
  [
    ind('cpi_mm', 'CPI m/m', '%', 'monthly', 'CPIAUCSL', 'mm', 'CPI', 'cpi_mm', 'BLS'),
    ind('cpi_yy', 'CPI y/y', '%', 'monthly', 'CPIAUCSL', 'yy', 'CPI', 'cpi_yy', 'BLS'),
    ind('core_cpi_mm', 'Core CPI m/m', '%', 'monthly', 'CPILFESL', 'mm', 'CPI', 'core_mm', 'BLS'),
    ind('core_cpi_yy', 'Core CPI y/y', '%', 'monthly', 'CPILFESL', 'yy', 'CPI', 'core_yy', 'BLS'),
    ind('payrolls', 'Nonfarm payrolls', 'k', 'monthly', 'PAYEMS', 'diff', 'NFP', 'payrolls', 'BLS', 0),
    ind('unemployment', 'Unemployment rate', '%', 'monthly', 'UNRATE', 'level', 'NFP', 'unemployment', 'BLS'),
    ind('ahe_mm', 'Avg hourly earnings m/m', '%', 'monthly', 'CES0500000003', 'mm', 'NFP', 'ahe_mm', 'BLS'),
    ind('ahe_yy', 'Avg hourly earnings y/y', '%', 'monthly', 'CES0500000003', 'yy', 'NFP', 'ahe_yy', 'BLS'),
    ind('ppi_mm', 'PPI m/m', '%', 'monthly', 'PPIFIS', 'mm', 'PPI', 'ppi_mm', 'BLS'),
    ind('ppi_yy', 'PPI y/y', '%', 'monthly', 'PPIFIS', 'yy', 'PPI', 'ppi_yy', 'BLS'),
    ind('pce_mm', 'PCE prices m/m', '%', 'monthly', 'PCEPI', 'mm', 'PCE', 'pce_mm', 'BEA'),
    ind('pce_yy', 'PCE prices y/y', '%', 'monthly', 'PCEPI', 'yy', 'PCE', 'pce_yy', 'BEA'),
    ind('core_pce_mm', 'Core PCE m/m', '%', 'monthly', 'PCEPILFE', 'mm', 'PCE', 'core_mm', 'BEA'),
    ind('core_pce_yy', 'Core PCE y/y', '%', 'monthly', 'PCEPILFE', 'yy', 'PCE', 'core_yy', 'BEA'),
    ind('gdp', 'Real GDP (annual rate)', '%', 'quarterly', 'A191RL1Q225SBEA', 'level', 'GDP', 'gdp', 'BEA'),
    ind('jolts', 'Job openings (millions)', 'M', 'monthly', 'JTSJOL', 'thousandths', 'JOLTS', 'openings', 'BLS', 3),
    ind('eci_qq', 'ECI q/q', '%', 'quarterly', 'ECIALLCIV', 'qq', 'ECI', 'eci_qq', 'BLS'),
    ind('eci_yy', 'ECI y/y', '%', 'quarterly', 'ECIALLCIV', 'yy', 'ECI', 'eci_yy', 'BLS'),
    ind('fed_upper', 'Fed funds target, upper bound', '%', 'daily', 'DFEDTARU', 'steps', 'FOMC', 'range', 'Federal Reserve', 2),
    ind('fed_lower', 'Fed funds target, lower bound', '%', 'daily', 'DFEDTARL', 'steps', 'FOMC', 'range', 'Federal Reserve', 2),
    // The releases SoSoValue's calendar names (calendar.ts sosoIndicators): no official card, a chart.
    ind('new_home_sales', 'New home sales (annual rate)', 'K', 'monthly', 'HSN1F', 'level', 'Housing', 'new_home_sales', 'Census', 0),
    ind('existing_home_sales', 'Existing home sales (annual rate)', 'M', 'monthly', 'EXHOSLUSM495S', 'millionths', 'Housing', 'existing_home_sales', 'NAR', 2),
    ind('housing_starts', 'Housing starts (annual rate)', 'K', 'monthly', 'HOUST', 'level', 'Housing', 'housing_starts', 'Census', 0),
    ind('building_permits', 'Building permits (annual rate)', 'K', 'monthly', 'PERMIT', 'level', 'Housing', 'building_permits', 'Census', 0),
    ind('retail_mm', 'Retail sales m/m', '%', 'monthly', 'RSAFS', 'mm', 'Retail', 'retail_mm', 'Census'),
    ind('retail_ex_auto_mm', 'Retail sales ex autos m/m', '%', 'monthly', 'RSFSXMV', 'mm', 'Retail', 'retail_ex_auto_mm', 'Census'),
    ind('initial_claims', 'Initial jobless claims', 'K', 'weekly', 'ICSA', 'thousandths', 'Claims', 'initial_claims', 'DOL', 0),
    ind('continuing_claims', 'Continuing jobless claims', 'K', 'weekly', 'CCSA', 'thousandths', 'Claims', 'continuing_claims', 'DOL', 0),
    ind('umich_sentiment', 'Michigan consumer sentiment', '', 'monthly', 'UMCSENT', 'level', 'Sentiment', 'umich_sentiment', 'University of Michigan'),
    ind('ip_mm', 'Industrial production m/m', '%', 'monthly', 'INDPRO', 'mm', 'IP', 'ip_mm', 'Federal Reserve'),
    ind('durables_mm', 'Durable goods orders m/m', '%', 'monthly', 'DGORDER', 'mm', 'Durables', 'durables_mm', 'Census'),
  ].map((i) => [i.id, i]),
);

const UA = 'ValueDesk economic calendar (+https://www.valuedesk.so)';
const FRED_CSV = 'https://fred.stlouisfed.org/graph/fredgraph.csv?id=';
const CACHE_MS = 6 * 60 * 60_000;
/** After a release of its kind: how often a series is read again, and for how long at most. */
const AFTER_RELEASE_MS = 15 * 60_000;
const AFTER_RELEASE_FOR_MS = 24 * 60 * 60_000;
/** A series that failed is not asked again for this long (its last copy is served meanwhile). */
const RETRY_MS = 5 * 60_000;
const TIMEOUT_MS = 15_000;
const TABLE_ROWS = 24;

// --- parsing --------------------------------------------------------------------------

/** One observation: its date (YYYY-MM-DD, the period's first day) and value. */
export type Observation = [date: string, value: number];

/** FRED's CSV: `observation_date,SERIES` then a row per period; '.' (no value) is left out. */
export function parseFredCsv(text: string): Observation[] {
  const lines = text.replace(/\r/g, '').trim().split('\n');
  if (!/^observation_date,/i.test(lines[0] ?? '') && !/^DATE,/i.test(lines[0] ?? '')) throw new Error('not a FRED series file');
  const out: Observation[] = [];
  for (const line of lines.slice(1)) {
    const [date, raw] = line.split(',');
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || raw === undefined) continue;
    const v = raw.trim() === '.' || raw.trim() === '' ? Number.NaN : Number(raw);
    if (Number.isFinite(v)) out.push([date, v]);
  }
  return out;
}

const round = (v: number, d: number) => {
  const f = 10 ** d;
  // Half away from zero, after removing float noise (0.35 * 10 is 3.4999...).
  const r = (Math.sign(v) * Math.round(Number((Math.abs(v) * f).toPrecision(12)))) / f;
  return r === 0 ? 0 : r;
};

const yearBefore = (date: string) => `${Number(date.slice(0, 4)) - 1}${date.slice(4)}`;
/** Calendar months from one observation's date to another's. */
const monthsBetween = (a: string, b: string) => (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + Number(b.slice(5, 7)) - Number(a.slice(5, 7));
const daysBetween = (a: string, b: string) => (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000;

/** The indicator's values from its series' observations, oldest first. */
export function transform(obs: readonly Observation[], i: Pick<Indicator, 'transform' | 'decimals'>): Observation[] {
  const out: Observation[] = [];
  const d = i.decimals;
  switch (i.transform) {
    case 'level':
      for (const [t, v] of obs) out.push([t, round(v, d)]);
      break;
    case 'thousandths':
      for (const [t, v] of obs) out.push([t, round(v / 1000, d)]);
      break;
    case 'millionths':
      for (const [t, v] of obs) out.push([t, round(v / 1_000_000, d)]);
      break;
    // A change is on the period just before: a period never published (October 2025's
    // CPI) leaves the next one without a change rather than a two-period one.
    case 'mm':
    case 'qq': {
      const step = i.transform === 'mm' ? 1 : 3;
      for (let k = 1; k < obs.length; k++) {
        if (monthsBetween(obs[k - 1]![0], obs[k]![0]) !== step) continue;
        out.push([obs[k]![0], round((obs[k]![1] / obs[k - 1]![1] - 1) * 100, d)]);
      }
      break;
    }
    case 'diff': {
      // The series' own step is its shortest gap (a month of 28 days, a week).
      let gap = Infinity;
      for (let k = 1; k < obs.length; k++) gap = Math.min(gap, daysBetween(obs[k - 1]![0], obs[k]![0]));
      for (let k = 1; k < obs.length; k++) {
        if (daysBetween(obs[k - 1]![0], obs[k]![0]) > gap * 1.5) continue;
        out.push([obs[k]![0], round(obs[k]![1] - obs[k - 1]![1], d)]);
      }
      break;
    }
    case 'yy': {
      const by = new Map(obs.map(([t, v]) => [t, v]));
      for (const [t, v] of obs) {
        const before = by.get(yearBefore(t));
        if (before) out.push([t, round((v / before - 1) * 100, d)]);
      }
      break;
    }
    case 'steps':
      // Where it changes, and the newest day, so a chart runs to today.
      obs.forEach(([t, v], k) => {
        if (k === 0 || v !== obs[k - 1]![1] || k === obs.length - 1) out.push([t, round(v, d)]);
      });
      break;
  }
  return out;
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** What an observation covers, as the agencies say it: "September 2026", "Q2 2026", "2026-10-24". */
export function periodLabel(date: string, frequency: IndicatorFrequency): string {
  const y = date.slice(0, 4);
  const m = Number(date.slice(5, 7));
  if (frequency === 'daily') return date;
  if (frequency === 'weekly') return `Week of ${date}`;
  if (frequency === 'quarterly') return `Q${Math.floor((m - 1) / 3) + 1} ${y}`;
  return `${MONTH_NAMES[m - 1]} ${y}`;
}

export type IndicatorRange = '1y' | '5y' | '10y' | 'max';
export const INDICATOR_RANGES: readonly IndicatorRange[] = ['1y', '5y', '10y', 'max'];
const RANGE_YEARS: Record<IndicatorRange, number> = { '1y': 1, '5y': 5, '10y': 10, max: Infinity };

const dayMs = (date: string) => Date.parse(`${date}T00:00:00Z`);

export interface IndicatorRow {
  period: string;
  value: number;
  prior: number | null;
}

/** The route's figures from a series: the chart's points over `range`, the table (newest first) and the latest. */
export function indicatorView(obs: readonly Observation[], i: Indicator, range: IndicatorRange): { points: Array<[number, number]>; table: IndicatorRow[]; latest: IndicatorRow | null } {
  const values = transform(obs, i);
  const last = values.at(-1);
  // The range counts back from the newest observation, a year being 12 months (a quarter's first day included).
  const from = last && RANGE_YEARS[range] !== Infinity ? dayMs(`${Number(last[0].slice(0, 4)) - RANGE_YEARS[range]}${last[0].slice(4)}`) : -Infinity;
  const points = values.filter(([t]) => dayMs(t) >= from).map(([t, v]) => [dayMs(t), v] as [number, number]);
  // A step's level when the range opens: the one in force then, from the range's first day.
  const before = values.findLast(([t]) => dayMs(t) < from);
  if (i.transform === 'steps' && before && points[0]?.[0] !== from) points.unshift([from, before[1]]);
  // The table of a step series is its changes (not the newest day that ends the chart).
  const rows = i.transform === 'steps' ? values.filter(([, v], k) => k === 0 || v !== values[k - 1]![1]) : values;
  const table: IndicatorRow[] = [];
  for (let k = rows.length - 1; k >= 0 && table.length < TABLE_ROWS; k--) {
    table.push({ period: periodLabel(rows[k]![0], i.frequency), value: rows[k]![1], prior: k > 0 ? rows[k - 1]![1] : null });
  }
  return { points, table, latest: table[0] ?? null };
}

// --- reading FRED ----------------------------------------------------------------------

interface SeriesState {
  at: number;
  failedAt: number;
  obs: Observation[];
}
const series = new Map<string, SeriesState>();
const inflight = new Map<string, Promise<void>>();
/** Per kind, when the watcher read a release of it, and the newest observation each of its series had then. */
const released = new Map<string, { at: number; newest: Map<string, string | null> }>();

/** Tests only. */
export function resetIndicators(): void {
  series.clear();
  inflight.clear();
  released.clear();
}

const seriesOfKind = (kind: string) => [...new Set(Object.values(INDICATORS).filter((i) => i.kind === kind).map((i) => i.series))];

/**
 * A release of `kind` was read: its series are read again soon, and every 15
 * minutes until FRED has a newer period than now (a day at most).
 */
export function indicatorReleased(kind: string, now = Date.now()): void {
  const ids = seriesOfKind(kind);
  if (!ids.length) return;
  released.set(kind, { at: now, newest: new Map(ids.map((id) => [id, series.get(id)?.obs.at(-1)?.[0] ?? null])) });
}

onRelease((kind) => indicatorReleased(kind));

/** How long a series' copy is good for: 6 hours, or 15 minutes while a release of its kind is not on FRED yet. */
function freshFor(id: string, s: SeriesState, now: number): number {
  for (const [kind, r] of released) {
    if (now - r.at > AFTER_RELEASE_FOR_MS) {
      released.delete(kind);
      continue;
    }
    if (!r.newest.has(id)) continue;
    // A copy from before the release is stale now.
    if (s.at < r.at) return 0;
    // Nothing newer than at the release yet (or nothing was held then to tell): again in 15 minutes.
    const before = r.newest.get(id) ?? null;
    if (before === null || (s.obs.at(-1)?.[0] ?? null) === before) return AFTER_RELEASE_MS;
  }
  return CACHE_MS;
}

async function getCsv(url: string, fetchImpl: typeof fetch): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { headers: { 'user-agent': UA, accept: 'text/csv,*/*' }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`FRED HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/** A FRED series, cached; a read that fails keeps the last copy. Throws only when there is none. */
export async function fredSeries(id: string, fetchImpl: typeof fetch = fetch): Promise<SeriesState> {
  const now = Date.now();
  const s = series.get(id);
  const stale = !s || now - s.at >= freshFor(id, s, now);
  if (stale && !(s && now - s.failedAt < RETRY_MS)) {
    let flight = inflight.get(id);
    if (!flight) {
      flight = (async () => {
        try {
          const obs = parseFredCsv(await getCsv(`${FRED_CSV}${encodeURIComponent(id)}`, fetchImpl));
          if (!obs.length) throw new Error('no observations');
          series.set(id, { at: Date.now(), failedAt: 0, obs });
        } catch (e) {
          if (!s) throw e;
          series.set(id, { ...s, failedAt: Date.now() });
        }
      })().finally(() => inflight.delete(id));
      inflight.set(id, flight);
    }
    await flight;
  }
  const got = series.get(id);
  if (!got) throw new Error(`FRED series ${id} not read`);
  return got;
}

// --- the routes' answers ---------------------------------------------------------------

export interface IndicatorListing {
  id: string;
  name: string;
  unit: IndicatorUnit;
  frequency: IndicatorFrequency;
  kind: string;
  field: string;
}

export const indicatorList = (): IndicatorListing[] =>
  Object.values(INDICATORS).map(({ id, name, unit, frequency, kind, field }) => ({ id, name, unit, frequency, kind, field }));

export interface IndicatorPage {
  id: string;
  name: string;
  unit: IndicatorUnit;
  frequency: IndicatorFrequency;
  kind: string;
  field: string;
  source: { name: string; series: string; href: string };
  /** [ms of the period's first day, value], oldest first. */
  points: Array<[number, number]>;
  /** Newest first, the last 24 periods. */
  table: IndicatorRow[];
  latest: IndicatorRow | null;
  /** The next release of its kind on the calendar. */
  next: { time: number; eventId: string } | null;
  /** When this server last read the series from FRED. */
  updatedAt: number;
}

export const parseIndicatorRange = (v: unknown): IndicatorRange => (INDICATOR_RANGES as readonly unknown[]).includes(v) ? (v as IndicatorRange) : '5y';

/** The next official release of a kind after `now`, from the calendar; null when it cannot say. */
async function nextRelease(kind: string, now: number, calendarImpl: typeof calendar): Promise<IndicatorPage['next']> {
  try {
    const { events } = await calendarImpl(now, now + 400 * 86_400_000);
    const e = events.find((x) => x.short === kind && x.source !== 'sosovalue' && x.time > now);
    return e ? { time: e.time, eventId: e.id } : null;
  } catch {
    return null;
  }
}

/** One indicator for the route; null for an id not in the catalog. */
export async function indicator(id: string, range: IndicatorRange, opts: { fetchImpl?: typeof fetch; calendarImpl?: typeof calendar; now?: number } = {}): Promise<IndicatorPage | null> {
  const i = INDICATORS[id];
  if (!i) return null;
  const now = opts.now ?? Date.now();
  const [s, next] = await Promise.all([fredSeries(i.series, opts.fetchImpl), nextRelease(i.kind, now, opts.calendarImpl ?? calendar)]);
  const view = indicatorView(s.obs, i, range);
  return {
    id: i.id,
    name: i.name,
    unit: i.unit,
    frequency: i.frequency,
    kind: i.kind,
    field: i.field,
    source: { name: `FRED (${i.agency})`, series: i.series, href: `https://fred.stlouisfed.org/series/${i.series}` },
    ...view,
    next,
    updatedAt: s.at,
  };
}
