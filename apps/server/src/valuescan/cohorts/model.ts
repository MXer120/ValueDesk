/**
 * Cohorts: every wallet a venue ranks, grouped by all-time PnL and by account
 * size, with what each group holds long and short right now.
 *
 * PURE AND ISOMORPHIC. The indexer and the API aggregate with it and the web
 * app labels with it (through the `@sign` alias), so a threshold, a sector or
 * a bias word has one definition. No I/O here.
 *
 * NETTING. A wallet on several of the chosen venues is ONE wallet: its PnL and
 * equity are summed across them and it lands in one cohort, and its positions
 * on each are added up per coin. Hyperliquid's own PnL and account value
 * already hold its xyz dex (trade.xyz), so with both chosen the trade.xyz
 * figures are not added again - its POSITIONS are (a separate margin book).
 *
 * SAMPLED TAIL. Where one read per small account is too expensive (Lighter's
 * ~100k accounts), wallets under TAIL_EQUITY are read on a fixed random sample
 * and each sampled one stands for 1 / rate wallets (`weight`). Wallet counts
 * stay exact - they come from the venue's own lists.
 */
import type { Venue } from '../types.js';

export type CohortKind = 'pnl' | 'size';

export type CohortId =
  | 'extremely-profitable' | 'very-profitable' | 'profitable' | 'unprofitable' | 'very-unprofitable' | 'rekt'
  | 'apex' | 'whale' | 'large' | 'medium' | 'small';

export interface CohortDef {
  id: CohortId;
  kind: CohortKind;
  name: string;
  /** The range as people read it: "+$100K to +$1M PnL". */
  range: string;
}

/** All-time PnL cohorts, best first. */
export const PNL_COHORTS: readonly CohortDef[] = [
  { id: 'extremely-profitable', kind: 'pnl', name: 'Extremely Profitable', range: '+$1M+ PnL' },
  { id: 'very-profitable', kind: 'pnl', name: 'Very Profitable', range: '+$100K to +$1M PnL' },
  { id: 'profitable', kind: 'pnl', name: 'Profitable', range: '$0 to +$100K PnL' },
  { id: 'unprofitable', kind: 'pnl', name: 'Unprofitable', range: '$0 to -$100K PnL' },
  { id: 'very-unprofitable', kind: 'pnl', name: 'Very Unprofitable', range: '-$100K to -$1M PnL' },
  { id: 'rekt', kind: 'pnl', name: 'Rekt', range: '-$1M+ PnL' },
];

/** Account-size cohorts, largest first. */
export const SIZE_COHORTS: readonly CohortDef[] = [
  { id: 'apex', kind: 'size', name: 'Apex', range: '$5M+ equity' },
  { id: 'whale', kind: 'size', name: 'Whale', range: '$1M – $5M equity' },
  { id: 'large', kind: 'size', name: 'Large', range: '$100K – $1M equity' },
  { id: 'medium', kind: 'size', name: 'Medium', range: '$10K – $100K equity' },
  { id: 'small', kind: 'size', name: 'Small', range: '$0 – $10K equity' },
];

export const COHORTS: readonly CohortDef[] = [...PNL_COHORTS, ...SIZE_COHORTS];
export const COHORT_BY_ID: Readonly<Record<CohortId, CohortDef>> = Object.fromEntries(COHORTS.map((c) => [c.id, c])) as Record<CohortId, CohortDef>;
export const isCohortId = (s: unknown): s is CohortId => typeof s === 'string' && s in COHORT_BY_ID;

/** All-time PnL -> cohort. */
export function pnlCohort(pnl: number): CohortId {
  if (pnl >= 1_000_000) return 'extremely-profitable';
  if (pnl >= 100_000) return 'very-profitable';
  if (pnl >= 0) return 'profitable';
  if (pnl > -100_000) return 'unprofitable';
  if (pnl > -1_000_000) return 'very-unprofitable';
  return 'rekt';
}

