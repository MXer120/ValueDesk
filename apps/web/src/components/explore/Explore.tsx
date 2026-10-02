/**
 * Explore: discover traders across venues.
 *
 * BUILT FROM VALUETRADE'S OWN PIECES, NOT A NEW LOOK. The page is a dashboard -
 * the same react-grid-layout machinery, 4px gutters and card panels as
 * /portfolio and /points - and every panel is the portfolio design system's
 * `Card` / `Stat` (components/Portfolio.tsx), scoped under `.pf` the way those
 * two pages scope it. Tables are the account band's `.acct-table` (20px rows,
 * sentence-case heads, hover tint, text actions), the large-trade tape is the
 * trade page's `.mkt-tapetable`, the long/short bar is the exposure card's
 * `.pf-split`, and the venue and size selectors are `.pf-seg` segments.
 * Explore.css only fits those together; it introduces no colour, size or radius.
 *
 * EVERY SECTION FAILS ON ITS OWN. Rankings, the tape and positioning are three
 * requests; each renders its own loading / not-available / error / empty state,
 * so a venue whose backend is not built yet reads as "not available yet" in the
 * sections it feeds and nowhere else.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Dashboard } from '../../dashboard/Dashboard';
import type { DashboardConfig, PanelDefinition, PanelPlacement } from '../../dashboard/types';
import { Card, Stat } from '../portfolio/parts';
import { LoadFailed, logLoadFailure } from '../LoadFailed';
import { useAsync, useStored, useSymbols } from '../../hooks';
import { usePrivacy, maskAddress } from '../../privacy';
import { DASH, marketName, shortAddr } from '../../format';
import {
  vsApi, VsError, VENUE_LABEL, VS_VENUES,
  type ExploreResponse, type Positioning, type TraderRow, type Venue, type WhaleTrade,
} from '../../vsApi';
import {
  SEGMENT_COLUMNS, SEGMENT_FALLBACK, SEGMENT_IDS, VENUE_SHORT, WHALE_MIN_OPTIONS,
  fmtCell, fmtClock, fmtCount, fmtPx, fmtUsdExact, fmtUsdShort, longShare, marketKey,
  rollUpPositioning, rowsFor, tradeKeys,
  type SegmentId, type VenueFilter,
} from './model';
import '../Account.css';
import './Explore.css';
import { Cohorts } from './cohorts/Cohorts';

type ExploreView = 'overview' | 'cohorts';
const viewFromUrl = (): ExploreView => (new URLSearchParams(window.location.search).get('view') === 'cohorts' ? 'cohorts' : 'overview');

export interface ExploreProps {
  address: string | null;
  onScan: (address: string, venue?: Venue) => void;
  onOpenCopy: (address: string, venue: Venue) => void;
  onOpenSymbol: (symbol: string) => void;
}

/* ===========================================================================
 *  DATA
 * ======================================================================== */

interface Section<T> {
  data: T | null;
  error: { message: string; code?: string } | null;
  /** No answer yet for the current request. */
  loading: boolean;
  /** Showing the last good answer because the latest refresh failed. */
  stale: boolean;
  /** Ask again now (the Retry of a failed section). */
  retry: () => void;
}

type Settled<T> =
  | { key: string; ok: true; value: T }
  | { key: string; ok: false; message: string; code?: string };

/**
 * `useAsync`, keeping the error CODE and the last good answer.
 *
 * useAsync flattens a rejection to a string, and the page needs the code to tell
 * "this venue is not built yet" (`not_available`) from "the request failed". So
 * the fetch is settled into a value first and never rejects.
 *
 * `key` names the request. An answer for an older key (the venue filter just
 * changed) is not shown under the new one - the tape must not list SoDEX prints
 * under a Hyperliquid filter for the second it takes the new answer to land.
 */
