/**
 * One upstream value held `ttlMs`, read again just before it lapses while it is being asked for (2026-11-18, the phone
 * pass: maps F9). The holds it replaces (SoDEX's internal pair for the OI figures, SoDEX's maintenance flag) made the
 * request that found them lapsed wait for SoDEX - on a quiet region's edge that was most polls.
 *
 *   const flag = new AheadValue(() => readFlag(), { ttlMs: 15_000, askedWithinMs: 50_000 });
 *   await flag.get();
 *
 * The same rules as the hold it replaces, so what a page sees is never older than before:
 *   - a value is handed out only while it is younger than `ttlMs` (measured from when its read finished, as TtlCache);
 *   - one read at a time, however many ask; a failed read is not kept: the next asker reads again;
 *   - nothing older is ever handed out when a read fails - the value lapses at its own `ttlMs` as before.
 * New: while someone asked within `askedWithinMs`, the next read starts shortly before the value lapses (a lead of twice
 * the last read's time, 0.5-5 s), so a poll finds a value and waits for nothing. Asked by nobody, nothing is read.
 */
export interface AheadOptions {
  ttlMs: number;
  /** Read ahead only while the last ask is at most this old (just over the pages' poll period). */
  askedWithinMs: number;
  now?: () => number;
  /** Tests: no timers (call tick()). */
  timers?: boolean;
}

export class AheadValue<T> {
  private held: { at: number; value: T } | null = null;
  private inflight: Promise<T> | null = null;
  private askedAt = Number.NEGATIVE_INFINITY;
  private lastReadMs = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** The held value (its `at`) whose read ahead failed: not tried ahead again - a failing upstream is asked once per value, not per request. */
  private aheadFailedFor: number | null = null;
  /** Reads made, reads a request waited for, reads made ahead, failed reads. */
  readonly stats = { reads: 0, waited: 0, ahead: 0, failed: 0 };

  constructor(private readonly read: () => Promise<T>, private readonly o: AheadOptions) {}

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  /** The value: the held one while it is fresh, else a read (shared with any under way). */
  get(): Promise<T> {
    const now = this.now();
    this.askedAt = now;
    if (this.held && now - this.held.at < this.o.ttlMs) {
      this.arm();
      return Promise.resolve(this.held.value);
    }
    this.stats.waited++;
    return this.start();
  }

  /** The lead before the value lapses at which the next read starts. */
  lead(): number {
    return Math.min(5_000, this.o.ttlMs / 3, Math.max(500, 2 * this.lastReadMs));
  }

  /** When the next read ahead is due (null: none while nobody asked lately or nothing is held). Exported for tests. */
  dueAt(): number | null {
    if (!this.held) return null;
    return this.held.at + this.o.ttlMs - this.lead();
  }

  /** One look: read ahead now when due and someone asked lately. Returns whether it read. */
  tick(): boolean {
    const now = this.now();
    const due = this.dueAt();
    if (due === null || now < due || this.inflight) return false;
    if (this.held && this.aheadFailedFor === this.held.at) return false;
    if (now - this.askedAt > this.o.askedWithinMs) return false;
    this.stats.ahead++;
    const heldAt = this.held?.at ?? null;
    this.start().catch(() => {
      // Not kept; a request after the value lapses reads again.
      this.aheadFailedFor = heldAt;
    });
    return true;
  }

  private start(): Promise<T> {
    if (this.inflight) return this.inflight;
    const t0 = this.now();
    this.stats.reads++;
    const p = this.read().then(
      (value) => {
        this.held = { at: this.now(), value };
        this.lastReadMs = Math.max(0, this.now() - t0);
        this.arm();
        return value;
      },
      (e: unknown) => {
        this.stats.failed++;
        throw e;
      },
    ).finally(() => {
      if (this.inflight === p) this.inflight = null;
    });
    this.inflight = p;
    return p;
  }

  private arm(): void {
    if (this.o.timers === false || this.timer) return;
    const due = this.dueAt();
    if (due === null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.tick();
    }, Math.max(0, due - this.now()));
    this.timer.unref?.();
  }

  /** Tests: forget the value and stop the timer. */
  reset(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.held = null;
    this.inflight = null;
    this.aheadFailedFor = null;
    this.askedAt = Number.NEGATIVE_INFINITY;
    this.lastReadMs = 0;
    for (const k of Object.keys(this.stats) as Array<keyof AheadValue<T>['stats']>) this.stats[k] = 0;
  }
}
