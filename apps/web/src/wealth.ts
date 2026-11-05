/**
 * SoDEX Wealth: the reads, and what the page needs out of them. Reads leave this browser for SoDEX's
 * gateway through readGateway (per-IP budget, dedupe, cooldown); nothing is signed here.
 *
 * NOTHING IS INVENTED. Numbers stay SoDEX's decimal strings until they are printed. A field SoDEX did
 * not send is null and prints as a dash: most funds have no `apy1M`, a new one no `roi1Y`, and the live
 * sample's `/markets` carries `fundType` only on the bridged vault, so a quote's type comes from `/funds`.
 *
 * THE PRODUCT GROUPS ARE NOT fundType. SoDEX's page files US Semis 25 (vSMH) and Strategy Preferred
 * Yield (vSTRC) under Specialty and US Cash Yield (vBOXX) under Stable Earn, though all three are `clob`.
 * The API has no group field, so FUND_LABELS below copies SoDEX's page. A fund it does not list yet
 * falls back on its type: escrow_vault Specialty, clob Curated ETF, bridged_vault Stable Earn. The
 * product names ("US Tech 100") are SoDEX's page's too; the API calls that one "QQQ Fund".
 */
import { readGateway } from './trading/gateway';
import { serverGetJson } from './serverFetch';

export type FundType = 'escrow_vault' | 'clob' | 'bridged_vault' | (string & {});
export type ProductGroup = 'specialty' | 'curated' | 'stable';

export const GROUP_LABEL: Record<ProductGroup, string> = { specialty: 'Specialty', curated: 'Curated ETF', stable: 'Stable Earn' };
export const GROUP_LINE: Record<ProductGroup, string> = {
  specialty: 'Discover growth opportunities',
  curated: 'Invest in long-term beta',
  stable: 'Earn variable yield',
};
export const GROUPS: readonly ProductGroup[] = ['specialty', 'curated', 'stable'];

/** fundId -> SoDEX's page's product name and group. */
const FUND_LABELS: Record<string, { name: string; group: ProductGroup }> = {
  CXMT: { name: 'CXMT Vault', group: 'specialty' },
  UNITREE: { name: 'Unitree Vault', group: 'specialty' },
  vSMH: { name: 'US Semis 25', group: 'specialty' },
  vSTRC: { name: 'Strategy Preferred Yield', group: 'specialty' },
  vQQQ: { name: 'US Tech 100', group: 'curated' },
  vVOO: { name: 'US 500', group: 'curated' },
  vSCHD: { name: 'US Selected Dividend', group: 'curated' },
  vVYM: { name: 'US Broad Dividend', group: 'curated' },
  vVGT: { name: 'US Broad Tech', group: 'curated' },
  'Morpho-Earn': { name: 'USDC Earn', group: 'stable' },
  vBOXX: { name: 'US Cash Yield', group: 'stable' },
};

export function groupOf(fundId: string, fundType: FundType | null | undefined): ProductGroup {
  const known = FUND_LABELS[fundId];
  if (known) return known.group;
  return fundType === 'escrow_vault' ? 'specialty' : fundType === 'bridged_vault' ? 'stable' : 'curated';
}

/* --- the wire --------------------------------------------------------------------------------- */

export interface WealthShare { coin: string; address?: string; decimals?: number }

export interface WealthFund {
  fundId: string;
  name: string;
  fundType: FundType;
  fundStatus?: string;
  nav?: string;
  aum?: string;
  asOf?: string;
  share?: WealthShare;
  spot?: { symbol: string; symbolId?: number; displayName?: string; quote?: { coin: string; decimals?: number } };
  issuerName?: string;
  inceptionDate?: string;
  contracts?: Record<string, string>;
  chainConfig?: {
    assetDecimals?: number;
    minDeposit?: string;
    minRedeemShares?: string;
    mgmtFeeRate?: string;
    perfFeeRate?: string;
    exchangeRate?: string;
    paused?: boolean;
    asOfBlock?: number;
  } | null;
  subscription?: {
    subscribeDeadline?: number;
    unsubscribeDeadline?: number;
    totalSubscribed?: string;
    minimumSubscribeAmount?: string;
  };
}

