/**
 * ValueDesk indexes: baskets of SoDEX Wealth funds bought in one go on ValueDesk. Owner 2026-11-28: "custom stuff from
 * us, so e.g. valuedesk indexes that combine multiple wealth products", then "create your own ... You can select
 * everything, no longterm rebalancing on our side tho just yet ... ValueDesk indexes can also be published".
 *
 * Three kinds, one shape:
 *   ValueDesk's own   VD_INDEXES below
 *   a draft           made on this page and kept in this browser (localStorage) until it is published
 *   published         a wallet's index on the server for everyone (apps/server/src/indexes, trading/vdIndexApi.ts)
 *
 * Fixed weights at the moment of buying, then held as bought: no rebalancing (owner 2026-11-27), so the weights drift
 * with prices the way a market-cap index does. Each leg goes through its fund's own channel:
 *
 *   clob fund (vVOO, vQQQ...)    a spot market buy sized in USDC, from Spot (carries the builder fee like any order)
 *   escrow vault (CXMT, Unitree)  a batch request or a maker's quote, from the wallet on ValueChain
 *   USDC Earn                     SoDEX's bridge (trading/wealthEarn.ts), from the wallet on ValueChain
 *   ANT Believers Index           a maker's quote through the index contract (trading/ssi.ts)
 *
 * A recurring index is one SoDEX recurring plan per leg, same schedule, amounts by weight (trading/recurring.ts), so
 * only funds SoDEX's recurring-buy contract lists can be in one. Returns are computed from SoDEX's own daily closes of
 * each fund (price-history, as far back as SoDEX has them), as a buy-and-hold basket from the first day every leg has a
 * close. A leg SoDEX keeps no closes for (USDC Earn) is left out of the chart and said so; nothing is projected.
 */
import { closedLine, type FundAction, type WealthFund, type WealthQuote } from './wealth';
import type { RecurringTarget } from './recurring';

export interface IndexLeg { fundId: string; weight: number }
export type IndexKind = 'valuedesk' | 'sosovalue' | 'draft' | 'published';
export interface VdIndex {
  id: string;
  name: string;
  line: string;
  legs: IndexLeg[];
  /** ValueDesk's own when left out. */
  kind?: IndexKind;
  /** A published index's wallet, lowercase. */
  owner?: string | null;
  ownerName?: string | null;
  createdAt?: number;
  updatedAt?: number;
  /** A draft that was published: the published id, so the page can say so and update it. */
  publishedId?: string | null;
  /** A published index's picture: the SHA-256 of its bytes (served at /api/vs/indexes/image/<hash>). */
  image?: string | null;
  /** A draft's picture, as a data URL made by trading/indexPicture.ts, kept in this browser. */
  picture?: string | null;
}

export const VD_INDEXES: readonly VdIndex[] = [
  { id: 'us-core', name: 'ValueDesk US Core', line: 'The S&P 500, the Nasdaq 100 and US dividend payers.', legs: [{ fundId: 'vVOO', weight: 0.6 }, { fundId: 'vQQQ', weight: 0.25 }, { fundId: 'vSCHD', weight: 0.15 }] },
  { id: 'tech', name: 'ValueDesk Tech & Chips', line: 'US tech leaders, the semiconductor 25 and broad tech.', legs: [{ fundId: 'vQQQ', weight: 0.4 }, { fundId: 'vSMH', weight: 0.3 }, { fundId: 'vVGT', weight: 0.3 }] },
  { id: 'dividends', name: 'ValueDesk Dividend Payers', line: 'The two US dividend stock funds with STRC preferred.', legs: [{ fundId: 'vSCHD', weight: 0.4 }, { fundId: 'vVYM', weight: 0.4 }, { fundId: 'vSTRC', weight: 0.2 }] },
  { id: 'balanced', name: 'ValueDesk Balanced', line: 'Stocks and T-bill yield: the S&P 500 and Nasdaq 100 beside US Cash Yield.', legs: [{ fundId: 'vVOO', weight: 0.4 }, { fundId: 'vQQQ', weight: 0.2 }, { fundId: 'vBOXX', weight: 0.4 }] },
  { id: 'cash', name: 'ValueDesk Cash Yield', line: 'Two dollar yields in one: USDC Earn and US Cash Yield, half each.', legs: [{ fundId: 'Morpho-Earn', weight: 0.5 }, { fundId: 'vBOXX', weight: 0.5 }] },
  { id: 'us-equal', name: 'ValueDesk US Equal Weight', line: 'Every US stock fund on SoDEX Wealth, in near-equal parts.', legs: [{ fundId: 'vVOO', weight: 0.17 }, { fundId: 'vQQQ', weight: 0.17 }, { fundId: 'vSCHD', weight: 0.17 }, { fundId: 'vSMH', weight: 0.17 }, { fundId: 'vVGT', weight: 0.16 }, { fundId: 'vVYM', weight: 0.16 }] },
];

