/**
 * The status page's prober as a process of its own (valuescan-status.service), so a release
 * never blinds it: inside the API it stopped for every API restart - minutes with no sample on
 * the status page (five on 2026-10-31), and the very minutes a release was under way. Owner
 * 2026-11-01: the status checker must be up 100%.
 *
 * It only probes and writes status.db (WAL: the API's routes read the same file). Its unit is
 * restarted only when this code changes (deploy/release/parts.mjs). The API leaves the
 * prober off with VALUESCAN_STATUS_PROBE=0 once this unit runs.
 */
import { startStatusProber } from './ops/status.js';
import { indexerStatusJudged as indexerStatus } from './indexer/read.js';

const log = {
  warn: (o: object, msg: string) => console.warn(JSON.stringify({ level: 'warn', msg, ...o })),
};

// The first round at once: a restart of this unit is the only blind time it has.
const prober = startStatusProber({ indexerStatus, log, firstAfterMs: 1_000 });
console.log(JSON.stringify({ level: 'info', msg: 'status prober started' }));

// Kept alive by its interval (unref'd inside, for the API): hold the process open here.
const keep = setInterval(() => {}, 60_000);
const stop = () => {
  prober.stop();
  clearInterval(keep);
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
