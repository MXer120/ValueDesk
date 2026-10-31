/**
 * What a scenario is: its setup, actions and checks (`run`), what it costs on
 * SoDEX (for --budget), what it depends on (for the resume hash), and how a
 * dry run treats it. The cleanup after it is the runner's, the same for every
 * scenario (cleanup.ts): it always runs, also when the scenario failed.
 */
import type { DepGroup } from './hash.ts';
import type { T } from './harness.ts';
import type { LeaderVenueName } from './leader.ts';
import type { Capability } from './target.ts';

/**
 * What one scenario costs, in USD at the follower (and the leader), with
 * every child order worth `U` (SoDEX's minimum plus headroom). Notional
 * TRADED counts both the open and the close (the cleanup's close included);
 * PEAK is the largest exposure at once - open positions plus resting orders
 * that could fill - which sets the margin it needs.
 */
export interface Cost {
  takerUsd: number;
  makerUsd: number;
  peakUsd: number;
  /** Leverage the peak is held at (default: the scenario's market default, see budget.ts). */
  leverage?: number;
  leaderTakerUsd?: number;
  leaderPeakUsd?: number;
  /**
   * Margin the scenario may lose to a liquidation SoDEX makes (the position's isolated margin, at
   * most what the scenario lets it hold while it waits): an upper bound, spent (budget.ts).
   */
  lostUsd?: number;
  /** Signed requests sent to SoDEX by the master wallet (registrations, approvals): free, counted for the record. */
  walletSignatures?: number;
}

/** 'ticket': the order ticket and the account tables, worked on the page (scenarios/ui.ts). */
export type Section = 'setup' | 'ticket' | 'algo' | 'copy' | 'fee';

export interface Scenario {
  id: string;
  section: Section;
  /** The algo kind, 'copy', 'kill', 'key'...: what --only matches besides the id. */
  kind: string;
  title: string;
  /** What only a real exchange shows, that this scenario confirms. */
  confirms: string;
  deps: DepGroup[];
  /** The file it is written in (repository-relative), hashed with it. */
  source: string;
  /** Bump to re-run it on unchanged code. */
  rev?: number;
  /** The bootstrap: runs every time, never skipped. */
  always?: boolean;
  /** Long (tens of minutes): runs only with --slow. */
  slow?: boolean;
  /** Needs the leader wallet. */
  leader?: boolean;
  /** Runs only with a leader on this venue (LIVE_LEADER_VENUE): with another it is skipped, with why. */
  leaderVenue?: LeaderVenueName;
  /** What the target must let the runner do (target.ts): on a target that cannot, it is skipped, with why. */
  needs?: Capability[];
  /**
   * How a dry run exercises it: on paper with its checks / its spec accepted and stopped / a copy's
   * lifecycle without leader trades / not at all ('live': what it waits for has no paper form - a
   * liquidation needs SoDEX's margin - so a dry run skips it, with why).
   */
  dry: 'full' | 'spec' | 'lifecycle' | 'live';
  timeoutMs: number;
  cost(U: number): Cost;
  run(t: T): Promise<void>;
}

/** Why a scenario does not run with the run's leader venue (it is written for another one), or null. */
export function leaderSkip(s: { leaderVenue?: LeaderVenueName }, venue: LeaderVenueName): string | null {
  return s.leaderVenue && s.leaderVenue !== venue ? `it needs a leader on ${s.leaderVenue === 'hyperliquid' ? 'Hyperliquid (LIVE_LEADER_VENUE=hyperliquid)' : 'SoDEX'}` : null;
}