export const kindOf = (ix: VdIndex): IndexKind => ix.kind ?? 'valuedesk';

/**
 * SoSoValue's SSI index tokens SoDEX offers (owner 2026-11-28: "shouldnt we include some original sodex indexes and
 * then ssi ones in the index page?"): each one token whose basket SoSoValue manages, shown among the indexes and opening
 * its fund page, where its basket is read from its own contract. Lines say only what the baskets hold (2026-11-28).
 */
export const SOSO_INDEXES: readonly VdIndex[] = [
  { id: 'antb', name: 'ANT Believers Index', line: 'Anthropic and the listed companies that invest in or supply it; rebalanced quarterly.', legs: [{ fundId: 'antb', weight: 1 }], kind: 'sosovalue' },
  { id: 'vMAG7ssi', name: 'MAG7.ssi', line: 'Seven large crypto assets in one token: BTC, ETH, BNB, XRP, SOL, HYPE and DOGE.', legs: [{ fundId: 'vMAG7ssi', weight: 1 }], kind: 'sosovalue' },
  { id: 'vDEFIssi', name: 'DEFI.ssi', line: 'DeFi tokens in one: HYPE, LINK, UNI, AAVE and more.', legs: [{ fundId: 'vDEFIssi', weight: 1 }], kind: 'sosovalue' },
  { id: 'vMEMEssi', name: 'MEME.ssi', line: 'Meme coins in one: DOGE, SHIB, PEPE and more.', legs: [{ fundId: 'vMEMEssi', weight: 1 }], kind: 'sosovalue' },
  { id: 'vUSSI', name: 'USSI', line: 'SoSoValue’s hedged index token, redeemable in USDC.', legs: [{ fundId: 'vUSSI', weight: 1 }], kind: 'sosovalue' },
];

/** Every index adds up to one. */
export const weightsOk = (ix: VdIndex): boolean => Math.abs(ix.legs.reduce((s, l) => s + l.weight, 0) - 1) < 1e-9 && ix.legs.every((l) => l.weight > 0);

/** Basis points to weights and back (the published form is whole basis points adding up to 10000). */
export const legsFromBp = (legs: ReadonlyArray<{ fundId: string; bp: number }>): IndexLeg[] => legs.map((l) => ({ fundId: l.fundId, weight: l.bp / 10_000 }));
export const bpFromLegs = (legs: readonly IndexLeg[]): Array<{ fundId: string; bp: number }> => legs.map((l) => ({ fundId: l.fundId, bp: Math.round(l.weight * 10_000) }));

/** Equal parts in whole basis points, the remainder on the first legs: 3 funds are 3334 / 3333 / 3333. */
export function equalBp(n: number): number[] {
  if (n <= 0) return [];
  const base = Math.floor(10_000 / n);
  return Array.from({ length: n }, (_, i) => base + (i < 10_000 - base * n ? 1 : 0));
}

/** Every index that holds a fund. */
export const indexesWith = (fundId: string, list: readonly VdIndex[]): VdIndex[] => list.filter((ix) => ix.legs.some((l) => l.fundId === fundId));

// --- performance ------------------------------------------------------------------------------------

export interface Close { t: number; close: number }

const at = (pts: readonly Close[], t: number): number | null => {
  let lo = 0, hi = pts.length - 1, hit: number | null = null;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (pts[m]!.t <= t) { hit = pts[m]!.close; lo = m + 1; } else hi = m - 1; }
  return hit;
};

/**
 * The basket's value over time, 1 at the start: on each day any leg has a close for (each leg at its last close at or
 * before that day), sum of weight x close / first close. Starts on the first day all legs have one; null without
 * history for every leg.
 */
