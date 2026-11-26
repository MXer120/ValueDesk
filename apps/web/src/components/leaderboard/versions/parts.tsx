/**
 * What the leaderboard versions share: a trader's identity, the board's notes, the figures' formats, and the trader's
 * detail (their curve, open positions and the Copy / Counter / Scan entries), read from the venue in this browser
 * like Scan does (vsApi.trader: one read, kept for a moment, the copy setup's prefetch reads the same).
 */
import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { COHORT_BY_ID, type CohortId } from '@sign/valuedesk/cohorts/model.js';
import { PROFILE_WINDOW } from '@sign/valuedesk/cardPeek.js';
import { useAsync } from '../../../hooks';
import { asOfText } from '../../../asOf';
import { DASH, MINUS, fmtUsd, shortAddr } from '../../../format';
import { fmtNum, localize } from '../../../numStyle';
import { maskAddress, useMask, usePrivacy } from '../../../privacy';
import { VENUE_LABEL, vsApi, type BoardWindow, type EquityPoint, type TraderProfile, type TraderRow, type Venue, type VsPosition } from '../../../vsApi';
import { CoinIcon } from '../../CoinIcon';
import { VenueLogo } from '../../VenueLogo';
import { Modal } from '../../Modal';
import { CohortIcon } from '../../explore/cohorts/CohortIcon';
import { Avatar, CopyButton, WinRate, fmtAgo } from '../../copy/TraderCard';
import { isCopyable } from '../../copy/gridModel';
import { Button, EmptyState, Icon, IconButton, Segmented, Skeleton, StatusPill } from '../../bots/kit/kit';
import { rankMove, rankMoveText, sodexTradesNote } from '../lbState';
import { WINDOW_WORD, edgeOf, sizeOf, type Board, type Row } from './useBoard';

const finite = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

/* ---------------------------------------------------------------------------------------- formats ----- */

const cut = (n: number) => (n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2));

/** "$120.6M", "−$23.4K"; under $1,000 whole dollars. `sign`: a "+" on gains. */
export function usdShort(v: number | null | undefined, sign = false): string {
  if (!finite(v)) return DASH;
  const a = Math.abs(v);
  const body = a >= 1e9 ? `$${cut(a / 1e9)}B` : a >= 1e6 ? `$${cut(a / 1e6)}M` : a >= 1e3 ? `$${cut(a / 1e3)}K` : `$${a.toFixed(0)}`;
  const s = v < 0 ? MINUS : sign && v > 0 ? '+' : '';
  return `${s}${localize(body)}`;
}

/** The full figure with its sign: "+$120,607,553" (whole dollars from $1,000, cents under). */
export function usdSigned(v: number | null | undefined): string {
  if (!finite(v)) return DASH;
  return `${v > 0 ? '+' : ''}${fmtUsd(v)}`;
}

/** Edge in basis points: "+14.6 bp". */
export function bps(v: number | null | undefined): string {
  if (!finite(v)) return DASH;
  const a = Math.abs(v);
  const body = fmtNum(a, { maximumFractionDigits: a >= 100 ? 0 : 1, minimumFractionDigits: a >= 100 ? 0 : 1 });
  return `${v > 0 ? '+' : v < 0 ? MINUS : ''}${body} bp`;
}

export function tradesText(r: TraderRow): string {
  if (!finite(r.trades)) return DASH;
  return `${fmtNum(r.trades)}${r.tradesCapped ? '+' : ''}`;
}

export const toneOf = (v: number | null | undefined): '' | 'pos' | 'neg' => (!finite(v) || v === 0 ? '' : v > 0 ? 'pos' : 'neg');

/* -------------------------------------------------------------------------------------- the marks ----- */

export function VenueMarks({ venues, size = 16 }: { venues: readonly Venue[]; size?: number }) {
  return (
    <span className="lbv-vm" title={venues.map((v) => VENUE_LABEL[v]).join(' + ')}>
      {venues.map((v) => <span key={v}><VenueLogo venue={v} size={size} /></span>)}
    </span>
  );
}

const ticker = (s: string) => s.replace(/^[a-z]+:/, '').replace(/-USD.*$/, '');

