/**
 * Funding spreads between SoDEX and Hyperliquid.
 *
 * Compact is the strip on Explore. Full is the scanner: every pair, with the
 * rate, the clock, the book, the size of each market, and which leg to long.
 */
import { useEffect, useMemo, useState } from 'react';
import type { Ticker } from '../../api';
import { DASH, fmtCountdown, fmtPct, signClass } from '../../format';
import { useSharedPoll, useSodexOiExcluded, useStored, useSymbols, useTickers } from '../../hooks';
import { vsApi, VENUE_LABEL } from '../../vsApi';
import { CoinIcon } from '../CoinIcon';
import { LoadFailed } from '../LoadFailed';
import { VenueLogo } from '../VenueLogo';
import { fmtPx, fmtUsdShort } from './model';
import {
  buildPairs, filterPairs, fmtInterval, hlLegs, nextUtcHour, sodexLegs, sortPairs,
  type ArbSort, type ArbVenue, type FundLeg, type FundPair,
} from './fundingArb';

const POLL_MS = 30_000;
const COMPACT_ROWS = 6;
const VOL_STEPS = [
  { v: 0, label: 'Any size' },
  { v: 100_000, label: '$100k' },
  { v: 1_000_000, label: '$1M' },
] as const;
const SORTS: { id: ArbSort; label: string }[] = [
  { id: 'apr', label: 'APR' },
  { id: 'spread', label: 'Spread' },
  { id: 'price', label: 'Price' },
  { id: 'volume', label: 'Volume' },
];

const VENUE_WORD: Record<ArbVenue, string> = { sodex: 'SoDEX', hyperliquid: 'Hyperliquid' };

function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}

