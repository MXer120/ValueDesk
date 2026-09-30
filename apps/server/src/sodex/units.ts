/**
 * Decimal strings <-> integer base units, exactly (no float ever touches an
 * amount). Pure; sodex/chain.ts re-exports both, and the browser's deposit
 * options use them the same way.
 */
import { canonicalDecimal } from '../decimal.js';

/** "1.5" @ 6dp -> 1500000n. String-based, so no float ever touches an amount. */
export function toBaseUnits(amount: string, decimals: number): bigint {
  const c = canonicalDecimal(amount);
  if (c.startsWith('-')) throw new Error('amount must be positive');
  const [int = '0', frac = ''] = c.split('.');
  if (frac.length > decimals) {
    throw new Error(`${c} has more than ${decimals} decimal places for this asset`);
  }
  return BigInt(int + frac.padEnd(decimals, '0'));
}

/** 1500000n @ 6dp -> "1.5" */
export function fromBaseUnits(v: bigint, decimals: number): string {
  const neg = v < 0n;
  const s = (neg ? -v : v).toString().padStart(decimals + 1, '0');
  const out = decimals === 0 ? s : `${s.slice(0, -decimals)}.${s.slice(-decimals)}`;
  return canonicalDecimal((neg ? '-' : '') + out);
}
