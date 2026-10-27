/**
 * Explore -> Markets.
 *
 * Hyperdash's markets page is the reference: the board's pulse in one strip and
 * one sentence; a featured market (its figures as tiles, its chart over a range)
 * beside a rail of lists to pick it from (watchlist, hot, gainers, losers,
 * funding); the day as a heatmap; the sectors; the funding spreads; then every
 * market in one sortable table. A section with no data is not drawn.
 *
 * Data: Hyperliquid's screener (default dex and trade.xyz), SoDEX's tickers and
 * symbols, and the cohort map for what the tracked wallets hold. Polled while
 * the page is visible.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { SECTORS, type Sector } from '@sign/valuedesk/cohorts/model.js';
import { api } from '../../../api';
import { DASH } from '../../../format';
import { useAsync, useSharedPoll, useStored, useSymbols, useTickers } from '../../../hooks';
import { VENUE_LABEL, vsApi, type Venue } from '../../../vsApi';
import { CoinIcon } from '../../CoinIcon';
import { VenueLogo } from '../../VenueLogo';
import { FxSelect } from '../../funds/ui';
import { EmptyState } from '../../EmptyState';
import { PlatformSelect } from '../../PlatformSelect';
import { PriceChart, toCandles, type Candle, type PriceKind } from '../cohorts/PriceChart';
import { FundingScanner } from '../FundingScanner';
import { fmtPx, fmtUsdExact, fmtUsdShort } from '../model';
import { Heatmap } from './Heatmap';
import {
  MARKET_KINDS, MARKET_VENUES, RAIL_LISTS, buildMarkets, filterMarkets, fundingApr, headline, heldLong, pulseOf, railRows, sectorStats, sortMarkets,
  type HeldAsset, type HlAsset, type MarketKind, type MarketRow, type MarketSort, type RailList,
} from './model';
import '../cohorts/Cohorts.css';
import './Markets.css';

const POLL_MS = 30_000;
const MAP_VENUES: readonly Venue[] = ['sodex', 'hyperliquid', 'tradexyz', 'lighter', 'arcus'];
const PAGE = 50;
const RANGES = [
  { id: '1d', label: '1D' },
  { id: '7d', label: '7D' },
  { id: '30d', label: '30D' },
] as const;
type Range = (typeof RANGES)[number]['id'];
/** SoDEX candles for a market Hyperliquid does not list: the same span per range as the server's. */
const SODEX_BARS: Record<Range, { interval: string; limit: number }> = {
  '1d': { interval: '15m', limit: 96 },
  '7d': { interval: '1h', limit: 168 },
  '30d': { interval: '4h', limit: 180 },
};
const DEFAULT_WATCH = ['BTC', 'ETH', 'HYPE', 'SOL'];
const SECTOR_LABEL = Object.fromEntries(SECTORS.map((s) => [s.id, s.label])) as Record<Sector, string>;

const pct = (v: number | null, dp = 2) => (v === null ? DASH : `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(dp)}%`);
const tone = (v: number | null) => (v === null || v === 0 ? '' : v > 0 ? 'pos' : 'neg');
const fundPct = (hourly: number | null) => (hourly === null ? DASH : `${hourly >= 0 ? '+' : '−'}${Math.abs(hourly * 100).toFixed(4)}%`);

