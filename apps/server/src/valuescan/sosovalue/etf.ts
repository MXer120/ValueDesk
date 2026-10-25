/**
 * Crypto ETF flows from SoSoValue (https://openapi.sosovalue.com/openapi/v1,
 * its ETF module): the US spot ETFs of an asset, summed per trading day, and
 * where each fund stands.
 *
 *   /etfs/summary-history?symbol&country_code=US   per day: total net inflow,
 *        cumulative net inflow, total net assets, value traded - the last
 *        month only (SoSoValue answers 403 to anything older), newest first.
 *   /etfs?symbol&country_code=US                    the funds: ticker, name, exchange.
 *   /etfs/{ticker}/market-snapshot                  a fund's latest settled day:
 *        net inflow, net assets, market price.
 *
 * Because SoSoValue gives a month, the days are kept here as they are read,
 * in etf-flows.json next to the device key, so 3m / 1y / all fill as the
 * server runs; a day read again replaces its copy (flows settle T+1, and the
 * newest row comes without them until then: such rows are left out).
 *
 * The budget is the news key's (sosovalue/news.ts: 20 a minute, 100,000 a
 * month, every call counted there). This module takes at most 5 calls a
 * minute of it: a summary per asset every 30 minutes, the fund list once a
 * day, and the funds' snapshots in the background, one at a time, only for an
 * asset someone asks about and only when the summary has a newer settled day
 * than the snapshot (until then it cannot have changed). The first answer for
 * an asset may come with the funds' figures still null; they fill in.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { deviceKeyPath } from '../../deviceKey.js';
import { NotAvailable } from '../types.js';
import { newsKey, sosoValueJson } from './news.js';

/** The assets SoSoValue has US spot ETFs for. */
export const ETF_ASSETS = ['BTC', 'ETH', 'SOL', 'LTC', 'HBAR', 'XRP', 'DOGE', 'LINK', 'AVAX', 'DOT'] as const;
export type EtfAsset = (typeof ETF_ASSETS)[number];
export type EtfRange = '1m' | '3m' | '1y' | 'all';
export const ETF_RANGES: readonly EtfRange[] = ['1m', '3m', '1y', 'all'];

const SUMMARY_MS = 30 * 60_000;
const SNAPSHOT_MS = 30 * 60_000;
const LIST_MS = 24 * 60 * 60_000;
/** A read that failed is not tried again for this long. */
const RETRY_MS = 5 * 60_000;
/** Of the news key's budget, the most this module spends in a minute. */
const CALLS_PER_MIN = 5;
const FILE = 'etf-flows.json';
const RANGE_DAYS: Record<EtfRange, number> = { '1m': 31, '3m': 92, '1y': 366, all: Infinity };

export interface EtfDay {
  date: string;
  netInflow: number;
  cumNetInflow: number | null;
  totalNetAssets: number | null;
  valueTraded: number | null;
}

export interface EtfFund {
  ticker: string;
  name: string;
  exchange?: string;
  /** Its latest settled day's net inflow, USD. */
  netInflow: number | null;
  netAssets: number | null;
  /** Of the asset's ETFs' total net assets that day, 0..1. */
  share: number | null;
  /** Market price, USD. */
  price: number | null;
  /** The day those figures are for. */
  date: string | null;
}

export interface EtfFlowsPage {
  asset: EtfAsset;
  /** Oldest first. */
  days: EtfDay[];
  /** Largest first (net assets). */
  funds: EtfFund[];
  assets: string[];
  /** When the summary was last read from SoSoValue, ms. */
  updatedAt: number;
}

// --- parsing -------------------------------------------------------------------------

/** SoSoValue's `{ code, message, data }`: the data, or an error when the code says so. */
export function sosoData(body: unknown): unknown {
  if (body && typeof body === 'object' && 'code' in body) {
    const b = body as { code?: unknown; message?: unknown; data?: unknown };
    if (b.code !== 0 && b.code !== '0') throw new Error(`SoSoValue ${String(b.code)}: ${typeof b.message === 'string' ? b.message : 'error'}`);
    return b.data;
  }
  return body;
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n : null;
};
const usd = (v: unknown) => {
  const n = num(v);
  return n === null ? null : Math.round(n);
};

