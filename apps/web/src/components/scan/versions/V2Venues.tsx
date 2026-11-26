/**
 * Version 2, "Venues": the wallet, not one venue. Everything it does on every venue on one screen.
 *
 * The page never leaves the overview. On top a ledger of the five venues, each with its own figures for one window
 * (account value, PnL, ROI, volume, last trade, the PnL line) and its standing. Under it every open position on every
 * venue in one list (a position two venues report, trade.xyz's markets on Hyperliquid, is listed once with both
 * logos) and the exposure per coin summed over venues. A row of the ledger opens that venue's account below: its two
 * charts, the copy buttons and the band of orders and history. No figure is summed across venues' balances: each
 * venue's account value is its own, side by side (trade.xyz's may be part of Hyperliquid's; adding them could count
 * one dollar twice).
 */
import { useMemo, useState } from 'react';
import { Button, EmptyState, Panel, Shell, ShellHeader, Skeleton, Sparkline, StatusPill, Tag } from '../../bots/kit/kit';
import { VenueLogo } from '../../VenueLogo';
import { CoinIcon } from '../../CoinIcon';
import { Private, useMask } from '../../../privacy';
import { fmtPrice, fmtUsd, shortAddr } from '../../../format';
import { fmtPlain } from '../../../numStyle';
import { signedPct, signedUsd } from '../../accountTables/cells';
import { useMediaQuery } from '../../../hooks';
import { SCAN_VENUES, VENUE_LABEL, type TraderProfile, type Venue, type Window } from '../../../vsApi';
import { HL_WINDOW_LABEL, windowCurve } from '../hlModel';
import type { VenueCard } from '../addressVenues';
import { useScanFlow, useVenueView, type ScanFlow, type ScanPageProps, type VenueView } from './flow';
import { baseOf, bookTotals, crossPositions, exposureByCoin, liqDistance, roeOf, standingOf, windowFigures, type CrossPosition } from './model';
import {
  Avatar, CopyActions, HistoryBand, PhoneCopyBar, ScanCurve, ScanSearch, StandingPill, TraderTags,
  WalletName, WindowSwitch, ago, cx, lastActiveTitle, num, savedWallets, signed, tone, toneUsd, 
} from './parts';

const FIRST_ROWS = 8;

export function V2Venues(props: ScanPageProps) {
  const flow = useScanFlow();
  const view = useVenueView(props, flow.address, flow.venue);
  if (!flow.address) return <Start flow={flow} connected={props.address} />;
  return (
    <div className="sx sx-v2">
      <header className="sx-v2__head">
        <Avatar address={flow.address} size={44} />
        <div className="sx-v2__id">
          <WalletName address={flow.address} />
          <Meta flow={flow} view={view} />
        </div>
        <ScanSearch seed={flow.address} connected={props.address} onSearch={flow.search} error={flow.error} className="sx-v2__find" />
      </header>
      <Ledger flow={flow} view={view} />
      <Book flow={flow} view={view} />
      {flow.venue && <Detail flow={flow} view={view} />}
      {flow.venue && <PhoneCopyBar address={flow.address} venue={flow.venue} label={`${VENUE_LABEL[flow.venue]} · ${shortAddr(flow.address)}`} />}
    </div>
  );
}

function Meta({ flow, view }: { flow: ScanFlow; view: VenueView }) {
  const active = flow.cards.filter((c) => standingOf(c) === 'active');
  return (
    <div className="sx-v2__meta">
      {!flow.settled
        ? <StatusPill size="sm" dot pulse>Checking {SCAN_VENUES.length} venues</StatusPill>
        : <StatusPill size="sm" tone={active.length ? 'positive' : 'neutral'} dot={active.length > 0}>{active.length ? `Active on ${active.length} of ${SCAN_VENUES.length} venues` : 'No active venue'}</StatusPill>}
      <TraderTags p={view.trader.data} />
    </div>
  );
}

/* ------------------------------------------------------------------ start ----- */

/**
 * What Scan can read of a wallet on each venue without the wallet's own key: the venue's PnL and positions, and the
 * band's tabs each venue serves publicly (VenueBand.tsx HAS; SoDEX's band is the portfolio's, which reads them all).
 */
