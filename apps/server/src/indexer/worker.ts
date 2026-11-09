/**
 * The indexer as a unit that runs on its own thread or process.
 *
 *   dev         the API process starts it as a worker thread (host.ts), so a
 *               board rebuild never blocks an API request;
 *   production  `npm run indexer` runs it as its own process (main.ts), and
 *               API processes set VALUESCAN_INDEXER=0 and only read the file.
 *
 * Either way it owns the only writing connection to the index file and
 * publishes its status to the file's `meta` table every 30 s. It holds the
 * writer lock (writerLock.ts) for as long as it writes, and hands over to a
 * standby that asks (handover.ts) instead of a stop and a cold start.
 */
import type { BoardWindow, Venue } from '../valuedesk/types.js';
import { isMainThread, parentPort } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import { noteRateLimited, cooldownLeftMs } from '../valuedesk/sodex/util.js';
import { envOf } from '../valuedesk/env.js';
import { hlInfo } from '../valuedesk/hyperliquid/client.js';
import { hlWeightPerMin, type HlInfoClient } from '../valuedesk/hyperliquid/info.js';
import { Indexer, type HandoverStart } from './engine.js';
import { IndexStore, defaultDbPath } from './store.js';
import { lockHolder, tryWriterLock, type WriterLock } from './writerLock.js';
import { alive, handoverPaths, removeFiles, tellSupervisor, watchForStandby, writeJsonAtomic, type Accepted, type Boundary, type HandoverPaths } from './handover.js';

export interface Running {
  indexer: Indexer;
  store: IndexStore;
  lock: WriterLock;
  stop(): void;
}

/** Another process holds the writer lock: this one must not write the index. */
export class WriterLockHeld extends Error {
  constructor(readonly path: string, readonly holder: { pid: number; at: number; role: string } | null) {
    super(`the writer lock of ${path} is held by ${holder ? `pid ${holder.pid} (${holder.role}, since ${new Date(holder.at).toISOString()})` : 'another process'}: not starting a second writer`);
  }
}

export interface RunOptions {
  /** Held already (a standby that waited for it). */
  lock?: WriterLock;
  /** This process takes over from a running one (handover.ts). */
  handover?: HandoverStart;
  /** After this process handed over to a standby: everything written, the lock let go. main.ts ends the process. */
  onHandedOver?: () => void;
}

/**
 * Files a handover left when it ended midway (a crash): the ones only a live standby may still need are kept while its
 * pid is alive.
 */
function clearStale(p: HandoverPaths): void {
  removeFiles(p.boundary, p.accepted, p.withdrawn, p.heldDone, p.hlLent);
  for (const f of [p.hello, p.request, p.hlLend]) {
    try {
      const pid = Number((JSON.parse(readFileSync(f, 'utf8')) as { pid?: unknown }).pid);
      if (!(pid > 0) || pid === process.pid || !alive(pid)) removeFiles(f);
    } catch { /* none */ }
  }
}

/**
 * This thread or process IS the indexer: its lanes limit what it reads from
 * Hyperliquid. The shared client must not hold them below that - it would,
 * where one env file gives this process the API's switches (VALUESCAN_INDEXER=0,
 * VALUESCAN_HOSTED=1) and with them the small share of a process that only
 * serves the API (hyperliquid/info.ts).
 */
export function claimHlShare(client: Pick<HlInfoClient, 'resize' | 'backgroundMaxWaitMs'> = hlInfo, get: (name: string) => string | undefined = envOf): void {
  client.resize(hlWeightPerMin(get, true));
  client.backgroundMaxWaitMs = BACKGROUND_MAX_WAIT_MS;
}

/** The boards' reads wait this long for headroom at most, then queue with the cohort reads (info.ts backgroundMaxWaitMs). */
export const BACKGROUND_MAX_WAIT_MS = 10_000;

