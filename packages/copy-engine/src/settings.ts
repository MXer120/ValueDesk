/**
 * Copy rules: defaults, validation, and the canonical form that is signed.
 *
 * The same function validates the rules in the setup form, in the browser
 * copier and in every executor, so a rule one of them accepts is accepted by
 * all. `canonicalSettings` fixes key order and number formatting: the exact
 * JSON the follower's wallet signs is the JSON the executor stores.
 */
import type { CopyDirection, CopySettings, LeaderVenue, SizingMode } from './types.ts';

const ADDRESS = /^0x[0-9a-f]{40}$/;
const COIN = /^[A-Z0-9]{1,20}$/;

/** Research 03 section 11 defaults: proportional sizing, 5x cap, new positions only, isolated margin. */
export const DEFAULT_SETTINGS: Omit<CopySettings, 'leader'> = {
  direction: 'copy',
  sizingMode: 'proportional',
  allocationUsd: 1000,
  ratio: 0.1,
  fixedNotionalUsd: 100,
  multiplier: 1,
  maxLeverage: 5,
  maxPositionUsd: 2500,
  stopLossPct: 0.5,
  takeProfitPct: null,
  drawdownStopPct: 0.3,
  assetAllow: [],
  assetDeny: [],
  copyExisting: false,
  slippageBps: 50,
  marginMode: 'isolated',
  approval: 'auto',
  paper: false,
};

export const LIMITS = {
  allocationUsd: { min: 10, max: 10_000_000 },
  ratio: { min: 0.0001, max: 10 },
  fixedNotionalUsd: { min: 10, max: 1_000_000 },
  multiplier: { min: 0.1, max: 10 },
  maxLeverage: { min: 1, max: 50 },
  maxPositionUsd: { min: 10, max: 10_000_000 },
  stopLossPct: { min: 0.01, max: 1 },
  takeProfitPct: { min: 0.01, max: 100 },
  drawdownStopPct: { min: 0.01, max: 1 },
  slippageBps: { min: 1, max: 500 },
  coins: 100,
} as const;

export type SettingsField = keyof CopySettings | 'leader.address' | 'leader.venue';

export interface SettingsCheck {
  settings: CopySettings | null;
  errors: Partial<Record<SettingsField, string>>;
}

const VENUES: readonly LeaderVenue[] = ['sodex', 'hyperliquid'];
const MODES: readonly SizingMode[] = ['proportional', 'fixedRatio', 'fixedNotional'];
const DIRECTIONS: readonly CopyDirection[] = ['copy', 'counter'];

function numberIn(v: unknown, lim: { min: number; max: number }, label: string, errors: Record<string, string>, field: string): number {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    errors[field] = `${label} must be a number.`;
    return NaN;
  }
  if (n < lim.min || n > lim.max) errors[field] = `${label} must be between ${lim.min} and ${lim.max}.`;
  return n;
}

function optionalIn(v: unknown, lim: { min: number; max: number }, label: string, errors: Record<string, string>, field: string): number | null {
  if (v === null || v === undefined || v === '') return null;
  return numberIn(v, lim, label, errors, field);
}

function coins(v: unknown, label: string, errors: Record<string, string>, field: string): string[] {
  if (v === undefined || v === null) return [];
  const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[\s,;]+/) : null;
  if (!list) {
    errors[field] = `${label} must be a list of coins.`;
    return [];
  }
  const out = [...new Set(list.map((c) => String(c).trim().toUpperCase()).filter(Boolean))].sort();
  if (out.length > LIMITS.coins) errors[field] = `${label} can name at most ${LIMITS.coins} coins.`;
  const bad = out.find((c) => !COIN.test(c));
  if (bad) errors[field] = `${label}: "${bad}" is not a coin symbol.`;
  return out;
}

