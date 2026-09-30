/**
 * The copy setup form: its stored shape, parsing into an engine config, the
 * fee figures it quotes, and the one-line worked example.
 *
 * Pure (no React, no fetch) so every number the form prints can be tested.
 * The form keeps the RAW strings the person typed and parses on use: a half
 * typed "0." must stay on screen as "0.", not be rewritten under the cursor.
 */
import { FEE_TIERS } from '../../fees';
import { DASH, MINUS, fmt, fmtUsd } from '../../format';
import type { TraderProfile, Venue, VsPosition, Window } from '../../vsApi';
import type { CopyConfig, CopySizingMode } from './sim/types';

/* --------------------------------------------------------------- fees ----- */

/**
 * Base-tier taker fees, perps. SoDEX comes from the published ladder the fee
 * tier panel already renders (fees.ts); Hyperliquid's is its documented tier 0
 * (research 06, 1.3). Copied orders are IOC, so they are taker orders.
 */
export const TAKER_RATE: Record<Venue, number> = {
  sodex: FEE_TIERS[0]?.perpsTaker ?? 0.0004,
  hyperliquid: 0.00045,
  // Not copy venues yet; kept so a Venue always has a rate.
  tradexyz: 0.00045,
  lighter: 0,
  arcus: 0.0004,
};

/**
 * PLANNED builder fee, in tenths of a basis point (the unit both venues sign):
 * 50 = 5 bp = 0.05%, charged on copied orders that open or add, closes free.
 * Not charged by anything today - there is no copy executor. Research 06 is the
 * source: 5 bp is the going rate for copy trading, and the approval a follower
 * would sign is capped at the same 0.05% rather than the venue maximum.
 */
export const PLANNED_BUILDER_TENTHS_BPS = 50;

/** Venue minimum order value, USD (perps on both venues). */
export const MIN_ORDER_USD = 10;

/** 0.0004 -> "0.040%". Three places, because fee rates differ in the third. */
export const fmtRate = (rate: number): string => `${(rate * 100).toFixed(3)}%`;

/** Fraction -> signed percent with a true minus sign: 0.1234 -> "+12.34%". */
export function fmtSignedPct(frac: number | null | undefined, dp = 2): string {
  if (frac === null || frac === undefined || !Number.isFinite(frac)) return DASH;
  const v = frac * 100;
  const body = Math.abs(v).toFixed(dp);
  if (Number(body) === 0) return `${(0).toFixed(dp)}%`;
  return `${v > 0 ? '+' : MINUS}${body}%`;
}

/** USD with an explicit + on gains; fmtUsd already signs losses with a minus sign. */
export function fmtSignedUsd(v: number | null | undefined, dp = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return DASH;
  return `${v > 0 ? '+' : ''}${fmtUsd(v, dp)}`;
}

