/**
 * The all-time history sync, pure: which scopes a wallet has, what a scope's
 * checkpoint says, and the two-phase walk that brings a scope up to date.
 *
 * Shared by the server (history.ts binds it to SQLite and the server's gateway
 * client) and the browser (its own store in IndexedDB, its own IP's budget), so
 * the rules below hold in both - they were each learned the hard way:
 *
 *  - A FAILED PAGE IS NOT THE END OF HISTORY. A throw aborts the walk, is
 *    recorded as an error, and leaves `complete = false` so the next run resumes
 *    instead of enshrining a partial number as final (historyRows.ts has the
 *    pager and its `endTime`-is-inclusive rule).
 *  - Rows land in the store after EVERY page, so a walk is resumable and a
 *    failure costs one page.
 *  - `complete` is only ever set by the backward walk reaching the start of
 *    history; a catch-up finishing is a different, narrower claim.
 *
 * The store is synchronous on purpose: the server's SQLite calls are, and the
 * browser keeps the rows in memory (mirrored to IndexedDB behind the scenes).
 */
import { walkBackwards, type NormalRow, type PageQuery } from './historyRows.js';

export type ScopeKind = 'trades-spot' | 'trades-perps' | 'funding';

export const SCOPE_KINDS: ScopeKind[] = ['trades-spot', 'trades-perps', 'funding'];

export const scopeKey = (kind: ScopeKind, address: string): string => `${kind}|${address.toLowerCase()}`;

/** What a scope's walk has established so far (the persisted checkpoint). */
export interface ScopeState {
  oldest: number | null;
  newest: number | null;
  complete: boolean;
  pages: number;
  updatedAt: number;
  lastError: string | null;
}

export const EMPTY_STATE: ScopeState = {
  oldest: null,
  newest: null,
  complete: false,
  pages: 0,
  updatedAt: 0,
  lastError: null,
};

/** Where walked rows and checkpoints live. Every call is synchronous and must not throw for a missing scope. */
export interface HistoryStore {
  readState(scope: string): ScopeState;
  writeState(scope: string, s: ScopeState): void;
  /** Insert-or-replace by row id; returns rows.length. */
  saveRows(scope: string, rows: NormalRow[]): number;
  /** Everything held for a scope, newest first. */
  loadRows(scope: string): NormalRow[];
  dropScope(scope: string): void;
  cachedCount(scope: string): number;
}

export interface SyncProgress {
  kind: ScopeKind;
  status: 'never' | 'running' | 'done' | 'error';
  /** Pages fetched in the run currently in flight (or the last one). */
  pages: number;
  /** New rows fetched in that run. */
  fetched: number;
  /** Rows in the cache for this scope. */
  cached: number;
  /** Oldest timestamp the walk has reached. */
  oldest: number | null;
  newest: number | null;
  /** True only once a walk hit the genuine end of history. */
  complete: boolean;
  /** Non-null when a walk stopped for a reason other than running out of rows. */
  truncated: string | null;
  error: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  updatedAt: number;
}

export type PageFetcher = (q: PageQuery) => Promise<NormalRow[]>;

export interface HistorySyncOptions {
  store: HistoryStore;
  /** The page reader for one scope of one wallet. */
  pageSource(kind: ScopeKind, address: string): PageFetcher;
  /** Wraps every page fetch of a walk (the pacing and pause policy). */
  paced(fetchPage: PageFetcher): PageFetcher;
  /** How long a completed sync counts as fresh before an automatic re-sync. */
  resyncAfterMs: number;
  now?: () => number;
  /**
   * Runs one scope's sync exclusively. The browser holds a Web Lock per scope
   * so two tabs never walk the same history twice; the default runs at once.
   */
  exclusive?(scope: string, run: () => Promise<void>): Promise<void>;
  /** Called with the scope held, before the freshness re-check (the browser re-reads what another tab stored). */
  beforeSync?(scope: string): Promise<void>;
}

