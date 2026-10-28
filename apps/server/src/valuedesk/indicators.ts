/**
 * The history behind the calendar's figures: each indicator a release card
 * shows, as a series, read from the agency that publishes it (all of it US
 * government work, public domain). No FRED: its terms license downloads for
 * personal, non-commercial use only.
 *
 *   BLS     Public Data API v2 (api.bls.gov/publicAPI/v2/timeseries/data/,
 *           POST): CPI, core CPI, payrolls, unemployment, hourly earnings,
 *           PPI final demand, JOLTS openings, ECI - all eight in one request.
 *           Without BLS_API_KEY: 25 requests a day, 10 years a request; with
 *           it 500 and 20. The history is read once (10- or 20-year pieces),
 *           then only the newest piece; a day's requests are counted and kept
 *           under the limit (a read past it keeps the last copy).
 *   BEA     NIPA API (apps.bea.gov/api/data, needs BEA_API_KEY, free): table
 *           T20804 (PCE and core PCE price indexes, monthly) and T10101 (real
 *           GDP, percent change at annual rate). The history once, then the
 *           last six years. Without the key the PCE and GDP indicators are not
 *           read (the route answers upstream, as for any read that fails).
 *   Census  each survey's own download (www.census.gov/econ_getzippedfile/,
 *           a zip of one CSV, no key): RESSALES (new home sales), RESCONST
 *           (starts, permits), MARTS (retail sales), M3ADV (durable goods).
 *           The API (api.census.gov/data/timeseries/eits) wants a key now.
 *   DOL     ETA's weekly claims report (oui.doleta.gov/unemploy/wkclaims/
 *           report.asp, XML, no key): initial and continued claims, SA.
 *   Fed     the Board's own pages: the FOMC's target range from the open
 *           market operations page (monetarypolicy/openmarket.htm, each change
 *           with its effective date), industrial production from the G.17's
 *           Data Download Program CSV (series IP.B50001.S).
 *
 * Every series is the one FRED carried (seasonally adjusted where its was);
 * the figures are computed here the way the agencies compute them: the
 * percent change on the period before (m/m, q/q) or on the same period a year
 * before (y/y), to one decimal; the jobs report's payrolls as the change in
 * thousands; JOLTS in millions. The Fed's target range is kept where it
 * changes, and today.
 *
 * Two things differ from the printed release by a tenth now and then: BLS
 * gives CPI's 12-month change from the unadjusted index (CUSR0000SA0 is the
 * adjusted one), and BEA computes PCE's changes from unrounded indexes (the
 * API's have three decimals). The ECI's 12-month change is likewise from the
 * adjusted series.
 *
 * Michigan sentiment (University of Michigan) and existing home sales (NAR)
 * are not here: both are copyrighted, and neither licenses display on a
 * commercial site.
 *
 * Each source is read at most every 6 hours. When the release watcher reads a
 * release of a kind (releases.ts onRelease), the sources of that kind's
 * series are read again every 15 minutes until the new period is out, for a
 * day at most. The parsers are pure and covered by test/indicators.test.ts on
 * saved files.
 */
import { inflateRawSync } from 'node:zlib';
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
export type Agency = 'BLS' | 'BEA' | 'Federal Reserve' | 'Census' | 'DOL';

export interface Indicator {
  id: string;
  name: string;
  unit: IndicatorUnit;
  frequency: IndicatorFrequency;
  /** The series' key in SERIES. */
  series: string;
  transform: IndicatorTransform;
  /** The calendar kind (CalendarEvent.short) whose release publishes it. */
  kind: string;
  /** Its figure on the release card (releases.ts RELEASE_FIELDS key). */
  field: string;
  /** Who publishes it (SERIES[series].agency). */
  agency: Agency;
  /** Decimals kept. */
  decimals: number;
}

// --- the series and where they come from -----------------------------------------------

/** Where a series is read: one request (or file) gives every series of its source. */
export type SourceId = 'bls' | 'bea-T20804' | 'bea-T10101' | 'census-RESSALES' | 'census-RESCONST' | 'census-MARTS' | 'census-M3ADV' | 'dol-claims' | 'fed-target' | 'fed-g17';

export interface SeriesInfo {
  source: SourceId;
  agency: Agency;
  /** As the route names it (`source.series`). */
  label: string;
  /** The agency's own page for it. */
  href: string;
}

const bls = (id: string): SeriesInfo => ({ source: 'bls', agency: 'BLS', label: id, href: `https://data.bls.gov/timeseries/${id}` });
const census = (program: 'RESSALES' | 'RESCONST' | 'MARTS' | 'M3ADV', cat: string, dt: string): [string, SeriesInfo] => [
  `${program}/${cat}/${dt}`,
  {
    source: `census-${program}`,
    agency: 'Census',
    label: `${program} ${cat} ${dt}`,
    href: `https://www.census.gov/econ/currentdata/dbsearch?programCode=${program}&categories%5B%5D=${encodeURIComponent(cat)}&dataType=${dt}&geoLevel=US&adjusted=1&notAdjusted=0&errorData=0`,
  },
];

