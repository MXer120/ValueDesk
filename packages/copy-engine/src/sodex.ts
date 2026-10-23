/**
 * SoDEX, as the copier talks to it: public reads, and signed writes it never
 * retries.
 *
 * READS go through one weight budget per client (SoDEX allows 1,200 weight a
 * minute per IP; the budget keeps 20% back for writes) and are retried on a
 * transient failure. WRITES are sent once. A write that got no answer, or an
 * answer that cannot be read, may still have executed: it raises
 * `OutcomeUnknownError` and the caller re-reads instead of sending again (the
 * nonce makes a resend of the SAME bytes harmless, a new signature would not).
 */
import {
  GATEWAY_ORIGIN,
  SodexApiError,
  approvedBuilderRates,
  isTransientFailure,
  parseEnvelope,
  weightFor,
  type BuiltRequest,
  type Network,
} from '../../sodex-core/src/index.ts';
import { abortController, sleep, timers, type FetchLike } from './io.ts';
import { parseMarkets } from './markets.ts';
import type { FollowerSnapshot, MarginChoice, MarketInfo } from './types.ts';

export class OutcomeUnknownError extends Error {
  override name = 'OutcomeUnknownError';
  readonly outcomeUnknown = true;
}

/** A sliding one-minute weight budget. */
export class WeightBudget {
  private spent: Array<{ at: number; w: number }> = [];
  constructor(readonly perMinute = 1200, readonly readShare = 0.8) {}

  used(now = Date.now()): number {
    while (this.spent.length && now - this.spent[0]!.at >= 60_000) this.spent.shift();
    return this.spent.reduce((a, b) => a + b.w, 0);
  }

  /** Book `w` now (writes never wait). */
  charge(w: number, now = Date.now()): void {
    this.spent.push({ at: now, w });
  }

  /** Wait until a read of weight `w` fits under the read share, then book it. */
  async take(w: number): Promise<void> {
    for (let i = 0; i < 120; i++) {
      const now = Date.now();
      if (this.used(now) + w <= this.perMinute * this.readShare) {
        this.charge(w, now);
        return;
      }
      const oldest = this.spent[0];
      await sleep(oldest ? Math.max(50, 60_000 - (now - oldest.at) + 5) : 250);
    }
    throw new SodexApiError(429, 'local read budget exhausted', 429, '');
  }
}

export interface SodexClientOptions {
  network: Network;
  /** REST origin; default SoDEX's gateway for the network. */
  gateway?: string;
  fetch: FetchLike;
  budget?: WeightBudget;
  readTimeoutMs?: number;
  writeTimeoutMs?: number;
}

interface ApiKeyRow {
  name: string;
  publicKey: string;
  expiresAt: number;
  permissions?: number;
}

export class SodexClient {
  readonly network: Network;
  readonly gateway: string;
  readonly budget: WeightBudget;
  private readonly fetch: FetchLike;
  private readonly readTimeoutMs: number;
  private readonly writeTimeoutMs: number;

  constructor(o: SodexClientOptions) {
    this.network = o.network;
    this.gateway = (o.gateway ?? GATEWAY_ORIGIN[o.network]).replace(/\/+$/, '');
    this.fetch = o.fetch;
    this.budget = o.budget ?? new WeightBudget();
    this.readTimeoutMs = o.readTimeoutMs ?? 10_000;
    this.writeTimeoutMs = o.writeTimeoutMs ?? 15_000;
  }

  /** An unsigned GET, budgeted and retried on transient failures. */
  async get<T>(path: string, weight = weightFor(path), attempts = 3): Promise<T> {
    let last: unknown;
    for (let i = 1; i <= attempts; i++) {
      await this.budget.take(weight);
      const ctl = abortController();
      const timer = timers.after(this.readTimeoutMs, () => ctl.abort());
      try {
        const res = await this.fetch(this.gateway + path, { method: 'GET', headers: { Accept: 'application/json' }, signal: ctl.signal });
        const text = await res.text();
        return parseEnvelope<T>(res.status, text, path);
      } catch (e) {
        last = e;
        if (i >= attempts || !isTransientFailure(e)) throw e;
        await sleep(300 * 2 ** (i - 1));
      } finally {
        timers.cancel(timer);
      }
    }
    throw last;
  }