export function runIndexer(path = defaultDbPath(), o: RunOptions = {}): Running {
  claimHlShare();
  const t0 = Date.now();
  const lock = o.lock ?? tryWriterLock(path);
  if (!lock) throw new WriterLockHeld(path, lockHolder(path));
  const paths = handoverPaths(path);
  if (!o.handover && path !== ':memory:') clearStale(paths);
  let store: IndexStore;
  try {
    store = new IndexStore(path, { deferHeld: !!o.handover });
  } catch (e) {
    lock.release();
    throw e;
  }
  const t1 = Date.now();
  // The bulk writes on their own thread (writerThread.ts), before the engine starts: the last stop's spill goes through it.
  const writer = store.startWriter();
  const indexer = new Indexer(store);
  const t2 = Date.now();
  console.log(`[indexer] start: store ${t1 - t0} ms, engine ${t2 - t1} ms, writer thread ${writer ? 'on' : 'off'}${o.handover ? ', taking over from a running indexer' : ''}`);
  indexer.start(o.handover ? { handover: o.handover } : {});
  /** When a stop began (0: running). Published from its first moment, so the status page can say maintenance, not down. */
  let stoppingSince = 0;
  const publish = () => {
    try {
      const status = (() => { try { return indexer.status(); } catch { return {}; } })();
      store.setMeta('indexer_status', statusRow(status, Date.now(), process.pid, stoppingSince));
    } catch { /* the next tick tries again */ }
  };
  // At once, not 30 s on: the row the last stop left says `stopping` until this one replaces it.
  publish();
  const statusTimer = setInterval(publish, 30_000);
  // Tell the host when this thread hits a SoDEX rate limit, so the API side backs off too.
  let reported = 0;
  const coolTimer = setInterval(() => {
    const left = cooldownLeftMs();
    if (left > 0 && Date.now() - reported > left) {
      reported = Date.now();
      parentPort?.postMessage({ type: 'cooldown' });
    }
  }, 2_000);
  // A standby beside this process (handover.ts): keep its ids from its hello on, lend it Hyperliquid markets, hand over.
  const stopWatch = process.env.VALUESCAN_HANDOVER === '0' || path === ':memory:' ? () => {} : watchForStandby(paths, {
    onHello: (h) => {
      indexer.prepareHandover();
      console.log(`[indexer] handover: standby pid ${h.pid} said hello; every print id is kept from now on`);
    },
    onLend: (coins) => indexer.lendHl(coins),
    onGone: (h) => {
      const back = indexer.unlendHl();
      console.log(`[indexer] handover: standby pid ${h.pid} went away before it asked${back ? `; its ${back} Hyperliquid markets subscribed here again` : ''}`);
    },
    onRequest: (a) => handOver(a),
  });

  /**
   * The running side of a handover: stop as on SIGTERM, name the prints taken (the boundary), let go of the lock, then the
   * held rows (a file: the incoming process writes the index meanwhile). The status row says `handover`, not `stopping`:
   * the standby's sockets hold every print meanwhile (ops/status.ts).
   */
  const handOver = (a: Accepted) => {
    if (stoppingSince) return;
    stoppingSince = Date.now();
    stopWatch();
    clearInterval(statusTimer);
    clearInterval(coolTimer);
    const lap = stopLaps(stoppingSince);
    console.log(`[indexer] handover: pid ${a.pid} takes over (it asked ${Math.round((a.at - a.helloAt) / 1000)} s after its hello); stopping`);
    tellSupervisor('accepted', { to: a.pid });
    const frozen = (() => { try { return indexer.status() as Record<string, unknown>; } catch { return {}; } })();
    const handing = { to: a.pid, since: stoppingSince };
    const pub = () => {
      try { store.setMeta('indexer_status', handoverRow(frozen, Date.now(), process.pid, handing, a.up)); } catch { /* the next step tries again */ }
    };
    pub();
    lap('status published (handing over)');
    const stoppedAt = Date.now();
    try {
      indexer.stop((step) => { lap(step); pub(); });
    } catch (e) {
      console.warn(`[indexer] handover: the stop failed (${String(e)}); the boundary and the lock follow all the same`);
    }
    // Tests only (handover.test.ts): a stop as slow as production's (2026-11-08: minutes), every print meanwhile buffered.
    const hold = Number(process.env.VALUESCAN_HANDOVER_TEST_HOLD_MS) || 0;
    if (hold > 0) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, hold); lap('test hold'); }
    const b = indexer.handoverBoundary(a.from);
    pub();
    lap('status published');
    store.releaseForHandover(lap);
    const boundary: Boundary = { pid: process.pid, to: a.pid, at: Date.now(), stoppedAt, ...b };
    const ids = Object.values(boundary.venues).reduce((n, v) => n + v!.ids.length, 0);
    try {
      writeJsonAtomic(paths.boundary, boundary);
    } catch (e) {
      console.warn(`[indexer] handover: boundary not written (${String(e)}): the standby falls back to the restart check`);
    }
    lap(`boundary written (${ids} print ids)`);
    lock.release();
    lap('writer lock released');
    tellSupervisor('released', { to: a.pid });
    const rows = store.writeHeld();
    lap(`held rows (${rows})`);
    try { writeJsonAtomic(paths.heldDone, { pid: process.pid, at: Date.now(), rows }); } catch { /* the standby also waits for this pid to end */ }
    lap.done();
    o.onHandedOver?.();
  };

  return {
    indexer,
    store,
    lock,
    stop() {
      if (stoppingSince) return;
      stoppingSince = Date.now();
      stopWatch();
      clearInterval(statusTimer);
      clearInterval(coolTimer);
      const lap = stopLaps(stoppingSince);
      publish();
      lap('status published (stopping)');
      indexer.stop(lap);
      // Still `stopping`: the process is about to end, and the next start replaces the row at once.
      publish();
      lap('status published');
      // Both callers end the process right after: the connection is left open, no checkpoint of the WAL on the way out.
      store.close(lap, { exiting: true });
      lock.release();
      lap.done();
    },
  };
}