export interface WealthQuote {
  fundId: string;
  symbol?: string;
  fundType?: FundType;
  currency?: string;
  price?: string;
  prevClose?: string;
  changePct?: string;
  roi24h?: string;
  roi1M?: string;
  roi1Y?: string;
  roi3Y?: string;
  roiYtd?: string;
  roiInception?: string;
  apy24h?: string;
  apy7d?: string;
  apy1M?: string;
  dividendYield?: string;
  dayHigh?: string;
  dayLow?: string;
  dayVolume?: string;
  marketStatus?: string;
  asOf?: string;
  yieldBasis?: string;
  yieldAsOf?: string;
}

export interface PriceHistory {
  fundId: string;
  symbol?: string;
  interval?: string;
  range?: string;
  points: Array<{ ts: string; close: string }>;
}

export interface PnlPosition {
  fundId: string;
  source?: string;
  shares?: string;
  avgCostWithAirdrop?: string;
  price?: string;
  priceAsOf?: string;
  marketValue?: string;
  unrealizedPnl?: string;
  realizedPnl?: string;
  pnl24h?: string;
  price24hAgo?: string;
  priced?: boolean;
}

export interface WealthPnl {
  address: string;
  currency?: string;
  settledValue?: string;
  totalCost?: string;
  totalPnl?: string;
  totalRealizedPnl?: string;
  totalUnrealizedPnl?: string;
  totalPnl24h?: string;
  inFlightValue?: string;
  totalValue?: string;
  totalWealth?: string;
  complete?: boolean;
  bridgeStatus?: string;
  positions: PnlPosition[];
}

export interface WealthPositions {
  address: string;
  summary?: { processingCost?: string; pendingProceeds?: string; predepositAssets?: string };
  positions: Array<{ fundId: string; pendingRedeemShares?: string; pendingDepositShares?: string; processingCost?: string; pendingProceeds?: string }>;
}

export interface FundDetailEntry {
  fundId: string;
  kind?: string;
  status?: string;
  transactionType?: string;
  cost?: string;
  proceeds?: string;
  shares?: string;
  requestedShares?: string;
  entryId?: string;
  at?: string;
  requestedAt?: string;
  pricedAt?: string;
  txHash?: string;
}

export interface WealthFundDetails {
  address: string;
  totals: Array<{ fundId: string; shares?: string; costBasis?: string; avgCost?: string; share?: WealthShare }>;
  entries: FundDetailEntry[];
  unavailableTotalsFundIds?: string[];
}

export interface PnlHistory {
  address: string;
  range?: string;
  accountingFrom?: string;
  points: Array<{ ts: string; pnl: string; settledValue?: string; inFlightValue?: string; totalValue?: string }>;
}

/** `/price-history` takes 1D 1W 1M 3M 1Y ALL (6M, YTD and 5Y are refused: "invalid parameter: range"). */
export const PRICE_RANGES = ['1M', '3M', '1Y', 'ALL'] as const;
export type PriceRange = (typeof PRICE_RANGES)[number];
export const PNL_RANGES = ['1W', '1M', '3M', '1Y', 'ALL'] as const;
export type PnlRange = (typeof PNL_RANGES)[number];

/* --- the reads -------------------------------------------------------------------------------- */

type Read = <T>(path: string) => Promise<T>;
const gateway: Read = (path) => readGateway(path);

const API = '/api/v1/wealth';
const id = (s: string): string => encodeURIComponent(s);

export const fetchFunds = (read: Read = gateway): Promise<WealthFund[]> =>
  read<WealthFund[] | null>(`${API}/funds`).then((d) => (Array.isArray(d) ? d : []));

export const fetchFund = (fundId: string, read: Read = gateway): Promise<WealthFund> => read<WealthFund>(`${API}/funds/${id(fundId)}`);

export const fetchMarkets = (read: Read = gateway): Promise<WealthQuote[]> =>
  read<{ quotes?: WealthQuote[] } | null>(`${API}/markets`).then((d) => (Array.isArray(d?.quotes) ? d.quotes : []));

export const fetchPriceHistory = (fundId: string, range: PriceRange, read: Read = gateway): Promise<PriceHistory> =>
  read<PriceHistory>(`${API}/funds/${id(fundId)}/price-history?interval=1d&range=${range}`).then((d) => ({ ...d, points: Array.isArray(d?.points) ? d.points : [] }));

