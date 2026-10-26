/**
 * The shared price oracle as the browser reads it: through our API's
 * GET /api/vs/oracle (server routes/oracle.ts), never from the venues
 * directly (no venue host is in the CSP or the privacy policy for it).
 *
 * The server stamps each quote with its age; here `at` is re-made from that
 * age on this clock, so a skewed clock never makes a quote look fresh or stale.
 */
import { useEffect, useState } from 'react';
import { ORACLE_VENUES, combineOracle, type OracleCombined, type OracleVenue, type VenueQuote } from '@copy-engine';

export interface OracleRead {
  quotes: VenueQuote[];
  /** When this browser received it. */
  at: number;
}

export async function readOracle(coin: string, venues: readonly OracleVenue[] = ORACLE_VENUES): Promise<OracleRead> {
  const all = venues.length === ORACLE_VENUES.length && ORACLE_VENUES.every((v) => venues.includes(v));
  const r = await fetch(`/api/vs/oracle?coin=${encodeURIComponent(coin)}${all ? '' : `&venues=${venues.join(',')}`}`);
  const j = (await r.json().catch(() => null)) as { ok?: boolean; error?: string; quotes?: Array<VenueQuote & { ageMs?: number }> } | null;
  if (!j?.ok || !Array.isArray(j.quotes)) throw new Error(j?.error ?? `The oracle did not answer (${r.status})`);
  const now = Date.now();
  return {
    at: now,
    quotes: j.quotes.map((q) => ({ venue: q.venue, bid: Number(q.bid), ask: Number(q.ask), mid: Number(q.mid), mark: q.mark === null ? null : Number(q.mark), at: now - Math.max(0, Number(q.ageMs) || 0) })),
  };
}

/** The coin of a SoDEX symbol ('BTC-USD' -> 'BTC'). */
export const coinOf = (symbol: string): string => symbol.replace(/-USD$/i, '').toUpperCase();

/** The oracle for a coin, read every 2 s while `on` (the Fill fast ticket's live band). */
export function useOracle(coin: string | null, venues: readonly OracleVenue[], on: boolean): (OracleCombined & { quotes: VenueQuote[] }) | null {
  const [read, setRead] = useState<OracleRead | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on || !coin) {
      setRead(null);
      return;
    }
    let gone = false;
    const pull = () =>
      readOracle(coin)
        .then((r) => !gone && setRead(r))
        .catch(() => {
          /* keep the last read: its quotes age out on their own */
        })
        .finally(() => !gone && setNow(Date.now()));
    void pull();
    const t = window.setInterval(pull, 2_000);
    return () => {
      gone = true;
      window.clearInterval(t);
    };
  }, [coin, on]);
  if (!read) return null;
  return { ...combineOracle(read.quotes, now, { venues }), quotes: read.quotes };
}