export function basketSeries(ix: Pick<VdIndex, 'legs'>, closes: ReadonlyMap<string, readonly Close[]>): Array<{ t: number; v: number }> | null {
  const series = ix.legs.map((l) => ({ w: l.weight, pts: [...(closes.get(l.fundId) ?? [])].sort((a, b) => a.t - b.t) }));
  if (series.length === 0 || series.some((s) => s.pts.length < 2)) return null;
  const start = Math.max(...series.map((s) => s.pts[0]!.t));
  const days = [...new Set(series.flatMap((s) => s.pts.map((p) => p.t)).filter((t) => t >= start))].sort((a, b) => a - b);
  const base = series.map((s) => at(s.pts, start)!);
  const out: Array<{ t: number; v: number }> = [];
  for (const t of days) {
    let v = 0;
    for (let i = 0; i < series.length; i++) v += series[i]!.w * (at(series[i]!.pts, t)! / base[i]!);
    out.push({ t, v });
  }
  return out.length >= 2 ? out : null;
}

/**
 * The basket's history from the legs SoDEX keeps closes for, their weights scaled to add up to one again; the legs
 * left out are named so the page says so. Null when no leg has closes.
 */
export function basketHistory(ix: Pick<VdIndex, 'legs'>, closes: ReadonlyMap<string, readonly Close[]>): { series: Array<{ t: number; v: number }>; leftOut: string[]; share: number } | null {
  const kept = ix.legs.filter((l) => (closes.get(l.fundId)?.length ?? 0) >= 2);
  const leftOut = ix.legs.filter((l) => !kept.includes(l)).map((l) => l.fundId);
  const share = kept.reduce((s, l) => s + l.weight, 0);
  if (!kept.length || share <= 0) return null;
  const series = basketSeries({ legs: kept.map((l) => ({ fundId: l.fundId, weight: l.weight / share })) }, closes);
  return series ? { series, leftOut, share } : null;
}

/** The change over the last `days` of a series (from the last point at or before then), as a fraction; null if too short. */
export function changeOver(s: ReadonlyArray<{ t: number; v: number }> | null, days: number): number | null {
  if (!s || s.length < 2) return null;
  const end = s[s.length - 1]!;
  const from = end.t - days * 86_400_000;
  if (s[0]!.t > from + 86_400_000) return null;
  let start = s[0]!;
  for (const p of s) { if (p.t <= from) start = p; else break; }
  return end.v / start.v - 1;
}

/** The yearly rate a series grew at, start to end (only over a year or more, else null). */
export function annualised(s: ReadonlyArray<{ t: number; v: number }> | null): number | null {
  if (!s || s.length < 2) return null;
  const years = (s[s.length - 1]!.t - s[0]!.t) / (365.25 * 86_400_000);
  if (years < 1) return null;
  return (s[s.length - 1]!.v / s[0]!.v) ** (1 / years) - 1;
}

/** The deepest fall from a high, as a negative fraction (0 when it never fell). */
export function maxDrawdown(s: ReadonlyArray<{ t: number; v: number }> | null): number | null {
  if (!s || s.length < 2) return null;
  let peak = s[0]!.v, worst = 0;
  for (const p of s) { peak = Math.max(peak, p.v); worst = Math.min(worst, p.v / peak - 1); }
  return worst;
}

/** The series from `days` back (all of it for null), rebased to 1 at its first point. */
export function rangeOf(s: ReadonlyArray<{ t: number; v: number }>, days: number | null): Array<{ t: number; v: number }> {
  if (!s.length) return [];
  const from = days === null ? -Infinity : s[s.length - 1]!.t - days * 86_400_000;
  let i = 0;
  while (i < s.length - 1 && s[i + 1]!.t <= from) i++;
  const part = s.slice(i);
  const b = part[0]!.v;
  return part.map((p) => ({ t: p.t, v: p.v / b }));
}

/** The basket's 7-day APY where every leg has one (SoDEX's, by weight); null otherwise. */
export function basketApy(ix: Pick<VdIndex, 'legs'>, quotes: ReadonlyMap<string, WealthQuote>): number | null {
  let s = 0;
  for (const l of ix.legs) {
    const v = Number(quotes.get(l.fundId)?.apy7d);
    if (!Number.isFinite(v)) return null;
    s += l.weight * v;
  }
  return s;
}

// --- buying once -----------------------------------------------------------------------------------

export type LegRoute = 'spot' | 'batch' | 'rfq' | 'earn' | 'closed';
export interface PlannedLeg { fundId: string; fund: WealthFund | null; weight: number; usd: number; route: LegRoute; why: string | null; from: 'spot' | 'wallet' }

/** A leg whose fund's status is still being read: not closed, only not known yet. */
export const LEG_READING = 'Reading what this fund allows.';

