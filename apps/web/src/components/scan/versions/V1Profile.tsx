/**
 * Version 1, "Profile": the wallet as a trader's page, for the one question Scan is mostly opened with: is this
 * trader worth copying?
 *
 * One column. The stage on top answers it: who (avatar, name, the venue's rank and tags), where (the venue switch,
 * each venue's balance on it), how it went (the window's PnL in large, ROI, the clean curve), and the two actions.
 * Under it the figures that qualify the curve (win rate, drawdown, trades, Sharpe), then what it holds now as cards,
 * then the full band of orders and history. A search goes straight to the largest active account: no venue step.
 * On a phone the copy buttons ride in a bar above the tab bar.
 */
import { useMemo, useState } from 'react';
import { Button, EmptyState, Icon, Skeleton, StatusPill } from '../../bots/kit/kit';
import { VenueLogo } from '../../VenueLogo';
import { Private, useMask } from '../../../privacy';
import { fmtUsd, shortAddr } from '../../../format';
import { fmtPlain } from '../../../numStyle';
import { signedPct } from '../../accountTables/cells';
import { fmtDay } from '../../portfolio/parts';
import { winRateView } from '../../../winRateView';
import { SCAN_VENUES, VENUE_LABEL } from '../../../vsApi';
import { HL_WINDOW_LABEL, windowCurve } from '../hlModel';
import { useScanFlow, useVenueView, type ScanFlow, type ScanPageProps, type VenueView } from './flow';
import { bookTotals, standingOf, windowFigures } from './model';
import {
  Avatar, CopyActions, Fig, HistoryBand, PhoneCopyBar, PositionCard, ScanCurve, ScanSearch, TraderTags, VenueSwitch,
  WalletName, WindowSwitch, ChartNote, blockedWhy, cx, noAccountLine, lastActiveText, lastActiveTitle, num, savedWallets, signed, tone, toneUsd, 
} from './parts';

const FIRST_CARDS = 6;

export function V1Profile(props: ScanPageProps) {
  const flow = useScanFlow();
  const view = useVenueView(props, flow.address, flow.venue);
  if (!flow.address) return <Start flow={flow} connected={props.address} />;
  return (
    <div className="sx sx-v1">
      <div className="sx-v1__bar">
        <Button variant="quiet" size="sm" icon="arrowLeft" onClick={flow.clear}>New search</Button>
        <ScanSearch seed={flow.address} connected={props.address} onSearch={flow.search} error={flow.error} className="sx-v1__find" />
      </div>
      <Stage flow={flow} view={view} />
      {flow.venue && <Body view={view} />}
      {flow.venue && <PhoneCopyBar address={flow.address} venue={flow.venue} label={`${VENUE_LABEL[flow.venue]} · ${shortAddr(flow.address)}`} />}
    </div>
  );
}

/* ------------------------------------------------------------------ start ----- */

