/**
 * Trading limits & conditions: what SoDEX's own market feeds say, shaped for the page and nothing
 * else. Every figure is SoDEX's string, carried as a string: a percentage moves the decimal point
 * (0.0125 -> 1.25%, never through a float), and no figure is worked out here. The one thing put
 * together is a tier's lower bound, which SoDEX defines as the tier below's upper bound (docs,
 * Margin Tiers).
 *
 * Sources: GET /api/v1/{perps,spot}/markets/symbols, GET /api/v1/perps/markets/coins. Checked live
 * on 2026-11-05: 36 single-position accounts' maintenance margin against these tiers.
 */

export interface LimitTier {
  maxNotionalValue: string;
  maintenanceMarginRate: string;
  maxLeverage: number;
  maintenanceDeduction: string;
}

/** A market of either engine; perps carry the leverage and funding fields. */
export interface LimitSymbol {
  id: number;
  name: string;
  displayName: string;
  baseCoin: string;
  quoteCoin?: string;
  tickSize: string;
  minPrice: string;
  maxPrice: string;
  stepSize: string;
  minQuantity: string;
  maxQuantity: string;
  marketMinQuantity: string;
  marketMaxQuantity: string;
  minNotional: string;
  maxNotional: string;
  buyLimitUpRatio?: string;
  sellLimitDownRatio?: string;
  marketDeviationRatio?: string;
  makerFee: string;
  takerFee: string;
  status: string;
  maxLeverage?: number;
  initLeverage?: number;
  marginTiers?: LimitTier[];
  fundingInterval?: number;
  interestRate?: string;
  maxFundingRate?: string;
  minFundingRate?: string;
  openInterestCap?: string;
  openInterestCapUSD?: string;
}

export interface LimitCoin {
  id: number;
  name: string;
  marginRatio?: string;
  price?: string;
}

const DEC = /^(-?)(\d+)(?:\.(\d+))?$/;

/** A fraction as a percentage, by moving the point in the string: '0.0125' -> '1.25%'. Null when it is no number. */
export function pctOf(raw: string | null | undefined): string | null {
  const m = DEC.exec((raw ?? '').trim());
  if (!m) return null;
  const whole = m[2]!;
  const frac = (m[3] ?? '').padEnd(2, '0');
  const int = `${whole}${frac.slice(0, 2)}`.replace(/^0+(?=\d)/, '');
  const rest = frac.slice(2).replace(/0+$/, '');
  return `${m[1]}${int}${rest ? `.${rest}` : ''}%`;
}

/** SoDEX's "0" on a maximum means none is set (rest.ts). Null then, so the page can say so. */
export function capOf(raw: string | null | undefined): string | null {
  const m = DEC.exec((raw ?? '').trim());
  if (!m) return null;
  return Number(raw) > 0 ? raw!.trim() : null;
}

/** A price band as SoDEX's two ratios: '±5%' when they match, else up and down. */
export function bandOf(up: string | null | undefined, down: string | null | undefined): string | null {
  const u = pctOf(up);
  const d = pctOf(down);
  if (u === null || d === null) return null;
  return u === d ? `±${u}` : `+${u} / −${d}`;
}

export interface Bracket {
  tier: number;
  from: string;
  to: string;
  maxLeverage: number;
  rate: string | null;
  deduction: string;
}

/** A market's tiers, smallest first, each from the tier below's upper bound. */
export function bracketsOf(tiers: readonly LimitTier[] | null | undefined): Bracket[] {
  const sorted = [...(tiers ?? [])].sort((a, b) => Number(a.maxNotionalValue) - Number(b.maxNotionalValue));
  return sorted.map((t, i) => ({
    tier: i + 1,
    from: i === 0 ? '0' : sorted[i - 1]!.maxNotionalValue,
    to: t.maxNotionalValue,
    maxLeverage: t.maxLeverage,
    rate: pctOf(t.maintenanceMarginRate),
    deduction: t.maintenanceDeduction,
  }));
}

