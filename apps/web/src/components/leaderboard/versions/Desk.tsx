/**
 * Version "Desk": the hundred as a dense ranked list, the chosen trader beside it - their curve, what they hold now
 * and Copy / Counter / Scan - without leaving the page. Arrow keys walk the list. Under 1,060px of its own width (a
 * phone, a terminal widget) the list stands alone and a trader opens as a sheet.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { fmtNum } from '../../../numStyle';
import { VENUE_LABEL } from '../../../vsApi';
import { Skeleton } from '../../bots/kit/kit';
import { WinRate } from '../../copy/TraderCard';
import { ActiveChips, FilterButton, Search, SideTabs, Venues, WindowSeg, type Narrow } from './controls';
import { Assets, BoardState, DetailSheet, Move, Notes, Place, TraderDetail, VenueMarks, Who, bps, toneOf, useMasks, usdShort, useWidth } from './parts';
import { SORT_HINT, SORT_LABEL, WINDOW_LONG, dirOf, edgeOf, hasVolume, shape, usableSort, type AssetGroup, type Row, type SizeBand, type SortKey } from './useBoard';
import { useBoard } from './useBoard';
import type { VersionProps } from './types';

const keyOf = (r: Row) => `${r.venue}:${r.address}`;
const COLS: SortKey[] = ['pnl', 'accountValue', 'volume', 'edge', 'winRate'];

export function Desk({ address, onScan, onCopy, embedded }: VersionProps) {
  const board = useBoard(embedded);
  const { view } = board;
  const [sortPick, setSort] = useState<SortKey>(view.sort === 'volume' || view.sort === 'accountValue' ? view.sort : 'pnl');
  const [asset, setAsset] = useState<AssetGroup>('all');
  const [size, setSize] = useState<SizeBand>('all');
  const narrow: Narrow = { asset, setAsset, size, setSize };
  const pickSort = (s: SortKey) => {
    setSort(s);
    if (s === 'pnl' || s === 'volume' || s === 'accountValue') board.update({ sort: s });
  };
  const vol = hasVolume(board.rows, view.window);
  const sort = usableSort(sortPick, vol);
  const cols = vol ? COLS : COLS.filter((c) => c !== 'volume' && c !== 'edge');
  const rows = useMemo(
    () => (board.rows ? shape(board.rows, { window: view.window, side: view.side, sort, q: view.q, asset, size }) : null),
    [board.rows, view.window, view.side, sort, view.q, asset, size],
  );
  const [setRoot, width] = useWidth<HTMLDivElement>();
  const split = width >= 1060;
  const [picked, setPicked] = useState<string | null>(null);
  const [sheet, setSheet] = useState(false);
  // A new hundred starts on its first trader (side by side); a phone opens nobody until a tap.
  useEffect(() => { setPicked(null); setSheet(false); }, [board.key]);
  const sel = rows?.find((r) => keyOf(r) === picked) ?? (split ? rows?.[0] ?? null : null);
  const me = address ? address.toLowerCase() : null;
  const masks = useMasks(me);
  const since = board.page?.index?.rankSince ?? null;
  const dir = dirOf(view.side, sort);
  const list = useRef<HTMLOListElement>(null);

  const open = (r: Row) => {
    setPicked(keyOf(r));
    if (!split) setSheet(true);
  };
  const onKey = (e: KeyboardEvent) => {
    if (!rows?.length || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
    e.preventDefault();
    const at = sel ? rows.indexOf(sel) : -1;
    const next = rows[Math.max(0, Math.min(rows.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))]!;
    setPicked(keyOf(next));
    const el = list.current?.querySelector<HTMLButtonElement>(`[data-k="${CSS.escape(keyOf(next))}"]`);
    el?.focus();
  };
  const venuesText = view.venues.length === 1 ? VENUE_LABEL[view.venues[0]!] : `${view.venues.length} platforms${board.mode === 'net' ? ', netted per address' : ''}`;
  const head = (col: SortKey) => (
    <button type="button" className={`lbv-th${sort === col ? ' is-on' : ''}`} onClick={() => pickSort(col)} title={SORT_HINT[col]} aria-pressed={sort === col}>
      {SORT_LABEL[col]}
      <svg viewBox="0 0 8 10" width="7" height="9" aria-hidden="true"><path d="M4 1 7 4H1z" opacity={sort === col && dir === 'asc' ? 1 : 0.35} /><path d="M4 9 1 6h6z" opacity={sort === col && dir === 'desc' ? 1 : 0.35} /></svg>
    </button>
  );

  return (
    <section ref={setRoot} className={`tf lbv lbv-desk${split ? ' is-split' : ''}${vol ? '' : ' is-novol'}${embedded ? ' is-embedded' : ''}`} aria-busy={board.loading}>
      {!embedded && (
        <header className="lbv-desk__top">
          <div>
            <h1 className="lbv-h1">Leaderboard</h1>
            <p className="lbv-lede">{view.side === 'top' ? 'Highest' : 'Lowest'} PnL over {WINDOW_LONG[view.window]} · {venuesText}</p>
          </div>
          <Search board={board} />
        </header>
      )}
      {width > 0 && width < 560 ? (
        <div className="lbv-desk__bar is-phone">
          <div className="lbv-bar-row">
            <SideTabs board={board} compact />
            <Venues board={board} noMode />
            <FilterButton board={board} narrow={narrow} sort={sort} onSort={pickSort} mode iconOnly />
          </div>
          <WindowSeg board={board} />
          {embedded && <Search board={board} placeholder="Search address" />}
        </div>
      ) : (
        <div className="lbv-desk__bar">
          <SideTabs board={board} />
          <WindowSeg board={board} />
          <Venues board={board} />
          <FilterButton board={board} narrow={narrow} sort={sort} onSort={pickSort} />
          {embedded && <Search board={board} placeholder="Search" />}
        </div>
      )}
      <ActiveChips board={board} narrow={narrow} />

      <div className="lbv-desk__grid">
        <div className="lbv-desk__list">
          <div className="lbv-desk__lh" role="presentation">
            <span className="c-rank">#</span>
            <span className="c-who">Trader{rows && board.rows && rows.length !== board.rows.length ? <em>{rows.length} of {board.rows.length}</em> : null}</span>
            {cols.map((c) => <span key={c} className={`c-${c}`}>{head(c)}</span>)}
          </div>
          <BoardState board={board} rows={rows} empty={view.q || asset !== 'all' || size !== 'all' ? 'No trader in this hundred matches' : board.minTrades === 2 ? 'No indexed trader has more than one trade in this window yet' : 'No traders in this hundred'} />
          {!rows && !board.unavailable && !(board.failed && !board.rows) && (
            <div className="lbv-desk__skel">{Array.from({ length: 10 }, (_, i) => <Skeleton key={i} className="lbv-skel-line" />)}</div>
          )}
          {rows && rows.length > 0 && (
            <ol ref={list} className="lbv-desk__rows" onKeyDown={onKey} aria-label="Traders">
              {rows.map((r, i) => {
                const k = keyOf(r);
                const on = sel ? keyOf(sel) === k : false;
                const pnl = r.pnl[view.window] ?? null;
                const edge = edgeOf(r, view.window);
                return (
                  <li key={k}>
                    <button type="button" data-k={k} className={`lbv-row${on ? ' is-on' : ''}`} onClick={() => open(r)} aria-current={on || undefined} tabIndex={on || (!sel && i === 0) ? 0 : -1}>
                      <span className="c-rank">{sort === 'pnl' ? <Place n={r.place} size="sm" /> : <span className="lbv-pos-n">{i + 1}</span>}{sort === 'pnl' && <Move rc={r.rankChange} since={since} />}</span>
                      <span className="c-who"><Who row={r} me={me} size={26} sub={<><VenueMarks venues={r.venues} size={13} /><Assets assets={r.assets} size={13} />{sort !== 'pnl' && <span className="lbv-hint">PnL #{r.place}</span>}</>} /></span>
                      <span className={`c-pnl ${toneOf(pnl)}`}>{masks.pnl(r, usdShort(pnl, true))}<small>{masks.equity(r, usdShort(r.accountValue))}</small></span>
                      <span className="c-accountValue">{masks.equity(r, usdShort(r.accountValue))}</span>
                      {vol && <span className="c-volume">{usdShort(r.volume[view.window] ?? null)}</span>}
                      {vol && <span className={`c-edge ${toneOf(edge)}`}>{bps(edge)}</span>}
                      <span className="c-winRate"><WinRate value={r.winRate} closes={r.winRateCloses} /></span>
                    </button>
                  </li>
                );
              })}
            </ol>
          )}
          <Notes board={board} className="lbv-desk__notes" />
        </div>
        {split && (
          <aside className="lbv-desk__side" aria-label="Trader">
            {sel ? (
              <div className="lbv-desk__panel">
                <TraderDetail key={keyOf(sel)} row={sel} window={view.window} side={view.side} me={me} rankSince={since} onScan={onScan} onCopy={onCopy} />
              </div>
            ) : (
              <div className="lbv-desk__panel is-wait"><Skeleton className="lbv-skel-detail" /></div>
            )}
          </aside>
        )}
      </div>
      {!split && sel && (
        <DetailSheet open={sheet} onClose={() => setSheet(false)} row={sel} window={view.window} side={view.side} me={me} rankSince={since} onScan={onScan} onCopy={onCopy} />
      )}
      {rows && <span className="lbv-sr" aria-live="polite">{fmtNum(rows.length)} traders, {SORT_LABEL[sort]} {dir === 'desc' ? 'high to low' : 'low to high'}</span>}
    </section>
  );
}