/** Validate anything that claims to be copy rules. Unknown fields are ignored; missing ones take the defaults. */
export function checkSettings(input: unknown): SettingsCheck {
  const errors: Record<string, string> = {};
  const s = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const leaderIn = (s.leader && typeof s.leader === 'object' ? s.leader : {}) as Record<string, unknown>;
  const address = typeof leaderIn.address === 'string' ? leaderIn.address.trim().toLowerCase() : '';
  if (!ADDRESS.test(address)) errors['leader.address'] = 'The trader to copy must be a 0x address.';
  const venue = leaderIn.venue as LeaderVenue;
  if (!VENUES.includes(venue)) errors['leader.venue'] = 'The trader must be on SoDEX or Hyperliquid.';

  const pick = <K extends keyof typeof DEFAULT_SETTINGS>(k: K): unknown => (k in s ? s[k] : DEFAULT_SETTINGS[k]);
  // Absent (rules from before counter-trading existed) or null is a plain copy.
  const direction = ((s.direction ?? null) === null ? DEFAULT_SETTINGS.direction : s.direction) as CopyDirection;
  if (!DIRECTIONS.includes(direction)) errors.direction = 'Choose copy or counter-trade.';
  const sizingMode = pick('sizingMode') as SizingMode;
  if (!MODES.includes(sizingMode)) errors.sizingMode = 'Choose proportional, fixed ratio or fixed amount.';

  const allocationUsd = numberIn(pick('allocationUsd'), LIMITS.allocationUsd, 'Allocation', errors, 'allocationUsd');
  const ratio = numberIn(pick('ratio'), LIMITS.ratio, 'Ratio', errors, 'ratio');
  const fixedNotionalUsd = numberIn(pick('fixedNotionalUsd'), LIMITS.fixedNotionalUsd, 'Amount per trade', errors, 'fixedNotionalUsd');
  // Absent (rules from before the multiplier existed) or null is 1x.
  const multiplier = numberIn((s.multiplier ?? null) === null ? DEFAULT_SETTINGS.multiplier : s.multiplier, LIMITS.multiplier, 'Multiplier', errors, 'multiplier');
  const maxLeverage = numberIn(pick('maxLeverage'), LIMITS.maxLeverage, 'Max leverage', errors, 'maxLeverage');
  const maxPositionUsd = numberIn(pick('maxPositionUsd'), LIMITS.maxPositionUsd, 'Max position', errors, 'maxPositionUsd');
  const stopLossPct = optionalIn(pick('stopLossPct'), LIMITS.stopLossPct, 'Stop loss', errors, 'stopLossPct');
  const takeProfitPct = optionalIn(pick('takeProfitPct'), LIMITS.takeProfitPct, 'Take profit', errors, 'takeProfitPct');
  const drawdownStopPct = optionalIn(pick('drawdownStopPct'), LIMITS.drawdownStopPct, 'Drawdown stop', errors, 'drawdownStopPct');
  const slippageBps = numberIn(pick('slippageBps'), LIMITS.slippageBps, 'Slippage cap', errors, 'slippageBps');
  const assetAllow = coins(pick('assetAllow'), 'Coins to copy', errors, 'assetAllow');
  const assetDeny = coins(pick('assetDeny'), 'Coins never to copy', errors, 'assetDeny');
  const both = assetAllow.filter((c) => assetDeny.includes(c));
  if (both.length) errors.assetDeny = `${both.join(', ')} is on both lists.`;
  const marginMode = pick('marginMode');
  if (marginMode !== 'isolated' && marginMode !== 'cross') errors.marginMode = 'Margin must be isolated or cross.';
  const approval = pick('approval');
  if (approval !== 'auto' && approval !== 'confirm') errors.approval = 'Approval must be automatic or ask each time.';
  const copyExisting = pick('copyExisting');
  if (typeof copyExisting !== 'boolean') errors.copyExisting = 'Copy existing positions must be yes or no.';
  const paper = pick('paper');
  if (typeof paper !== 'boolean') errors.paper = 'Paper copy must be yes or no.';

  if (Object.keys(errors).length) return { settings: null, errors };
  return {
    settings: {
      leader: { venue, address },
      direction,
      sizingMode,
      allocationUsd,
      ratio,
      fixedNotionalUsd,
      multiplier,
      maxLeverage: Math.floor(maxLeverage),
      maxPositionUsd,
      stopLossPct,
      takeProfitPct,
      drawdownStopPct,
      assetAllow,
      assetDeny,
      copyExisting: copyExisting as boolean,
      slippageBps,
      marginMode: marginMode as 'isolated' | 'cross',
      approval: approval as 'auto' | 'confirm',
      paper: paper as boolean,
    },
    errors: {},
  };
}

