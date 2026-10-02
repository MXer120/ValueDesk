/**
 * SoDEX account reads, straight from the gateway - in exactly the shapes the
 * Valuescan server's /api/acct/* routes answered.
 *
 * All public and unauthenticated upstream (any wallet's state is readable by
 * anyone), so nothing about the connected wallet or a scanned one passes
 * through Valuescan any more, and each user spends their own IP's budget.
 *
 * History pages keep the server's two protections: a few seconds of sharing
 * between panels (sodexGateway.ts HISTORY_TTL_MS), and - when SoDEX refuses or
 * fails - the last good copy of exactly that page, marked with `staleAt`.
 */
import { unwrapList } from '@sign/sodex/restCore.js';
import type { Engine } from '../api';
import { isAbort } from './errors';
import { MarketRequestError } from './sodexMarket';
import { gateway, gwGet, type GwGetOptions } from './sodexGateway';
import type { HistoryPriority } from './historyQueue';

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Upstream's maximum page size for every history-style read (the server's
 * HISTORY_LIMIT_MAX); the default stays 100.
 */
const HISTORY_LIMIT_MAX = 1000;

function requireAddress(address: string | undefined): string {
  if (!address || !ADDRESS_RE.test(address)) throw new MarketRequestError('a valid 0x wallet address is required', 400);
  return address;
}

const ep = (e: Engine): string => `/api/v1/${e}`;

export interface HistoryFilter {
  limit?: number;
  symbol?: string;
  startTime?: number;
  endTime?: number | null;
  /** Who the read is for (historyQueue.ts); default 'visible'. */
  priority?: HistoryPriority;
  /** Aborts when the reader no longer wants the page: a read still waiting for its slot is dropped. */
  signal?: AbortSignal;
  /** Called when the request leaves for SoDEX (after any wait for its slot). */
  onSent?: () => void;
  /** true: never an answer kept from a moment ago (a table catching up because something changed). */
  fresh?: boolean;
}

/** The documented history filter, and the page size it asks for. */
export function historyQuery(q: HistoryFilter): { qs: string; limit: number } {
  const p = new URLSearchParams();
  if (q.symbol) p.set('symbol', q.symbol);
  if (q.startTime !== undefined) p.set('startTime', String(q.startTime));
  if (q.endTime !== undefined && q.endTime !== null) p.set('endTime', String(q.endTime));
  const limit = Math.min(HISTORY_LIMIT_MAX, Math.trunc(q.limit ?? 100) || 100);
  p.set('limit', String(limit));
  return { qs: p.toString(), limit };
}

/** A history page, or the last good copy of exactly this page (with when it was read). */
async function historyPage(path: string, q: Pick<HistoryFilter, 'priority' | 'signal' | 'onSent' | 'fresh'> = {}): Promise<{ data: unknown; staleAt: number | null }> {
  try {
    const o: GwGetOptions = {};
    if (q.priority) o.priority = q.priority;
    if (q.signal) o.signal = q.signal;
    if (q.onSent) o.onSent = q.onSent;
    if (q.fresh) o.ttlMs = 0;
    return { data: await gwGet<unknown>(path, o), staleAt: null };
  } catch (e) {
    // The reader left before the read was sent: not a failure, and no reason to answer with an old copy.
    if (isAbort(e)) throw e;
    const kept = gateway.lastGood<unknown>(path);
    if (kept) return { data: kept.value, staleAt: kept.at };
    throw e;
  }
}

export const account = {
  /** `aid === 0` means this wallet has no SoDEX account yet. */
  async state(e: Engine, addressIn: string) {
    const address = requireAddress(addressIn);
    const state = await gwGet<any>(`${ep(e)}/accounts/${address}/state`);
    return {
      engine: e,
      address,
      accountId: state?.aid ?? 0,
      userId: state?.uid ?? 0,
      exists: (state?.aid ?? 0) !== 0,
      state,
    };
  },

  async balances(e: Engine, addressIn: string) {
    const address = requireAddress(addressIn);
    return { engine: e, balances: unwrapList<any>(await gwGet<unknown>(`${ep(e)}/accounts/${address}/balances`), 'balances') };
  },

  async openOrders(e: Engine, addressIn: string, symbol?: string) {
    const address = requireAddress(addressIn);
    const qs = symbol ? `?symbol=${encodeURIComponent(symbol)}` : '';
    return { engine: e, orders: unwrapList<any>(await gwGet<unknown>(`${ep(e)}/accounts/${address}/orders${qs}`), 'orders') };
  },

  async positions(addressIn: string) {
    const address = requireAddress(addressIn);
    return { positions: unwrapList<any>(await gwGet<unknown>(`${ep('perps')}/accounts/${address}/positions`), 'positions') };
  },

  async orderHistory(e: Engine, addressIn: string, q: HistoryFilter = {}) {
    const address = requireAddress(addressIn);
    const { qs } = historyQuery(q);
    const { data, staleAt } = await historyPage(`${ep(e)}/accounts/${address}/orders/history?${qs}`, q);
    return { engine: e, orders: unwrapList<any>(data, 'orders'), staleAt };
  },

  async trades(e: Engine, addressIn: string, q: HistoryFilter = {}) {
    const address = requireAddress(addressIn);
    const { qs } = historyQuery(q);
    const { data, staleAt } = await historyPage(`${ep(e)}/accounts/${address}/trades?${qs}`, q);
    return { engine: e, trades: unwrapList<any>(data, 'trades'), staleAt };
  },

  /** NOT `/funding-history` as the published reference says - that path 404s; the log is `/fundings`. */
  async fundingHistory(addressIn: string, q: HistoryFilter = {}) {
    const address = requireAddress(addressIn);
    const { qs } = historyQuery(q);
    const { data, staleAt } = await historyPage(`${ep('perps')}/accounts/${address}/fundings?${qs}`, q);
    return { funding: unwrapList<any>(data, 'fundings'), staleAt };
  },

  /** Closed and partly closed perps positions, newest first (sodex.com's Position History). */
  async positionHistory(addressIn: string, q: HistoryFilter = {}) {
    const address = requireAddress(addressIn);
    const { qs } = historyQuery(q);
    const { data, staleAt } = await historyPage(`${ep('perps')}/accounts/${address}/positions/history?${qs}`, q);
    return { positions: unwrapList<any>(data, 'positions'), staleAt };
  },

  async feeRate(e: Engine, addressIn: string) {
    const address = requireAddress(addressIn);
    return { engine: e, feeRate: await gwGet<any>(`${ep(e)}/accounts/${address}/fee-rate`) };
  },

  async apiKeys(e: Engine, addressIn: string) {
    const address = requireAddress(addressIn);
    return { engine: e, apiKeys: await gwGet<any>(`${ep(e)}/accounts/${address}/api-keys`) };
  },
};
