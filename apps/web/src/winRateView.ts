/**
 * How a win rate reads on screen: the leaderboard, the cohort wallets table
 * and Scan all go through here, so "≈" and its tooltip mean one thing.
 *
 * The figure and its definition are the server's (apps/server/src/valuedesk/
 * winRate.ts): exact when every close in the window is held, otherwise an
 * estimate from the closes held, published only from WIN_RATE_MIN_CLOSES up.
 * An estimate gets a muted "≈" and says what it is built from. A row from a
 * server that does not send `winRateExact` yet renders as it always did.
 *
 * Pure (no React, no DOM) so it runs under `npx tsx --test`.
 */
import { WIN_RATE_MIN_CLOSES } from '@sign/valuedesk/winRate.js';
import { formatNumber } from './intlCache';

export interface WinRateFields {
  winRate?: number | null;
  /** true = every close in the window; false = an estimate; absent = an older server. */
  winRateExact?: boolean;
  winRateCloses?: number | null;
  /** An estimate's oldest held close (ms). */
  winRateFrom?: number | null;
}

export interface WinRateView {
  /** "62.5%", or the dash. Without the "≈" (the caller styles it). */
  text: string;
  /** Show a muted "≈" in front: the figure is an estimate. */
  approx: boolean;
  /** Tooltip; undefined when there is nothing to add. */
  title: string | undefined;
  /** The leaderboard's colour classes: >= 55% pos, >= 45% warn, else neg; muted for no figure. */
  tone: 'pos' | 'warn' | 'neg' | 'muted';
}

const DASH = '—';

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** "Sep 29, 14:05" in the viewer's time zone. */
export const fmtSince = (ms: number): string =>
  new Date(ms).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

const closesWord = (n: number): string => `${formatNumber(n, 'en-US')} ${n === 1 ? 'close' : 'closes'}`;

/**
 * `context`:
 *  - 'window' (default): a ranked window's figure (leaderboard, cohorts).
 *  - 'sample': a trader profile's recent-fills figure (Scan), which is never
 *    "the window" - it says what it came from instead.
 */
export function winRateView(
  r: WinRateFields,
  o: { dp?: number; context?: 'window' | 'sample'; fmtDate?: (ms: number) => string } = {},
): WinRateView {
  const dp = o.dp ?? 1;
  const fmtDate = o.fmtDate ?? fmtSince;
  const closes = isNum(r.winRateCloses) && r.winRateCloses > 0 ? Math.round(r.winRateCloses) : null;
  const from = isNum(r.winRateFrom) && r.winRateFrom > 0 ? r.winRateFrom : null;
  const v = isNum(r.winRate) ? Math.max(0, Math.min(1, r.winRate)) : null;

  if (v === null) {
    // Not enough closes held for an estimate: say so rather than leave a bare dash.
    const title = r.winRateExact === false && closes !== null && closes < WIN_RATE_MIN_CLOSES
      ? `Only ${closesWord(closes)} held so far. An estimate needs ${WIN_RATE_MIN_CLOSES}.`
      : undefined;
    return { text: DASH, approx: false, title, tone: 'muted' };
  }

  const p = v * 100;
  const tone = p >= 55 ? 'pos' : p >= 45 ? 'warn' : 'neg';
  const text = `${p.toFixed(dp)}%`;

  if (r.winRateExact === false) {
    const since = from !== null ? ` since ${fmtDate(from)}` : '';
    const title = o.context === 'sample'
      ? `From the last ${closes !== null ? closesWord(closes) : 'closes'}${since}.`
      : `Estimate from the last ${closes !== null ? `${closes.toLocaleString('en-US')} closed trades` : 'closed trades'} held${from !== null ? ` (since ${fmtDate(from)})` : ''}. The full window is still being read.`;
    return { text, approx: true, title, tone };
  }
  // A profile's sample has no window to be complete over; the caller keeps its own hint.
  if (r.winRateExact === true && o.context !== 'sample') {
    return { text, approx: false, title: `Every close in the window${closes !== null ? ` (${closesWord(closes)})` : ''}.`, tone };
  }
  return { text, approx: false, title: undefined, tone };
}