export const fetchPositions = (address: string, read: Read = gateway): Promise<WealthPositions> =>
  read<WealthPositions>(`${API}/users/${address}/positions`).then((d) => ({ ...d, positions: Array.isArray(d?.positions) ? d.positions : [] }));

export const fetchPnl = (address: string, read: Read = gateway): Promise<WealthPnl> =>
  read<WealthPnl>(`${API}/users/${address}/pnl`).then((d) => ({ ...d, positions: Array.isArray(d?.positions) ? d.positions : [] }));

export const fetchFundDetails = (address: string, read: Read = gateway): Promise<WealthFundDetails> =>
  read<WealthFundDetails>(`${API}/users/${address}/fund-details`).then((d) => ({
    ...d,
    totals: Array.isArray(d?.totals) ? d.totals : [],
    entries: Array.isArray(d?.entries) ? d.entries : [],
  }));

export const fetchPnlHistory = (address: string, range: PnlRange, read: Read = gateway): Promise<PnlHistory> =>
  read<PnlHistory>(`${API}/users/${address}/pnl-history?interval=1d&range=${range}`).then((d) => ({ ...d, points: Array.isArray(d?.points) ? d.points : [] }));

/**
 * Whether SoDEX has Wealth in maintenance.
 *
 * NOT ON THE GATEWAY: `mainnet-gw.../wealth/maintenance` is a 404. SoDEX's own page reads this one path
 * from `wealth.sodex.dev`, which sends no CORS headers to other sites, so it comes through our server
 * (routes/sodexLottery.ts), as `{status:'NORMAL'|'MAINTENANCE', message, updatedAt}`. Only an answer that
 * says MAINTENANCE stops anything; a read that failed is `unknown`, never maintenance (the same evidence
 * rule as maintenanceVerdict.ts).
 */
export const WEALTH_MAINTENANCE_PATH = '/api/vs/sodex/wealth/maintenance';

export interface WealthMaintenance { state: 'normal' | 'maintenance' | 'unknown'; message: string | null }

type MaintenanceGet = (path: string, signal?: AbortSignal) => Promise<{ ok: boolean; body: { status?: unknown; message?: unknown } | null }>;

export async function fetchMaintenance(signal?: AbortSignal, get: MaintenanceGet = serverGetJson): Promise<WealthMaintenance> {
  try {
    const r = await get(WEALTH_MAINTENANCE_PATH, signal);
    if (!r.ok || !r.body) return { state: 'unknown', message: null };
    const message = typeof r.body.message === 'string' && r.body.message ? r.body.message : null;
    if (r.body.status === 'MAINTENANCE') return { state: 'maintenance', message };
    if (r.body.status === 'NORMAL') return { state: 'normal', message: null };
    return { state: 'unknown', message: null };
  } catch {
    return { state: 'unknown', message: null };
  }
}

/* --- what the page shows ---------------------------------------------------------------------- */

