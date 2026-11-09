/**
 * A venue the indexer ranks through the generic machinery: its PnL in
 * `pnl_snap`, its trades in `fills` + `coverage`, its public trade stream (if
 * any) in the activity tables. The adapter only knows how to fill those.
 */
import type { BoardWindow, Venue } from '../../valuedesk/types.js';
import type { Lane } from '../lanes.js';
import type { ArcusStream, Dedup, LighterStream, Print } from '../streams.js';
import type { IndexStore } from '../store.js';

export interface ExtContext {
  store: IndexStore;
  now: () => number;
  /** Since when this venue's stream has run without a gap (null = no stream / down). */
  streamSince: (venue: Venue) => number | null;
  /** Deliver a print from the adapter's own stream. */
  onPrint: (p: Print) => void;
  /** The Hyperliquid /info lane (trade.xyz reads its fills from Hyperliquid). */
  hlLane: Lane;
  /**
   * Sockets opened before this start (a handover's standby, handover.ts), already delivering to `onPrint`: used as they
   * are. Left out: the adapter opens its own as before; null: none.
   */
  adopt?: { lighter?: LighterStream | null; arcus?: ArcusStream | null };
}

export interface ExtVenue {
  readonly venue: Venue;
  readonly lane: Lane;
  start(ctx: ExtContext): void;
  stop(): void;
  /** When the adapter's own socket came up (null = no stream or down). */
  socketSince(): number | null;
  /** Its socket's memory of print ids (a handover names them), if it has a socket. */
  dedup?(): Dedup | null;
  /** Called on every board pass: keep the venue's PnL inputs fresh. */
  refresh(now: number): void | Promise<void>;
  /** Whether the PnL behind the window's boards has loaded. */
  sourceReady(window: BoardWindow, now: number): boolean;
  /** How old a pnl_snap row may be and still rank. */
  maxAgeMs(window: BoardWindow): number;
  /** Queue the cheapest read that answers "more than one trade since `from`". */
  queueCheck(address: string, from: number, prio: number): void;
  /**
   * Queue a full read of the address's fills over [from, now]. `catchUpFrom`:
   * the held range stopped following the stream there (a restart or a
   * reconnect) - read [catchUpFrom, now] soon, whatever the resync age.
   */
  queueHistory(address: string, from: number, prio: number, catchUpFrom?: number): void;
  /** Queue a read of the wallet's account value at `prio` (trade.xyz: its xyz margin book). */
  queueAccountValue?(address: string, prio: number): void;
  /** For a venue whose prints name sub-accounts: the wallet behind one (null = not known). */
  addressOf?(acct: string): string | null;
  /** For a venue whose prints name sub-accounts: every one of a wallet's (null = not known yet). */
  accountsOf?(address: string): string[] | null;
  /** A short diagnostics line. */
  status(): Record<string, unknown>;
}
