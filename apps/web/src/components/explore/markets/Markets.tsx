/**
 * Explore -> Markets.
 *
 * The board's pulse in one strip and one sentence; the day's moves as a heatmap
 * where the BTC chart was; traders to copy; the sectors; then every market in one
 * sortable table. Only the markets SoDEX lists (owner, 2026-11-06): the figures of
 * one may sum the venues it trades on, whose logos it shows. A section with no
 * data is not drawn. A market opens on the trade page.
 *
 * Data: Hyperliquid's screener (default dex and trade.xyz), SoDEX's tickers and
 * symbols, the cohort map for what the tracked wallets hold, and the copy boards
 * of SoDEX and Hyperliquid. Polled while the page is visible.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { SECTORS, type Sector } from '@sign/valuedesk/cohorts/model.js';
import { DASH } from '../../../format';
import { useAsync, useSharedPoll, useSodexOiExcluded, useStored, useSymbols, useTickers } from '../../../hooks';
import { vsApi, type Venue } from '../../../vsApi';
import { CoinIcon } from '../../CoinIcon';
import { VenueLogo } from '../../VenueLogo';
import { FxSelect } from '../../funds/ui';
import { EmptyState } from '../../EmptyState';
import { fmtPx, fmtUsdExact, fmtUsdShort } from '../model';
import { fmtFixed, fmtNum } from '../../../numStyle';
import { Heatmap } from './Heatmap';
import { TraderCard } from '../../copy/TraderCard';
import { COPY_VENUES, NO_FILTERS, scoreRows, shapeGrid } from '../../copy/gridModel';
import type { BoardWindow, TraderRow } from '../../../vsApi';
import {
  MARKET_KINDS, buildMarkets, filterMarkets, fundingApr, headline, heldLong, pulseOf, sectorStats, sortMarkets,
  type HeldAsset, type HlAsset, type MarketKind, type MarketRow, type MarketSort,
} from './model';
import '../cohorts/Cohorts.css';
import './Markets.css';

const POLL_MS = 30_000;
const MAP_VENUES: readonly Venue[] = ['sodex', 'hyperliquid', 'tradexyz', 'lighter', 'arcus'];
const PAGE = 50;
const DEFAULT_WATCH = ['BTC', 'ETH', 'HYPE', 'SOL'];
const SECTOR_LABEL = Object.fromEntries(SECTORS.map((s) => [s.id, s.label])) as Record<Sector, string>;

const pct = (v: number | null, dp = 2) => (v === null ? DASH : `${v >= 0 ? '+' : '−'}${fmtFixed(Math.abs(v), dp)}%`);
const tone = (v: number | null) => (v === null || v === 0 ? '' : v > 0 ? 'pos' : 'neg');
const fundPct = (hourly: number | null) => (hourly === null ? DASH : `${hourly >= 0 ? '+' : '−'}${fmtFixed(Math.abs(hourly * 100), 4)}%`);

export function Markets({ enabled, onOpenSymbol, onOpenCopy, onOpenCopyPage }: {
  enabled: boolean;
  onOpenSymbol: (symbol: string) => void;
  onOpenCopy: (address: string, venue: Venue) => void;
  onOpenCopyPage?: () => void;
}) {
  // Shared with the funding scanner below (and the trade page's tickers): one read each.
  const hl = useSharedPoll('vs:screener:assets', () => vsApi.assets(), { pollMs: POLL_MS, enabled });
  const tickers = useTickers('perps', { pollMs: POLL_MS, enabled });
  const { symbols } = useSymbols('perps');
  const map = useAsync(() => vsApi.cohortMap(MAP_VENUES, null), [], { pollMs: 5 * 60_000, enabled });

  const oiExcluded = useSodexOiExcluded(enabled);

  const held = useMemo<HeldAsset[]>(() => (map.data?.sectors ?? []).flatMap((s) => s.assets ?? []), [map.data]);
  // Only what SoDEX lists: a market that cannot be traded here is not on this page.
  const rows = useMemo(
    () => buildMarkets(Array.isArray(hl.data?.assets) ? (hl.data.assets as HlAsset[]) : [], tickers.data?.tickers, symbols, held, oiExcluded).filter((r) => r.sodex !== null),
    [hl.data, tickers.data, symbols, held, oiExcluded],
  );

  const [watch, setWatch] = useStored<string[]>('vs.markets.watch', DEFAULT_WATCH);
  const watchList = Array.isArray(watch) ? watch : DEFAULT_WATCH;
  const toggleWatch = (key: string) => setWatch(watchList.includes(key) ? watchList.filter((k) => k !== key) : [...watchList, key]);
  const open = (key: string) => {
    const r = rows.find((x) => x.key === key);
    if (r?.sodex) onOpenSymbol(r.sodex);
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
      <MoversSection rows={rows} active={null} onPick={open} />
      <TradersToCopy enabled={enabled} onOpenCopy={onOpenCopy} onOpenCopyPage={onOpenCopyPage} />
      <Sectors rows={rows} onSector={pickSector} onPick={open} />
      <MarketTable
        anchor={table}
        rows={rows}
        sector={sector}
        onSector={setSector}
        active={null}
        watch={watchList}
        onWatch={toggleWatch}
        onPick={open}
        onOpenSymbol={onOpenSymbol}
      />
    </div>
  );
}

/* --- traders to copy ------------------------------------------------------------------------ */

