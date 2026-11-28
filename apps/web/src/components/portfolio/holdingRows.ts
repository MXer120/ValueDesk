/**
 * A fund's holdings as a reader can take them in (owner 2026-11-28: "ValueDesk Cash Yield for example has 0% and
 * negative ones"). US Cash Yield (vBOXX) holds box spreads: four option legs per box, long and short, worth about 0 or
 * less than 0 each and about the fund's whole value together; and a little cash, partly owed. Listed one by one they
 * read as "SPY 12/18/2026 10.01 P 0%" and "QQQ ... -1.6%".
 *
 *   - option legs (OCC-style "SPY 12/18/2026 10.01 P" names or "2SPY 261218P..." tickers) become one row,
 *     "Box spreads: SPY, QQQ options", their weights summed;
 *   - cash lines (Cash & Other, government / treasury money market funds) become "Cash and money market";
 *   - what is left at or below 0.05% after that, and any group that nets below zero, is not a row. What it nets to is
 *     given back as `netted` so the page can say so instead of hiding it.
 *
 * The weights still add up to what the fund reported: nothing is dropped from the sum without being named in `netted`.
 */
export interface HoldingRow { name: string; ticker: string | null; weight: number }

const OPTION_NAME = /^([A-Z.]{1,6})\s+\d{2}\/\d{2}\/\d{4}\s+[\d.]+\s+[CP]$/;
const OPTION_TICKER = /^\d?([A-Z.]{1,6})\s+\d{6}[CP]\d{8}$/;
const CASH = /^(cash\b|cash\s*&|cash and)|government obli|treasury obli|money market|\bt-?bill fund/i;
const CASH_TICKERS = new Set(['FGXXX', 'FTXXX', 'SPAXX', 'VMFXX', 'SWVXX', 'CASH&OTHER', 'USD']);
const SHOWN_MIN = 0.0005;

const underlyingOf = (r: HoldingRow): string | null => r.name.match(OPTION_NAME)?.[1] ?? r.ticker?.replace(/\s+/g, ' ').match(OPTION_TICKER)?.[1] ?? null;
const isCash = (r: HoldingRow): boolean => CASH.test(r.name) || (!!r.ticker && CASH_TICKERS.has(r.ticker.replace(/\s+/g, '').toUpperCase()));

export function tidyHoldings(rows: readonly HoldingRow[]): { rows: HoldingRow[]; netted: number } {
  const out: HoldingRow[] = [];
  const under: string[] = [];
  let options = 0, optionLegs = 0, cash = 0, cashLines = 0, netted = 0;
  for (const r of rows) {
    const u = underlyingOf(r);
    if (u) { options += r.weight; optionLegs++; if (!under.includes(u)) under.push(u); continue; }
    if (isCash(r)) { cash += r.weight; cashLines++; continue; }
    if (r.weight > SHOWN_MIN) out.push(r); else netted += r.weight;
  }
  const group = (name: string, w: number, n: number) => {
    if (!n) return;
    if (w > SHOWN_MIN) out.push({ name, ticker: null, weight: w }); else netted += w;
  };
  group(`Box spreads: ${under.join(', ')} options`, options, optionLegs);
  group('Cash and money market', cash, cashLines);
  out.sort((a, b) => b.weight - a.weight);
  return { rows: out, netted: Math.abs(netted) < 1e-9 ? 0 : netted };
}
