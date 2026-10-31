/**
 * Algo orders in THIS browser: the algo engine (@copy-engine algo runtime)
 * runs in a tab, and every child order is signed with the trading key this
 * browser already holds and sent from here, through the app's one signing
 * path and its fee guard (trading/actions.ts placeAlgoChildren) - so each
 * child carries the ValueDesk builder fee at exactly the rate a manual order
 * would, and nothing about an algo reaches a ValueDesk server.
 *
 * ONE TAB RUNS. Every tab of a wallet with live algos asks for the Web Lock
 * `vd-algo-run:<wallet>` - a tab that opened before there were any, as soon
 * as another tab starts one; the tab that holds it runs the algos, the others
 * wait in line (and take over when that tab closes). The running tab
 * publishes its views to IndexedDB; the others read them and send commands
 * (pause, cancel, the kill switch...) over a BroadcastChannel.
 *
 * WITHOUT WEB LOCKS (Safari before 15.4) the tabs elect the runner over the
 * BroadcastChannel instead: a tab asks whether one runs, and claims the run
 * only when none answers (two claims at once: the lower number wins); the
 * others ask again every few seconds and take over when the runner is gone.
 * With neither, no tab runs algos ('unsupported'): every tab would send every
 * child, so none does, and the Algos tab says why.
 *
 * WHILE NO TAB IS OPEN NOTHING IS WORKED. A child resting on SoDEX stays
 * there (it is an ordinary order, in your open orders); when a tab opens
 * again the runner asks SoDEX what became of every child before it goes on.
 * For algos that must keep going while the browser is closed: the ValueDesk
 * executor or a self-hosted one.
 */
import { requirePaperAlgo } from './liveAlgos';
import {
  AlgoRuntime,
  FINAL_STATUSES,
  SodexClient,
  WeightBudget,
  readBatch,
  readStops,
  regionPolicy,
  type AlgoEvent,
  type AlgoRecord,
  type AlgoSink,
  type AlgoView,
  type WebSocketLike,
} from '@copy-engine';
import { builderRateToFraction, unwrapList } from '@sodex-core';
import { activeBuilder } from '../trading/builder';
import { tradingConfig } from '../trading/config';
import { OutcomeUnknownError, readGateway } from '../trading/gateway';
import { algoAccountId, cancelAlgoChildren, placeAlgoChildren, placeAlgoStops, setLeverage } from '../trading/actions';
import { getTradingState } from '../trading/session';
import { feeNow } from '../trading/terms';
import { getLiveCopy } from '../copy/live';
import { localTerms } from '../copy/terms';
import { logger } from '../log';
import { readOracle } from './oracle';
import { PAPER_OWNER, needsRunner, noteRunnerLoaded, setLiveAlgos } from './algoBus';
import { openAlgoStore, type BrowserAlgoStore } from './algoStore';
import { noteLimitNotices } from './limitNotices';
import { holdReloadWhile } from '../lazyPage';
import { takeEngineNotice } from '../engineNotices';
import { closedBeforeBoot, keepAlive } from './tabLife';

const log = logger('algo');
const CHANNEL = 'vd-algo';

/** 'unsupported': this browser has neither Web Locks nor BroadcastChannel - one runner per wallet cannot be made sure of, so none runs. */
export type AlgoRole = 'off' | 'starting' | 'runner' | 'standby' | 'unsupported';

/** Why a tab of a browser without Web Locks or BroadcastChannel runs no algo. */
export const ALGOS_UNSUPPORTED = 'This browser cannot run algo orders in a tab safely (it lacks Web Locks): two tabs would both send every order. Update it, or run them on the ValueDesk executor.';

/** Without Web Locks: how long a tab waits for a runner to answer, and how often a standby tab asks again. */
const ELECT_WAIT_MS = 400;
const ELECT_EVERY_MS = 3_000;

type Command =
  | { op: 'add'; spec: unknown; seed?: number }
  | { op: 'pause'; id: string }
  | { op: 'resume'; id: string }
  | { op: 'cancel'; id: string }
  | { op: 'cancel-all' }
  | { op: 'update'; id: string; patch: Record<string, unknown> };