export function Markets({ enabled, onOpenSymbol, onOpenScanner }: {
  enabled: boolean;
  onOpenSymbol: (symbol: string) => void;
  onOpenScanner: () => void;
}) {
  // Shared with the funding scanner below (and the trade page's tickers): one read each.
  const hl = useSharedPoll('vs:screener:assets', () => vsApi.assets(), { pollMs: POLL_MS, enabled });
  const tickers = useTickers('perps', { pollMs: POLL_MS, enabled });
  const { symbols } = useSymbols('perps');
  const map = useAsync(() => vsApi.cohortMap(MAP_VENUES, null), [], { pollMs: 5 * 60_000, enabled });

  const held = useMemo<HeldAsset[]>(() => (map.data?.sectors ?? []).flatMap((s) => s.assets ?? []), [map.data]);
  const rows = useMemo(
    () => buildMarkets(Array.isArray(hl.data?.assets) ? (hl.data.assets as HlAsset[]) : [], tickers.data?.tickers, symbols, held),
    [hl.data, tickers.data, symbols, held],
  );

  const [featuredKey, setFeatured] = useStored<string>('vs.markets.featured', 'BTC');
  const [watch, setWatch] = useStored<string[]>('vs.markets.watch', DEFAULT_WATCH);
  const watchList = Array.isArray(watch) ? watch : DEFAULT_WATCH;
  const toggleWatch = (key: string) => setWatch(watchList.includes(key) ? watchList.filter((k) => k !== key) : [...watchList, key]);
  const featured = rows.find((r) => r.key === featuredKey) ?? rows[0] ?? null;
  const top = useRef<HTMLDivElement>(null);
  const feature = (key: string, scroll = false) => {
    setFeatured(key);
    if (scroll) top.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const [sector, setSector] = useState<Sector | null>(null);
  const table = useRef<HTMLElement>(null);
  const pickSector = (s: Sector) => {
    setSector(s);
    table.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  // Both books first (or their failure): a board drawn from one and then the other reshuffles under the pointer.
  const waiting = (!hl.data && !hl.error) || (!tickers.data && !tickers.error);
  if (waiting) return <div className="mk mk--wait" aria-busy="true"><div className="mk-skel mk-skel--pulse" /><div className="mk-skel mk-skel--top" /></div>;
  if (!rows.length) {
    return (
      <div className="mk">
        <EmptyState icon="chart" title="Markets did not load" line={hl.error ?? tickers.error ?? undefined} />
      </div>
    );
  }

  return (
    <div className="mk">
      <Pulse rows={rows} />
      <div className="mk-top" ref={top}>
        {featured && (
          <Featured
            row={featured}
            watched={watchList.includes(featured.key)}
            onWatch={() => toggleWatch(featured.key)}
            onOpenSymbol={onOpenSymbol}
          />
        )}
        <Rail rows={rows} watch={watchList} active={featured?.key ?? null} onPick={(k) => feature(k)} />
      </div>
      <MoversSection rows={rows} active={featured?.key ?? null} onPick={(k) => feature(k, true)} />
      <Sectors rows={rows} onSector={pickSector} onPick={(k) => feature(k, true)} />
      <section className="mk-sec">
        <FundingScanner enabled={enabled} mode="compact" onOpenSymbol={onOpenSymbol} onOpenScanner={onOpenScanner} />
      </section>
      <MarketTable
        anchor={table}
        rows={rows}
        sector={sector}
        onSector={setSector}
        active={featured?.key ?? null}
        watch={watchList}
        onWatch={toggleWatch}
        onPick={(k) => feature(k, true)}
        onOpenSymbol={onOpenSymbol}
      />
    </div>
  );
}

/* --- the pulse ------------------------------------------------------------------------------- */

function Pulse({ rows }: { rows: readonly MarketRow[] }) {
  const p = pulseOf(rows);
  const line = headline(rows);
  const upShare = p.up + p.down > 0 ? p.up / (p.up + p.down) : 0.5;
  return (
    <section className="mk-pulse" aria-label="The board today">
      <div className="mk-pulse__head">
        <h1 className="mk-title">Markets</h1>
        {line && <p className="mk-pulse__line">{line}</p>}
      </div>
      <dl className="mk-pulse__stats">
        <Stat k="24h volume" v={fmtUsdShort(p.volume)} title={fmtUsdExact(p.volume)} />
        <Stat k="Open interest" v={fmtUsdShort(p.oi)} title={fmtUsdExact(p.oi)} />
        <Stat k="Markets" v={p.markets.toLocaleString('en-US')} />
        <Stat k="Avg move" v={pct(p.avgChange)} tone={tone(p.avgChange)} title="24h change, weighted by volume" />
        <Stat k="Avg funding" v={fundPct(p.avgFunding)} sub="per hour" tone={tone(p.avgFunding)} title={`APR ${pct(fundingApr(p.avgFunding), 1)}, weighted by volume`} />
        <div className="mk-pulse__breadth">
          <dt>Breadth</dt>
          <dd>
            <span className="mk-breadth" aria-hidden="true"><i style={{ width: `${upShare * 100}%` }} /></span>
            <span className="mk-breadth__n"><b className="pos">{p.up} up</b><b className="neg">{p.down} down</b></span>
          </dd>
        </div>
      </dl>
    </section>
  );
}

function Stat({ k, v, sub, tone: t = '', title }: { k: string; v: string; sub?: string; tone?: string; title?: string }) {
  return (
    <div title={title}>
      <dt>{k}</dt>
      <dd className={t}>{v}{sub && <small>{sub}</small>}</dd>
    </div>
  );
}

/* --- the featured market --------------------------------------------------------------------- */

function Featured({ row, watched, onWatch, onOpenSymbol }: {
  row: MarketRow;
  watched: boolean;
  onWatch: () => void;
  onOpenSymbol: (symbol: string) => void;
}) {
  const [range, setRange] = useStored<Range>('vs.markets.range', '1d');
  const [kind, setKind] = useStored<PriceKind>('vs.markets.kind', 'candles');
  const r: Range = RANGES.some((x) => x.id === range) ? range : '1d';
  // The source is part of the key: SoDEX's tickers can land before Hyperliquid's screener, and the chart then moves to Hyperliquid.
  const want = `${row.key}|${row.chartCoin ?? ''}|${row.sodex ?? ''}|${r}`;
  const series = useAsync<{ want: string; candles: Candle[] }>(async () => {
    if (row.chartCoin) {
      try {
        const p = await vsApi.price(row.chartCoin, r);
        return { want, candles: toCandles(p.candles, p.points) };
      } catch (e) {
        if (!row.sodex) throw e;
      }
    }
    if (!row.sodex) return { want, candles: [] };
    // SoDEX sends its bars newest first.
    const k = await api.klines('perps', row.sodex, SODEX_BARS[r].interval, SODEX_BARS[r].limit);
    const candles = k.klines
      .map((c) => [c.t, Number(c.o), Number(c.h), Number(c.l), Number(c.c)] as const)
      .filter((c) => c.every((v) => Number.isFinite(v) && v > 0))
      .sort((a, b) => a[0] - b[0]);
    return { want, candles };
  }, [want], { pollMs: 60_000 });
  // The last answer can be another market's while this one loads, or when it failed: never drawn here.
  const candles = series.data?.want === want ? series.data.candles : [];
  const lean = heldLong(row);

  return (
    <section className="mk-feat" aria-label={`${row.name} market`}>
      <header className="mk-feat__head">
        <div className="mk-feat__id">
          <CoinIcon coin={row.name} size={34} />
          <div>
            <h2>
              {row.name}
              <span className="mk-tag">{SECTOR_LABEL[row.sector]}</span>
              <WatchStar on={watched} onClick={onWatch} name={row.name} />
            </h2>
            <Venues venues={row.venues} />
          </div>
        </div>
        <div className="mk-feat__px">
          <b>{fmtPx(row.price)}</b>
          <span className={tone(row.changePct)}>{pct(row.changePct)} <small>24h</small></span>
        </div>
        <div className="mk-feat__acts">
          {row.sodex ? (
            <button type="button" className="mk-btn mk-btn--trade" onClick={() => onOpenSymbol(row.sodex!)}>Trade on SoDEX</button>
          ) : (
            <span className="mk-feat__note" title="SoDEX does not list this market, so it cannot be traded from here.">Not on SoDEX</span>
          )}
        </div>
      </header>

      <dl className="mk-feat__tiles">
        <Tile k="24h volume" v={fmtUsdShort(row.volume)} title={fmtUsdExact(row.volume)} />
        <Tile k="Open interest" v={fmtUsdShort(row.oi)} title={fmtUsdExact(row.oi)} />
        <Tile
          k="Funding / h"
          v={fundPct(row.funding)}
          tone={tone(row.funding)}
          sub={row.funding === null ? undefined : `${pct(fundingApr(row.funding), 1)} APR`}
          title="A positive rate means longs pay shorts."
        />
        <Tile k="Max leverage" v={row.maxLeverage ? `${row.maxLeverage}×` : DASH} />
        <div className="mk-tile mk-tile--lean" title="What the wallets ValueDesk tracks hold of this market, long against short.">
          <dt>Tracked wallets</dt>
          {lean === null ? (
            <dd className="muted">{DASH}</dd>
          ) : (
            <dd>
              <span className={lean >= 0.5 ? 'pos' : 'neg'}>{Math.round(lean * 100)}% long</span>
              <span className="mk-lean" aria-hidden="true"><i style={{ width: `${lean * 100}%` }} /></span>
              <small>{fmtUsdShort((row.long ?? 0) + (row.short ?? 0))} held{row.holders ? ` · ${row.holders.toLocaleString('en-US')} wallets` : ''}</small>
            </dd>
          )}
        </div>
      </dl>

      <div className="mk-feat__chart">
        <div className="mk-feat__bar">
          <Seg label="Chart range" value={r} options={RANGES} onChange={(v) => setRange(v)} />
          <Seg label="Chart kind" value={kind === 'line' ? 'line' : 'candles'} options={[{ id: 'candles', label: 'Candles' }, { id: 'line', label: 'Line' }]} onChange={(v) => setKind(v)} />
        </div>
        {candles.length > 1 ? (
          <PriceChart candles={candles} kind={kind === 'line' ? 'line' : 'candles'} height={300} />
        ) : (
          <div className="mk-feat__nochart">{series.loading || (!series.error && series.data?.want !== want) ? 'Loading the chart…' : `No price history for ${row.name}.`}</div>
        )}
      </div>
    </section>
  );
}

function Tile({ k, v, sub, tone: t = '', title }: { k: string; v: string; sub?: string; tone?: string; title?: string }) {
  return (
    <div className="mk-tile" title={title}>
      <dt>{k}</dt>
      <dd className={t}>{v}{sub && <small>{sub}</small>}</dd>
    </div>
  );
}

function Seg<T extends string>({ label, value, options, onChange }: {
  label: string;
  value: T;
  options: ReadonlyArray<{ id: T; label: string }>;
  onChange: (v: T) => void;
}) {
  return (
    <div className="mk-seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.id} type="button" className={value === o.id ? 'is-on' : ''} aria-pressed={value === o.id} onClick={() => onChange(o.id)}>{o.label}</button>
      ))}
    </div>
  );
}