/** Account equity -> cohort; null for an empty account (it holds nothing to weigh). */
export function sizeCohort(equity: number): CohortId | null {
  if (!(equity > 0)) return null;
  if (equity >= 5_000_000) return 'apex';
  if (equity >= 1_000_000) return 'whale';
  if (equity >= 100_000) return 'large';
  if (equity >= 10_000) return 'medium';
  return 'small';
}

/** Below this equity a venue may read a sample instead of every wallet. */
export const TAIL_EQUITY = 10_000;

// --- bias words ---------------------------------------------------------------------------

export type Bias = 'very-bullish' | 'bullish' | 'slightly-bullish' | 'slightly-bearish' | 'bearish' | 'very-bearish';

export const BIAS_LABEL: Readonly<Record<Bias, string>> = {
  'very-bullish': 'Very Bullish',
  bullish: 'Bullish',
  'slightly-bullish': 'Slightly Bullish',
  'slightly-bearish': 'Slightly Bearish',
  bearish: 'Bearish',
  'very-bearish': 'Very Bearish',
};

/** Long share of gross exposure, 0..1; null with nothing open. */
export function longShare(long: number, short: number): number | null {
  const gross = long + short;
  return gross > 0 ? long / gross : null;
}

/**
 * A COHORT's word for its long share. Crowds lean long, so the bullish steps
 * start at even and the bearish ones need a clear short majority.
 */
export function biasOf(share: number | null): Bias | null {
  if (share === null || !Number.isFinite(share)) return null;
  if (share >= 0.65) return 'very-bullish';
  if (share >= 0.575) return 'bullish';
  if (share >= 0.5) return 'slightly-bullish';
  if (share >= 0.35) return 'slightly-bearish';
  if (share >= 0.25) return 'bearish';
  return 'very-bearish';
}

export const isBullish = (b: Bias | null): boolean => b === 'very-bullish' || b === 'bullish' || b === 'slightly-bullish';

/**
 * One wallet's (or one coin's) lean: symmetric around even, and never
 * "neutral" - 51% long leans long, just slightly.
 */
export type Lean =
  | 'extremely-bullish' | 'very-bullish' | 'bullish' | 'slightly-bullish'
  | 'slightly-bearish' | 'bearish' | 'very-bearish' | 'extremely-bearish';

export const LEAN_LABEL: Readonly<Record<Lean, string>> = {
  'extremely-bullish': 'Extremely Bullish',
  'very-bullish': 'Very Bullish',
  bullish: 'Bullish',
  'slightly-bullish': 'Slightly Bullish',
  'slightly-bearish': 'Slightly Bearish',
  bearish: 'Bearish',
  'very-bearish': 'Very Bearish',
  'extremely-bearish': 'Extremely Bearish',
};

export function leanOf(share: number | null): Lean | null {
  if (share === null || !Number.isFinite(share)) return null;
  if (share >= 0.95) return 'extremely-bullish';
  if (share >= 0.75) return 'very-bullish';
  if (share >= 0.55) return 'bullish';
  if (share >= 0.5) return 'slightly-bullish';
  if (share > 0.45) return 'slightly-bearish';
  if (share > 0.25) return 'bearish';
  if (share > 0.05) return 'very-bearish';
  return 'extremely-bearish';
}

// --- coins and sectors ------------------------------------------------------------------------

/** Every market reduced to its coin, so BTC on each venue nets: `xyz:TSLA` -> TSLA, `BTC-USD` -> BTC, `ETH-PERP` -> ETH. */
export function coinOf(symbol: string): string {
  const tail = symbol.includes(':') ? symbol.slice(symbol.indexOf(':') + 1) : symbol;
  const head = tail.split(/[-/_]/)[0] ?? tail;
  return head.replace(/^v(?=[A-Z])/, '').toUpperCase();
}

export type Sector = 'majors' | 'layer1' | 'defi' | 'memes' | 'ai' | 'equities' | 'indices' | 'commodities' | 'fx' | 'other';

