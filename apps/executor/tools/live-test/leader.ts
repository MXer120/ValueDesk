/**
 * THE LEADER the copy scenarios follow: a wallet the owner controls, traded by
 * the harness itself (real IOCs) so the follower has a real trade to copy. It
 * trades on one of the two venues a copy can follow (LIVE_LEADER_VENUE):
 *
 *   sodex        (default) a second SoDEX wallet, its IOCs signed by the
 *                harness's own one-day API key on it (exchange.ts): what the
 *                suite always did. Its fills are on SoDEX's clock, as the
 *                follower's copies are.
 *   hyperliquid  a Hyperliquid wallet, its IOCs signed by its own master key
 *                (hyperliquid.ts: only IOCs, cancels and leverage changes can be
 *                signed there). The copier hears of its fills from
 *                Hyperliquid's userFills stream; its fills are on Hyperliquid's
 *                clock, the copies on SoDEX's.
 *
 * Its markets are named as its venue names them ('BTC-USD' on SoDEX, 'BTC' on
 * Hyperliquid): `symbolFor` gives the leader's market of a SoDEX market. The
 * cleanup flattens it like the follower (cleanup.ts FlattenVenue); a
 * Hyperliquid leader is flattened on every coin it holds or has an order on,
 * so a coin only a Hyperliquid scenario trades (kPEPE, one SoDEX does not
 * list) is cleared too - also after a crash.
 */
import type { LeaderVenue as VenueName } from '../../../../packages/copy-engine/src/index.ts';
import type { FlattenVenue, VenueOrder } from './cleanup.ts';
import type { FillInfo, SodexWallet } from './exchange.ts';
import { HL_MIN_ORDER_USD, hlCoinOf, type HyperliquidExchange } from './hyperliquid.ts';

export type LeaderVenueName = VenueName;
export const LEADER_VENUES: readonly LeaderVenueName[] = ['sodex', 'hyperliquid'];

/** LIVE_LEADER_VENUE: sodex (default) or hyperliquid. */
export function leaderVenueOf(v: string | undefined): LeaderVenueName {
  const x = (v ?? '').trim().toLowerCase() || 'sodex';
  if (!(LEADER_VENUES as readonly string[]).includes(x)) throw new Error(`LIVE_LEADER_VENUE must be ${LEADER_VENUES.join(' or ')} (got "${v}")`);
  return x as LeaderVenueName;
}

/** The env file's key of the leader's wallet on a venue. */
export const leaderKeyName = (venue: LeaderVenueName): string => (venue === 'hyperliquid' ? 'LIVE_HL_LEADER_KEY' : 'LIVE_LEADER_KEY');

/** A trade the leader made: the id its fills carry, and when this machine sent it and had the answer (for the clocks). */
export interface LeaderTrade {
  /** SoDEX: the client order id; Hyperliquid: the order id. */
  ref: string;
  sentAt: number;
  answeredAt: number;
}

export interface LeaderVenue extends FlattenVenue {
  /** What a copy's settings name as the leader's venue (CopySettings.leader.venue). */
  readonly venue: LeaderVenueName;
  readonly address: string;
  /** Where its account is, for the log. */
  readonly where: string;
  /** The leader's market of a SoDEX market: the same name on SoDEX, the coin on Hyperliquid ('BTC-USD' -> 'BTC'). */
  symbolFor(sodexSymbol: string): string;
  /** Before the run: its account there (an error if it has none) and what it is worth, USD. */
  preflight(): Promise<{ account: string; equity: number }>;
  /** Ready to trade (SoDEX: the harness's own one-day key registered on it). */
  prepare(): Promise<void>;
  /** The account value the copier sizes a proportional copy by. */
  equity(): Promise<number>;
  /** The price its notional is valued at: SoDEX's mark; Hyperliquid's mid. */
  mark(symbol: string): Promise<number>;
  /** An IOC worth `usd` at the touch (at least the venue's minimum order value). */
  buyUsd(symbol: string, usd: number): Promise<LeaderTrade>;
  sellUsd(symbol: string, usd: number): Promise<LeaderTrade>;
  /** Its fills of a market since `since`, by its venue's clock. */
  fills(symbol: string, since: number): Promise<FillInfo[]>;
}

