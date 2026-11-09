/**
 * A restart with no gap: the next indexer process opens its trade sockets while the running one still writes, and
 * takes over writing the moment the running one has stopped.
 *
 * Why (status.db, 2026-10-26 to 11-08): restarts and releases were ~70% of the indexer's bad minutes. A classic stop
 * closes the sockets first and the next process opens them last - between the two, 6-17 min of stop on 2026-11-08 and
 * Lighter's ~75 s of subscribing, every print of every venue was missing from the heatmap, who traded and the cohorts
 * unless a REST catch-up read it back (SoDEX and Arcus have one; Hyperliquid and Lighter do not).
 *
 * THE STEPS (files next to the index, so both processes and the tests need nothing else):
 *
 *   1. the incoming process (STANDBY, VALUESCAN_INDEXER_STANDBY=1) finds the writer lock held (writerLock.ts), writes
 *      `hello` and opens its own sockets. Every print goes to an in-memory buffer (PrintBuffer). It does not open the
 *      index, write anything or bind the liquidation feed's port.
 *   2. the running process sees `hello` (it looks every HANDOVER_POLL_MS) and keeps more of its ids (Dedup.keepAtLeast),
 *      so it can still name every print it took since the buffer began.
 *   3. once every socket is up (or READY_MAX_MS passed), the standby writes `request`: per venue the time its buffer
 *      starts (`from`).
 *   4. the running process takes the request (renames it to `accepted`: a rename is atomic, so a standby that gave up
 *      at the same moment, renaming it to `withdrawn`, cannot both win), stops as on SIGTERM (sockets, cohorts, the
 *      write backlog to the spill, the warm answers, who traded), then writes `boundary`: per venue every print id it
 *      took at `from` or later, and the time before which it can no longer say (`forgotThrough`), plus its "one trade
 *      per account and block" memory. It lets go of the writer lock, writes the held rows (a file) and `held-done`,
 *      and exits.
 *   5. the standby takes the lock, opens the index, replays the spill, and applies its buffer through the boundary
 *      (BoundaryFilter): a print the old process took is skipped, every other one applied - exactly once in fills,
 *      activity, who traded and the cohorts. Then the sockets feed the engine directly; the filter stays on a few
 *      minutes for a print one socket delivered later than the other.
 *
 * WHAT CAN GO WRONG, AND THEN: the standby gives up before step 4 (sockets never up, no answer in REQUEST_WAIT_MS) and
 * exits 75: the running process never knew, the release does a classic restart. The running process dies in step 4:
 * its lock goes with it, the standby takes over without a boundary and the flow recorder's restart check
 * (recorder.ts repeatOfHeld) decides what was already held, as after any crash. The standby dies after step 4: nobody
 * writes - the supervisor (supervisor.ts) exits and systemd starts a classic indexer 30 s later.
 */
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import type { Venue } from '../valuedesk/types.js';
import type { Print } from './streams.js';

/** How often the running process looks for a standby's files. existsSync of two names: nothing measurable. */
export const HANDOVER_POLL_MS = 250;
/** The standby hands over once its sockets are up, or after this long with what is up (Lighter has needed 75 s to 8 min). */
export const READY_MAX_MS = Number(process.env.VALUESCAN_HANDOVER_READY_MS) || 10 * 60_000;
/**
 * A request the running process has not taken in this long is withdrawn (a running process of older code never will).
 * Its thread can be held for a while: stalls of 33-74 s were profiled on 2026-11-08, and the poll runs on that thread.
 */
export const REQUEST_WAIT_MS = Number(process.env.VALUESCAN_HANDOVER_REQUEST_MS) || 180_000;
/** How long the standby waits for the running process to let a batch of Hyperliquid markets go (same thread as above). */
export const LEND_WAIT_MS = Number(process.env.VALUESCAN_HANDOVER_LEND_MS) || 120_000;
/** Once taken, how long the standby waits for the lock: the stop of 2026-11-08 22:46 took 351 s with its close. */
export const LOCK_WAIT_MS = Number(process.env.VALUESCAN_HANDOVER_LOCK_MS) || 15 * 60_000;
/**
 * The buffer's cap. Measured 2026-11-09 against the live venues (a standby on this laptop, all four sockets): 40,285
 * prints buffered in 123 s (~330 a second), the process 142 MB resident in all - so at most ~1.5 KB a print with the
 * sockets counted in, and this cap at most ~3 GB, ~100 minutes at that rate: far past any stop. Past it the newest
 * prints are not buffered, and the count is logged (`NOT buffered`).
 */
