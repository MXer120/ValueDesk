/**
 * What the shell's one-line maintenance banner says, or null for silence.
 *
 * The server's verdict is used as given, never re-derived: it sets
 * `maintenance` only on evidence - a status SoDEX declared, or a real HTTP 503
 * from a SoDEX host - and leaves it false, with `status: null`, when the status
 * service could not be reached at all (routes/external.ts). "We could not ask"
 * is not "the exchange is down": a banner that read `status !== 'NORMAL'`
 * showed a maintenance warning on every page whenever that one request failed.
 */
export interface MaintenanceVerdict {
  maintenance: boolean;
  reason: 'status' | 'http-503' | null;
  status: string | null;
}

export function bannerMessage(s: MaintenanceVerdict | null | undefined): string | null {
  if (!s || !s.maintenance) return null;
  if (s.reason === 'http-503') return 'A SoDEX service is returning HTTP 503, which usually means maintenance.';
  return s.status === 'CHAIN_MAINTENANCE'
    ? 'SoDEX reports chain maintenance. Deposits and withdrawals may be unavailable.'
    : 'SoDEX reports maintenance. Trading may be unavailable.';
}
