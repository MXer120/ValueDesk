/**
 * All-time account statistics, computed in this browser.
 *
 * The same answer /api/stats/all-time gave (statsCore.ts builds both), from the
 * same engine (historySync.ts: the two-phase, resumable backward walk) and the
 * same totals (historyStats.ts) - but the pages are read straight from SoDEX
 * with this user's own per-IP budget, and what was walked is kept in this
 * browser (historyDb.ts), not on the ValueDesk server.
 *
 * The walk is the lowest-priority traffic there is, as it was on the server:
 *  - one walk page per WALK_GAP_MS, over every tab and every wallet;
 *  - a `/trades` page only as the lowest-priority history read there is
 *    (exchange/historyQueue.ts): nothing else read history in the last minute,
 *    no table asked for any, and the page is past its first seconds - so the
 *    fill and order panels always find a slot of the two per minute;
 *  - never while the per-IP weight budget is more than half spent;
 *  - after SoDEX rate-limits a walk page, no tab walks for WALK_PAUSE_MS.
 *
 * Tabs: each scope (spot fills, perps fills, funding) of a wallet is walked by
 * one tab at a time, under a Web Lock. A tab that waits reads what the walking
 * tab stored as it goes, so both show the same progress.
 */
import { unwrapList } from '@sign/sodex/restCore.js';
import { normaliseFunding, normaliseTrade, type NormalRow, type PageQuery } from '@sign/historyRows.js';
import {
  MemoryHistoryStore,
  SCOPE_KINDS,
  createHistorySync,
  scopeKey,
  type HistorySync,
  type PageFetcher,
  type ScopeKind,
  type ScopeState,
  type StoreChange,
} from '@sign/historySync.js';
import { aggregateFunding, aggregateTradeRows, quoteCoinMap, type FundingStats, type TradeStats } from '@sign/historyStats.js';
import { allTimeStatsBody, headlineReader, type AllTimeStats } from '@sign/statsCore.js';
import type { Engine } from '../api';
import { logger } from '../log';
import { RateLimitedError, isRateLimitError } from './errors';
import { IdbHistory, type HistoryPersistence } from './historyDb';
import { SharedLedger, defaultLedgerDeps, type LedgerDeps, type LockManagerLike } from './ledger';
import { dataGet } from './sodexData';
import { MarketRequestError, symbolList } from './sodexMarket';
import { gateway as appGateway, type GatewayClient } from './sodexGateway';

const log = logger('history');

/** At least this long between two walk pages, every tab and wallet together (the server's WALK_GAP_MS). */
export const WALK_GAP_MS = 6_000;
/** After SoDEX rate-limits a walk page, every tab's walks stay off this long. */
export const WALK_PAUSE_MS = 30 * 60_000;
/** How long a completed sync counts as fresh (the server's RESYNC_AFTER_MS). */
const RESYNC_AFTER_MS = 5 * 60_000;
/** A tab waiting for another tab's walk re-reads what it stored at most this often. */
const FOLLOW_EVERY_MS = 4_000;
const PAUSE_KEY = 'vs:history:walk-paused-until';

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export interface AllTimeDeps {
  gateway: GatewayClient;
  /** One data-host GET (mainnet-data.sodex.dev), resolving with `data`. */
  dataGet<T>(path: string): Promise<T>;
  /** The engine's market list (for the quote coin each symbol is priced in). */
  symbols(e: Engine): Promise<ReadonlyArray<{ name?: string; quoteCoin?: string }>>;
  persistence: HistoryPersistence;
  /** Per-scope exclusivity across tabs; null = this tab alone. */
  locks: LockManagerLike | null;
  ledger: LedgerDeps;
}

const sameState = (a: ScopeState | null, b: ScopeState): boolean =>
  (a === null && b.updatedAt === 0 && b.pages === 0) ||
  (a !== null &&
    a.updatedAt === b.updatedAt &&
    a.pages === b.pages &&
    a.oldest === b.oldest &&
    a.newest === b.newest &&
    a.complete === b.complete &&
    a.lastError === b.lastError);

const qsOf = (q: PageQuery): string => {
  const p = new URLSearchParams();
  if (q.startTime !== undefined) p.set('startTime', String(q.startTime));
  if (q.endTime !== undefined) p.set('endTime', String(q.endTime));
  p.set('limit', String(q.limit));
  return p.toString();
};

export interface AllTime {
  /** The Stats answer for one wallet; starts (or continues) its walks in the background. */
  stats(address: string, rebuild?: boolean): Promise<AllTimeStats>;
  readonly sync: HistorySync;
  /** Resolves once every queued write has reached persistence (tests). */
  flush(): Promise<void>;
}

