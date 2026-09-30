/**
 * Serial task lanes with priorities and a spend-rate cap.
 *
 * One lane per upstream budget (HL /info, SoDEX gateway, SoDEX data host), so
 * a slow venue never holds the other back and each budget is paced on its
 * own. A task returns what it spent; the lane then rests long enough that the
 * average stays at or below `perMin`. The shared clients (hlInfo, sodex) still
 * enforce the hard limits; this is the indexer's share, kept well below them
 * so the trading UI keeps its headroom.
 *
 * Tasks are keyed: adding a key that is already queued only raises its
 * priority. A task that throws is dropped (the next board pass re-adds it if
 * it is still needed); a rate limit pauses the whole lane.
 *
 * An upstream that is struggling (5xx, "Request Timeout", our own abort) is
 * backed off: 15 s after the first such failure, doubling to 5 minutes while
 * they continue, reset by the next success. Hammering a host that answers 503
 * only makes it answer 503 for longer.
 */
import { isRateLimit } from '../valuescan/sodex/util.js';
import { mark } from './busy.js';

export interface LaneTask {
  key: string;
  prio: number;
  run: () => Promise<number>;
  /** When the key is already queued at a lower priority, this request's `run` replaces the queued one. */
  replace?: boolean;
}

export interface LaneOptions {
  name: string;
  /** Spend units per minute (weight or requests). */
  perMin: number;
  /** Extra wait before a task, e.g. a shared cooldown or a busy shared budget. */
  gate?: () => number;
  /** Pause after a rate-limit error. */
  rateLimitPauseMs?: number;
  /** First back-off after a transient upstream failure (doubles to `transientMaxMs`). */
  transientBaseMs?: number;
  transientMaxMs?: number;
  /**
   * Guaranteed shares of the lane's SPEND by key prefix. A prefix that spent
   * less than its share over the recent tasks goes next whenever it has work
   * queued, whatever the priorities say - so a steady stream of urgent checks
   * cannot starve a background walk forever (Lighter's full ranking walk did
   * exactly that). Counted in spend, not tasks: a 3-request trade check and a
   * 1-request position read are not the same share of a budget.
   */
  shares?: ReadonlyArray<{ prefix: string; share: number }>;
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A failure worth backing off from: the upstream is overloaded or slow, not the request wrong. */
export function isTransient(err: unknown): boolean {
  const e = err as { status?: number; statusCode?: number; name?: string; message?: string } | null;
  const status = e?.status ?? e?.statusCode;
  if (typeof status === 'number' && (status >= 500 || status === 408)) return true;
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return true;
  return /HTTP\s*5\d\d|request timeout|timed out|aborted due to timeout|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed/i.test(e?.message ?? String(err));
}

export class Lane {
  private queue = new Map<string, { prio: number; run: () => Promise<number>; seq: number }>();
  private seq = 0;
  private running = false;
  private stopped = false;
  private active: string | null = null;
  private activeAt = 0;
  /** The prefixes and spend of the last tasks, for `shares`. */
  private recent: Array<{ prefix: string; cost: number }> = [];
  private transientStreak = 0;
  /** Until when the lane backs off a struggling upstream (ms epoch, 0 = not). */
  backoffUntil = 0;
  done = 0;
  failed = 0;
  spent = 0;
  lastError: string | null = null;

  constructor(private readonly o: LaneOptions) {}

  get size(): number {
    return this.queue.size;
  }

  /** Queued tasks per kind (the key up to its first ':'), largest first. */
  byKind(): Record<string, number> {
    const out = new Map<string, number>();
    for (const k of this.queue.keys()) {
      const kind = k.slice(0, Math.max(0, k.indexOf(':'))) || k;
      out.set(kind, (out.get(kind) ?? 0) + 1);
    }
    return Object.fromEntries([...out].sort((a, b) => b[1] - a[1]));
  }

  /** Queued tasks at or above a priority. */
  countAbove(prio: number): number {
    let n = 0;
    for (const e of this.queue.values()) if (e.prio >= prio) n++;
    return n;
  }

  /** Queued or running tasks whose key starts with `prefix`. */
  countPrefix(prefix: string): number {
    let n = this.active?.startsWith(prefix) ? 1 : 0;
    for (const k of this.queue.keys()) if (k.startsWith(prefix)) n++;
    return n;
  }