  /** Send one signed request, once. */
  async send<T = unknown>(req: Pick<BuiltRequest, 'method' | 'gatewayPath' | 'headers' | 'body'>): Promise<T> {
    this.budget.charge(1);
    const ctl = abortController();
    const timer = timers.after(this.writeTimeoutMs, () => ctl.abort());
    let res;
    try {
      res = await this.fetch(this.gateway + req.gatewayPath, { method: req.method, headers: req.headers, body: req.body, signal: ctl.signal });
    } catch (e) {
      throw new OutcomeUnknownError(`SoDEX did not answer (${String(e).slice(0, 120)}); the request may still have executed.`);
    } finally {
      timers.cancel(timer);
    }
    const text = await res.text().catch(() => '');
    const unreadable = res.status < 400 && text.trim() !== '' && !/^[\[{]/.test(text.trim());
    if (res.status >= 500 || unreadable) {
      throw new OutcomeUnknownError(`SoDEX answered HTTP ${res.status} after receiving the request; it may still have executed.`);
    }
    return parseEnvelope<T>(res.status, text, req.gatewayPath);
  }

  async markets(): Promise<MarketInfo[]> {
    return parseMarkets(await this.get<unknown>('/api/v1/perps/markets/symbols'));
  }

  async markPrices(): Promise<Array<{ symbol: string; price: number }>> {
    const rows = await this.get<Array<{ symbol?: string; markPrice?: string }>>('/api/v1/perps/markets/mark-prices');
    return (rows ?? [])
      .map((r) => ({ symbol: String(r.symbol ?? ''), price: Number(r.markPrice) }))
      .filter((r) => r.symbol && Number.isFinite(r.price) && r.price > 0);
  }

  /** The primary account id (0 when SoDEX has never seen a deposit from the wallet). */
  async accountId(address: string): Promise<number> {
    const a = address.toLowerCase();
    try {
      const s = await this.get<{ primaryAccountID?: number } | null>(`/api/v1/user/${a}/subaccounts`);
      if (s && typeof s.primaryAccountID === 'number' && s.primaryAccountID > 0) return s.primaryAccountID;
    } catch (e) {
      if (!(e instanceof SodexApiError && /user not found/i.test(e.message))) throw e;
    }
    const st = await this.perpsState(a);
    return st && typeof st.aid === 'number' && st.aid > 0 ? st.aid : 0;
  }

  async perpsState(address: string): Promise<RawPerpsState | null> {
    return this.get<RawPerpsState | null>(`/api/v1/perps/accounts/${address.toLowerCase()}/state`);
  }

  /** The follower's account as the copier needs it. */
  async follower(address: string, now = Date.now()): Promise<FollowerSnapshot> {
    return followerFromState(await this.perpsState(address), now);
  }

  /** Leader positions on SoDEX, symbol -> signed size, plus equity. */
  async leaderPositions(address: string): Promise<{ positions: Record<string, number>; equity: number | null; marks: Record<string, number> }> {
    const st = await this.perpsState(address);
    const positions: Record<string, number> = {};
    const marks: Record<string, number> = {};
    for (const p of st?.P ?? []) {
      const sz = Number(p.sz);
      if (p.s && Number.isFinite(sz) && sz !== 0) positions[p.s] = sz;
    }
    const av = Number(st?.av);
    return { positions, equity: Number.isFinite(av) ? av : null, marks };
  }

  /** The account's API keys on perps (names are public). */
  async apiKeys(address: string, engine: 'spot' | 'perps' = 'perps'): Promise<ApiKeyRow[]> {
    const rows = await this.get<ApiKeyRow[] | { apiKeys?: ApiKeyRow[] } | null>(`/api/v1/${engine}/accounts/${address.toLowerCase()}/api-keys`);
    return Array.isArray(rows) ? rows : rows?.apiKeys ?? [];
  }

  /** Whether `keyAddress` is registered under `name` and not expired. */
  async keyRegistered(owner: string, name: string, keyAddress: string, now = Date.now()): Promise<{ ok: boolean; expiresAt: number | null }> {
    const rows = await this.apiKeys(owner, 'perps');
    const row = rows.find((r) => r.name === name);
    if (!row || row.publicKey.toLowerCase() !== keyAddress.toLowerCase()) return { ok: false, expiresAt: null };
    if (row.expiresAt && row.expiresAt <= now) return { ok: false, expiresAt: row.expiresAt };
    return { ok: true, expiresAt: row.expiresAt || null };
  }

  /** The perps builder-fee ceiling the account approved for `builderId` (null: none). */
  async builderApproval(owner: string, builderId: number): Promise<number | null> {
    const data = await this.get<unknown>(`/api/v1/user/${owner.toLowerCase()}/builders`);
    return approvedBuilderRates(data, builderId).perps;
  }
}

/** The part of `GET /perps/accounts/{a}/state` the copier reads. */
export interface RawPerpsState {
  aid?: number;
  av?: string;
  am?: string;
  P?: Array<{ s: string; sz: string; ep: string; l?: number; m?: string }> | null;
  S?: Array<{ s: string; l: number; m: string }> | null;
}

export function followerFromState(st: RawPerpsState | null, now = Date.now()): FollowerSnapshot {
  const positions: FollowerSnapshot['positions'] = {};
  for (const p of st?.P ?? []) {
    const size = Number(p.sz);
    if (!p.s || !Number.isFinite(size) || size === 0) continue;
    positions[p.s] = {
      size,
      entry: Number(p.ep) || 0,
      leverage: typeof p.l === 'number' ? p.l : 1,
      marginMode: (p.m === 'ISOLATED' ? 'isolated' : 'cross') as MarginChoice,
    };
  }
  const equity = Number(st?.av);
  const available = Number(st?.am);
  return {
    accountId: typeof st?.aid === 'number' ? st.aid : 0,
    equity: Number.isFinite(equity) ? equity : 0,
    available: Number.isFinite(available) ? available : 0,
    positions,
    at: now,
  };
}

/** Per-symbol leverage settings the account has (S[]), symbol -> {leverage, margin}. */
export function leverageSettings(st: RawPerpsState | null): Record<string, { leverage: number; marginMode: MarginChoice }> {
  const out: Record<string, { leverage: number; marginMode: MarginChoice }> = {};
  for (const s of st?.S ?? []) out[s.s] = { leverage: s.l, marginMode: s.m === 'ISOLATED' ? 'isolated' : 'cross' };
  return out;
}

/* --------------------------------------------------------- Hyperliquid ----- */

export const HL_INFO_URL = 'https://api.hyperliquid.xyz/info';
export const HL_WS_URL = 'wss://api.hyperliquid.xyz/ws';

/** Hyperliquid's public info endpoint: leader positions and equity. */
export class HyperliquidClient {
  constructor(
    private readonly fetch: FetchLike,
    private readonly url = HL_INFO_URL,
  ) {}

  async post<T>(body: Record<string, unknown>, attempts = 3): Promise<T> {
    let last: unknown;
    for (let i = 1; i <= attempts; i++) {
      const ctl = abortController();
      const timer = timers.after(10_000, () => ctl.abort());
      try {
        const res = await this.fetch(this.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal });
        const text = await res.text();
        if (!res.ok) throw new SodexApiError(res.status, `Hyperliquid answered HTTP ${res.status}`, res.status, this.url);
        return JSON.parse(text) as T;
      } catch (e) {
        last = e;
        if (i >= attempts || !isTransientFailure(e)) throw e;
        await sleep(300 * 2 ** (i - 1));
      } finally {
        timers.cancel(timer);
      }
    }
    throw last;
  }

  /** Perp positions (coin -> signed size) and account value. */
  async leaderPositions(address: string): Promise<{ positions: Record<string, number>; equity: number | null; marks: Record<string, number> }> {
    const st = await this.post<{
      marginSummary?: { accountValue?: string };
      assetPositions?: Array<{ position?: { coin?: string; szi?: string; positionValue?: string } }>;
    }>({ type: 'clearinghouseState', user: address.toLowerCase() });
    const positions: Record<string, number> = {};
    const marks: Record<string, number> = {};
    for (const ap of st?.assetPositions ?? []) {
      const p = ap.position;
      const sz = Number(p?.szi);
      if (p?.coin && Number.isFinite(sz) && sz !== 0) {
        positions[p.coin] = sz;
        const pv = Number(p.positionValue);
        if (Number.isFinite(pv) && pv > 0) marks[p.coin] = pv / Math.abs(sz);
      }
    }
    const av = Number(st?.marginSummary?.accountValue);
    return { positions, equity: Number.isFinite(av) ? av : null, marks };
  }
}