export function createAllTime(d: AllTimeDeps): AllTime {
  const { gateway } = d;
  const now = d.ledger.now;
  const walkGap = new SharedLedger('sodex-walk', 1, WALK_GAP_MS, d.ledger);
  let pending: Promise<void> = Promise.resolve();
  let pausedUntilMem = 0;

  // --- the shared walk pause (localStorage, so every tab honours it) -------------
  const pausedFor = (): number => {
    let until = pausedUntilMem;
    try {
      const v = Number(d.ledger.store?.getItem(PAUSE_KEY) ?? 0);
      if (Number.isFinite(v)) until = Math.max(until, v);
    } catch {
      /* this tab's copy */
    }
    return Math.max(0, until - now());
  };
  const pauseWalks = (ms: number): void => {
    const until = Math.max(now() + ms, now() + pausedFor());
    pausedUntilMem = until;
    try {
      d.ledger.store?.setItem(PAUSE_KEY, String(until));
    } catch {
      /* this tab still honours it */
    }
  };

  /** Wait for this walk page's turn: pause, cooldown, budget, drip headroom, the gap. */
  async function walkTurn(path: string): Promise<void> {
    const drip = gateway.dripFor(path);
    for (;;) {
      if (pausedFor() > 0) throw new Error('SoDEX rate-limited this connection - history walks are paused for a while.');
      const cool = gateway.cooldownLeft(path);
      if (cool > 0) {
        // That endpoint is cooling down: a background walk does not add to it.
        pauseWalks(Math.min(WALK_PAUSE_MS, cool * 4));
        throw new Error('SoDEX is rate limiting this connection - the walk resumes later.');
      }
      // A `/trades` page only when a background history read may go (historyQueue.ts):
      // the walk spends its turn when the page can actually be sent, not before.
      const busy = gateway.budget.spent() > gateway.budget.limit / 2 || (drip !== null && !gateway.historyQueue.backgroundMayGo());
      if (!busy) {
        const wait = await walkGap.tryTake(1);
        if (wait === 0) return;
        await d.ledger.sleep(Math.min(wait, 3_000));
        continue;
      }
      await d.ledger.sleep(3_000);
    }
  }

  /** One walk page reader: newest first, each row normalised (its raw JSON dropped once hashed). */
  function walkPages(pathOf: (q: PageQuery) => string, listKey: string, normalise: (r: Record<string, unknown>) => NormalRow): PageFetcher {
    return async (q) => {
      const path = pathOf(q);
      await walkTurn(path);
      try {
        // Not kept as a last-good copy: a long walk would otherwise hold every page it read.
        const data = await gateway.get<unknown>(path, { ttlMs: 0, keepLastGood: false, priority: 'walk' });
        return unwrapList<Record<string, unknown>>(data, listKey).map((r) => ({ ...normalise(r), raw: '' }));
      } catch (e) {
        if (e instanceof RateLimitedError || isRateLimitError(e)) pauseWalks(WALK_PAUSE_MS);
        throw e;
      }
    };
  }

  function pageSource(kind: ScopeKind, address: string): PageFetcher {
    if (kind === 'funding') {
      // `/fundings`, not the documented `/funding-history` - the latter 404s.
      return walkPages((q) => `/api/v1/perps/accounts/${address}/fundings?${qsOf(q)}`, 'fundings', normaliseFunding);
    }
    const engine: Engine = kind === 'trades-spot' ? 'spot' : 'perps';
    return walkPages((q) => `/api/v1/${engine}/accounts/${address}/trades?${qsOf(q)}`, 'trades', normaliseTrade);
  }

  // --- the working copy, mirrored to persistence ---------------------------------
  const persist = (c: StoreChange): void => {
    const p = d.persistence;
    const write = c.type === 'rows' ? p.appendRows(c.scope, c.rows) : c.type === 'state' ? p.putState(c.scope, c.state) : p.dropScope(c.scope);
    pending = pending.then(() => write);
  };
  const store = new MemoryHistoryStore(persist);

  /** Scopes whose walk waits for another tab: shown from what that tab stores. */
  const waiting = new Set<string>();
  const followedAt = new Map<string, number>();

  const lockName = (scope: string) => `vs-history:${scope}`;

  function exclusive(scope: string, run: () => Promise<void>): Promise<void> {
    if (!d.locks) return run();
    waiting.add(scope);
    return d.locks
      .request(lockName(scope), async () => {
        waiting.delete(scope);
        await run();
      })
      .finally(() => waiting.delete(scope));
  }

  /** Bring a scope's working copy up to what is persisted, if another tab moved it on. */
  async function refresh(scope: string): Promise<void> {
    if (!d.persistence.status().ok) return;
    const persisted = await d.persistence.readState(scope);
    if (sameState(persisted, store.readState(scope))) return;
    const loaded = await d.persistence.readScope(scope);
    if (loaded) store.load(scope, loaded.state, loaded.rows);
  }

  const sync = createHistorySync({
    store,
    pageSource,
    // Pacing is per page path (walkTurn), inside the page source.
    paced: (f) => f,
    resyncAfterMs: RESYNC_AFTER_MS,
    now,
    exclusive,
    beforeSync: async (scope) => {
      await refresh(scope);
      await d.persistence.compact(scope);
    },
  });

  // --- hydration and the wallet cap ---------------------------------------------
  const hydrated = new Map<string, Promise<void>>();

  function hydrate(address: string): Promise<void> {
    const key = address.toLowerCase();
    let p = hydrated.get(key);
    if (!p) {
      p = (async () => {
        await Promise.all(
          SCOPE_KINDS.map(async (kind) => {
            const loaded = await d.persistence.readScope(scopeKey(kind, key));
            if (loaded) store.load(scopeKey(kind, key), loaded.state, loaded.rows);
          }),
        );
        const evicted = await d.persistence.touchWallet(key);
        for (const old of evicted) void evict(old);
      })();
      hydrated.set(key, p);
    }
    return p;
  }

  /** Drop a wallet that fell out of the cap - each scope under its lock, so no walk is cut in half. */
  async function evict(address: string): Promise<void> {
    for (const kind of SCOPE_KINDS) {
      const scope = scopeKey(kind, address);
      const drop = async () => {
        await d.persistence.dropScope(scope);
        store.unload(scope);
      };
      await (d.locks ? d.locks.request(lockName(scope), drop) : drop());
    }
    hydrated.delete(address);
    await d.persistence.forgetWallet(address);
    log.debug('dropped the cached history of a wallet not used lately');
  }

  // --- totals, recomputed only when the rows changed ------------------------------
  const quoteMaps = new Map<Engine, Map<string, string>>();
  async function quotes(e: Engine): Promise<Map<string, string>> {
    const known = quoteMaps.get(e);
    if (known && known.size > 0) return known;
    try {
      const m = quoteCoinMap(await d.symbols(e));
      quoteMaps.set(e, m);
      return m;
    } catch {
      // Symbol metadata is a nicety here, not a prerequisite: the volume
      // bucket loses its label, which the panel shows as "unlabelled".
      return new Map();
    }
  }

  const tradeMemo = new Map<string, { version: number; labels: number; value: TradeStats }>();
  async function tradeStats(e: Engine, address: string): Promise<TradeStats> {
    const scope = scopeKey(e === 'spot' ? 'trades-spot' : 'trades-perps', address);
    const q = await quotes(e);
    const version = store.versionOf(scope);
    const hit = tradeMemo.get(scope);
    if (hit && hit.version === version && hit.labels === q.size) return hit.value;
    const value = aggregateTradeRows(q, store.loadRows(scope));
    tradeMemo.set(scope, { version, labels: q.size, value });
    return value;
  }

  const fundingMemo = new Map<string, { version: number; value: FundingStats }>();
  function fundingStats(address: string): FundingStats {
    const scope = scopeKey('funding', address);
    const version = store.versionOf(scope);
    const hit = fundingMemo.get(scope);
    if (hit && hit.version === version) return hit.value;
    const value = aggregateFunding(store.loadRows(scope));
    fundingMemo.set(scope, { version, value });
    return value;
  }

  const headline = headlineReader({
    accountId: async (a) => Number((await gateway.get<{ aid?: number }>(`/api/v1/perps/accounts/${a}/state`))?.aid ?? 0),
    dataGet: (path) => d.dataGet(path),
    now,
  });

  async function stats(addressIn: string, rebuild = false): Promise<AllTimeStats> {
    if (!addressIn || !ADDRESS_RE.test(addressIn)) throw new MarketRequestError('a valid 0x wallet address is required', 400);
    const address = addressIn;
    await hydrate(address);

    // A scope another tab is walking: show what it has stored so far.
    for (const kind of SCOPE_KINDS) {
      const scope = scopeKey(kind, address);
      if (!waiting.has(scope)) continue;
      if (now() - (followedAt.get(scope) ?? 0) < FOLLOW_EVERY_MS) continue;
      followedAt.set(scope, now());
      await refresh(scope);
    }

    for (const kind of SCOPE_KINDS) sync.ensureSync(kind, address, rebuild);

    // A snapshot, as the server's JSON was: the live progress objects keep changing.
    const scopes: Record<string, ReturnType<HistorySync['progressOf']>> = {};
    for (const kind of SCOPE_KINDS) scopes[kind] = { ...sync.progressOf(kind, address) };

    const [spot, perps, head] = await Promise.all([tradeStats('spot', address), tradeStats('perps', address), headline(address)]);
    return allTimeStatsBody({
      address,
      spot,
      perps,
      funding: fundingStats(address),
      headline: head,
      scopes,
      cache: d.persistence.status(),
    });
  }

  return {
    stats,
    sync,
    flush: async () => {
      for (;;) {
        const p = pending;
        await p;
        if (p === pending) return;
      }
    },
  };
}

// --- this app's instance (built on first use: IndexedDB opens only when Stats is shown) ---

let instance: AllTime | null = null;

function appInstance(): AllTime {
  if (!instance) {
    const ledger = defaultLedgerDeps();
    instance = createAllTime({
      gateway: appGateway,
      dataGet: (path) => dataGet(path),
      symbols: (e) => symbolList(e),
      persistence: new IdbHistory(),
      locks: ledger.locks,
      ledger,
    });
  }
  return instance;
}

/** All-time statistics for one wallet (the Stats panel and Portfolio's lifetime figures). */
export function allTimeStats(address: string, rebuild = false): Promise<AllTimeStats> {
  return appInstance().stats(address, rebuild);
}