function useSection<T>(
  what: string,
  key: string,
  fetcher: () => Promise<T>,
  opts: { pollMs?: number; enabled?: boolean },
): Section<T> {
  const { data: settled, refresh: retry } = useAsync<Settled<T>>(
    () => fetcher().then(
      (value): Settled<T> => ({ key, ok: true, value }),
      (e: unknown): Settled<T> => {
        // The reason is for the console; the page only says "<What> couldn't load."
        if (!(e instanceof VsError && e.code === 'not_available')) logLoadFailure(what, e);
        return {
          key,
          ok: false,
          message: e instanceof Error ? e.message : String(e),
          code: e instanceof VsError ? e.code : undefined,
        };
      },
    ),
    [key],
    opts,
  );

  const good = useRef<{ key: string; value: T } | null>(null);
  const cur = settled && settled.key === key ? settled : null;
  if (cur?.ok && good.current?.value !== cur.value) good.current = { key, value: cur.value };
  const last = good.current?.key === key ? good.current.value : null;

  if (!cur) return { data: last, error: null, loading: last === null, stale: false, retry };
  if (cur.ok) return { data: cur.value, error: null, loading: false, stale: false, retry };
  const error = { message: cur.message, code: cur.code };
  // "Not available" is an answer, not a blip: never paper over it with old rows.
  if (cur.code === 'not_available' || last === null) return { data: null, error, loading: false, stale: false, retry };
  return { data: last, error, loading: false, stale: true, retry };
}

/** Polls stop while the tab is hidden and catch up the moment it is shown. */
function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden');
  useEffect(() => {
    const on = () => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);
  return visible;
}

interface ExploreContext {
  address: string | null;
  venue: VenueFilter;
  setVenue: (v: VenueFilter) => void;
  explore: Section<ExploreResponse>;
  whales: Section<WhaleTrade[]>;
  minUsd: number;
  setMinUsd: (n: number) => void;
  positioning: Section<Positioning[]>;
  /** Market key -> SoDEX perps market name (`BTC` -> `BTC-USD`). */
  perps: ReadonlyMap<string, string>;
  onScan: ExploreProps['onScan'];
  onOpenCopy: ExploreProps['onOpenCopy'];
  onOpenSymbol: ExploreProps['onOpenSymbol'];
}

const VENUE_FILTERS: readonly VenueFilter[] = ['all', ...VS_VENUES];
const DEFAULT_MIN_USD = 100_000;
/** Five seconds: the same floor the trade tape's REST mode polls at. */
const TAPE_POLL_MS = 5_000;
const POSITIONING_POLL_MS = 30_000;
/** The server rebuilds rankings at most once a minute. */
const EXPLORE_POLL_MS = 60_000;
const SEGMENT_ROWS = 10;
const TAPE_ROWS = 40;

/* ===========================================================================
 *  SMALL PIECES
 * ======================================================================== */

/**
 * A segmented control on the design system's classes - the same local helper
 * Points.tsx keeps, because `PeriodSeg` is welded to the period union.
 */