/** Every series an indicator is computed from, by key. */
export const SERIES: Readonly<Record<string, SeriesInfo>> = {
  // CPI-U all items and less food and energy, SA (FRED's CPIAUCSL, CPILFESL).
  CUSR0000SA0: bls('CUSR0000SA0'),
  CUSR0000SA0L1E: bls('CUSR0000SA0L1E'),
  // Total nonfarm payrolls (PAYEMS), unemployment rate (UNRATE), private average hourly earnings (CES0500000003).
  CES0000000001: bls('CES0000000001'),
  LNS14000000: bls('LNS14000000'),
  CES0500000003: bls('CES0500000003'),
  // PPI final demand, SA (PPIFIS); JOLTS job openings (JTSJOL); ECI total compensation, civilian, SA index (ECIALLCIV).
  WPSFD4: bls('WPSFD4'),
  JTS000000000000000JOL: bls('JTS000000000000000JOL'),
  CIS1010000000000I: bls('CIS1010000000000I'),
  // NIPA table 2.8.4 line 1 and the line for PCE less food and energy (PCEPI, PCEPILFE); table 1.1.1 line 1 (A191RL1Q225SBEA).
  DPCERG: { source: 'bea-T20804', agency: 'BEA', label: 'T20804 DPCERG', href: 'https://www.bea.gov/data/personal-consumption-expenditures-price-index' },
  DPCCRG: { source: 'bea-T20804', agency: 'BEA', label: 'T20804 DPCCRG', href: 'https://www.bea.gov/data/personal-consumption-expenditures-price-index-excluding-food-and-energy' },
  A191RL: { source: 'bea-T10101', agency: 'BEA', label: 'T10101 A191RL', href: 'https://www.bea.gov/data/gdp/gross-domestic-product' },
  // FOMC target range (DFEDTARU, DFEDTARL); industrial production, total index, SA (INDPRO).
  'target/upper': { source: 'fed-target', agency: 'Federal Reserve', label: 'Target range, upper limit', href: 'https://www.federalreserve.gov/monetarypolicy/openmarket.htm' },
  'target/lower': { source: 'fed-target', agency: 'Federal Reserve', label: 'Target range, lower limit', href: 'https://www.federalreserve.gov/monetarypolicy/openmarket.htm' },
  'IP.B50001.S': { source: 'fed-g17', agency: 'Federal Reserve', label: 'G.17 IP.B50001.S', href: 'https://www.federalreserve.gov/releases/g17/current/default.htm' },
  // New home sales (HSN1F), starts (HOUST), permits (PERMIT), retail sales (RSAFS, RSFSXMV), durable goods orders (DGORDER): annual rates / SA.
  ...Object.fromEntries([
    census('RESSALES', 'ASOLD', 'TOTAL'),
    census('RESCONST', 'ASTARTS', 'TOTAL'),
    census('RESCONST', 'APERMITS', 'TOTAL'),
    census('MARTS', '44X72', 'SM'),
    census('MARTS', '44Y72', 'SM'),
    census('M3ADV', 'MDM', 'NO'),
  ]),
  // Initial and continued weeks claimed, SA (ICSA, CCSA).
  'claims/initial': { source: 'dol-claims', agency: 'DOL', label: 'Initial claims, SA', href: 'https://oui.doleta.gov/unemploy/claims.asp' },
  'claims/continued': { source: 'dol-claims', agency: 'DOL', label: 'Continued claims, SA', href: 'https://oui.doleta.gov/unemploy/claims.asp' },
};

const ind = (
  id: string,
  name: string,
  unit: IndicatorUnit,
  frequency: IndicatorFrequency,
  series: string,
  transform: IndicatorTransform,
  kind: string,
  field: string,
  decimals = 1,
): Indicator => ({ id, name, unit, frequency, series, transform, kind, field, agency: SERIES[series]!.agency, decimals });