/** Where a leg goes now, from its fund's action (fundAction) and type. */
export function routeOf(fund: WealthFund | null, action: FundAction | null): { route: LegRoute; why: string | null } {
  if (!fund) return { route: 'closed', why: 'SoDEX does not list this fund right now.' };
  if (fund.comingSoon) return { route: 'closed', why: `Coming soon: ${fund.comingSoon}` };
  if (fund.fundType === 'bridged_vault') return { route: 'earn', why: null };
  if (!action) return { route: 'closed', why: LEG_READING };
  if (action.kind === 'trade') return { route: 'spot', why: null };
  if (action.kind === 'batch') return { route: 'batch', why: null };
  if (action.kind === 'rfq') return { route: 'rfq', why: null };
  // sodex.com's words for it, with the countdown; SoDEX's reason (market closed, a break, paused) stays in the title.
  if (action.kind === 'closed') return { route: 'closed', why: closedLine(action.nextAt) };
  return { route: 'closed', why: action.why };
}

/** The legs of `usd` into an index, cents rounded down, the remainder on the largest leg. */
export function planLegs(ix: Pick<VdIndex, 'legs'>, usd: number, funds: readonly WealthFund[] | null, actions: ReadonlyMap<string, FundAction | null>): PlannedLeg[] {
  const cents = Math.floor(usd * 100);
  const legs = ix.legs.map((l) => ({ l, c: Math.floor(cents * l.weight) }));
  const rest = cents - legs.reduce((s, x) => s + x.c, 0);
  const biggest = legs.reduce((a, b) => (b.l.weight > a.l.weight ? b : a), legs[0]!);
  biggest.c += rest;
  return legs.map(({ l, c }) => {
    const fund = funds?.find((f) => f.fundId === l.fundId) ?? null;
    const { route, why } = routeOf(fund, actions.get(l.fundId) ?? null);
    return { fundId: l.fundId, fund, weight: l.weight, usd: c / 100, route, why, from: route === 'spot' ? 'spot' : 'wallet' };
  });
}

/** The least that buys every leg at or above its own minimum (`mins`: USD per fund), rounded up to a dollar. */
export function minimumFor(ix: Pick<VdIndex, 'legs'>, mins: ReadonlyMap<string, number>): number {
  let m = 0;
  for (const l of ix.legs) m = Math.max(m, (mins.get(l.fundId) ?? 0) / l.weight);
  return Math.ceil(m);
}

// --- buying on a schedule ---------------------------------------------------------------------------

export interface RecurringLeg { fundId: string; weight: number; /** USDC base units per run. */ amount: bigint; target: RecurringTarget | null }

/** The legs SoDEX's recurring-buy contract does not list: such an index can only be bought once. */
export const notRecurring = (ix: Pick<VdIndex, 'legs'>, targets: readonly RecurringTarget[]): string[] =>
  ix.legs.filter((l) => !targets.some((t) => t.fund.fundId === l.fundId)).map((l) => l.fundId);

/** Each leg's amount per run of `perRun` base units, rounded down, the remainder on the largest leg. */
export function recurringLegs(ix: Pick<VdIndex, 'legs'>, perRun: bigint, targets: readonly RecurringTarget[]): RecurringLeg[] {
  const legs = ix.legs.map((l) => ({ fundId: l.fundId, weight: l.weight, amount: (perRun * BigInt(Math.round(l.weight * 10_000))) / 10_000n, target: targets.find((t) => t.fund.fundId === l.fundId) ?? null }));
  if (!legs.length) return legs;
  const rest = perRun - legs.reduce((s, l) => s + l.amount, 0n);
  const biggest = legs.reduce((a, b) => (b.weight > a.weight ? b : a), legs[0]!);
  biggest.amount += rest;
  return legs;
}

/** The least per run that keeps every leg at or above its own minimum per purchase, in base units rounded up to a dollar. */
export function recurringMinimum(ix: Pick<VdIndex, 'legs'>, targets: readonly RecurringTarget[]): bigint {
  let m = 0;
  for (const l of ix.legs) {
    const t = targets.find((x) => x.fund.fundId === l.fundId);
    if (t) m = Math.max(m, Number(t.minAmount) / 1e6 / l.weight);
  }
  return BigInt(Math.ceil(m)) * 1_000_000n;
}

// --- kept in this browser ----------------------------------------------------------------------------

