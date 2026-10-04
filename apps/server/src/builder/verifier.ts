/**
 * The verifier: reads what a wallet paid from SoDEX and counts it
 * (docs/BUILDER-TIERS.md §6). The only thing a request can do to it is leave a
 * hint; everything it counts it has read itself.
 *
 * THREE LANES, each with a budget of its own, each asleep when it has nothing
 * to do:
 *
 *   approvals  A hint for a wallet the ledger does not know costs one cheap
 *              public read: has it approved our builder? No -> the hint is
 *              dropped and the wallet is not asked about again for a while.
 *              Yes -> the wallet gets a row and a place in the queue.
 *
 *   history    One page of the wallet's fills (`/trades`) per step, perps
 *              first, then spot. This is the scarce one: SoDEX counts `/trades`
 *              and `/orders/history` of both engines together, about 4 per
 *              60 s per IP, and a 1015 blocks the whole IP's history reads -
 *              the owner's browser included. So: never above 2 a minute, 1 by
 *              default, evenly spaced; the time of the last request is kept on
 *              disk, so restarts cannot add up to a burst; a rate-limit answer
 *              stops the lane for minutes, doubling. Steps of different
 *              wallets take turns, so one wallet with a long history cannot
 *              hold the others up.
 *
 *   explorer   One order's signed request per step from SoDEX's public
 *              explorer: whose builder the order names, at which fee, and who
 *              signed it (counting.ts, explorer.ts). The explorer publishes no
 *              limits: a few a minute at most, and ANY answer that is not a
 *              200 stops the lane, for longer each time.
 *
 * NOTHING ABOUT A WALLET IS KEPT IN MEMORY between two steps but its place in
 * the queue. Each step reads the wallet's rows and writes only if the row is
 * still the one it read, so `tools/builderTiers.ts forget` can remove a wallet
 * while the server runs and it stays removed.
 *
 * Every queue is bounded, and a full one drops the newest hint: the app leaves
 * another one after the next fill.
 */
import { weightFor, unwrapList } from '../sodex/restCore.js';
import { KeyedLimiter, type Limit } from '../rateLimit.js';
import { ENGINES, defaultFee, type Engine, type LogLike, type TiersConfig } from './config.js';
import { OrderState, applyFills, dayOf, defaultsOf, feeOwedAt, judgeOrder, readFill, type FeeRow, type Fill, type OrderRow } from './counting.js';
import { explorerPath, orderFacts, readExplorerTx } from './explorer.js';
import type { BuilderStore, Evidence, WalletRow } from './store.js';

// --- budgets and bounds ---------------------------------------------------------------

/** History requests per minute: the default, and the most any setting can ask for (the safe rate of the pair). */
export const VERIFY_PER_MIN_DEFAULT = 1;
export const VERIFY_PER_MIN_MAX = 2;
export const APPROVALS_PER_MIN_DEFAULT = 10;
export const APPROVALS_PER_MIN_MAX = 30;
export const EXPLORER_PER_MIN_DEFAULT = 3;
export const EXPLORER_PER_MIN_MAX = 6;

/** A little more than the window, as the browser's drip counts it: what is sent is never closer than this. */
const WINDOW_MS = 60_500;

/** `/trades` returns at most this many rows. Weight 20 + 1 per 20 rows. */
export const PAGE = 1000;
/** A sweep that needs more pages than this stops there; what lies deeper is not read. */
export const MAX_SWEEP_PAGES = 20;
/** Fills this close to the newest one read are read again next time (and told apart by id): history may lag. */
export const OVERLAP_MS = 120_000;
/** `GET /user/{address}/builders` is not on SoDEX's weight list, so it costs the default. */
const APPROVAL_WEIGHT = 20;

/** Wallets waiting for a verification, and for the approval read. */
export const MAX_JOBS = 500;
export const MAX_APPROVALS = 200;
/** Wallets the ledger takes on at most. */
export const MAX_WALLETS = 250_000;
/** Addresses remembered as "not approved". */
const MAX_DENIED = 5_000;
/** A wallet that had not approved is not asked about again for this long; after a failed read, sooner. */
const DENIED_MS = 60_000;
const DENIED_ERROR_MS = 30_000;
/** Hints for wallets the ledger does not know, per client: one client cannot fill the approval queue. */
const UNKNOWN_HINTS_PER_CLIENT: Limit = { max: 6, windowMs: 60_000 };