type Msg =
  | { t: 'cmd'; rid: string; owner: string; cmd: Command }
  | { t: 'res'; rid: string; ok: boolean; error?: string; id?: string }
  | { t: 'changed'; owner: string }
  // Without Web Locks: is a runner there; the runner's answer; a tab claiming the run (the lower nonce wins); the runner leaving.
  | { t: 'who'; owner: string }
  | { t: 'here'; owner: string }
  | { t: 'claim'; owner: string; nonce: number }
  | { t: 'bye'; owner: string };

type Locks = {
  request: (name: string, options: { signal?: AbortSignal }, cb: () => Promise<void>) => Promise<void>;
  query?: () => Promise<{ held?: Array<{ name?: string }> }>;
};
const lockManager = (): Locks | null => (navigator as unknown as { locks?: Locks }).locks ?? null;

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The sink of this browser: the trading key, the fee guard, the builder. */
const browserSink: AlgoSink = {
  paper: false,
  async place(_a, m, orders) {
    try {
      return readBatch(await placeAlgoChildren(m.name, orders), orders);
    } catch (e) {
      const unknown = e instanceof OutcomeUnknownError;
      return orders.map((o) => ({ clOrdID: o.clOrdID, ok: false, orderId: null, error: message(e), outcomeUnknown: unknown }));
    }
  },
  async placeStops(_a, m, stops) {
    try {
      return readStops(await placeAlgoStops(m.name, stops), stops);
    } catch (e) {
      const unknown = e instanceof OutcomeUnknownError;
      return stops.map((o) => ({ clOrdID: o.clOrdID, ok: false, orderId: null, error: message(e), outcomeUnknown: unknown }));
    }
  },
  cancel: (_a, m, ids) => cancelAlgoChildren(m.name, ids),
  async setLeverage(_a, m, leverage, margin) {
    await setLeverage(m.name, leverage, margin);
  },
};

class BrowserAlgos {
  role: AlgoRole = 'off';
  owner: string | null = null;
  views: AlgoView[] = [];
  /** While this tab runs the algos: its notes for the next start (tabLife.ts). */
  private stopAlive: (() => void) | null = null;
  persistent = true;

  private runtime: AlgoRuntime | null = null;
  private store: BrowserAlgoStore | null = null;
  private release: (() => void) | null = null;
  private generation = 0;
  private listeners = new Set<() => void>();
  private channel: BroadcastChannel | null = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(CHANNEL) : null;
  private waiting = new Map<string, { resolve: (id?: string) => void; reject: (e: Error) => void }>();
  private poll: ReturnType<typeof setInterval> | null = null;
  private publishTimer: ReturnType<typeof setTimeout> | null = null;
  private snapshot = { role: this.role, views: this.views };
  /** This tab holds the run lock (or, without Web Locks, won the election). */
  private lockHeld = false;
  /** Without Web Locks: when a runner last answered, and the claims heard while this tab claimed. */
  private runnerSeenAt = 0;
  private claims: number[] | null = null;
  private electWake: (() => void) | null = null;

