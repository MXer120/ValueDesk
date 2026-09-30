/**
 * Symbol resolution and pre-signing order validation - the PURE half of
 * Opentrade/server/src/sodex/symbols.ts. The fetching/caching half stays with
 * the app's data layer; this module takes the symbol list as an argument.
 *
 * Order placement needs a numeric `symbolID`, but humans and URLs use names
 * ("BTC-USD", "vBTC_vUSDC"). Symbol rules (tick size, step size, min notional)
 * are also needed to validate an order BEFORE spending a signature on it - a
 * client-side rejection is instant, a server-side one costs a round trip and a
 * consumed nonce.
 */
import { canonicalDecimal, decimalCompare, roundToStep } from './decimal.ts';
import { OrderType } from './actions.ts';

/**
 * The trading rules `normaliseOrder` reads. Every rule is optional: a rule the
 * gateway omitted means "unbounded", not "throw from canonicalDecimal". The
 * REST `SpotSymbol` / `PerpsSymbol` types (types/rest.ts) satisfy this shape,
 * and so does the web app's looser `SodexSymbol`.
 */
export interface SymbolRules {
  id?: number;
  name?: string;
  displayName?: string;
  tickSize?: string;
  minPrice?: string;
  maxPrice?: string;
  stepSize?: string;
  minQuantity?: string;
  maxQuantity?: string;
  marketMinQuantity?: string;
  marketMaxQuantity?: string;
  minNotional?: string;
  maxNotional?: string;
}

export class OrderValidationError extends Error {
  override name = 'OrderValidationError';
}

/** An unknown market is a bad request, not a server fault. */
export class SymbolNotFoundError extends Error {
  override name = 'SymbolNotFoundError';
  readonly statusCode = 404;
}

/** Resolve by internal name, display name, or numeric id - case-insensitively. */
export function resolveSymbol<S extends { id: number; name: string; displayName: string }>(
  list: readonly S[],
  ref: string | number,
): S {
  if (typeof ref === 'number' || /^\d+$/.test(String(ref))) {
    const id = Number(ref);
    const hit = list.find((s) => s.id === id);
    if (hit) return hit;
    throw new SymbolNotFoundError(`unknown symbolID ${id}`);
  }
  const want = String(ref).toUpperCase();
  const hit = list.find(
    (s) => s.name.toUpperCase() === want || s.displayName.toUpperCase() === want,
  );
  if (hit) return hit;
  throw new SymbolNotFoundError(`unknown symbol ${ref}`);
}

/**
 * Validate and normalise price/quantity against a symbol's trading rules.
 *
 * Runs before signing, so a bad order costs nothing. Returns canonical decimal
 * strings snapped to the tick/step grid - which also guarantees no trailing
 * zeros, the single most common cause of a rejected payload.
 */
export function normaliseOrder(
  sym: SymbolRules,
  input: { price?: string; quantity?: string; funds?: string; type: number },
): { price?: string; quantity?: string; funds?: string } {
  const out: { price?: string; quantity?: string; funds?: string } = {};
  const isMarket = input.type === OrderType.MARKET;
  const label = sym.displayName ?? sym.name ?? `symbol ${sym.id ?? '?'}`;
  // A rule the gateway omitted means "unbounded", not "throw from canonicalDecimal".
  const rule = (v: string | undefined, fallback = '0'): string =>
    v === undefined || v === null || v === '' ? fallback : v;

  if (input.price !== undefined && input.price !== '') {
    const p = roundToStep(input.price, rule(sym.tickSize, '0'), 'nearest');
    if (decimalCompare(p, '0') <= 0) throw new OrderValidationError('price must be positive');
    if (decimalCompare(p, rule(sym.minPrice)) < 0) {
      throw new OrderValidationError(`price ${p} is below the minimum ${rule(sym.minPrice)}`);
    }
    if (decimalCompare(rule(sym.maxPrice), '0') > 0 && decimalCompare(p, rule(sym.maxPrice)) > 0) {
      throw new OrderValidationError(`price ${p} is above the maximum ${rule(sym.maxPrice)}`);
    }
    out.price = p;
  }

  if (input.quantity !== undefined && input.quantity !== '') {
    const q = roundToStep(input.quantity, rule(sym.stepSize, '0'), 'floor');
    if (decimalCompare(q, '0') <= 0) {
      throw new OrderValidationError(
        `quantity rounds to zero on a step size of ${rule(sym.stepSize)}`,
      );
    }
    const min = rule(isMarket ? sym.marketMinQuantity || sym.minQuantity : sym.minQuantity);
    const max = rule(isMarket ? sym.marketMaxQuantity || sym.maxQuantity : sym.maxQuantity);
    if (decimalCompare(q, min) < 0) {
      throw new OrderValidationError(`quantity ${q} is below the minimum ${min}`);
    }
    if (decimalCompare(max, '0') > 0 && decimalCompare(q, max) > 0) {
      throw new OrderValidationError(`quantity ${q} is above the maximum ${max}`);
    }
    out.quantity = q;
  }

  if (input.funds !== undefined && input.funds !== '') {
    // `funds` was previously passed straight through. It must be bounds-checked
    // like any other signed field: "0" is truthy in JS, so a zero- or
    // negative-funds order would otherwise slip past the caller's
    // `!quantity && !funds` guard and get signed.
    const f = canonicalDecimal(input.funds);
    if (decimalCompare(f, '0') <= 0) throw new OrderValidationError('funds must be positive');
    if (decimalCompare(rule(sym.maxNotional), '0') > 0 && decimalCompare(f, rule(sym.maxNotional)) > 0) {
      throw new OrderValidationError(`funds ${f} is above the maximum notional ${rule(sym.maxNotional)}`);
    }
    out.funds = f;
  }

  // Notional bounds, checkable only when both legs are known. The min and max
  // tests are independent: minNotional "0" is a "no minimum" sentinel and must
  // not also switch off the maximum.
  if (out.price && out.quantity) {
    const notional = mulDecimal(out.price, out.quantity);
    if (decimalCompare(rule(sym.minNotional), '0') > 0 && decimalCompare(notional, rule(sym.minNotional)) < 0) {
      throw new OrderValidationError(
        `notional ${notional} is below the minimum ${rule(sym.minNotional)} for ${label}`,
      );
    }
    if (decimalCompare(rule(sym.maxNotional), '0') > 0 && decimalCompare(notional, rule(sym.maxNotional)) > 0) {
      throw new OrderValidationError(
        `notional ${notional} is above the maximum ${rule(sym.maxNotional)} for ${label}`,
      );
    }
  }

  return out;
}

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