/** A wallet is verified at most this often; twice as long after each verification that found nothing new. */
export const VERIFY_EVERY_MS = 60_000;
export const VERIFY_EVERY_MAX_MS = 30 * 60_000;

/** After a rate-limit answer on the history lane: this long, doubling, at most the second. Reset by a success. */
const LIMITED_PAUSE_MS = 5 * 60_000;
const LIMITED_PAUSE_MAX_MS = 30 * 60_000;
/** The shared client replays a failed page up to three times; the lane rests as if all were sent. */
const FAILED_REST_FACTOR = 4;
/** A wallet whose step failed this often in a row is left for the next hint. */
const MAX_STEP_FAILURES = 3;

/** After a failed explorer request: this long, doubling, at most the second. */
const EXPLORER_PAUSE_MS = 10 * 60_000;
const EXPLORER_PAUSE_MAX_MS = 6 * 60 * 60_000;
/**
 * An order the explorer does not know (yet) is asked for again after these waits, then given up. The explorer
 * lists a new order a few minutes late: dense at first, so a fee tier follows within minutes (live 2026-10-04:
 * listed between 2.5 and 10 minutes, the next look came at 10 - six seconds after the live run stopped waiting).
 */
const NOT_FOUND_RETRY_MS = [30_000, 60_000, 90_000, 120_000, 180_000, 300_000, 600_000];
/** Rows wait for a retry and nothing else is due: look again after this. */
const EXPLORER_POLL_MS = 30_000;

/** Builder-less orders per page put up for a look at who signed them. */
const CHECKS_PER_PAGE = 2;
/** A wallet's order rows: kept this long after their last fill, and at most this many. */
const ORDER_RETAIN_MS = 30 * 86_400_000;
const MAX_ORDER_ROWS = 2_000;

/** The gateway budget this process shares (1200 weight a minute): the verifier waits while most of it is in use. */
const WEIGHT_BUSY = 800;

/** Names our app registers its trading key under (apps/web/src/trading/session.ts tradingKeyName). */
export const APP_KEY_NAME = /^valuescan-/;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** `VALUESCAN_BUILDER_VERIFY_PER_MIN` and friends: a positive number within the lane's bounds, else the default. */
export function perMinFrom(raw: string | undefined, dflt: number, max: number): number {
  const n = Number((raw ?? '').trim());
  return Number.isFinite(n) && n > 0 ? clamp(n, 0.05, max) : dflt;
}

// --- what the verifier needs from outside ---------------------------------------------------

export class ExplorerError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'ExplorerError';
  }
}

export interface VerifierIo {
  /** One GET on SoDEX's gateway through the shared client: its weight budget, its cooldown. */
  get(path: string, weight?: number): Promise<unknown>;
  /** One GET on the explorer: the JSON body of a 200. Anything else throws. */
  explorer(path: string): Promise<unknown>;
  /** ms SoDEX's rate limit is still cooling down for (0 = not limited). */
  cooldownMs(path: string): number;
  /** Gateway weight this process spent in the last minute. */
  weightSpent(): number;
}

export interface VerifierOptions {
  store: BuilderStore;
  /** The configuration in force (null = the feature is off). */
  config: () => TiersConfig | null;
  io: VerifierIo;
  /** SoDEX's chain id: part of what an order's key signed. */
  chainId: number;
  log: LogLike;
  now?: () => number;
  verifyPerMin?: number;
  approvalsPerMin?: number;
  /** 0 switches the explorer lane off: nothing is counted then. */
  explorerPerMin?: number;
  /** How far before a wallet's first verification its fills are read. */
  lookbackMs?: number;
  /** Called when a wallet's counted volume or flags changed: its fee may have. */
  onChange?: (address: string) => void;
}

/**
 * A wallet's place in the queue - and nothing else. How far its pass has come
 * is read from the ledger at every step (an engine swept since the hint is
 * done), so a restart, or the wallet being forgotten, needs no clean-up here.
 */
interface Job {
  address: string;
  builder: number;
  /** The wallet row this job was made for (`created_at`). */
  gen: number;
  due: number;
  /** Verifications in a row that found nothing: productive wallets go first. */
  level: number;
  failures: number;
}

const isRateLimit = (err: unknown): boolean => {
  const e = err as { httpStatus?: number; code?: number; status?: number; message?: string } | null;
  return e?.httpStatus === 429 || e?.status === 429 || e?.code === 429 || /\b1015\b|too many requests|rate.?limit/i.test(String(e?.message ?? ''));
};