/** Every indicator, by a stable id. */
export const INDICATORS: Readonly<Record<string, Indicator>> = Object.fromEntries(
  [
    ind('cpi_mm', 'CPI m/m', '%', 'monthly', 'CUSR0000SA0', 'mm', 'CPI', 'cpi_mm'),
    ind('cpi_yy', 'CPI y/y', '%', 'monthly', 'CUSR0000SA0', 'yy', 'CPI', 'cpi_yy'),
    ind('core_cpi_mm', 'Core CPI m/m', '%', 'monthly', 'CUSR0000SA0L1E', 'mm', 'CPI', 'core_mm'),
    ind('core_cpi_yy', 'Core CPI y/y', '%', 'monthly', 'CUSR0000SA0L1E', 'yy', 'CPI', 'core_yy'),
    ind('payrolls', 'Nonfarm payrolls', 'k', 'monthly', 'CES0000000001', 'diff', 'NFP', 'payrolls', 0),
    ind('unemployment', 'Unemployment rate', '%', 'monthly', 'LNS14000000', 'level', 'NFP', 'unemployment'),
    ind('ahe_mm', 'Avg hourly earnings m/m', '%', 'monthly', 'CES0500000003', 'mm', 'NFP', 'ahe_mm'),
    ind('ahe_yy', 'Avg hourly earnings y/y', '%', 'monthly', 'CES0500000003', 'yy', 'NFP', 'ahe_yy'),
    ind('ppi_mm', 'PPI m/m', '%', 'monthly', 'WPSFD4', 'mm', 'PPI', 'ppi_mm'),
    ind('ppi_yy', 'PPI y/y', '%', 'monthly', 'WPSFD4', 'yy', 'PPI', 'ppi_yy'),
    ind('pce_mm', 'PCE prices m/m', '%', 'monthly', 'DPCERG', 'mm', 'PCE', 'pce_mm'),
    ind('pce_yy', 'PCE prices y/y', '%', 'monthly', 'DPCERG', 'yy', 'PCE', 'pce_yy'),
    ind('core_pce_mm', 'Core PCE m/m', '%', 'monthly', 'DPCCRG', 'mm', 'PCE', 'core_mm'),
    ind('core_pce_yy', 'Core PCE y/y', '%', 'monthly', 'DPCCRG', 'yy', 'PCE', 'core_yy'),
    ind('gdp', 'Real GDP (annual rate)', '%', 'quarterly', 'A191RL', 'level', 'GDP', 'gdp'),
    ind('jolts', 'Job openings (millions)', 'M', 'monthly', 'JTS000000000000000JOL', 'thousandths', 'JOLTS', 'openings', 3),
    ind('eci_qq', 'ECI q/q', '%', 'quarterly', 'CIS1010000000000I', 'qq', 'ECI', 'eci_qq'),
    ind('eci_yy', 'ECI y/y', '%', 'quarterly', 'CIS1010000000000I', 'yy', 'ECI', 'eci_yy'),
    ind('fed_upper', 'Fed funds target, upper bound', '%', 'daily', 'target/upper', 'steps', 'FOMC', 'range', 2),
    ind('fed_lower', 'Fed funds target, lower bound', '%', 'daily', 'target/lower', 'steps', 'FOMC', 'range', 2),
    // The releases SoSoValue's calendar names (calendar.ts sosoIndicators): no official card, a chart.
    ind('new_home_sales', 'New home sales (annual rate)', 'K', 'monthly', 'RESSALES/ASOLD/TOTAL', 'level', 'Housing', 'new_home_sales', 0),
    ind('housing_starts', 'Housing starts (annual rate)', 'K', 'monthly', 'RESCONST/ASTARTS/TOTAL', 'level', 'Housing', 'housing_starts', 0),
    ind('building_permits', 'Building permits (annual rate)', 'K', 'monthly', 'RESCONST/APERMITS/TOTAL', 'level', 'Housing', 'building_permits', 0),
    ind('retail_mm', 'Retail sales m/m', '%', 'monthly', 'MARTS/44X72/SM', 'mm', 'Retail', 'retail_mm'),
    ind('retail_ex_auto_mm', 'Retail sales ex autos m/m', '%', 'monthly', 'MARTS/44Y72/SM', 'mm', 'Retail', 'retail_ex_auto_mm'),
    ind('initial_claims', 'Initial jobless claims', 'K', 'weekly', 'claims/initial', 'thousandths', 'Claims', 'initial_claims', 0),
    ind('continuing_claims', 'Continuing jobless claims', 'K', 'weekly', 'claims/continued', 'thousandths', 'Claims', 'continuing_claims', 0),
    ind('ip_mm', 'Industrial production m/m', '%', 'monthly', 'IP.B50001.S', 'mm', 'IP', 'ip_mm'),
    ind('durables_mm', 'Durable goods orders m/m', '%', 'monthly', 'M3ADV/MDM/NO', 'mm', 'Durables', 'durables_mm'),
  ].map((i) => [i.id, i]),
);

const UA = 'ValueDesk economic calendar (+https://www.valuedesk.so)';
const BLS_API = 'https://api.bls.gov/publicAPI/v2/timeseries/data/';
const BEA_API = 'https://apps.bea.gov/api/data/';
const CENSUS_ZIP = 'https://www.census.gov/econ_getzippedfile/?programCode=';
const DOL_CLAIMS = 'https://oui.doleta.gov/unemploy/wkclaims/report.asp';
const FED_TARGETS = 'https://www.federalreserve.gov/monetarypolicy/openmarket.htm';
/** G.17's "Major IP and Capacity Utilization Aggregates" package, every observation. */
const FED_G17 = 'https://www.federalreserve.gov/datadownload/Output.aspx?rel=G17&series=403cc340ea3a19566b30770b9e4793ab&lastobs=&from=&to=&filetype=csv&label=include&layout=seriescolumn';
/** The oldest year any BLS series here has (payrolls, 1939). */
const BLS_FIRST_YEAR = 1939;
const BEA_RECENT_YEARS = 6;
const DOL_FIRST_YEAR = 1967;
const DOL_RECENT_YEARS = 6;
const CACHE_MS = 6 * 60 * 60_000;
/** After a release of its kind: how often a source is read again, and for how long at most. */
const AFTER_RELEASE_MS = 15 * 60_000;
const AFTER_RELEASE_FOR_MS = 24 * 60 * 60_000;
/** A source that failed is not asked again for this long (its last copy is served meanwhile). */
const RETRY_MS = 5 * 60_000;
const TIMEOUT_MS = 15_000;
/** A whole history (BEA's tables, DOL since 1967) is a few megabytes. */
const HISTORY_TIMEOUT_MS = 60_000;
const TABLE_ROWS = 24;

