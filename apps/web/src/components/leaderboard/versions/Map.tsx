/**
 * Version "Map": the hundred as a picture. Every trader is a dot - their PnL up, their volume (or account value)
 * across, both on log scales - with lines of equal edge through the field: a dot above the 100 bp line made more than
 * a cent per traded dollar. Dot size is the other measure, colour the platform or the win rate. A dot, or a row of
 * the table under the map, opens the trader beside it (a sheet on a phone).
 *
 * Every point is a board row's own figures; rows without them (no volume for 90D and YTD, a PnL on the other side of
 * zero than its board) are counted under the map, not drawn.
 */
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { DASH } from '../../../format';
import { fmtNum, localize } from '../../../numStyle';
import { VENUE_LABEL, type BoardWindow, type Venue } from '../../../vsApi';
import { VENUE_BRAND } from '../../venueBrand';
import { Segmented, Skeleton } from '../../bots/kit/kit';
import { LB_VENUES } from '../lbState';
import { ActiveChips, FilterButton, Search, SideTabs, Venues, WindowSeg, type Narrow } from './controls';
import { Assets, BoardState, DetailSheet, Notes, Place, TraderDetail, VenueMarks, Who, bps, toneOf, useMasks, usdShort, useWidth } from './parts';
import { SORT_LABEL, WINDOW_LONG, WINDOW_WORD, dirOf, edgeOf, hasVolume, shape, usableSort, useBoard, type AssetGroup, type Row, type SizeBand, type SortKey } from './useBoard';
import type { VersionProps } from './types';

type Axis = 'volume' | 'accountValue';
type Colour = 'venue' | 'winRate';
const keyOf = (r: Row) => `${r.venue}:${r.address}`;
const finite = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);
const COLS: SortKey[] = ['pnl', 'volume', 'edge', 'accountValue'];

/** "$10K", "$1M", "$10B": a decade's label. */
function decade(e: number): string {
  const v = 10 ** e;
  return localize(v >= 1e9 ? `$${v / 1e9}B` : v >= 1e6 ? `$${v / 1e6}M` : v >= 1e3 ? `$${v / 1e3}K` : `$${v}`);
}

/** A win rate's colour: neutral at 50%, greener above, redder below (the copy cards' WinRate scale). */
function winTone(w: number | null | undefined): string {
  if (!finite(w)) return 'rgb(var(--ink) / 0.3)';
  const t = Math.max(-1, Math.min(1, (w - 0.5) / 0.2));
  return t >= 0 ? `color-mix(in srgb, var(--pos) ${Math.round(30 + t * 70)}%, rgb(var(--ink) / 0.5))` : `color-mix(in srgb, var(--neg) ${Math.round(30 - t * 70)}%, rgb(var(--ink) / 0.5))`;
}

/** A venue's own colour, a step darker in the light theme where its pale ones would vanish (map.css --lbv-v-*). */
const venueInk = (v: Venue): string => `var(--lbv-v-${v}, ${VENUE_BRAND[v]})`;

interface Dot { row: Row; x: number; y: number; r: number; fill: string }