/** The wallet's approval of `builderId`, from `GET /user/{address}/builders`: its account id when it has one. */
export function readApproval(data: unknown, builderId: number): { approved: boolean; accountId: number | null } {
  let approved = false;
  let accountId: number | null = null;
  if (data && typeof data === 'object') {
    for (const engine of ENGINES) {
      const rows = (data as Record<string, unknown>)[engine];
      if (!Array.isArray(rows)) continue;
      for (const row of rows) {
        if (!row || typeof row !== 'object') continue;
        const r = row as Record<string, unknown>;
        if (String(r.builderID) !== String(builderId)) continue;
        const rate = typeof r.feeRate === 'number' ? r.feeRate : typeof r.feeRate === 'string' && /^\d+$/.test(r.feeRate) ? Number(r.feeRate) : 0;
        if (!(rate > 0)) continue;
        approved = true;
        const id = typeof r.userID === 'number' ? r.userID : typeof r.userID === 'string' && /^\d+$/.test(r.userID) ? Number(r.userID) : NaN;
        if (Number.isSafeInteger(id) && id > 0) accountId = id;
      }
    }
  }
  return { approved, accountId };
}

/** The keys our app registered, from `GET /{engine}/accounts/{address}/api-keys`. The user's other keys are not kept. */
export function readAppKeys(data: unknown): Array<{ name: string; key: string }> {
  const out: Array<{ name: string; key: string }> = [];
  for (const row of unwrapList<Record<string, unknown>>(data, 'keys')) {
    const name = typeof row?.name === 'string' ? row.name : '';
    const key = typeof row?.publicKey === 'string' ? row.publicKey : '';
    if (APP_KEY_NAME.test(name) && name.length <= 36 && /^0x[0-9a-fA-F]{40}$/.test(key)) out.push({ name, key: key.toLowerCase() });
  }
  return out;
}

export class Verifier {
  private readonly store: BuilderStore;
  private readonly io: VerifierIo;
  private readonly log: LogLike;
  private readonly now: () => number;
  private readonly historyGap: number;
  private readonly approvalGap: number;
  private readonly explorerGap: number;
  private readonly lookbackMs: number;

  private jobs = new Map<string, Job>();
  /** Wallets waiting for the approval read, oldest first. */
  private approvals = new Map<string, number>();
  /** Address -> until when it is not asked about again. */
  private denied = new Map<string, number>();
  private hints = new KeyedLimiter(10_000);
  private wallets: number;

  private historyAt = 0;
  private historyPause = 0;
  private limitedStreak = 0;
  private approvalAt = 0;
  private explorerAt = 0;
  private explorerPause = 0;
  private explorerStreak = 0;
  private explorerPoll = 0;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private busy = false;
  private again = false;
  private stopped = true;

  /** Requests sent, by lane (tests and the status line). */
  readonly sent = { approvals: 0, history: 0, keys: 0, explorer: 0 };

  constructor(private readonly o: VerifierOptions) {
    this.store = o.store;
    this.io = o.io;
    this.log = o.log;
    this.now = o.now ?? Date.now;
    this.historyGap = Math.ceil(WINDOW_MS / clamp(o.verifyPerMin ?? VERIFY_PER_MIN_DEFAULT, 0.05, VERIFY_PER_MIN_MAX));
    this.approvalGap = Math.ceil(WINDOW_MS / clamp(o.approvalsPerMin ?? APPROVALS_PER_MIN_DEFAULT, 0.05, APPROVALS_PER_MIN_MAX));
    const ex = o.explorerPerMin ?? EXPLORER_PER_MIN_DEFAULT;
    this.explorerGap = ex > 0 ? Math.ceil(WINDOW_MS / clamp(ex, 0.05, EXPLORER_PER_MIN_MAX)) : Number.POSITIVE_INFINITY;
    this.lookbackMs = Math.max(0, o.lookbackMs ?? 7 * 86_400_000);
    this.wallets = this.store.walletCount();
    // What the last process knew: restarts must not add up to a burst, nor forget a pause.
    this.historyAt = Number(this.store.getMeta('history_at')) || 0;
    this.historyPause = Number(this.store.getMeta('history_pause')) || 0;
    this.limitedStreak = Number(this.store.getMeta('history_streak')) || 0;
    this.explorerPause = Number(this.store.getMeta('explorer_pause')) || 0;
    this.explorerStreak = Number(this.store.getMeta('explorer_streak')) || 0;
  }