export interface IndexBuy { id: string; at: number; usd: number; legs: Array<{ fundId: string; usd: number; units: number | null; ok: boolean }> }
export interface IndexPlan { id: string; at: number; perRun: number; type: string; day: number; legs: Array<{ fundId: string; usd: number; ok: boolean }> }

const BUYS = (owner: string) => `vs.vdindex.${owner.toLowerCase()}`;
const PLANS = (owner: string) => `vs.vdindex.plans.${owner.toLowerCase()}`;
const DRAFTS = 'vs.vdindex.drafts';
const listeners = new Set<() => void>();
let version = 0;
const changed = () => { version++; for (const l of [...listeners]) l(); };
/** For useSyncExternalStore: what this browser keeps changed (a buy, a plan, a draft). */
export const subscribeKept = (fn: () => void): (() => void) => { listeners.add(fn); return () => listeners.delete(fn); };
export const keptVersion = (): number => version;
if (typeof window !== 'undefined') window.addEventListener('storage', (e) => { if (e.key?.startsWith('vs.vdindex')) changed(); });

function readList<T>(key: string, ok: (x: unknown) => x is T): T[] {
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? '[]') as unknown;
    return Array.isArray(raw) ? raw.filter(ok) : [];
  } catch { return []; }
}
function writeList(key: string, list: unknown[]): void {
  try { localStorage.setItem(key, JSON.stringify(list)); } catch { /* this tab only */ }
  changed();
}

const isBuy = (b: unknown): b is IndexBuy => !!b && typeof b === 'object' && typeof (b as IndexBuy).id === 'string' && Array.isArray((b as IndexBuy).legs);
export const readBuys = (owner: string): IndexBuy[] => readList(BUYS(owner), isBuy);
export const saveBuy = (owner: string, b: IndexBuy): void => writeList(BUYS(owner), [...readBuys(owner), b].slice(-200));
export const dropBuys = (owner: string, id: string): void => writeList(BUYS(owner), readBuys(owner).filter((b) => b.id !== id));

const isPlan = (p: unknown): p is IndexPlan => !!p && typeof p === 'object' && typeof (p as IndexPlan).id === 'string' && Array.isArray((p as IndexPlan).legs) && typeof (p as IndexPlan).type === 'string';
export const readIndexPlans = (owner: string): IndexPlan[] => readList(PLANS(owner), isPlan);
export const saveIndexPlan = (owner: string, p: IndexPlan): void => writeList(PLANS(owner), [...readIndexPlans(owner), p].slice(-100));

const isDraft = (d: unknown): d is VdIndex => !!d && typeof d === 'object' && typeof (d as VdIndex).id === 'string' && /^d[0-9a-z]{9}$/.test((d as VdIndex).id) && Array.isArray((d as VdIndex).legs);
export const readDrafts = (): VdIndex[] => readList(DRAFTS, isDraft).map((d) => ({ ...d, kind: 'draft' as const }));
export function saveDraft(d: VdIndex): VdIndex {
  const now = Date.now();
  const id = d.id && /^d[0-9a-z]{9}$/.test(d.id) ? d.id : newDraftId();
  const kept: VdIndex = { id, name: d.name, line: d.line, legs: d.legs, kind: 'draft', createdAt: d.createdAt ?? now, updatedAt: now, publishedId: d.publishedId ?? null, picture: d.picture ?? null };
  writeList(DRAFTS, [...readDrafts().filter((x) => x.id !== id), kept]);
  return kept;
}
export const dropDraft = (id: string): void => writeList(DRAFTS, readDrafts().filter((d) => d.id !== id));

function newDraftId(): string {
  const b = new Uint8Array(9);
  crypto.getRandomValues(b);
  return `d${Array.from(b, (x) => (x % 36).toString(36)).join('')}`;
}

// --- editing weights (the builder) ------------------------------------------------------------------
//
// Owner 2026-11-28: "a weight can be set to 100%, it should just be one moves the other", and a clean-up "which then
// rounds it to the nearest clean number - needs to be dynamic depending on size, so 0.46% doesnt go to 1% if theres a
// lot of small stuff". Weights are whole basis points and always add up to 10000 while editing.

export interface BpLeg { fundId: string; bp: number }
const TOTAL = 10_000;

