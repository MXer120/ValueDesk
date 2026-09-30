/**
 * Production entry: `npm run indexer` (one process per deployment).
 *
 * API processes on the same machine read the same file; give them
 * VALUESCAN_INDEXER=0 so none of them starts a second writer. See
 * docs/INDEXER.md for the environment and budgets.
 */
import { runIndexer } from './worker.js';

const running = runIndexer();
console.log(`[indexer] writing ${running.store.path}`);

const stop = () => {
  running.stop();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

setInterval(() => {
  const s = running.indexer.status();
  console.log(
    `[indexer] hl q=${s.lanes.hl.queued} done=${s.lanes.hl.done} | sgw q=${s.lanes.sgw.queued} done=${s.lanes.sgw.done} ` +
      `err=${s.lanes.sgw.lastError ?? '-'} | strades q=${s.lanes.strades.queued} done=${s.lanes.strades.done} | ` +
      `sdata q=${s.lanes.sdata.queued} done=${s.lanes.sdata.done} | tracked hl=${s.tracked.hyperliquid} sodex=${s.tracked.sodex} | ` +
      `streams hl=${s.streams.hyperliquid ? 'up' : 'down'} sodex=${s.streams.sodex ? 'up' : 'down'} | build ${s.lastBuildMs} ms`,
  );
}, 60_000).unref();