function Venues({ venues }: { venues: readonly Venue[] }) {
  return (
    <span className="mk-venues">
      {venues.map((v) => (
        <span key={v} className="mk-venue" title={VENUE_LABEL[v]}><VenueLogo venue={v} size={14} />{VENUE_LABEL[v]}</span>
      ))}
    </span>
  );
}

function WatchStar({ on, onClick, name }: { on: boolean; onClick: () => void; name: string }) {
  return (
    <button
      type="button"
      className={`mk-star${on ? ' is-on' : ''}`}
      aria-pressed={on}
      aria-label={on ? `Remove ${name} from the watchlist` : `Add ${name} to the watchlist`}
      title={on ? 'On your watchlist' : 'Add to the watchlist'}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
    >
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        <path d="m8 1.8 1.85 3.9 4.25.55-3.1 2.95.8 4.2L8 11.35 4.2 13.4l.8-4.2L1.9 6.25l4.25-.55Z" fill={on ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      </svg>
    </button>
  );
}

/* --- the rail -------------------------------------------------------------------------------- */

function Rail({ rows, watch, active, onPick }: {
  rows: readonly MarketRow[];
  watch: readonly string[];
  active: string | null;
  onPick: (key: string) => void;
}) {
  const [list, setList] = useStored<RailList>('vs.markets.rail', 'hot');
  const id: RailList = RAIL_LISTS.some((x) => x.id === list) ? list : 'hot';
  const shown = railRows(rows, id, watch, 14);
  return (
    <aside className="mk-rail" aria-label="Pick a market">
      <div className="mk-rail__tabs" role="tablist">
        {RAIL_LISTS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={id === t.id} className={id === t.id ? 'is-on' : ''} onClick={() => setList(t.id)}>{t.label}</button>
        ))}
      </div>
      <ol className="mk-rail__list">
        {shown.map((r) => (
          <li key={r.key}>
            <button type="button" className={`mk-rail__row${active === r.key ? ' is-on' : ''}`} onClick={() => onPick(r.key)}>
              <CoinIcon coin={r.name} size={20} />
              <span className="mk-rail__name">
                <b>{r.name}</b>
                <small>{id === 'funding' ? `${pct(fundingApr(r.funding), 1)} APR` : fmtUsdShort(r.volume)}</small>
              </span>
              <span className="mk-rail__px">
                <b>{fmtPx(r.price)}</b>
                <small className={tone(id === 'funding' ? r.funding : r.changePct)}>{id === 'funding' ? fundPct(r.funding) : pct(r.changePct)}</small>
              </span>
            </button>
          </li>
        ))}
      </ol>
      {!shown.length && (
        <EmptyState compact icon={id === 'watch' ? 'positions' : 'search'} title={id === 'watch' ? 'No markets starred' : 'Nothing here right now'} line={id === 'watch' ? 'Star a market to keep it here.' : undefined} />
      )}
    </aside>
  );
}

