/**
 * The ONE door to SoDEX's two rate-limited history routes.
 *
 * SoDEX answers `/accounts/{a}/orders/history` and `/accounts/{a}/trades` - both
 * engines, one counter - about four times per 60 s per IP. The fifth request
 * blocks that IP for a minute or more: this run, the owner's browser, and the
 * server's fee verifier, which reads the same routes from the same machine.
 *
 * So in this runner:
 *   - every read of those routes goes through `HistoryLimiter.run`: at most one
 *     per `minGapMs` (35 s), counted over both routes and both engines;
 *   - the network guard asks `admit()` for each such request and refuses any that
 *     did not come through here (and every one in plan mode) - so a read added
 *     somewhere else by mistake never leaves the process;
 *   - while the run waits for the server's fee verifier the door is shut
 *     (`block`), and what the verifier used is counted (`touch`);
 *   - the time of the last read is kept in a small file, so a run restarted at
 *     once still keeps the distance.
 * The steps themselves take fills and order states from the account stream
 * (stream.ts); history is read only for the final cross-check.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const HISTORY_MIN_GAP_MS = 35_000;

const HISTORY_PATH_RE = /^\/api\/v1\/(spot|perps)\/accounts\/0x[0-9a-fA-F]{40}\/(orders\/history|trades)$/;

/** Is this gateway path one of the two rate-limited history routes? */
export const isLimitedHistoryPath = (pathname: string): boolean => HISTORY_PATH_RE.test(pathname);

export interface HistoryLimiterOptions {
  /** Least time between two reads (default 35 s). */
  minGapMs?: number;
  /** Where the time of the last read is kept between processes (null: memory only). */
  stateFile?: string | null;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Progress lines ("waiting 31 s for the history limit"). */
  say?: (line: string) => void;
}

export class HistoryBlocked extends Error {
  override name = 'HistoryBlocked';
}

export class HistoryLimiter {
  readonly minGapMs: number;
  private last = 0;
  private grant: { until: number } | null = null;
  private blockedBy: string | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly say: (line: string) => void;
  private readonly stateFile: string | null;
  /** Every read that left through this limiter (for the report). */
  readonly reads: Array<{ at: number; what: string; waitedMs: number }> = [];

  constructor(o: HistoryLimiterOptions = {}) {
    this.minGapMs = o.minGapMs ?? HISTORY_MIN_GAP_MS;
    this.now = o.now ?? (() => Date.now());
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.say = o.say ?? (() => undefined);
    this.stateFile = o.stateFile ?? null;
    if (this.stateFile && existsSync(this.stateFile)) {
      try {
        const j = JSON.parse(readFileSync(this.stateFile, 'utf8')) as { last?: unknown };
        // A time in the future (a clock that was set back) must not shut the door for good.
        if (typeof j.last === 'number' && Number.isFinite(j.last) && j.last <= this.now()) this.last = j.last;
      } catch {
        /* an unreadable file is no state */
      }
    }
  }

  private persist(): void {
    if (!this.stateFile) return;
    try {
      mkdirSync(dirname(this.stateFile), { recursive: true });
      writeFileSync(this.stateFile, JSON.stringify({ last: this.last }), 'utf8');
    } catch {
      /* the limit still holds within this process */
    }
  }

  /** ms until the next read may leave. */
  waitLeft(): number {
    return Math.max(0, this.last + this.minGapMs - this.now());
  }

  /** Shut the door: no history read may start until `unblock` (the server's verifier needs the budget). */
  block(reason: string): void {
    this.blockedBy = reason;
  }
  unblock(): void {
    this.blockedBy = null;
  }
  get blocked(): string | null {
    return this.blockedBy;
  }

  /** Someone else on this IP read a history route just now (the server's verifier): count it. */
  touch(at: number = this.now()): void {
    if (at > this.last) {
      this.last = at;
      this.persist();
    }
  }

  /**
   * The network guard's question for a request to a limited route: null = this
   * is the read the limiter just let through (its pass is used up); otherwise why not.
   */
  admit(): string | null {
    if (this.blockedBy) return `no history read while ${this.blockedBy}`;
    const g = this.grant;
    if (!g || this.now() > g.until) return 'history reads (orders/history, trades) go through the runner\'s limiter, one per 35 s - this one did not';
    this.grant = null;
    return null;
  }

  /**
   * Make ONE history read. Waits for its turn and for the gap; `read` must send
   * exactly one request to a limited route (a second one is refused by the guard).
   */
  run<T>(what: string, read: () => Promise<T>): Promise<T> {
    const job = this.tail.then(async () => {
      if (this.blockedBy) throw new HistoryBlocked(`history read "${what}" refused: ${this.blockedBy}`);
      const wait = this.waitLeft();
      if (wait > 0) {
        this.say(`history limit: waiting ${Math.ceil(wait / 1000)} s before "${what}" (one read per ${Math.round(this.minGapMs / 1000)} s over orders/history and trades, both engines)`);
        await this.sleep(wait);
      }
      if (this.blockedBy) throw new HistoryBlocked(`history read "${what}" refused: ${this.blockedBy}`);
      // Counted BEFORE it leaves: a request that fails still used the budget.
      this.last = this.now();
      this.persist();
      this.grant = { until: this.last + 60_000 };
      this.reads.push({ at: this.last, what, waitedMs: wait });
      try {
        return await read();
      } finally {
        this.grant = null;
      }
    });
    // One at a time, whatever the outcome of the one before.
    this.tail = job.catch(() => undefined);
    return job;
  }
}
