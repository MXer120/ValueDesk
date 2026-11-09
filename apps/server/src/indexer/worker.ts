/**
 * The indexer as a unit that runs on its own thread or process.
 *
 *   dev         the API process starts it as a worker thread (host.ts), so a
 *               board rebuild never blocks an API request;
 *   production  `npm run indexer` runs it as its own process (main.ts), and
 *               API processes set VALUESCAN_INDEXER=0 and only read the file.
 *
 * Either way it owns the only writing connection to the index file and
 * publishes its status to the file's `meta` table every 30 s.
 */
import type { BoardWindow, Venue } from '../valuedesk/types.js';
import { isMainThread, parentPort } from 'node:worker_threads';
import { noteRateLimited, cooldownLeftMs } from '../valuedesk/sodex/util.js';
import { envOf } from '../valuedesk/env.js';
import { hlInfo } from '../valuedesk/hyperliquid/client.js';
import { hlWeightPerMin, type HlInfoClient } from '../valuedesk/hyperliquid/info.js';
import { Indexer } from './engine.js';
import { IndexStore, defaultDbPath } from './store.js';

export interface Running {
  indexer: Indexer;
  store: IndexStore;
  stop(): void;
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

export function runIndexer(path = defaultDbPath()): Running {
  claimHlShare();
  const t0 = Date.now();
  const store = new IndexStore(path);
  const t1 = Date.now();
  // The bulk writes on their own thread (writerThread.ts), before the engine starts: the last stop's spill goes through it.
  const writer = store.startWriter();
  const indexer = new Indexer(store);
  const t2 = Date.now();
  console.log(`[indexer] start: store ${t1 - t0} ms, engine ${t2 - t1} ms, writer thread ${writer ? 'on' : 'off'}`);
  indexer.start();
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
  return {
    indexer,
    store,
    stop() {
      if (stoppingSince) return;
      stoppingSince = Date.now();
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