const blsKey = () => process.env.BLS_API_KEY?.trim() || '';
const beaKey = () => process.env.BEA_API_KEY?.trim() || '';

// --- parsing --------------------------------------------------------------------------

/** One observation: its date (YYYY-MM-DD, the period's first day; a week's last day) and value. */
export type Observation = [date: string, value: number];

const num = (raw: unknown): number => {
  const s = String(raw ?? '').replace(/,/g, '').trim();
  return s === '' || !/^-?\d*\.?\d+(e-?\d+)?$/i.test(s) ? Number.NaN : Number(s);
};
const byDate = (a: Observation, b: Observation) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
const pad2 = (n: number) => String(n).padStart(2, '0');
const quarterStart = (q: number) => pad2(q * 3 - 2);

/** BLS API v2's answer: each series' monthly (M01-M12) or quarterly (Q01-Q04) values; annual averages and '-' left out. */
export function parseBls(json: unknown): Map<string, Observation[]> {
  const j = json as { status?: string; message?: string[]; Results?: { series?: Array<{ seriesID?: string; data?: Array<{ year?: string; period?: string; value?: string }> }> } };
  if (j?.status !== 'REQUEST_SUCCEEDED' || !Array.isArray(j.Results?.series)) throw new Error(`BLS: ${j?.message?.join('; ') || j?.status || 'not a BLS answer'}`);
  const out = new Map<string, Observation[]>();
  for (const s of j.Results.series) {
    if (!s.seriesID) continue;
    const obs: Observation[] = [];
    for (const d of s.data ?? []) {
      const m = /^([MQ])(\d\d)$/.exec(d.period ?? '');
      const v = num(d.value);
      if (!m || !/^\d{4}$/.test(d.year ?? '') || !Number.isFinite(v)) continue;
      const k = Number(m[2]);
      if (m[1] === 'M' ? k < 1 || k > 12 : k < 1 || k > 4) continue;
      obs.push([`${d.year}-${m[1] === 'M' ? pad2(k) : quarterStart(k)}-01`, v]);
    }
    out.set(s.seriesID, obs.sort(byDate));
  }
  return out;
}

/** BEA's NIPA GetData answer: the values of each SeriesCode (2026M08, 2026Q2), commas removed. */
export function parseBea(json: unknown): Map<string, Observation[]> {
  const api = (json as { BEAAPI?: { Results?: unknown } })?.BEAAPI;
  const results = (Array.isArray(api?.Results) ? api.Results[0] : api?.Results) as { Data?: Array<Record<string, string>>; Error?: { APIErrorDescription?: string } } | undefined;
  if (!results || !Array.isArray(results.Data)) throw new Error(`BEA: ${results?.Error?.APIErrorDescription ?? 'not a BEA answer'}`);
  const out = new Map<string, Observation[]>();
  for (const d of results.Data) {
    const m = /^(\d{4})(?:M(\d\d)|Q([1-4]))$/.exec(d.TimePeriod ?? '');
    const v = num(d.DataValue);
    if (!m || !d.SeriesCode || !Number.isFinite(v)) continue;
    const date = `${m[1]}-${m[2] ?? quarterStart(Number(m[3]))}-01`;
    let list = out.get(d.SeriesCode);
    if (!list) out.set(d.SeriesCode, (list = []));
    list.push([date, v]);
  }
  for (const list of out.values()) list.sort(byDate);
  return out;
}

const MONTHS: Record<string, string> = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };

/**
 * One Census survey's CSV (econ_getzippedfile): sections split by a blank line
 * (CATEGORIES, DATA TYPES, GEO LEVELS, TIME PERIODS, DATA ...), the DATA rows
 * by index. The seasonally adjusted US total of each category/data type, keyed
 * `CAT/DT`; standard errors left out.
 */
