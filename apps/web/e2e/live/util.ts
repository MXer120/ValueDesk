/**
 * Small helpers for the live E2E runner.
 *
 * AMOUNTS ARE DECIMAL STRINGS. Everything that is signed, sent or compared as
 * money goes through the fixed-point bigint helpers below (36 fractional
 * digits, more than any SoDEX coin has) - never through a float. Floats appear
 * only in USD ESTIMATES and display text, where a cent of rounding is harmless.
 */
import { canonicalDecimal } from '@sodex-core';

const SCALE = 36;
const ONE = 10n ** BigInt(SCALE);

/** A decimal string as a fixed-point bigint (36 fractional digits). Throws on anything that is not a plain decimal. */
export function fx(v: string): bigint {
  const c = canonicalDecimal(v);
  const neg = c.startsWith('-');
  const [i = '0', f = ''] = (neg ? c.slice(1) : c).split('.');
  if (f.length > SCALE) throw new RangeError(`too many decimal places: ${v}`);
  const n = BigInt(i + f.padEnd(SCALE, '0'));
  return neg ? -n : n;
}

/** A fixed-point bigint back to a canonical decimal string (no trailing zeros, no exponent). */
export function unfx(n: bigint): string {
  const neg = n < 0n;
  const x = neg ? -n : n;
  const whole = x / ONE;
  const frac = (x % ONE).toString().padStart(SCALE, '0').replace(/0+$/, '');
  return `${neg && (whole > 0n || frac) ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

export const dAdd = (a: string, b: string): string => unfx(fx(a) + fx(b));
export const dSub = (a: string, b: string): string => unfx(fx(a) - fx(b));
/** a x b, cut toward zero at 36 digits. */
export const dMul = (a: string, b: string): string => unfx((fx(a) * fx(b)) / ONE);
export function dDiv(a: string, b: string, mode: 'floor' | 'ceil' = 'floor'): string {
  const d = fx(b);
  if (d === 0n) throw new RangeError('division by zero');
  const n = fx(a) * ONE;
  let q = n / d;
  if (mode === 'ceil' && n % d !== 0n && n > 0n === d > 0n) q += 1n;
  return unfx(q);
}
export const dCmp = (a: string, b: string): number => {
  const x = fx(a);
  const y = fx(b);
  return x < y ? -1 : x > y ? 1 : 0;
};
export const dMax = (a: string, b: string): string => (dCmp(a, b) >= 0 ? a : b);
export const dMin = (a: string, b: string): string => (dCmp(a, b) <= 0 ? a : b);
export const dIsZero = (a: string): boolean => fx(a) === 0n;

/** Snap `v` onto a step grid: DOWN (floor) or UP (ceil). A step of 0 means "no grid". */
export function toStep(v: string, step: string, mode: 'floor' | 'ceil'): string {
  const s = fx(step);
  if (s <= 0n) return canonicalDecimal(v);
  const x = fx(v);
  let q = x / s;
  if (mode === 'ceil' && x % s !== 0n && x > 0n) q += 1n;
  return unfx(q * s);
}

/** A percentage as an exact decimal string (at most 6 decimals), 0 <= pct < 100. */
function pctDec(pct: number): string {
  if (!Number.isFinite(pct) || pct < 0 || pct >= 100) throw new RangeError(`percentage out of range: ${pct}`);
  return canonicalDecimal(pct.toFixed(6));
}
/** v x (100 - pct) / 100, exact. */
export const lessPct = (v: string, pct: number): string => dDiv(dMul(v, dSub('100', pctDec(pct))), '100');
/** v x (100 + pct) / 100, exact. */
export const morePct = (v: string, pct: number): string => dDiv(dMul(v, dAdd('100', pctDec(pct))), '100');

/** A non-negative plain decimal STRING (what the config and SoDEX use for amounts). */
export const isDecimal = (v: unknown): v is string => typeof v === 'string' && /^\d+(\.\d+)?$/.test(v.trim());

/** Number(v) for ESTIMATES AND DISPLAY ONLY - never for anything that is signed or sent. */
export const approx = (v: string | number | null | undefined): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

// --- display ---------------------------------------------------------------------------------

export const usd = (n: number | null | undefined): string =>
  n === null || n === undefined || !Number.isFinite(n) ? '$?' : `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(2)}`;

/** A decimal string cut (never rounded up) to at most `dp` decimals, for display. */
export function cut(v: string, dp = 8): string {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(String(v).trim());
  if (!m) return String(v);
  const f = (m[3] ?? '').slice(0, dp).replace(/0+$/, '');
  return `${m[1]}${m[2]}${f ? `.${f}` : ''}`;
}

export const shortAddr = (a: string): string => (a.length > 14 ? `${a.slice(0, 8)}...${a.slice(-6)}` : a);

export function dur(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  return `${m}m${String(Math.floor(s % 60)).padStart(2, '0')}s`;
}

export const hhmmss = (t = Date.now()): string => new Date(t).toISOString().slice(11, 19);

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// --- polling -----------------------------------------------------------------------------------

export type PollResult<T> = { ok: true; value: T; ms: number } | { ok: false; last: T | undefined; ms: number; lastError: string | null };

/**
 * Poll `probe` until `done(value)`, or until `timeoutMs` has passed. A probe
 * that THROWS is a failed read, not a failed step: it is remembered and polling
 * goes on. `progress` is called at most every `progressEveryMs` with the last
 * value, so a long wait (a cross-chain deposit) shows that it is alive.
 */
export async function pollUntil<T>(o: {
  timeoutMs: number;
  intervalMs?: number;
  probe: () => Promise<T>;
  done: (v: T) => boolean;
  progress?: (last: T | undefined, elapsedMs: number) => void;
  progressEveryMs?: number;
}): Promise<PollResult<T>> {
  const t0 = Date.now();
  const every = o.progressEveryMs ?? 30_000;
  let lastProgress = t0;
  let last: T | undefined;
  let lastError: string | null = null;
  for (let attempt = 0; ; attempt++) {
    try {
      last = await o.probe();
      lastError = null;
      if (o.done(last)) return { ok: true, value: last, ms: Date.now() - t0 };
    } catch (e) {
      lastError = errText(e);
    }
    const elapsed = Date.now() - t0;
    if (elapsed >= o.timeoutMs) return { ok: false, last, ms: elapsed, lastError };
    if (o.progress && Date.now() - lastProgress >= every) {
      lastProgress = Date.now();
      o.progress(last, elapsed);
    }
    // Quick at first (most credits land in seconds), then no faster than every few seconds.
    const base = o.intervalMs ?? 4000;
    const wait = attempt < 3 ? Math.min(base, 1500 + attempt * 1000) : base;
    await sleep(Math.min(wait, Math.max(250, o.timeoutMs - elapsed)));
  }
}

/** An error's message, whatever was thrown. */
export function errText(e: unknown): string {
  if (e instanceof Error) {
    const hint = (e as { hint?: unknown }).hint;
    return `${e.name && e.name !== 'Error' ? `${e.name}: ` : ''}${e.message}${typeof hint === 'string' && hint ? ` (${hint})` : ''}`;
  }
  return String(e);
}