export const SECTORS: ReadonlyArray<{ id: Sector; label: string }> = [
  { id: 'majors', label: 'Majors' },
  { id: 'layer1', label: 'Layer 1 / 2' },
  { id: 'defi', label: 'DeFi' },
  { id: 'memes', label: 'Memes' },
  { id: 'ai', label: 'AI' },
  { id: 'equities', label: 'Equities' },
  { id: 'indices', label: 'Indices' },
  { id: 'commodities', label: 'Commodities' },
  { id: 'fx', label: 'FX' },
  { id: 'other', label: 'Other' },
];
export const isSector = (s: unknown): s is Sector => typeof s === 'string' && SECTORS.some((x) => x.id === s);

const set = (s: string) => new Set(s.split(/\s+/).filter(Boolean));
const MAJORS = set('BTC ETH');
const LAYER1 = set(`SOL AVAX SUI APT NEAR TON ADA DOT ATOM ARB OP SEI TIA INJ BNB TRX XRP LTC BCH ETC HBAR ALGO XLM
  ICP FIL KAS STX MNT POL MATIC S BERA HYPE ZK STRK IMX MOVE MON MEGA LINEA BLAST MANTA ZETA SAGA DYM IP XMR ZEC DASH
  EGLD FTM KAIA CFX MINA ROSE CELO NEO QTUM VET XTZ EOS IOTA THETA FLOW ASTR KSM OM ORDI SATS STORJ BSV RVN ZEN HNT
  AR TRB W SCR ABS INIT PLUME SOPH HEMI 2Z XPL MET`);
const DEFI = set(`UNI AAVE MKR LDO CRV PENDLE ENA JUP RAY DYDX GMX SNX COMP ONDO ETHFI EIGEN MORPHO LINK SKY SUSHI
  1INCH CAKE JTO PYTH ZRO RUNE AERO VVV USUAL RESOLV SYRUP BAL YFI ALT BANANA LISTA SUPER FXS CVX BLUR ORCA DRIFT
  KMNO AVNT LIT ASTER WLFI HYPER NXPC EUL FRAX INST GRT API3 BAND UMA LQTY RSR ACX REZ ZORA BIO`);
const MEMES = set(`DOGE SHIB KSHIB PEPE KPEPE WIF BONK KBONK FLOKI KFLOKI POPCAT TRUMP FARTCOIN PENGU SPX MOODENG
  PNUT BRETT MEW TURBO NEIRO NEIROETH GOAT MELANIA CHILLGUY PUMP BOME MYRO DOGS HMSTR NOT MEME PEOPLE KNEIRO KLUNC
  LUNC BABY CAT ANIME MOG TST USELESS YZY PURR JELLY HPOS ME BRETT`);
const AI = set(`TAO FET RENDER RNDR WLD VIRTUAL AI16Z AIXBT ARKM IO GRASS KAITO ZEREBRO GRIFFAIN AI NIL PROMPT
  OLAS AGI AKT NMR COOKIE AVAAI SWARMS VANA 0G`);
const COMMODITIES = set('GOLD SILVER OIL WTI BRENT BRENTOIL NATGAS GAS COPPER XAU XAG CL NG PAXG XAUT PLATINUM PALLADIUM URANIUM URNM CORN WHEAT');
const INDICES = set('SP500 US500 US100 US30 NAS100 SPX500 NDX DJI GER40 UK100 JPN225 HK50 XYZ100 SPY QQQ DXY VIX RUSSELL MAG7');
const FX = set('EUR JPY GBP AUD CAD CHF CNH MXN EURUSD USDJPY GBPUSD AUDUSD USDCAD USDCHF KRW');
const EQUITIES = set(`TSLA NVDA AAPL MSFT AMZN META GOOGL GOOG COIN MSTR HOOD PLTR AMD NFLX INTC ORCL CRCL SNDK SKHX SMSN
  BABA TSM AVGO MU ARM CRWV RDDT UBER SHOP SQ PYPL IBM DIS NKE JPM GS BAC V MA WMT COST LLY UNH XOM CVX BA`);