/* --- the heatmap ----------------------------------------------------------------------------- */

function MoversSection({ rows, active, onPick }: { rows: readonly MarketRow[]; active: string | null; onPick: (key: string) => void }) {
  const [kind, setKind] = useStored<'crypto' | 'tradfi'>('vs.markets.heat', 'crypto');
  const k = kind === 'tradfi' ? 'tradfi' : 'crypto';
  const shown = useMemo(() => rows.filter((r) => (k === 'tradfi' ? r.tradfi : !r.tradfi)), [rows, k]);
  const hasTradfi = rows.some((r) => r.tradfi);
  if (!shown.length) return null;
  return (
    <Section
      title="Today's moves"
      sub="Size: 24h volume · colour: 24h change"
      tools={hasTradfi ? <Seg label="Markets" value={k} options={[{ id: 'crypto', label: 'Crypto' }, { id: 'tradfi', label: 'Stocks & macro' }]} onChange={(v) => setKind(v)} /> : null}
    >
      <Heatmap rows={shown} active={active} onPick={onPick} />
    </Section>
  );
}

function Section({ title, sub, tools, children, id }: { title: string; sub?: string; tools?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <section className="mk-sec" id={id}>
      <header className="mk-sec__head">
        <div>
          <h2 className="mk-h">{title}</h2>
          {sub && <p className="mk-sub">{sub}</p>}
        </div>
        {tools && <div className="mk-sec__tools">{tools}</div>}
      </header>
      {children}
    </section>
  );
}