function Scatter({ rows, w, axis, colour, side, q, hover, picked, onHover, onPick, me }: {
  rows: Row[]; w: BoardWindow; axis: Axis; colour: Colour; side: 'top' | 'worst'; q: string;
  hover: string | null; picked: string | null; onHover: (k: string | null) => void; onPick: (r: Row) => void; me: string | null;
}) {
  const [setBox, width] = useWidth<HTMLDivElement>();
  const masks = useMasks(me);
  const W = Math.max(280, width);
  const H = W < 560 ? 300 : W < 900 ? 380 : 440;
  const m = { l: W < 560 ? 46 : 56, r: 14, t: 14, b: 30 };
  const sign = side === 'worst' ? -1 : 1;
  const xOf = (r: Row) => (axis === 'volume' ? r.volume[w] : r.accountValue);
  const sizeOf = (r: Row) => (axis === 'volume' ? r.accountValue : r.volume[w]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const usable = useMemo(() => rows.filter((r) => { const p = r.pnl[w]; const x = xOf(r); return finite(p) && sign * p > 0 && finite(x) && x > 0; }), [rows, w, axis, sign]);
  const skipped = rows.length - usable.length;

  const layout = useMemo(() => {
    if (!usable.length) return null;
    const xs = usable.map((r) => Math.log10(xOf(r)!));
    const ys = usable.map((r) => Math.log10(sign * r.pnl[w]!));
    const x0 = Math.floor(Math.min(...xs) - 0.05); const x1 = Math.ceil(Math.max(...xs) + 0.05);
    const y0 = Math.floor(Math.min(...ys) - 0.05); const y1 = Math.ceil(Math.max(...ys) + 0.05);
    const px = (lx: number) => m.l + ((lx - x0) / (x1 - x0 || 1)) * (W - m.l - m.r);
    const py = (ly: number) => m.t + (1 - (ly - y0) / (y1 - y0 || 1)) * (H - m.t - m.b);
    const sizes = usable.map(sizeOf).filter(finite).filter((v) => v > 0);
    const sMax = sizes.length ? Math.sqrt(Math.max(...sizes)) : 1;
    const big = W < 560 ? 10 : 14;
    const dots: Dot[] = usable.map((r) => {
      const s = sizeOf(r);
      return {
        row: r,
        x: px(Math.log10(xOf(r)!)),
        y: py(Math.log10(sign * r.pnl[w]!)),
        r: finite(s) && s > 0 ? 3 + (Math.sqrt(s) / sMax) * (big - 3) : 3.5,
        fill: colour === 'venue' ? venueInk(r.venues[0] ?? r.venue) : winTone(r.winRate),
      };
    }).sort((a, b) => b.r - a.r);
    // Lines of one ratio, PnL = k × x: straight on log-log, cut to the plot.
    const ks = axis === 'volume' ? [[-4, '1 bp'], [-3, '10 bp'], [-2, '100 bp'], [-1, '1,000 bp']] as const : [[-1, '0.1×'], [0, '1×'], [1, '10×'], [2, '100×'], [3, '1,000×']] as const;
    const guides = ks.flatMap(([lk, label]) => {
      const a = Math.max(x0, y0 - lk);
      const b = Math.min(x1, y1 - lk);
      if (b <= a) return [];
      return [{ label: localize(label), x1: px(a), y1: py(a + lk), x2: px(b), y2: py(b + lk) }];
    });
    const xt = Array.from({ length: x1 - x0 + 1 }, (_, i) => x0 + i);
    const yt = Array.from({ length: y1 - y0 + 1 }, (_, i) => y0 + i);
    return { dots, guides, xt, yt, px, py };
  }, [usable, W, H, axis, colour, w, sign]);

  const qq = q.trim().toLowerCase();
  const ringed = layout?.dots.find((d) => keyOf(d.row) === (hover ?? picked));
  // The tooltip follows the pointer only: the chosen trader is already beside the map.
  const hot = hover ? layout?.dots.find((d) => keyOf(d.row) === hover) : undefined;
  const pickAt = (e: { clientX: number; clientY: number; currentTarget: SVGSVGElement }) => {
    if (!layout) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * W;
    const y = ((e.clientY - rect.top) / rect.height) * H;
    let best: Dot | null = null; let bd = Infinity;
    for (const d of layout.dots) { const dd = Math.hypot(d.x - x, d.y - y) - d.r; if (dd < bd) { bd = dd; best = d; } }
    return best && bd < 14 ? best : null;
  };

  return (
    <div className="lbv-map__plotwrap" ref={setBox}>
      {!layout ? (
        <div className="lbv-map__none" style={{ height: H }}>{rows.length ? 'No trader here has the figures to draw' : ''}</div>
      ) : (
        <>
          <svg
            className="lbv-map__svg"
            viewBox={`0 0 ${W} ${H}`}
            width={W}
            height={H}
            role="img"
            aria-label={`${usable.length} traders: ${side === 'worst' ? 'loss' : 'PnL'} against ${axis === 'volume' ? 'volume' : 'account value'}, log scales. The table below lists them.`}
            onPointerMove={(e) => { const d = pickAt(e); onHover(d ? keyOf(d.row) : null); }}
            onPointerLeave={() => onHover(null)}
            onClick={(e) => { const d = pickAt(e); if (d) onPick(d.row); }}
          >
            {layout.xt.map((t) => <line key={`x${t}`} className="lbv-map__gl" x1={layout.px(t)} x2={layout.px(t)} y1={m.t} y2={H - m.b} />)}
            {layout.yt.map((t) => <line key={`y${t}`} className="lbv-map__gl" x1={m.l} x2={W - m.r} y1={layout.py(t)} y2={layout.py(t)} />)}
            {layout.guides.map((g) => (
              <g key={g.label} className="lbv-map__guide">
                <line x1={g.x1} y1={g.y1} x2={g.x2} y2={g.y2} />
                <text x={g.x2 - 4} y={g.y2 + 12} textAnchor="end">{g.label}</text>
              </g>
            ))}
            {layout.xt.map((t, i) => (i % (W < 560 && layout.xt.length > 5 ? 2 : 1) ? null : <text key={`xl${t}`} className="lbv-map__tick" x={layout.px(t)} y={H - 10} textAnchor="middle">{decade(t)}</text>))}
            {layout.yt.map((t) => <text key={`yl${t}`} className="lbv-map__tick" x={m.l - 8} y={layout.py(t) + 4} textAnchor="end">{side === 'worst' ? `−${decade(t)}` : decade(t)}</text>)}
            {layout.dots.map((d) => {
              const k = keyOf(d.row);
              const dim = qq && !d.row.address.toLowerCase().includes(qq);
              const on = k === picked;
              return (
                <circle
                  key={k}
                  cx={d.x}
                  cy={d.y}
                  r={d.r}
                  className={`lbv-map__dot${on ? ' is-on' : ''}${k === hover ? ' is-hover' : ''}${dim ? ' is-dim' : ''}${d.row.venues.length > 1 ? ' is-net' : ''}`}
                  style={{ '--dot': d.fill } as CSSProperties}
                />
              );
            })}
            {ringed && <circle cx={ringed.x} cy={ringed.y} r={ringed.r + 5} className="lbv-map__ring" />}
          </svg>
          {hot && (
            <div className={`lbv-map__tip${hot.x > W * 0.62 ? ' is-left' : ''}${hot.y < 90 ? ' is-low' : ''}`} style={{ left: hot.x, top: hot.y }} aria-hidden="true">
              <Who row={hot.row} me={me} size={22} sub={<VenueMarks venues={hot.row.venues} size={12} />} />
              <dl>
                <div><dt>PnL {WINDOW_WORD[w]}</dt><dd className={toneOf(hot.row.pnl[w])}>{masks.pnl(hot.row, usdShort(hot.row.pnl[w] ?? null, true))}</dd></div>
                <div><dt>{axis === 'volume' ? 'Volume' : 'Account'}</dt><dd>{axis === 'volume' ? usdShort(hot.row.volume[w] ?? null) : masks.equity(hot.row, usdShort(hot.row.accountValue))}</dd></div>
                <div><dt>{axis === 'volume' ? 'Edge' : 'PnL ÷ account'}</dt><dd className={axis === 'volume' ? toneOf(edgeOf(hot.row, w)) : ''}>{axis === 'volume' ? bps(edgeOf(hot.row, w)) : finite(hot.row.accountValue) && hot.row.accountValue > 0 ? `${fmtNum(Math.abs(hot.row.pnl[w]!) / hot.row.accountValue, { maximumFractionDigits: 1 })}×` : DASH}</dd></div>
              </dl>
              <span className="lbv-map__tipk">Rank {hot.row.place} · click to open</span>
            </div>
          )}
        </>
      )}
      {skipped > 0 && layout && <p className="lbv-map__skip">{skipped} {skipped === 1 ? 'trader is' : 'traders are'} not drawn: {axis === 'volume' ? 'no volume' : 'no account value'}{side === 'top' ? ' or no gain' : ' or no loss'} in this window</p>}
    </div>
  );
}

export function MapView({ address, onScan, onCopy, embedded }: VersionProps) {
  const board = useBoard(embedded);
  const { view } = board;
  const [axis, setAxis] = useState<Axis>('volume');
  const [colour, setColour] = useState<Colour>('venue');
  const [sortPick, setSort] = useState<SortKey>('pnl');
  const [asset, setAsset] = useState<AssetGroup>('all');
  const [size, setSize] = useState<SizeBand>('all');
  const narrow: Narrow = { asset, setAsset, size, setSize };
  const [hover, setHover] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [sheet, setSheet] = useState(false);
  const [setRoot, width] = useWidth<HTMLElement>();
  const split = width >= 1180;
  const phone = width > 0 && width < 560;
  const me = address ? address.toLowerCase() : null;
  const masks = useMasks(me);
  const since = board.page?.index?.rankSince ?? null;
  useEffect(() => { setPicked(null); setSheet(false); }, [board.key]);

  const noVolume = !hasVolume(board.rows, view.window);
  const cols = noVolume ? COLS.filter((c) => c !== 'volume' && c !== 'edge') : COLS;
  const ax: Axis = noVolume ? 'accountValue' : axis;
  const sort = usableSort(sortPick, !noVolume);
  // The map shows every match of the page's filters; the search only dims the others, so a trader is seen in the field.
  const field = useMemo(() => (board.rows ? shape(board.rows, { window: view.window, side: view.side, sort: 'pnl', q: '', asset, size }) : null), [board.rows, view.window, view.side, asset, size]);
  const rows = useMemo(() => (board.rows ? shape(board.rows, { window: view.window, side: view.side, sort, q: view.q, asset, size }) : null), [board.rows, view.window, view.side, sort, view.q, asset, size]);
  const sel = rows?.find((r) => keyOf(r) === picked) ?? field?.find((r) => keyOf(r) === picked) ?? (split ? field?.[0] ?? null : null);
  const pick = (r: Row) => { setPicked(keyOf(r)); if (!split) setSheet(true); };
  const present = LB_VENUES.filter((v) => field?.some((r) => r.venues[0] === v));
  const dir = dirOf(view.side, sort);
  const venuesText = view.venues.length === 1 ? VENUE_LABEL[view.venues[0]!] : `${view.venues.length} platforms`;

  const th = (c: SortKey) => (
    <th key={c} className={`c-${c}`}>
      <button type="button" className={`lbv-th${sort === c ? ' is-on' : ''}`} onClick={() => setSort(c)} aria-pressed={sort === c}>
        {SORT_LABEL[c]}
        <svg viewBox="0 0 8 10" width="7" height="9" aria-hidden="true"><path d="M4 1 7 4H1z" opacity={sort === c && dir === 'asc' ? 1 : 0.35} /><path d="M4 9 1 6h6z" opacity={sort === c && dir === 'desc' ? 1 : 0.35} /></svg>
      </button>
    </th>
  );

  return (
    <section ref={setRoot} className={`tf lbv lbv-map${split ? ' is-split' : ''}${embedded ? ' is-embedded' : ''}`} aria-busy={board.loading}>
      {!embedded && (
        <header className="lbv-map__top">
          <div>
            <h1 className="lbv-h1">Leaderboard</h1>
            <p className="lbv-lede">{view.side === 'top' ? 'The best' : 'The worst'} 100 over {WINDOW_LONG[view.window]} on {venuesText}, drawn by {view.side === 'top' ? 'PnL' : 'loss'} and {ax === 'volume' ? 'volume' : 'account value'}</p>
          </div>
          <Search board={board} placeholder="Find an address" />
        </header>
      )}
      {phone ? (
        <div className="lbv-desk__bar is-phone">
          <div className="lbv-bar-row"><SideTabs board={board} compact /><Venues board={board} noMode /><FilterButton board={board} narrow={narrow} mode iconOnly /></div>
          <WindowSeg board={board} />
          {embedded && <Search board={board} placeholder="Find an address" />}
        </div>
      ) : (
        <div className="lbv-desk__bar">
          <SideTabs board={board} />
          <WindowSeg board={board} />
          <Venues board={board} />
          <FilterButton board={board} narrow={narrow} />
          {embedded && <Search board={board} placeholder="Find" />}
        </div>
      )}
      <ActiveChips board={board} narrow={narrow} />

      <div className="lbv-map__grid">
        <div className="lbv-map__main">
          <div className="lbv-map__card">
            <div className="lbv-map__head">
              <h2>{view.side === 'top' ? 'PnL' : 'Loss'} against {ax === 'volume' ? 'volume' : 'account value'}</h2>
              <div className="lbv-map__ctl">
                <Segmented<Axis> label="Across" value={ax} onChange={setAxis} options={[{ value: 'volume', label: 'Volume', disabled: noVolume }, { value: 'accountValue', label: 'Account' }]} />
                <Segmented<Colour> label="Colour" value={colour} onChange={setColour} options={[{ value: 'venue', label: 'Platform' }, { value: 'winRate', label: 'Win rate' }]} />
              </div>
            </div>
            {field ? (
              <Scatter rows={field} w={view.window} axis={ax} colour={colour} side={view.side} q={view.q} hover={hover} picked={sel ? keyOf(sel) : null} onHover={setHover} onPick={pick} me={me} />
            ) : !board.unavailable && !(board.failed && !board.rows) ? <Skeleton className="lbv-skel-map" /> : null}
            <div className="lbv-map__legend">
              {colour === 'venue'
                ? present.map((v: Venue) => <span key={v}><i style={{ background: venueInk(v) }} />{VENUE_LABEL[v]}</span>)
                : <span className="lbv-map__wr"><i style={{ background: winTone(0.3) }} />30%<i style={{ background: winTone(0.5) }} />50%<i style={{ background: winTone(0.7) }} />70%<i style={{ background: winTone(null) }} />no rate</span>}
              {colour === 'venue' && field?.some((r) => r.venues.length > 1) && <span title="One address netted over several platforms; its colour is the first"><i className="is-net" />Netted</span>}
              <span className="lbv-map__lk">{ax === 'volume' ? 'Lines: PnL per traded dollar' : 'Lines: PnL as a multiple of account value'} · Dot size: {ax === 'volume' ? 'account value' : 'volume'}{noVolume ? ` · No volume for ${WINDOW_WORD[view.window]}` : ''}</span>
            </div>
          </div>

          <div className="lbv-map__tablecard">
            <BoardState board={board} rows={rows} empty={view.q || asset !== 'all' || size !== 'all' ? 'No trader in this hundred matches' : 'No traders in this hundred'} />
            {rows && rows.length > 0 && (
              <table className="lbv-map__table">
                <thead><tr><th className="c-rank">#</th><th className="c-who">Trader</th>{cols.map(th)}</tr></thead>
                <tbody>
                  {rows.map((r) => {
                    const k = keyOf(r);
                    const pnl = r.pnl[view.window] ?? null;
                    const edge = edgeOf(r, view.window);
                    return (
                      <tr key={k} className={`${sel && keyOf(sel) === k ? 'is-on' : ''}${hover === k ? ' is-hover' : ''}`} onPointerEnter={() => setHover(k)} onPointerLeave={() => setHover(null)}>
                        <td className="c-rank"><Place n={r.place} size="sm" /></td>
                        <td className="c-who"><button type="button" className="lbv-map__open" onClick={() => pick(r)}><Who row={r} me={me} size={24} sub={<><VenueMarks venues={r.venues} size={12} /><Assets assets={r.assets} size={12} /></>} /></button></td>
                        <td className={`c-pnl ${toneOf(pnl)}`}>{masks.pnl(r, usdShort(pnl, true))}</td>
                        {!noVolume && <td className="c-volume">{usdShort(r.volume[view.window] ?? null)}</td>}
                        {!noVolume && <td className={`c-edge ${toneOf(edge)}`}>{bps(edge)}</td>}
                        <td className="c-accountValue">{masks.equity(r, usdShort(r.accountValue))}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            <Notes board={board} className="lbv-map__notes" />
          </div>
        </div>
        {split && (
          <aside className="lbv-desk__side" aria-label="Trader">
            <div className="lbv-desk__panel">
              {sel ? <TraderDetail key={keyOf(sel)} row={sel} window={view.window} side={view.side} me={me} rankSince={since} onScan={onScan} onCopy={onCopy} /> : <Skeleton className="lbv-skel-detail" />}
            </div>
          </aside>
        )}
      </div>
      {!split && sel && <DetailSheet open={sheet} onClose={() => setSheet(false)} row={sel} window={view.window} side={view.side} me={me} rankSince={since} onScan={onScan} onCopy={onCopy} />}
    </section>
  );
}
