/**
 * What the status page counts as the indexer being behind, besides a stream down and old boards
 * (ops/status.ts indexerState): its work lanes and its thread, judged over the prober's last minutes.
 *
 * Measured on production (2026-11-06): the page said "up" while SoDEX's data lane had 5,091 reads
 * queued with figures up to 35 h old, and from 14:44 to 15:06 the gateway lane did nothing for 19
 * minutes and the data lane 12 reads with 5,683 queued. The page judged only freshness, streams and
 * board age. A long queue alone is normal (sdata keeps thousands queued at its pace): what counts is
 * whether a lane that has work gets any of it done.
 *
 *   lane stalled   a lane had work queued in every reading for LANE_STALL_MS[lane] and finished none.
 *                  From the indexer's minute log 2026-10-31..11-07 (9,467 minutes): outside a ship's
 *                  window these limits flag hl 179 minutes, sdata 119, sgw 45 (311 in all, 215 of them
 *                  counted as up then). Runs of 10 in a row (what opens an incident, statusAuto.ts):
 *                  four on the night of 11-06 (hl, 2,500 reads queued, none done for 15 to 47 min)
 *                  and two on its afternoon (sdata and sgw, the stop above). sgw waits out a rate
 *                  limit 15 minutes by design (engine.ts), scheck and strades 30: their limits sit
 *                  above that (they are not in the minute log, so theirs are not measured).
 *   reads failing  in the last FAIL_WINDOW_MS a lane failed FAIL_MIN reads or more and at least as many
 *                  as it finished. Normal is near none (hl: 2 failed of 2,650 in 10 h on 11-07).
 *   thread behind  the worst pause of the indexer's thread in the last minute was LAG_LIMIT_MS or more
 *                  in LAG_MINUTES of the last LAG_OF minutes. A pause of 5 s is ordinary (11-07 10:40);
 *                  stalls of 15 s or more were logged in 156 of 10,080 minutes, and in 5 of 10 minutes
 *                  only on 11-05 14:32-16:28 (59 minutes), all of it inside ship windows.
 *
 * The readings are kept in this process only: a prober restart starts the windows again, and an
 * indexer restart (its counts start at zero) starts them again for every lane.
 */
import type { IndexerHealth } from '../hosted.js';

const MIN = 60_000;
export const LANE_STALL_MS: Readonly<Record<string, number>> = { hl: 15 * MIN, sgw: 20 * MIN, scheck: 40 * MIN, strades: 40 * MIN, sdata: 15 * MIN };
/** A lane added later without a limit of its own. */
const LANE_STALL_DEFAULT_MS = 20 * MIN;
export const FAIL_WINDOW_MS = 10 * MIN;
export const FAIL_MIN = 10;
export const LAG_LIMIT_MS = 15_000;
export const LAG_MINUTES = 5;
export const LAG_OF = 10;
/** Two readings further apart than this (the prober did not run): no claim across the hole. */
const GAP_MS = 5 * MIN;
const KEEP_MS = 45 * MIN;

interface Reading {
  minute: number;
  at: number;
  lanes: IndexerHealth['lanes'];
  lag: number | null;
}

export class IndexerJudge {
  private readings: Reading[] = [];

  /**
   * Record this reading (one per prober minute: a second one in the same minute replaces it) and
   * say what is behind, as codes (whyText): `lane:<name>`, `fail:<name>`, `lag`.
   */
  judge(h: IndexerHealth, now: number): string[] {
    const minute = Math.floor(now / MIN);
    const r: Reading = { minute, at: h.at ?? now, lanes: h.lanes, lag: h.loopLagMs.lastMinute };
    if (this.readings.at(-1)?.minute === minute) this.readings.pop();
    this.readings.push(r);
    while (this.readings.length && this.readings[0]!.at < r.at - KEEP_MS) this.readings.shift();
    const why: string[] = [];
    for (const name of Object.keys(r.lanes)) {
      if (this.stalled(name)) why.push(`lane:${name}`);
      if (this.failing(name)) why.push(`fail:${name}`);
    }
    const recent = this.readings.filter((x) => x.minute > minute - LAG_OF);
    if (recent.filter((x) => x.lag !== null && x.lag >= LAG_LIMIT_MS).length >= LAG_MINUTES) why.push('lag');
    return why;
  }