export function FundingScanner({
  enabled, mode, onOpenSymbol, onOpenScanner,
}: {
  enabled: boolean;
  mode: 'compact' | 'full';
  onOpenSymbol: (symbol: string) => void;
  onOpenScanner?: () => void;
}) {
  // Shared with the markets board above it (and the trade page's tickers): one read each.
  const tickers = useTickers('perps', { pollMs: POLL_MS, enabled });
  const hl = useSharedPoll('vs:screener:assets', () => vsApi.assets(), { pollMs: POLL_MS, enabled });
  // Only the full table shows open interest; the compact card has no such column.
  const oiExcluded = useSodexOiExcluded(enabled && mode === 'full');
  const { symbols, error: symbolError } = useSymbols('perps');
  const now = useNow();
  const [sort, setSort] = useStored<ArbSort>('vs.funding.sort', 'apr');
  const [minVol, setMinVol] = useStored<number>('vs.funding.minVol', 0);
  const [q, setQ] = useState('');
  const sortId: ArbSort = SORTS.some((s) => s.id === sort) ? sort : 'apr';
  const vol = VOL_STEPS.some((s) => s.v === minVol) ? minVol : 0;

  const pairs = useMemo(() => {
    const tickerRows: Ticker[] = tickers.data?.tickers ?? [];
    const legs = [
      ...sodexLegs(symbols, tickerRows, oiExcluded),
      ...hlLegs(hl.data?.assets),
    ];
    const built = buildPairs(legs);
    if (mode === 'compact') return built.slice(0, COMPACT_ROWS);
    return sortPairs(filterPairs(built, { q, minVol: vol }), sortId);
  }, [tickers.data, hl.data, symbols, oiExcluded, mode, q, vol, sortId]);

  const waiting = (!tickers.data && !tickers.error) || (!hl.data && !hl.error) || (symbols.length === 0 && !symbolError);
  const broken = (symbolError && symbols.length === 0) || (!tickers.data && tickers.error)
    ? 'SoDEX markets'
    : !hl.data && hl.error
      ? 'Hyperliquid markets'
      : null;

  return (
    <section className={`ex-band${mode === 'full' ? ' ex-band--full' : ''}`} aria-label="Funding scanner">
      <header className="ex-band__head">
        <div className="ex-band__copy">
          <h2>Funding</h2>
          <p>
            Long the lower rate and short the higher one, on SoDEX and Hyperliquid. The rate is live, scaled to 8 hours, then annualised. A dash is a figure the venue did not publish.
          </p>
        </div>
        {mode === 'compact' && onOpenScanner && (
          <button type="button" className="acct-link" onClick={onOpenScanner}>Open the scanner</button>
        )}
      </header>
      {mode === 'full' && (
        <div className="ex-arb__tools">
          <div className="ex-arb__sort" role="radiogroup" aria-label="Sort spreads">
            {SORTS.map((s) => (
              <button key={s.id} type="button" role="radio" aria-checked={sortId === s.id} className={sortId === s.id ? 'is-on' : ''} onClick={() => setSort(s.id)}>
                {s.label}
              </button>
            ))}
          </div>
          <div className="ex-arb__sort" role="radiogroup" aria-label="Minimum 24h volume on the thinner leg">
            {VOL_STEPS.map((s) => (
              <button key={s.v} type="button" role="radio" aria-checked={vol === s.v} className={vol === s.v ? 'is-on' : ''} onClick={() => setMinVol(s.v)}>
                {s.label}
              </button>
            ))}
          </div>
          <input
            className="ex-arb__find"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Market"
            aria-label="Filter by market"
            spellCheck={false}
          />
        </div>
      )}
      {broken ? (
        <LoadFailed what={broken} onRetry={() => { tickers.refresh(); hl.refresh(); }} />
      ) : waiting ? (
        <p className="ex-arb__empty">Loading…</p>
      ) : pairs.length === 0 ? (
        <p className="ex-arb__empty">No market is listed on both SoDEX and Hyperliquid with a funding rate.</p>
      ) : (
        <div className={`ex-scan${mode === 'compact' ? ' is-compact' : ''}`}>
          <table className="ex-arb">
            <thead>
              <tr>
                <th>Market</th>
                <th>Long</th>
                <th>Short</th>
                <th className="num">Spread /8h</th>
                <th className="num">APR</th>
                <th className="num">Price</th>
                {mode === 'full' && <th className="num">Volume</th>}
                {mode === 'full' && <th className="num">Open interest</th>}
              </tr>
            </thead>
            <tbody>
              {pairs.map((p) => <ArbRow key={p.coin} pair={p} now={now} full={mode === 'full'} onOpenSymbol={onOpenSymbol} />)}
            </tbody>
          </table>
        </div>
      )}
      {(tickers.error && tickers.data) || (hl.error && hl.data) ? (
        <p className="ex-arb__stale">
          The latest refresh failed. These are the previous rates.
          <button type="button" onClick={() => { tickers.refresh(); hl.refresh(); }}>Retry</button>
        </p>
      ) : null}
    </section>
  );
}

function sodexSymbol(pair: FundPair): string | null {
  if (pair.long.venue === 'sodex') return pair.long.symbol;
  if (pair.short.venue === 'sodex') return pair.short.symbol;
  return null;
}