function Start({ flow, connected }: { flow: ScanFlow; connected: string | null }) {
  const saved = useMemo(savedWallets, []);
  return (
    <div className="sx sx-v1">
      <section className="sx-v1__start">
        <div className="sx-v1__glow" aria-hidden="true" />
        <span className="sx-v1__marks" aria-hidden="true">
          {SCAN_VENUES.map((v) => <span key={v}><VenueLogo venue={v} size={30} /></span>)}
        </span>
        <h1>Look up any wallet</h1>
        <p>Its PnL, positions and history on {SCAN_VENUES.map((v) => VENUE_LABEL[v]).join(', ').replace(/, ([^,]*)$/, ' and $1')}.</p>
        <ScanSearch connected={connected} onSearch={flow.search} error={flow.error} size="md" className="sx-v1__startfind" />
        {saved.length > 0 && (
          <div className="sx-v1__saved">
            <span className="sx-v1__savedk">Saved</span>
            {saved.slice(0, 8).map((w) => (
              <button key={w.address} type="button" className="sx-chip" onClick={() => flow.search(w.address)} title={w.address}>
                <Avatar address={w.address} size={18} />
                {w.name}
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ stage ----- */

function Stage({ flow, view }: { flow: ScanFlow; view: VenueView }) {
  const p = view.trader.data;
  const w = view.win;
  const curve = p && !view.historyNote ? windowCurve(p.equity, w, 'pnl') : null;
  const fig = windowFigures(p, w, curve?.change ?? null);
  const maskPnl = useMask('pnl');
  const maskEq = useMask('equity');
  const active = flow.cards.filter((c) => standingOf(c) === 'active').length;
  const nowhere = flow.settled && !flow.venue;
  const wait = !flow.venue && !flow.settled;
  const why = blockedWhy(view, 'PnL history');
  const glow = view.historyNote ? '' : toneUsd(fig.pnl);
  return (
    <section className={cx('sx-v1__stage', glow && `is-${glow}`)}>
      <div className="sx-v1__glow" aria-hidden="true" />
      <header className="sx-v1__who">
        <Avatar address={flow.address!} size={56} />
        <div className="sx-v1__id">
          <WalletName address={flow.address!} />
          <div className="sx-v1__meta">
            {wait ? <StatusPill size="sm" dot pulse>Checking {SCAN_VENUES.length} venues</StatusPill>
              : <StatusPill size="sm" tone={active ? 'positive' : 'neutral'} dot={active > 0}>{active ? `Active on ${active} of ${SCAN_VENUES.length} venues` : 'No active venue'}</StatusPill>}
            <TraderTags p={p} />
          </div>
        </div>
        {flow.venue && <CopyActions address={flow.address!} venue={flow.venue} profile={p} size="lg" className="sx-v1__cta" />}
      </header>

      <VenueSwitch cards={flow.cards} value={flow.venue} onPick={flow.pick} equity className="sx-v1__venues" />

      {nowhere ? (
        <EmptyState
          icon="search"
          title="No account on any venue"
          description={noAccountLine(flow.cards)}
          className="sx-v1__none"
        />
      ) : wait ? (
        <div className="sx-v1__read">
          <div className="sx-v1__fig"><Skeleton style={{ width: 120, height: 14 }} /><Skeleton style={{ width: 260, height: 44, marginTop: 10 }} /></div>
          <Skeleton className="sx-v1__curve" style={{ height: 260 }} />
        </div>
      ) : (
        <>
          <div className="sx-v1__read">
            <div className="sx-v1__fig">
              {view.historyNote ? (
                <>
                  <span className="sx-v1__k">Account value · live</span>
                  <b className="sx-v1__big">{maskEq(num(p?.summary.accountValue) ? fmtUsd(p!.summary.accountValue) : '—')}</b>
                </>
              ) : (
                <>
                  <span className="sx-v1__k">PnL · {w === 'all' ? 'all time' : HL_WINDOW_LABEL[w]}</span>
                  <b className={cx('sx-v1__big', toneUsd(fig.pnl))}>{view.trader.settled ? maskPnl(signed(fig.pnl)) : <Skeleton style={{ width: 240, height: 44 }} />}</b>
                  <span className="sx-v1__subs">
                    {num(fig.roi) && <StatusPill tone={fig.roi >= 0 ? 'positive' : 'negative'} size="md">ROI {maskPnl(signedPct(fig.roi, 1))}</StatusPill>}
                    {num(fig.volume) && <span>Volume <b>{fmtUsd(fig.volume, 0)}</b></span>}
                    {num(curve?.maxDrawdown) && curve!.maxDrawdown! < 0 && <span title="The biggest fall from a peak to a later low of this window's PnL curve. Derived.">Max drawdown <b className="neg">{maskPnl(fmtUsd(curve!.maxDrawdown!))}</b></span>}
                  </span>
                </>
              )}
            </div>
            {!view.historyNote && <WindowSwitch win={w} onWin={view.setWin} size="md" label="PnL window" />}
          </div>
          {why && why !== 'Loading…' ? <ChartNote>{why}</ChartNote> : <ScanCurve view={view} field="pnl" win={w} className="sx-v1__curve" />}
        </>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------- body ----- */

function Body({ view }: { view: VenueView }) {
  const p = view.trader.data;
  const s = p?.summary;
  const w = view.win;
  const maskEq = useMask('equity');
  const maskPnl = useMask('pnl');
  const [all, setAll] = useState(false);
  const traded = Object.values(s?.volume ?? {}).some((v) => num(v) && v > 0);
  const trades = num(s?.trades) && !(s!.trades === 0 && traded) ? s!.trades! : null;
  const wr = s ? winRateView(s, { context: 'sample', fmtDate: fmtDay }) : null;
  const positions = p?.positions ?? [];
  const totals = bookTotals(positions);
  const shown = all ? positions : positions.slice(0, FIRST_CARDS);
  const why = blockedWhy(view, 'positions');
  const curve = p && !view.historyNote ? windowCurve(p.equity, w, 'pnl') : null;
  const fig = windowFigures(p, w, curve?.change ?? null);

  return (
    <>
      <section className="sx-v1__kpis" aria-label="Figures">
        <Fig label="Account value" value={maskEq(num(s?.accountValue) ? fmtUsd(s!.accountValue) : '—')} title="As the venue reports it." />
        <Fig
          label="Win rate"
          value={num(s?.winRate) ? `${wr?.approx ? '≈' : ''}${fmtPlain(Number((s!.winRate! * 100).toFixed(1)))}%` : '—'}
          sub={num(s?.winRateCloses) && s!.winRateCloses! > 0 ? `${fmtPlain(s!.winRateCloses!)} closes` : undefined}
          title={wr?.title ?? 'Not published for this trader.'}
          tag={num(s?.winRate) && wr?.approx ? 'est.' : undefined}
        />
        <Fig
          label="All-time PnL"
          value={view.historyNote ? '—' : maskPnl(signed(s?.pnl.all))}
          cls={view.historyNote ? undefined : toneUsd(s?.pnl.all)}
          title={view.historyNote ?? 'As the venue reports it.'}
        />
        <Fig label="Closed trades" value={trades === null ? '—' : fmtPlain(trades)} title={trades === null ? 'Not counted by the venue feed.' : 'Orders that closed or reduced a position, in the latest fills the venue serves.'} />
        <Fig label="Sharpe" value={num(s?.sharpe) ? fmtPlain(Number(s!.sharpe!.toFixed(2))) : '—'} title={num(s?.sharpe) ? undefined : 'Not published for this trader.'} />
        <Fig label="Last trade" value={lastActiveText(s?.lastActive)} title={lastActiveTitle(s?.lastActive)} />
      </section>

      <section className="sx-v1__book" aria-label="Open positions">
        <header className="sx-v1__h">
          <h2>Open positions{positions.length > 0 && <span className="sx-count">{positions.length}</span>}</h2>
          {totals && (
            <span className="sx-v1__totals">
              <span>Long <b>{fmtUsd(totals.long, 0)}</b></span>
              <span>Short <b>{fmtUsd(totals.short, 0)}</b></span>
              <span>Unrealized <b className={toneUsd(totals.upnl)}>{maskPnl(signed(totals.upnl))}</b></span>
            </span>
          )}
        </header>
        {totals && totals.gross > 0 && (
          <div className="sx-split" role="img" aria-label={`${Math.round((totals.long / totals.gross) * 100)}% of the open value is long`}>
            <span className="sx-split__l" style={{ flexGrow: totals.long }} />
            <span className="sx-split__s" style={{ flexGrow: totals.short }} />
          </div>
        )}
        <Private k="positions">
          {why ? (
            why === 'Loading…'
              ? <div className="sx-v1__grid">{[0, 1, 2].map((i) => <Skeleton key={i} style={{ height: 168, borderRadius: 14 }} />)}</div>
              : <EmptyState compact icon="layers" title={why} />
          ) : positions.length === 0 ? (
            <EmptyState compact icon="layers" title="No open positions" description="This account holds nothing on this venue right now." />
          ) : (
            <>
              <div className="sx-v1__grid">{shown.map((pp, i) => <PositionCard key={`${pp.symbol}-${pp.side}-${i}`} p={pp} />)}</div>
              {positions.length > FIRST_CARDS && (
                <div className="sx-v1__more">
                  <Button variant="secondary" size="sm" onClick={() => setAll(!all)}>{all ? 'Show fewer' : `Show all ${positions.length}`}</Button>
                </div>
              )}
            </>
          )}
        </Private>
      </section>

      <section className="sx-v1__hist" aria-label="Positions, orders and history">
        <header className="sx-v1__h">
          <h2>Positions, orders and history</h2>
          <span className="sx-v1__src"><Icon name="clock" size={13} />{view.venue ? `From ${VENUE_LABEL[view.venue]}` : ''}</span>
        </header>
        <HistoryBand view={view} />
      </section>
    </>
  );
}
