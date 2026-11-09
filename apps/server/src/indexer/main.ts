/**
 * Production entry: `npm run indexer` (one process per deployment).
 *
 * API processes on the same machine read the same file; give them
 * VALUESCAN_INDEXER=0 so none of them starts a second writer. See
 * docs/INDEXER.md for the environment and budgets.
 *
 * VALUESCAN_INDEXER_STANDBY=1 (the supervisor sets it for a handover, supervisor.ts): stand by beside the running
 * indexer and take over from it (handover.ts, standby.ts). Without it a start finds the writer lock free or refuses
 * (exit 73): never two writers.
 */
import './fetchThreadOn.js';
import { runIndexer, WriterLockHeld, type Running } from './worker.js';
import { startStandby } from './standby.js';
import { LOCK_HELD_EXIT } from './handover.js';
import { profileOnSignal } from './cpuProfile.js';
import { dirname, join } from 'node:path';

const standby = process.env.VALUESCAN_INDEXER_STANDBY === '1';
let running: Running | null = null;
let cancelStandby: (() => void) | null = null;
const exit = (code: number) => process.exit(code);

const stop = () => {
  if (running) {
    running.stop();
    process.exit(0);
  } else if (cancelStandby) {
    cancelStandby();
  } else {
    process.exit(0);
  }
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
// From the supervisor (supervisor.ts) where a signal cannot carry it (Windows, the tests).
process.on('message', (m) => { if (m === 'stop') stop(); });

try {
  if (standby) {
    const s = startStandby(undefined, { exit, onHandedOver: () => exit(0) });
    cancelStandby = s.cancel;
    running = await s.running;
    cancelStandby = null;
  } else {
    running = runIndexer(undefined, { onHandedOver: () => exit(0) });
  }
} catch (e) {
  if (e instanceof WriterLockHeld) {
    console.error(`[indexer] ${e.message}`);
    process.exit(LOCK_HELD_EXIT);
  }
  throw e;
}
if (!running) process.exit(0);
const live = running;
console.log(`[indexer] writing ${live.store.path}`);
live.store.startCheckpointer();
profileOnSignal(join(dirname(live.store.path), 'profiles'), 'indexer');

/** " 224/224": Lighter's markets confirmed of those wanted (ext/lighter.ts status). */
const lighterSubs = (v: unknown): string => {
  const sub = (v as { subscribed?: { confirmed?: number; markets?: number } | null } | undefined)?.subscribed;
  return sub && typeof sub.confirmed === 'number' ? ` ${sub.confirmed}/${sub.markets}` : '';
};

setInterval(() => {
  const s = live.indexer.status();
  console.log(
    `[indexer] hl q=${s.lanes.hl.queued} done=${s.lanes.hl.done} | sgw q=${s.lanes.sgw.queued} done=${s.lanes.sgw.done} ` +
      `err=${s.lanes.sgw.lastError ?? '-'} | strades q=${s.lanes.strades.queued} done=${s.lanes.strades.done} | ` +
      `sdata q=${s.lanes.sdata.queued} done=${s.lanes.sdata.done} | tracked hl=${s.tracked.hyperliquid} sodex=${s.tracked.sodex} | ` +
      `streams hl=${s.streams.hyperliquid ? 'up' : 'down'} sodex=${s.streams.sodex ? 'up' : 'down'} ` +
      `lighter=${s.streams.lighter ? 'up' : 'down'}${lighterSubs(s.venues.lighter)} arcus=${s.streams.arcus ? 'up' : 'down'} | build ${s.lastBuildMs} ms` +
      // The three slowest steps of that build (engine.ts lastBuildStepMs): the journal names what made a build slow.
      ` (${Object.entries(s.lastBuildStepMs ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k} ${v}`).join(', ')})`,
  );
}, 60_000).unref();
