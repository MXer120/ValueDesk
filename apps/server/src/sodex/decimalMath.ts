/**
 * Exact decimal arithmetic the symbol rules and the history totals share,
 * pure (sodex/symbols.ts re-exports it; the browser's all-time stats use it).
 */
import { canonicalDecimal } from '../decimal.js';

/**
 * Exact decimal multiply via BigInt - no float rounding.
 * Sign is stripped before the digit shuffling and reapplied at the end, since
 * zero-padding a "-15" string would otherwise produce garbage like "0-15".
 */
export function mulDecimal(a: string, b: string): string {
  const [ca, cb] = [canonicalDecimal(a), canonicalDecimal(b)];
  const negative = ca.startsWith('-') !== cb.startsWith('-');
  const strip = (s: string) => (s.startsWith('-') ? s.slice(1) : s);
  const scale = (s: string) => (s.split('.')[1] ?? '').length;
  const digits = (s: string) => BigInt(strip(s).replace('.', ''));

  const total = scale(ca) + scale(cb);
  const raw = (digits(ca) * digits(cb)).toString();
  const sign = negative ? '-' : '';
  if (total === 0) return canonicalDecimal(sign + raw);
  const padded = raw.padStart(total + 1, '0');
  return canonicalDecimal(sign + padded.slice(0, -total) + '.' + padded.slice(-total));
}