export const BUFFER_MAX = Number(process.env.VALUESCAN_HANDOVER_BUFFER) || 2_000_000;
/** The ids the running process keeps from the hello on (Dedup's usual 200,000 is ~10 min of Hyperliquid at its peaks). */
export const KEEP_IDS = 3_000_000;
/** Buffered prints older than the hello by this much are snapshots of what the running process took: never applied. */
export const SNAPSHOT_FLOOR_MS = 30 * 60_000;
/** The running process names its prints from this long before the buffer's start: a print may reach one socket late. */
export const FROM_MARGIN_MS = 2 * 60_000;
/** The filter stays on this long after the buffer is applied, for a print the old socket had and this one gets late. */
export const FILTER_TAIL_MS = 5 * 60_000;
/** The standby's exit code when it gave up: the release falls back to a classic restart. */
export const STANDBY_GAVE_UP = 75;
/** A second writer refused: the lock is held. */
export const LOCK_HELD_EXIT = 73;

export interface HandoverPaths {
  hello: string;
  request: string;
  accepted: string;
  withdrawn: string;
  boundary: string;
  heldDone: string;
  /** Hyperliquid markets the standby has (it asks the running process to let them go: streams.ts HL_SUBSCRIPTION_LIMIT). */
  hlLend: string;
  /** The running process's answer: the markets it let go, by the request's seq. */
  hlLent: string;
}

export const handoverPaths = (dbPath: string): HandoverPaths => ({
  hello: `${dbPath}.handover-hello.json`,
  request: `${dbPath}.handover-request.json`,
  accepted: `${dbPath}.handover-accepted.json`,
  withdrawn: `${dbPath}.handover-withdrawn.json`,
  boundary: `${dbPath}.handover-boundary.json`,
  heldDone: `${dbPath}.handover-held-done.json`,
  hlLend: `${dbPath}.handover-hl-lend.json`,
  hlLent: `${dbPath}.handover-hl-lent.json`,
});

export function writeJsonAtomic(file: string, value: unknown): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(value));
  renameSync(tmp, file);
}

export function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

export const removeFiles = (...files: string[]): void => {
  for (const f of files) try { rmSync(f, { force: true }); } catch { /* gone */ }
};

/** Left over from an earlier handover (a crash midway): cleared by the next writer once it holds the lock. */
export function clearHandoverFiles(p: HandoverPaths, keep: Array<keyof HandoverPaths> = []): void {
  removeFiles(...(Object.keys(p) as Array<keyof HandoverPaths>).filter((k) => !keep.includes(k)).map((k) => p[k]));
}

export interface Hello { pid: number; at: number }
export interface Request {
  pid: number;
  at: number;
  helloAt: number;
  from: Partial<Record<Venue, number>>;
  /** The standby's sockets: up or not, as it asks (the running process publishes them while it hands over). */
  up: Partial<Record<Venue, boolean>>;
}
export interface Accepted extends Request { by: number; acceptedAt: number }

/** One venue in the boundary: what the outgoing process took from `from` on. */
export interface VenueBoundary {
  from: number;
  /** Its ids of prints at `from` - FROM_MARGIN_MS or later. */
  ids: string[];
  /** It cannot say for prints at or before this (ids dropped for the cap). */
  forgotThrough: number;
}

export interface Boundary {
  pid: number;
  to: number;
  at: number;
  /** When the outgoing process stopped taking prints (its sockets closed). */
  stoppedAt: number;
  venues: Partial<Record<Venue, VenueBoundary>>;
  /** engine lastOrder: `${venue}|${acct}` -> `${t}|${symbol}` of its newest print, for one trade per account and block. */
  lastOrder: Array<[string, string]>;
}

/** Where the streams deliver: the buffer while standing by, the engine after. */
export class PrintTap {
  sink: (p: Print) => void = () => {};
  readonly emit = (p: Print): void => this.sink(p);
}

export class PrintBuffer {
  readonly prints: Print[] = [];
  dropped = 0;
  private first = new Map<Venue, number>();
  constructor(private readonly cap = BUFFER_MAX) {}
  readonly push = (p: Print): void => {
    if (this.prints.length >= this.cap) { this.dropped++; return; }
    this.prints.push(p);
    const f = this.first.get(p.venue);
    if (f === undefined || p.t < f) this.first.set(p.venue, p.t);
  };
  get size(): number { return this.prints.length; }
  /** Per venue, the oldest print held (not before `floor`). A venue with none: `now` (nothing of it to name). */
  from(floor: number, venues: readonly Venue[], now: number): Partial<Record<Venue, number>> {
    const out: Partial<Record<Venue, number>> = {};
    for (const v of venues) out[v] = Math.max(floor, this.first.get(v) ?? now);
    return out;
  }
}

/** What the filter did per venue: for the log line and the tests. */
export interface FilterCounts { applied: number; tookByOld: number; older: number }

