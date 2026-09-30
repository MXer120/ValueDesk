/**
 * Symbol search: click the ticker symbol, press ⌘K/Ctrl+K, or just start
 * typing outside a field. Pulls symbols+tickers for both engines so search
 * and the Spot/Futures tabs work regardless of which engine is currently
 * selected. Favorites persist to localStorage, same pattern as useStored.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { api, type Engine, type Symbol, type Ticker } from '../api';
import { useAsync, useStored } from '../hooks';
import { aliasFor, resolveTarget } from '../dashboard/ScanDashboard';
import { fmtPct, fmtPrice, fmtUsd, num, signClass } from '../format';
import { usePrivacy } from '../privacy';
import { type Venue } from '../vsApi';
import { CoinIcon } from './CoinIcon';
import {
  overviewCards, overviewLead, useAddressVenues, VENUE_CHECK,
} from './scan/addressVenues';
import { VenueChooser } from './scan/VenueChooser';

interface Row { engine: Engine; symbol: Symbol; ticker?: Ticker; key: string; }

type Category = 'home' | 'all' | 'spot' | 'futures' | 'commodities' | 'stocks' | 'indexes';
type SortKey = 'pair' | 'last' | 'change' | 'funding' | 'volume' | 'oi';

const CATEGORIES: { key: Category; label: string }[] = [
  { key: 'home', label: 'Home' },
  { key: 'all', label: 'All' },
  { key: 'spot', label: 'Spot' },
  { key: 'futures', label: 'Futures' },
  { key: 'commodities', label: 'Commodities' },
  { key: 'stocks', label: 'Stocks' },
  { key: 'indexes', label: 'Indexes' },
];

/**
 * Asset class per base coin. The API's Symbol type carries no such field (it
 * only distinguishes spot vs. perps engines), so this is a client-maintained
 * map of the real, recognizable tickers on this exchange - not sourced from
 * any endpoint. Anything not listed here (the crypto majority) falls back to
 * "crypto" and stays out of the Commodities/Stocks/Indexes tabs.
 */
const COMMODITY_COINS = new Set(['XAUT', 'SILVER', 'COPPER', 'CL', 'LIT']);
const INDEX_COINS = new Set(['US500', 'USTECH100']);
const STOCK_COINS = new Set([
  'AAPL', 'AMD', 'AMZN', 'COIN', 'CRCL', 'EWY', 'GOOGL', 'HOOD', 'INTC', 'META', 'MRVL', 'MSFT',
  'MSTR', 'MU', 'NVDA', 'ORCL', 'PLTR', 'SAMSUNG', 'SNDK', 'SPCX', 'TSLA', 'TSM', 'UNITREE', 'ZHIPU',
]);
type AssetClass = 'commodities' | 'stocks' | 'indexes' | 'crypto';
const assetClass = (baseCoin: string): AssetClass => {
  const c = baseCoin.toUpperCase();
  if (COMMODITY_COINS.has(c)) return 'commodities';
  if (INDEX_COINS.has(c)) return 'indexes';
  if (STOCK_COINS.has(c)) return 'stocks';
  return 'crypto';
};

const FEATURED_COUNT = 8;

/**
 * Sort by exactly what the column DISPLAYS - `quoteVolume ?? volume`, not raw
 * `volume` alone. The two disagree by orders of magnitude: a sub-cent token's
 * raw unit count dwarfs its real USD size (measured: a spot meme pair topped
 * the raw-volume ranking at 72M units while carrying $0 of the real top-10 USD
 * volume, and BTC-USD - $26.8M quoteVolume, the single largest market - did
 * not place in the raw-volume top 8 at all). Sorting on the field nobody sees
 * silently buried every major perp beneath spot's highest-unit-count pairs,
 * which is what "futures is hidden" and "sorting doesn't work" both were.
 */
/**
 * The gateway reports open interest in BASE units, not notional - the same
 * fact Market.tsx's own `oi` stat had to correct for (see the comment on its
 * `case 'oi'`). Converted here with the row's own mark price (falling back
 * to last, since spot rows and a freshly-listed perp with no mark yet both
 * lack one) so this column and its sort agree with each other and with the
 * header stat, rather than each guessing independently.
 */
