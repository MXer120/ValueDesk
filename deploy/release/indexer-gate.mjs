#!/usr/bin/env node
// deploy/release/indexer-gate.mjs - the indexer gate of ship.sh: is the indexer that was just released keeping up?
//
//   node deploy/release/indexer-gate.mjs <readings.jsonl>    prints "ok: ..." or "rollback: <why>" (exit 0 either way;
//                                                             2 for a file it cannot read)
//
// Each line is one reading of the indexer's published status (meta indexer_status), one a minute from the time it
// publishes again after the restart: {"now": <server ms>, "at": <its publish time>, "backlog": <flushBacklog>,
// "lag": <loopLagMs.lastMinute>}. Production 2026-11-08: releases and restarts made ~70% of all bad minutes (6-17 min
// stops and a slow first build), and the write backlog reached 883,699 rows before anything said so. A release that
// publishes once is not proof. Rolled back when, in the readings so far:
//   stale     the newest reading's status is over STALE_MS old (it publishes every 30 s: its thread or its worker is stuck);
//   lag       the thread's worst pause in the minute was LAG_MS or more in each of the last LAG_MINUTES readings, counted
//             only from LAG_GRACE_MS after the first reading: every start (the old release's too) catches up first - books
//             loaded, missed cohort hours written, the last stop's spill replayed - with pauses of 10-60 s (v0.2.200 and
//             v0.2.202 on 2026-11-09 were rolled back for exactly that, v0.2.198 shows the same at its starts);
//   backlog   the write backlog rose in each of the last BACKLOG_RISES minutes and stands at BACKLOG_MIN steps or more
//             (a handful of steps going up is noise: a whole flush is a few steps).
// A field the status does not have (null) is judged as nothing.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const STALE_MS = 180_000;
export const LAG_MS = 15_000;
export const LAG_MINUTES = 3;
export const LAG_GRACE_MS = 10 * 60_000;
export const BACKLOG_RISES = 3;
export const BACKLOG_MIN = Number(process.env.SHIP_INDEXER_BACKLOG_MIN) > 0 ? Number(process.env.SHIP_INDEXER_BACKLOG_MIN) : 100;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** The readings so far, oldest first -> { rollback, why }. */
export function judgeIndexerGate(readings, o = {}) {
  const staleMs = o.staleMs ?? STALE_MS;
  const lagMs = o.lagMs ?? LAG_MS;
  const lagMinutes = o.lagMinutes ?? LAG_MINUTES;
  const graceMs = o.lagGraceMs ?? LAG_GRACE_MS;
  const rises = o.backlogRises ?? BACKLOG_RISES;
  const backlogMin = o.backlogMin ?? BACKLOG_MIN;
  // A line that is no reading (no server clock) is left out.
  const rs = readings.map((r) => ({ now: num(r?.now), at: num(r?.at), backlog: num(r?.backlog), lag: num(r?.lag) })).filter((r) => r.now !== null);
  const last = rs.at(-1);
  if (!last) return { rollback: false, why: null };
  if (last.at === null || last.now - last.at > staleMs) {
    return { rollback: true, why: last.at === null ? 'published no status' : `published no status for ${Math.round((last.now - last.at) / 1000)} s` };
  }
  const lags = rs.filter((r) => r.now - rs[0].now >= graceMs).slice(-lagMinutes);
  if (lags.length === lagMinutes && lags.every((r) => r.lag !== null && r.lag >= lagMs)) {
    return { rollback: true, why: `held its thread ${Math.round(lagMs / 1000)} s or more in each of the last ${lagMinutes} minutes (worst ${Math.max(...lags.map((r) => r.lag))} ms)` };
  }
  const bl = rs.slice(-(rises + 1));
  if (bl.length === rises + 1 && bl.every((r) => r.backlog !== null) && bl.every((r, i) => i === 0 || r.backlog > bl[i - 1].backlog) && bl.at(-1).backlog >= backlogMin) {
    return { rollback: true, why: `fell behind its writes: the backlog rose ${rises} minutes in a row (${bl.map((r) => r.backlog).join(' -> ')} steps)` };
  }
  return { rollback: false, why: null };
}

/** One line for the ship's notes: what the readings showed. */
export function gateSummary(readings) {
  readings = readings.filter((r) => num(r?.now) !== null);
  const backlog = readings.map((r) => num(r?.backlog)).filter((v) => v !== null);
  const lag = readings.map((r) => num(r?.lag)).filter((v) => v !== null);
  return `${readings.length} readings, write backlog at most ${backlog.length ? Math.max(...backlog) : '?'} steps, longest pause ${lag.length ? Math.max(...lag) : '?'} ms`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let text;
  try {
    text = readFileSync(process.argv[2], 'utf8');
  } catch (e) {
    console.error(`indexer-gate: ${e.message}`);
    process.exit(2);
  }
  const readings = text.split('\n').filter((l) => l.trim()).map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return {};
    }
  });
  const v = judgeIndexerGate(readings);
  console.log(v.rollback ? `rollback: ${v.why}` : `ok: ${gateSummary(readings)}`);
}