/* -------------------------------------------------------------------- SoDEX ----- */

/** A SoDEX leader: the second wallet, traded with the harness's own key (what the suite always did). */
export class SodexLeader implements LeaderVenue {
  readonly venue = 'sodex' as const;
  readonly name = 'leader';
  readonly where = 'SoDEX';

  constructor(readonly wallet: SodexWallet) {}

  get address(): string {
    return this.wallet.address;
  }

  symbolFor(sodexSymbol: string): string {
    return sodexSymbol;
  }

  async preflight(): Promise<{ account: string; equity: number }> {
    if (!(await this.wallet.load())) throw new Error(`leader ${this.address} has no SoDEX account: deposit USDC on SoDEX first`);
    return { account: `account ${this.wallet.accountId}`, equity: await this.equity() };
  }

  async prepare(): Promise<void> {
    await this.wallet.ownKey('vd-livetest-leader');
  }

  async equity(): Promise<number> {
    return (await this.wallet.reads.equity(this.address)).equity;
  }

  async mark(symbol: string): Promise<number> {
    return (await this.wallet.reads.quote(symbol)).mark;
  }

  private async trade(symbol: string, side: 'buy' | 'sell', usd: number): Promise<LeaderTrade> {
    const sentAt = Date.now();
    const r = await this.wallet.iocUsd(symbol, side, usd, { tag: 'leader' });
    return { ref: r.clOrdID, sentAt, answeredAt: Date.now() };
  }

  buyUsd(symbol: string, usd: number): Promise<LeaderTrade> {
    return this.trade(symbol, 'buy', usd);
  }

  sellUsd(symbol: string, usd: number): Promise<LeaderTrade> {
    return this.trade(symbol, 'sell', usd);
  }

  fills(symbol: string, since: number): Promise<FillInfo[]> {
    return this.wallet.reads.fills(this.address, symbol, since);
  }

  openOrders(symbol: string): Promise<VenueOrder[]> {
    return this.wallet.openOrders(symbol);
  }

  position(symbol: string): Promise<number> {
    return this.wallet.position(symbol);
  }

  cancel(symbol: string, orders: VenueOrder[]): Promise<void> {
    return this.wallet.cancel(symbol, orders);
  }

  close(symbol: string, size: number): Promise<void> {
    return this.wallet.close(symbol, size);
  }
}

/* -------------------------------------------------------------- Hyperliquid ----- */

/** How far past the touch a leader's IOC may fill (bp), and a close (reduce-only, it must go). */
const OPEN_SLIP_BPS = 30;
const CLOSE_SLIP_BPS = 100;
/** The leverage the leader holds its positions at: the budget's margin is costed at 2x. */
const LEADER_LEVERAGE = 2;

/** A Hyperliquid leader: its own master key signs its IOCs (and nothing but IOCs, cancels and leverage). */
export class HyperliquidLeader implements LeaderVenue {
  readonly venue = 'hyperliquid' as const;
  readonly name = 'leader';
  readonly where = 'Hyperliquid';
  /** Coins whose leverage was set this run (once per coin, before its first trade). */
  private levered = new Set<string>();

  constructor(
    readonly ex: HyperliquidExchange,
    private readonly log: (line: string) => void = () => undefined,
  ) {}

  get address(): string {
    return this.ex.address;
  }

  private get info() {
    return this.ex.info;
  }

  symbolFor(sodexSymbol: string): string {
    return hlCoinOf(sodexSymbol);
  }

  async preflight(): Promise<{ account: string; equity: number }> {
    return { account: 'Hyperliquid perps', equity: await this.equity() };
  }

  async prepare(): Promise<void> {
    /* nothing to register: the master key signs its own orders */
  }

