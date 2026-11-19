/**
 * The copy setup form: its stored shape, parsing into an engine config, the
 * fee figures it quotes, and the one-line worked example.
 *
 * Pure (no React, no fetch) so every number the form prints can be tested.
 * The form keeps the RAW strings the person typed and parses on use: a half
 * typed "0." must stay on screen as "0.", not be rewritten under the cursor.
 */
import { COPY_FEE_MAX, type CopySettings, type LeaderVenue } from '@copy-engine';
import { FEE_TIERS } from '../../fees';
import { DASH, fmtUsd } from '../../format';
import { formatNumber } from '../../intlCache';
import type { TraderProfile, Venue, VsPosition, Window } from '../../vsApi';
import type { CopyConfig, CopySizingMode } from './sim/types';
import { fmtFixed, localize } from '../../numStyle';

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
 * The copy fee on a copied order, in tenths of a basis point (the unit SoDEX
 * signs): the copy ladder's default, 25 = 2.5 bp = 0.025%, lower with 14-day
 * volume (packages/copy-engine/src/policy.ts COPY_FEE_LADDER). Charged on every
 * copied order - opens, adds, reductions and closes - so the backtest charges
 * it on every order too.
 */
export const COPY_BUILDER_TENTHS_BPS = COPY_FEE_MAX;

/** Venue minimum order value, USD (perps on both venues). */
export const MIN_ORDER_USD = 10;

/** 0.0004 -> "0.040%". Three places, because fee rates differ in the third. */
export const fmtRate = (rate: number): string => `${fmtFixed(rate * 100, 3)}%`;

/* "+12.34%" and "+$1,240": a leaf module (./fmtSigned), so the trader cards print them without this one. */
export { fmtSignedPct, fmtSignedUsd } from './fmtSigned';

/** A base-unit size at a precision that suits its magnitude: 2.5, 0.0213, 18,420. */
export function fmtSize(v: number): string {
  const a = Math.abs(v);
  if (!Number.isFinite(a)) return DASH;
  const dp = a >= 1000 ? 0 : a >= 1 ? 3 : a >= 0.01 ? 4 : 6;
  // Trimmed in en-US (where "." is the decimal mark), then put in the chosen format.
  const en = formatNumber(Number(a.toFixed(dp)), 'en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
  return localize(en.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, ''));
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
  /** 'copy' takes the trader's side; 'counter' the other side (counter-trading). */
  direction: 'copy' | 'counter';
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
  /**
   * Only the trader's positions opened after the start are copied; off, the ones they already
   * hold are joined at the start too. A new field (owner, 2026-11-03: off by default), so a
   * setup stored when "new only" was the default starts off as well.
   */
  onlyNew: boolean;
  /** A multiple of the sizing mode's size, before the caps: "1" mirrors the trader. */
  multiplier: string;
  /** Margin mode of copied positions. */
  marginMode: 'isolated' | 'cross';
  /** Ask before each copied order (the browser copier only). */
  confirmEach: boolean;
  /** Paper copy: runs live against the leader, sends nothing to SoDEX. */
  paper: boolean;
}

/**
 * Defaults, from research 03 section 11 where it gives one: equity-proportional
 * sizing at 1x, leverage capped at 5x; the trader's open positions are joined too
 * (owner, 2026-11-03: "only new" is a switch, off by default). Slippage is a cap; the
 * backtest charges all of it on every order, so a tight default keeps that
 * worst case from swamping the result.
 */
export const DEFAULT_SETUP: SetupState = {
  direction: 'copy',
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
  onlyNew: false,
  multiplier: '1',
  marginMode: 'isolated',
  confirmEach: false,
  paper: false,
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
  if (out.marginMode !== 'isolated' && out.marginMode !== 'cross') out.marginMode = DEFAULT_SETUP.marginMode;
  if (out.direction !== 'copy' && out.direction !== 'counter') out.direction = DEFAULT_SETUP.direction;
  out.confirmEach = out.confirmEach === true;
  out.paper = out.paper === true;
  out.onlyNew = out.onlyNew === true;
  if (typeof out.multiplier !== 'string') out.multiplier = DEFAULT_SETUP.multiplier;
  delete (out as Partial<{ copyExisting: unknown }>).copyExisting;
  return out;
}

/**
 * The form as the copy engine's rules for `leader`. The engine checks them
 * again (`checkSettings`): where it is stricter than the backtest (a whole
 * leverage, at least 1 bp of slippage, at least 10 USDC), the copy says so.
 */
export function toCopySettings(p: ParsedSetup, s: SetupState, leader: { venue: LeaderVenue; address: string }): CopySettings {
  const c = p.config;
  return {
    leader: { venue: leader.venue, address: leader.address.toLowerCase() },
    direction: s.direction,
    sizingMode: c.sizingMode,
    allocationUsd: c.allocationUsd,
    ratio: c.ratio,
    fixedNotionalUsd: p.fixedNotionalUsd,
    multiplier: c.multiplier ?? 1,
    maxLeverage: Math.max(1, Math.floor(c.maxLeverage)),
    maxPositionUsd: c.maxPositionUsd,
    stopLossPct: c.stopLossPct,
    takeProfitPct: c.takeProfitPct,
    drawdownStopPct: c.drawdownStopPct,
    assetAllow: c.assetAllow,
    assetDeny: c.assetDeny,
    copyExisting: c.copyExisting,
    slippageBps: Math.max(1, c.slippageBps),
    marginMode: s.marginMode,
    approval: s.confirmEach ? 'confirm' : 'auto',
    paper: s.paper,
  };
}