const COIN_NAMES: Readonly<Record<string, string>> = { WSOSO: 'SOSO', vXAUt: 'XAUT', vsoUSDC: 'soUSDC' };

/** A coin as people say it: SoDEX's internal vBTC is BTC. */
export function coinName(name: string): string {
  return COIN_NAMES[name] ?? name.replace(/^[va](?=[A-Z])/, '');
}

export interface CollateralRow {
  name: string;
  /** SoDEX's spelling, for the icon. */
  coin: string;
  ratio: string;
  /** The ratio as a share of the bar, for the eye only. */
  share: number;
  price: string | null;
}

/** The coins that count as margin (SoDEX's marginRatio above 0): USDC first, then the highest ratio. */
export function collateralOf(coins: readonly LimitCoin[]): CollateralRow[] {
  return coins
    .filter((c) => Number(c.marginRatio) > 0 && pctOf(c.marginRatio) !== null)
    .map((c) => ({ name: coinName(c.name), coin: c.name, ratio: pctOf(c.marginRatio)!, share: Math.min(1, Number(c.marginRatio)), price: c.price ?? null }))
    .sort((a, b) => Number(b.name === 'USDC') - Number(a.name === 'USDC') || b.share - a.share || a.name.localeCompare(b.name));
}

export const isTrading = (s: Pick<LimitSymbol, 'status'>): boolean => s.status === 'TRADING';

/** Listed order: SoDEX's id, the oldest markets first, halted ones after those trading. */
export function ordered<T extends Pick<LimitSymbol, 'id' | 'status'>>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => Number(isTrading(b)) - Number(isTrading(a)) || a.id - b.id);
}

export function matches(s: Pick<LimitSymbol, 'name' | 'displayName' | 'baseCoin'>, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return `${s.name} ${s.displayName} ${coinName(s.baseCoin)}`.toLowerCase().includes(q);
}

/** The highest leverage any listed market allows, and which ones. */
export function topLeverage(rows: readonly LimitSymbol[]): { leverage: number; coins: string[] } | null {
  const top = Math.max(0, ...rows.map((s) => s.maxLeverage ?? 0));
  if (!(top > 0)) return null;
  return { leverage: top, coins: ordered(rows).filter((s) => s.maxLeverage === top).map((s) => coinName(s.baseCoin)) };
}

/** Funding interval in words, from SoDEX's seconds: 3600 -> '1 h'. */
export function intervalOf(seconds: number | null | undefined): string | null {
  if (!seconds || !(seconds > 0)) return null;
  return seconds % 3600 === 0 ? `${seconds / 3600} h` : `${seconds} s`;
}

/** An 18-decimal oracle price cut for reading (the full string is the cell's title): 2 places from 1,000, 4 from 1, else 6. */
export function shortPrice(raw: string): string {
  const [w = '', f] = raw.split('.');
  if (f === undefined) return raw;
  const n = Number(raw);
  const places = n >= 1000 ? 2 : n >= 1 ? 4 : 6;
  const kept = f.slice(0, places).replace(/0+$/, '');
  return kept ? `${w}.${kept}` : w;
}

export type LimitsTab ='leverage' | 'rules' | 'collateral';

/** The page's place in its URL (/limits?tab=rules&market=ETH-USD), so a view can be linked. */
export function readPlace(search: string): { tab: LimitsTab; market: string | null } {
  const q = new URLSearchParams(search);
  const t = q.get('tab');
  const m = q.get('market')?.trim() ?? '';
  return {
    tab: t === 'rules' || t === 'collateral' ? t : 'leverage',
    market: /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(m) ? m : null,
  };
}

export function placeSearch(tab: LimitsTab, market: string | null): string {
  const q = new URLSearchParams();
  if (tab !== 'leverage') q.set('tab', tab);
  if (tab === 'leverage' && market) q.set('market', market);
  const s = q.toString();
  return s ? `?${s}` : '';
}