  // --- hints ------------------------------------------------------------------------

  /** Is a verification of this wallet queued, running or waiting for its approval read? */
  pending(address: string): boolean {
    return this.jobs.has(address) || this.approvals.has(address);
  }

  get queues(): { jobs: number; approvals: number; denied: number } {
    return { jobs: this.jobs.size, approvals: this.approvals.size, denied: this.denied.size };
  }

  /**
   * A request left a hint for `address`. Costs nothing by itself: a wallet the
   * ledger knows gets a place in the queue (once per interval), an unknown one
   * waits for the approval read - unless the queue is full or this client has
   * named too many unknown wallets.
   */
  hint(address: string, client: string): void {
    const cfg = this.o.config();
    if (!cfg || this.jobs.has(address) || this.approvals.has(address)) return;
    const now = this.now();
    const w = this.store.wallet(cfg.builderId, address);
    if (w) {
      this.enqueue(w, now);
      return;
    }
    const until = this.denied.get(address);
    if (until !== undefined) {
      if (now < until) return;
      this.denied.delete(address);
    }
    if (this.approvals.size >= MAX_APPROVALS) return;
    if (this.hints.take(`hint|${client}`, UNKNOWN_HINTS_PER_CLIENT, now) !== null) return;
    this.approvals.set(address, now);
    this.kick();
  }

  private interval(idleRuns: number): number {
    return Math.min(VERIFY_EVERY_MAX_MS, VERIFY_EVERY_MS * 2 ** Math.min(idleRuns, 10));
  }

  private enqueue(w: WalletRow, now: number): boolean {
    if (this.jobs.size >= MAX_JOBS) return false;
    const due = Math.max(now, w.verifiedAt ? w.verifiedAt + this.interval(w.idleRuns) : 0);
    this.jobs.set(w.address, { address: w.address, builder: w.builder, gen: w.createdAt, due, level: w.idleRuns, failures: 0 });
    // On disk too, so a restart does not lose the hint.
    if (w.dueAt === 0) this.guard(() => this.store.setDue(w.builder, w.address, w.createdAt, due));
    this.kick();
    return true;
  }

  private deny(address: string, ms: number, now: number): void {
    if (this.denied.size >= MAX_DENIED) {
      const oldest = this.denied.keys().next().value;
      if (oldest !== undefined) this.denied.delete(oldest);
    }
    this.denied.set(address, now + ms);
  }

  /** A write that failed (the tool holds the lock, the disk is full) is logged, never thrown into a request. */
  private guard<T>(fn: () => T): T | undefined {
    try {
      return fn();
    } catch (e) {
      this.log.warn({ err: e instanceof Error ? e.message : String(e) }, 'builder verifier: a write to builder.db failed');
      return undefined;
    }
  }

  // --- the loop ----------------------------------------------------------------------

  /** Take up the hints that were waiting when the last process stopped. */
  resume(): void {
    const cfg = this.o.config();
    if (!cfg) return;
    const now = this.now();
    for (const w of this.store.dueWallets(cfg.builderId, MAX_JOBS)) {
      if (!this.jobs.has(w.address)) this.jobs.set(w.address, { address: w.address, builder: w.builder, gen: w.createdAt, due: Math.max(now, w.dueAt), level: w.idleRuns, failures: 0 });
    }
  }

  /** Run by itself, on timers. Without this call nothing happens until `runOnce` is called by hand. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.resume();
    this.kick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Something may be due: look now. */
  kick(): void {
    if (this.stopped) return;
    if (this.busy) {
      this.again = true;
      return;
    }
    this.schedule(0);
  }