const PUBLIC: Record<Venue, string[]> = {
  sodex: ['PnL', 'Positions', 'Orders', 'Balances', 'Fills', 'Funding'],
  hyperliquid: ['PnL', 'Positions', 'Orders', 'Balances', 'Fills', 'Funding'],
  tradexyz: ['PnL', 'Positions', 'Orders', 'Fills', 'Funding'],
  lighter: ['PnL', 'Positions', 'Balances', 'Fills'],
  arcus: ['PnL', 'Positions', 'Orders', 'Balances', 'Fills', 'Funding'],
};

function Start({ flow, connected }: { flow: ScanFlow; connected: string | null }) {
  const saved = useMemo(savedWallets, []);
  return (
    <div className="sx sx-v2 sx-v2--start">
      <Shell className="sx-v2__startcard">
        <ShellHeader icon="search" as="h2" title="Scan a wallet" subtitle="One address, every venue it trades on" />
        <Panel className="sx-v2__startbody">
          <ScanSearch connected={connected} onSearch={flow.search} error={flow.error} size="md" />
          <ul className="sx-v2__preview" aria-label="Venues checked">
            {SCAN_VENUES.map((v) => (
              <li key={v}>
                <VenueLogo venue={v} size={20} />
                <b>{VENUE_LABEL[v]}</b>
                <span className="sx-v2__reads">
                  {PUBLIC[v].map((t) => <Tag key={t}>{t}</Tag>)}
                </span>
              </li>
            ))}
          </ul>
          {saved.length > 0 && (
            <div className="sx-v2__saved">
              <span>Saved</span>
              {saved.slice(0, 8).map((w) => (
                <button key={w.address} type="button" className="sx-chip" onClick={() => flow.search(w.address)} title={w.address}>
                  <Avatar address={w.address} size={18} />{w.name}
                </button>
              ))}
            </div>
          )}
        </Panel>
      </Shell>
    </div>
  );
}

/* ----------------------------------------------------------------- ledger ----- */

/** The profile to read for a venue: the polled one for the venue on screen, the lookup's for the rest. */
function profileOf(flow: ScanFlow, view: VenueView, v: Venue): TraderProfile | null {
  if (v === flow.venue && view.trader.data) return view.trader.data;
  return flow.profiles[v].data ?? null;
}

function Ledger({ flow, view }: { flow: ScanFlow; view: VenueView }) {
  const w = view.win;
  const phone = useMediaQuery('(max-width: 760px)');
  const order = useMemo(() => {
    const rank = (c: VenueCard) => ({ active: 0, inactive: 1, loading: 0, unknown: 2, none: 3 })[standingOf(c)];
    return [...flow.cards].sort((a, b) => rank(a) - rank(b) || SCAN_VENUES.indexOf(a.venue) - SCAN_VENUES.indexOf(b.venue));
  }, [flow.cards]);
  return (
    <Shell className="sx-v2__ledger">
      <ShellHeader
        icon="layers"
        title="Venues"
        subtitle="Each venue's own figures. Pick one to open its account."
        aside={<WindowSwitch win={w} onWin={view.setWin} label="Ledger window" />}
      />
      <Panel className="sx-v2__table" role="list">
        {!phone && (
          <div className="sx-v2__row is-head" aria-hidden="true">
            <span>Venue</span>
            <span className="is-n">Account value</span>
            <span className="is-n">PnL · {HL_WINDOW_LABEL[w]}</span>
            <span className="is-n">ROI · {HL_WINDOW_LABEL[w]}</span>
            <span className="is-n">Volume · {HL_WINDOW_LABEL[w]}</span>
            <span className="is-n">Last trade</span>
            <span>PnL line</span>
            <span />
          </div>
        )}
        {order.map((c) => <LedgerRow key={c.venue} card={c} p={profileOf(flow, view, c.venue)} w={w} on={c.venue === flow.venue} onPick={() => flow.pick(c.venue)} historyNote={c.venue === 'sodex' ? (c.venue === flow.venue ? view.historyNote : c.historyNote ?? null) : null} />)}
      </Panel>
    </Shell>
  );
}

