/**
 * Symbol metadata cache and resolver.
 *
 * Order placement needs a numeric `symbolID`, but humans and URLs use names
 * ("BTC-USD", "vBTC_vUSDC"). Symbol rules (tick size, step size, min notional)
 * are also needed to validate an order BEFORE spending a signature on it - a
 * client-side rejection is instant, a server-side one costs a round trip and a
 * consumed nonce.
 */
import { sodex } from './rest.js';
import { enginePath, type Engine } from '../config.js';
import { canonicalDecimal, decimalCompare, roundToStep } from '../decimal.js';

export interface Symbol {
  id: number;
  name: string;
  displayName: string;
  baseCoin: string;
  quoteCoin: string;
  quoteCoinID: number;
  baseCoinID?: number;
  pricePrecision: number;
  tickSize: string;
  minPrice: string;
  maxPrice: string;
  quantityPrecision: number;
  stepSize: string;
  minQuantity: string;
  maxQuantity: string;
  marketMinQuantity: string;
  marketMaxQuantity: string;
  minNotional: string;
  maxNotional: string;
  makerFee: string;
  takerFee: string;
  status: string;
  maxLeverage?: number;
  initLeverage?: number;
  fundingInterval?: number;
  maxFundingRate?: string;
  minFundingRate?: string;
  marginTiers?: Array<{
    maxNotionalValue: string;
    maintenanceMarginRate: string;
    maxLeverage: number;
    maintenanceDeduction: string;
  }>;
}

export interface Coin {
  id: number;
  name: string;
  precision: number;
}

const byEngine = new Map<Engine, { at: number; list: Symbol[] }>();
const TTL = 60_000;

export async function symbols(engine: Engine): Promise<Symbol[]> {
  const hit = byEngine.get(engine);
  if (hit && Date.now() - hit.at < TTL) return hit.list;
  const list = await sodex.get<Symbol[]>(`${enginePath(engine)}/markets/symbols`);
  byEngine.set(engine, { at: Date.now(), list });
  return list;
}

export const coins = (): Promise<Coin[]> => sodex.get<Coin[]>(`${enginePath('spot')}/markets/coins`);

/** Resolve by internal name, display name, or numeric id - case-insensitively. */
export async function resolve(engine: Engine, ref: string | number): Promise<Symbol> {
  const list = await symbols(engine);
  if (typeof ref === 'number' || /^\d+$/.test(String(ref))) {
    const id = Number(ref);
    const hit = list.find((s) => s.id === id);
    if (hit) return hit;
    throw new SymbolNotFoundError(`unknown ${engine} symbolID ${id}`);
  }
  const want = String(ref).toUpperCase();
  const hit = list.find(
    (s) => s.name.toUpperCase() === want || s.displayName.toUpperCase() === want,
  );
  if (hit) return hit;
  throw new SymbolNotFoundError(`unknown ${engine} symbol ${ref}`);
}

export class OrderValidationError extends Error {}

/** An unknown market is a bad request, not a server fault. */
export class SymbolNotFoundError extends Error {
  readonly statusCode = 404;
}

/**
 * Validate and normalise price/quantity against a symbol's trading rules.
 *
 * Runs before signing, so a bad order costs nothing. Returns canonical decimal
 * strings snapped to the tick/step grid - which also guarantees no trailing
 * zeros, the single most common cause of a rejected payload.
 */
export function normaliseOrder(
  sym: Symbol,
  input: { price?: string; quantity?: string; funds?: string; type: number },
): { price?: string; quantity?: string; funds?: string } {
  const out: { price?: string; quantity?: string; funds?: string } = {};
  const isMarket = input.type === 2;
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
        `notional ${notional} is below the minimum ${rule(sym.minNotional)} for ${sym.displayName}`,
      );
    }
    if (decimalCompare(rule(sym.maxNotional), '0') > 0 && decimalCompare(notional, rule(sym.maxNotional)) > 0) {
      throw new OrderValidationError(
        `notional ${notional} is above the maximum ${rule(sym.maxNotional)} for ${sym.displayName}`,
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

export const clearSymbolCache = (): void => void byEngine.clear();
