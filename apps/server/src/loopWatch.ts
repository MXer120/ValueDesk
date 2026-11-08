/**
 * The API's event loop, watched (2026-11-07 outage: "Data API not answering" 15:20-15:23, and nothing said why).
 *
 * A tick every TICK_MS measures how late it ran. A stall of STALL_MS or more is counted and logged with what started
 * it (busy.ts: the last label marked before the tick was due - a route `req:<pattern>`, or a timer such as coh:rebuild),
 * the requests in flight then, and how much of it was garbage collection. A long one (PROFILE_MS) writes the last
 * minute of CPU samples (indexer/stallProfiler.ts) to the profiles directory. Requests of SLOW_MS or more are logged
 * with their route pattern, time, status and size: never the query string or a path's values (addresses).
 * The counts go in /api/health (`loop`), so the health check and the status page can name the stall.
 */
import type { FastifyInstance } from 'fastify';
import { PerformanceObserver, performance } from 'node:perf_hooks';
import { gcWithin, mark, noteGc, startedBefore } from './indexer/busy.js';
import { StallProfiler } from './indexer/stallProfiler.js';

export const TICK_MS = 250;
export const STALL_MS = 1_000;
export const SLOW_MS = 2_000;
/** A stall this long writes a profile (at most one in the profiler's gap, 10 minutes). */
export const PROFILE_MS = 4_000;
const KEEP = 8;

export interface Stall { ms: number; at: number; by: string | null; gcMs: number; inFlight: string[] }
export interface LoopHealth {
  /** Stalls of STALL_MS or more since the start. */
  stalls: number;
  longestMs: number;
  /** The longest in the last minute (0: none). */
  lastMinuteMs: number;
  last: { ms: number; at: number; by: string | null } | null;
  /** Requests of SLOW_MS or more since the start. */
  slowRequests: number;
}

type Log = (obj: Record<string, unknown>, msg: string) => void;

export class LoopWatch {
  private stalls = 0;
  private longest = 0;
  private slow = 0;
  private recent: Stall[] = [];
  private window = { ms: 0, at: 0 };
  private inFlight = new Map<string, { route: string; at: number }>();
  private timer: NodeJS.Timeout | null = null;
  private gc: PerformanceObserver | null = null;
  private profiler: StallProfiler | null = null;

  constructor(private readonly log: Log, private readonly o: { profileDir?: string | null; tickMs?: number; stallMs?: number; slowMs?: number } = {}) {}

  start(): void {
    if (this.timer) return;
    try {
      this.gc = new PerformanceObserver((list) => { for (const e of list.getEntries()) noteGc(performance.timeOrigin + e.startTime, e.duration); });
      this.gc.observe({ entryTypes: ['gc'] });
    } catch { /* the lines then say 0 s of it */ }
    if (this.o.profileDir) {
      // Cut every 30 minutes, not every minute: each cut starts the profiler again, which walks the heap - 0.3 s on a
      // 0.5 GB heap here, 3.6 s on the production API's 2+ GB (its SIGUSR2 profile, 2026-11-07 15:41).
      this.profiler = new StallProfiler(this.o.profileDir, 'api-stall', { stallMs: PROFILE_MS, segmentMs: 30 * 60_000, log: (l) => this.log({}, l) });
      this.profiler.start();
    }
    const every = this.o.tickMs ?? TICK_MS;
    let due = Date.now() + every;
    this.timer = setInterval(() => {
      const now = Date.now();
      const late = Math.max(0, now - due);
      due = now + every;
      this.onLate(late, now);
    }, every);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.gc?.disconnect();
    this.profiler?.stop();
  }

  /** One tick `late` ms late (exported for tests). */
  onLate(late: number, now = Date.now()): void {
    this.profiler?.onLag(late, now);
    if (now - this.window.at > 60_000) this.window = { ms: 0, at: now };
    if (late < (this.o.stallMs ?? STALL_MS)) return;
    const from = now - late;
    for (const [id, r] of this.inFlight) if (now - r.at > 5 * 60_000) this.inFlight.delete(id);
    const stall: Stall = {
      ms: late, at: from, by: startedBefore(from), gcMs: 0,
      inFlight: [...this.inFlight.values()].filter((r) => r.at <= from).map((r) => r.route).slice(0, 8),
    };
    this.stalls++;
    this.longest = Math.max(this.longest, late);
    if (late >= this.window.ms) this.window = { ms: late, at: now };
    this.recent.push(stall);
    if (this.recent.length > KEEP) this.recent.shift();
    // A moment later: the observer delivers the stall's collections after it.
    const said = setTimeout(() => {
      stall.gcMs = gcWithin(from, now);
      // The heap with each stall (2026-11-08): GC pauses of 8-11 s came on a heap near its limit, which only this shows.
      const m = process.memoryUsage();
      const mb = (x: number) => Math.round(x / 1048576);
      this.log({ stallMs: late, by: stall.by, inFlight: stall.inFlight, gcMs: stall.gcMs, heapMb: mb(m.heapUsed), heapTotalMb: mb(m.heapTotal), rssMb: mb(m.rss), extMb: mb(m.external + m.arrayBuffers) },`api thread stalled ${(late / 1000).toFixed(1)} s, started by ${stall.by ?? 'unknown'}`);
    }, 1_000);
    said.unref();
  }

  health(now = Date.now()): LoopHealth {
    const last = this.recent.at(-1);
    return {
      stalls: this.stalls,
      longestMs: Math.round(this.longest),
      lastMinuteMs: now - this.window.at <= 60_000 ? Math.round(this.window.ms) : 0,
      last: last ? { ms: Math.round(last.ms), at: last.at, by: last.by } : null,
      slowRequests: this.slow,
    };
  }

  /** Every request marked by its route pattern (busy.ts) and timed; slow ones logged. */
  install(app: FastifyInstance): void {
    app.addHook('onRequest', async (req) => {
      const route = `req:${req.routeOptions?.url ?? '(no route)'}`;
      mark(route);
      this.inFlight.set(req.id, { route, at: Date.now() });
    });
    // The handler runs after the hooks: marked again where its own work starts.
    app.addHook('preHandler', async (req) => { mark(`req:${req.routeOptions?.url ?? '(no route)'}`); });
    app.addHook('onRequestAbort', async (req) => { this.inFlight.delete(req.id); });
    app.addHook('onResponse', async (req, reply) => {
      this.inFlight.delete(req.id);
      const ms = reply.elapsedTime;
      if (ms < (this.o.slowMs ?? SLOW_MS)) return;
      this.slow++;
      const bytes = Number(reply.getHeader('content-length')) || null;
      this.log({ route: req.routeOptions?.url ?? null, method: req.method, ms: Math.round(ms), status: reply.statusCode, bytes }, 'slow request');
    });
  }
}