/** A figure as a number, or null when SoDEX sent none (or nothing readable). Zero is a figure. */
export function numOrNull(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export interface WealthRow {
  fundId: string;
  /** SoDEX's product name when known, else the API's. */
  name: string;
  apiName: string | null;
  group: ProductGroup;
  fundType: FundType | null;
  status: string | null;
  coin: string | null;
  fund: WealthFund | null;
  quote: WealthQuote | null;
}

/** One row per fund: `/funds` and `/markets` joined on fundId, either may lack it. */
export function joinFunds(funds: readonly WealthFund[], quotes: readonly WealthQuote[]): WealthRow[] {
  const byId = new Map(quotes.map((q) => [q.fundId, q]));
  const ids = [...funds.map((f) => f.fundId), ...quotes.map((q) => q.fundId).filter((q) => !funds.some((f) => f.fundId === q))];
  const fundById = new Map(funds.map((f) => [f.fundId, f]));
  return ids.map((fundId) => {
    const fund = fundById.get(fundId) ?? null;
    const quote = byId.get(fundId) ?? null;
    const fundType = fund?.fundType ?? quote?.fundType ?? null;
    return {
      fundId,
      name: FUND_LABELS[fundId]?.name ?? fund?.name ?? fundId,
      apiName: fund?.name ?? null,
      group: groupOf(fundId, fundType),
      fundType,
      status: fund?.fundStatus ?? null,
      coin: fund?.share?.coin ?? quote?.symbol ?? null,
      fund,
      quote,
    };
  });
}

const GROUP_ORDER: Record<ProductGroup, number> = { specialty: 0, curated: 1, stable: 2 };

/** SoDEX's order: its page's own, then anything new. */
export function sortRows(rows: readonly WealthRow[]): WealthRow[] {
  const order = Object.keys(FUND_LABELS);
  const at = (r: WealthRow): number => { const i = order.indexOf(r.fundId); return i < 0 ? order.length : i; };
  return [...rows].sort((a, b) => GROUP_ORDER[a.group] - GROUP_ORDER[b.group] || at(a) - at(b));
}

/**
 * The one return a card leads with, picked the way SoDEX's page picks it: a yield product's 7-day
 * annualised, else the 1-year return, else since inception, else the 1-month. Null when it has none.
 */
export function leadReturn(r: WealthRow): { label: string; value: number; annualised: boolean } | null {
  const q = r.quote;
  if (!q) return null;
  const apy = numOrNull(q.apy7d);
  if (r.group === 'stable' && apy !== null) return { label: '7D APY', value: apy, annualised: true };
  const y = numOrNull(q.roi1Y);
  if (y !== null) return { label: '1-year return', value: y, annualised: false };
  const inc = numOrNull(q.roiInception);
  if (inc !== null) return { label: 'Since inception', value: inc, annualised: false };
  const m = numOrNull(q.roi1M);
  if (m !== null) return { label: '1-month return', value: m, annualised: false };
  return null;
}

/** What qualifies a yield, in words; an unknown value is shown as SoDEX spelled it, unspaced no longer. */
export function yieldBasisLabel(basis: string | null | undefined): string | null {
  if (!basis) return null;
  if (basis === 'net_excluding_rewards') return 'Net, excluding rewards';
  return basis.replace(/_/g, ' ');
}

/** `clob` funds trade as spot on the trade page: the link, or null for a vault. */
export function tradeHref(fund: WealthFund | null | undefined): string | null {
  const symbol = fund?.fundType === 'clob' ? fund.spot?.symbol : undefined;
  return symbol ? `/trade?symbol=${encodeURIComponent(symbol)}` : null;
}

/** A vault's actions are not here yet: they sign, which the portfolio work is still settling. */
export const isVault = (fund: WealthFund | null | undefined): boolean =>
  !!fund && fund.fundType !== 'clob';

/**
 * A rate as a percent, from a contract's 18-decimal fixed point ("36500000000000000" -> 3.65).
 * The scale is read off `exchangeRate`, which carries the same 18 decimals and equals `nav` in the
 * live sample. Null when there is none.
 */
export function ratePct(raw: string | null | undefined): number | null {
  const n = numOrNull(raw);
  return n === null ? null : (n / 1e18) * 100;
}

/** A price or value series for the chart: oldest first, unreadable points dropped. */
export function seriesOf<T extends { ts: string }>(points: readonly T[], value: (p: T) => unknown): Array<readonly [number, number]> {
  const out: Array<readonly [number, number]> = [];
  for (const p of points) {
    const t = Date.parse(p.ts);
    const v = numOrNull(value(p));
    if (Number.isFinite(t) && v !== null) out.push([t, v]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

/** A wealth deep link's fund: /wealth/vQQQ -> vQQQ. */
export function fundIdFromPath(pathname: string): string | null {
  const seg = pathname.replace(/\/+$/, '').split('/').filter(Boolean);
  if (seg[0]?.toLowerCase() !== 'wealth' || !seg[1]) return null;
  try {
    return decodeURIComponent(seg[1]);
  } catch {
    return null;
  }
}

/** Whether a wallet holds nothing here: no position, no value, nothing in flight. */
export function isEmptyHolding(p: WealthPnl | null): boolean {
  if (!p) return true;
  return p.positions.length === 0 && !numOrNull(p.totalValue) && !numOrNull(p.inFlightValue);
}