  private schedule(ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.pump();
    }, Math.min(ms, 0x7fffffff));
    (this.timer as { unref?: () => void }).unref?.();
  }

  private async pump(): Promise<void> {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      for (;;) {
        this.again = false;
        let wait: number | null;
        try {
          wait = await this.runOnce();
        } catch (e) {
          this.log.error({ err: e instanceof Error ? e.message : String(e) }, 'builder verifier: a step failed unexpectedly');
          wait = 60_000;
        }
        if (this.stopped) return;
        if (this.again || wait === 0) continue;
        if (wait !== null) this.schedule(wait);
        return; // nothing queued: asleep until the next hint
      }
    } finally {
      this.busy = false;
    }
  }

  /**
   * Do what is due now - at most one request per lane - and say how long until
   * the next thing is (ms), or null when nothing is queued at all.
   */
  async runOnce(): Promise<number | null> {
    const cfg = this.o.config();
    if (!cfg) {
      this.jobs.clear();
      this.approvals.clear();
      return null;
    }
    const waits: number[] = [];

    if (this.approvals.size) {
      const ready = Math.max(this.approvalAt, this.gate('/api/v1/user/{a}/builders'));
      if (this.now() >= ready) await this.approvalStep(cfg);
      if (this.approvals.size) waits.push(Math.max(this.approvalAt, this.gate('/api/v1/user/{a}/builders')) - this.now());
    }

    const job = this.nextJob();
    if (job) {
      const ready = Math.max(job.due, this.historyReady());
      if (this.now() >= ready) await this.historyStep(cfg, job);
      const next = this.nextJob();
      if (next) waits.push(Math.max(next.due, this.historyReady()) - this.now());
    }

    if (Number.isFinite(this.explorerGap) && this.store.hasLookups(cfg.builderId)) {
      const ready = Math.max(this.explorerAt, this.explorerPause, this.explorerPoll);
      if (this.now() >= ready) await this.explorerStep(cfg);
      if (this.store.hasLookups(cfg.builderId)) waits.push(Math.max(this.explorerAt, this.explorerPause, this.explorerPoll) - this.now());
    }

    return waits.length ? Math.max(0, Math.min(...waits)) : null;
  }

  /** How long the shared SoDEX client wants requests held back: its cooldown, or its budget mostly in use. */
  private gate(path: string): number {
    const cool = this.io.cooldownMs(path);
    const now = this.now();
    if (cool > 0) return now + cool + 250;
    return this.io.weightSpent() > WEIGHT_BUSY ? now + 5_000 : 0;
  }

  private historyReady(): number {
    return Math.max(this.historyAt, this.historyPause, this.gate('/api/v1/perps/accounts/{a}/trades'));
  }

  /** The job to serve next: wallets whose last verifications found something first, then the one due longest. */
  private nextJob(): Job | null {
    let best: Job | null = null;
    const now = this.now();
    for (const j of this.jobs.values()) {
      if (!best) {
        best = j;
        continue;
      }
      const jDue = j.due <= now;
      const bDue = best.due <= now;
      if (jDue !== bDue) {
        if (jDue) best = j;
      } else if (jDue ? j.level < best.level || (j.level === best.level && j.due < best.due) : j.due < best.due) best = j;
    }
    return best;
  }

  // --- approvals -----------------------------------------------------------------------

  private async approvalStep(cfg: TiersConfig): Promise<void> {
    const address = this.approvals.keys().next().value as string;
    this.approvals.delete(address);
    this.approvalAt = this.now() + this.approvalGap;
    this.sent.approvals += 1;
    let data: unknown;
    try {
      data = await this.io.get(`/api/v1/user/${address}/builders`, APPROVAL_WEIGHT);
    } catch (e) {
      // Not a "no": the wallet may be asked about again soon. A rate limit holds the lane (gate) by itself.
      this.deny(address, DENIED_ERROR_MS, this.now());
      this.log.warn({ err: e instanceof Error ? e.message : String(e) }, 'builder verifier: the approval read failed');
      return;
    }
    const now = this.now();
    const { approved, accountId } = readApproval(data, cfg.builderId);
    if (!approved || accountId === null) {
      this.deny(address, DENIED_MS, now);
      return;
    }
    if (this.wallets >= MAX_WALLETS) {
      this.deny(address, DENIED_MS, now);
      this.log.error({ wallets: this.wallets }, 'builder verifier: the ledger is full - no new wallet is taken on');
      return;
    }
    // A new wallet is read back as far as the volume window reaches (a 14-day window: 14 days), at least the lookback.
    const back = Math.max(this.lookbackMs, (cfg.volumeDays ?? 0) * 86_400_000);
    const w = this.guard(() => this.store.createWallet(cfg.builderId, address, accountId, now, now - back));
    if (!w) return;
    if (w.createdAt === now) this.wallets += 1;
    this.enqueue(w, now);
  }

  // --- history ---------------------------------------------------------------------------

  private drop(job: Job, clearDue: boolean): void {
    this.jobs.delete(job.address);
    if (clearDue) this.guard(() => this.store.setDue(job.builder, job.address, job.gen, 0));
  }

  private async historyStep(cfg: TiersConfig, job: Job): Promise<void> {
    const { address } = job;
    const builder = cfg.builderId;
    const w = this.store.wallet(builder, address);
    // Forgotten, replaced, or the configuration names another builder now: the job is stale.
    if (!w || w.createdAt !== job.gen || job.builder !== builder) {
      this.jobs.delete(address);
      return;
    }
    // The pass began with the hint: an engine swept since then is done. An engine whose default fee is 0
    // is never read: the app attaches no builder there, so there is nothing to count.
    const since = w.dueAt > 0 ? w.dueAt : job.due;
    const dflt = defaultFee(cfg);
    const todo = ENGINES.filter((e) => dflt[e] > 0 && this.store.engine(builder, address, e).sweptAt < since);
    const engine = todo[0];
    if (!engine) {
      this.finish(job);
      return;
    }
    const held = this.store.engine(builder, address, engine);

    try {
      let from = held.swFrom;
      if (from === 0) {
        // A new sweep: from a little before the newest fill read, or from the wallet's floor.
        from = held.hi ? Math.max(w.floor, held.hi - OVERLAP_MS) : w.floor;
        await this.readKeys(address, engine);
      }
      const end = held.swFrom === 0 ? 0 : held.swEnd;
      const path = `/api/v1/${engine}/accounts/${address}/trades?limit=${PAGE}&startTime=${from}${end ? `&endTime=${end}` : ''}`;
      this.sent.history += 1;
      this.historyAt = this.now() + this.historyGap;
      this.guard(() => this.store.setMeta('history_at', String(this.historyAt)));
      const raw = unwrapList<unknown>(await this.io.get(path, weightFor(path, PAGE)), 'trades');
      if (this.limitedStreak) {
        this.limitedStreak = 0;
        this.guard(() => this.store.setMeta('history_streak', '0'));
      }

      const fills: Fill[] = [];
      for (const r of raw) {
        const f = readFill(r, engine);
        if (f) fills.push(f);
      }
      let top = held.swFrom === 0 ? 0 : held.swTop;
      let low = Number.POSITIVE_INFINITY;
      for (const f of fills) {
        if (f.time > top) top = f.time;
        if (f.time < low) low = f.time;
      }
      const pages = (held.swFrom === 0 ? 0 : held.swPages) + 1;
      const full = raw.length >= PAGE && fills.length > 0;
      const capped = full && pages >= MAX_SWEEP_PAGES;
      const done = !full || capped;

      // A full page ends somewhere inside a millisecond: that millisecond comes back whole on the next page.
      let use = fills;
      let nextEnd = 0;
      if (full && !capped) {
        const oneInstant = fills.every((f) => f.time === low);
        if (oneInstant) nextEnd = low - 1;
        else {
          use = fills.filter((f) => f.time > low);
          nextEnd = low;
        }
      }
      // What the sweep before this one already added up: the overlap is read twice on purpose.
      use = use.filter((f) => !(f.time <= held.hi && this.store.fillSeen(builder, address, engine, f.key)));

      const history = this.store.feeHistory(builder, address);
      const defaults = this.defaults(cfg);
      const appKeys = this.store.keysOf(address).size > 0;
      const result = applyFills({
        fills: use,
        row: (key) => this.store.order(builder, address, engine, key),
        owedAt: (t) => feeOwedAt(history, defaults, engine, t),
        checks: appKeys && Number.isFinite(this.explorerGap) ? CHECKS_PER_PAGE : 0,
      });

      const hi = Math.max(held.hi, top);
      const kept = new Set(result.rows.map((r) => r.key));
      const ok = this.store.commitFills({
        builder, address, gen: job.gen, engine,
        addMicro: result.addMicro,
        byDay: result.byDay,
        rows: result.rows,
        queued: result.queued,
        noBuilder: result.noBuilder,
        fills: use.filter((f) => kept.has(f.orderKey) && f.time >= hi - OVERLAP_MS).map((f) => ({ key: f.key, t: f.time })),
        found: result.addMicro > 0 || result.queued > 0 || result.noBuilder.n > 0,
        state: done
          ? { hi, swFrom: 0, swEnd: 0, swTop: 0, swPages: 0, sweptAt: this.now() }
          : { hi: held.hi, swFrom: from, swEnd: nextEnd, swTop: top, swPages: pages, sweptAt: held.sweptAt },
        pruneFillsBefore: done ? hi - OVERLAP_MS : null,
      });
      if (!ok) {
        this.jobs.delete(address);
        return;
      }
      job.failures = 0;
      if (result.addMicro > 0 || result.noBuilder.n > 0) this.o.onChange?.(address);
      if (capped) this.log.warn({ engine, pages }, 'builder verifier: a wallet has more fills than one sweep reads - the older ones were left out');
      if (done && todo.length === 1) this.finish(job);
    } catch (e) {
      const now = this.now();
      const msg = e instanceof Error ? e.message : String(e);
      if (isRateLimit(e)) {
        // Stop. Every request into a rate limit keeps it up - for the whole IP.
        this.limitedStreak += 1;
        this.historyPause = now + Math.min(LIMITED_PAUSE_MAX_MS, LIMITED_PAUSE_MS * 2 ** (this.limitedStreak - 1));
        this.guard(() => {
          this.store.setMeta('history_pause', String(this.historyPause));
          this.store.setMeta('history_streak', String(this.limitedStreak));
        });
        this.log.warn({ pausedForS: Math.round((this.historyPause - now) / 1000) }, 'builder verifier: SoDEX rate-limited a history read - the lane is paused');
        return;
      }
      this.historyAt = Math.max(this.historyAt, now + FAILED_REST_FACTOR * this.historyGap);
      this.guard(() => this.store.setMeta('history_at', String(this.historyAt)));
      job.failures += 1;
      this.log.warn({ err: msg, failures: job.failures }, 'builder verifier: a verification step failed');
      if (job.failures >= MAX_STEP_FAILURES) this.drop(job, true);
      else job.due = now + VERIFY_EVERY_MS * job.failures;
    }
  }

  /** The default fee over time, as the ledger has it; before the ledger has any, the one in force. */
  private defaults(cfg: TiersConfig): FeeRow[] {
    const rows = this.store.defaults(cfg.builderId);
    return rows.length ? rows : defaultsOf(defaultFee(cfg));
  }

  /** Both engines are swept: the pass is done. */
  private finish(job: Job): void {
    const now = this.now();
    this.jobs.delete(job.address);
    this.guard(() => {
      this.store.completePass(job.builder, job.address, job.gen, now);
      this.store.pruneOrders(job.builder, job.address, now - ORDER_RETAIN_MS);
      this.store.capOrders(job.builder, job.address, MAX_ORDER_ROWS);
    });
  }

  /** The keys our app registered for the wallet, as the engine lists them now. A failed read is not worth a retry. */
  private async readKeys(address: string, engine: Engine): Promise<void> {
    if (!Number.isFinite(this.explorerGap)) return;
    this.sent.keys += 1;
    let data: unknown;
    try {
      data = await this.io.get(`/api/v1/${engine}/accounts/${address}/api-keys`);
    } catch (e) {
      if (isRateLimit(e)) throw e;
      return;
    }
    const keys = readAppKeys(data);
    if (keys.length) this.guard(() => this.store.recordKeys(address, keys, this.now()));
  }

  // --- explorer -----------------------------------------------------------------------------

  private async explorerStep(cfg: TiersConfig): Promise<void> {
    const builder = cfg.builderId;
    const now = this.now();
    const next = this.store.nextLookup(builder, now);
    if (!next) {
      // Rows wait, none is due: their retry time has not come.
      this.explorerPoll = now + EXPLORER_POLL_MS;
      return;
    }
    this.explorerPoll = 0;
    const { wallet: w, engine, row } = next;
    this.explorerAt = now + this.explorerGap;
    this.sent.explorer += 1;

    let body: unknown;
    try {
      body = await this.io.explorer(explorerPath(engine, w.accountId, row.orderId));
    } catch (e) {
      // Not a 200, or no answer: stop asking, for longer each time. The order waits; its wallet goes to the back.
      const at = this.now();
      this.explorerStreak += 1;
      this.explorerPause = at + Math.min(EXPLORER_PAUSE_MAX_MS, EXPLORER_PAUSE_MS * 2 ** (this.explorerStreak - 1));
      const tries = row.tries + 1;
      const gaveUp = tries > NOT_FOUND_RETRY_MS.length;
      this.guard(() => {
        this.store.setMeta('explorer_pause', String(this.explorerPause));
        this.store.setMeta('explorer_streak', String(this.explorerStreak));
        this.store.commitLookup({
          builder, address: w.address, gen: w.createdAt, engine,
          row: { ...row, tries, nextAt: this.explorerPause, state: gaveUp ? (row.state === OrderState.check ? OrderState.checked : OrderState.unknown) : row.state },
          closed: gaveUp, addMicro: 0, byDay: new Map(), underpaid: { n: 0, at: 0 }, tampered: { n: 0, at: 0 }, misses: w.misses + 1, now: at, evidence: [],
        });
      });
      this.log.warn(
        { status: e instanceof ExplorerError ? e.status : null, err: e instanceof Error ? e.message : String(e), pausedForS: Math.round((this.explorerPause - at) / 1000) },
        'builder verifier: the explorer did not answer with a 200 - the lane is paused',
      );
      return;
    }
    if (this.explorerStreak) {
      this.explorerStreak = 0;
      this.explorerPause = 0;
      this.guard(() => {
        this.store.setMeta('explorer_pause', '0');
        this.store.setMeta('explorer_streak', '0');
      });
    }

    const at = this.now();
    const tx = readExplorerTx(body);
    if (!tx) {
      // The explorer does not know the order (yet): ask again later, a few times.
      const tries = row.tries + 1;
      const wait = NOT_FOUND_RETRY_MS[tries - 1];
      const gaveUp = wait === undefined;
      this.guard(() => this.store.commitLookup({
        builder, address: w.address, gen: w.createdAt, engine,
        row: { ...row, tries, nextAt: gaveUp ? 0 : at + wait, state: gaveUp ? (row.state === OrderState.check ? OrderState.checked : OrderState.unknown) : row.state },
        closed: gaveUp, addMicro: 0, byDay: new Map(), underpaid: { n: 0, at: 0 }, tampered: { n: 0, at: 0 }, misses: null, now: at, evidence: [],
      }));
      return;
    }

    const facts = orderFacts(tx, engine, row.orderId, this.o.chainId);
    if (!facts) {
      // Not the request that created the order, or one that cannot be read for certain: nothing is concluded.
      this.guard(() => this.store.commitLookup({
        builder, address: w.address, gen: w.createdAt, engine,
        row: { ...row, tries: row.tries + 1, nextAt: 0, state: row.state === OrderState.check ? OrderState.checked : OrderState.unknown },
        closed: true, addMicro: 0, byDay: new Map(), underpaid: { n: 0, at: 0 }, tampered: { n: 0, at: 0 }, misses: null, now: at, evidence: [],
      }));
      return;
    }

    const owed = feeOwedAt(this.store.feeHistory(builder, w.address), this.defaults(cfg), engine, facts.createdAt);
    const keys = this.store.keysOf(w.address);
    const verdict = judgeOrder(row, facts, { builderId: builder, owed, appKeys: new Set(keys.keys()), since: this.store.since() });
    const proof = (kind: Evidence['kind']): Evidence => ({
      kind, engine, orderId: row.orderId, txHash: facts.txHash, at: facts.createdAt, signer: facts.signer,
      keyName: facts.signer ? keys.get(facts.signer) ?? null : null, fee: facts.builder?.fee ?? null, owed,
    });
    const evidence: Evidence[] = [];
    if (verdict.underpaid) evidence.push(proof('underpaid'));
    if (verdict.tampered) evidence.push(proof('tampered'));
    const next2: OrderRow = { ...row, state: verdict.state, rate: verdict.rate, countedMicro: row.countedMicro + verdict.addMicro, tries: row.tries + 1, nextAt: 0 };
    const ok = this.guard(() => this.store.commitLookup({
      builder, address: w.address, gen: w.createdAt, engine, row: next2, closed: true,
      addMicro: verdict.addMicro,
      // The order's paid fills, on the day it first filled (the explorer confirmed it long after, maybe).
      byDay: verdict.addMicro > 0 ? new Map([[dayOf(row.t), verdict.addMicro]]) : new Map(),
      underpaid: verdict.underpaid ? { n: 1, at: facts.createdAt } : { n: 0, at: 0 },
      tampered: verdict.tampered ? { n: 1, at: facts.createdAt } : { n: 0, at: 0 },
      misses: verdict.state === OrderState.counted ? 0 : verdict.state === OrderState.other ? w.misses + 1 : null,
      now: at, evidence,
    }));
    if (!ok) return;
    if (verdict.tampered) {
      this.log.warn({ engine, orderId: row.orderId, txHash: facts.txHash, key: facts.signer ? keys.get(facts.signer) : null }, 'builder verifier: an order signed by the key our app registered does not carry our fee');
    }
    if (verdict.addMicro > 0 || verdict.underpaid || verdict.tampered) this.o.onChange?.(w.address);
  }
}
