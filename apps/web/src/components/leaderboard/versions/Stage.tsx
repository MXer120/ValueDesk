/**
 * Version "Stage": the home page's look. The board's three best stand on a dark stage with their curves and a Copy
 * (or Counter, on the worst hundred) each; under them, what the whole hundred adds up to. Below the stage the
 * hundred is ranked by one measure at a time - PnL, edge, win rate, account, volume, trades - as bars against the
 * leader of that measure, and any trader opens in place.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent } from 'react';
import { DASH } from '../../../format';
import { fmtNum } from '../../../numStyle';
import { VENUE_LABEL, type BoardWindow, type TraderRow, type Venue } from '../../../vsApi';
import { VENUE_BRAND } from '../../venueBrand';
import { CopyButton, Spark, ViewButton, WinRate } from '../../copy/TraderCard';
import { isCopyable } from '../../copy/gridModel';
import { Button, Icon, IconButton, Segmented, Skeleton, Switch } from '../../bots/kit/kit';
import { LB_VENUES } from '../lbState';
import { Search, SideTabs, Venues, WindowSeg } from './controls';
import { Assets, BoardState, Move, Notes, Place, SizePill, TraderDetail, VenueMarks, Who, bps, toneOf, tradesText, useMasks, usdShort, useWidth } from './parts';
import {
  ASSET_GROUPS, SIZE_BANDS, SORT_HINT, SORT_LABEL, WINDOW_LONG, WINDOW_WORD, dirOf, edgeOf, hasVolume, metricOf, shape, usableSort, useBoard,
  type AssetGroup, type Row, type SizeBand, type SortKey,
} from './useBoard';
import type { VersionProps } from './types';

const keyOf = (r: Row) => `${r.venue}:${r.address}`;
const RANK_BY: SortKey[] = ['pnl', 'edge', 'winRate', 'accountValue', 'volume', 'trades'];
const FIRST = 25;
const finite = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

/** A measure's figure as the ranked bars print it. */
function metricText(r: TraderRow, s: SortKey, w: BoardWindow): string {
  switch (s) {
    case 'pnl': return usdShort(r.pnl[w] ?? null, true);
    case 'edge': return bps(edgeOf(r, w));
    case 'winRate': return finite(r.winRate) ? `${Math.round(r.winRate * 100)}%` : DASH;
    case 'accountValue': return usdShort(r.accountValue);
    case 'volume': return usdShort(r.volume[w] ?? null);
    case 'trades': return tradesText(r);
  }
}

/* ------------------------------------------------------------------------------------- the podium ----- */

