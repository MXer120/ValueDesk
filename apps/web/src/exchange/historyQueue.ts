/**
 * Who gets the next SoDEX history read.
 *
 * `/trades` and `/orders/history` allow two reads a minute per IP (the drip,
 * sodexGateway.ts). Two a minute is plenty for what is ON SCREEN - one
 * history table at a time - as long as nothing in the background takes those
 * slots first. So every history read waits here with a priority:
 *
 *  - 'visible'    a history table on screen, or a read the user just asked for.
 *                 Takes any free slot, first come first served.
 *  - 'bulk'       many pages for one view (a wallet's fills walked for the
 *                 copy simulator). Any free slot too, but never while a
 *                 table waits: a table is one read, and it is what the user
 *                 opened last.
 *  - 'background' reads nobody is looking at (the account setup's index walk,
 *                 prefetches, anything from a hidden tab). Only on an idle drip,
 *                 only once no tab has wanted a visible read for a minute, and
 *                 not in the first seconds after a page load (that is when the
 *                 user opens tables) - so a visible read always finds a slot.
 *  - 'walk'       the all-time statistics walk: after everything else.
 *
 * A read from a tab that is hidden is background whatever it asked for: there
 * is nothing on screen to wait for it. Within a tab a lower priority never
 * goes while a higher one waits; across tabs, a waiting visible read raises a
 * shared "visible demand" mark that every tab's background reads respect.
 */
import { BudgetWaitError, type KeyValueStore, type SharedLedger } from './ledger';

export type HistoryPriority = 'visible' | 'bulk' | 'background' | 'walk';

const RANK: Record<HistoryPriority, number> = { visible: 0, bulk: 1, background: 2, walk: 3 };
const BY_RANK: HistoryPriority[] = ['visible', 'bulk', 'background', 'walk'];

/** Background reads wait this long after the last visible demand in any tab. */
export const VISIBLE_QUIET_MS = 60_000;
/** ...and this long after the page loaded: both slots are for what the user opens first. */
export const STARTUP_GRACE_MS = 20_000;
const DEMAND_KEY = 'vs:history:visible-demand';
const POLL_MS = 500;

export interface HistoryQueueDeps {
  /** The drip every history read must pass. */
  drip: SharedLedger;
  /** Shared with other tabs (localStorage), for the visible-demand mark. */
  store: KeyValueStore | null;
  now(): number;
  sleep(ms: number): Promise<void>;
  /** True while this tab is not on screen. */
  hidden(): boolean;
}

interface Waiter {
  rank: number;
  seq: number;
}

export class HistoryQueue {
  private readonly waiting = new Set<Waiter>();
  private seq = 0;
  private demandMem = 0;
  private demandWritten = 0;
  private readonly startedAt: number;

  constructor(private readonly d: HistoryQueueDeps) {
    this.startedAt = d.now();
  }

  /** A waiter's priority as it stands now (a hidden tab has nothing visible). */
  private rankOf(w: Waiter): number {
    return w.rank <= RANK.bulk && this.d.hidden() ? RANK.background : w.rank;
  }

  private markVisibleDemand(): void {
    const now = this.d.now();
    this.demandMem = now;
    if (now - this.demandWritten < 1_000) return;
    this.demandWritten = now;
    try {
      this.d.store?.setItem(DEMAND_KEY, String(now));
    } catch {
      /* this tab still knows */
    }
  }

  /** When any tab last wanted (or got) a visible history read. */
  lastVisibleDemand(): number {
    let at = this.demandMem;
    try {
      const v = Number(this.d.store?.getItem(DEMAND_KEY) ?? 0);
      if (Number.isFinite(v)) at = Math.max(at, v);
    } catch {
      /* this tab's own */
    }
    return at;
  }

  /**
   * Nobody in this tab outranks `me`. Reads of the same priority do not queue
   * behind each other: while slots are free they all go at once.
   */
  private isHead(me: Waiter): boolean {
    const mine = this.rankOf(me);
    for (const w of this.waiting) if (w !== me && this.rankOf(w) < mine) return false;
    return true;
  }

  /**
   * A background read could take a slot right now: the drip is idle, no tab
   * has wanted a visible read for a minute, and the page is past its first
   * seconds. (The all-time walk waits for this before it spends its own turn.)
   */
  backgroundMayGo(): boolean {
    const now = this.d.now();
    return this.d.drip.spent() === 0 && now - this.lastVisibleDemand() >= VISIBLE_QUIET_MS && now - this.startedAt >= STARTUP_GRACE_MS;
  }

  /** How many are waiting, per priority (diagnostics, tests). */
  pending(): Record<HistoryPriority, number> {
    const out: Record<HistoryPriority, number> = { visible: 0, bulk: 0, background: 0, walk: 0 };
    for (const w of this.waiting) out[BY_RANK[this.rankOf(w)]!]++;
    return out;
  }

  /**
   * Wait for this read's turn and a slot of the drip, then take it. Rejects
   * with BudgetWaitError after `maxWaitMs`, or when `signal` aborts - at once,
   * so a read whose table left the screen frees its place for the one shown.
   *
   * `hold` is asked before every try: the ms this read must still stay out
   * (a cooldown that opened while it waited), 0 to go. It may throw to give
   * up. A read that is held takes no slot.
   */
  async take(priority: HistoryPriority, maxWaitMs: number, signal?: AbortSignal, hold?: () => number): Promise<void> {
    const me: Waiter = { rank: RANK[priority], seq: this.seq++ };
    this.waiting.add(me);
    const start = this.d.now();
    let wake: (() => void) | null = null;
    const onAbort = () => wake?.();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      for (;;) {
        if (signal?.aborted) throw signal.reason ?? new DOMException('aborted', 'AbortError');
        const rank = this.rankOf(me);
        // For something on screen: any free slot, and background readers hold off.
        const shown = rank <= RANK.bulk;
        if (shown) this.markVisibleDemand();
        let wait = POLL_MS;
        const held = hold ? hold() : 0;
        if (held > 0) {
          wait = Math.min(held, 1_000);
        } else if (this.isHead(me)) {
          const idle = this.backgroundMayGo();
          if (shown || idle) {
            // A read for the screen takes any free slot; a background one only the
            // idle drip, checked and taken in one step (never two of them at once).
            const w = shown ? await this.d.drip.tryTake(1) : await this.d.drip.tryTakeIdle(1);
            if (w === 0) {
              if (shown) this.markVisibleDemand();
              return;
            }
            wait = Math.min(Math.max(w, 50), 1_000);
          }
        }
        const waited = this.d.now() - start;
        if (waited + wait > maxWaitMs) throw new BudgetWaitError(`${this.d.drip.name} (${priority})`, waited + wait);
        await new Promise<void>((resolve) => {
          wake = resolve;
          void this.d.sleep(wait).then(resolve);
        });
        wake = null;
      }
    } finally {
      signal?.removeEventListener('abort', onAbort);
      this.waiting.delete(me);
    }
  }
}
