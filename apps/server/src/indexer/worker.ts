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
import { Indexer } from './engine.js';
import { IndexStore, defaultDbPath } from './store.js';

export interface Running {
  indexer: Indexer;
  store: IndexStore;
  stop(): void;
}

export function runIndexer(path = defaultDbPath()): Running {
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
