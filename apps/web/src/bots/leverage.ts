/**
 * A bot's leverage (owner 2026-11-08: "make it possible to change leverage bot uses"): the market's maximum, what SoDEX
 * holds for the account on the market now, and whether a position is open there.
 *
 * Verified live (live-test liquidation runs, 2026-10-30/31: ETH, BTC and SOL at 2x isolated with a position open, set to
 * 40x / 10x): SoDEX takes a HIGHER leverage on an open position, and the position's margin stays as it was. A lower one,
 * or another margin mode, on an open position is not verified: the settings say so beside the choice.
 */
import { api } from '../api';
import { useAccountResource } from '../accountFeeds';
import { useSymbols } from '../hooks';
import { accountLeverage } from '../trading/accountLeverage';

export interface BotLeverage {
  /** The market's maximum (SoDEX's symbol list); null while unknown. */
  max: number | null;
  /** What SoDEX uses for this account on the market now (an open position's own first), or null. */
  held: number | null;
  /** SoDEX's starting leverage for a market the account never set. */
  init: number | null;
  /** A position is open on the market now. */
  open: boolean;
}

type Row = Record<string, unknown>;

/** Whether the account holds a position on `symbol` (perps account state, P[]). */
export function hasOpenPosition(state: unknown, symbol: string): boolean {
  const p = (state as { P?: unknown } | null)?.P;
  return Array.isArray(p) && p.some((x) => x && typeof x === 'object' && String((x as Row).s ?? (x as Row).symbol ?? '') === symbol && Number((x as Row).sz ?? (x as Row).size ?? 0) !== 0);
}

export function useBotLeverage(address: string | null, symbol: string): BotLeverage {
  const { byName } = useSymbols('perps');
  const sym = byName.get(symbol);
  const key = address ? `state:perps:${address}` : null;
  const acct = useAccountResource(key, () => api.state('perps', address!), 20_000);
  const state = (acct.data as { state?: unknown } | null)?.state;
  return {
    max: sym?.maxLeverage ?? null,
    init: sym?.initLeverage ?? null,
    held: accountLeverage(state, symbol)?.leverage ?? null,
    open: hasOpenPosition(state, symbol),
  };
}