/** The sector of a coin; `hip3` = it came from a builder-deployed dex (trade.xyz), which lists stocks. */
export function sectorOf(coin: string, hip3 = false): Sector {
  if (COMMODITIES.has(coin)) return 'commodities';
  if (INDICES.has(coin)) return 'indices';
  if (FX.has(coin)) return 'fx';
  if (EQUITIES.has(coin)) return 'equities';
  if (MAJORS.has(coin)) return 'majors';
  if (hip3) return 'equities';
  if (LAYER1.has(coin)) return 'layer1';
  if (DEFI.has(coin)) return 'defi';
  if (MEMES.has(coin)) return 'memes';
  if (AI.has(coin)) return 'ai';
  return 'other';
}

// --- wallets ----------------------------------------------------------------------------------

/** One open position as its venue names it. `szi` is signed (long > 0). */
export interface Position {
  symbol: string;
  szi: number;
  entry: number | null;
}

/** One wallet on one venue. */
export interface WalletVenue {
  /** All-time PnL, when the venue (or the index) has one. Cohort membership. */
  pnl: number | null;
  /** PnL over each page range, when the venue's lists (or the index) have it. Never all-time under a range. */
  pnlRange?: Partial<Record<CohortRange, number | null>>;
  equity: number | null;
  label: string | null;
  /** Open positions; null until they were read. */
  positions: readonly Position[] | null;
  /** When the positions were last known right (ms), 0 if never. */
  at: number;
  /** How many wallets this one stands for (1, or 1 / rate for a sampled tail wallet). */
  weight: number;
}

/** A price for a venue's symbol right now. */
export type MarkOf = (venue: Venue, symbol: string) => number | null;

export interface Holding {
  coin: string;
  sector: Sector;
  /** Signed notional, USD. */
  notional: number;
  upnl: number;
  /** Wallets this holding stands for (the venue's sampling weight). */
  weight: number;
}

export interface NettedWallet {
  address: string;
  label: string | null;
  venues: Venue[];
  pnl: number | null;
  /** PnL per range over the venues; null for a range any of them does not know. */
  pnlRange: Partial<Record<CohortRange, number | null>>;
  equity: number | null;
  /** Its positions were read on at least one of the venues. */
  covered: boolean;
  weight: number;
  holdings: Holding[];
}

/** One address over the chosen venues (see NETTING at the top). */
export function netWallet(address: string, per: ReadonlyMap<Venue, WalletVenue>, mark: MarkOf): NettedWallet {
  const hasHl = per.has('hyperliquid');
  let pnl: number | null = null;
  let equity: number | null = null;
  let label: string | null = null;
  let covered = false;
  let weight = 1;
  const by = new Map<string, Holding>();
  const venues: Venue[] = [];
  const range: Partial<Record<CohortRange, number | null>> = {};
  const unknown = new Set<CohortRange>();
  for (const [venue, w] of per) {
    venues.push(venue);
    label = label ?? w.label;
    const figures = !(venue === 'tradexyz' && hasHl);
    if (figures && w.pnl !== null) pnl = (pnl ?? 0) + w.pnl;
    if (figures && w.equity !== null) equity = (equity ?? 0) + w.equity;
    if (figures) {
      for (const r of COHORT_RANGES) {
        const v = w.pnlRange?.[r];
        if (typeof v === 'number' && Number.isFinite(v)) range[r] = (range[r] ?? 0) + v;
        else unknown.add(r);
      }
    }
    weight = Math.max(weight, w.weight);
    if (!w.positions) continue;
    covered = true;
    for (const p of w.positions) {
      if (!p.szi) continue;
      const px = mark(venue, p.symbol) ?? p.entry;
      if (px === null || !(px > 0)) continue;
      const coin = coinOf(p.symbol);
      const hip3 = venue === 'tradexyz' || p.symbol.includes(':');
      const h = by.get(coin) ?? { coin, sector: sectorOf(coin, hip3), notional: 0, upnl: 0, weight: w.weight };
      h.weight = Math.max(h.weight, w.weight);
      h.notional += p.szi * px;
      if (p.entry !== null) h.upnl += (px - p.entry) * p.szi;
      by.set(coin, h);
    }
  }
  // A range is known only when every venue in the sum knows it.
  for (const r of COHORT_RANGES) if (unknown.has(r) || range[r] === undefined) range[r] = null;
  return { address, label, venues, pnl, pnlRange: range, equity, covered, weight, holdings: [...by.values()] };
}