function LedgerRow({ card, p, w, on, onPick, historyNote }: { card: VenueCard; p: TraderProfile | null; w: Window; on: boolean; onPick: () => void; historyNote: string | null }) {
  const st = standingOf(card);
  const maskEq = useMask('equity');
  const maskPnl = useMask('pnl');
  const curve = p && !historyNote ? windowCurve(p.equity, w, 'pnl') : null;
  const fig = historyNote ? { pnl: null, roi: null, volume: windowFigures(p, w, null).volume } : windowFigures(p, w, curve?.change ?? null);
  const s = p?.summary;
  const idle = st === 'none' || st === 'inactive' || st === 'unknown';
  const values = curve?.points.map((q) => q.v) ?? [];
  const dash = st === 'loading' ? <Skeleton style={{ width: 54, height: 12 }} /> : '—';
  return (
    <div role="listitem" className={cx('sx-v2__li', on && 'is-on', idle && 'is-idle')}>
      <button type="button" className="sx-v2__row" aria-pressed={on} onClick={onPick} title={on ? 'Open below' : `Open the ${VENUE_LABEL[card.venue]} account`}>
        <span className="sx-v2__venue">
          <VenueLogo venue={card.venue} size={22} />
          <b>{VENUE_LABEL[card.venue]}</b>
          {card.venue === 'tradexyz' && <span className="sx-v2__on" title="trade.xyz's markets are a dex on Hyperliquid: its positions show on both.">on Hyperliquid</span>}
        </span>
        <span className="is-n sx-c-av" data-k="Account value">{num(s?.accountValue) ? maskEq(fmtUsd(s!.accountValue)) : dash}</span>
        <span className={cx('is-n sx-c-pnl', toneUsd(fig.pnl))} data-k={`PnL · ${HL_WINDOW_LABEL[w]}`}>{num(fig.pnl) ? maskPnl(signed(fig.pnl)) : dash}</span>
        <span className={cx('is-n sx-c-roi', tone(fig.roi))} data-k="ROI">{num(fig.roi) ? maskPnl(signedPct(fig.roi, 1)) : dash}</span>
        <span className="is-n sx-c-vol" data-k="Volume">{num(fig.volume) ? fmtUsd(fig.volume, 0) : dash}</span>
        <span className="is-n sx-c-ago" data-k="Last trade" title={lastActiveTitle(s?.lastActive)}>{num(s?.lastActive) ? ago(s!.lastActive) : dash}</span>
        <span className="sx-v2__spark" aria-hidden="true">
          {values.length > 1 ? <Sparkline values={values} tone={values[values.length - 1]! >= values[0]! ? 'positive' : 'negative'} w={120} h={30} /> : historyNote ? <i title={historyNote}>History incomplete</i> : null}
        </span>
        <span className="sx-v2__st">
          {on ? <StatusPill size="sm" tone="brand">Open below</StatusPill> : <StandingPill card={card} />}
        </span>
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------- book ----- */

function Book({ flow, view }: { flow: ScanFlow; view: VenueView }) {
  const phone = useMediaQuery('(max-width: 760px)');
  const maskPnl = useMask('pnl');
  const profiles = useMemo(() => Object.fromEntries(SCAN_VENUES.map((v) => [v, profileOf(flow, view, v)])) as Partial<Record<Venue, TraderProfile | null>>, [flow, view]);
  const rows = useMemo(() => crossPositions(profiles), [profiles]);
  const coins = useMemo(() => exposureByCoin(rows), [rows]);
  const totals = bookTotals(rows);
  const venuesWith = new Set(rows.flatMap((r) => r.venues)).size;
  const waiting = !flow.settled && rows.length === 0;
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, FIRST_ROWS);
  return (
    <div className="sx-v2__duo">
      <Shell className="sx-v2__book">
        <ShellHeader
          icon="coins"
          title={<>Open positions{rows.length > 0 && <span className="sx-count">{rows.length}</span>}</>}
          subtitle={rows.length ? `On ${venuesWith} ${venuesWith === 1 ? 'venue' : 'venues'} · a position two venues report is listed once` : 'Every venue, one list'}
          aside={totals && (
            <span className="sx-v2__totals">
              <span>Long <b>{fmtUsd(totals.long, 0)}</b></span>
              <span>Short <b>{fmtUsd(totals.short, 0)}</b></span>
              <span>Unrealized <b className={toneUsd(totals.upnl)}>{maskPnl(signed(totals.upnl))}</b></span>
            </span>
          )}
        />
        <Panel className="sx-v2__bookbody">
          <Private k="positions">
            {waiting ? <div className="sx-v2__skel">{[0, 1, 2, 3].map((i) => <Skeleton key={i} style={{ height: 34 }} />)}</div>
              : rows.length === 0 ? <EmptyState compact icon="layers" title="No open positions" description={flow.settled ? 'Nothing open on any venue right now.' : 'Still reading some venues.'} />
              : (
                <>
                  {phone
                    ? <ul className="sx-v2__lines">{shown.map((r, i) => <PositionLine key={`${r.symbol}-${r.side}-${i}`} r={r} />)}</ul>
                    : <PositionTable rows={shown} />}
                  {rows.length > FIRST_ROWS && (
                    <div className="sx-v2__more">
                      <Button variant="quiet" size="sm" onClick={() => setAll(!all)}>{all ? 'Show fewer' : `Show all ${rows.length}`}</Button>
                    </div>
                  )}
                </>
              )}
          </Private>
        </Panel>
      </Shell>
      <Shell className="sx-v2__expo">
        <ShellHeader icon="chart" title="Exposure by coin" subtitle="Long and short value, every venue added" />
        <Panel className="sx-v2__expobody">
          {coins.length === 0 ? <EmptyState compact icon="chart" title="Nothing to weigh" description="No open position on any venue." />
            : <CoinBars coins={coins} />}
        </Panel>
      </Shell>
    </div>
  );
}

function PositionTable({ rows }: { rows: CrossPosition[] }) {
  const maskPnl = useMask('pnl');
  return (
    <div className="sx-v2__pt" role="table" aria-label="Open positions on every venue">
      <div className="sx-v2__pr is-head" role="row">
        <span role="columnheader">Market</span>
        <span role="columnheader">Venue</span>
        <span role="columnheader" className="is-n">Value</span>
        <span role="columnheader" className="is-n">Unrealized PnL</span>
        <span role="columnheader" className="is-n">Entry</span>
        <span role="columnheader" className="is-n">Mark</span>
        <span role="columnheader" className="is-n" title="The venue's liquidation price, and how far the mark can move against the position before it (derived).">Liq.</span>
      </div>
      {rows.map((r, i) => {
        const roe = roeOf(r);
        const d = liqDistance(r);
        return (
          <div className="sx-v2__pr" role="row" key={`${r.symbol}-${r.side}-${i}`}>
            <span role="cell" className="sx-v2__mk">
              <CoinIcon coin={baseOf(r.symbol)} size={20} />
              <b title={r.symbol}>{r.symbol.replace(/^[a-z]+:/, '')}</b>
              <StatusPill size="sm" tone={r.side === 'long' ? 'positive' : 'negative'}>{r.side === 'long' ? 'Long' : 'Short'}</StatusPill>
              {num(r.leverage) && <span className="sx-v2__lev">{fmtPlain(r.leverage)}x</span>}
            </span>
            <span role="cell" className="sx-v2__vs" title={r.venues.map((v) => VENUE_LABEL[v]).join(' · ')}>
              {r.venues.map((v) => <VenueLogo key={v} venue={v} size={16} />)}
            </span>
            <span role="cell" className="is-n">{fmtUsd(Math.abs(r.notional))}</span>
            <span role="cell" className={cx('is-n', toneUsd(r.uPnl))}>{maskPnl(signedUsd(r.uPnl))}{roe !== null && <i> {maskPnl(signedPct(roe, 1))}</i>}</span>
            <span role="cell" className="is-n">{num(r.entryPx) ? fmtPrice(r.entryPx) : '—'}</span>
            <span role="cell" className="is-n">{num(r.markPx) ? fmtPrice(r.markPx) : '—'}</span>
            <span role="cell" className="is-n">{num(r.liqPx) ? fmtPrice(r.liqPx) : '—'}{d !== null && <i className={d < 0.1 ? 'is-near' : undefined}> {fmtPlain(Number((d * 100).toFixed(d < 0.1 ? 1 : 0)))}%</i>}</span>
          </div>
        );
      })}
    </div>
  );
}

/** A phone's row of the merged book: the market and where, its value, its PnL, entry to mark and the liquidation. */
function PositionLine({ r }: { r: CrossPosition }) {
  const maskPnl = useMask('pnl');
  const roe = roeOf(r);
  const d = liqDistance(r);
  return (
    <li className="sx-v2__line">
      <CoinIcon coin={baseOf(r.symbol)} size={26} />
      <div className="sx-v2__lt">
        <span className="sx-v2__l1">
          <b title={r.symbol}>{r.symbol.replace(/^[a-z]+:/, '')}</b>
          <StatusPill size="sm" tone={r.side === 'long' ? 'positive' : 'negative'}>{r.side === 'long' ? 'Long' : 'Short'}</StatusPill>
          {num(r.leverage) && <span className="sx-v2__lev">{fmtPlain(r.leverage)}x</span>}
          <span className="sx-v2__vs" title={r.venues.map((v) => VENUE_LABEL[v]).join(' · ')}>{r.venues.map((v) => <VenueLogo key={v} venue={v} size={14} />)}</span>
        </span>
        <span className="sx-v2__l2">
          {num(r.entryPx) ? fmtPrice(r.entryPx) : '—'} → {num(r.markPx) ? fmtPrice(r.markPx) : '—'}
          {d !== null && <i className={d < 0.1 ? 'is-near' : undefined}> · {fmtPlain(Number((d * 100).toFixed(d < 0.1 ? 1 : 0)))}% to liq.</i>}
        </span>
      </div>
      <div className="sx-v2__lr">
        <b>{fmtUsd(Math.abs(r.notional))}</b>
        <span className={toneUsd(r.uPnl)}>{maskPnl(signedUsd(r.uPnl))}{roe !== null && <i> {maskPnl(signedPct(roe, 1))}</i>}</span>
      </div>
    </li>
  );
}

function CoinBars({ coins }: { coins: ReturnType<typeof exposureByCoin> }) {
  const max = Math.max(...coins.map((c) => Math.max(c.long, c.short)), 1);
  return (
    <ul className="sx-v2__coins">
      {coins.map((c) => (
        <li key={c.coin}>
          <span className="sx-v2__cn"><CoinIcon coin={c.coin} size={18} /><b>{c.coin}</b></span>
          <span className="sx-v2__bar" role="img" aria-label={`${c.coin}: long ${fmtUsd(c.long, 0)}, short ${fmtUsd(c.short, 0)}`}>
            <span className="sx-v2__bs"><i style={{ width: `${(c.short / max) * 100}%` }} /></span>
            <span className="sx-v2__bl"><i style={{ width: `${(c.long / max) * 100}%` }} /></span>
          </span>
          <span className={cx('sx-v2__net', toneUsd(c.net))} title={`Net: long ${fmtUsd(c.long, 0)} − short ${fmtUsd(c.short, 0)}`}>{signed(c.net)}</span>
        </li>
      ))}
      <li className="sx-v2__legend" aria-hidden="true"><span /><span className="sx-v2__lg"><i className="neg">Short</i><i className="pos">Long</i></span><span>Net</span></li>
    </ul>
  );
}

/* ----------------------------------------------------------------- detail ----- */

function Detail({ flow, view }: { flow: ScanFlow; view: VenueView }) {
  const v = flow.venue!;
  const p = view.trader.data;
  const w = view.win;
  const maskEq = useMask('equity');
  const maskPnl = useMask('pnl');
  const curve = p && !view.historyNote ? windowCurve(p.equity, w, 'pnl') : null;
  const fig = windowFigures(p, w, curve?.change ?? null);
  const av = p?.summary.accountValue;
  return (
    <Shell className="sx-v2__detail">
      <ShellHeader
        tile={<VenueLogo venue={v} size={22} />}
        title={`${VENUE_LABEL[v]} account`}
        subtitle={view.trader.data ? `Read ${ago(view.trader.data.updatedAt)} · ${view.trader.data.source}` : 'Reading…'}
        aside={<CopyActions address={flow.address!} venue={v} profile={p} className="sx-v2__cta" />}
      />
      <div className="sx-v2__charts">
        <Panel className="sx-v2__chart">
          <div className="sx-v2__ch">
            <span>PnL · {w === 'all' ? 'all time' : HL_WINDOW_LABEL[w]}</span>
            <b className={toneUsd(fig.pnl)}>{view.historyNote ? '—' : maskPnl(signed(fig.pnl))}</b>
          </div>
          <ScanCurve view={view} field="pnl" win={w} className="sx-v2__cv" />
        </Panel>
        <Panel className="sx-v2__chart">
          <div className="sx-v2__ch">
            <span>Account value</span>
            <b>{num(av) ? maskEq(fmtUsd(av)) : '—'}</b>
          </div>
          <ScanCurve view={view} field="accountValue" win={w} className="sx-v2__cv" />
        </Panel>
      </div>
      <HistoryBand view={view} className="sx-v2__band" />
    </Shell>
  );
}