export interface HistorySync {
  /**
   * Start a sync for one scope if one is not already running and the cache is
   * stale, incomplete, or absent. Returns immediately - the walk continues in the
   * background and the caller polls `progressOf`.
   */
  ensureSync(kind: ScopeKind, address: string, rebuild?: boolean): void;
  /** Current progress for one scope, whether or not a walk is in flight. */
  progressOf(kind: ScopeKind, address: string): SyncProgress;
  isSyncing(address: string): boolean;
  /** Everything cached for one scope, newest first. */
  rowsFor(kind: ScopeKind, address: string): NormalRow[];
  /** Test/maintenance hook: forget everything cached for an address. */
  clearAddress(address: string): void;
  /** Resolves once the scope's sync in flight (if any) has finished. */
  settled(kind: ScopeKind, address: string): Promise<void>;
}

export function createHistorySync(o: HistorySyncOptions): HistorySync {
  const { store } = o;
  const now = o.now ?? Date.now;
  const exclusive = o.exclusive ?? ((_scope: string, run: () => Promise<void>) => run());

  const running = new Map<string, SyncProgress>();
  const inFlight = new Map<string, Promise<void>>();
  /** Scopes whose sync waits for another holder (another tab) to finish. */
  const queued = new Set<string>();

  const isFresh = (s: ScopeState): boolean =>
    // A recorded error or truncation re-arms the sync even inside the freshness
    // window: an incomplete answer is exactly the thing worth retrying.
    s.complete && !s.lastError && now() - s.updatedAt <= o.resyncAfterMs;

  function progressOf(kind: ScopeKind, address: string): SyncProgress {
    const scope = scopeKey(kind, address);
    const live = running.get(scope);
    if (live) return live;
    const s = store.readState(scope);
    return {
      kind,
      status: queued.has(scope) ? 'running' : s.updatedAt === 0 ? 'never' : s.lastError ? 'error' : 'done',
      pages: s.pages,
      fetched: 0,
      cached: store.cachedCount(scope),
      oldest: s.oldest,
      newest: s.newest,
      complete: s.complete,
      truncated: null,
      error: s.lastError,
      startedAt: null,
      finishedAt: s.updatedAt || null,
      updatedAt: s.updatedAt,
    };
  }

  /**
   * Bring one scope up to date.
   *
   * Two phases, either of which may be a no-op:
   *
   *  1. CATCH UP. If we already have a `newest`, ask only for rows at or after it
   *     (`startTime` is a real lower bound upstream). On a warm cache this is
   *     normally a single page.
   *  2. EXTEND. If the backward walk has never reached the end of history, resume
   *     from the oldest row we hold and keep going.
   *
   * `complete` is only ever set by phase 2 reaching an empty page. Phase 1
   * completing means "complete down to startTime", which is a different claim and
   * must not be allowed to mark the whole history as walked.
   */
  async function syncScope(kind: ScopeKind, address: string, rebuild: boolean): Promise<void> {
    const scope = scopeKey(kind, address);
    if (rebuild) store.dropScope(scope);

    const prior = store.readState(scope);
    const prog: SyncProgress = {
      kind,
      status: 'running',
      pages: 0,
      fetched: 0,
      cached: store.cachedCount(scope),
      oldest: prior.oldest,
      newest: prior.newest,
      complete: prior.complete,
      truncated: null,
      error: null,
      startedAt: now(),
      finishedAt: null,
      updatedAt: now(),
    };
    running.set(scope, prog);

    const fetchPage = o.paced(o.pageSource(kind, address));

    let oldest = prior.oldest;
    let newest = prior.newest;
    let complete = prior.complete;
    let pages = 0;
    let error: string | null = null;
    let truncated: string | null = null;

    /**
     * Persist after EVERY page, not at the end of the phase.
     *
     * A full walk is minutes long, and page ~8% of the time comes back as an error
     * envelope that survives its retries. If the rows only landed when the phase
     * returned, a failure on the fortieth page would discard the thirty-nine
     * before it AND leave `oldest` where it started - so the retry would re-fetch
     * the same history, hit the same odds, and could realistically never finish.
     * Saving per page makes the walk genuinely resumable: progress is monotonic,
     * and a failure costs one page.
     */
    const savePage = (p: { pages: number; rows: number; fresh: NormalRow[] }) => {
      prog.pages += 1;
      prog.fetched = p.rows;
      prog.updatedAt = now();
      store.saveRows(scope, p.fresh);
    };

    const checkpoint = (lastError: string | null = null) => {
      prog.oldest = oldest;
      prog.newest = newest;
      store.writeState(scope, { oldest, newest, complete, pages: prog.pages, updatedAt: now(), lastError });
    };

    /**
     * Phase 2's checkpoint. Safe to advance the covered window on every page
     * BECAUSE phase 2 descends contiguously: at any moment everything between the
     * current `oldest` and the top has been fetched, so the recorded window is
     * always a true statement about what is on disk.
     *
     * `complete` is carried through untouched - a checkpoint must never upgrade the
     * completeness claim, nor undo one the phase already earned.
     */
    const onExtendPage = (p: { pages: number; rows: number; oldest: number | null; fresh: NormalRow[] }) => {
      savePage(p);
      for (const r of p.fresh) {
        if (!Number.isFinite(r.time)) continue;
        if (oldest === null || r.time < oldest) oldest = r.time;
        if (newest === null || r.time > newest) newest = r.time;
      }
      checkpoint();
    };

    try {
      if (newest !== null) {
        /*
         * Phase 1 saves its rows per page but does NOT move `newest` until the
         * phase finishes.
         *
         * It descends from now down to the floor, so a failure halfway leaves a
         * HOLE between the old `newest` and where it got to. Advancing `newest`
         * mid-phase would record that hole as covered, and the next catch-up would
         * start above it - the gap would never be filled and the totals would be
         * quietly short by exactly those fills. Leaving `newest` alone costs a
         * repeat of a page or two and is always correct; the rows already written
         * are simply deduped on the retry.
         *
         * `startTime` keeps the pages small; `floorTime` is what ends the phase.
         */
        const r = await walkBackwards(fetchPage, { startTime: newest, floorTime: newest, onPage: savePage });
        pages += r.pages;
        prog.fetched = 0; // phase 2 restarts the per-run row counter
        if (r.newest !== null) newest = Math.max(newest, r.newest);
        if (r.truncated) truncated = r.truncated;
        checkpoint();
      }

      if (!complete) {
        const r = await walkBackwards(fetchPage, {
          // Resume from the oldest row already held. `endTime` is inclusive, so the
          // boundary row comes back and is deduped rather than skipped.
          endTime: oldest ?? undefined,
          onPage: onExtendPage,
        });
        pages += r.pages;
        complete = r.complete;
        if (r.truncated) truncated = r.truncated;
      }
    } catch (e) {
      // Every page fetched before the failure is already stored (see savePage),
      // and `complete` stays false - so the next run resumes from the checkpointed
      // `oldest` rather than publishing this partial walk as an all-time total.
      error = (e as Error).message;
    }

    // `complete` is the narrow claim "the backward walk reached the beginning of
    // history" and nothing else. A truncation is recorded separately so it shows
    // up in the UI and re-arms the next sync, but it does not get to rewrite a
    // completeness that phase 2 legitimately established.
    store.writeState(scope, {
      oldest,
      newest,
      complete,
      pages,
      updatedAt: now(),
      lastError: error ?? truncated,
    });

    prog.status = error ? 'error' : 'done';
    prog.pages = pages;
    prog.cached = store.cachedCount(scope);
    prog.oldest = oldest;
    prog.newest = newest;
    prog.complete = complete;
    prog.truncated = truncated;
    prog.error = error;
    prog.finishedAt = now();
    prog.updatedAt = now();
    running.delete(scope);
  }

  function ensureSync(kind: ScopeKind, address: string, rebuild = false): void {
    const scope = scopeKey(kind, address);
    if (inFlight.has(scope)) return;
    if (!rebuild && isFresh(store.readState(scope))) return;

    // Reads as running from here on, also while it waits for another holder:
    // a poller that saw "not running" in between would stop polling.
    queued.add(scope);
    const p = exclusive(scope, async () => {
      if (o.beforeSync) await o.beforeSync(scope);
      // Whoever held the scope before may have just brought it up to date.
      if (!rebuild && isFresh(store.readState(scope))) return;
      queued.delete(scope);
      await syncScope(kind, address, rebuild); // marks the scope running before its first await
    })
      .catch((e) => {
        // syncScope handles its own errors; this is the belt-and-braces path so an
        // unexpected throw can never leave the scope permanently "in flight".
        const prog = running.get(scope);
        if (prog) {
          prog.status = 'error';
          prog.error = (e as Error).message;
          running.delete(scope);
        }
      })
      .finally(() => {
        queued.delete(scope);
        inFlight.delete(scope);
      });
    inFlight.set(scope, p);
  }

  return {
    ensureSync,
    progressOf,
    isSyncing: (address) => SCOPE_KINDS.some((k) => inFlight.has(scopeKey(k, address))),
    rowsFor: (kind, address) => store.loadRows(scopeKey(kind, address)),
    clearAddress(address) {
      for (const kind of SCOPE_KINDS) store.dropScope(scopeKey(kind, address));
    },
    settled: async (kind, address) => {
      await inFlight.get(scopeKey(kind, address));
    },
  };
}