function ArbRow({
  pair, now, full, onOpenSymbol,
}: {
  pair: FundPair;
  now: number;
  full: boolean;
  onOpenSymbol: (symbol: string) => void;
}) {
  const symbol = sodexSymbol(pair);
  const open = symbol ? () => onOpenSymbol(symbol) : null;
  const change = pair.long.venue === 'sodex' ? pair.long.changePct : pair.short.changePct;
  const clocks = pair.long.intervalSec !== pair.short.intervalSec;
  const priceTitle = pair.priceBasis === 'book'
    ? 'Sell the short leg at its bid and buy the long leg at its ask.'
    : pair.priceBasis === 'mark'
      ? 'Mark to mark. One venue did not publish a bid and an ask, so this is not an executable entry.'
      : 'Neither venue published a price.';
  return (
    <tr
      className={open ? 'is-link' : undefined}
      onClick={open ?? undefined}
      onKeyDown={open ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } } : undefined}
      tabIndex={open ? 0 : undefined}
      role={open ? 'link' : undefined}
      title={open ? `Long ${VENUE_WORD[pair.long.venue]}, short ${VENUE_WORD[pair.short.venue]}. Trade ${symbol} on SoDEX.` : undefined}
    >
      <td>
        <span className="ex-arb__mkt">
          <CoinIcon coin={pair.label} size={18} />
          <span>
            <span className="ex-arb__name">{pair.label}</span>
            {change != null && <span className={`ex-arb__sub ${signClass(change)}`}>{fmtPct(change)}</span>}
          </span>
        </span>
      </td>
      <td><Leg leg={pair.long} now={now} /></td>
      <td><Leg leg={pair.short} now={now} /></td>
      <td className={`num ${signClass(pair.spread8h)}`} title={clocks ? 'The venues settle on different clocks. Both rates are scaled to 8 hours before the difference.' : 'Both venues settle on the same clock.'}>
        {fmtPct(pair.spread8h * 100, 4)}
      </td>
      <td className={`num ${signClass(pair.apr)}`}>{fmtPct(pair.apr, pair.apr >= 100 ? 0 : 1)}</td>
      <td className="num" title={priceTitle}>
        <span className="ex-arb__stack">
          <span>{fmtPx(pair.long.mark)}</span>
          <span>{fmtPx(pair.short.mark)}</span>
          <span className={signClass(pair.priceSpread)}>{pair.priceSpread == null ? DASH : fmtPct(pair.priceSpread * 100, 3)}</span>
        </span>
      </td>
      {full && (
        <td className="num" title={`${VENUE_WORD[pair.long.venue]} ${fmtUsdShort(pair.long.volumeUsd)} · ${VENUE_WORD[pair.short.venue]} ${fmtUsdShort(pair.short.volumeUsd)}`}>
          <span className="ex-arb__stack">
            <span>{fmtUsdShort(pair.long.volumeUsd)}</span>
            <span>{fmtUsdShort(pair.short.volumeUsd)}</span>
          </span>
        </td>
      )}
      {full && (
        <td className="num" title={`${VENUE_WORD[pair.long.venue]} ${fmtUsdShort(pair.long.oiUsd)} · ${VENUE_WORD[pair.short.venue]} ${fmtUsdShort(pair.short.oiUsd)}`}>
          <span className="ex-arb__stack">
            <span>{fmtUsdShort(pair.long.oiUsd)}</span>
            <span>{fmtUsdShort(pair.short.oiUsd)}</span>
          </span>
        </td>
      )}
    </tr>
  );
}

function Leg({ leg, now }: { leg: FundLeg; now: number }) {
  const next = leg.venue === 'hyperliquid' ? nextUtcHour(now) : leg.nextFundingMs ?? undefined;
  const when = leg.venue === 'hyperliquid'
    ? 'Hyperliquid settles funding every hour, on the hour.'
    : 'Next funding time published by SoDEX.';
  const lev = leg.maxLev != null && leg.maxLev > 0 ? `${leg.maxLev}x max` : null;
  return (
    <span className="ex-arb__leg" title={`${VENUE_LABEL[leg.venue]} ${leg.symbol}. Positive funding means longs pay shorts.${lev ? ` ${lev}.` : ''} ${when}`}>
      <VenueLogo venue={leg.venue} size={14} />
      <span>
        <span className={`ex-arb__rate ${signClass(leg.rate)}`}>
          {fmtPct(leg.rate * 100, 4)}
          <span className="ex-arb__iv">{fmtInterval(leg.intervalSec)}</span>
        </span>
        <span className="ex-arb__sub">{fmtCountdown(next ?? undefined)}</span>
      </span>
    </span>
  );
}
