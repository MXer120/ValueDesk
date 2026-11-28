/**
 * What SoDEX offers right now, so ValueDesk offers the same (owner 2026-11-28: "sodex doesnt show some stuff in the UI
 * ... we need to block that automatically as long as sodex does, e.g. coming soon on buy"). A fund reads as coming
 * soon, with no way in on ValueDesk, when:
 *
 *   SoDEX's own content file has it but not listed (visibility not 'listed', or on no shelf: /api/vs/wealth/listing)
 *   its spot market is not TRADING (SoDEX halts a market: /api/v1/spot/markets/symbols status HALT)
 *   SoDEX marks the fund neither live nor in subscription
 *
 * A fund the content file does not name at all (ANT Believers Index has its own page on sodex.com, the SSI tokens are
 * spot markets) is judged by the other two. Selling or redeeming what a wallet holds stays possible. Read once per five
 * minutes; until read, nothing is blocked (SoDEX's own trading status still applies).
 */
import { readGateway } from './gateway';
import type { WealthFund } from './wealth';

export interface Listing { listed: Map<string, boolean>; spot: Map<string, string> }

let cache: { at: number; p: Promise<Listing> } | null = null;
export function readListing(): Promise<Listing> {
  if (cache && Date.now() - cache.at < 300_000) return cache.p;
  const p = Promise.all([
    fetch('/api/vs/wealth/listing', { signal: AbortSignal.timeout(15_000) }).then((r) => r.json()).catch(() => null) as Promise<{ ok?: boolean; funds?: Record<string, { listed: boolean }> } | null>,
    readGateway<Array<{ name: string; status?: string }>>('/api/v1/spot/markets/symbols').catch(() => null),
  ]).then(([l, s]) => ({
    listed: new Map(Object.entries(l?.ok ? l.funds ?? {} : {}).map(([k, v]) => [k, v.listed === true])),
    spot: new Map((s ?? []).map((m) => [m.name, m.status ?? ''])),
  }));
  cache = { at: Date.now(), p };
  p.catch(() => { cache = null; });
  return p;
}

/** Why SoDEX does not offer this fund now, or null when it does (or when that is not known yet). */
export function comingSoonWhy(f: WealthFund, l: Listing | null): string | null {
  if (!l) return null;
  if (l.listed.get(f.fundId) === false) return 'SoDEX does not list it yet';
  if (f.spot && l.spot.size && (l.spot.get(f.spot.symbol) ?? 'TRADING') !== 'TRADING') return 'SoDEX has halted its market';
  if (f.fundStatus !== 'live' && f.fundStatus !== 'subscription') return 'SoDEX has not opened it';
  return null;
}

/** The funds with `comingSoon` set where SoDEX does not offer them; the same array when nothing changes. */
export function markComingSoon(funds: readonly WealthFund[], l: Listing | null): WealthFund[] {
  let changed = false;
  const out = funds.map((f) => {
    const why = comingSoonWhy(f, l);
    if ((why ?? undefined) === f.comingSoon) return f;
    changed = true;
    return { ...f, comingSoon: why ?? undefined };
  });
  return changed ? out : (funds as WealthFund[]);
}