const oiUsd = (r: Row): number => num(r.ticker?.openInterest) * num(r.ticker?.markPrice ?? r.ticker?.lastPx);

const SORT_VALUE: Record<SortKey, (r: Row) => number | string> = {
  pair: (r) => r.symbol.displayName,
  last: (r) => num(r.ticker?.lastPx),
  change: (r) => r.ticker?.changePct ?? -Infinity,
  funding: (r) => num(r.ticker?.fundingRate),
  volume: (r) => num(r.ticker?.quoteVolume ?? r.ticker?.volume),
  oi: (r) => oiUsd(r),
};

/**
 * Annualised funding, derived from the symbol's OWN reported interval - never
 * assumed. Every symbol on this venue currently reports 3600 (seconds, i.e.
 * hourly funding - confirmed against all 95 live perps symbols, not inferred
 * from one), but the venue's own field is what decides periods-per-year here
 * rather than a hardcoded "funding is hourly" that would silently go wrong the
 * day one symbol differs. No `fundingInterval` (spot has none) or no
 * `fundingRate` (a fresh symbol with nothing published yet) means no APR line,
 * not a guessed one.
 */
const SECONDS_PER_YEAR = 365 * 24 * 3600;
const fundingApr = (fundingRate: string | undefined, fundingInterval: number | undefined): number | null => {
  if (fundingRate === undefined || !fundingInterval) return null;
  return num(fundingRate) * (SECONDS_PER_YEAR / fundingInterval) * 100;
};