/** The rules or a thrown error naming every problem. */
export function parseSettings(input: unknown): CopySettings {
  const r = checkSettings(input);
  if (!r.settings) {
    const msg = Object.entries(r.errors).map(([k, v]) => `${k}: ${v}`).join(' ');
    throw new SettingsError(msg || 'Invalid copy settings.', r.errors);
  }
  return r.settings;
}

export class SettingsError extends Error {
  override name = 'SettingsError';
  constructor(message: string, readonly fields: Partial<Record<SettingsField, string>>) {
    super(message);
  }
}

/**
 * Numbers as the shortest exact JSON form; key order fixed. `direction` is
 * written only for a counter-trade and `multiplier` only when it is not 1 (both
 * at the end): the canonical form of every copy rule set signed before either
 * existed stays byte for byte the same.
 */
const KEYS: ReadonlyArray<keyof CopySettings> = [
  'leader',
  'sizingMode',
  'allocationUsd',
  'ratio',
  'fixedNotionalUsd',
  'maxLeverage',
  'maxPositionUsd',
  'stopLossPct',
  'takeProfitPct',
  'drawdownStopPct',
  'assetAllow',
  'assetDeny',
  'copyExisting',
  'slippageBps',
  'marginMode',
  'approval',
  'paper',
];

/** The canonical object (fixed key order) that is signed and stored. */
export function canonicalSettings(s: CopySettings): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of KEYS) {
    if (k === 'leader') out.leader = { venue: s.leader.venue, address: s.leader.address.toLowerCase() };
    else if (k === 'assetAllow' || k === 'assetDeny') out[k] = [...s[k]].map((c) => c.toUpperCase()).sort();
    else out[k] = s[k];
  }
  if (s.direction === 'counter') out.direction = 'counter';
  if ((s.multiplier ?? 1) !== 1) out.multiplier = s.multiplier;
  return out;
}

/** A short human summary: "Proportional, $1,000, max 5x, SL 50%, DD 30%". */
export function describeSettings(s: CopySettings): string {
  const usd = (n: number) => `$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  const pct = (f: number) => `${Math.round(f * 1000) / 10}%`;
  const sizing =
    s.sizingMode === 'proportional' ? `Proportional on ${usd(s.allocationUsd)}` : s.sizingMode === 'fixedRatio' ? `${pct(s.ratio)} of the leader's size` : `${usd(s.fixedNotionalUsd)} per trade`;
  const parts = [s.direction === 'counter' ? `Counter-trade: ${sizing.charAt(0).toLowerCase()}${sizing.slice(1)}` : sizing];
  if ((s.multiplier ?? 1) !== 1) parts.push(`${s.multiplier}x the trader's size`);
  parts.push(`max ${s.maxLeverage}x`, `max ${usd(s.maxPositionUsd)} per position`);
  if (s.stopLossPct !== null) parts.push(`stop loss ${pct(s.stopLossPct)}`);
  if (s.takeProfitPct !== null) parts.push(`take profit ${pct(s.takeProfitPct)}`);
  if (s.drawdownStopPct !== null) parts.push(`drawdown stop ${pct(s.drawdownStopPct)}`);
  if (s.paper) parts.push('paper');
  return parts.join(', ');
}