export function parseCensus(text: string): Map<string, Observation[]> {
  const sections = new Map<string, string[][]>();
  for (const block of text.replace(/\r/g, '').split(/\n\s*\n/)) {
    const lines = block.trim().split('\n');
    if (lines.length < 2) continue;
    sections.set(lines[0]!.trim().toUpperCase(), lines.slice(1).map((l) => l.split(',').map((c) => c.trim().replace(/^"|"$/g, ''))));
  }
  const data = sections.get('DATA');
  if (!data || !sections.get('CATEGORIES') || !sections.get('TIME PERIODS')) throw new Error('not a Census time series file');
  const table = (name: string) => new Map((sections.get(name) ?? []).slice(1).map((r) => [r[0]!, r[1]!]));
  const cats = table('CATEGORIES');
  const types = table('DATA TYPES');
  const geos = table('GEO LEVELS');
  const periods = new Map<string, string>();
  for (const [idx, name] of table('TIME PERIODS')) {
    const m = /^([A-Z][a-z]{2})-(\d{4})$/.exec(name ?? '');
    if (m && MONTHS[m[1]!]) periods.set(idx, `${m[2]}-${MONTHS[m[1]!]}-01`);
  }
  const head = data[0]!;
  const col = (n: string) => head.indexOf(n);
  const [cP, cC, cD, cE, cG, cA, cV] = ['per_idx', 'cat_idx', 'dt_idx', 'et_idx', 'geo_idx', 'is_adj', 'val'].map(col) as [number, number, number, number, number, number, number];
  if (cP < 0 || cC < 0 || cD < 0 || cV < 0 || cA < 0) throw new Error('not a Census time series file');
  const out = new Map<string, Observation[]>();
  for (const r of data.slice(1)) {
    if (r[cA] !== '1' || (cE >= 0 && r[cE] !== '0') || (cG >= 0 && geos.get(r[cG]!) !== 'US')) continue;
    const date = periods.get(r[cP]!);
    const v = num(r[cV]);
    const key = `${cats.get(r[cC]!)}/${types.get(r[cD]!)}`;
    if (!date || !Number.isFinite(v)) continue;
    let list = out.get(key);
    if (!list) out.set(key, (list = []));
    list.push([date, v]);
  }
  for (const list of out.values()) list.sort(byDate);
  return out;
}