/** The row's largest open positions, as the live trader index lists them. */
export function Assets({ assets, max = 3, size = 16 }: { assets: readonly string[] | undefined; max?: number; size?: number }) {
  const list = (assets ?? []).slice(0, max);
  if (!list.length) return null;
  return (
    <span className="lbv-assets" title={`Largest open positions: ${(assets ?? []).map(ticker).join(', ')}`}>
      {list.map((a) => <CoinIcon key={a} coin={ticker(a)} size={size} />)}
    </span>
  );
}

/** Places moved on the board since its earlier snapshot; nothing when flat or unknown. */
export function Move({ rc, since }: { rc: number | null | undefined; since: number | null | undefined }) {
  const m = rankMove(rc);
  if (!m) return null;
  const t = rankMoveText(m, since);
  return (
    <span className={`lbv-move ${m.dir === 'up' ? 'pos' : 'neg'}`} title={t.title} aria-label={t.label}>
      <svg viewBox="0 0 8 8" width="7" height="7" aria-hidden="true"><path d={m.dir === 'up' ? 'M4 1 7.5 6.5h-7z' : 'M4 7 .5 1.5h7z'} /></svg>
      {m.n}
    </span>
  );
}

/** First, second, third: the metal as a tint; every other place a plain number. */
export function Place({ n, size = 'md' }: { n: number; size?: 'sm' | 'md' | 'lg' }) {
  const metal = n === 1 ? 'is-gold' : n === 2 ? 'is-silver' : n === 3 ? 'is-bronze' : '';
  return <span className={`lbv-place is-${size} ${metal}`} aria-label={`Rank ${n}`}>{n}</span>;
}

/** The Cohorts page's size band over the account value: its icon and name. */
export function SizePill({ row, size = 'sm' }: { row: TraderRow; size?: 'sm' | 'md' }) {
  const s = sizeOf(row);
  if (!s || s === 'all') return null;
  const def = COHORT_BY_ID[s as CohortId];
  return (
    <span className={`lbv-size is-${s} is-${size}`} title={`${def.name}: ${def.range.replace('equity', 'account value')} (the Cohorts page's size bands)`}>
      <CohortIcon id={s as CohortId} size={size === 'sm' ? 12 : 14} />{def.name}
    </span>
  );
}

export function YouPill() {
  return <span className="lbv-you">You</span>;
}

/** Who: the address's disc, its short address (masked for the viewer's own row when they hide it), and You. */
export function Who({ row, me, size = 28, sub }: { row: TraderRow; me: string | null; size?: number; sub?: ReactNode }) {
  const { isHidden } = usePrivacy();
  const mine = !!me && row.address.toLowerCase() === me;
  const name = mine && isHidden('address') ? maskAddress(row.address, true) : shortAddr(row.address);
  return (
    <span className="lbv-who">
      <Avatar address={row.address} size={size} />
      <span className="lbv-who__t">
        <span className="lbv-who__a">{name}{mine && <YouPill />}</span>
        {sub && <span className="lbv-who__s">{sub}</span>}
      </span>
    </span>
  );
}

/** The viewer's own PnL and account value follow their privacy switches; everyone else's are public board figures. */
export function useMasks(me: string | null) {
  const maskPnl = useMask('pnl');
  const maskEquity = useMask('equity');
  return useMemo(() => ({
    pnl: (row: TraderRow, text: string): ReactNode => (me && row.address.toLowerCase() === me ? maskPnl(text) : text),
    equity: (row: TraderRow, text: string): ReactNode => (me && row.address.toLowerCase() === me ? maskEquity(text) : text),
  }), [me, maskPnl, maskEquity]);
}

/* ------------------------------------------------------------------------------------ board notes ----- */

/**
 * What the board says about itself, in one line of pills: where the figures come from (its title), indexing still
 * running, SoDEX's trade counts being floors, a venue that did not answer, and an answer drawn from the kept copy.
 */
