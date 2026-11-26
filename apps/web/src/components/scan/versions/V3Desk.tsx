/**
 * Version 3, "Desk": a workbench for reading wallets one after another, in the trade page's density.
 *
 * A rail on the left keeps the search, this wallet's venues (balance and standing each) and the wallets saved by
 * name, so moving between wallets and venues never leaves the page. The account on the right is in three tabs:
 *
 *   Book         what it holds now, by risk: account value, unrealised PnL, open value, leverage, margin in use and
 *                the nearest liquidation on one strip, then the positions nearest to liquidation first
 *   Performance  the PnL and account value curves side by side, and every window's PnL, ROI and volume in one table
 *   History      the band of orders, fills, funding and closed trades
 *
 * On a phone the rail folds into the top: the search, then the venues as a switch; saved wallets show on the empty page.
 */
import { useMemo } from 'react';
import { EmptyState, Skeleton, StatusPill, Tabs } from '../../bots/kit/kit';
import { VenueLogo } from '../../VenueLogo';
import { Private, useMask } from '../../../privacy';
import { fmtUsd, shortAddr } from '../../../format';
import { fmtPlain } from '../../../numStyle';
import { signedPct } from '../../accountTables/cells';
import { fmtDay } from '../../portfolio/parts';
import { useMediaQuery, useStored } from '../../../hooks';
import { winRateView } from '../../../winRateView';
import { SCAN_VENUES, VENUE_LABEL, type Window } from '../../../vsApi';
import { HL_WINDOWS, HL_WINDOW_LABEL, windowCurve } from '../hlModel';
import { useScanFlow, useVenueView, type ScanFlow, type ScanPageProps, type VenueView } from './flow';
import { bookTotals, byRisk, liqDistance, marginOf, standingOf, STANDING_TEXT, windowFigures } from './model';
import {
  Avatar, CopyActions, Fig, HistoryBand, PhoneCopyBar, PositionCard, ScanCurve, ScanSearch, TraderTags, VenueSwitch,
  WalletName, WindowSwitch, blockedWhy, compactUsd, cx, noAccountLine, lastActiveText, lastActiveTitle, num, savedWallets, signed, tone, toneUsd, 
} from './parts';

type Tab = 'book' | 'perf' | 'history';

export function V3Desk(props: ScanPageProps) {
  const flow = useScanFlow();
  const view = useVenueView(props, flow.address, flow.venue);
  const phone = useMediaQuery('(max-width: 760px)');
  const [tab, setTab] = useStored<Tab>('vs.scanx.desk.tab', 'book');
  const n = view.trader.data?.positions.length;
  return (
    <div className="sx sx-v3">
      <aside className="sx-v3__rail" aria-label="Wallets">
        <ScanSearch seed={flow.address} connected={props.address} onSearch={flow.search} error={flow.error} />
        {!phone && flow.address && <RailVenues flow={flow} />}
        {(!phone || !flow.address) && <RailSaved flow={flow} />}
      </aside>

      <main className="sx-v3__main">
        {!flow.address ? (
          <div className="sx-v3__box sx-v3__blank">
            <EmptyState
              icon="search"
              title="Pick a wallet"
              description={`Paste an address to read its book, performance and history on ${SCAN_VENUES.map((v) => VENUE_LABEL[v]).join(', ')}.`}
            />
          </div>
        ) : (
          <>
            <header className="sx-v3__head">
              <Avatar address={flow.address} size={40} />
              <div className="sx-v3__id">
                <WalletName address={flow.address} />
                <div className="sx-v3__meta">
                  {flow.venue && <StatusPill size="sm" className="sx-v3__venuepill"><VenueLogo venue={flow.venue} size={13} />{VENUE_LABEL[flow.venue]}</StatusPill>}
                  <TraderTags p={view.trader.data} />
                </div>
              </div>
              {flow.venue && <CopyActions address={flow.address} venue={flow.venue} profile={view.trader.data} className="sx-v3__cta" />}
            </header>
            {phone && <VenueSwitch cards={flow.cards} value={flow.venue} onPick={flow.pick} size="sm" className="sx-v3__pvs" />}
            {!flow.venue ? (
              <div className="sx-v3__box sx-v3__blank">
                {flow.settled
                  ? <EmptyState icon="search" title="No account on any venue" description={noAccountLine(flow.cards)} />
                  : <EmptyState icon="clock" title="Reading every venue" description="The largest active account opens as soon as all five have answered." />}
              </div>
            ) : (
              <>
                <Tabs<Tab>
                  tabs={[
                    { value: 'book', label: 'Book', count: n },
                    { value: 'perf', label: 'Performance' },
                    { value: 'history', label: 'History' },
                  ]}
                  value={tab}
                  onChange={setTab}
                  label="Account view"
                  className="sx-v3__tabs"
                />
                {tab === 'book' && <Book view={view} />}
                {tab === 'perf' && <Perf view={view} />}
                {tab === 'history' && <HistoryBand view={view} className="sx-v3__band" />}
              </>
            )}
            {flow.venue && <PhoneCopyBar address={flow.address} venue={flow.venue} label={`${VENUE_LABEL[flow.venue]} · ${shortAddr(flow.address)}`} />}
          </>
        )}
      </main>
    </div>
  );
}

