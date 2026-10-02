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
import type { BoardWindow, Venue } from '../valuescan/types.js';
import { isMainThread, parentPort } from 'node:worker_threads';
import { noteRateLimited, cooldownLeftMs } from '../valuescan/sodex/util.js';
import { envOf } from '../valuescan/env.js';
import { hlInfo } from '../valuescan/hyperliquid/client.js';
import { hlWeightPerMin, type HlInfoClient } from '../valuescan/hyperliquid/info.js';
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
export function claimHlShare(client: Pick<HlInfoClient, 'resize'> = hlInfo, get: (name: string) => string | undefined = envOf): void {
  client.resize(hlWeightPerMin(get, true));
}

export function runIndexer(path = defaultDbPath()): Running {
  claimHlShare();
  const store = new IndexStore(path);
  const indexer = new Indexer(store);
  indexer.start();
  const publish = () => {
    try {
      store.setMeta('indexer_status', JSON.stringify({ ...indexer.status(), at: Date.now(), pid: process.pid }));
    } catch { /* the next tick tries again */ }
  };
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
      clearInterval(statusTimer);
      clearInterval(coolTimer);
      indexer.stop();
      publish();
      store.close();
    },
  };
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
