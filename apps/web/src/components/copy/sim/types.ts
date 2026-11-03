/**
 * Input and config types for the copy simulation engine.
 *
 * The engine does not read `VsFill` directly. `adapt.ts` turns the venue fills
 * from /api/vs/fills into `SimFill`s first, adding the three things a replay
 * needs and the contract does not carry: the venue, the coin (for allow/deny
 * lists) and, where it can be worked out, the leader's position BEFORE the fill.
 *
 * Money is USD as a plain number, ratios are fractions (0.2 = 20%), times are ms.
 * These are analytics values only; nothing here is ever signed.
 */
import type { EquityPoint, Venue } from '../../../vsApi';

export type { EquityPoint, Venue };

/** A trader on a venue. */
export interface TraderRef {
  venue: Venue;
  /** Lower-case 0x address. */
  address: string;
}

/** One leader fill, as the engine replays it. */
export interface SimFill {
  /** Unique within the venue (trade id / tid). */
  id: string;
  venue: Venue;
  symbol: string;
  /** Upper-case coin used by the allow and deny lists ('BTC' for 'BTC-USD'). */
  coin: string;
  side: 'buy' | 'sell';
  price: number;
  /** Base units, positive. */
  size: number;
  notionalUsd: number;
  fee: number | null;
  /** null = USD (the contract's convention). */
  feeAsset: string | null;
  /** Realised PnL of this fill when the venue reports it. */
  realizedPnl: number | null;
  /** 'Open Long' | 'Close Short' | ... when the venue reports it. */
  dir: string | null;
  /** Leader position BEFORE this fill (signed base units), when known. */
  startPosition: number | null;
  /**
   * Groups fills of one order so they are copied as one. The venues' fills
   * carry no order id in the contract, so adapt.ts derives one from
   * (time, symbol, side); see `toSimFills`.
   */
  orderId: string | null;
  time: number;
}

export type CopySizingMode = 'proportional' | 'fixedRatio' | 'fixedNotional';

export interface CopyConfig {
  /**
   * proportional:  mirror the leader's position as a share of equity
   *                (your allocation x leader position / leader equity);
   * fixedRatio:    your size = leader size x `ratio`;
   * fixedNotional: every copied open is a fixed USD amount (SimOptions.fixedNotionalUsd,
   *                default `maxPositionUsd`); scale-outs follow the leader's fraction.
   */
  sizingMode: CopySizingMode;
  /** Capital committed to this leader, USD. */
  allocationUsd: number;
  /** Multiplier for fixedRatio (0.1 = 10% of the leader's size). */
  ratio: number;
  /** Hard cap on gross exposure / equity for copied positions. */
  maxLeverage: number;
  /** Per-position notional cap, USD. */
  maxPositionUsd: number;
  /** Close a copied position at this loss, fraction of its margin (0.5 = -50%). null = off. */
  stopLossPct: number | null;
  /** Stop copying entirely when equity falls this far from its peak, fraction. null = off. */
  drawdownStopPct: number | null;
  /** Take profit per copied position, fraction of its margin. null = off. */
  takeProfitPct: number | null;
  /** Only copy these coins (empty = all). */
  assetAllow: string[];
  /** Never copy these coins. */
  assetDeny: string[];
  /** Open the leader's existing positions on subscribe (vs only new ones). */
  copyExisting: boolean;
  /** Max acceptable slippage per copied order, basis points. */
  slippageBps: number;
  /**
   * 'counter': take the other side of every leader position (the live planner's
   * direction, packages/copy-engine planner.ts). Absent = 'copy'.
   */
  direction?: 'copy' | 'counter';
  /** A multiple of the sizing mode's size before the caps (the live planner's settings.multiplier). Absent = 1. */
  multiplier?: number;
}

/** One entry of the per-trade log (copied or skipped). */
export interface SimulatedFill {
  /** The leader fill this reproduces (a merged fill when several were merged). */
  leaderFill: SimFill;
  /** Follower size (base units, signed by side), 0 when skipped. */
  size: number;
  price: number;
  notionalUsd: number;
  fee: number;
  slippageCost: number;
  realizedPnl: number;
  /** Why it was not copied, when skipped (a SkipReason id). */
  skippedReason: string | null;
}