/* ------------------------------------------------------------------- rail ----- */

function RailVenues({ flow }: { flow: ScanFlow }) {
  const mask = useMask('equity');
  return (
    <section className="sx-v3__sec" aria-label="Venues of this wallet">
      <h3>Venues</h3>
      <ul className="sx-v3__list">
        {flow.cards.map((c) => {
          const st = standingOf(c);
          const on = c.venue === flow.venue;
          return (
            <li key={c.venue}>
              <button type="button" className={cx('sx-v3__item', on && 'is-on', `is-${st}`)} aria-pressed={on} onClick={() => flow.pick(c.venue)}>
                <VenueLogo venue={c.venue} size={18} />
                <span className="sx-v3__itemt">
                  <b>{VENUE_LABEL[c.venue]}</b>
                  <small>{st === 'active' || st === 'inactive' ? (num(c.equity) ? mask(fmtUsd(c.equity)) : '—') : STANDING_TEXT[st]}</small>
                </span>
                {st === 'active' && <i className="sx-dot" aria-label="active" />}
                {st === 'loading' && <i className="sx-dot is-wait" aria-hidden="true" />}
                {st === 'inactive' && <span className="sx-v3__quiet">Inactive</span>}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function RailSaved({ flow }: { flow: ScanFlow }) {
  // Read once per wallet change: a name saved in the header shows here on the next look-up.
  const saved = useMemo(savedWallets, [flow.address]);
  return (
    <section className="sx-v3__sec" aria-label="Saved wallets">
      <h3>Saved wallets</h3>
      {saved.length === 0 ? (
        <p className="sx-v3__hint">Name a wallet with the pen beside its address and it stays here.</p>
      ) : (
        <ul className="sx-v3__list">
          {saved.map((w) => {
            const on = flow.address?.toLowerCase() === w.address.toLowerCase();
            return (
              <li key={w.address}>
                <button type="button" className={cx('sx-v3__item', on && 'is-on')} aria-pressed={on} onClick={() => flow.search(w.address)} title={w.address}>
                  <Avatar address={w.address} size={18} />
                  <span className="sx-v3__itemt"><b>{w.name}</b><small>{shortAddr(w.address)}</small></span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------- book ----- */

function Book({ view }: { view: VenueView }) {
  const p = view.trader.data;
  const s = p?.summary;
  const maskEq = useMask('equity');
  const maskPnl = useMask('pnl');
  const maskFunds = useMask('funds');
  const positions = p?.positions ?? [];
  const totals = bookTotals(positions);
  const av = num(s?.accountValue) ? s!.accountValue! : null;
  const margin = positions.reduce<{ sum: number; skipped: number }>((m, q) => {
    const x = marginOf(q);
    return x === null ? { ...m, skipped: m.skipped + 1 } : { ...m, sum: m.sum + x };
  }, { sum: 0, skipped: 0 });
  const lev = totals && av && av > 0 ? totals.gross / av : null;
  const used = av && av > 0 && positions.length ? margin.sum / av : null;
  const sorted = byRisk(positions);
  const nearest = sorted.find((q) => liqDistance(q) !== null) ?? null;
  const near = nearest ? liqDistance(nearest)! : null;
  const why = blockedWhy(view, 'positions');
  return (
    <div className="sx-v3__pane">
      <div className="sx-v3__box sx-v3__strip">
        <Fig label="Account value" value={maskEq(av === null ? '—' : fmtUsd(av))} title="As the venue reports it." />
        <Fig label="Unrealized PnL" value={maskPnl(signed(totals?.upnl))} cls={toneUsd(totals?.upnl)} title="The sum of the venue's own figure per position." />
        <Fig label="Open value" value={totals ? fmtUsd(totals.gross, 0) : '—'} tag={totals ? 'derived' : undefined} title="Long plus short value of the open positions." />
        <Fig label="Leverage" value={maskFunds(lev === null ? '—' : `${fmtPlain(Number(lev.toFixed(2)))}x`)} tag={lev === null ? undefined : 'derived'} title="Open value ÷ account value." />
        <Fig
          label="Margin in use"
          value={maskFunds(used === null ? '—' : `${fmtPlain(Number((used * 100).toFixed(1)))}%`)}
          sub={used === null ? undefined : `${fmtUsd(margin.sum, 0)} of ${fmtUsd(av)}${margin.skipped ? ` · ${margin.skipped} without leverage` : ''}`}
          tag={used === null ? undefined : 'est.'}
          title="Each position's value ÷ its leverage, against the account value. Margin added to an isolated position by hand is not in the venue's feed."
        />
        <Fig
          label="Nearest liq."
          value={near === null ? '—' : `${fmtPlain(Number((near * 100).toFixed(near < 0.1 ? 1 : 0)))}%`}
          cls={near !== null && near < 0.1 ? 'is-warn' : undefined}
          sub={nearest ? `${nearest.symbol.replace(/^[a-z]+:/, '')} ${nearest.side}` : positions.length ? 'No liquidation price published' : undefined}
          tag={near === null ? undefined : 'derived'}
          title="How far the mark can move against the closest position before the venue's liquidation price."
        />
      </div>
      {totals && totals.gross > 0 && (
        <div className="sx-v3__split">
          <span className="pos">Long {fmtUsd(totals.long, 0)}</span>
          <div className="sx-split" role="img" aria-label={`${Math.round((totals.long / totals.gross) * 100)}% of the open value is long`}>
            <span className="sx-split__l" style={{ flexGrow: totals.long }} />
            <span className="sx-split__s" style={{ flexGrow: totals.short }} />
          </div>
          <span className="neg">Short {fmtUsd(totals.short, 0)}</span>
        </div>
      )}
      <Private k="positions">
        {why ? (
          why === 'Loading…'
            ? <div className="sx-v3__grid">{[0, 1, 2, 3].map((i) => <Skeleton key={i} style={{ height: 160, borderRadius: 14 }} />)}</div>
            : <div className="sx-v3__box"><EmptyState compact icon="layers" title={why} /></div>
        ) : positions.length === 0 ? (
          <div className="sx-v3__box"><EmptyState icon="layers" title="Nothing open" description="This account holds no position on this venue right now. Its history is in the History tab." /></div>
        ) : (
          <>
            <p className="sx-v3__note">Nearest to liquidation first</p>
            <div className="sx-v3__grid">{sorted.map((q, i) => <PositionCard key={`${q.symbol}-${q.side}-${i}`} p={q} />)}</div>
          </>
        )}
      </Private>
    </div>
  );
}

/* ------------------------------------------------------------ performance ----- */

function Perf({ view }: { view: VenueView }) {
  const p = view.trader.data;
  const s = p?.summary;
  const w = view.win;
  const maskPnl = useMask('pnl');
  const maskEq = useMask('equity');
  const curve = p && !view.historyNote ? windowCurve(p.equity, w, 'pnl') : null;
  const fig = windowFigures(p, w, curve?.change ?? null);
  const traded = Object.values(s?.volume ?? {}).some((v) => num(v) && v > 0);
  const trades = num(s?.trades) && !(s!.trades === 0 && traded) ? s!.trades! : null;
  const wr = s ? winRateView(s, { context: 'sample', fmtDate: fmtDay }) : null;
  const cols: Window[] = [...HL_WINDOWS];
  const per = cols.map((x) => {
    const c = p && !view.historyNote ? windowCurve(p.equity, x, 'pnl') : null;
    return { w: x, c, f: windowFigures(p, x, c?.change ?? null) };
  });
  return (
    <div className="sx-v3__pane">
      <div className="sx-v3__perfbar">
        <WindowSwitch win={w} onWin={view.setWin} label="Chart window" />
        {view.historyNote && <span className="sx-v3__warn">{view.historyNote}</span>}
      </div>
      <div className="sx-v3__charts">
        <div className="sx-v3__box sx-v3__chart">
          <div className="sx-v3__ch"><span>PnL · {w === 'all' ? 'all time' : HL_WINDOW_LABEL[w]}</span><b className={toneUsd(fig.pnl)}>{view.historyNote ? '—' : maskPnl(signed(fig.pnl))}</b></div>
          <ScanCurve view={view} field="pnl" win={w} className="sx-v3__cv" />
        </div>
        <div className="sx-v3__box sx-v3__chart">
          <div className="sx-v3__ch"><span>Account value</span><b>{maskEq(num(s?.accountValue) ? fmtUsd(s!.accountValue) : '—')}</b></div>
          <ScanCurve view={view} field="accountValue" win={w} className="sx-v3__cv" />
        </div>
      </div>
      <div className="sx-v3__duo">
        <div className="sx-v3__box sx-v3__tbl" role="table" aria-label="Every window">
          <div className="sx-v3__tr is-head" role="row">
            <span role="columnheader" />
            {per.map((x) => <span key={x.w} role="columnheader" className={cx(x.w === w && 'is-on')}>{x.w === 'all' ? 'All time' : HL_WINDOW_LABEL[x.w]}</span>)}
          </div>
          <div className="sx-v3__tr" role="row">
            <span role="rowheader">PnL</span>
            {per.map((x) => <span key={x.w} role="cell" className={cx(toneUsd(x.f.pnl), x.w === w && 'is-on')}>{view.historyNote ? '—' : maskPnl(signed(x.f.pnl))}</span>)}
          </div>
          <div className="sx-v3__tr" role="row">
            <span role="rowheader">ROI</span>
            {per.map((x) => <span key={x.w} role="cell" className={cx(tone(x.f.roi), x.w === w && 'is-on')}>{num(x.f.roi) ? maskPnl(signedPct(x.f.roi, 1)) : '—'}</span>)}
          </div>
          <div className="sx-v3__tr" role="row">
            <span role="rowheader">Volume</span>
            {per.map((x) => <span key={x.w} role="cell" className={cx(x.w === w && 'is-on')}>{num(x.f.volume) ? compactUsd(x.f.volume) : '—'}</span>)}
          </div>
          <div className="sx-v3__tr" role="row">
            <span role="rowheader" title="The biggest fall from a peak to a later low of each window's PnL curve. Derived.">Max drawdown</span>
            {per.map((x) => <span key={x.w} role="cell" className={cx(num(x.c?.maxDrawdown) && x.c!.maxDrawdown! < 0 && 'neg', x.w === w && 'is-on')}>{num(x.c?.maxDrawdown) ? maskPnl(fmtUsd(x.c!.maxDrawdown!)) : '—'}</span>)}
          </div>
        </div>
        <div className="sx-v3__box sx-v3__facts">
          <Fig label="Win rate" value={num(s?.winRate) ? `${wr?.approx ? '≈' : ''}${fmtPlain(Number((s!.winRate! * 100).toFixed(1)))}%` : '—'} sub={num(s?.winRateCloses) && s!.winRateCloses! > 0 ? `${fmtPlain(s!.winRateCloses!)} closes` : undefined} tag={num(s?.winRate) && wr?.approx ? 'est.' : undefined} title={wr?.title ?? 'Not published for this trader.'} />
          <Fig label="Closed trades" value={trades === null ? '—' : fmtPlain(trades)} title={trades === null ? 'Not counted by the venue feed.' : 'Orders that closed or reduced a position, in the latest fills the venue serves.'} />
          <Fig label="Sharpe" value={num(s?.sharpe) ? fmtPlain(Number(s!.sharpe!.toFixed(2))) : '—'} title={num(s?.sharpe) ? undefined : 'Not published for this trader.'} />
          <Fig label="Last trade" value={lastActiveText(s?.lastActive)} title={lastActiveTitle(s?.lastActive)} />
        </div>
      </div>
    </div>
  );
}