/**
 * The boundary as a test per print. A print the outgoing process took is skipped; one older than what it can still name
 * (or older than the request's start) counts as taken; every other is applied. A venue the outgoing process had no
 * socket for: every print from the floor on is applied.
 */
export class BoundaryFilter {
  private ids = new Map<Venue, Set<string>>();
  private before = new Map<Venue, number>();
  readonly counts = new Map<Venue, FilterCounts>();
  constructor(boundary: Boundary | null, private readonly floor: number) {
    for (const [v, b] of Object.entries(boundary?.venues ?? {}) as Array<[Venue, VenueBoundary]>) {
      this.ids.set(v, new Set(b.ids));
      this.before.set(v, Math.max(b.forgotThrough + 1, b.from - FROM_MARGIN_MS));
    }
  }
  private count(v: Venue): FilterCounts {
    let c = this.counts.get(v);
    if (!c) this.counts.set(v, (c = { applied: 0, tookByOld: 0, older: 0 }));
    return c;
  }
  admit(p: Print): boolean {
    const c = this.count(p.venue);
    const ids = this.ids.get(p.venue);
    if (ids?.has(p.id)) { c.tookByOld++; return false; }
    const before = this.before.get(p.venue) ?? this.floor;
    if (p.t < before) { c.older++; return false; }
    c.applied++;
    return true;
  }
  /** One line per venue: `hyperliquid applied 812, taken by the old 3,104, older 990`. */
  line(): string {
    return [...this.counts].map(([v, c]) => `${v} applied ${c.applied}, taken by the old process ${c.tookByOld}, older ${c.older}`).join('; ');
  }
}

export interface HlLend { seq: number; pid: number; coins: string[] }
export interface HlLent { seq: number; pid: number; coins: number }

/** Whether a process with this pid is alive (signal 0 tests, sends nothing). */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * The running process's side: look for a standby's files. `onRequest` runs once, with the request it took. `onLend`: the
 * standby has these Hyperliquid markets, let them go. `onGone`: the standby withdrew or died before a request was taken
 * (what was lent comes back).
 */
export function watchForStandby(paths: HandoverPaths, o: {
  onHello: (h: Hello) => void;
  onLend?: (coins: string[]) => void;
  onGone?: (h: Hello) => void;
  onRequest: (r: Accepted) => void;
  everyMs?: number;
}): () => void {
  let hello: Hello | null = null;
  let lendSeq = 0;
  let taken = false;
  const t = setInterval(() => {
    if (taken) return;
    try {
      const h = existsSync(paths.hello) ? readJson<Hello>(paths.hello) : null;
      if (h && h.pid !== process.pid && alive(h.pid)) {
        if (!hello || hello.at !== h.at) { hello = h; lendSeq = 0; o.onHello(h); }
      } else if (hello) {
        // Withdrawn (its hello removed) or dead: whatever it had comes back here.
        const was = hello;
        hello = null;
        if (h && !alive(h.pid)) removeFiles(paths.hello, paths.request, paths.hlLend, paths.hlLent);
        o.onGone?.(was);
        return;
      }
      if (!hello) return;
      const lend = existsSync(paths.hlLend) ? readJson<HlLend>(paths.hlLend) : null;
      if (lend && lend.pid === hello.pid && lend.seq > lendSeq) {
        lendSeq = lend.seq;
        o.onLend?.(lend.coins);
        writeJsonAtomic(paths.hlLent, { seq: lend.seq, pid: process.pid, coins: lend.coins.length } satisfies HlLent);
      }
      if (!existsSync(paths.request)) return;
      const r = readJson<Request>(paths.request);
      if (!r || r.pid !== hello.pid) return;
      // Taken by renaming it: a standby that withdraws at the same moment renames it too, and only one rename finds it.
      try { renameSync(paths.request, paths.accepted); } catch { return; }
      taken = true;
      const a: Accepted = { ...r, by: process.pid, acceptedAt: Date.now() };
      writeJsonAtomic(paths.accepted, a);
      o.onRequest(a);
    } catch { /* the next look */ }
  }, o.everyMs ?? HANDOVER_POLL_MS);
  t.unref?.();
  return () => clearInterval(t);
}

/** The standby gives up: its request back, if the running process has not taken it. True when withdrawn. */
export function withdrawRequest(paths: HandoverPaths): boolean {
  try {
    renameSync(paths.request, paths.withdrawn);
    removeFiles(paths.withdrawn, paths.hello);
    return true;
  } catch {
    return !existsSync(paths.accepted);
  }
}

/** Tell the supervisor (supervisor.ts) where a handover stands, when there is one listening. */
export function tellSupervisor(phase: string, extra: Record<string, unknown> = {}): void {
  try { process.send?.({ ...extra, handover: phase, pid: process.pid, at: Date.now() }); } catch { /* none listening */ }
}