/**
 * A HistoryStore in memory: the browser's working copy (mirrored to IndexedDB
 * through `onChange`) and the tests' store. Rows are keyed by id, so a page's
 * boundary rows are deduped exactly as the server's primary key dedupes them.
 */
export type StoreChange =
  | { type: 'state'; scope: string; state: ScopeState }
  | { type: 'rows'; scope: string; rows: NormalRow[] }
  | { type: 'drop'; scope: string };

export class MemoryHistoryStore implements HistoryStore {
  private readonly scopes = new Map<string, { state: ScopeState; rows: Map<string, NormalRow> }>();
  /** Per scope, bumped whenever its rows change - lets a reader cache what it derived from them. */
  private readonly versions = new Map<string, number>();

  constructor(private readonly onChange?: (c: StoreChange) => void) {}

  private bump(scope: string): void {
    this.versions.set(scope, (this.versions.get(scope) ?? 0) + 1);
  }

  private scope(scope: string): { state: ScopeState; rows: Map<string, NormalRow> } {
    let s = this.scopes.get(scope);
    if (!s) this.scopes.set(scope, (s = { state: { ...EMPTY_STATE }, rows: new Map() }));
    return s;
  }

  readState(scope: string): ScopeState {
    const s = this.scopes.get(scope);
    return s ? { ...s.state } : { ...EMPTY_STATE };
  }