/**
 * The `indexer_status` meta row. `stopping` (with `stoppingSince`, ms) only while a stop runs and after it, until the next
 * start writes its first row: the status page reads the field as maintenance.
 */
export function statusRow(status: object, at: number, pid: number, stoppingSince = 0): string {
  return JSON.stringify({ ...status, at, pid, ...(stoppingSince ? { stopping: true, stoppingSince } : {}) });
}

/**
 * The `indexer_status` row while handing over: the last status before the stop, with `handover` (to: the standby's pid)
 * and no `stopping` - the standby's sockets buffer every print meanwhile, and the status page judges the row as it is
 * (ops/status.ts) for as long as INDEXER_HANDOVER_MAX_MS. A venue whose socket the standby has not got up shows as down.
 */
export function handoverRow(status: Record<string, unknown>, at: number, pid: number, handover: { to: number; since: number }, up: Partial<Record<string, boolean>> = {}): string {
  const streams = { ...((status.streams as Record<string, unknown> | undefined) ?? {}) };
  for (const v of Object.keys(streams)) {
    const socket = v === 'tradexyz' ? 'hyperliquid' : v;
    if (up[socket] === false) streams[v] = null;
  }
  return JSON.stringify({ ...status, streams, at, pid, handover });
}

/**
 * The stop's steps timed, like the start's (`start: store 1632 ms, ...`): each one of a second or more in a line of its
 * own as it ends (a stop killed midway still names the step it was in), and all of them in one line at the end.
 */
export function stopLaps(since: number, log: (line: string) => void = (l) => console.log(l), now: () => number = Date.now): ((step: string) => void) & { done(): void } {
  const steps: Array<[string, number]> = [];
  let at = since;
  const lap = ((step: string) => {
    const t = now();
    steps.push([step, t - at]);
    if (t - at >= 1_000) log(`[indexer] stop: ${step} ${t - at} ms`);
    at = t;
  }) as ((step: string) => void) & { done(): void };
  lap.done = () => log(`[indexer] stopped in ${now() - since} ms: ${steps.map(([s, ms]) => `${s} ${ms} ms`).join(', ')}`);
  return lap;
}

if (!isMainThread && parentPort) {
  const running = runIndexer();
  parentPort.on('message', (m: { type?: string; venue?: Venue; addresses?: string[]; window?: BoardWindow }) => {
    if (m?.type === 'watch' && m.venue && Array.isArray(m.addresses)) running.indexer.watch(m.venue, m.addresses, m.window);
    else if (m?.type === 'cooldown') noteRateLimited();
    else if (m?.type === 'stop') {
      running.stop();
      process.exit(0);
    }
  });
}