/** Spread `amount` bp over `legs` in proportion to `by` (whole bp, largest remainders first). */
function spread(amount: number, by: number[]): number[] {
  const sum = by.reduce((a, b) => a + b, 0);
  const share = by.map((b) => (sum > 0 ? (amount * b) / sum : amount / by.length));
  const out = share.map((x) => Math.floor(x));
  let rest = amount - out.reduce((a, b) => a + b, 0);
  const order = share.map((x, i) => [x - Math.floor(x), i] as const).sort((a, b) => b[0] - a[0]);
  for (let k = 0; rest > 0 && k < order.length; k++, rest--) out[order[k]![1]]! += 1;
  return out;
}

/**
 * One leg set to `bp`; the others give or take the difference in proportion to their size, each keeping at least
 * `min`. The total stays 10000, so no leg can reach 100% while others are in.
 */
export function setWeight(legs: readonly BpLeg[], fundId: string, bp: number, min = 10): BpLeg[] {
  const i = legs.findIndex((l) => l.fundId === fundId);
  if (i < 0) return [...legs];
  if (legs.length === 1) return [{ ...legs[0]!, bp: TOTAL }];
  const others = legs.filter((_, k) => k !== i);
  const target = Math.round(Math.max(min, Math.min(TOTAL - min * others.length, bp)));
  // The rest in proportion to what the others have now; any pushed under the minimum is lifted, from the largest.
  const share = spread(TOTAL - target, others.map((l) => Math.max(1, l.bp)));
  for (let k = 0; k < share.length; k++) {
    if (share[k]! >= min) continue;
    const need = min - share[k]!;
    share[k] = min;
    const big = share.indexOf(Math.max(...share));
    share[big]! -= need;
  }
  let o = 0;
  return legs.map((l, k) => (k === i ? { ...l, bp: target } : { ...l, bp: share[o++]! }));
}

/** A fund added: an equal share for it, taken from the others in proportion. */
export function addLeg(legs: readonly BpLeg[], fundId: string, min = 10): BpLeg[] {
  if (legs.some((l) => l.fundId === fundId)) return [...legs];
  if (!legs.length) return [{ fundId, bp: TOTAL }];
  return setWeight([...legs, { fundId, bp: 0 }], fundId, Math.round(TOTAL / (legs.length + 1)), min);
}

/** A fund removed: its share back to the others in proportion. */
export function removeLeg(legs: readonly BpLeg[], fundId: string): BpLeg[] {
  const rest = legs.filter((l) => l.fundId !== fundId);
  if (!rest.length) return [];
  const add = spread(TOTAL - rest.reduce((s, l) => s + l.bp, 0), rest.map((l) => l.bp));
  return rest.map((l, i) => ({ ...l, bp: l.bp + add[i]! }));
}

/** Steps tried, largest first, in bp: 5%, 2.5%, 1%, 0.5%, 0.25%, 0.1%, 0.05%, 0.01%. Each divides 10000. */
const STEPS = [500, 250, 100, 50, 25, 10, 5, 1];

/**
 * The weights rounded to the cleanest step that moves no leg by more than `tolerance` of its own size (so 0.46% among
 * many small legs stays near 0.46%, and 33.34 / 33.33 / 33.33 becomes 34 / 33 / 33; by default 3%), the total kept at 10000 by putting the rounding left over on the legs that lost the most.
 */
export function cleanWeights(legs: readonly BpLeg[], tolerance = 0.03, min = 10): BpLeg[] {
  if (legs.length < 2) return legs.map((l) => ({ ...l, bp: TOTAL }));
  for (const step of STEPS) {
    if (step < min && step !== 1) continue;
    const r = legs.map((l) => Math.max(step, Math.round(l.bp / step) * step));
    let diff = TOTAL - r.reduce((a, b) => a + b, 0);
    // Settle the difference a step at a time on the legs whose rounding moved them most the other way.
    const order = legs.map((l, i) => i).sort((a, b) => (diff > 0 ? (legs[a]!.bp - r[a]!) - (legs[b]!.bp - r[b]!) : (r[a]! - legs[a]!.bp) - (r[b]! - legs[b]!.bp))).reverse();
    for (let k = 0; diff !== 0 && k < order.length * 4; k++) {
      const i = order[k % order.length]!;
      const d = diff > 0 ? step : -step;
      if (r[i]! + d < Math.max(min, step)) continue;
      r[i]! += d;
      diff -= d;
    }
    if (diff !== 0) continue;
    if (legs.every((l, i) => Math.abs(r[i]! - l.bp) <= Math.max(tolerance * l.bp, 0.5))) return legs.map((l, i) => ({ ...l, bp: r[i]! }));
  }
  return [...legs];
}
