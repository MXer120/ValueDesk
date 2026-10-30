/**
 * The heatmap's coverage line per venue (LiqHeatmap.tsx Coverage): what share of the venue's open
 * interest the books hold, how much of it has a liquidation price, and how well the prices track
 * the venue's own between reads.
 *
 * Honest labels (audit 2026-10-30):
 *   - "% exact" was the share of venue figures the model reproduced AT A READ - near 100% by
 *     construction (the read sets the cash from the venue's own figure). What a viewer needs is
 *     the drift BETWEEN reads: the book's figure against the venue's next one. SoDEX showed "100%
 *     exact" while 26.5% of its figures were within 0.1% at the next read (94.8% by USD within 1%).
 *   - "% priced" counted a position with no liquidation price at all (a 1x long the account carries
 *     to zero) as not known. It is known: it never liquidates. Only the rest is unknown.
 */
import type { LiqHeatmap } from '@sign/indexer/liqRead.js';

type Cov = NonNullable<LiqHeatmap['coverage'][keyof LiqHeatmap['coverage']]>;

const pct1 = (x: number) => `${(Math.round(x * 1000) / 10).toFixed(1)}%`;
const pct0 = (x: number) => `${Math.round(x * 100)}%`;

export interface CoverageText {
  /** "86% of OI", or ">100% of OI" past 105%. */
  share: string;
  /** "97% priced" among positions that can be liquidated; null when all are (or nothing is held). */
  priced: string | null;
  /** The accuracy label: "77% ≤0.1%" (drift between reads), "computed", or "checking". */
  accuracy: string;
  /** Tooltip lines. */
  lines: string[];
}

export function coverageText(c: Cov, venueName: string, coin: string, fmtSize: (v: number) => string): CoverageText {
  const held = (c.long + c.short) / 2;
  const share = c.oi ? held / c.oi : null;
  const none = (c.longNone ?? 0) + (c.shortNone ?? 0);
  const total = c.long + c.short;
  const liquidatable = total - none;
  const known = liquidatable > 0 ? (c.longKnown + c.shortKnown) / liquidatable : null;
  const acc = c.accuracy;
  const lines: string[] = [];
  lines.push(`${venueName} ${coin}: the books hold ${fmtSize(c.long)} long and ${fmtSize(c.short)} short in ${c.positions} positions`);
  if (c.past > 0) lines.push(`${fmtSize(c.past)} ${coin} more is past its liquidation price (being liquidated, or a book not caught up yet): not in the bars, read again first`);
  lines.push(c.oi !== null ? `against open interest of ${fmtSize(c.oi)} ${coin}${c.oiUsd ? ` (${c.oiUsd >= 1e6 ? `$${(c.oiUsd / 1e6).toFixed(1)}M` : `$${Math.round(c.oiUsd).toLocaleString('en-US')}`})` : ''}` : 'open interest unavailable');
  if (none > 0) lines.push(`${fmtSize(none)} ${coin} (${pct1(total > 0 ? none / total : 0)}) has no liquidation price: the account carries it to zero`);
  if (known !== null) lines.push(`${pct1(known)} of the rest has a known liquidation price${known < 0.995 ? ' (the others are not read yet)' : ''}`);
  if (c.computed) lines.push(`${venueName} publishes no liquidation price: computed from its maintenance margin rules`);
  let accuracy = c.computed ? 'computed' : 'checking';
  if (acc && acc.n > 0) {
    const when = acc.window === 'today' ? 'today' : 'yesterday';
    accuracy = `${pct0(acc.within01 / acc.n)} ≤0.1%`;
    lines.push(`Between reads ${when}: ${acc.n.toLocaleString('en-US')} figures against the venue's next one - ${pct1(acc.within01 / acc.n)} within 0.1%, ${pct1(acc.within1 / acc.n)} within 1%, ${pct1(acc.within5 / acc.n)} within 5%`);
    if (acc.usd > 0) {
      const byUsd = [acc.usd01 !== undefined ? `${pct1(acc.usd01 / acc.usd)} within 0.1%` : null, `${pct1(acc.usd1 / acc.usd)} within 1%`].filter(Boolean).join(', ');
      lines.push(`Weighted by USD: ${byUsd}`);
    }
    if (acc.moved > 0) lines.push(`${acc.moved.toLocaleString('en-US')} positions had changed size by the next read`);
  }
  if (acc && acc.checked > 0) lines.push(`At reads: ${acc.matched.toLocaleString('en-US')} of ${acc.checked.toLocaleString('en-US')} venue figures reproduced to 0.01%`);
  if (c.noRules) lines.push('The market list could not be read: no levels');
  return {
    share: share === null ? 'OI –' : `${share > 1.05 ? '>100' : Math.round(share * 100)}% of OI`,
    priced: known !== null && known < 0.995 ? `${Math.round(known * 100)}% priced` : null,
    accuracy,
    lines,
  };
}