  async equity(): Promise<number> {
    return (await this.info.state(this.address)).accountValue;
  }

  async mark(symbol: string): Promise<number> {
    return (await this.info.book(symbol)).mid;
  }

  /**
   * The leverage the budget assumes, set once per coin before its first trade
   * (cross where the coin allows it). A refusal is noted, not fatal: the order
   * then goes out at the leverage the account already has on the coin.
   */
  private async lever(coin: string): Promise<void> {
    if (this.levered.has(coin)) return;
    this.levered.add(coin);
    const a = await this.info.asset(coin);
    try {
      await this.ex.updateLeverage(coin, LEADER_LEVERAGE, !a.onlyIsolated);
    } catch (e) {
      this.log(`    . the leader's leverage on ${coin} could not be set (${String(e).slice(0, 120)}): it trades at what the account has`);
    }
  }

  private async trade(coin: string, side: 'buy' | 'sell', usd: number): Promise<LeaderTrade> {
    await this.lever(coin);
    const a = await this.info.asset(coin);
    const b = await this.info.book(coin);
    const touch = side === 'buy' ? b.ask : b.bid;
    const step = 10 ** -a.szDecimals;
    // Rounded UP to the step from at least the minimum order value, so it is never under it.
    const size = Math.ceil(Number((Math.max(usd, HL_MIN_ORDER_USD * 1.05) / touch / step).toPrecision(12))) * step;
    const price = touch * (1 + ((side === 'buy' ? 1 : -1) * OPEN_SLIP_BPS) / 10_000);
    const sentAt = Date.now();
    const f = await this.ex.ioc(coin, side === 'buy', size, price, false);
    return { ref: String(f.oid), sentAt, answeredAt: Date.now() };
  }

  buyUsd(coin: string, usd: number): Promise<LeaderTrade> {
    return this.trade(coin, 'buy', usd);
  }

  sellUsd(coin: string, usd: number): Promise<LeaderTrade> {
    return this.trade(coin, 'sell', usd);
  }

  async fills(coin: string, since: number): Promise<FillInfo[]> {
    return (await this.info.fills(this.address, since)).filter((f) => f.coin === coin && f.time >= since - 1_000);
  }

  /* ------------------------------------------- FlattenVenue (cleanup) ----- */

  /** The test markets as its coins (those Hyperliquid lists), and every coin it holds or has an order on (a coin only a Hyperliquid scenario trades). */
  async markets(symbols: readonly string[]): Promise<string[]> {
    const [st, orders, assets] = await Promise.all([this.info.state(this.address), this.info.openOrders(this.address), this.info.assets()]);
    const listed = new Set(assets.map((a) => a.name));
    return [...new Set([...symbols.map((s) => this.symbolFor(s)).filter((c) => listed.has(c)), ...Object.keys(st.positions), ...orders.map((o) => o.coin)])];
  }

  async openOrders(coin: string): Promise<VenueOrder[]> {
    return (await this.info.openOrders(this.address)).filter((o) => o.coin === coin).map(({ coin: _c, ...o }) => o);
  }

  async position(coin: string): Promise<number> {
    return (await this.info.state(this.address)).positions[coin] ?? 0;
  }

  async cancel(coin: string, orders: VenueOrder[]): Promise<void> {
    const oids = orders.map((o) => Number(o.orderId)).filter((o) => Number.isSafeInteger(o) && o > 0);
    await this.ex.cancel(coin, oids).catch((e) => {
      // An order that filled or was cancelled meanwhile is not an error; the next read says.
      if (!/never placed|already canceled|already filled|not found/i.test(String(e))) throw e;
    });
  }

  async close(coin: string, size: number): Promise<void> {
    if (!size) return;
    const b = await this.info.book(coin);
    const sell = size > 0;
    const price = sell ? b.bid * (1 - CLOSE_SLIP_BPS / 10_000) : b.ask * (1 + CLOSE_SLIP_BPS / 10_000);
    await this.ex.ioc(coin, !sell, Math.abs(size), price, true);
  }
}