export function SymbolSearch({
  open, initialQuery, onClose, onSelect, favorites, onToggleFavorite, onScanAddress,
}: {
  open: boolean;
  /** Seeds the search box, e.g. when the user opened this by typing outside a field. */
  initialQuery?: string;
  onClose: () => void;
  onSelect: (engine: Engine, symbolName: string) => void;
  /**
   * Scan an address. PURELY ADDITIVE: when omitted, this palette behaves exactly
   * as it always has and the address row never appears. Nothing about symbol
   * search is gated on it.
   *
   * `venue` is set once both venues have been checked. Omit it only when the
   * caller already knows which one to open.
   */
  onScanAddress?: (address: string, venue?: Venue) => void;
  /** Lifted to App so the ticker bar's star and this modal never go stale against each other. */
  favorites: string[];
  onToggleFavorite: (key: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<Category>('home');
  const [sortKey, setSortKey] = useState<SortKey>('volume');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [highlight, setHighlight] = useState(0);
  const [venueHi, setVenueHi] = useState(0);
  const [showFeatured, setShowFeatured] = useStored<boolean>('ot.showFeatured', true);
  const hideFavs = usePrivacy().isHidden('favorites');
  const inputRef = useRef<HTMLInputElement>(null);

  // Only fetched while the modal is actually open — no idle REST weight cost.
  const spotSymbols = useAsync(() => api.symbols('spot'), [], { enabled: open });
  const perpsSymbols = useAsync(() => api.symbols('perps'), [], { enabled: open });
  const spotTickers = useAsync(() => api.tickers('spot'), [], { enabled: open, pollMs: 15_000 });
  const perpsTickers = useAsync(() => api.tickers('perps'), [], { enabled: open, pollMs: 15_000 });

  useEffect(() => {
    if (open) {
      setQuery(initialQuery ?? '');
      setHighlight(0);
      // Let the seeded character land before focusing/selecting.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Escape must close the modal from anywhere inside it. Binding it only to the
  // search input meant that clicking a row, a category tab, or the featured
  // toggle moved focus and silently broke Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open, onClose]);

  const rows = useMemo((): Row[] => {
    const build = (engine: Engine, symbols?: Symbol[], tickers?: Ticker[]): Row[] => {
      const byName = new Map((tickers ?? []).map((t) => [t.symbol, t]));
      return (symbols ?? [])
        .filter((s) => s.status === 'TRADING')
        .map((s) => ({ engine, symbol: s, ticker: byName.get(s.name), key: `${engine}:${s.name}` }));
    };
    return [
      ...build('spot', spotSymbols.data?.symbols, spotTickers.data?.tickers),
      ...build('perps', perpsSymbols.data?.symbols, perpsTickers.data?.tickers),
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spotSymbols.data, perpsSymbols.data, spotTickers.data, perpsTickers.data]);

  /*
   * AN ADDRESS IS A SECOND KIND OF ANSWER, not a replacement for the first.
   *
   * The palette's whole model is one flat `Row[]` of symbols, read from four
   * places; changing that shape would put every existing behaviour at risk. So
   * addresses are recognised SEPARATELY and rendered as one row above the table.
   * The symbol list, its filters, its sorting and its keyboard handling are
   * untouched - type a symbol and nothing about this is different.
   *
   * A saved scan alias resolves too, so the name you gave a wallet works here
   * exactly as it does in the scan bar.
   */
  const addressHit = useMemo(() => {
    if (!onScanAddress) return null;
    const q = query.trim();
    if (!q) return null;
    if (/^0x[0-9a-fA-F]{40}$/.test(q)) return { address: q, alias: aliasFor(q) };
    const viaAlias = resolveTarget(q);
    return viaAlias ? { address: viaAlias, alias: aliasFor(viaAlias) } : null;
  }, [query, onScanAddress]);

  /*
   * A full address is not a venue. Look both up and show each one — active,
   * inactive, or empty — plus the netted equity. Nothing opens until a venue
   * is picked.
   */
  const looked = useAddressVenues(open && addressHit ? addressHit.address : null);
  const choices = looked.cards ? overviewCards(looked.cards) : [];
  const choosing = choices.length > 0 && !looked.loading;

  useEffect(() => { setVenueHi(0); }, [addressHit?.address]);

  const filtered = useMemo(() => {
    const q = query.trim().toUpperCase();
    let list = rows;
    if (category === 'home') list = list.filter((r) => favorites.includes(r.key));
    else if (category === 'spot') list = list.filter((r) => r.engine === 'spot');
    else if (category === 'futures') list = list.filter((r) => r.engine === 'perps');
    else if (category === 'commodities') list = list.filter((r) => assetClass(r.symbol.baseCoin) === 'commodities');
    else if (category === 'stocks') list = list.filter((r) => assetClass(r.symbol.baseCoin) === 'stocks');
    else if (category === 'indexes') list = list.filter((r) => assetClass(r.symbol.baseCoin) === 'indexes');
    if (q) list = list.filter((r) => r.symbol.displayName.toUpperCase().includes(q) || r.symbol.baseCoin.toUpperCase().includes(q));

    const dir = sortDir === 'asc' ? 1 : -1;
    const accessor = SORT_VALUE[sortKey];
    return [...list].sort((a, b) => {
      const av = accessor(a);
      const bv = accessor(b);
      if (typeof av === 'string' || typeof bv === 'string') return String(av).localeCompare(String(bv)) * dir;
      return (av - bv) * dir;
    });
  }, [rows, category, query, favorites, sortKey, sortDir]);

  // Top movers market-wide, independent of search/category - "featured" is
  // just the real 24h change stat, not a curated/fabricated field.
  const featured = useMemo(
    () => [...rows].sort((a, b) => Math.abs(b.ticker?.changePct ?? 0) - Math.abs(a.ticker?.changePct ?? 0)).slice(0, FEATURED_COUNT),
    [rows],
  );

  useEffect(() => setHighlight((h) => Math.min(h, Math.max(0, filtered.length - 1))), [filtered.length]);

  if (!open) return null;

  const pick = (r: Row) => {
    onSelect(r.engine, r.symbol.name);
    onClose();
  };

  const sortBy = (key: SortKey) => {
    if (key === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortKey(key);
      setSortDir(key === 'pair' ? 'asc' : 'desc');
    }
  };

  const openVenue = (venue: Venue) => {
    if (!addressHit || !onScanAddress) return;
    onScanAddress(addressHit.address, venue);
    onClose();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { onClose(); return; }
    if (addressHit && choosing && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      setVenueHi((h) => e.key === 'ArrowDown' ? Math.min(choices.length - 1, h + 1) : Math.max(0, h - 1));
      return;
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight((h) => Math.min(h + 1, filtered.length - 1)); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight((h) => Math.max(h - 1, 0)); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      /* An exact address beats a fuzzy symbol match. Enter does not open Scan
         until the venue check has somewhere to go, and never opens an empty one. */
      if (addressHit && onScanAddress) {
        if (choosing) openVenue(choices[Math.min(venueHi, choices.length - 1)]!.venue);
        return;
      }
      if (filtered[highlight]) pick(filtered[highlight]!);
    }
  };

  const loading = spotSymbols.loading || perpsSymbols.loading;
  const sortIndicator = (key: SortKey) => (key === sortKey ? (sortDir === 'asc' ? '▲' : '▼') : '');
  const emptyMessage = loading ? 'Loading…' : category === 'home' && !query ? 'No favorites yet — star a market to add it here.' : 'No markets match.';

  const resultsTable = (
    <table className="datatable symbolsearch-table">
      <thead>
        <tr>
          <th className="sortable" onClick={() => sortBy('pair')}>Pair {sortIndicator('pair')}</th>
          <th className="sortable" onClick={() => sortBy('last')}>Last price {sortIndicator('last')}</th>
          <th className="sortable" onClick={() => sortBy('change')}>24h change {sortIndicator('change')}</th>
          <th className="sortable" onClick={() => sortBy('funding')}>Funding {sortIndicator('funding')}</th>
          <th className="sortable" onClick={() => sortBy('volume')}>24h vol {sortIndicator('volume')}</th>
          <th className="sortable" onClick={() => sortBy('oi')}>Open interest {sortIndicator('oi')}</th>
        </tr>
      </thead>
      <tbody>
        {addressHit && onScanAddress && (
          <tr
            className={`ss-addr${choosing ? ' ss-addr--choose' : ''}`}
          >
            <td colSpan={6}>
              <span className="ss-addr__kind">Scan wallet</span>
              <code>{addressHit.address}</code>
              {addressHit.alias && <span className="ss-addr__alias">{addressHit.alias}</span>}
              <span className="ss-addr__hint">
                {looked.loading ? VENUE_CHECK : choosing && looked.cards ? overviewLead(looked.cards) : VENUE_CHECK}
              </span>
              {choosing && looked.cards && (
                <VenueChooser
                  cards={choices}
                  lead=""
                  activeVenue={choices[Math.min(venueHi, choices.length - 1)]?.venue}
                  onHover={(v) => setVenueHi(choices.findIndex((c) => c.venue === v))}
                  onPick={openVenue}
                />
              )}
            </td>
          </tr>
        )}
        {filtered.length === 0 && !addressHit && (
          <tr><td colSpan={6} className="muted tablenote">{emptyMessage}</td></tr>
        )}
        {filtered.map((r, i) => {
          const apr = fundingApr(r.ticker?.fundingRate, r.symbol.fundingInterval);
          return (
          <tr
            key={r.key}
            className={i === highlight ? 'active' : ''}
            onMouseEnter={() => setHighlight(i)}
            onClick={() => pick(r)}
          >
            <td>
              <button
                className="star"
                aria-label={favorites.includes(r.key) ? 'Remove from watchlist' : 'Add to watchlist'}
                onClick={(e) => { e.stopPropagation(); onToggleFavorite(r.key); }}
              >
                {/* Hollow while favourites are hidden: a filled star in a list
                    anyone can see is the leak, not the list itself. The Home
                    category still filters by them - that takes a deliberate
                    click, and it is the one place you have asked to see them. */}
                {!hideFavs && favorites.includes(r.key) ? '★' : '☆'}
              </button>
              <CoinIcon coin={r.symbol.baseCoin} size={18} className="ss-coin" />
              {r.symbol.displayName}
              {/* One badge per row, always. A futures row's leverage figure
                  already says "this is a futures market" - "Futures" beside
                  it was the second word for the same fact, and it was also
                  why futures rows measured taller than spot ones (33px vs
                  21px): two inline badges wrap where one does not. Spot has
                  no leverage to carry that signal, so its tag stays. */}
              {r.symbol.maxLeverage
                ? <span className="ss-tag ss-tag--lev">{r.symbol.maxLeverage}x</span>
                : <span className="ss-tag">Spot</span>}
            </td>
            <td>{fmtPrice(r.ticker?.lastPx, r.symbol.tickSize)}</td>
            <td className={signClass(r.ticker?.changePct)}>{fmtPct(r.ticker?.changePct)}</td>
            <td className={signClass(r.ticker?.fundingRate ? num(r.ticker.fundingRate) : undefined)}>
              <div className="ss-funding-rate">
                {r.ticker?.fundingRate !== undefined ? fmtPct(num(r.ticker.fundingRate) * 100, 4) : '-'}
              </div>
              {/* Derived from the rate above via the symbol's own reported
                  interval - see fundingApr(). Dim by default: it is a
                  secondary, annualised READING of the same number, not a
                  second fact, so it does not compete with the rate for
                  attention until the row is actually being looked at. */}
              {/* Always rendered, even on a spot row with no funding at all -
                  a non-breaking space when there is nothing to show, so every
                  row reserves the SAME two-line height regardless of what it
                  has to say. Row height is layout, not a fact; the value
                  inside stays governed by the same honesty rule as
                  everywhere else - real data or nothing, never a stand-in
                  number pretending to be one. */}
              <div className={`ss-funding-apr ${apr !== null ? signClass(apr) : ''}`}>
                {apr !== null ? `${fmtPct(apr, 1)} APR` : ' '}
              </div>
            </td>
            <td>{fmtUsd(r.ticker?.quoteVolume ?? r.ticker?.volume, 0)}</td>
            <td>{r.ticker?.openInterest ? fmtUsd(oiUsd(r), 0) : '-'}</td>
          </tr>
          );
        })}
      </tbody>
    </table>
  );

  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal symbolsearch" role="dialog" aria-modal="true" aria-label="Search markets">
        <div className="symbolsearch-search">
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search markets…"
            aria-label="Search markets"
          />
        </div>

        <div className="tabbar">
          {CATEGORIES.map((c) => (
            <button key={c.key} className={category === c.key ? 'active' : ''} onClick={() => setCategory(c.key)}>
              {c.label}
            </button>
          ))}
          {category === 'home' && (
            <label className="inline small muted board-featured-toggle">
              <input type="checkbox" checked={showFeatured} onChange={(e) => setShowFeatured(e.target.checked)} />
              Featured
            </label>
          )}
        </div>

        <div className="symbolsearch-body">
          {category === 'home' ? (
            <div className={showFeatured ? 'symbolsearch-board split' : 'symbolsearch-board'}>
              <div className="board-list">{resultsTable}</div>
              {showFeatured && (
                <div className="board-featured">
                  <h3>Featured — today's biggest movers</h3>
                  <div className="board-featured-list">
                    {featured.length === 0 && <p className="muted small">{loading ? 'Loading…' : 'No data yet.'}</p>}
                    {featured.map((r) => (
                      <button key={r.key} className="board-featured-row" onClick={() => pick(r)}>
                        <span className="board-featured-name">
                          <CoinIcon coin={r.symbol.baseCoin} size={18} className="ss-coin" />
                          {r.symbol.displayName}
                          {r.symbol.maxLeverage
                            ? <span className="ss-tag ss-tag--lev">{r.symbol.maxLeverage}x</span>
                            : <span className="ss-tag">Spot</span>}
                        </span>
                        <span className="board-featured-price">{fmtPrice(r.ticker?.lastPx, r.symbol.tickSize)}</span>
                        <span className={`board-featured-change ${signClass(r.ticker?.changePct)}`}>{fmtPct(r.ticker?.changePct)}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : resultsTable}
        </div>

        <div className="symbolsearch-footer muted small">
          <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
          <span><kbd>↵</kbd> select</span>
          <span><kbd>esc</kbd> close</span>
          <span><kbd>⌘</kbd><kbd>K</kbd> open from anywhere</span>
        </div>
      </div>
    </div>
  );
}