/** A base-unit size at a precision that suits its magnitude: 2.5, 0.0213, 18,420. */
export function fmtSize(v: number): string {
  const a = Math.abs(v);
  if (!Number.isFinite(a)) return DASH;
  const dp = a >= 1000 ? 0 : a >= 1 ? 3 : a >= 0.01 ? 4 : 6;
  return fmt(Number(a.toFixed(dp)), dp).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

/* ----------------------------------------------------------- windows ----- */

export const BACKTEST_WINDOWS: ReadonlyArray<{ v: Window; label: string }> = [
  { v: '1d', label: '24H' },
  { v: '7d', label: '7D' },
  { v: '30d', label: '30D' },
  { v: 'all', label: 'All' },
];

export const WINDOW_LABEL: Record<Window, string> = { '1d': '24H', '7d': '7D', '30d': '30D', all: 'All time' };

const WINDOW_MS: Record<Window, number | null> = { '1d': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000, all: null };

/** Start of a window counted back from `now`, or null for all of history. */
export function windowStart(w: Window, now: number): number | null {
  const ms = WINDOW_MS[w];
  return ms === null ? null : now - ms;
}

/* ------------------------------------------------------------- setup ----- */

/** What the form stores. Strings are what the person typed; see the header. */
export interface SetupState {
  allocation: string;
  mode: CopySizingMode;
  /** Fixed ratio, as a percent of the leader's size ("10" = 10%). */
  ratioPct: string;
  /** Fixed notional, USD per copied open. */
  notional: string;
  maxLeverage: string;
  maxPosition: string;
  /** Percent of the copied position's margin; '' = off. */
  stopLoss: string;
  takeProfit: string;
  /** Percent from the copy's equity peak; '' = off. */
  drawdown: string;
  slippageBps: string;
  allow: string;
  deny: string;
  copyExisting: boolean;
}

/**
 * Defaults, from research 03 section 11 where it gives one: equity-proportional
 * sizing, leverage capped at 5x, new positions only. Slippage is a cap; the
 * backtest charges all of it on every order, so a tight default keeps that
 * worst case from swamping the result.
 */
export const DEFAULT_SETUP: SetupState = {
  allocation: '1000',
  mode: 'proportional',
  ratioPct: '10',
  notional: '100',
  maxLeverage: '5',
  maxPosition: '2500',
  stopLoss: '50',
  takeProfit: '',
  drawdown: '30',
  slippageBps: '10',
  allow: '',
  deny: '',
  copyExisting: false,
};

export const SIZING_MODES: ReadonlyArray<{ v: CopySizingMode; label: string; hint: string }> = [
  { v: 'proportional', label: 'Proportional', hint: 'Mirror the leader as a share of equity: your allocation over theirs.' },
  { v: 'fixedRatio', label: 'Fixed ratio', hint: "A fixed percent of the leader's size, whatever their equity." },
  { v: 'fixedNotional', label: 'Fixed notional', hint: 'The same dollar amount on every copied open; scale-outs follow the leader.' },
];

/** Stored state from an older build can miss fields; fill them from the defaults. */
export function normaliseSetup(s: Partial<SetupState> | null | undefined): SetupState {
  const out = { ...DEFAULT_SETUP, ...(s ?? {}) };
  if (!SIZING_MODES.some((m) => m.v === out.mode)) out.mode = DEFAULT_SETUP.mode;
  return out;
}

const num = (s: string): number | null => {
  const t = s.replace(/[,\s$%]/g, '');
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

/** "btc, Eth ;SOL" -> ['BTC', 'ETH', 'SOL'] */
export const parseCoins = (s: string): string[] =>
  [...new Set(s.split(/[\s,;]+/).map((c) => c.trim().toUpperCase()).filter(Boolean))];

export type SetupField = keyof SetupState;

export interface ParsedSetup {
  config: CopyConfig;
  /** USD per copied open in fixed-notional mode (an engine option, not config). */
  fixedNotionalUsd: number;
  /** Field -> what is wrong with it. Empty when the setup can run. */
  errors: Partial<Record<SetupField, string>>;
}

/** Parse the form. Bad fields are reported and replaced by their defaults in `config`. */
export function parseSetup(s: SetupState): ParsedSetup {
  const errors: Partial<Record<SetupField, string>> = {};
  const need = (field: SetupField, v: string, o: { min?: number; max?: number; optional?: boolean; label: string }): number | null => {
    const n = num(v);
    if (n === null) {
      if (!o.optional) errors[field] = `${o.label} is required.`;
      return null;
    }
    if (o.min !== undefined && !(n > o.min)) errors[field] = `${o.label} must be above ${o.min}.`;
    else if (o.max !== undefined && n > o.max) errors[field] = `${o.label} can be at most ${o.max}.`;
    return errors[field] ? null : n;
  };

  const allocation = need('allocation', s.allocation, { min: 0, label: 'Allocation' });
  const ratioPct = s.mode === 'fixedRatio' ? need('ratioPct', s.ratioPct, { min: 0, max: 1000, label: 'Ratio' }) : num(s.ratioPct);
  const notional = s.mode === 'fixedNotional' ? need('notional', s.notional, { min: 0, label: 'Amount per trade' }) : num(s.notional);
  const maxLeverage = need('maxLeverage', s.maxLeverage, { min: 0, max: 50, label: 'Max leverage' });
  const maxPosition = need('maxPosition', s.maxPosition, { min: 0, label: 'Max position' });
  const stopLoss = need('stopLoss', s.stopLoss, { min: 0, max: 100, optional: true, label: 'Stop loss' });
  const takeProfit = need('takeProfit', s.takeProfit, { min: 0, max: 10_000, optional: true, label: 'Take profit' });
  const drawdown = need('drawdown', s.drawdown, { min: 0, max: 100, optional: true, label: 'Drawdown stop' });
  const slip = num(s.slippageBps);
  if (slip === null || slip < 0 || slip > 500) errors.slippageBps = 'Slippage cap must be 0 to 500 bps.';

  const allow = parseCoins(s.allow);
  const deny = parseCoins(s.deny);
  const both = allow.filter((c) => deny.includes(c));
  if (both.length) errors.deny = `${both.join(', ')} is on both lists.`;

  const alloc = allocation ?? Number(DEFAULT_SETUP.allocation);
  const maxPos = maxPosition ?? Number(DEFAULT_SETUP.maxPosition);
  return {
    config: {
      sizingMode: s.mode,
      allocationUsd: alloc,
      ratio: (ratioPct ?? Number(DEFAULT_SETUP.ratioPct)) / 100,
      maxLeverage: maxLeverage ?? Number(DEFAULT_SETUP.maxLeverage),
      maxPositionUsd: maxPos,
      stopLossPct: stopLoss === null ? null : stopLoss / 100,
      takeProfitPct: takeProfit === null ? null : takeProfit / 100,
      drawdownStopPct: drawdown === null ? null : drawdown / 100,
      assetAllow: allow,
      assetDeny: deny,
      copyExisting: s.copyExisting,
      slippageBps: slip !== null && slip >= 0 && slip <= 500 ? slip : Number(DEFAULT_SETUP.slippageBps),
    },
    fixedNotionalUsd: notional ?? Number(DEFAULT_SETUP.notional),
    errors,
  };
}

/* --------------------------------------------------- worked example ----- */

/** The leader's largest open position by notional, or null when flat. */
export function largestPosition(positions: readonly VsPosition[] | null | undefined): VsPosition | null {
  let best: VsPosition | null = null;
  for (const p of positions ?? []) {
    if (!(Math.abs(p.notional) > 0) || !(Math.abs(p.size) > 0)) continue;
    if (!best || Math.abs(p.notional) > Math.abs(best.notional)) best = p;
  }
  return best;
}

export interface WorkedExample {
  /** One line, e.g. "Leader long 2.5 BTC ($150,210) on $1.20M. You: long 0.0021 BTC ($125.18)." */
  text: string;
  /** Why the copy would be smaller than the mode alone says, or skipped. */
  caveat: string | null;
}

/**
 * The sizing mode applied to the leader's real largest position, with the
 * setup's caps, in one sentence. Opening that position fresh, i.e. what the
 * copy would do if the leader opened it now.
 */
export function workedExample(
  parsed: ParsedSetup,
  profile: Pick<TraderProfile, 'positions' | 'summary'> | null,
  coinLabel: (symbol: string) => string,
): WorkedExample | null {
  if (!profile) return null;
  const pos = largestPosition(profile.positions);
  if (!pos) return null;
  const { config } = parsed;
  const coin = coinLabel(pos.symbol);
  const notional = Math.abs(pos.notional);
  const px = notional / Math.abs(pos.size);
  const equity = profile.summary.accountValue;

  let mine: number | null;
  let basis: string;
  if (config.sizingMode === 'proportional') {
    if (equity === null || !(equity > 0)) {
      return {
        text: `Leader ${pos.side} ${fmtSize(pos.size)} ${coin} (${fmtUsd(notional, 0)}).`,
        caveat: 'Proportional sizing needs the leader\'s account value, which this venue did not report.',
      };
    }
    mine = (notional * config.allocationUsd) / equity;
    basis = ` on ${fmtUsd(equity, 0)} equity`;
  } else if (config.sizingMode === 'fixedRatio') {
    mine = notional * config.ratio;
    basis = '';
  } else {
    mine = parsed.fixedNotionalUsd;
    basis = '';
  }

  let caveat: string | null = null;
  const capLev = config.maxLeverage * config.allocationUsd;
  if (mine > config.maxPositionUsd || mine > capLev) {
    const cap = Math.min(config.maxPositionUsd, capLev);
    caveat = `Capped at ${fmtUsd(cap, 0)} by your ${config.maxPositionUsd <= capLev ? 'max position' : 'max leverage'}.`;
    mine = cap;
  }
  if (mine < MIN_ORDER_USD) {
    caveat = `Below the ${fmtUsd(MIN_ORDER_USD, 0)} minimum order, so it would not be copied.`;
  }
  const size = mine / px;
  return {
    text: `Leader ${pos.side} ${fmtSize(pos.size)} ${coin} (${fmtUsd(notional, 0)})${basis}. You: ${pos.side} ${fmtSize(size)} ${coin} (${fmtUsd(mine, 2)}).`,
    caveat,
  };
}

/* ------------------------------------------------------------- URL ----- */

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
export const isAddress = (s: string | null | undefined): s is string => !!s && ADDRESS_RE.test(s.trim());

/** `?address=&venue=` from a query string. The venue defaults to the one given. */
export function readTarget(search: string, fallback: Venue): { address: string | null; venue: Venue } {
  const q = new URLSearchParams(search);
  const a = q.get('address');
  const v = q.get('venue');
  return {
    address: isAddress(a) ? a.trim().toLowerCase() : null,
    venue: v === 'sodex' || v === 'hyperliquid' ? v : fallback,
  };
}