export function Notes({ board, className }: { board: Board; className?: string }) {
  const p = board.page;
  if (!p) return null;
  const pending = p.index && !p.index.complete ? p.index.pending : 0;
  const asOf = board.heldAt ? asOfText(board.heldAt) : null;
  return (
    <div className={`lbv-notes ${className ?? ''}`}>
      <span className="lbv-notes__src" title={p.source}><Icon name="layers" size={13} />{p.source}</span>
      {p.index && !p.index.complete && (
        <StatusPill size="sm" tone="neutral" dot pulse title={pending > 0 ? `${fmtNum(pending)} traders ranked here wait for a trade check, so the order can still change` : 'The ranking source is loading'}>
          {pending > 0 ? `Indexing ${fmtNum(pending)}` : 'Indexing'}
        </StatusPill>
      )}
      {p.sodexTrades && <StatusPill size="sm" tone="neutral" title={sodexTradesNote(p.sodexTrades)}>SoDEX trades are floors</StatusPill>}
      {p.partial?.length ? <StatusPill size="sm" tone="warning" icon="warning">{p.partial.map((v) => VENUE_LABEL[v]).join(' and ')} not loaded</StatusPill> : null}
      {asOf && <StatusPill size="sm" tone="neutral" icon="clock">{asOf}</StatusPill>}
    </div>
  );
}

/** The board's states other than rows: not available, failed, or nothing left after the page's own filters. */
export function BoardState({ board, rows, empty }: { board: Board; rows: Row[] | null; empty: string }) {
  if (board.unavailable) return <EmptyState compact icon="chart" title="This leaderboard is not available yet" />;
  if (board.failed && !board.rows) return <EmptyState compact tone="error" icon="warning" title="The leaderboard did not load" actions={<Button onClick={board.refresh}>Try again</Button>} />;
  if (rows && !rows.length) return <EmptyState compact icon="search" title={empty} />;
  return null;
}

/* ------------------------------------------------------------------------------------- the curve ----- */

type Series = 'pnl' | 'accountValue';

function pointsOf(series: EquityPoint[] | undefined, s: Series): Array<{ t: number; v: number }> {
  return (series ?? []).flatMap((p) => (finite(p[s]) ? [{ t: p.t, v: p[s]! }] : []));
}