/** The summary's settled days, oldest first (a row without its net inflow is not settled yet). */
export function parseEtfSummary(body: unknown): EtfDay[] {
  const rows = sosoData(body);
  if (!Array.isArray(rows)) return [];
  const out = new Map<string, EtfDay>();
  for (const r of rows as Array<Record<string, unknown>>) {
    const date = typeof r?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.date) ? r.date : null;
    const netInflow = usd(r?.total_net_inflow);
    if (!date || netInflow === null) continue;
    out.set(date, { date, netInflow, cumNetInflow: usd(r.cum_net_inflow), totalNetAssets: usd(r.total_net_assets), valueTraded: usd(r.total_value_traded) });
  }
  return [...out.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/** The fund list: ticker, name, exchange. */
export function parseEtfList(body: unknown): Array<{ ticker: string; name: string; exchange?: string }> {
  const rows = sosoData(body);
  if (!Array.isArray(rows)) return [];
  const out: Array<{ ticker: string; name: string; exchange?: string }> = [];
  for (const r of rows as Array<Record<string, unknown>>) {
    const ticker = typeof r?.ticker === 'string' ? r.ticker.trim().toUpperCase() : '';
    if (!/^[A-Z0-9.]{1,10}$/.test(ticker) || out.some((f) => f.ticker === ticker)) continue;
    out.push({ ticker, name: typeof r.name === 'string' ? r.name.trim() : ticker, ...(typeof r.exchange === 'string' && r.exchange ? { exchange: r.exchange } : {}) });
  }
  return out;
}

export interface EtfSnapshot {
  ticker: string;
  date: string | null;
  netInflow: number | null;
  netAssets: number | null;
  price: number | null;
}

/** A fund's market snapshot (its latest settled day). The doc calls `date` a timestamp; it comes as YYYY-MM-DD. */
export function parseEtfSnapshot(body: unknown): EtfSnapshot | null {
  const r = sosoData(body) as Record<string, unknown> | null;
  if (!r || typeof r !== 'object' || typeof r.ticker !== 'string') return null;
  const d = r.date;
  const date = typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : typeof d === 'number' && d > 1e11 ? new Date(d).toISOString().slice(0, 10) : null;
  return { ticker: r.ticker.toUpperCase(), date, netInflow: usd(r.net_inflow), netAssets: usd(r.net_assets), price: num(r.mkt_price) };
}

/** Days kept and days just read as one list, oldest first; a day read again replaces the kept one. */
export function mergeDays(kept: readonly EtfDay[], read: readonly EtfDay[]): EtfDay[] {
  const by = new Map(kept.map((d) => [d.date, d]));
  for (const d of read) by.set(d.date, d);
  return [...by.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/** The days within `range` of the newest one. */
export function daysIn(days: readonly EtfDay[], range: EtfRange): EtfDay[] {
  const last = days.at(-1);
  if (!last || RANGE_DAYS[range] === Infinity) return [...days];
  const from = Date.parse(`${last.date}T00:00:00Z`) - RANGE_DAYS[range] * 86_400_000;
  return days.filter((d) => Date.parse(`${d.date}T00:00:00Z`) > from);
}

/**
 * The funds with their snapshots, largest first. `share` is against the
 * summary's total for the snapshot's day; a snapshot can be a day ahead of the
 * summary (IBIT's said 23 October with the summary at the 22nd), and then
 * against the funds' own sum for that day once every fund has it.
 */
export function buildFunds(list: ReturnType<typeof parseEtfList>, snaps: ReadonlyMap<string, EtfSnapshot>, days: readonly EtfDay[]): EtfFund[] {
  const total = new Map<string, number | null>(days.map((d) => [d.date, d.totalNetAssets]));
  for (const date of new Set([...snaps.values()].map((s) => s.date))) {
    if (!date || total.get(date)) continue;
    const same = list.map((f) => snaps.get(f.ticker)).filter((s) => s?.date === date && s.netAssets !== null);
    if (list.length && same.length === list.length) total.set(date, same.reduce((sum, s) => sum + s!.netAssets!, 0));
  }
  return list
    .map((f) => {
      const s = snaps.get(f.ticker);
      const t = s?.date ? total.get(s.date) : null;
      return {
        ...f,
        netInflow: s?.netInflow ?? null,
        netAssets: s?.netAssets ?? null,
        share: s?.netAssets !== null && s?.netAssets !== undefined && t ? Math.round((s.netAssets / t) * 10_000) / 10_000 : null,
        price: s?.price ?? null,
        date: s?.date ?? null,
      };
    })
    .sort((a, b) => (b.netAssets ?? -1) - (a.netAssets ?? -1) || a.ticker.localeCompare(b.ticker));
}

// --- the store and the budget ---------------------------------------------------------

interface AssetState {
  /** Summary read at / failed at. */
  at: number;
  failedAt: number;
  list: { at: number; failedAt: number; funds: ReturnType<typeof parseEtfList> };
  snaps: Map<string, EtfSnapshot & { at: number; failedAt: number }>;
}

let days: Partial<Record<EtfAsset, EtfDay[]>> | null = null;
const state = new Map<EtfAsset, AssetState>();
const flights = new Map<string, Promise<void>>();
const filling = new Set<EtfAsset>();
let calls: number[] = [];

/** Tests only. */
export function resetEtf(): void {
  days = null;
  state.clear();
  flights.clear();
  filling.clear();
  calls = [];
}

function load(path: string): Partial<Record<EtfAsset, EtfDay[]>> {
  try {
    const s = JSON.parse(readFileSync(path, 'utf8')) as { version?: number; days?: Partial<Record<EtfAsset, EtfDay[]>> };
    if (s?.version === 1 && s.days && typeof s.days === 'object') return s.days;
  } catch {
    /* first start, or a damaged file: start empty */
  }
  return {};
}

function save(path: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, days }));
    renameSync(tmp, path);
  } catch {
    /* kept in memory; the next read tries again */
  }
}

