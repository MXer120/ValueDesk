/**
 * The shared price oracle as the browser reads it: through our API's
 * GET /api/vs/oracle (server routes/oracle.ts), never from the venues
 * directly (no venue host is in the CSP or the privacy policy for it).
 *
 * One venue chosen, the API gives its quote; several, only their combined mid
 * and fair price (no venue's own quote leaves the server). Either way the read
 * becomes quotes the engine's combineOracle understands: for a combined price,
 * one per venue it is made of, each carrying that combined price, so their
 * median is it again.
 *
 * The server stamps the age; here `at` is re-made from that age on this clock,
 * so a skewed clock never makes a price look fresh or stale.
 */
import { useEffect, useState } from 'react';
import { ORACLE_VENUES, combineOracle, type OracleCombined, type OracleVenue, type VenueQuote } from '@copy-engine';

export interface OracleRead {
  quotes: VenueQuote[];
  /** Venues the server found stale or could not read (a combined answer names them; its quotes are not handed out). */
  stale: OracleVenue[];
  missing: OracleVenue[];
  /** When this browser received it. */
  at: number;
}

type Answer = {
  ok?: boolean;
  error?: string;
  quotes?: Array<VenueQuote & { ageMs?: number }>;
  mid?: number | null;
  fair?: number | null;
  used?: OracleVenue[];
  stale?: OracleVenue[];
  missing?: OracleVenue[];
  ageMs?: number | null;
};

/** The API's answer as quotes (exported for tests). */
export function quotesOf(j: Answer, now: number): VenueQuote[] {
  if (Array.isArray(j.quotes)) {
    return j.quotes.map((q) => ({ venue: q.venue, bid: Number(q.bid), ask: Number(q.ask), mid: Number(q.mid), mark: q.mark === null ? null : Number(q.mark), at: now - Math.max(0, Number(q.ageMs) || 0) }));
  }
  const mid = Number(j.mid);
  if (!(mid > 0) || !j.used?.length) return [];
  const fair = Number(j.fair) > 0 ? Number(j.fair) : mid;
  const at = now - Math.max(0, Number(j.ageMs) || 0);
  return j.used.map((venue) => ({ venue, bid: mid, ask: mid, mid, mark: fair, at }));
}

export async function readOracle(coin: string, venues: readonly OracleVenue[] = ORACLE_VENUES): Promise<OracleRead> {
  const all = venues.length === ORACLE_VENUES.length && ORACLE_VENUES.every((v) => venues.includes(v));
  const r = await fetch(`/api/vs/oracle?coin=${encodeURIComponent(coin)}${all ? '' : `&venues=${venues.join(',')}`}`);
  const j = (await r.json().catch(() => null)) as Answer | null;
  if (!j?.ok) throw new Error(j?.error ?? `The oracle did not answer (${r.status})`);
  const now = Date.now();
  return { at: now, quotes: quotesOf(j, now), stale: Array.isArray(j.stale) ? j.stale : [], missing: Array.isArray(j.missing) ? j.missing : [] };
}

/** The coin of a SoDEX symbol ('BTC-USD' -> 'BTC'). */
export const coinOf = (symbol: string): string => symbol.replace(/-USD$/i, '').toUpperCase();

/** The oracle for a coin over the chosen venues, read every 2 s while `on` (the Fill fast ticket's live band). */
export function useOracle(coin: string | null, venues: readonly OracleVenue[], on: boolean): (OracleCombined & { quotes: VenueQuote[] }) | null {
  const [read, setRead] = useState<OracleRead | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const venueKey = [...venues].sort().join(',');
  useEffect(() => {
    if (!on || !coin) {
      setRead(null);
      return;
    }
    let gone = false;
    const pull = () =>
      readOracle(coin, venues)
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
    // venueKey stands for `venues`, a new array each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coin, on, venueKey]);
  if (!read) return null;
  const c = combineOracle(read.quotes, now, { venues });
  // The server's word on the venues it did not use: a combined answer carries no quotes for them.
  const stale = [...new Set([...c.stale, ...read.stale.filter((v) => venues.includes(v) && !c.used.includes(v))])];
  const missing = c.missing.filter((v) => !stale.includes(v) && (read.missing.includes(v) || !c.used.includes(v)));
  return { ...c, stale, missing, quotes: read.quotes };
}
