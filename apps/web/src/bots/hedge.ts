/**
 * The hedge bot on the web (owner 2026-11-14): its draft, the two signed specs, and the numbers the page shows before
 * anything starts. The engine's arithmetic is the same (copy-engine algo/hedge.ts): what is shown here is what runs.
 *
 *   pair  a perp leg in this wallet, the opposite leg in a second wallet. Each wallet signs its own leg; the legs pair
 *         by an id and by naming each other. The second wallet starts its leg on this same page once it is connected
 *         (an invitation kept in this browser, pendingPairs).
 *   spot  a short in this wallet, as large as the coin it holds in its futures balance (bought on spot and moved to
 *         Futures first: SoDEX counts it as margin, BTC at 90%).
 *
 * Pure: the page and its tests read the same numbers.
 */
import { maxQtyAt } from '@copy-engine';

export type HedgeShape = 'pair' | 'spot';

export interface HedgeDraft {
  shape: HedgeShape;
  symbol: string;
  /** This wallet's leg in a pair (the second wallet takes the other side); the spot shape is always short. */
  side: 'buy' | 'sell';
  /** Each leg's target, USD: the open interest per leg. */
  sizeUsd: number;
  /** What each leg's account brings as margin, USD (the estimate; a real leg reads its account). */
  marginUsd: number;
  /** Set on SoDEX before the first order (the market's maximum by default: the least margin locked). */
  leverage: number;
  /** Both legs shrink when a liquidation comes within this many % of the price. */
  minLiqPct: number;
  /** They grow back only while every liquidation stays this far away. */
  growLiqPct: number;
  /** Each step per leg, USD. */
  sliceUsd: number;
  /** A taker's limit, bp from the mark. */
  maxSlipBps: number;
  /** The second wallet (pair). */
  partner: string;
  maxLossUsd: number | null;
  takeProfitUsd: number | null;
  runHours: number | null;
  onStop: 'close' | 'keep';
  /** How much of the way to the liquidation the price may use before both legs shrink (sets minLiqPct, growLiqPct). */
  safety: HedgeSafety;
  paper: boolean;
  label: string;
}

export const HEDGE_DEFAULT: Omit<HedgeDraft, 'symbol'> = {
  shape: 'pair',
  side: 'buy',
  sizeUsd: 1_000,
  marginUsd: 200,
  leverage: 40,
  minLiqPct: 3,
  growLiqPct: 6,
  sliceUsd: 250,
  maxSlipBps: 15,
  partner: '',
  maxLossUsd: 25,
  takeProfitUsd: null,
  runHours: null,
  onStop: 'close',
  safety: 'balanced',
  paper: false,
  label: '',
};

/**
 * Safety, as a share of the way to the liquidation (owner 2026-11-15: "safety needs to be within liquidation, not
 * price; for high leverage it would trigger instantly"): both legs shrink once the price has used up this share of
 * the distance a leg starts with at its leverage, and grow back only while 90% of that distance is free again.
 */
export type HedgeSafety = 'early' | 'balanced' | 'late';
export const SAFETY_USED: Record<HedgeSafety, number> = { early: 0.4, balanced: 0.6, late: 0.8 };
/** The engine's floors (copy-engine algo/spec.ts LIMITS.hedge): a buffer under these is refused. */
const MIN_LIQ_FLOOR = 0.5;
const GROW_LIQ_FLOOR = 1;

/**
 * How far a leg's liquidation starts (share of the price) at `leverage`: its account holds the size / leverage as
 * margin; the short's side is the closer one, (1/L - m) / (1 + m).
 */
export function startDistance(leverage: number, maxLeverage: number): number {
  const L = Math.max(1, Math.min(leverage, maxLeverage));
  const m = mmrOf(maxLeverage);
  return Math.max(0, (1 / L - m) / (1 + m));
}

/** The engine's two buffers (% of the price) for a leverage and a safety, kept above the engine's floors. */
export function buffersFor(leverage: number, maxLeverage: number, safety: HedgeSafety): { minLiqPct: number; growLiqPct: number; startPct: number } {
  const d0 = startDistance(leverage, maxLeverage) * 100;
  const r = (x: number) => Math.round(x * 100) / 100;
  const minLiqPct = r(Math.max(MIN_LIQ_FLOOR, d0 * (1 - SAFETY_USED[safety])));
  const growLiqPct = r(Math.max(GROW_LIQ_FLOOR, minLiqPct + 0.25, d0 * 0.9));
  return { minLiqPct, growLiqPct, startPct: d0 };
}

export const isAddress = (x: string): boolean => /^0x[0-9a-fA-F]{40}$/.test(x.trim());

/** A pair's id: the same on both legs (the engine pairs legs by it and by their naming each other). */
export function newPairId(rand: () => number = Math.random): string {
  const part = () => Math.floor(rand() * 0x1_0000_0000).toString(36).padStart(7, '0');
  return `pair-${Date.now().toString(36)}-${part()}`;
}

