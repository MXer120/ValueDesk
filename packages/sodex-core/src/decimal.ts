/**
 * Ported verbatim from Opentrade/server/src/decimal.ts (pure string/BigInt maths,
 * no floats on the signing path). Pinned against shopspring/decimal by the
 * `decimals` / `decimalsExtra` fixtures in test/vectors*.json.
 */
/**
 * Canonical decimal strings, byte-compatible with Go's shopspring/decimal `String()`.
 *
 * This module exists because of a subtle, high-consequence mismatch:
 *
 *   The SoDEX gateway verifies a signature by re-marshalling the request body with
 *   Go's `json.Marshal`. Decimal fields round-trip through `shopspring/decimal`,
 *   whose `String()` emits PLAIN decimal notation with trailing zeros stripped.
 *
 *   The documented JS advice — `parseFloat(x).toString()` — is WRONG for small
 *   numbers: `parseFloat("0.0000001").toString() === "1e-7"`. Go would produce
 *   "0.0000001". The two strings hash differently, so the signature is rejected
 *   with an opaque 401. Perps like SHIB-USD and DOGE-USD trade in exactly this
 *   range, so this is not a hypothetical.
 *
 * `canonicalDecimal` therefore works on the STRING, never on a float, and never
 * emits exponent notation.
 */

const DECIMAL_RE = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

export class DecimalError extends Error {}

/** Expand scientific notation into plain digits without going through a float. */
function expandExponent(digits: string, exponent: number): string {
  const neg = digits.startsWith('-');
  if (neg || digits.startsWith('+')) digits = digits.slice(1);

  let [intPart = '', fracPart = ''] = digits.split('.');
  if (exponent > 0) {
    if (fracPart.length <= exponent) {
      intPart += fracPart.padEnd(exponent, '0');
      fracPart = '';
    } else {
      intPart += fracPart.slice(0, exponent);
      fracPart = fracPart.slice(exponent);
    }
  } else if (exponent < 0) {
    const shift = -exponent;
    if (intPart.length <= shift) {
      fracPart = intPart.padStart(shift, '0') + fracPart;
      intPart = '';
    } else {
      fracPart = intPart.slice(intPart.length - shift) + fracPart;
      intPart = intPart.slice(0, intPart.length - shift);
    }
  }
  return (neg ? '-' : '') + (intPart || '0') + (fracPart ? '.' + fracPart : '');
}

/**
 * Normalise a numeric string to the exact form Go's decimal.String() would emit.
 * Strips trailing fractional zeros (SoDEX rejects "0.4060"; it wants "0.406"),
 * strips redundant leading zeros, and normalises "-0" to "0".
 */
export function canonicalDecimal(input: string | number): string {
  let s = typeof input === 'number' ? numberToPlainString(input) : String(input).trim();
  if (s === '') throw new DecimalError('empty decimal');
  if (!DECIMAL_RE.test(s)) throw new DecimalError(`not a decimal: ${JSON.stringify(s)}`);

  const expMatch = s.match(/[eE]([+-]?\d+)$/);
  if (expMatch) {
    s = expandExponent(s.slice(0, expMatch.index), Number.parseInt(expMatch[1]!, 10));
  }

  let neg = s.startsWith('-');
  if (neg || s.startsWith('+')) s = s.slice(1);

  let [intPart = '', fracPart = ''] = s.split('.');
  intPart = intPart.replace(/^0+(?=\d)/, '') || '0';
  fracPart = fracPart.replace(/0+$/, '');

  // Zero is always "0" — never "-0", never "0.000".
  if (intPart === '0' && fracPart === '') neg = false;

  return (neg ? '-' : '') + intPart + (fracPart ? '.' + fracPart : '');
}

/**
 * Float -> plain string, avoiding the exponent notation JS reaches for.
 *
 * Deliberately expands `String(n)` (JS's shortest round-trip form) rather than
 * using `toFixed`. `(1e-7).toFixed(27)` yields "0.000000099999999999999995475",
 * exposing the underlying binary float; `String(1e-7)` is "1e-7", which expands
 * cleanly to "0.0000001" - what Go's decimal would print.
 *
 * Prefer passing decimal STRINGS throughout; this exists only for convenience at
 * the edges, and cannot recover precision a float has already lost.
 */
export function numberToPlainString(n: number): string {
  if (!Number.isFinite(n)) throw new DecimalError(`not finite: ${n}`);
  const s = String(n);
  const m = s.match(/^([^eE]+)[eE]([+-]?\d+)$/);
  return m ? expandExponent(m[1]!, Number.parseInt(m[2]!, 10)) : s;
}

/** Compare two decimal strings numerically without float precision loss. */
export function decimalCompare(a: string, b: string): number {
  const [ca, cb] = [canonicalDecimal(a), canonicalDecimal(b)];
  const [na, nb] = [ca.startsWith('-'), cb.startsWith('-')];
  if (na !== nb) return na ? -1 : 1;
  const sign = na ? -1 : 1;
  const [ai = '0', af = ''] = (na ? ca.slice(1) : ca).split('.');
  const [bi = '0', bf = ''] = (nb ? cb.slice(1) : cb).split('.');
  if (ai.length !== bi.length) return ai.length > bi.length ? sign : -sign;
  if (ai !== bi) return ai > bi ? sign : -sign;
  const width = Math.max(af.length, bf.length);
  const [ap, bp] = [af.padEnd(width, '0'), bf.padEnd(width, '0')];
  if (ap === bp) return 0;
  return ap > bp ? sign : -sign;
}

export const isZero = (a: string): boolean => canonicalDecimal(a) === '0';

/**
 * Round a value to a symbol's tick/step grid, then canonicalise.
 * Uses integer math on scaled strings so no float ever touches the value.
 */
export function roundToStep(value: string, step: string, mode: 'floor' | 'nearest' = 'nearest'): string {
  const c = canonicalDecimal(step);
  if (c === '0') return canonicalDecimal(value);
  const scale = Math.max(fracDigits(value), fracDigits(c));
  const v = BigInt(scaleToInt(value, scale));
  const s = BigInt(scaleToInt(c, scale));
  let q = v / s;
  const r = v % s;
  if (mode === 'nearest' && r * 2n >= s) q += 1n;
  return unscaleFromInt(q * s, scale);
}

const fracDigits = (v: string): number => (canonicalDecimal(v).split('.')[1] ?? '').length;

function scaleToInt(v: string, scale: number): string {
  const c = canonicalDecimal(v);
  const neg = c.startsWith('-');
  const [i = '0', f = ''] = (neg ? c.slice(1) : c).split('.');
  return (neg ? '-' : '') + (i + f.padEnd(scale, '0') || '0');
}

function unscaleFromInt(n: bigint, scale: number): string {
  const neg = n < 0n;
  let s = (neg ? -n : n).toString().padStart(scale + 1, '0');
  const out = scale === 0 ? s : s.slice(0, s.length - scale) + '.' + s.slice(s.length - scale);
  return canonicalDecimal((neg ? '-' : '') + out);
}