const TRADERS_WINDOW: BoardWindow = '30d';
const TRADERS_SHOWN = 4;

/** The best traders to copy right now, as the Copy page scores them: profitable over 30 days, best score first. */
function TradersToCopy({ enabled, onOpenCopy, onOpenCopyPage }: {
  enabled: boolean;
  onOpenCopy: (address: string, venue: Venue) => void;
  onOpenCopyPage?: () => void;
}) {
  const boards = useAsync(
    () => Promise.all(COPY_VENUES.map((venue) =>
      vsApi.leaderboard({ venue, window: TRADERS_WINDOW, sort: 'pnl', limit: 100 }).then((b) => b.rows, () => [] as TraderRow[]))),
    [],
    { pollMs: 5 * 60_000, enabled },
  );
  const top = useMemo(
    () => shapeGrid(scoreRows((boards.data ?? []).flat(), TRADERS_WINDOW, 'copy'), { category: 'top', filters: { ...NO_FILTERS, sideOnly: true }, sort: 'score', window: TRADERS_WINDOW }).slice(0, TRADERS_SHOWN),
    [boards.data],
  );
  if (!boards.loading && !top.length) return null;
  const open = (row: TraderRow) => onOpenCopy(row.address, row.venue);
  return (
    <Section
      title="Traders to copy"
      sub="Best copy score over 30 days, on SoDEX and Hyperliquid · every trade lands in your own SoDEX account"
      tools={onOpenCopyPage ? <button type="button" className="mk-more" onClick={onOpenCopyPage}>All traders <span aria-hidden="true">&rarr;</span></button> : null}
    >
      <div className="mk-traders">
        {top.length
          ? top.map((t) => <TraderCard key={`${t.row.venue}:${t.row.address}`} row={t.row} score={t.score} window={TRADERS_WINDOW} unit="usd" onOpen={open} onCopy={open} />)
          : Array.from({ length: TRADERS_SHOWN }, (_, i) => <div key={i} className="cpy-card cpy-card--ghost" aria-busy="true" />)}
      </div>
    </Section>
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
        <Stat k="Markets" v={fmtNum(p.markets)} />
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
  const [q, setQ] = useState('');
  const [shown, setShown] = useState(PAGE);
  useEffect(() => setShown(PAGE), [k, sector, q, s.by, s.dir]);

  const list = useMemo(() => sortMarkets(filterMarkets(rows, { kind: k, sector, q }), s.by, s.dir), [rows, k, sector, q, s.by, s.dir]);
  const sectorsHere = useMemo(() => SECTORS.filter((x) => rows.some((r) => r.sector === x.id)), [rows]);
  const anyHeld = rows.some((r) => heldLong(r) !== null);
  const cols = anyHeld ? COLS : COLS.filter((c) => c.id !== 'held');
  const sortBy = (by: MarketSort) => setSort(s.by === by ? { by, dir: s.dir === 'desc' ? 'asc' : 'desc' } : { by, dir: by === 'name' ? 'asc' : 'desc' });

  return (
    <section className="mk-sec mk-table-sec" ref={anchor} aria-label="Every market">
      <header className="mk-sec__head">
        <div>
          <h2 className="mk-h">All markets</h2>
          <p className="mk-sub">{fmtNum(list.length)} of {fmtNum(rows.length)} · every market SoDEX lists</p>
        </div>
      </header>
      <div className="mk-toolbar">
        <div className="mk-cats" role="tablist" aria-label="Markets">
          {MARKET_KINDS.map((x) => (
            <button key={x.id} type="button" role="tab" aria-selected={k === x.id} className={`mk-cat${k === x.id ? ' is-on' : ''}`} onClick={() => setKind(x.id)}>{x.label}</button>
          ))}
        </div>
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
                  <td className="num" title={fmtUsdExact(r.oi)}>{r.oi !== null && r.oi > 0 ? fmtUsdShort(r.oi) : DASH}</td>
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
