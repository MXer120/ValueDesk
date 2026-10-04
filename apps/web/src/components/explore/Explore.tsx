/**
 * Explore: one ranking, the large-trade tape, and where top traders are positioned.
 *
 * The same pieces as the rest of the app: portfolio cards, the account table,
 * the trade tape, the exposure bar, and the command palette's sliding segment.
 * Rankings, the tape and positioning each fail on their own.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Card } from '../portfolio/parts';
import { LoadFailed, logLoadFailure } from '../LoadFailed';
import { CrossFade } from '../motion';
import { Seg } from '../palette/ui';
import { useAsync, useStored, useSymbols } from '../../hooks';
import { usePrivacy, maskAddress } from '../../privacy';
import { DASH, marketName, shortAddr } from '../../format';
import {
  vsApi, VsError, VENUE_LABEL, VS_VENUES,
  type ExploreResponse, type Positioning, type TraderRow, type Venue, type WhaleTrade,
} from '../../vsApi';
import {
  SEGMENT_COLUMNS, SEGMENT_FALLBACK, SEGMENT_IDS, VENUE_SHORT, WHALE_MIN_OPTIONS,
  fmtCell, fmtClock, fmtPx, fmtUsdExact, fmtUsdShort, longShare, marketKey,
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
const SEGMENT_ROWS = 15;
const TAPE_ROWS = 40;
const TAPE_SHOWN = 12;
const POSITION_ROWS = 8;

const RANK_LABEL: Record<SegmentId, string> = {
  'top-pnl': 'PnL',
  'top-roi': 'ROI',
  consistent: 'Consistent',
  whales: 'Whales',
  rising: 'Rising',
  'most-active': 'Active',
};

/* ===========================================================================
 *  SMALL PIECES
 * ======================================================================== */

const VENUE_OPTIONS = VENUE_FILTERS.map((v) => ({
  id: v,
  label: v === 'all' ? 'All' : VENUE_SHORT[v],
  title: v === 'all' ? 'Every venue' : VENUE_LABEL[v],
}));

const RANK_OPTIONS = SEGMENT_IDS.map((id) => ({
  id,
  label: RANK_LABEL[id],
  title: SEGMENT_FALLBACK[id].subtitle,
}));

const MIN_OPTIONS = WHALE_MIN_OPTIONS.map((o) => ({
  id: String(o.v),
  label: o.label,
  title: `Trades of ${o.label} or more`,
}));

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
    <Card title={meta.title} className="vs-card">
      <CrossFade viewKey={`${id}|${c.venue}`}>
        {body}
      </CrossFade>
      <StaleNote s={ex} />
    </Card>
  );
}

function TapePanel({ c }: { c: ExploreContext }) {
  const s = c.whales;
  const trades = (s.data ?? []).slice(0, TAPE_SHOWN);
  const keys = tradeKeys(trades);
  const state = sectionState(s, 'large trades', c.venue);

  return (
    <Card
      title="Large trades"
      className="vs-card"
      action={(
        <Seg
          size="sm"
          label="Minimum trade size"
          value={String(c.minUsd)}
          onChange={(id) => c.setMinUsd(Number(id))}
          options={MIN_OPTIONS}
        />
      )}
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
  const rows = useMemo(() => rollUpPositioning(s.data ?? [], POSITION_ROWS), [s.data]);
  const state = sectionState(s, 'top-trader positioning', c.venue);

  return (
    <Card
      title="Positioning"
      className="vs-card"
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
 *  THE PAGE
 * ======================================================================== */

function isSegment(v: string): v is SegmentId {
  return (SEGMENT_IDS as readonly string[]).includes(v);
}

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
  const [storedSeg, setSegment] = useStored<string>('vs.explore.segment', 'top-pnl');
  const segment: SegmentId = isSegment(storedSeg) ? storedSeg : 'top-pnl';
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
                {v === 'overview' ? 'Traders' : 'Cohorts'}
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
        <div className="pf vs-explore ex-board">
          <div className="ex-bar">
            <Seg label="Ranking" value={segment} onChange={setSegment} options={RANK_OPTIONS} />
            <Seg label="Venue" value={venue} onChange={setVenue} options={VENUE_OPTIONS} />
          </div>
          <div className="ex-grid">
            <SegmentPanel c={context} id={segment} />
            <div className="ex-side">
              <TapePanel c={context} />
              <PositioningPanel c={context} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