  /** The task running now and for how long (ms) - a lane that stops moving shows why. */
  get current(): { key: string; forMs: number } | null {
    return this.active ? { key: this.active, forMs: Date.now() - this.activeAt } : null;
  }

  /** A queued task's priority (undefined when not queued). */
  prioOf(key: string): number | undefined {
    return this.queue.get(key)?.prio;
  }

  /** Queued tasks per kind at or above `prio` (status: how much urgent work waits). */
  urgentByKind(prio: number): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [k, e] of this.queue) {
      if (e.prio < prio) continue;
      const kind = k.slice(0, Math.max(0, k.indexOf(':'))) || k;
      out[kind] = (out[kind] ?? 0) + 1;
    }
    return out;
  }

  has(key: string): boolean {
    return this.queue.has(key) || this.active === key;
  }

  add(t: LaneTask): void {
    if (this.active === t.key) return;
    const cur = this.queue.get(t.key);
    if (cur) {
      if (t.prio > cur.prio) {
        cur.prio = t.prio;
        if (t.replace) cur.run = t.run;
      }
      return;
    }
    this.queue.set(t.key, { prio: t.prio, run: t.run, seq: this.seq++ });
  }

  /** Drop queued tasks that are no longer wanted. */
  retain(keep: (key: string) => boolean): void {
    for (const k of this.queue.keys()) if (!keep(k)) this.queue.delete(k);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopped = false;
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
  }

  private next(): [string, { prio: number; run: () => Promise<number>; seq: number }] | null {
    const pick = (only?: string) => {
      let best: [string, { prio: number; run: () => Promise<number>; seq: number }] | null = null;
      for (const e of this.queue) {
        if (only && !e[0].startsWith(only)) continue;
        if (!best || e[1].prio > best[1].prio || (e[1].prio === best[1].prio && e[1].seq < best[1].seq)) best = e;
      }
      return best;
    };
    let total = 0;
    for (const r of this.recent) total += r.cost;
    for (const s of this.o.shares ?? []) {
      let served = 0;
      for (const r of this.recent) if (r.prefix === s.prefix) served += r.cost;
      if (total > 0 && served / total >= s.share) continue;
      const e = pick(s.prefix);
      if (e) return e;
    }
    return pick();
  }

  private prefixOf(key: string): string {
    return this.o.shares?.find((s) => key.startsWith(s.prefix))?.prefix ?? '';
  }

  private note(key: string, cost: number): void {
    this.recent.push({ prefix: this.prefixOf(key), cost: Math.max(cost, 0.25) });
    if (this.recent.length > 60) this.recent.shift();
  }

  private async loop(): Promise<void> {
    const sleep = this.o.sleep ?? realSleep;
    while (!this.stopped) {
      const gate = Math.max(this.o.gate?.() ?? 0, this.backoffUntil - Date.now());
      if (gate > 0) {
        await sleep(Math.min(gate, 5_000));
        continue;
      }
      const e = this.next();
      if (!e) {
        await sleep(1_000);
        continue;
      }
      const [key, task] = e;
      this.queue.delete(key);
      mark(`lane:${this.o.name}:${key.split(':')[0]}`);
      this.activeAt = Date.now();
      this.active = key;
      let cost = 1;
      try {
        cost = Math.max(0, await task.run());
        this.done++;
        this.transientStreak = 0;
      } catch (err) {
        this.failed++;
        this.lastError = err instanceof Error ? err.message : String(err);
        if (isRateLimit(err)) await sleep(this.o.rateLimitPauseMs ?? 60_000);
        else if (isTransient(err)) {
          const base = this.o.transientBaseMs ?? 15_000;
          const wait = Math.min(this.o.transientMaxMs ?? 5 * 60_000, base * 2 ** this.transientStreak++);
          this.backoffUntil = Date.now() + wait;
        }
      } finally {
        this.active = null;
      }
      this.note(key, cost);
      this.spent += cost;
      // Rest so the average spend stays at perMin.
      await sleep((cost / this.o.perMin) * 60_000);
    }
    this.running = false;
  }
}