const dayText = (t: number, long: boolean) => new Date(t).toLocaleString(undefined, long ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' } : { month: 'short', day: 'numeric' });

/** A trader's curve with a pointer readout: the series' value at the time under the pointer. */
export function Curve({ pts, kind, height = 150, compact }: { pts: Array<{ t: number; v: number }>; kind: Series; height?: number; compact?: boolean }) {
  const id = useId().replace(/:/g, '');
  const box = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<number | null>(null);
  if (pts.length < 2) return <div className="lbv-curve is-empty" style={{ height }}><span>No curve for this window</span></div>;
  const W = 600;
  const H = 200;
  const vals = pts.map((p) => p.v);
  const lo = kind === 'pnl' ? Math.min(0, ...vals) : Math.min(...vals);
  const hi = kind === 'pnl' ? Math.max(0, ...vals) : Math.max(...vals);
  const span = hi - lo || 1;
  const t0 = pts[0]!.t;
  const t1 = pts[pts.length - 1]!.t;
  const x = (t: number) => ((t - t0) / (t1 - t0 || 1)) * W;
  const y = (v: number) => 8 + (1 - (v - lo) / span) * (H - 16);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
  const last = pts[pts.length - 1]!;
  const up = kind === 'pnl' ? last.v >= 0 : last.v >= pts[0]!.v;
  const zero = kind === 'pnl' ? y(0) : null;
  const shown = at === null ? last : pts[at]!;
  const move = (clientX: number) => {
    const r = box.current?.getBoundingClientRect();
    if (!r || r.width <= 0) return;
    const t = t0 + ((clientX - r.left) / r.width) * (t1 - t0);
    let best = 0;
    for (let i = 1; i < pts.length; i++) if (Math.abs(pts[i]!.t - t) < Math.abs(pts[best]!.t - t)) best = i;
    setAt(best);
  };
  const long = t1 - t0 < 3 * 86_400_000;
  return (
    <div className={`lbv-curve ${up ? 'is-up' : 'is-down'}${compact ? ' is-compact' : ''}`}>
      <div className="lbv-curve__read" aria-live="off">
        <b className={kind === 'pnl' ? toneOf(shown.v) : ''}>{kind === 'pnl' ? usdSigned(shown.v) : fmtUsd(shown.v)}</b>
        <span>{at === null ? 'Now' : dayText(shown.t, long)}</span>
      </div>
      <div
        ref={box}
        className="lbv-curve__plot"
        style={{ height }}
        onPointerMove={(e) => move(e.clientX)}
        onPointerLeave={() => setAt(null)}
        role="img"
        aria-label={`${kind === 'pnl' ? 'PnL' : 'Account value'} from ${dayText(t0, false)} to ${dayText(t1, false)}, now ${kind === 'pnl' ? usdSigned(last.v) : fmtUsd(last.v)}`}
      >
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
          <defs>
            <linearGradient id={`${id}-f`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="currentColor" stopOpacity="0.26" />
              <stop offset="1" stopColor="currentColor" stopOpacity="0" />
            </linearGradient>
          </defs>
          {[0.25, 0.5, 0.75].map((f) => <line key={f} x1="0" x2={W} y1={H * f} y2={H * f} className="lbv-curve__grid" />)}
          {zero !== null && <line x1="0" x2={W} y1={zero} y2={zero} className="lbv-curve__zero" />}
          <path d={`${line}L${W},${H}L0,${H}Z`} fill={`url(#${id}-f)`} />
          <path d={line} className="lbv-curve__line" />
          {at !== null && <line x1={x(shown.t)} x2={x(shown.t)} y1="0" y2={H} className="lbv-curve__x" />}
        </svg>
        <span className="lbv-curve__dot" style={{ left: `${(x(shown.t) / W) * 100}%`, top: `${(y(shown.v) / H) * 100}%` }} />
        <span className="lbv-curve__hi">{kind === 'pnl' ? usdShort(hi, true) : usdShort(hi)}</span>
        <span className="lbv-curve__lo">{kind === 'pnl' ? usdShort(lo, true) : usdShort(lo)}</span>
      </div>
      <div className="lbv-curve__ax"><span>{dayText(t0, long)}</span><span>{dayText(t1, long)}</span></div>
    </div>
  );
}

/* ---------------------------------------------------------------------------------- the positions ----- */

function Positions({ list, max, venue }: { list: VsPosition[]; max: number; venue: Venue }) {
  const sorted = [...list].sort((a, b) => Math.abs(b.notional) - Math.abs(a.notional));
  const shown = sorted.slice(0, max);
  const gross = sorted.reduce((n, p) => n + Math.abs(p.notional), 0);
  const long = sorted.filter((p) => p.side === 'long').reduce((n, p) => n + Math.abs(p.notional), 0);
  if (!list.length) return <p className="lbv-pos__none">No open positions on {VENUE_LABEL[venue]} right now.</p>;
  return (
    <div className="lbv-pos">
      <div className="lbv-pos__bias" title={`Long ${usdShort(long)} · Short ${usdShort(gross - long)}`}>
        <span className="lbv-pos__bar"><i style={{ width: `${gross > 0 ? (long / gross) * 100 : 50}%` }} /></span>
        <span><b className="pos">{gross > 0 ? Math.round((long / gross) * 100) : 0}%</b> long</span>
        <span><b>{usdShort(gross)}</b> open</span>
      </div>
      <ul>
        {shown.map((p) => (
          <li key={`${p.symbol}-${p.side}`}>
            <CoinIcon coin={ticker(p.symbol)} size={20} />
            <span className="lbv-pos__sym">
              <b>{ticker(p.symbol)}</b>
              <small><span className={p.side === 'long' ? 'pos' : 'neg'}>{p.side === 'long' ? 'Long' : 'Short'}</span>{finite(p.leverage) ? ` · ${fmtNum(p.leverage, { maximumFractionDigits: 1 })}x` : ''}</small>
            </span>
            <span className="lbv-pos__n">
              <b>{usdShort(Math.abs(p.notional))}</b>
              <small className={toneOf(p.uPnl)}>{finite(p.uPnl) ? usdShort(p.uPnl, true) : DASH}</small>
            </span>
          </li>
        ))}
      </ul>
      {sorted.length > max && <p className="lbv-pos__more">{sorted.length - max} more in Scan</p>}
    </div>
  );
}

/* ------------------------------------------------------------------------------------- the detail ----- */

export type OnCopy = (address: string, venue: Venue, direction: 'copy' | 'counter') => void;

export interface DetailProps {
  row: Row;
  window: BoardWindow;
  side: 'top' | 'worst';
  me: string | null;
  rankSince: number | null;
  onScan: (address: string, venue?: Venue) => void;
  onCopy: OnCopy;
  /** 'panel': one column (a side panel or a sheet); 'wide': three columns under a row. */
  layout?: 'panel' | 'wide';
  onClose?: () => void;
}

/** The figures the board carries for this row, as tiles, and the newest trade the venue's profile has (`last`). */
function Figures({ row, w, me, last }: { row: Row; w: BoardWindow; me: string | null; last: number | null | undefined }) {
  const masks = useMasks(me);
  const pnl = row.pnl[w] ?? null;
  const edge = edgeOf(row, w);
  return (
    <dl className="lbv-figs">
      <div className="is-big"><dt>PnL {WINDOW_WORD[w]}</dt><dd className={toneOf(pnl)}>{masks.pnl(row, usdSigned(pnl))}</dd></div>
      <div><dt>Account value</dt><dd>{masks.equity(row, fmtUsd(row.accountValue, 0))}</dd></div>
      <div><dt>Volume {WINDOW_WORD[w]}</dt><dd>{usdShort(row.volume[w] ?? null)}</dd></div>
      <div title="PnL per traded dollar in the window"><dt>Edge</dt><dd className={toneOf(edge)}>{bps(edge)}</dd></div>
      <div><dt>Win rate</dt><dd><WinRate value={row.winRate} closes={row.winRateCloses} /></dd></div>
      <div><dt>Trades</dt><dd>{tradesText(row)}</dd></div>
      <div title="The newest trade the venue shows for this account"><dt>Last trade</dt><dd>{last === undefined ? <Skeleton className="lbv-skel-fig" /> : last ? fmtAgo(last) : DASH}</dd></div>
    </dl>
  );
}

export function TraderDetail({ row, window: w, side, me, rankSince, onScan, onCopy, layout = 'panel', onClose }: DetailProps) {
  const [venue, setVenue] = useState<Venue>(row.venue);
  useEffect(() => setVenue(row.venue), [row.address, row.venue]);
  const [series, setSeries] = useState<Series>('pnl');
  const { data, error, loading, refresh } = useAsync<TraderProfile | null>(() => vsApi.trader(venue, row.address), [venue, row.address]);
  const p = data && data.summary.address.toLowerCase() === row.address.toLowerCase() ? data : null;
  const curveWindow = PROFILE_WINDOW[w];
  const pts = pointsOf(p?.equity[curveWindow], series);
  const copyable = isCopyable(venue);
  const direction = side === 'worst' ? 'counter' : 'copy';
  const [copied, setCopied] = useState(false);
  const copyAddr = () => {
    void navigator.clipboard?.writeText(row.address).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1400); }, () => {});
  };
  const curveNote = curveWindow !== w ? `${WINDOW_WORD[curveWindow]} curve: the venue has none for ${WINDOW_WORD[w]}` : null;
  const head = (
    <header className="lbv-d__head">
      <Avatar address={row.address} size={layout === 'wide' ? 40 : 44} />
      <div className="lbv-d__id">
        <span className="lbv-d__addr">
          <span title={row.address}>{shortAddr(row.address)}</span>
          {me && row.address.toLowerCase() === me && <YouPill />}
          <button type="button" className="lbv-icon" onClick={copyAddr} aria-label="Copy address" title={copied ? 'Copied' : 'Copy address'}>
            {copied ? <Icon name="check" size={13} /> : <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="2" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M10.5 3.4A1.9 1.9 0 0 0 8.6 1.5H4.4a1.9 1.9 0 0 0-1.9 1.9v4.2a1.9 1.9 0 0 0 1.9 1.9" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>}
          </button>
        </span>
        <span className="lbv-d__meta">
          <span className="lbv-rankpill"><Place n={row.place} size="sm" />of {side === 'worst' ? 'worst' : 'top'} 100<Move rc={row.rankChange} since={rankSince} /></span>
          <SizePill row={row} />
          <VenueMarks venues={row.venues} size={15} />
        </span>
      </div>
      {onClose && <IconButton icon="x" label="Close" onClick={onClose} className="lbv-d__x" />}
    </header>
  );
  const venuePick = row.venues.length > 1 && (
    <Segmented<Venue>
      label="Whose account"
      value={venue}
      onChange={setVenue}
      options={row.venues.map((v) => ({ value: v, label: <span className="lbv-segv"><VenueLogo venue={v} size={14} />{VENUE_LABEL[v]}</span> }))}
    />
  );
  const curve = (
    <section className="lbv-d__curve" aria-label="Curve">
      <div className="lbv-d__bar">
        <Segmented<Series> label="Curve" value={series} onChange={setSeries} options={[{ value: 'pnl', label: 'PnL' }, { value: 'accountValue', label: 'Account value' }]} />
        <span className="lbv-d__win">{WINDOW_WORD[curveWindow]}<span className="lbv-d__venue"><VenueLogo venue={venue} size={13} />{VENUE_LABEL[venue]}</span></span>
      </div>
      {loading && !p ? <Skeleton className={layout === 'wide' ? 'lbv-skel-curve is-tall' : 'lbv-skel-curve'} /> : p?.analyticsSuspect ? <div className="lbv-curve is-empty"><span>{VENUE_LABEL[venue]}'s analytics for this account look wrong, so no curve is drawn</span></div> : <Curve pts={pts} kind={series} height={layout === 'wide' ? 216 : 140} />}
      {curveNote && <p className="lbv-d__fine">{curveNote}</p>}
    </section>
  );
  const positions = (
    <section className="lbv-d__pos" aria-label="Open positions">
      <h4>Open positions{p ? <span>{p.positions.length}</span> : null}{p && finite(p.openOrders) && p.openOrders > 0 ? <em>{fmtNum(p.openOrders)} open orders</em> : null}</h4>
      {loading && !p ? <div className="lbv-skel-rows">{[0, 1, 2].map((i) => <Skeleton key={i} className="lbv-skel-row" />)}</div>
        : error && !p ? <EmptyState compact tone="error" icon="warning" title={`${VENUE_LABEL[venue]} did not answer`} actions={<Button onClick={refresh}>Try again</Button>} />
        : !p ? <p className="lbv-pos__none">No {VENUE_LABEL[venue]} account at this address.</p>
        : <Positions list={p.positions} max={layout === 'wide' ? 5 : 6} venue={venue} />}
    </section>
  );
  const actions = (
    <footer className="lbv-d__act">
      {copyable
        ? <CopyButton kind={direction} size="lg" label={direction === 'copy' ? 'Copy this trader' : 'Counter-trade'} onClick={() => onCopy(row.address, venue, direction)} title={direction === 'copy' ? 'Open the copy setup for this trader' : 'Open the copy setup to take the other side of this trader'} />
        : <span className="lbv-d__nocopy" title="Copying follows SoDEX and Hyperliquid traders"><Icon name="shield" size={14} />Copy follows SoDEX and Hyperliquid</span>}
      <Button variant="secondary" size="md" icon="search" onClick={() => onScan(row.address, venue)}>Open in Scan</Button>
    </footer>
  );
  const source = p ? <p className="lbv-d__fine" title={p.source}>Curve and positions from {VENUE_LABEL[venue]}, read {fmtAgo(p.updatedAt)}; the figures above are the board's.</p> : null;
  const last = loading && !p ? undefined : p?.summary.lastActive ?? null;

  if (layout === 'wide') {
    return (
      <div className="lbv-d is-wide">
        <div className="lbv-d__c1">{head}{venuePick}<Figures row={row} w={w} me={me} last={last} />{actions}</div>
        <div className="lbv-d__c2">{curve}</div>
        <div className="lbv-d__c3">{positions}{source}</div>
      </div>
    );
  }
  return (
    <div className="lbv-d">
      {head}
      {venuePick}
      <Figures row={row} w={w} me={me} last={last} />
      {curve}
      {positions}
      {actions}
      {source}
    </div>
  );
}

/** The detail as a phone sheet (and a dialog on a narrow widget): the app's Modal, dragged down to close. */
export function DetailSheet(props: Omit<DetailProps, 'layout' | 'onClose'> & { open: boolean; onClose: () => void }) {
  const { open, onClose, ...rest } = props;
  return (
    <Modal open={open} onClose={onClose} title="Trader" sheet size="md" className="lbv-sheet">
      <div className="tf lbv-sheet__in"><TraderDetail {...rest} layout="panel" /></div>
    </Modal>
  );
}

/* ------------------------------------------------------------------------------------------ misc ----- */

/** The element's width, followed (a version lays out by its own width, so a terminal widget gets the narrow one). */
export function useWidth<T extends HTMLElement>(): [(el: T | null) => void, number] {
  const [el, setEl] = useState<T | null>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    if (!el) return;
    setW(el.getBoundingClientRect().width);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((es) => { const r = es[0]?.contentRect; if (r) setW(r.width); });
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [setEl, w];
}

/** A plain style object with CSS custom properties. */
export const vars = (o: Record<string, string | number>): CSSProperties => o as CSSProperties;