/* --- sectors --------------------------------------------------------------------------------- */

function Sectors({ rows, onSector, onPick }: { rows: readonly MarketRow[]; onSector: (s: Sector) => void; onPick: (key: string) => void }) {
  const stats = useMemo(() => sectorStats(rows), [rows]);
  if (stats.length < 2) return null;
  return (
    <Section title="Sectors" sub="24h change weighted by volume · open a sector to list its markets">
      <div className="mk-sectors">
        {stats.map((s) => {
          const up = s.up + s.down > 0 ? s.up / (s.up + s.down) : 0.5;
          return (
            <article key={s.id} className="mk-sector">
              <button type="button" className="mk-sector__open" onClick={() => onSector(s.id)} aria-label={`List the ${s.label} markets`}>
                <span className="mk-sector__t">{s.label}</span>
                <span className={`mk-sector__chg ${tone(s.change)}`}>{pct(s.change)}</span>
                <span className="mk-sector__meta">{s.markets} markets · {fmtUsdShort(s.volume)}</span>
                <span className="mk-breadth mk-breadth--sm" aria-hidden="true"><i style={{ width: `${up * 100}%` }} /></span>
              </button>
              <div className="mk-sector__chips">
                {s.top.map((r) => (
                  <button key={r.key} type="button" className="mk-chip" onClick={() => onPick(r.key)} title={`${r.name} · ${fmtPx(r.price)}`}>
                    <CoinIcon coin={r.name} size={14} />
                    {r.name}
                    <span className={tone(r.changePct)}>{pct(r.changePct, 1)}</span>
                  </button>
                ))}
              </div>
            </article>
          );
        })}
      </div>
    </Section>
  );
}