  writeState(scope: string, state: ScopeState): void {
    this.scope(scope).state = { ...state };
    this.onChange?.({ type: 'state', scope, state: { ...state } });
  }

  saveRows(scope: string, rows: NormalRow[]): number {
    if (rows.length === 0) return 0;
    const s = this.scope(scope);
    // Same id, same bytes (the id is a hash of the whole row): only new ids change anything.
    const added = rows.filter((r) => !s.rows.has(r.id));
    for (const r of added) s.rows.set(r.id, r);
    if (added.length) {
      this.bump(scope);
      this.onChange?.({ type: 'rows', scope, rows: added });
    }
    return rows.length;
  }

  loadRows(scope: string): NormalRow[] {
    const s = this.scopes.get(scope);
    if (!s) return [];
    return [...s.rows.values()].sort((a, b) => (b.time || 0) - (a.time || 0));
  }

  dropScope(scope: string): void {
    this.scopes.delete(scope);
    this.bump(scope);
    this.onChange?.({ type: 'drop', scope });
  }

  cachedCount(scope: string): number {
    return this.scopes.get(scope)?.rows.size ?? 0;
  }

  /** The change counter of a scope's rows. */
  versionOf(scope: string): number {
    return this.versions.get(scope) ?? 0;
  }

  /** Replace a scope with what was persisted (reported to no one: it came from the persistence). */
  load(scope: string, state: ScopeState | null, rows: Iterable<NormalRow>): void {
    const map = new Map<string, NormalRow>();
    for (const r of rows) map.set(r.id, r);
    this.scopes.set(scope, { state: state ? { ...state } : { ...EMPTY_STATE }, rows: map });
    this.bump(scope);
  }

  /** Forget a scope in memory only; whatever was persisted stays. */
  unload(scope: string): void {
    if (this.scopes.delete(scope)) this.bump(scope);
  }
}