/** Copy rules the engine keeps as fractions, which the copy window takes in percent. */
/** Multiplier presets, and the engine's range (packages/copy-engine settings.ts LIMITS.multiplier). */
export const MULTIPLIER_PRESETS = [0.5, 1, 2, 3] as const;
export const MULTIPLIER_MIN = 0.1;
export const MULTIPLIER_MAX = 10;

const PCT_FIELDS = new Set(['ratio', 'stopLossPct', 'takeProfitPct', 'drawdownStopPct']);
const USD_FIELDS = new Set(['allocationUsd', 'fixedNotionalUsd', 'maxPositionUsd']);
const RANGE = /^(.+) must be between (-?\d+(?:\.\d+)?) and (-?\d+(?:\.\d+)?)\.$/;

/**
 * The engine's rule check (checkSettings) in the copy window's units. It states its
 * limits as fractions: a 0,5 % stop loss read "Stop loss must be between 0.01 and 1.",
 * under a field typed in percent. Now "between 1 % and 100 %"; dollar limits as
 * dollars, the slippage cap in bps, numbers in the app's format.
 */
export function copyErrorInWords(field: string, message: string): string {
  const m = RANGE.exec(message);
  if (!m) return message;
  const [, label, a, b] = m;
  const min = Number(a);
  const max = Number(b);
  const n = (v: number) => localize(formatNumber(v, 'en-US', { maximumFractionDigits: 4 }));
  if (PCT_FIELDS.has(field)) return `${label} must be between ${n(min * 100)} % and ${n(max * 100)} %.`;
  if (USD_FIELDS.has(field)) return `${label} must be between ${fmtUsd(min, 0)} and ${fmtUsd(max, 0)}.`;
  if (field === 'slippageBps') return `${label} must be between ${n(min)} and ${n(max)} bps.`;
  return `${label} must be between ${n(min)} and ${n(max)}.`;
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
  let multiplier = need('multiplier', s.multiplier, { min: 0, max: MULTIPLIER_MAX, label: 'Multiplier' });
  if (multiplier !== null && multiplier < MULTIPLIER_MIN) {
    errors.multiplier = `Multiplier must be at least ${localize(String(MULTIPLIER_MIN))}x.`;
    multiplier = null;
  }
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
      copyExisting: !s.onlyNew,
      multiplier: multiplier ?? 1,
      slippageBps: slip !== null && slip >= 0 && slip <= 500 ? slip : Number(DEFAULT_SETUP.slippageBps),
      direction: s.direction,
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
  const k = config.multiplier ?? 1;
  mine *= k;
  if (k !== 1) basis += `, ${localize(String(k))}x`;

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
  // A counter-trade takes the other side of the same position, at the same size.
  const yours = config.direction === 'counter' ? (pos.side === 'long' ? 'short' : 'long') : pos.side;
  return {
    text: `Leader ${pos.side} ${fmtSize(pos.size)} ${coin} (${fmtUsd(notional, 0)})${basis}. You: ${yours} ${fmtSize(size)} ${coin} (${fmtUsd(mine, 2)}).`,
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

/* ------------------------------------------------------ expected PnL ----- */

export interface PreviewSide {
  /** Fraction of the start equity. */
  roi: number;
  /** USD. */
  pnl: number;
  /** Positive fraction from the peak. */
  maxDrawdown: number;
}

/**
 * The copy dialog's expected-result figures, from the replay: yours, and the trader's
 * scaled to your allocation (the replay's leader curve starts at your equity), so the
 * two compare on one axis. Every number is the replay's; nothing is projected.
 */
export function previewFigures(r: {
  roi: number; pnl: number; maxDrawdown: number; startEquity: number;
  leaderRoi: number; leaderMaxDrawdown: number; leaderCurve: ReadonlyArray<{ accountValue: number | null }>;
}): { you: PreviewSide; them: PreviewSide } {
  const fin = (v: number) => (Number.isFinite(v) ? v : 0);
  const last = r.leaderCurve.length ? r.leaderCurve[r.leaderCurve.length - 1]!.accountValue : null;
  return {
    you: { roi: fin(r.roi), pnl: fin(r.pnl), maxDrawdown: Math.max(0, fin(r.maxDrawdown)) },
    them: {
      roi: fin(r.leaderRoi),
      pnl: last === null ? fin(r.leaderRoi * r.startEquity) : fin(last - r.startEquity),
      maxDrawdown: Math.max(0, fin(r.leaderMaxDrawdown)),
    },
  };
}