/* --- every market ---------------------------------------------------------------------------- */

const COLS: ReadonlyArray<{ id: MarketSort; label: string; num?: boolean; title?: string }> = [
  { id: 'name', label: 'Market' },
  { id: 'price', label: 'Price', num: true },
  { id: 'change', label: '24h', num: true },
  { id: 'volume', label: 'Volume', num: true },
  { id: 'oi', label: 'Open interest', num: true },
  { id: 'funding', label: 'Funding / h', num: true, title: 'Hourly funding rate; a positive rate means longs pay shorts' },
  { id: 'held', label: 'Tracked wallets', num: true, title: 'What the wallets ValueDesk tracks hold here, long against short' },
];

function MarketTable({ anchor, rows, sector, onSector, active, watch, onWatch, onPick, onOpenSymbol }: {
  anchor: RefObject<HTMLElement>;
  rows: readonly MarketRow[];
  sector: Sector | null;
  onSector: (s: Sector | null) => void;
  active: string | null;
  watch: readonly string[];
  onWatch: (key: string) => void;
  onPick: (key: string) => void;
  onOpenSymbol: (symbol: string) => void;
}) {
  const [kind, setKind] = useStored<MarketKind>('vs.markets.kind.table', 'all');
  const k: MarketKind = MARKET_KINDS.some((x) => x.id === kind) ? kind : 'all';
  const [sort, setSort] = useStored<{ by: MarketSort; dir: 'asc' | 'desc' }>('vs.markets.sort', { by: 'volume', dir: 'desc' });
  const s = sort && COLS.some((c) => c.id === sort.by) ? sort : { by: 'volume' as const, dir: 'desc' as const };
  const [venues, setVenues] = useStored<Venue[]>('vs.markets.venues', [...MARKET_VENUES]);
  const chosen = Array.isArray(venues) && venues.some((v) => MARKET_VENUES.includes(v)) ? venues.filter((v) => MARKET_VENUES.includes(v)) : [...MARKET_VENUES];
  const venueKey = chosen.join(',');
  const [q, setQ] = useState('');
  const [shown, setShown] = useState(PAGE);
  useEffect(() => setShown(PAGE), [k, sector, q, s.by, s.dir, venueKey]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const list = useMemo(() => sortMarkets(filterMarkets(rows, { kind: k, sector, q, venues: chosen }), s.by, s.dir), [rows, k, sector, q, s.by, s.dir, venueKey]);
  const sectorsHere = useMemo(() => SECTORS.filter((x) => rows.some((r) => r.sector === x.id)), [rows]);
  const anyHeld = rows.some((r) => heldLong(r) !== null);
  const cols = anyHeld ? COLS : COLS.filter((c) => c.id !== 'held');
  const sortBy = (by: MarketSort) => setSort(s.by === by ? { by, dir: s.dir === 'desc' ? 'asc' : 'desc' } : { by, dir: by === 'name' ? 'asc' : 'desc' });

  return (
    <section className="mk-sec mk-table-sec" ref={anchor} aria-label="Every market">
      <header className="mk-sec__head">
        <div>
          <h2 className="mk-h">All markets</h2>
          <p className="mk-sub">{list.length.toLocaleString('en-US')} of {rows.length.toLocaleString('en-US')} · SoDEX, Hyperliquid and trade.xyz</p>
        </div>
      </header>
      <div className="mk-toolbar">
        <div className="mk-cats" role="tablist" aria-label="Markets">
          {MARKET_KINDS.map((x) => (
            <button key={x.id} type="button" role="tab" aria-selected={k === x.id} className={`mk-cat${k === x.id ? ' is-on' : ''}`} onClick={() => setKind(x.id)}>{x.label}</button>
          ))}
        </div>
        <PlatformSelect options={MARKET_VENUES} value={chosen} onChange={setVenues} />
        <FxSelect
          label="Sector"
          value={sector ?? 'all'}
          options={[{ value: 'all', label: 'Every sector' }, ...sectorsHere.map((x) => ({ value: x.id, label: x.label }))]}
          onChange={(v) => onSector(v === 'all' ? null : (v as Sector))}
          searchable={false}
          triggerClassName="mk-select"
          listMinWidth={200}
        />
        <label className="mk-search">
          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="m10.5 10.5 3 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search markets" aria-label="Search markets" />
        </label>
      </div>
      <div className="mk-table-wrap">
        <table className="mk-table">
          <thead>
            <tr>
              <th className="mk-table__star" aria-label="Watchlist" />
              {cols.map((c) => (
                <th key={c.id} className={c.num ? 'num' : ''} aria-sort={s.by === c.id ? (s.dir === 'asc' ? 'ascending' : 'descending') : undefined} title={c.title}>
                  <button type="button" onClick={() => sortBy(c.id)} className={s.by === c.id ? 'is-on' : ''}>
                    {c.label}
                    {s.by === c.id && <span className="mk-sort" aria-hidden="true">{s.dir === 'asc' ? '↑' : '↓'}</span>}
                  </button>
                </th>
              ))}
              <th className="mk-table__act" aria-label="Trade" />
            </tr>
          </thead>
          <tbody>
            {list.slice(0, shown).map((r) => {
              const lean = heldLong(r);
              return (
                <tr key={r.key} className={active === r.key ? 'is-on' : ''} onClick={() => onPick(r.key)}>
                  <td className="mk-table__star"><WatchStar on={watch.includes(r.key)} onClick={() => onWatch(r.key)} name={r.name} /></td>
                  <td>
                    <span className="mk-mkt">
                      <CoinIcon coin={r.name} size={20} />
                      <span className="mk-mkt__t">
                        <b>{r.name}</b>
                        <small>{SECTOR_LABEL[r.sector]}</small>
                      </span>
                      <span className="mk-mkt__v">{r.venues.map((v) => <VenueLogo key={v} venue={v} size={12} />)}</span>
                    </span>
                  </td>
                  <td className="num">{fmtPx(r.price)}</td>
                  <td className={`num ${tone(r.changePct)}`}>{pct(r.changePct)}</td>
                  <td className="num" title={fmtUsdExact(r.volume)}>{fmtUsdShort(r.volume)}</td>
                  <td className="num" title={fmtUsdExact(r.oi)}>{r.oi > 0 ? fmtUsdShort(r.oi) : DASH}</td>
                  <td className={`num ${tone(r.funding)}`} title={r.funding === null ? undefined : `${pct(fundingApr(r.funding), 1)} APR`}>{fundPct(r.funding)}</td>
                  {anyHeld && (
                    <td className="num">
                      {lean === null ? <span className="muted">{DASH}</span> : (
                        <span className="mk-held" title={`${fmtUsdShort(r.long)} long · ${fmtUsdShort(r.short)} short`}>
                          <span className="mk-lean mk-lean--sm" aria-hidden="true"><i style={{ width: `${lean * 100}%` }} /></span>
                          <span className={lean >= 0.5 ? 'pos' : 'neg'}>{Math.round(lean * 100)}% L</span>
                        </span>
                      )}
                    </td>
                  )}
                  <td className="mk-table__act">
                    {r.sodex && (
                      <button type="button" className="mk-btn mk-btn--sm" onClick={(e) => { e.stopPropagation(); onOpenSymbol(r.sodex!); }}>Trade</button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!list.length && <EmptyState icon="search" title="No market matches" line="Try another search, sector or platform." />}
      </div>
      {list.length > shown && (
        <button type="button" className="mk-more" onClick={() => setShown((n) => n + PAGE)}>
          Show {Math.min(PAGE, list.length - shown)} more
        </button>
      )}
    </section>
  );
}