/** The two specs (the main signs its own; the second wallet signs `partner`). */
export function hedgeSpecs(d: HedgeDraft, owner: string, pairId: string, now = Date.now()): { main: Record<string, unknown>; partner: Record<string, unknown> | null } {
  const common = {
    kind: 'hedge',
    symbol: d.symbol,
    shape: d.shape,
    sizeUsd: d.sizeUsd,
    minLiqPct: d.minLiqPct,
    growLiqPct: d.growLiqPct,
    sliceUsd: Math.min(d.sliceUsd, d.sizeUsd),
    maxSlipBps: d.maxSlipBps,
    marginUsd: d.marginUsd,
    leverage: d.leverage,
    marginMode: 'cross',
    paper: d.paper,
    maxLossUsd: d.maxLossUsd,
    onStop: d.onStop,
    ...(d.takeProfitUsd !== null && d.takeProfitUsd > 0 ? { takeProfitUsd: d.takeProfitUsd } : {}),
    ...(d.runHours !== null && d.runHours > 0 ? { endAt: now + Math.round(d.runHours * 3_600_000) } : {}),
  };
  if (d.shape === 'spot') return { main: { ...common, side: 'sell', label: d.label.trim() || null }, partner: null };
  const partner = d.partner.trim().toLowerCase();
  const me = owner.toLowerCase();
  return {
    main: { ...common, side: d.side, role: 'main', pairId, partner, label: d.label.trim() || null },
    partner: { ...common, side: d.side === 'buy' ? 'sell' : 'buy', role: 'partner', pairId, partner: me, label: d.label.trim() ? `${d.label.trim()} (2nd leg)` : null },
  };
}

/** What is wrong with the draft (null: nothing). */
export function hedgeProblems(d: HedgeDraft, owner: string | null): Partial<Record<'partner' | 'size' | 'buffer' | 'loss', string>> {
  const e: Partial<Record<'partner' | 'size' | 'buffer' | 'loss', string>> = {};
  if (d.shape === 'pair') {
    if (!isAddress(d.partner)) e.partner = 'Paste the second wallet\'s address (0x…).';
    else if (owner && d.partner.trim().toLowerCase() === owner.toLowerCase()) e.partner = 'The second leg needs another wallet: one account cannot hold both sides of a market.';
  }
  if (!(d.sizeUsd >= 10)) e.size = 'At least $10 a leg.';
  if (!(d.growLiqPct > d.minLiqPct)) e.buffer = 'The grow-back buffer must be wider than the liquidation buffer.';
  if (!d.paper && (d.maxLossUsd === null || !(d.maxLossUsd > 0))) e.loss = 'A real bot needs a loss limit.';
  return e;
}

/** A market's maintenance rate (first tier): half the initial rate at its max leverage (docs.sodex.com, Margin Tiers). */
export const mmrOf = (maxLeverage: number): number => (maxLeverage > 0 ? 1 / maxLeverage / 2 : 0.025);

export interface HedgeNumbers {
  /** The most a leg may hold with its liquidation minLiq away, at the planned margin, USD. */
  maxLegUsd: number;
  /** What it will work towards: the target, or less where the margin does not allow it, USD per leg. */
  legUsd: number;
  /** Open interest it holds, both legs together (pair) or the short (spot). */
  oiUsd: number;
  /** How far each leg's liquidation is at that size (share of the price); spot: null (the coin is the margin). */
  liqDistance: number | null;
  /** The price move that shrinks both legs (minLiq reached on the losing side), share of the price. */
  trimMove: number | null;
  /** Initial margin locked per leg at the leverage set, USD. */
  initialUsd: number;
  /** Fees to open and close once: every leg takes (IOC) both ways, USD. */
  roundTripFeesUsd: number;
}

/**
 * The numbers shown before it starts, for one leg's account with `marginUsd` of equity (the losing leg decides):
 * a long and a short each sized by the liquidation buffer, the smaller of the two kept.
 */