function Podium({ rows, w, side, me, since, onOpen, onScan, onCopy }: {
  rows: Row[]; w: BoardWindow; side: 'top' | 'worst'; me: string | null; since: number | null;
  onOpen: (r: Row) => void; onScan: VersionProps['onScan']; onCopy: VersionProps['onCopy'];
}) {
  const masks = useMasks(me);
  const direction = side === 'worst' ? 'counter' : 'copy';
  return (
    <ol className="lbv-pod" aria-label={side === 'worst' ? 'The three biggest losses' : 'The three best'}>
      {rows.map((r) => {
        const pnl = r.pnl[w] ?? null;
        const stop = (e: MouseEvent) => e.stopPropagation();
        return (
          <li key={keyOf(r)} className={`lbv-pod__c is-${r.place}`}>
            <div className="lbv-pod__card" role="button" tabIndex={0} onClick={() => onOpen(r)} onKeyDown={(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) onOpen(r); }} aria-label={`Open trader ${r.address}`}>
              <div className="lbv-pod__top">
                <Place n={r.place} size="lg" />
                <Who row={r} me={me} size={r.place === 1 ? 40 : 34} sub={<><VenueMarks venues={r.venues} size={13} /><Assets assets={r.assets} size={13} /></>} />
                <Move rc={r.rankChange} since={since} />
              </div>
              <div className="lbv-pod__fig">
                <b className={toneOf(pnl)}>{masks.pnl(r, usdShort(pnl, true))}</b>
                <span>PnL {WINDOW_WORD[w]}</span>
              </div>
              <Spark values={r.spark && r.spark.length > 1 ? r.spark : null} className="lbv-pod__spark" />
              <dl className="lbv-pod__kv">
                <div><dt>Account</dt><dd>{masks.equity(r, usdShort(r.accountValue))}</dd></div>
                <div><dt>Edge</dt><dd className={toneOf(edgeOf(r, w))}>{bps(edgeOf(r, w))}</dd></div>
                <div><dt>Win rate</dt><dd>{finite(r.winRate) ? `${Math.round(r.winRate * 100)}%` : DASH}</dd></div>
              </dl>
              <div className="lbv-pod__act" onClick={stop}>
                {isCopyable(r.venue)
                  ? <CopyButton kind={direction} onClick={() => onCopy(r.address, r.venue, direction)} />
                  : <ViewButton venue={r.venue} onClick={() => onScan(r.address, r.venue)} />}
                <IconButton icon="search" label="Open in Scan" variant="secondary" onClick={() => onScan(r.address, r.venue)} />
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/* --------------------------------------------------------------------------------- the hundred's sum ----- */

function Sum({ rows, w, side }: { rows: TraderRow[]; w: BoardWindow; side: 'top' | 'worst' }) {
  const s = useMemo(() => {
    let pnl = 0; let vol = 0; let volKnown = 0; let pnlOfVol = 0;
    const wr: number[] = [];
    const venues = new Map<Venue, number>();
    for (const r of rows) {
      const p = r.pnl[w];
      const v = r.volume[w];
      if (finite(p)) pnl += p;
      if (finite(v)) { vol += v; volKnown += 1; if (finite(p)) pnlOfVol += p; }
      if (finite(r.winRate)) wr.push(r.winRate);
      for (const x of r.venues?.length ? r.venues : [r.venue]) venues.set(x, (venues.get(x) ?? 0) + 1);
    }
    wr.sort((a, b) => a - b);
    const median = wr.length ? (wr.length % 2 ? wr[(wr.length - 1) / 2]! : (wr[wr.length / 2 - 1]! + wr[wr.length / 2]!) / 2) : null;
    return { pnl, vol: volKnown ? vol : null, edge: volKnown && vol > 0 ? (pnlOfVol / vol) * 10_000 : null, median, wrN: wr.length, venues };
  }, [rows, w]);
  const counted = LB_VENUES.filter((v) => s.venues.has(v));
  return (
    <div className="lbv-sum">
      <div><dt>{side === 'worst' ? 'Lost together' : 'Made together'}</dt><dd className={toneOf(s.pnl)}>{usdShort(s.pnl, true)}</dd><small>{fmtNum(rows.length)} traders, {WINDOW_LONG[w]}</small></div>
      <div><dt>Traded together</dt><dd>{usdShort(s.vol)}</dd><small>{s.vol === null ? `Not ranked for ${WINDOW_WORD[w]}` : 'Volume in the window'}</small></div>
      <div title="All their PnL over all their volume"><dt>Their edge</dt><dd className={toneOf(s.edge)}>{bps(s.edge)}</dd><small>PnL per traded dollar</small></div>
      <div><dt>Median win rate</dt><dd>{s.median === null ? DASH : `${Math.round(s.median * 100)}%`}</dd><small>{s.wrN ? `Of ${fmtNum(s.wrN)} with a rate` : 'No rates yet'}</small></div>
      <div className="lbv-sum__v">
        <dt>Where they trade</dt>
        <div className="lbv-sum__bar" aria-hidden="true">
          {counted.map((v) => <span key={v} style={{ flexGrow: s.venues.get(v), background: VENUE_BRAND[v] } as CSSProperties} />)}
        </div>
        <ul>
          {counted.map((v) => <li key={v}><i style={{ background: VENUE_BRAND[v] }} />{VENUE_LABEL[v]}<b>{fmtNum(s.venues.get(v)!)}</b></li>)}
        </ul>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------------------------------- the page ----- */

export function Stage({ address, onScan, onCopy, embedded }: VersionProps) {
  const board = useBoard(embedded);
  const { view } = board;
  const [sortPick, setSort] = useState<SortKey>(view.sort === 'volume' || view.sort === 'accountValue' ? view.sort : 'pnl');
  const [asset, setAsset] = useState<AssetGroup>('all');
  const [size, setSize] = useState<SizeBand>('all');
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const [setRoot, width] = useWidth<HTMLElement>();
  const me = address ? address.toLowerCase() : null;
  const masks = useMasks(me);
  const since = board.page?.index?.rankSince ?? null;
  const pickSort = (s: SortKey) => {
    setSort(s);
    if (s === 'pnl' || s === 'volume' || s === 'accountValue') board.update({ sort: s });
  };
  useEffect(() => { setOpenKey(null); setAll(false); }, [board.key]);
  const vol = hasVolume(board.rows, view.window);
  const sort = usableSort(sortPick, vol);

  const podium = useMemo(() => (board.rows ? shape(board.rows, { window: view.window, side: view.side, sort: 'pnl', q: '', asset: 'all', size: 'all' }).slice(0, 3) : null), [board.rows, view.window, view.side]);
  const rows = useMemo(
    () => (board.rows ? shape(board.rows, { window: view.window, side: view.side, sort, q: view.q, asset, size }) : null),
    [board.rows, view.window, view.side, sort, view.q, asset, size],
  );
  const shown = rows ? (all || !!view.q ? rows : rows.slice(0, FIRST)) : null;
  const top = useMemo(() => {
    if (!rows) return 1;
    let m = 0;
    for (const r of rows) { const v = metricOf(r, sort, view.window); if (finite(v)) m = Math.max(m, Math.abs(v)); }
    return m || 1;
  }, [rows, sort, view.window]);
  const list = useRef<HTMLOListElement>(null);
  const open = (r: Row) => {
    const k = keyOf(r);
    setOpenKey((cur) => (cur === k ? null : k));
    if (rows && rows.indexOf(r) >= FIRST) setAll(true);
  };
  const openFromPodium = (r: Row) => {
    setOpenKey(keyOf(r));
    window.setTimeout(() => list.current?.querySelector(`[data-k="${CSS.escape(keyOf(r))}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 40);
  };
  const wide = width >= 1020;
  const dir = dirOf(view.side, sort);
  const signed = sort === 'pnl' || sort === 'edge';

  return (
    <section ref={setRoot} className={`tf lbv lbv-stage${embedded ? ' is-embedded' : ''}`} aria-busy={board.loading}>
      <div className="lbv-hero">
        <span className="lbv-hero__light" aria-hidden="true" /><span className="lbv-hero__ribs" aria-hidden="true" />
        <div className="lbv-hero__top">
          <div className="lbv-hero__t">
            {!embedded && <h1 className="lbv-h1">Leaderboard</h1>}
            <p className="lbv-lede">{view.side === 'top' ? 'The best' : 'The worst'} 100 by PnL over {WINDOW_LONG[view.window]}</p>
          </div>
          <div className="lbv-hero__ctl">
            <SideTabs board={board} compact={width < 560} />
            <WindowSeg board={board} />
          </div>
        </div>
        {podium ? (
          podium.length ? <Podium rows={podium} w={view.window} side={view.side} me={me} since={since} onOpen={openFromPodium} onScan={onScan} onCopy={onCopy} /> : null
        ) : !board.unavailable && !(board.failed && !board.rows) ? (
          <div className="lbv-pod is-wait">{[2, 1, 3].map((n) => <Skeleton key={n} className={`lbv-skel-pod is-${n}`} />)}</div>
        ) : null}
        {board.rows && board.rows.length > 0 && <Sum rows={board.rows} w={view.window} side={view.side} />}
      </div>

      <div className="lbv-stage__body">
        <div className="lbv-stage__head">
          <h2>Ranked by</h2>
          <Segmented<SortKey> label="Rank by" value={sort} onChange={pickSort} options={RANK_BY.map((s) => ({ value: s, disabled: !vol && (s === 'edge' || s === 'volume'), label: <span title={!vol && (s === 'edge' || s === 'volume') ? `No volume for ${WINDOW_WORD[view.window]}` : SORT_HINT[s]}>{SORT_LABEL[s]}</span> }))} className="lbv-rankby" />
          <Search board={board} />
        </div>
        <div className="lbv-stage__filters">
          <Venues board={board} />
          <Segmented<AssetGroup> label="Largest positions in" value={asset} onChange={setAsset} options={ASSET_GROUPS.map(([v, t]) => ({ value: v, label: t }))} />
          <Segmented<SizeBand> label="Account size" value={size} onChange={setSize} options={SIZE_BANDS.map(([v, t, hint]) => ({ value: v, label: <span title={hint}>{v === 'all' ? 'Any size' : t}</span> }))} />
          <Switch label="More than one trade" checked={board.minTrades === 2} onChange={(on) => board.setMinTrades(on ? 2 : 0)} className="lbv-stage__min" />
        </div>
        <BoardState board={board} rows={rows} empty={view.q || asset !== 'all' || size !== 'all' ? 'No trader in this hundred matches' : board.minTrades === 2 ? 'No indexed trader has more than one trade in this window yet' : 'No traders in this hundred'} />
        {!rows && !board.unavailable && !(board.failed && !board.rows) && <div className="lbv-stage__skel">{Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="lbv-skel-line" />)}</div>}
        {shown && shown.length > 0 && (
          <ol ref={list} className="lbv-rk" aria-label={`Traders ranked by ${SORT_LABEL[sort]}`}>
            {shown.map((r, i) => {
              const k = keyOf(r);
              const v = metricOf(r, sort, view.window);
              const fill = finite(v) ? (sort === 'winRate' ? v : Math.abs(v) / top) : 0;
              const isOpen = openKey === k;
              const tone = signed ? toneOf(v) : sort === 'winRate' ? 'is-wr' : 'is-n';
              return (
                <li key={k} data-k={k} className={isOpen ? 'is-open' : undefined}>
                  <button type="button" className="lbv-rk__row" onClick={() => open(r)} aria-expanded={isOpen}>
                    <span className="lbv-rk__n">{sort === 'pnl' ? <Place n={r.place} size="md" /> : <span className="lbv-pos-n">{i + 1}</span>}</span>
                    <span className="lbv-rk__who">
                      <Who row={r} me={me} size={30} sub={<><VenueMarks venues={r.venues} size={13} /><Assets assets={r.assets} size={13} /><SizePill row={r} />{sort !== 'pnl' && <span className="lbv-hint">PnL #{r.place}</span>}</>} />
                    </span>
                    <span className="lbv-rk__bar">
                      <span className={`lbv-rk__track ${tone}`}><i style={{ width: `${Math.max(fill * 100, finite(v) && v !== 0 ? 1.5 : 0)}%` }} /></span>
                      <b className={signed ? toneOf(v) : ''}>{sort === 'pnl' ? masks.pnl(r, metricText(r, sort, view.window)) : sort === 'accountValue' ? masks.equity(r, metricText(r, sort, view.window)) : metricText(r, sort, view.window)}</b>
                    </span>
                    <span className="lbv-rk__side">
                      {sort !== 'pnl' ? <span className={toneOf(r.pnl[view.window])}>{masks.pnl(r, usdShort(r.pnl[view.window] ?? null, true))}</span> : <span>{masks.equity(r, usdShort(r.accountValue))}</span>}
                      <small>{sort !== 'pnl' ? `PnL ${WINDOW_WORD[view.window]}` : 'Account'}</small>
                    </span>
                    <span className="lbv-rk__wr"><WinRate value={r.winRate} closes={r.winRateCloses} /></span>
                    <Icon name="arrowRight" size={15} className="lbv-rk__chev" />
                  </button>
                  {isOpen && (
                    <div className="lbv-rk__more">
                      <TraderDetail row={r} window={view.window} side={view.side} me={me} rankSince={since} onScan={onScan} onCopy={onCopy} layout={wide ? 'wide' : 'panel'} onClose={() => setOpenKey(null)} />
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        )}
        {rows && !all && !view.q && rows.length > FIRST && (
          <div className="lbv-stage__more"><Button variant="secondary" size="md" onClick={() => setAll(true)}>Show all {fmtNum(rows.length)}</Button></div>
        )}
        {rows && <p className="lbv-sr" aria-live="polite">{fmtNum(rows.length)} traders by {SORT_LABEL[sort]}, {dir === 'desc' ? 'highest first' : 'lowest first'}</p>}
        <Notes board={board} className="lbv-stage__notes" />
      </div>
    </section>
  );
}