/** The first `.csv` (else the first file) of a zip, read from its central directory (stored or deflated). */
export function unzipFirst(buf: Uint8Array): string {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65_557); i--) {
    if (b.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip file');
  const count = b.readUInt16LE(eocd + 10);
  let p = b.readUInt32LE(eocd + 16);
  let pick: { method: number; size: number; offset: number } | null = null;
  for (let k = 0; k < count && b.readUInt32LE(p) === 0x02014b50; k++) {
    const method = b.readUInt16LE(p + 10);
    const size = b.readUInt32LE(p + 20);
    const nameLen = b.readUInt16LE(p + 28);
    const extraLen = b.readUInt16LE(p + 30);
    const commentLen = b.readUInt16LE(p + 32);
    const offset = b.readUInt32LE(p + 42);
    const name = b.toString('utf8', p + 46, p + 46 + nameLen);
    if (!pick || /\.csv$/i.test(name)) pick = { method, size, offset };
    if (/\.csv$/i.test(name)) break;
    p += 46 + nameLen + extraLen + commentLen;
  }
  if (!pick || b.readUInt32LE(pick.offset) !== 0x04034b50) throw new Error('not a zip file');
  const start = pick.offset + 30 + b.readUInt16LE(pick.offset + 26) + b.readUInt16LE(pick.offset + 28);
  const raw = b.subarray(start, start + pick.size);
  if (pick.method === 0) return raw.toString('utf8');
  if (pick.method === 8) return inflateRawSync(raw).toString('utf8');
  throw new Error(`zip method ${pick.method}`);
}

/** DOL ETA 539's national XML: each week (ending Saturday) its seasonally adjusted initial and continued claims. */
export function parseClaims(xml: string): Map<string, Observation[]> {
  if (!/<week>/.test(xml) && !/National/.test(xml)) throw new Error('not a DOL claims report');
  const initial: Observation[] = [];
  const continued: Observation[] = [];
  for (const w of xml.match(/<week>[\s\S]*?<\/week>/g) ?? []) {
    const d = /<weekEnded>\s*(\d\d)\/(\d\d)\/(\d{4})\s*<\/weekEnded>/.exec(w);
    if (!d) continue;
    const date = `${d[3]}-${d[1]}-${d[2]}`;
    const sa = (block: string) => num(new RegExp(`<${block}>[\\s\\S]*?<SA>([^<]*)</SA>`).exec(w)?.[1]);
    const i = sa('InitialClaims');
    const c = sa('ContinuedClaims');
    if (Number.isFinite(i)) initial.push([date, i]);
    if (Number.isFinite(c)) continued.push([date, c]);
  }
  return new Map([['claims/initial', initial.sort(byDate)], ['claims/continued', continued.sort(byDate)]]);
}

/** A DDP CSV (layout seriescolumn): each series' column by its id in the "Time Period" row; months as YYYY-MM. */
export function parseDdp(csv: string): Map<string, Observation[]> {
  const lines = csv.replace(/\r/g, '').split('\n');
  const split = (l: string) => l.split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
  const at = lines.findIndex((l) => /^"?Time Period"?,/.test(l));
  if (at < 0) throw new Error('not a Data Download Program file');
  const ids = split(lines[at]!).slice(1);
  const out = new Map<string, Observation[]>(ids.map((id) => [id, []]));
  for (const line of lines.slice(at + 1)) {
    const [t, ...vals] = split(line);
    const date = /^\d{4}-\d\d$/.test(t ?? '') ? `${t}-01` : /^\d{4}-\d\d-\d\d$/.test(t ?? '') ? t! : null;
    if (!date) continue;
    vals.forEach((raw, k) => {
      const v = num(raw);
      if (Number.isFinite(v) && ids[k]) out.get(ids[k]!)!.push([date, v]);
    });
  }
  return out;
}

const MONTH_NUMBER: Record<string, string> = Object.fromEntries(
  ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'].map((m, k) => [m, pad2(k + 1)]),
);

/**
 * The FOMC's target range from the Board's open market operations page: a
 * table a year (`<h4>2026</h4>`), a row a change (its effective date, the
 * increase, the decrease, the level "3.75-4.00"). Rows with a single target
 * (before 16 December 2008) are left out. Each bound is kept at each change
 * and on `today` (YYYY-MM-DD), so a chart runs to today.
 */
export function parseFedTargets(html: string, today: string): Map<string, Observation[]> {
  const changes: Array<[string, number, number]> = [];
  const parts = html.split(/<h4[^>]*>\s*(\d{4})\s*<\/h4>/i);
  for (let k = 1; k + 1 < parts.length; k += 2) {
    const year = parts[k]!;
    const table = /<table[\s\S]*?<\/table>/i.exec(parts[k + 1]!)?.[0] ?? '';
    for (const row of table.match(/<tr[\s\S]*?<\/tr>/gi) ?? []) {
      const cells = (row.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi) ?? []).map((c) => c.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim());
      const day = /^([A-Za-z]+)\.?\s+(\d{1,2})/.exec(cells[0] ?? '');
      const range = /^(\d+(?:\.\d+)?)\s*(?:-|–|&ndash;|&#8211;)\s*(\d+(?:\.\d+)?)$/.exec(cells.at(-1) ?? '');
      const month = day && MONTH_NUMBER[day[1]!.toLowerCase()];
      if (!month || !range) continue;
      changes.push([`${year}-${month}-${pad2(Number(day![2]))}`, Number(range[1]), Number(range[2])]);
    }
  }
  if (!changes.length) throw new Error('no target range on the page');
  changes.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const lower: Observation[] = changes.map(([d, lo]) => [d, lo]);
  const upper: Observation[] = changes.map(([d, , up]) => [d, up]);
  if (today > changes.at(-1)![0]) {
    lower.push([today, lower.at(-1)![1]]);
    upper.push([today, upper.at(-1)![1]]);
  }
  return new Map([['target/lower', lower], ['target/upper', upper]]);
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

// --- reading the agencies ---------------------------------------------------------------

interface SourceState {
  at: number;
  failedAt: number;
  series: Map<string, Observation[]>;
  /** The whole history is held (only the newest years are read again). */
  full: boolean;
}

/** What one series' read gives: when its source was read, and the observations. */
export interface SeriesRead {
  at: number;
  obs: Observation[];
}

const sources = new Map<SourceId, SourceState>();
const inflight = new Map<SourceId, Promise<void>>();
/** Per kind, when the watcher read a release of it, and the newest observation each of its series had then. */
const released = new Map<string, { at: number; newest: Map<string, string | null> }>();
/** BLS requests made per UTC day (its limit is per day). */
const blsDay = { day: '', count: 0 };

/** Tests only. */
export function resetIndicators(): void {
  sources.clear();
  inflight.clear();
  released.clear();
  blsDay.day = '';
  blsDay.count = 0;
}

const seriesOfKind = (kind: string) => [...new Set(Object.values(INDICATORS).filter((i) => i.kind === kind).map((i) => i.series))];

/**
 * A release of `kind` was read: its sources are read again soon, and every 15
 * minutes until a series of it has a newer period than now (a day at most).
 */
export function indicatorReleased(kind: string, now = Date.now()): void {
  const ids = seriesOfKind(kind);
  if (!ids.length) return;
  released.set(kind, { at: now, newest: new Map(ids.map((id) => [id, sources.get(SERIES[id]!.source)?.series.get(id)?.at(-1)?.[0] ?? null])) });
}

onRelease((kind) => indicatorReleased(kind));

/** How long a source's copy is good for: 6 hours, or 15 minutes while a release of a kind it carries is not out yet. */
function freshFor(source: SourceId, s: SourceState, now: number): number {
  for (const [kind, r] of released) {
    if (now - r.at > AFTER_RELEASE_FOR_MS) {
      released.delete(kind);
      continue;
    }
    for (const [id, before] of r.newest) {
      if (SERIES[id]?.source !== source) continue;
      // A copy from before the release is stale now.
      if (s.at < r.at) return 0;
      // Nothing newer than at the release yet (or nothing was held then to tell): again in 15 minutes.
      if (before === null || (s.series.get(id)?.at(-1)?.[0] ?? null) === before) return AFTER_RELEASE_MS;
    }
  }
  return CACHE_MS;
}

async function get(url: string, fetchImpl: typeof fetch, init: RequestInit = {}, timeout = TIMEOUT_MS): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetchImpl(url, { ...init, headers: { 'user-agent': UA, ...(init.headers as Record<string, string> | undefined) }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`${new URL(url).hostname} HTTP ${res.status}`);
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/** The observations of `fresh` from `from` on, the older ones of `old` kept. */
function mergeFrom(old: Map<string, Observation[]> | undefined, fresh: Map<string, Observation[]>, from: string): Map<string, Observation[]> {
  const out = new Map(fresh);
  for (const [id, obs] of old ?? []) {
    const kept = obs.filter(([t]) => t < from);
    out.set(id, [...kept, ...(fresh.get(id) ?? obs.filter(([t]) => t >= from))]);
  }
  return out;
}

const BLS_IDS = Object.entries(SERIES).filter(([, s]) => s.source === 'bls').map(([id]) => id);

async function blsRequest(start: number, end: number, fetchImpl: typeof fetch, now: number): Promise<Map<string, Observation[]>> {
  const key = blsKey();
  const day = new Date(now).toISOString().slice(0, 10);
  if (blsDay.day !== day) Object.assign(blsDay, { day, count: 0 });
  // 25 a day without a key, 500 with one; one spare.
  if (blsDay.count >= (key ? 499 : 24)) throw new Error("BLS: today's requests are used up");
  blsDay.count++;
  const body = { seriesid: BLS_IDS, startyear: String(start), endyear: String(end), ...(key ? { registrationkey: key } : {}) };
  const res = await get(BLS_API, fetchImpl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return parseBls(await res.json());
}

/**
 * Each source's read. `prev` is the copy held: a source with a long history
 * reads it whole once, then only its newest years.
 */
const READERS: Record<SourceId, (fetchImpl: typeof fetch, prev: SourceState | undefined, now: number) => Promise<{ series: Map<string, Observation[]>; full: boolean }>> = {
  async bls(fetchImpl, prev, now) {
    const year = new Date(now).getUTCFullYear();
    const span = blsKey() ? 20 : 10;
    const from = year - span + 1;
    let series = mergeFrom(prev?.series, await blsRequest(from, year, fetchImpl, now), `${from}-01-01`);
    if (prev?.full) return { series, full: true };
    // The older years, a piece at a time, newest first: a piece that fails leaves the rest to the next read.
    for (let end = from - 1; end >= BLS_FIRST_YEAR; end -= span) {
      const start = Math.max(BLS_FIRST_YEAR, end - span + 1);
      try {
        const piece = await blsRequest(start, end, fetchImpl, now);
        series = new Map([...series].map(([id, obs]) => [id, [...(piece.get(id) ?? []).filter(([t]) => !obs.some(([u]) => u === t)), ...obs].sort(byDate)]));
      } catch {
        return { series, full: false };
      }
    }
    return { series, full: true };
  },
  'bea-T20804': (fetchImpl, prev, now) => beaTable('T20804', 'M', fetchImpl, prev, now),
  'bea-T10101': (fetchImpl, prev, now) => beaTable('T10101', 'Q', fetchImpl, prev, now),
  'census-RESSALES': (fetchImpl) => censusSurvey('RESSALES', fetchImpl),
  'census-RESCONST': (fetchImpl) => censusSurvey('RESCONST', fetchImpl),
  'census-MARTS': (fetchImpl) => censusSurvey('MARTS', fetchImpl),
  'census-M3ADV': (fetchImpl) => censusSurvey('M3ADV', fetchImpl),
  async 'dol-claims'(fetchImpl, prev, now) {
    const year = new Date(now).getUTCFullYear();
    const from = prev?.full ? year - DOL_RECENT_YEARS + 1 : DOL_FIRST_YEAR;
    const form = new URLSearchParams({ level: 'us', final_yr: String(year + 1), strtdate: String(from), enddate: String(year), filetype: 'xml' });
    const res = await get(DOL_CLAIMS, fetchImpl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString() }, HISTORY_TIMEOUT_MS);
    const fresh = parseClaims(await res.text());
    return { series: prev?.full ? mergeFrom(prev.series, fresh, `${from}-01-01`) : fresh, full: true };
  },
  async 'fed-target'(fetchImpl, _prev, now) {
    const res = await get(FED_TARGETS, fetchImpl);
    return { series: parseFedTargets(await res.text(), new Date(now).toISOString().slice(0, 10)), full: true };
  },
  async 'fed-g17'(fetchImpl) {
    const res = await get(FED_G17, fetchImpl);
    const all = parseDdp(await res.text());
    return { series: new Map([['IP.B50001.S', all.get('IP.B50001.S') ?? []]]), full: true };
  },
};

async function beaTable(table: 'T20804' | 'T10101', frequency: 'M' | 'Q', fetchImpl: typeof fetch, prev: SourceState | undefined, now: number) {
  const key = beaKey();
  if (!key) throw new Error('BEA_API_KEY is not set');
  const year = new Date(now).getUTCFullYear();
  const years = prev?.full ? Array.from({ length: BEA_RECENT_YEARS }, (_, k) => year - BEA_RECENT_YEARS + 1 + k).join(',') : 'X';
  const q = new URLSearchParams({ UserID: key, method: 'GetData', DataSetName: 'NIPA', TableName: table, Frequency: frequency, Year: years, ResultFormat: 'JSON' });
  const res = await get(`${BEA_API}?${q}`, fetchImpl, {}, HISTORY_TIMEOUT_MS);
  const all = parseBea(await res.json());
  const wanted = Object.entries(SERIES).filter(([, s]) => s.source === `bea-${table}`).map(([id]) => id);
  const fresh = new Map(wanted.map((id) => [id, all.get(id) ?? []]));
  if (wanted.every((id) => !fresh.get(id)!.length)) throw new Error(`BEA ${table}: none of ${wanted.join(', ')}`);
  return { series: prev?.full ? mergeFrom(prev.series, fresh, `${year - BEA_RECENT_YEARS + 1}-01-01`) : fresh, full: true };
}

async function censusSurvey(program: string, fetchImpl: typeof fetch) {
  const res = await get(`${CENSUS_ZIP}${program}`, fetchImpl, {}, HISTORY_TIMEOUT_MS);
  const all = parseCensus(unzipFirst(new Uint8Array(await res.arrayBuffer())));
  const series = new Map<string, Observation[]>();
  for (const [id, s] of Object.entries(SERIES)) if (s.source === `census-${program}`) series.set(id, all.get(id.slice(program.length + 1)) ?? []);
  return { series, full: true };
}

/** A source, cached; a read that fails keeps the last copy. Throws only when there is none. */
async function readSource(source: SourceId, fetchImpl: typeof fetch, now: number): Promise<SourceState> {
  const s = sources.get(source);
  const t = Date.now();
  const stale = !s || t - s.at >= freshFor(source, s, t);
  if (stale && !(s && t - s.failedAt < RETRY_MS)) {
    let flight = inflight.get(source);
    if (!flight) {
      flight = (async () => {
        try {
          const { series, full } = await READERS[source](fetchImpl, s, now);
          if (![...series.values()].some((obs) => obs.length)) throw new Error('no observations');
          sources.set(source, { at: Date.now(), failedAt: 0, series, full });
        } catch (e) {
          if (!s) throw e;
          sources.set(source, { ...s, failedAt: Date.now() });
        }
      })().finally(() => inflight.delete(source));
      inflight.set(source, flight);
    }
    await flight;
  }
  const got = sources.get(source);
  if (!got) throw new Error(`${source} not read`);
  return got;
}

/** One series (a key of SERIES), cached with its source. Throws when it cannot be read and nothing is held. */
export async function indicatorSeries(id: string, fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<SeriesRead> {
  const info = SERIES[id];
  if (!info) throw new Error(`no series ${id}`);
  const s = await readSource(info.source, fetchImpl, now);
  const obs = s.series.get(id) ?? [];
  if (!obs.length) throw new Error(`${info.agency} has no ${info.label}`);
  return { at: s.at, obs };
}

/** The FOMC's current target range from the Board's open market operations page (cached as the indicators are). */
export async function fedTargetRange(fetchImpl: typeof fetch = fetch): Promise<{ lower: number; upper: number } | null> {
  const [lo, up] = await Promise.all([indicatorSeries('target/lower', fetchImpl), indicatorSeries('target/upper', fetchImpl)]);
  const lower = lo.obs.at(-1)?.[1];
  const upper = up.obs.at(-1)?.[1];
  return lower !== undefined && upper !== undefined ? { lower, upper } : null;
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
  /** The agency, its name for the series, and its own page for it. */
  source: { name: string; series: string; href: string };
  /** [ms of the period's first day, value], oldest first. */
  points: Array<[number, number]>;
  /** Newest first, the last 24 periods. */
  table: IndicatorRow[];
  latest: IndicatorRow | null;
  /** The next release of its kind on the calendar. */
  next: { time: number; eventId: string } | null;
  /** When this server last read the series from the agency. */
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
  const info = SERIES[i.series]!;
  const [s, next] = await Promise.all([indicatorSeries(i.series, opts.fetchImpl, now), nextRelease(i.kind, now, opts.calendarImpl ?? calendar)]);
  const view = indicatorView(s.obs, i, range);
  return {
    id: i.id,
    name: i.name,
    unit: i.unit,
    frequency: i.frequency,
    kind: i.kind,
    field: i.field,
    source: { name: info.agency, series: info.label, href: info.href },
    ...view,
    next,
    updatedAt: s.at,
  };
}