/** A call of this module's 5 a minute, or false when they are spent. */
function spend(): boolean {
  const now = Date.now();
  calls = calls.filter((t) => now - t < 60_000);
  if (calls.length >= CALLS_PER_MIN) return false;
  calls.push(now);
  return true;
}

/** Ms until a call is free again. */
const nextSlot = () => (calls.length < CALLS_PER_MIN ? 0 : 60_000 - (Date.now() - calls[0]!) + 50);

async function soso(path: string, fetchImpl: typeof fetch): Promise<unknown> {
  if (!spend()) throw new Error('SoSoValue ETF data is busy; try again in a minute');
  return sosoValueJson(path, fetchImpl);
}

function once(id: string, run: () => Promise<void>): Promise<void> {
  let f = flights.get(id);
  if (!f) {
    f = run().finally(() => flights.delete(id));
    flights.set(id, f);
  }
  return f;
}

const stateOf = (asset: EtfAsset): AssetState => {
  let s = state.get(asset);
  if (!s) state.set(asset, (s = { at: 0, failedAt: 0, list: { at: 0, failedAt: 0, funds: [] }, snaps: new Map() }));
  return s;
};

/**
 * The funds' snapshots, read one at a time from what this module's budget has
 * left, for those that have none or an older day than the summary's newest.
 */