function Seg<T extends string | number>({ value, options, onChange, label }: {
  value: T;
  options: ReadonlyArray<{ v: T; label: string; hint?: string }>;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="pf-seg" role="tablist" aria-label={label}>
      {options.map((o) => (
        <button
          key={String(o.v)}
          type="button"
          role="tab"
          aria-selected={o.v === value}
          title={o.hint}
          className={`pf-ctl ${o.v === value ? 'is-on' : ''}`}
          onClick={() => onChange(o.v)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

const VENUE_OPTIONS = VENUE_FILTERS.map((v) => ({
  v,
  label: v === 'all' ? 'All' : VENUE_LABEL[v],
  hint: v === 'all' ? 'Every venue' : `${VENUE_LABEL[v]} only`,
}));

const MIN_OPTIONS = WHALE_MIN_OPTIONS.map((o) => ({ v: o.v, label: o.label, hint: `Trades of ${o.label} or more` }));

function VenueBadge({ venue }: { venue: Venue }) {
  return <span className="badge vs-venue" title={VENUE_LABEL[venue]}>{VENUE_SHORT[venue]}</span>;
}

/** Enter and Space on a row that behaves like a link. */
const onActivate = (fn: () => void) => (e: KeyboardEvent) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    fn();
  }
};

/** The sentence a section shows instead of rows. */
function Notice({ children, warn }: { children: ReactNode; warn?: boolean }) {
  return warn ? <p className="pf-note pf-note--warn vs-notice">{children}</p> : <p className="pf-empty">{children}</p>;
}

function venueWord(v: VenueFilter): string {
  return v === 'all' ? '' : `${VENUE_LABEL[v]} `;
}

/**
 * Loading / not-available / failed, or null when the section has data to show.
 * `what` is the thing the section lists, as it reads mid-sentence.
 */
function sectionState<T>(s: Section<T>, what: string, venue: VenueFilter) {
  if (s.data !== null) return null;
  if (s.loading) return <Notice>Loading…</Notice>;
  if (s.error?.code === 'not_available') {
    const w = `${venueWord(venue)}${what}`;
    return <Notice>{w.charAt(0).toUpperCase() + w.slice(1)} {what.endsWith('s') ? 'are' : 'is'} not available yet.</Notice>;
  }
  if (s.error) return <LoadFailed what={what.charAt(0).toUpperCase() + what.slice(1)} onRetry={s.retry} />;
  return null;
}

function StaleNote({ s }: { s: Section<unknown> }) {
  if (!s.stale) return null;
  return (
    <p className="pf-note pf-note--warn vs-stale">
      The last refresh failed; showing the previous answer.
    </p>
  );
}

/* ===========================================================================
 *  PANELS
 * ======================================================================== */

function OverviewPanel({ c }: { c: ExploreContext }) {
  const ex = c.explore;
  const k = ex.data?.kpis ?? null;
  const live = new Set(k?.venues ?? []);

  return (
    <Card
      title="Explore"
      className="vs-card vs-card--flush"
      action={<Seg value={c.venue} options={VENUE_OPTIONS} onChange={c.setVenue} label="Venue" />}
    >
      <div className="pf-statstrip vs-kpis">
        <Stat
          label="Traders tracked"
          value={k ? fmtCount(k.tracked) : DASH}
          cls={k ? undefined : 'pf-dim'}
          hint="Every account the live venues rank, summed across venues. The venue filter does not change it."
        />
        <Stat
          label="24h volume, top traders"
          value={fmtUsdShort(k?.volume24h)}
          cls={k?.volume24h != null ? undefined : 'pf-dim'}
          hint={
            k?.volume24h != null
              ? `${fmtUsdExact(k.volume24h)} - summed over the top traders Explore holds, not the venues' total.`
              : 'No venue reports a 24h volume for its top traders yet.'
          }
        />
        <div className="pf-stat" title="Which venues answered the last ranking request.">
          <span className="pf-stat__label">Venues</span>
          <span className="vs-venues">
            {VS_VENUES.map((v) => {
              const state = !ex.data && ex.loading ? 'pending' : live.has(v) ? 'live' : 'down';
              return (
                <span
                  key={v}
                  className={`pf-chip ${state === 'live' ? 'pf-chip--ok' : state === 'down' ? 'pf-chip--warn' : ''}`}
                >
                  {VENUE_LABEL[v]}
                  {state === 'live' ? ' live' : state === 'down' ? ' unavailable' : ''}
                </span>
              );
            })}
          </span>
        </div>
        <Stat
          label="Snapshot"
          value={ex.data ? fmtClock(ex.data.updatedAt) : DASH}
          cls={ex.data ? undefined : 'pf-dim'}
          hint="Time of the oldest leaderboard snapshot on this page. Rankings refresh every minute."
        >
          {/* Said once, here, for all six rankings - they share this one request. */}
          {ex.stale ? (
            <span className="pf-stat__sub pf-note--warn">
              Last refresh failed; showing the previous rankings.
            </span>
          ) : null}
        </Stat>
      </div>
    </Card>
  );
}

function TraderCell({ r, me }: { r: TraderRow; me: boolean }) {
  const hidden = usePrivacy().isHidden('address') && me;
  return (
    <span className="vs-trader" title={hidden ? undefined : r.address}>
      <code>{hidden ? maskAddress(r.address, true) : shortAddr(r.address)}</code>
      <VenueBadge venue={r.venue} />
      {me ? <span className="badge vs-you">you</span> : null}
    </span>
  );
}

function SegmentPanel({ c, id }: { c: ExploreContext; id: SegmentId }) {
  const ex = c.explore;
  const seg = ex.data?.segments.find((s) => s.id === id) ?? null;
  const meta = seg ?? SEGMENT_FALLBACK[id];
  const cols = SEGMENT_COLUMNS[id];
  const me = c.address?.toLowerCase() ?? null;

  let body: ReactNode = sectionState(ex, 'trader rankings', 'all');
  if (!body && ex.data) {
    const live = ex.data.kpis.venues;
    const rows = seg ? rowsFor(seg.rows, c.venue, SEGMENT_ROWS) : [];
    if (c.venue !== 'all' && !live.includes(c.venue)) {
      body = <Notice>{VENUE_LABEL[c.venue]} rankings are not available yet.</Notice>;
    } else if (!seg) {
      body = <Notice>This list is not served yet.</Notice>;
    } else if (!rows.length) {
      body = <Notice>No {venueWord(c.venue)}trader qualifies yet.</Notice>;
    } else {
      body = (
        <div className="acct vs-acct pf-tablewrap">
          <table className="acct-table vs-table">
            <thead>
              <tr>
                <th>Trader</th>
                {cols.map((col, i) => <th key={col.key} className={`num vs-col-${i + 1}`}>{col.head}</th>)}
                <th aria-label="Row actions" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const mine = !!me && r.address.toLowerCase() === me;
                return (
                  <tr key={`${r.venue}:${r.address}`} className={mine ? 'vs-me' : undefined}>
                    <td><TraderCell r={r} me={mine} /></td>
                    {cols.map((col, i) => {
                      const f = fmtCell(col, r);
                      return (
                        <td key={col.key} className={`num vs-col-${i + 1} ${f.tone}`} title={f.title}>{f.text}</td>
                      );
                    })}
                    <td className="acct-actions">
                      <button
                        type="button"
                        className="acct-act"
                        onClick={() => c.onScan(r.address, r.venue)}
                        title={`Open this ${VENUE_LABEL[r.venue]} account in Scan`}
                      >
                        Scan
                      </button>
                      <button
                        type="button"
                        className="acct-act"
                        onClick={() => c.onOpenCopy(r.address, r.venue)}
                        title="Set up copying this trader"
                      >
                        Copy
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      );
    }
  }

  return (
    <Card
      title={meta.title}
      className="vs-card"
      action={<span className="pf-unit vs-sub" title={meta.subtitle}>{meta.subtitle}</span>}
    >
      {body}
    </Card>
  );
}

function TapePanel({ c }: { c: ExploreContext }) {
  const s = c.whales;
  const trades = (s.data ?? []).slice(0, TAPE_ROWS);
  const keys = tradeKeys(trades);
  const state = sectionState(s, 'large trades', c.venue);

  return (
    <Card
      title="Large trades"
      className="vs-card"
      action={<Seg value={c.minUsd} options={MIN_OPTIONS} onChange={c.setMinUsd} label="Minimum trade size" />}
    >
      {state ?? (trades.length === 0 ? (
        <Notice>No {venueWord(c.venue)}trade of {fmtUsdShort(c.minUsd)} or more yet.</Notice>
      ) : (
        <table className="mkt-tapetable vs-tape">
          <colgroup>
            <col className="vs-tape__mkt" />
            <col className="vs-tape__px" />
            <col className="vs-tape__sz" />
            <col className="vs-tape__who" />
            <col className="vs-tape__time" />
          </colgroup>
          <thead>
            <tr>
              <th>Market</th>
              <th>Price</th>
              <th>Size (USD)</th>
              <th>Trader</th>
              <th>Time</th>
            </tr>
          </thead>
          <tbody>
            {trades.map((t, i) => {
              const buy = t.side === 'buy';
              const addr = t.address;
              const open = addr ? () => c.onScan(addr, t.venue) : undefined;
              return (
                <tr
                  key={keys[i]}
                  className={`mkt-taperow${open ? ' vs-click' : ''}`}
                  onClick={open}
                  onKeyDown={open ? onActivate(open) : undefined}
                  tabIndex={open ? 0 : undefined}
                  role={open ? 'link' : undefined}
                  title={
                    `${buy ? 'Buy' : 'Sell'} ${fmtPx(t.sz)} ${t.symbol} at ${fmtPx(t.px)} on ${VENUE_LABEL[t.venue]}`
                    + (open ? ' - open the trader in Scan' : ' - trader address not resolved')
                  }
                >
                  <td className="vs-tape-mkt">
                    <span className="vs-mkt">
                      <span className="vs-mkt__sym" title={t.symbol}>{marketName(t.symbol)}</span>
                      <VenueBadge venue={t.venue} />
                    </span>
                  </td>
                  <td className={buy ? 'pos' : 'neg'}>{fmtPx(t.px)}</td>
                  <td className="mkt-tape-size" title={fmtUsdExact(t.notional)}>{fmtUsdShort(t.notional)}</td>
                  <td className="vs-tape-who">
                    {addr ? <code>{shortAddr(addr)}</code>
                      : t.accountId != null ? <span className="muted">#{t.accountId}</span>
                      : <span className="muted">{DASH}</span>}
                  </td>
                  <td className="mkt-tape-time">{fmtClock(t.time)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ))}
      <StaleNote s={s} />
    </Card>
  );
}

function PositioningPanel({ c }: { c: ExploreContext }) {
  const s = c.positioning;
  const rows = useMemo(() => rollUpPositioning(s.data ?? [], 20), [s.data]);
  const state = sectionState(s, 'top-trader positioning', c.venue);

  return (
    <Card
      title="Top-trader positioning"
      className="vs-card"
      action={<span className="pf-unit vs-sub" title="Open positions of the tracked top traders, by market">By market</span>}
    >
      {state ?? (rows.length === 0 ? (
        <Notice>No {venueWord(c.venue)}top trader holds an open position yet.</Notice>
      ) : (
        <div className="acct vs-acct pf-tablewrap">
          <table className="acct-table vs-pos">
            <thead>
              <tr>
                <th>Market</th>
                <th className="num">Long</th>
                <th className="vs-pos__bar">Long / short</th>
                <th className="num">Short</th>
                <th className="num">Traders</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => {
                const share = longShare(m);
                const target = c.perps.get(m.key) ?? null;
                const open = target ? () => c.onOpenSymbol(target) : undefined;
                return (
                  <tr
                    key={m.key}
                    className={open ? 'vs-click' : undefined}
                    onClick={open}
                    onKeyDown={open ? onActivate(open) : undefined}
                    tabIndex={open ? 0 : undefined}
                    role={open ? 'link' : undefined}
                    title={open ? `Trade ${target} on SoDEX` : `${m.label} is not listed on SoDEX`}
                  >
                    <td>
                      <span className="vs-mkt">
                        <span className="vs-mkt__sym">{m.label}</span>
                        {m.venues.map((v) => <VenueBadge key={v} venue={v} />)}
                      </span>
                    </td>
                    <td className="num pos" title={fmtUsdExact(m.longUsd)}>{fmtUsdShort(m.longUsd)}</td>
                    <td className="vs-pos__bar">
                      <div
                        className="pf-split"
                        role="img"
                        aria-label={`${Math.round(share * 100)}% of the notional is long`}
                        title={`${Math.round(share * 100)}% long`}
                      >
                        <span className="pf-split__fill" style={{ transform: `scaleX(${share})` }} />
                      </div>
                    </td>
                    <td className="num neg" title={fmtUsdExact(m.shortUsd)}>{fmtUsdShort(m.shortUsd)}</td>
                    <td className="num muted" title={`${m.longTraders} long, ${m.shortTraders} short`}>
                      {m.longTraders} / {m.shortTraders}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ))}
      <StaleNote s={s} />
    </Card>
  );
}

/* ===========================================================================
 *  REGISTRY AND LAYOUT
 *
 *  Same shape and units as the portfolio dashboard in dashboard/layout.ts: 48
 *  columns, a fixed 26px row (the page scrolls, so it cannot derive its row
 *  from its own height), 4px gutters.
 * ======================================================================== */

const segPanel = (id: SegmentId): PanelDefinition<ExploreContext> => ({
  id: `seg-${id}`,
  title: SEGMENT_FALLBACK[id].title,
  pad: false,
  scroll: 'hidden',
  minW: 10,
  minH: 6,
  render: (c) => <SegmentPanel c={c} id={id} />,
});

const EXPLORE_PANELS: PanelDefinition<ExploreContext>[] = [
  {
    id: 'overview',
    title: 'Explore overview',
    pad: false,
    scroll: 'hidden',
    minW: 12,
    minH: 4,
    render: (c) => <OverviewPanel c={c} />,
  },
  ...SEGMENT_IDS.map(segPanel),
  {
    id: 'tape',
    title: 'Large trades',
    pad: false,
    scroll: 'hidden',
    minW: 10,
    minH: 6,
    render: (c) => <TapePanel c={c} />,
  },
  {
    id: 'positioning',
    title: 'Top-trader positioning',
    pad: false,
    scroll: 'hidden',
    minW: 10,
    minH: 6,
    render: (c) => <PositioningPanel c={c} />,
  },
];

/** Two ranking columns and a live rail on the right, the trade page's arrangement. */
const EX_LG: PanelPlacement[] = [
  { i: 'overview',         x: 0,  y: 0,  w: 48, h: 4 },
  { i: 'seg-top-pnl',      x: 0,  y: 4,  w: 17, h: 11 },
  { i: 'seg-top-roi',      x: 17, y: 4,  w: 17, h: 11 },
  { i: 'seg-consistent',   x: 0,  y: 15, w: 17, h: 11 },
  { i: 'seg-whales',       x: 17, y: 15, w: 17, h: 11 },
  { i: 'seg-rising',       x: 0,  y: 26, w: 17, h: 11 },
  { i: 'seg-most-active',  x: 17, y: 26, w: 17, h: 11 },
  { i: 'tape',             x: 34, y: 4,  w: 14, h: 18 },
  { i: 'positioning',      x: 34, y: 22, w: 14, h: 15 },
];

/** Two columns; the live pair sits under the first rankings row. */
const EX_MD: PanelPlacement[] = [
  { i: 'overview',         x: 0,  y: 0,  w: 48, h: 4 },
  { i: 'seg-top-pnl',      x: 0,  y: 4,  w: 24, h: 11 },
  { i: 'seg-top-roi',      x: 24, y: 4,  w: 24, h: 11 },
  { i: 'tape',             x: 0,  y: 15, w: 24, h: 17 },
  { i: 'positioning',      x: 24, y: 15, w: 24, h: 17 },
  { i: 'seg-consistent',   x: 0,  y: 32, w: 24, h: 11 },
  { i: 'seg-whales',       x: 24, y: 32, w: 24, h: 11 },
  { i: 'seg-rising',       x: 0,  y: 43, w: 24, h: 11 },
  { i: 'seg-most-active',  x: 24, y: 43, w: 24, h: 11 },
];

/**
 * One column, in reading order.
 *
 * Taller ranking panels than on a desktop, and not by choice: below a 993px
 * window responsive.css gives every button in the dashboard a 40px touch
 * target, which makes a row carrying Scan / Copy 40px tall. Ten of them plus the
 * head is 17 rows; at 11 a phone would scroll inside a panel inside the page.
 */
const column = (overviewH: number): PanelPlacement[] => {
  const order: Array<[string, number]> = [
    ['overview', overviewH],
    ['seg-top-pnl', 17],
    ['tape', 15],
    ['seg-top-roi', 17],
    ['seg-consistent', 17],
    ['seg-whales', 17],
    ['seg-rising', 17],
    ['seg-most-active', 17],
    ['positioning', 17],
  ];
  let y = 0;
  return order.map(([i, h]) => {
    const p = { i, x: 0, y, w: 48, h };
    y += h;
    return p;
  });
};

const ROW = { cols: 48, rowHeight: 26, margin: [4, 4] as [number, number], containerPadding: [0, 0] as [number, number] };

const EXPLORE_DASHBOARD: DashboardConfig = {
  id: 'explore',
  version: 1,
  breakpoints: { lg: 1200, md: 800, sm: 552, xs: 0 },
  grid: { lg: ROW, md: ROW, sm: ROW, xs: ROW },
  // xs: the four KPIs go two by two (see Explore.css), which needs two more rows.
  layouts: { lg: EX_LG, md: EX_MD, sm: column(4), xs: column(6) },
};

/* ===========================================================================
 *  THE PAGE
 * ======================================================================== */

export function Explore({ address, onScan, onOpenCopy, onOpenSymbol }: ExploreProps) {
  const pageVisible = usePageVisible();
  /* Overview (the rankings dashboard) or Cohorts: `?view=cohorts`, a link like any other. */
  const [view, setViewState] = useState<ExploreView>(viewFromUrl);
  useEffect(() => {
    const onPop = () => setViewState(viewFromUrl());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const setView = (v: ExploreView) => {
    if (v === view) return;
    setViewState(v);
    window.history.pushState(null, '', v === 'cohorts' ? '/explore?view=cohorts' : '/explore');
  };
  // The overview's feeds only poll while it is the view on screen.
  const visible = pageVisible && view === 'overview';

  const [storedVenue, setVenue] = useStored<VenueFilter>('vs.explore.venue', 'all');
  const venue: VenueFilter = VENUE_FILTERS.includes(storedVenue) ? storedVenue : 'all';
  const [storedMin, setMinUsd] = useStored<number>('vs.explore.minUsd', DEFAULT_MIN_USD);
  const minUsd = WHALE_MIN_OPTIONS.some((o) => o.v === storedMin) ? storedMin : DEFAULT_MIN_USD;

  const explore = useSection('Trader rankings', 'explore', () => vsApi.explore(), { pollMs: EXPLORE_POLL_MS, enabled: visible });
  const whales = useSection(
    'Large trades',
    `${venue}|${minUsd}`,
    () => vsApi.whales({ venue, minUsd, limit: TAPE_ROWS }),
    { pollMs: TAPE_POLL_MS, enabled: visible },
  );
  const positioning = useSection(
    'Top-trader positioning',
    venue,
    () => vsApi.positioning({ venue }),
    { pollMs: POSITIONING_POLL_MS, enabled: visible },
  );

  // SoDEX's perps list, to know which markets the trade page can open.
  const { symbols } = useSymbols('perps');
  const perps = useMemo(() => new Map(symbols.map((s) => [marketKey(s.name), s.name])), [symbols]);

  const context: ExploreContext = {
    address, venue, setVenue, explore, whales, minUsd, setMinUsd, positioning, perps,
    onScan, onOpenCopy, onOpenSymbol,
  };

  return (
    <div className="vs-explore-page">
      <div className="pf ex-views">
        <div className="dash-tabs__bar">
          <div className="ex-views__tabs" role="tablist" aria-label="Explore">
            {(['overview', 'cohorts'] as ExploreView[]).map((v) => (
              <button key={v} type="button" role="tab" aria-selected={view === v} className={`dash-tab${view === v ? ' is-active' : ''}`} onClick={() => setView(v)}>
                {v === 'overview' ? 'Overview' : 'Cohorts'}
              </button>
            ))}
          </div>
        </div>
      </div>
      {view === 'cohorts' ? (
        <div className="pf ex-cohorts">
          {/* A wallet opens on Scan's overview: every venue it is on. */}
          <Cohorts onScan={(a) => { window.location.href = `/scan?find=${encodeURIComponent(a)}`; }} />
        </div>
      ) : (
        <Dashboard
          config={EXPLORE_DASHBOARD}
          panels={EXPLORE_PANELS}
          context={context}
          /* `pf` is the scope the portfolio design system's rules match against -
             the same reason PointsDashboard passes it. */
          className="pf vs-explore"
        />
      )}
    </div>
  );
}