/** Every address in a set of venues, netted. */
export function scopeWallets(scope: readonly Venue[], per: ReadonlyMap<Venue, ReadonlyMap<string, WalletVenue>>, mark: MarkOf): NettedWallet[] {
  const addresses = new Set<string>();
  for (const v of scope) for (const a of per.get(v)?.keys() ?? []) addresses.add(a);
  const out: NettedWallet[] = [];
  for (const address of addresses) {
    const mine = new Map<Venue, WalletVenue>();
    for (const v of scope) {
      const w = per.get(v)?.get(address);
      if (w) mine.set(v, w);
    }
    out.push(netWallet(address, mine, mark));
  }
  return out;
}

/** 0..1 from an address: a fixed, uniform sample (the same wallets stay in it). */
export function sampleHash(address: string): number {
  let h = 2166136261;
  for (let i = 0; i < address.length; i++) {
    h ^= address.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}

/**
 * How a wallet on a venue that samples its tail takes part (`rate` < 1).
 * Stratified by CURRENT equity: above TAIL_EQUITY every wallet counts as
 * itself; below it only the fixed sample (sampleHash < rate) counts, each for
 * 1 / rate wallets, and a tail wallet outside the sample contributes no
 * positions even if it was read (it was read while it was large, or before
 * this rule): counting it too would count its stratum twice.
 */
export function sampleRule(rate: number, address: string, equity: number | null): { counts: boolean; weight: number } {
  if (rate >= 1 || (equity ?? 0) >= TAIL_EQUITY) return { counts: true, weight: 1 };
  return sampleHash(address) < rate ? { counts: true, weight: 1 / rate } : { counts: false, weight: 1 };
}

/** The positions a wallet contributes under the sampling rule (null = not covered). */
export function sampledVenue(
  rate: number, address: string,
  m: { pnl: number | null; equity: number | null; label: string | null; pnlRange?: Partial<Record<CohortRange, number | null>> } | undefined,
  book: { equity: number | null; positions: readonly Position[]; at: number } | undefined,
): WalletVenue {
  const eq = m?.equity ?? book?.equity ?? null;
  const rule = sampleRule(rate, address, eq);
  const read = book && rule.counts;
  return {
    pnl: m?.pnl ?? null, pnlRange: m?.pnlRange, equity: eq, label: m?.label ?? null,
    positions: read ? book.positions : null, at: read ? book.at : 0, weight: rule.weight,
  };
}

export interface CohortFilter {
  sector?: Sector | null;
  coin?: string | null;
}

export const matchesFilter = (h: Holding, f: CohortFilter): boolean =>
  (!f.coin || h.coin === f.coin) && (!f.sector || h.sector === f.sector);

/** The cohorts a netted wallet belongs to (one PnL cohort, one size cohort, either may be missing). */
export function cohortsOf(w: { pnl: number | null; equity: number | null }): CohortId[] {
  const out: CohortId[] = [];
  if (w.pnl !== null && Number.isFinite(w.pnl)) out.push(pnlCohort(w.pnl));
  const size = w.equity !== null ? sizeCohort(w.equity) : null;
  if (size) out.push(size);
  return out;
}

/** One wallet's figures under a filter. */
export interface WalletFigures {
  long: number;
  short: number;
  upnl: number;
  /** Holds at least one position the filter keeps. */
  holding: boolean;
}

export function walletFigures(w: NettedWallet, f: CohortFilter): WalletFigures {
  let long = 0;
  let short = 0;
  let upnl = 0;
  let holding = false;
  for (const h of w.holdings) {
    if (!matchesFilter(h, f)) continue;
    holding = true;
    if (h.notional > 0) long += h.notional;
    else short -= h.notional;
    upnl += h.upnl;
  }
  return { long, short, upnl, holding };
}

// --- cohort figures ----------------------------------------------------------------------------

export interface CohortMarket {
  coin: string;
  sector: Sector;
  long: number;
  short: number;
  upnl: number;
  /** Wallets holding it (either side), weighted. */
  holders: number;
}

export interface CohortStat {
  id: CohortId;
  /** Wallets in the cohort (exact, from the venues' lists). */
  wallets: number;
  /**
   * Wallets whose positions are known: every wallet read above the sampled
   * tail, plus the sampled tail wallets read, each counted for the ones it
   * stands for - an estimate there, so capped at `wallets`.
   */
  covered: number;
  /** Of those, wallets holding a position the filter keeps. */
  holding: number;
  long: number;
  short: number;
  upnl: number;
  /** Unrealised PnL of the wallets in profit, and of those in loss (<= 0). */
  upnlProfit: number;
  upnlLoss: number;
  inProfit: number;
  inLoss: number;
  /** Every coin held, largest gross exposure first. */
  markets: CohortMarket[];
}

const emptyStat = (id: CohortId): CohortStat => ({
  id, wallets: 0, covered: 0, holding: 0, long: 0, short: 0, upnl: 0, upnlProfit: 0, upnlLoss: 0, inProfit: 0, inLoss: 0, markets: [],
});

/**
 * Every cohort's figures, one wallet at a time - so a caller with a hundred
 * thousand wallets can pause between batches (the indexer does).
 */
export class Aggregator {
  private acc = new Map<CohortId, CohortStat>(COHORTS.map((c) => [c.id, emptyStat(c.id)]));
  private markets = new Map<CohortId, Map<string, CohortMarket>>(COHORTS.map((c) => [c.id, new Map()]));

  constructor(private readonly f: CohortFilter = {}) {}

  add(w: NettedWallet): void {
    const f = this.f;
    const ids = cohortsOf(w);
    if (!ids.length) return;
    const fig = w.covered ? walletFigures(w, f) : null;
    for (const id of ids) {
      const s = this.acc.get(id)!;
      s.wallets++;
      if (!fig) continue;
      // Counts by the wallet's weight, amounts by each holding's own (a sampled venue's).
      const k = w.weight;
      s.covered += k;
      if (!fig.holding) continue;
      s.holding += k;
      let upnl = 0;
      const m = this.markets.get(id)!;
      for (const h of w.holdings) {
        if (!matchesFilter(h, f) || !h.notional) continue;
        const n = h.notional * h.weight;
        if (n > 0) s.long += n;
        else s.short -= n;
        upnl += h.upnl * h.weight;
        const cur = m.get(h.coin) ?? { coin: h.coin, sector: h.sector, long: 0, short: 0, upnl: 0, holders: 0 };
        if (n > 0) cur.long += n;
        else cur.short -= n;
        cur.upnl += h.upnl * h.weight;
        cur.holders += h.weight;
        m.set(h.coin, cur);
      }
      s.upnl += upnl;
      if (upnl > 0) { s.inProfit += k; s.upnlProfit += upnl; }
      else if (upnl < 0) { s.inLoss += k; s.upnlLoss += upnl; }
    }
  }

  result(): CohortStat[] {
    return COHORTS.map((c) => {
      const s = { ...this.acc.get(c.id)! };
      // A sampled stratum is an estimate: in a small cohort it can overshoot the
      // exact wallet count. Never report more covered than there are wallets.
      s.covered = Math.min(s.wallets, Math.round(s.covered));
      s.holding = Math.min(s.covered, Math.round(s.holding));
      s.inProfit = Math.min(s.holding, Math.round(s.inProfit));
      s.inLoss = Math.min(s.holding - s.inProfit, Math.round(s.inLoss));
      s.markets = [...this.markets.get(c.id)!.values()]
        .map((x) => ({ ...x, holders: Math.round(x.holders) }))
        .sort((a, b) => b.long + b.short - (a.long + a.short));
      return s;
    });
  }
}

/** Every cohort's figures over a set of netted wallets, under a filter. */
export function aggregate(wallets: Iterable<NettedWallet>, f: CohortFilter = {}): CohortStat[] {
  const a = new Aggregator(f);
  for (const w of wallets) a.add(w);
  return a.result();
}

/** Per-sector totals of a cohort's markets. */
export function sectorTotals(markets: readonly CohortMarket[]): Array<{ sector: Sector; long: number; short: number }> {
  const by = new Map<Sector, { sector: Sector; long: number; short: number }>();
  for (const m of markets) {
    const cur = by.get(m.sector) ?? { sector: m.sector, long: 0, short: 0 };
    cur.long += m.long;
    cur.short += m.short;
    by.set(m.sector, cur);
  }
  return [...by.values()];
}

// --- wallet rows (the cohort page's table) ----------------------------------------------------

/** `pnl` sorts by the range's PnL; `pnlAll` by all-time PnL (membership). */
export type WalletSort = 'equity' | 'value' | 'leverage' | 'upnl' | 'pnl' | 'pnlAll' | 'winRate';
export const WALLET_SORTS: readonly WalletSort[] = ['equity', 'value', 'leverage', 'upnl', 'pnl', 'pnlAll', 'winRate'];

export interface CohortWalletRow {
  address: string;
  label: string | null;
  venues: Venue[];
  equity: number | null;
  /** All-time PnL: what the PnL cohort (membership) is based on. */
  pnl: number | null;
  /** PnL over the page's range (`CohortWalletsResponse.range`); null = not known for that range. */
  pnlRange: number | null;
  /** Win rate over the range (valuescan/winRate.ts), from the index; null below the threshold or not indexed. */
  winRate: number | null;
  winRateExact: boolean;
  winRateCloses: number | null;
  /** Gross position value under the filter; null when never read. */
  value: number | null;
  leverage: number | null;
  upnl: number | null;
  long: number | null;
  short: number | null;
  lean: Lean | null;
  pnlCohort: CohortId | null;
  sizeCohort: CohortId | null;
  /** A sampled wallet standing for several. */
  weight: number;
}

export function walletRow(w: NettedWallet, f: CohortFilter, range: CohortRange = '30d'): CohortWalletRow {
  const fig = w.covered ? walletFigures(w, f) : null;
  const value = fig ? fig.long + fig.short : null;
  const pnlC = w.pnl !== null && Number.isFinite(w.pnl) ? pnlCohort(w.pnl) : null;
  return {
    address: w.address,
    label: w.label,
    venues: w.venues,
    equity: w.equity,
    pnl: w.pnl,
    pnlRange: w.pnlRange[range] ?? null,
    winRate: null,
    winRateExact: false,
    winRateCloses: null,
    value,
    leverage: value !== null && w.equity !== null && w.equity > 0 ? value / w.equity : null,
    upnl: fig ? fig.upnl : null,
    long: fig ? fig.long : null,
    short: fig ? fig.short : null,
    lean: fig && fig.holding ? leanOf(longShare(fig.long, fig.short)) : null,
    pnlCohort: pnlC,
    sizeCohort: w.equity !== null ? sizeCohort(w.equity) : null,
    weight: w.weight,
  };
}

/** Venue sets as one key: sorted, `+`-joined ("hyperliquid+sodex"). */
export const scopeKey = (venues: readonly Venue[]): string => [...new Set(venues)].sort().join('+');

/** Filters as one key ("", "s:memes", "c:BTC"). */
export const filterKey = (f: CohortFilter): string => (f.coin ? `c:${f.coin}` : f.sector ? `s:${f.sector}` : '');

// --- the API ------------------------------------------------------------------------------------

export interface VenueCoverage {
  /** Wallets the venue ranks or the index saw. */
  members: number;
  /** Of those, wallets whose positions are known. */
  covered: number;
  /** Share of small wallets read, when the tail is sampled (1 = all). */
  tailRate: number;
}

/** A cohort card: today's figures and its lean over the last days as [t, long share]. */
export interface CohortCard extends Omit<CohortStat, 'markets'> {
  spark: Array<[number, number]>;
}

export interface CohortsResponse {
  venues: Venue[];
  filter: CohortFilter;
  /** When positions were last folded in (ms); 0 while the first pass runs. */
  at: number;
  cohorts: CohortCard[];
  coverage: Partial<Record<Venue, VenueCoverage>>;
  /** Every coin held in this scope, largest first, for the asset picker. */
  coins: Array<{ coin: string; sector: Sector; gross: number }>;
}

export type CohortRange = '1d' | '7d' | '30d';
export const COHORT_RANGES: readonly CohortRange[] = ['1d', '7d', '30d'];

export interface CohortPoint {
  t: number;
  long: number;
  short: number;
}

export interface CohortDetailResponse {
  venues: Venue[];
  filter: CohortFilter;
  at: number;
  range: CohortRange;
  cohort: CohortStat;
  series: CohortPoint[];
  coverage: Partial<Record<Venue, VenueCoverage>>;
}

export interface CohortWalletsResponse {
  total: number;
  /** The range `pnlRange` and the win rate cover. */
  range: CohortRange;
  rows: CohortWalletRow[];
}

// --- the market map and an asset / sector page ---------------------------------------------

/**
 * Every wallet once: the size cohorts partition the wallets that hold equity,
 * so their markets summed are the whole population's.
 */
export function everyWallet(stats: readonly CohortStat[]): CohortMarket[] {
  const by = new Map<string, CohortMarket>();
  for (const st of stats) {
    if (COHORT_BY_ID[st.id].kind !== 'size') continue;
    for (const m of st.markets) {
      const cur = by.get(m.coin) ?? { coin: m.coin, sector: m.sector, long: 0, short: 0, upnl: 0, holders: 0 };
      cur.long += m.long;
      cur.short += m.short;
      cur.upnl += m.upnl;
      cur.holders += m.holders;
      by.set(m.coin, cur);
    }
  }
  return [...by.values()].sort((a, b) => b.long + b.short - (a.long + a.short));
}

export interface MapSector {
  sector: Sector;
  long: number;
  short: number;
  upnl: number;
  assets: CohortMarket[];
}

export interface CohortMapResponse {
  venues: Venue[];
  /** Whose positions: one cohort, or every wallet (null). */
  cohort: CohortId | null;
  at: number;
  sectors: MapSector[];
  coverage: Partial<Record<Venue, VenueCoverage>>;
}

/** One cohort on the page's asset or sector. */
export interface FocusCohort {
  id: CohortId;
  wallets: number;
  holding: number;
  long: number;
  short: number;
  upnl: number;
  inProfit: number;
  inLoss: number;
}

export interface CohortFocusResponse {
  venues: Venue[];
  filter: CohortFilter;
  at: number;
  range: CohortRange;
  /** Every wallet together. */
  total: { long: number; short: number; upnl: number; holding: number; inProfit: number; inLoss: number };
  cohorts: FocusCohort[];
  /** Each cohort's [t, long, short] over the range (hourly). */
  series: Partial<Record<CohortId, CohortPoint[]>>;
  /** A sector's assets (every wallet), largest first; empty for one asset. */
  assets: CohortMarket[];
  coverage: Partial<Record<Venue, VenueCoverage>>;
}