function fillSnapshots(asset: EtfAsset, fetchImpl: typeof fetch): void {
  if (filling.has(asset)) return;
  filling.add(asset);
  void (async () => {
    try {
      const s = stateOf(asset);
      const newest = days?.[asset]?.at(-1)?.date ?? null;
      for (const f of s.list.funds) {
        const now = Date.now();
        const have = s.snaps.get(f.ticker);
        if (have && now - have.failedAt < RETRY_MS) continue;
        if (have && (now - have.at < SNAPSHOT_MS || !newest || (have.date !== null && have.date >= newest))) continue;
        const wait = nextSlot();
        if (wait > 0) await new Promise<void>((r) => setTimeout(r, wait).unref?.());
        try {
          const snap = parseEtfSnapshot(await soso(`/etfs/${encodeURIComponent(f.ticker)}/market-snapshot`, fetchImpl));
          if (!snap) throw new Error('no snapshot');
          s.snaps.set(f.ticker, { ...snap, at: Date.now(), failedAt: 0 });
        } catch (e) {
          if (e instanceof NotAvailable) return;
          const prev = s.snaps.get(f.ticker);
          s.snaps.set(f.ticker, { ...(prev ?? { ticker: f.ticker, date: null, netInflow: null, netAssets: null, price: null, at: 0 }), failedAt: Date.now() });
        }
      }
    } finally {
      filling.delete(asset);
    }
  })();
}

export interface EtfOptions {
  fetchImpl?: typeof fetch;
  /** Where etf-flows.json lives (default: the device key's directory). */
  dir?: string;
  /** Tests: do not read the snapshots in the background. */
  snapshots?: boolean;
}

/** An asset's flows over `range`, and its funds (cached 30 minutes; a read that fails keeps the last copy). */
export async function etfFlows(asset: EtfAsset, range: EtfRange, opts: EtfOptions = {}): Promise<EtfFlowsPage> {
  if (!newsKey()) throw new NotAvailable('SoSoValue ETF data is not configured');
  const fetchImpl = opts.fetchImpl ?? fetch;
  const path = join(opts.dir ?? dirname(deviceKeyPath()), FILE);
  days ??= load(path);
  const s = stateOf(asset);
  const now = Date.now();
  const reads: Promise<void>[] = [];
  if (now - s.at >= SUMMARY_MS && now - s.failedAt >= RETRY_MS) {
    reads.push(
      once(`summary:${asset}`, async () => {
        try {
          const read = parseEtfSummary(await soso(`/etfs/summary-history?symbol=${asset}&country_code=US&limit=300`, fetchImpl));
          if (!read.length) throw new Error('no settled days');
          days![asset] = mergeDays(days![asset] ?? [], read);
          s.at = Date.now();
          save(path);
        } catch (e) {
          if (e instanceof NotAvailable) throw e;
          s.failedAt = Date.now();
          // Nothing read and nothing kept: nothing to show.
          if (!s.at && !days![asset]?.length) throw e;
        }
      }),
    );
  }
  if (now - s.list.at >= LIST_MS && now - s.list.failedAt >= RETRY_MS) {
    reads.push(
      once(`list:${asset}`, async () => {
        try {
          const funds = parseEtfList(await soso(`/etfs?symbol=${asset}&country_code=US`, fetchImpl));
          if (!funds.length) throw new Error('no funds listed');
          s.list = { at: Date.now(), failedAt: 0, funds };
        } catch {
          // The funds are the page's second half: the flows still answer without them.
          s.list.failedAt = Date.now();
        }
      }),
    );
  }
  await Promise.all(reads);
  if (opts.snapshots !== false) fillSnapshots(asset, fetchImpl);
  const all = days![asset] ?? [];
  return {
    asset,
    days: daysIn(all, range),
    funds: buildFunds(s.list.funds, s.snaps, all),
    assets: [...ETF_ASSETS],
    updatedAt: s.at,
  };
}

export const parseEtfAsset = (v: unknown): EtfAsset => {
  const a = typeof v === 'string' ? v.trim().toUpperCase() : '';
  return (ETF_ASSETS as readonly string[]).includes(a) ? (a as EtfAsset) : 'BTC';
};
export const parseEtfRange = (v: unknown): EtfRange => ((ETF_RANGES as readonly unknown[]).includes(v) ? (v as EtfRange) : '1m');