  constructor() {
    if (this.channel) this.channel.onmessage = (e) => void this.onMessage(e.data as Msg);
    (this.channel as unknown as { unref?: () => void } | null)?.unref?.();
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  /** A stable snapshot for useSyncExternalStore. */
  getSnapshot = (): { role: AlgoRole; views: AlgoView[] } => this.snapshot;

  private emit(): void {
    this.snapshot = { role: this.role, views: this.views };
    setLiveAlgos(this.views.filter((v) => !FINAL_STATUSES.has(v.algo.status)).length);
    // A hold or a cut by SoDEX's position limit or open-interest cap: in the bell, once (limitNotices.ts).
    noteLimitNotices(this.views, 'in this browser');
    for (const fn of this.listeners) fn();
  }

  /** Follow the connected wallet (or the paper book, PAPER_OWNER): load its algos, and run them in one tab. */
  async follow(owner: string | null): Promise<void> {
    const next = owner ? owner.toLowerCase() : null;
    if (next === this.owner) return;
    await this.shutdown();
    this.owner = next;
    this.views = [];
    if (!next) {
      this.role = 'off';
      this.emit();
      return;
    }
    const gen = ++this.generation;
    this.store = await openAlgoStore();
    this.persistent = this.store.persistent;
    if (gen !== this.generation) return;
    const live = (await this.store.algos()).filter((a) => a.owner === next && needsRunner(a));
    if (!live.length) {
      this.role = 'off';
      await this.refreshViews();
      return;
    }
    this.acquire(next, gen);
  }

  /** Whether a tab can be sure it is the only one running this wallet's algos. */
  private canElect(): boolean {
    return lockManager() !== null || this.channel !== null;
  }

  /**
   * Run this wallet's algos in this tab once the lock is ours. The release is
   * armed HERE, not once the runner is up: a wallet change while the runner is
   * still starting (or still waiting for the lock) must give the lock back -
   * armed later, that release did not exist yet and the tab held the lock for
   * good, leaving every other request for it queued behind.
   */
  private acquire(owner: string, gen: number): void {
    const locks = lockManager();
    if (!locks && !this.channel) {
      // Nothing to elect one runner with: none runs (every tab would send every child), and the tab says so.
      this.role = 'unsupported';
      this.startPolling();
      this.emit();
      return;
    }
    this.role = 'starting';
    this.emit();
    let hold!: () => void;
    const held = new Promise<void>((r) => (hold = r));
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    this.release = () => {
      ctl?.abort();
      hold();
    };
    const run = async () => {
      if (gen !== this.generation) return;
      this.lockHeld = true;
      try {
        this.stopPolling();
        await this.startRuntime(owner);
        // A shutdown that came while it started has already released `held`.
        await held;
        await this.stopRuntime();
      } finally {
        this.lockHeld = false;
      }
    };
    if (!locks) {
      // No Web Locks: elected over the BroadcastChannel (only one tab claims a run no tab answers for).
      this.role = 'standby';
      this.startPolling();
      this.emit();
      void this.elect(owner, gen, run);
      return;
    }
    this.role = 'standby';
    this.startPolling();
    this.emit();
    void locks.request(`vd-algo-run:${owner}`, ctl ? { signal: ctl.signal } : {}, run).catch((e) => {
      if (!ctl?.signal.aborted) log.warn('algo: lock failed', { error: String(e) });
    });
  }

  private async shutdown(): Promise<void> {
    // Without Web Locks: the tabs waiting on this runner take over at once.
    if (this.runtime && this.owner && !lockManager()) this.channel?.postMessage({ t: 'bye', owner: this.owner } satisfies Msg);
    this.generation++;
    this.electWake?.();
    this.stopPolling();
    const r = this.release;
    this.release = null;
    if (r) r();
    else await this.stopRuntime();
  }

  /**
   * Without Web Locks: until this tab runs (or follows another wallet), ask
   * whether a runner is there; when none answers, claim the run - and run it
   * unless another tab answered or claimed with a lower number meanwhile.
   */
  private async elect(owner: string, gen: number, run: () => Promise<void>): Promise<void> {
    const sleep = (ms: number) =>
      new Promise<void>((r) => {
        const t = setTimeout(() => {
          this.electWake = null;
          r();
        }, ms);
        this.electWake = () => {
          clearTimeout(t);
          this.electWake = null;
          r();
        };
      });
    while (gen === this.generation && !this.runtime) {
      const asked = Date.now();
      this.channel!.postMessage({ t: 'who', owner } satisfies Msg);
      await sleep(ELECT_WAIT_MS);
      if (gen !== this.generation) return;
      if (this.runnerSeenAt < asked) {
        const nonce = Math.random();
        this.claims = [];
        this.channel!.postMessage({ t: 'claim', owner, nonce } satisfies Msg);
        await sleep(ELECT_WAIT_MS);
        const rivals = this.claims;
        this.claims = null;
        if (gen !== this.generation) return;
        if (this.runnerSeenAt < asked && !rivals.some((x) => x < nonce)) {
          await run();
          return;
        }
      }
      await sleep(ELECT_EVERY_MS);
    }
  }

  /** Whether another tab runs this wallet's algos now (a command goes to it instead of waiting to run here). */
  private async heldElsewhere(owner: string): Promise<boolean> {
    if (this.lockHeld) return false;
    const locks = lockManager();
    if (!locks) return Date.now() - this.runnerSeenAt < ELECT_EVERY_MS * 2;
    if (!locks.query) return false;
    try {
      const q = await locks.query();
      return (q.held ?? []).some((l) => l.name === `vd-algo-run:${owner}`) && !this.lockHeld;
    } catch {
      return false;
    }
  }

  private startPolling(): void {
    this.stopPolling();
    this.poll = setInterval(() => void this.refreshViews(), 3_000);
    void this.refreshViews();
  }

  private stopPolling(): void {
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
  }

  private async refreshViews(): Promise<void> {
    if (!this.store || !this.owner) return;
    if (this.runtime) {
      this.views = this.runtime.list(this.owner).map((a) => this.runtime!.view(a.id)).filter((v): v is AlgoView => !!v);
    } else {
      const saved = (await this.store.views()).filter((v) => v.algo.owner === this.owner);
      // Algos this browser ran before (no tab runs them now): their books, as last saved.
      const known = new Set(saved.map((v) => v.algo.id));
      const extra = (await this.store.algos()).filter((a) => a.owner === this.owner && !known.has(a.id)).map((a) => staticView(a));
      this.views = [...saved, ...extra];
    }
    this.views.sort((a, b) => b.algo.createdAt - a.algo.createdAt);
    this.emit();
  }

  /* ------------------------------------------------------------ runtime ----- */

  private async startRuntime(owner: string): Promise<void> {
    const cfg = tradingConfig();
    const fetchFn = (url: string, init?: RequestInit) => fetch(url, { ...init, credentials: 'omit', mode: 'cors', cache: 'no-store' });
    // Half of this IP's REST budget (the app's own reads draw on the rest); half of the limit SoDEX reports, once it does.
    const sodex = new SodexClient({ network: cfg.network, gateway: cfg.gateway, fetch: fetchFn as never, budget: new WeightBudget(600) });
    const store = this.store!;
    this.runtime = new AlgoRuntime({
      store: {
        algos: async () => (await store.algos()).filter((a) => a.owner === owner),
        saveAlgo: (a) => store.saveAlgo(a),
        addAlgoEvent: (e) => store.addAlgoEvent(e),
        algoEvents: (q) => store.algoEvents(q),
      },
      sodex,
      network: cfg.network,
      factory: (url) => new WebSocket(url) as unknown as WebSocketLike,
      sinkFor: () => browserSink,
      // Fill fast's reference: the shared oracle, through our API (algo/oracle.ts).
      oracle: async (coin, venues) => (await readOracle(coin, venues)).quotes,
      builderRate: (a) => (activeBuilder(cfg.builder) ? builderRateToFraction(feeNow('perps', a.owner)) : 0),
      // The copy region rules (policy.ts): the country declared in the copy terms and the one the executor saw, stricter wins.
      policyFor: (a) => regionPolicy(localTerms(a.owner)?.country ?? a.country ?? null, getLiveCopy().viewerCountry ?? a.observedCountry ?? null),
      // The operator's emergency brake (/api/health): live algos are held while it is on.
      brake: () => {
        const b = tradingConfig().brake;
        return b?.algos || b?.trading ? `ValueDesk paused algo orders: ${b.reason}` : null;
      },
      problem: async (a) => {
        const t = getTradingState();
        if (t.status !== 'enabled' || t.owner !== a.owner) return 'Held: enable trading in this browser - its children are signed with your trading key.';
        if (t.accountId && t.accountId !== a.accountId) return 'Held: this algo belongs to another SoDEX account than the one trading is enabled for.';
        return null;
      },
      lookup: async (a, symbol, history) => {
        const path = `/api/v1/perps/accounts/${a.owner}/orders${history ? '/history' : ''}?symbol=${encodeURIComponent(symbol)}${history ? '&limit=100' : ''}`;
        const rows = unwrapList<Record<string, unknown>>(await readGateway<unknown>(path), 'orders');
        return rows
          .filter((r) => typeof r.clOrdID === 'string')
          .map((r) => ({ clOrdID: r.clOrdID as string, orderId: String(r.orderID ?? ''), status: String(r.status ?? ''), executedQty: Number(r.executedQty ?? 0) || 0, executedValue: Number(r.executedValue ?? 0) || 0 }));
      },
      log,
      onChange: () => this.schedulePublish(),
      // Failed, stopped, held, finished: the bell, a toast for an error, the wallet's inbox (engineNotices.ts).
      onNotice: (n) => takeEngineNotice(n),
    });
    await this.runtime.start();
    // The tab that ran them was closed, not reloaded (tabLife.ts): they stop for good - their resting
    // children are cancelled, what filled keeps its exits - and the follower hears of it.
    if (closedBeforeBoot(owner)) {
      for (const a of this.runtime.list(owner)) {
        if (FINAL_STATUSES.has(a.status)) continue;
        await this.runtime.stopFor(a.id, 'Stopped: the browser tab that ran it was closed.').catch((e) => log.warn('algo: not stopped after its tab closed', { id: a.id, error: String(e) }));
      }
    }
    this.stopAlive?.();
    this.stopAlive = keepAlive(owner);
    this.role = 'runner';
    await this.refreshViews();
    this.schedulePublish();
    log.info('browser algos running', { owner, algos: this.runtime.list(owner).length });
  }

  private async stopRuntime(): Promise<void> {
    this.stopAlive?.();
    this.stopAlive = null;
    const rt = this.runtime;
    this.runtime = null;
    if (rt) await rt.stop().catch(() => {});
  }

  private schedulePublish(): void {
    if (this.publishTimer) return;
    this.publishTimer = setTimeout(() => {
      this.publishTimer = null;
      void this.publish();
    }, 400);
  }

  private async publish(): Promise<void> {
    if (!this.runtime || !this.store || !this.owner) return;
    await this.refreshViews();
    const others = (await this.store.views()).filter((v) => v.algo.owner !== this.owner);
    await this.store.putViews([...others, ...this.views]).catch(() => {});
    this.channel?.postMessage({ t: 'changed', owner: this.owner } satisfies Msg);
  }

  /* --------------------------------------------------------- commands ----- */

  private async command(cmd: Command): Promise<string | undefined> {
    if (!this.owner) throw new Error('Connect your wallet first.');
    if (this.runtime) return this.apply(cmd);
    if (this.role === 'off' && !this.canElect()) this.role = 'unsupported';
    if (this.role === 'unsupported') throw new Error(ALGOS_UNSUPPORTED);
    if (this.role === 'off') {
      // This tab follows the wallet but is in no line for its algos (it opened before there were any): it gets in
      // line now. With no other runner it runs them itself; with one (another tab started an algo since), the
      // command goes to that tab - an 'off' tab's pause, cancel and kill switch work as a standby tab's do.
      const owner = this.owner;
      this.acquire(owner, this.generation);
      const t0 = Date.now();
      while (!this.runtime && Date.now() - t0 < 8_000) {
        if (await this.heldElsewhere(owner)) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      if (this.runtime) return this.apply(cmd);
    }
    if (!this.channel) throw new Error('Algos run in another tab of this browser. Use that tab.');
    const rid = Math.random().toString(36).slice(2);
    const done = new Promise<string | undefined>((resolve, reject) => {
      this.waiting.set(rid, { resolve, reject });
      setTimeout(() => {
        if (this.waiting.delete(rid)) reject(new Error('The tab that runs your algos did not answer. Close other ValueDesk tabs and try again.'));
      }, 10_000);
    });
    this.channel.postMessage({ t: 'cmd', rid, owner: this.owner, cmd } satisfies Msg);
    return done;
  }

  private async apply(cmd: Command): Promise<string | undefined> {
    const rt = this.runtime!;
    let id: string | undefined;
    switch (cmd.op) {
      case 'add': {
        requirePaperAlgo(cmd.spec, this.owner);
        const s = requireSignerOrPaper(cmd.spec, this.owner!);
        const a = await rt.add({
          owner: this.owner!,
          accountId: s.accountId,
          mode: 'browser',
          spec: cmd.spec,
          seed: cmd.seed,
          country: localTerms(this.owner)?.country ?? null,
          observedCountry: getLiveCopy().viewerCountry,
        });
        id = a.id;
        break;
      }
      case 'pause':
        await rt.pause(cmd.id);
        break;
      case 'resume':
        await rt.resume(cmd.id);
        break;
      case 'cancel':
        await rt.cancel(cmd.id);
        break;
      case 'cancel-all':
        await rt.cancelAll(this.owner!);
        break;
      case 'update': {
        // The live gate covers a change as it covers a start: a practice run is never turned into a live one here
        // (the runtime also refuses any field but the limit, bounds, spread guard, label and size).
        const a = rt.get(cmd.id);
        if (!a) throw new Error('No such algo.');
        requirePaperAlgo({ ...a.spec, ...cmd.patch }, this.owner);
        await rt.update(cmd.id, cmd.patch);
        break;
      }
    }
    await this.publish();
    return id;
  }

  private async onMessage(m: Msg): Promise<void> {
    if (!m || typeof m !== 'object') return;
    if (m.t === 'changed' && m.owner === this.owner && !this.runtime) {
      await this.refreshViews();
      // Another tab started this wallet's first algo while this one was 'off': this tab gets in line for the run,
      // so it takes over when that tab closes (the algo is never left with no tab working it).
      if (this.role === 'off' && m.owner === this.owner && this.views.some((v) => needsRunner(v.algo))) this.acquire(m.owner, this.generation);
      return;
    }
    if (m.t === 'who' || m.t === 'claim') {
      // The runner answers for its wallet: the asking tab stays in standby.
      if (this.runtime && m.owner === this.owner) this.channel?.postMessage({ t: 'here', owner: m.owner } satisfies Msg);
      else if (m.t === 'claim' && m.owner === this.owner && this.claims) this.claims.push(m.nonce);
      return;
    }
    if (m.t === 'here') {
      if (m.owner === this.owner) this.runnerSeenAt = Date.now();
      return;
    }
    if (m.t === 'bye') {
      if (m.owner === this.owner) {
        this.runnerSeenAt = 0;
        this.electWake?.();
      }
      return;
    }
    if (m.t === 'res') {
      const w = this.waiting.get(m.rid);
      if (!w) return;
      this.waiting.delete(m.rid);
      if (m.ok) w.resolve(m.id);
      else w.reject(new Error(m.error ?? 'The command failed.'));
      return;
    }
    if (m.t === 'cmd' && this.runtime && m.owner === this.owner) {
      try {
        const id = await this.apply(m.cmd);
        this.channel?.postMessage({ t: 'res', rid: m.rid, ok: true, id } satisfies Msg);
      } catch (e) {
        this.channel?.postMessage({ t: 'res', rid: m.rid, ok: false, error: message(e) } satisfies Msg);
      }
    }
  }

  /* ------------------------------------------------------------ the API ----- */

  /** Start an algo in this browser. Returns its id. */
  start = (spec: unknown, seed?: number): Promise<string | undefined> => this.command({ op: 'add', spec, seed });
  pause = (id: string) => this.command({ op: 'pause', id });
  resume = (id: string) => this.command({ op: 'resume', id });
  cancel = (id: string) => this.command({ op: 'cancel', id });
  cancelAll = () => this.command({ op: 'cancel-all' });
  update = (id: string, patch: Record<string, unknown>) => this.command({ op: 'update', id, patch });

  async events(id: string, limit = 300): Promise<AlgoEvent[]> {
    return (await openAlgoStore()).algoEvents({ algoId: id, limit });
  }
}

/** The account a new algo trades: the trading key's (live), or the connected wallet's when it is paper. */
function requireSignerOrPaper(spec: unknown, owner: string): { accountId: number } {
  const paper = !!(spec && typeof spec === 'object' && (spec as { paper?: unknown }).paper === true);
  if (paper) return { accountId: owner === PAPER_OWNER ? 0 : (getTradingState().accountId ?? 0) };
  if (owner === PAPER_OWNER) throw new Error('Connect your wallet to run a live algo. Without one, only paper algos run.');
  return { accountId: algoAccountId(owner) };
}

/** A view of a saved algo no tab runs right now (its books as last saved). */
function staticView(a: AlgoRecord): AlgoView {
  const avg = a.filled > 0 ? a.filledValue / a.filled : null;
  return { algo: a, target: null, progress: 0, avgPrice: avg, vsArrivalBps: null, vsMarketVwapBps: null, marketVwap: null, nextAt: null, endsAt: null, working: null, triggerPrice: null, conditions: null, exits: null, legs: null };
}

export const browserAlgos = new BrowserAlgos();

// A release never reloads the tab that runs live algos (lazyPage.ts): it would stop them mid-way.
holdReloadWhile(() => {
  if (browserAlgos.role !== 'runner') return null;
  const n = browserAlgos.views.filter((v) => !FINAL_STATUSES.has(v.algo.status)).length;
  return n ? `${n} live algo${n === 1 ? '' : 's'}` : null;
});
noteRunnerLoaded();