export function hedgeNumbers(d: HedgeDraft, mark: number, maxLeverage: number, takerBps = 4, builderBps = 0.4): HedgeNumbers {
  const mmr = mmrOf(maxLeverage);
  const legs = d.shape === 'pair' ? 2 : 1;
  const fees = (usd: number) => usd * legs * 2 * ((takerBps + builderBps) / 10_000);
  const initial = (usd: number) => usd / Math.max(1, Math.min(d.leverage, maxLeverage));
  if (d.shape === 'spot') {
    // The coin is the margin: the short's liquidation is far away whatever the size; the size is the coin held.
    return { maxLegUsd: d.sizeUsd, legUsd: d.sizeUsd, oiUsd: d.sizeUsd, liqDistance: null, trimMove: null, initialUsd: initial(d.sizeUsd), roundTripFeesUsd: fees(d.sizeUsd) };
  }
  if (!(mark > 0)) return { maxLegUsd: 0, legUsd: 0, oiUsd: 0, liqDistance: null, trimMove: null, initialUsd: 0, roundTripFeesUsd: 0 };
  const capQty = Math.min(maxQtyAt(d.marginUsd, mark, mmr, d.growLiqPct / 100, 1), maxQtyAt(d.marginUsd, mark, mmr, d.growLiqPct / 100, -1));
  // Never more than the leverage set allows on the margin either.
  const levQty = (d.marginUsd * Math.min(d.leverage, maxLeverage)) / mark;
  const maxLegUsd = Math.min(capQty, levQty) * mark;
  const legUsd = Math.min(d.sizeUsd, maxLegUsd);
  const q = legUsd / mark;
  const dist = q > 0 ? (d.marginUsd / (q * mark) - mmr) / (1 + mmr) : null;
  // A move m against the short: its equity falls by q*m*P; the buffer is reached when its distance is minLiq.
  const trimMove = q > 0 ? Math.max(0, (d.marginUsd - (q * mark) * (mmr + (d.minLiqPct / 100) * (1 + mmr))) / (q * mark)) : null;
  return { maxLegUsd, legUsd, oiUsd: legUsd * 2, liqDistance: dist, trimMove, initialUsd: initial(legUsd), roundTripFeesUsd: fees(legUsd) };
}

/* --------------------------------------------------- a leg low on margin ----- */

/** One leg as the bot page reads it (copy-engine HedgeLegView). */
export interface LegRead { owner: string; equity: number | null; liqDistance: number | null }

export interface MarginWarning {
  /** The leg low on margin, and the one with margin to spare. */
  low: string;
  rich: string;
  /** About how much to move from `rich` to `low` to even them out, USD. */
  moveUsd: number;
  /** Its liquidation is inside the shrink buffer's 1.5x: it is shrinking both legs now, or about to. */
  urgent: boolean;
}

/**
 * A pair's leg low on margin (owner 2026-11-15: "add a warning if 1 leg is low on margin that the user should
 * transfer"). Every move makes one wallet richer and the other poorer, and SoDEX moves no margin between two wallets:
 * the poorer one keeps both legs small. Warned once its liquidation is closer than the grow-back buffer (it holds the
 * size back) and the other wallet has at least $1 more equity; the move evens the two out.
 */
export function marginWarning(legs: readonly LegRead[], minLiqPct: number, growLiqPct: number): MarginWarning | null {
  if (legs.length !== 2) return null;
  const [a, b] = legs as [LegRead, LegRead];
  if (a.equity === null || b.equity === null) return null;
  const [low, rich] = a.equity <= b.equity ? [a, b] : [b, a];
  const gap = rich.equity! - low.equity!;
  if (!(gap >= 1) || low.liqDistance === null || !(low.liqDistance < growLiqPct / 100)) return null;
  return { low: low.owner, rich: rich.owner, moveUsd: Math.floor(gap / 2), urgent: low.liqDistance < (minLiqPct / 100) * 1.5 };
}

/* --------------------------------------------------- the second wallet's invitation ----- */

/** A pair the main started in this browser, waiting for its second wallet to sign its leg. */
export interface PendingPair {
  pairId: string;
  main: string;
  partner: string;
  symbol: string;
  spec: Record<string, unknown>;
  at: number;
}

const KEY = 'vd.hedge.pending';
export const PENDING_EVENT = 'vd:hedge-pending';
/** An invitation older than this is dropped (the main's leg waits for it; a week is plenty to switch wallets). */
const PENDING_MS = 7 * 86_400_000;

export function pendingPairs(now = Date.now()): PendingPair[] {
  try {
    const xs = JSON.parse(localStorage.getItem(KEY) ?? '[]') as PendingPair[];
    return Array.isArray(xs) ? xs.filter((x) => x && typeof x.pairId === 'string' && now - x.at < PENDING_MS) : [];
  } catch {
    return [];
  }
}

export function savePending(p: PendingPair): void {
  try {
    localStorage.setItem(KEY, JSON.stringify([p, ...pendingPairs().filter((x) => x.pairId !== p.pairId)].slice(0, 20)));
  } catch {
    /* private mode: the invitation lives as long as the page */
  }
  window.dispatchEvent(new Event(PENDING_EVENT));
}

export function dropPending(pairId: string): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(pendingPairs().filter((x) => x.pairId !== pairId)));
  } catch {
    /* private mode */
  }
  window.dispatchEvent(new Event(PENDING_EVENT));
}

/** The invitations for `wallet` (it is their second wallet). */
export const pendingFor = (wallet: string | null, now = Date.now()): PendingPair[] => (wallet ? pendingPairs(now).filter((p) => p.partner === wallet.toLowerCase()) : []);
