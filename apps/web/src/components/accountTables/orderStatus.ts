/**
 * What an order's status IS, for the status icon in Order History and Open
 * Orders - one pure mapping, covered by orderStatus.test.ts.
 *
 * WHAT SODEX RETURNS (rest_schema.md, OrderStatusEnum - REST answers the
 * string, the account WebSocket the integer):
 *   NEW 1 · PARTIALLY_FILLED 2 · FILLED 3 · CANCELED 4 · REJECTED 5 ·
 *   EXPIRED 6 · TRIGGERED 10 (perps TP/SL whose trigger fired)
 * Older stream payloads also carried 7 pending, 8 pending cancel, 9 pending
 * modify, 11 replaced, 12 pending replace (the map Account.tsx always had); they
 * are kept so a row from the stream never falls through to "unknown".
 *
 * TWO THINGS THE STATUS ALONE DOES NOT SAY, and which the row does:
 *   - How much filled. A CANCELED or EXPIRED order with executedQty > 0 was
 *     PARTIALLY filled first - "cancelled" alone would hide a real fill. Those
 *     keep the partial pie and say "Partially filled · cancelled".
 *   - Whether a NEW order is still waiting for its trigger. An open stop
 *     (stopPrice set, status NEW) has not reached the book at all; that is
 *     "Untriggered", not "Open".
 * EXPIRED with nothing filled is the IOC / FOK / market / post-only order that
 * the engine dropped - the alert triangle, because nothing happened.
 */

import { fmtFixed, fmtPlain } from '../../numStyle';
export type StatusKind =
  | 'filled'
  | 'open'
  | 'partial'            // partially filled, still working
  | 'partial-ended'      // partially filled, then cancelled or expired
  | 'cancelled'
  | 'expired'            // expired with nothing filled (IOC / FOK / market / post-only)
  | 'rejected'
  | 'untriggered'        // a stop / TP waiting for its trigger
  | 'triggered'
  | 'pending'            // pending / pending modify / pending replace
  | 'pending-cancel'
  | 'replaced'
  | 'unknown';

export type StatusTone = 'pos' | 'neg' | 'warn' | 'accent' | 'muted' | 'dim';

export interface OrderStatusInfo {
  kind: StatusKind;
  /** Short label for the cell. */
  label: string;
  /** Colour of the icon (the label stays --text / --muted). */
  tone: StatusTone;
  /** executedQty / origQty in [0, 1], or null when either is unknown. */
  filled: number | null;
  /** The raw status, normalised (FILLED, PARTIALLY_FILLED, ...). */
  raw: string;
}

const NUMERIC: Record<number, string> = {
  1: 'NEW', 2: 'PARTIALLY_FILLED', 3: 'FILLED', 4: 'CANCELED', 5: 'REJECTED', 6: 'EXPIRED',
  7: 'PENDING', 8: 'PENDING_CANCEL', 9: 'PENDING_MODIFY', 10: 'TRIGGERED', 11: 'REPLACED', 12: 'PENDING_REPLACE',
};

/** The status as SoDEX's string enum, whichever spelling the row used. */
export function normaliseStatus(v: unknown): string {
  if (typeof v === 'number') return NUMERIC[v] ?? String(v);
  const s = String(v ?? '').trim().toUpperCase().replace(/[\s-]+/g, '_');
  if (/^\d+$/.test(s)) return NUMERIC[Number(s)] ?? s;
  if (s === 'CANCELLED') return 'CANCELED';
  if (s === 'PARTIAL' || s === 'PARTIALLYFILLED') return 'PARTIALLY_FILLED';
  return s;
}

const dec = (v: unknown): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : NaN;
};

/** executedQty / origQty, clamped to [0, 1]; null when either is missing or origQty is 0. */
export function filledFraction(executed: unknown, orig: unknown): number | null {
  const e = dec(executed);
  const o = dec(orig);
  if (!Number.isFinite(e) || !Number.isFinite(o) || o <= 0) return null;
  return Math.min(1, Math.max(0, e / o));
}

export interface StatusInput {
  status: unknown;
  executedQty?: unknown;
  origQty?: unknown;
  stopPrice?: unknown;
  stopType?: unknown;
}

export function orderStatusInfo(o: StatusInput): OrderStatusInfo {
  const raw = normaliseStatus(o.status);
  const filled = filledFraction(o.executedQty, o.origQty);
  const some = (filled ?? 0) > 0;
  const stop = dec(o.stopPrice) > 0 || (o.stopType !== undefined && o.stopType !== null && o.stopType !== '');
  const r = (kind: StatusKind, label: string, tone: StatusTone): OrderStatusInfo => ({ kind, label, tone, filled, raw });

  switch (raw) {
    case 'FILLED':
      return r('filled', 'Filled', 'pos');
    case 'NEW':
      if (some) return r('partial', 'Partially filled', 'accent');
      return stop ? r('untriggered', 'Untriggered', 'muted') : r('open', 'Open', 'muted');
    case 'PARTIALLY_FILLED':
      return r('partial', 'Partially filled', 'accent');
    case 'CANCELED':
      return some ? r('partial-ended', 'Partially filled · cancelled', 'warn') : r('cancelled', 'Cancelled', 'neg');
    case 'EXPIRED':
      return some ? r('partial-ended', 'Partially filled · expired', 'warn') : r('expired', 'Expired', 'neg');
    case 'REJECTED':
      return r('rejected', 'Rejected', 'neg');
    case 'TRIGGERED':
      return r('triggered', 'Triggered', 'accent');
    case 'PENDING':
      return r('pending', 'Pending', 'muted');
    case 'PENDING_MODIFY':
      return r('pending', 'Pending modify', 'muted');
    case 'PENDING_REPLACE':
      return r('pending', 'Pending replace', 'muted');
    case 'PENDING_CANCEL':
      return r('pending-cancel', 'Pending cancel', 'muted');
    case 'REPLACED':
      return r('replaced', 'Replaced', 'muted');
    default:
      return r('unknown', raw ? raw.charAt(0) + raw.slice(1).toLowerCase().replace(/_/g, ' ') : 'Unknown', 'dim');
  }
}

/** Every kind, in the order the report / legend lists them. */
export const STATUS_KINDS: readonly StatusKind[] = [
  'open', 'untriggered', 'partial', 'filled', 'partial-ended', 'cancelled', 'expired', 'rejected',
  'triggered', 'pending', 'pending-cancel', 'replaced', 'unknown',
];

/** The tooltip: the full status and how much of the order filled. */
export function statusTitle(info: OrderStatusInfo, executed: string | null, orig: string | null, unit?: string): string {
  const u = unit ? ` ${unit}` : '';
  const pct = info.filled === null ? '' : ` (${formatPct(info.filled)})`;
  const amount = executed !== null && orig !== null ? ` - filled ${executed} of ${orig}${u}${pct}` : '';
  return `${info.label}${amount}`;
}

/** 0.37 -> "37%", 0.0012 -> "0.12%", 1 -> "100%". */
export function formatPct(f: number): string {
  const p = f * 100;
  if (p === 0 || p === 100) return `${p}%`;
  if (p < 1) return `${fmtFixed(p, 2)}%`;
  if (p < 10) return `${fmtPlain(Number(p.toFixed(1)))}%`;
  return `${Math.round(p)}%`;
}