  /** The readings back from the newest that one process made one after another, newest first. */
  private run(name: string): Array<{ at: number; queued: number | null; done: number; failed: number }> {
    const out: Array<{ at: number; queued: number | null; done: number; failed: number }> = [];
    for (let i = this.readings.length - 1; i >= 0; i--) {
      const x = this.readings[i]!;
      const l = x.lanes[name];
      if (!l || l.done === null) break;
      const prev = out.at(-1);
      // An indexer restart starts its counts at zero; a hole in the readings says nothing.
      if (prev && (l.done > prev.done || (l.failed ?? 0) > prev.failed || prev.at - x.at > GAP_MS)) break;
      out.push({ at: x.at, queued: l.queued, done: l.done, failed: l.failed ?? 0 });
    }
    return out;
  }

  private stalled(name: string): boolean {
    const limit = LANE_STALL_MS[name] ?? LANE_STALL_DEFAULT_MS;
    const run = this.run(name);
    const now = run[0];
    if (!now) return false;
    for (const x of run) {
      if (!x.queued) return false;
      if (x.done !== now.done) return false;
      if (now.at - x.at >= limit) return true;
    }
    return false;
  }

  private failing(name: string): boolean {
    const run = this.run(name);
    const now = run[0];
    if (!now) return false;
    const from = run.filter((x) => now.at - x.at <= FAIL_WINDOW_MS).at(-1)!;
    const failed = now.failed - from.failed;
    return failed >= FAIL_MIN && failed >= now.done - from.done;
  }
}

const VENUE: Record<string, string> = { hyperliquid: 'Hyperliquid', sodex: 'SoDEX', lighter: 'Lighter', arcus: 'Arcus', tradexyz: 'trade.xyz' };

/** What a lane's reads are, for users: [what has stalled, what may be behind]. */
const LANE: Record<string, [string, string]> = {
  hl: ['Hyperliquid wallet reads (trades and PnL)', 'Hyperliquid wallet pages, cohorts and leaderboards may be behind'],
  sgw: ['SoDEX wallet trade reads', 'SoDEX wallet pages and leaderboards may miss recent trades'],
  scheck: ['checks of new SoDEX traders', 'new wallets may be missing from the SoDEX leaderboards'],
  strades: ['SoDEX trade history reads', 'SoDEX wallet trades may be behind'],
  sdata: ['SoDEX PnL, rank and account value reads', 'some SoDEX leaderboard figures may be hours old'],
};

/** One code (IndexerJudge.judge, ops/status.ts indexerState) in plain words, or null for one not known. */
export function whyText(code: string): string | null {
  const [kind, name = ''] = code.split(':');
  const lane = LANE[name] ?? [`the indexer's ${name} reads`, 'some figures may be behind'];
  switch (kind) {
    case 'stream':
      return name ? `live trades from ${VENUE[name] ?? name} are not coming in` : 'no live trade stream is connected';
    case 'boards':
      return 'the leaderboards have not been rebuilt for over an hour';
    case 'lane':
      return `${lane[0]} have stopped making progress: ${lane[1]}`;
    case 'fail':
      return `most ${lane[0]} are failing: ${lane[1]}`;
    case 'paused':
      return 'the indexer has stopped publishing new data: the figures shown are from its last update, under an hour ago';
    case 'stopping':
      return 'the indexer is restarting';
    case 'lag':
      return 'the indexer is running behind: live figures such as the liquidation heatmap and who traded may lag';
    default:
      return null;
  }
}
