/**
 * The Hyperliquid account, drawn with the portfolio page's own cards.
 *
 * NOTHING IN THIS FILE IS A NEW LOOK. Every card, group, row, stat strip, meter,
 * chart, exposure split and table below is the component or the class the
 * SoDEX portfolio already uses - Card / Group / Row / Stat / EquityCurve from
 * Portfolio.tsx, `.acct-table` from Account.css, PanelTabs from the dashboard.
 * The only thing that changes between the two venues is where the numbers come
 * from: here it is the multi-venue contract (`TraderProfile`, `VsFill`), read
 * through /api/vs/*, and every piece of arithmetic on it is in hlModel.ts.
 *
 * Two consumers, one set of cards:
 *   - Scan, when ?venue=hyperliquid: the same eight panel slots the SoDEX scan
 *     fills, so the page keeps its shape when you switch venue (HlPanels.tsx).
 *   - Portfolio: a Hyperliquid section for the connected wallet, since the same
 *     EVM address is a Hyperliquid account.
 *
 * HONEST EMPTY STATES. The venue's provider can be missing (`not_available`),
 * down, still loading, or can answer that the address never traded there.
 * Each gets its own sentence in the card; none of them renders a zero.
 */
import type { ReactNode } from 'react';
import {
  AccountChip, Card, EquityCurve, Group, Meter, Row, Stat,
  fmtCompactUsd, fmtDay, fmtRatioPct, fmtSigned, useFlash,
} from '../Portfolio';
import { PanelTabs, type PanelTab } from '../../dashboard/Panel';
import { Private, useMask, usePrivacy } from '../../privacy';
import { DASH, fmt, fmtDateTime, fmtUsd, marketName, signClass } from '../../format';
import { useStored } from '../../hooks';
import { VENUE_LABEL, type TraderProfile, type Venue, type VsFill, type VsPosition, type Window } from '../../vsApi';
import {
  HL_WINDOWS, HL_WINDOW_LABEL, curveOf, exposureOf, windowCurve, fillStats, marginOf, priceDp, unrealizedOf,
} from './hlModel';
import { useVsFills, useVsTrader, type VsRead } from './useVs';
import { winRateView } from '../../winRateView';
import '../Account.css';
import { CoinLabel } from '../CoinIcon';
import { LoadFailed, couldntLoad } from '../LoadFailed';

/* ---------------------------------------------------------------------------
 * STATE - one object every Hyperliquid card reads, built once per page.
 * ------------------------------------------------------------------------ */

export interface HlState {
  /** Whose data this is: Hyperliquid, or another venue served by the same profile + fills reads. */
  venue: Venue;
  /** The address being read. null = nothing connected / nothing scanned. */
  address: string | null;
  trader: VsRead<TraderProfile | null>;
  fills: VsRead<VsFill[]>;
  /** The Performance card and the Performance rail share one window, as on SoDEX. */
  win: Window;
  setWin: (w: Window) => void;
  /** The Account value card keeps its own, as on SoDEX. */
  valueWin: Window;
  setValueWin: (w: Window) => void;
}

/** 30s: the same order as the venue's own clearinghouse push cadence, and cheap. */
const TRADER_POLL_MS = 30_000;
const FILL_LIMIT = 200;

export function useHlState(address: string | null, venue: Venue = 'hyperliquid'): HlState {
  const trader = useVsTrader(venue, address, TRADER_POLL_MS);
  const fills = useVsFills(venue, address, FILL_LIMIT);
  const [win, setWin] = useStored<Window>('vs.hl.window', '30d');
  const [valueWin, setValueWin] = useStored<Window>('vs.hl.valuewindow', '30d');
  return { venue, address, trader, fills, win, setWin, valueWin, setValueWin };
}

/* ---------------------------------------------------------------------------
 * SMALL PIECES
 * ------------------------------------------------------------------------ */

/** PeriodSeg's markup and classes, over the contract's four windows. */
export function WindowSeg({ win, onWin, label }: { win: Window; onWin: (w: Window) => void; label: string }) {
  return (
    <div className="pf-seg" role="tablist" aria-label={label}>
      {HL_WINDOWS.map((w) => (
        <button
          key={w}
          type="button"
          role="tab"
          aria-selected={w === win}
          className={`pf-ctl ${w === win ? 'is-on' : ''}`}
          onClick={() => onWin(w)}
        >
          {HL_WINDOW_LABEL[w]}
        </button>
      ))}
    </div>
  );
}

/**
 * Why a card has nothing to draw, or null when it does.
 *
 * `what` names the thing the card would show, for the same reason Portfolio's
 * `Empty` takes one: six identical "Connect a wallet." lines read as a failed
 * page, six different ones teach the layout.
 */
function blocker(hl: HlState, what: string): string | null {
  const t = hl.trader;
  if (!hl.address) return `Connect a wallet to see ${what}.`;
  if (t.unavailable) return `${VENUE_LABEL[hl.venue]} data is not available yet.`;
  if (t.error) return couldntLoad(accountOf(hl));
  if (!t.settled) return 'Loading…';
  if (!t.data) return `No ${VENUE_LABEL[hl.venue]} account for this address.`;
  return null;
}

/** Every card here reads the one trader request; a failure is said the same way in each. */
const accountOf = (hl: HlState): string => `${VENUE_LABEL[hl.venue]} account`;

/** The trader read failed (an outage, not a `not_available` answer). */
const traderFailed = (hl: HlState): boolean => !!hl.trader.error && !hl.trader.unavailable;

/** "Hyperliquid account couldn't load." with Retry - never the reason. */
function TraderFailed({ hl }: { hl: HlState }) {
  return <LoadFailed what={accountOf(hl)} onRetry={hl.trader.refresh} />;
}

/** The blocker as a card body, styled the way Portfolio's `Empty` styles it. */
function Blocked({ hl, text }: { hl: HlState; text: string }) {
  return traderFailed(hl) ? <TraderFailed hl={hl} /> : <p className="pf-empty">{text}</p>;
}

/** The blocker inside a chart well: `.pf-chart--empty`, as the SoDEX cards do it. */
function ChartBlocked({ hl, text }: { hl: HlState; text: string }) {
  return (
    <div className="pf-chart pf-chart--empty">
      {traderFailed(hl) ? <TraderFailed hl={hl} /> : <p>{text}</p>}
    </div>
  );
}

const pct = (v: number | null | undefined, dp = 2): string =>
  v === null || v === undefined || !Number.isFinite(v) ? DASH : `${v > 0 ? '+' : ''}${(v * 100).toFixed(dp)}%`;

const num = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

/* ---------------------------------------------------------------------------
 * THE RAIL - identity, overview, activity, performance.
 * ------------------------------------------------------------------------ */

/** Display name, rank and style tags, as the rail's status chips. */
export function HlChips({ p }: { p: TraderProfile | null }) {
  if (!p) return null;
  const s = p.summary;
  const tags = s.tags ?? [];
  if (!s.label && !num(s.rank) && tags.length === 0) return null;
  return (
    <div className="pf-account__meta">
      {s.label && <span className="pf-chip pf-chip--ok" title="The display name this trader set on the venue.">{s.label}</span>}
      {num(s.rank) && <span className="pf-chip" title="Leaderboard rank on the venue.">rank {fmt(s.rank, 0)}</span>}
      {tags.map((t) => <span key={t} className="pf-chip">{t}</span>)}
    </div>
  );
}

/** The Overview group of the account card, over the venue's own summary. */
export function HlOverviewGroup({ hl }: { hl: HlState }) {
  const p = hl.trader.data;
  const s = p?.summary;
  const av = s?.accountValue ?? null;
  const exp = p ? exposureOf(p.positions, av) : null;
  const upnl = p ? unrealizedOf(p.positions) : null;
  const volAll = s?.volume.all ?? null;
  const pnlAll = s?.pnl.all ?? null;
  const why = blocker(hl, 'this account');

  return (
    <Group title="Overview">
      <Row
        label="Total equity"
        privacy="equity"
        value={num(av) ? fmtUsd(av) : DASH}
        cls={num(av) ? undefined : 'pf-dim'}
        hint="Account value as the venue reports it: perps margin plus unrealised PnL."
        tag={num(av) ? 'venue' : undefined}
      />
      <Row
        label="Unrealized PnL"
        privacy="pnl"
        value={upnl === null ? DASH : fmtSigned(upnl)}
        cls={upnl === null ? 'pf-dim' : signClass(upnl)}
        hint={upnl === null
          ? (p && p.positions.length ? 'Not shown: a position arrived without the venue\'s own unrealised figure.' : 'No open positions.')
          : "Sum of the venue's own per-position unrealised PnL."}
        tag={upnl === null ? undefined : 'venue'}
      />
      <Row
        label="Open position size"
        value={exp ? fmtCompactUsd(exp.gross) : DASH}
        cls={exp ? undefined : 'pf-dim'}
        hint={exp ? `${fmtUsd(exp.gross)} — long plus short notional.` : 'No open positions.'}
        tag={exp ? 'derived' : undefined}
      />
      <Row
        label="Open orders"
        privacy="counts"
        value={num(p?.openOrders) ? fmt(p!.openOrders!, 0) : DASH}
        cls={num(p?.openOrders) ? undefined : 'pf-dim'}
        tag={num(p?.openOrders) ? 'venue' : undefined}
      />
      <Row
        label="All-time volume"
        value={num(volAll) ? fmtCompactUsd(volAll) : DASH}
        cls={num(volAll) ? undefined : 'pf-dim'}
        hint={num(volAll) ? `${fmtUsd(volAll)} — the venue's own all-time traded volume.` : undefined}
        tag={num(volAll) ? 'venue' : undefined}
      />
      <Row
        label="All-time PnL"
        privacy="pnl"
        value={num(pnlAll) ? fmtSigned(pnlAll) : DASH}
        cls={num(pnlAll) ? signClass(pnlAll) : 'pf-dim'}
        tag={num(pnlAll) ? 'venue' : undefined}
      />
      <Row
        label="Last active"
        privacy="history"
        value={num(s?.lastActive) ? fmtDay(s!.lastActive!) : DASH}
        cls={num(s?.lastActive) ? undefined : 'pf-dim'}
        hint={num(s?.lastActive) ? fmtDateTime(s!.lastActive!) : 'The venue reported no fill time.'}
      />
      {why && hl.address && (traderFailed(hl) ? <TraderFailed hl={hl} /> : <p className="pf-note">{why}</p>)}
    </Group>
  );
}

/** Traded volume per window, as the venue reports it. */
export function HlVolumeGroup({ hl }: { hl: HlState }) {
  const s = hl.trader.data?.summary;
  return (
    <Group title="Traded volume">
      {HL_WINDOWS.map((w) => {
        const v = s?.volume[w] ?? null;
        return (
          <Row
            key={w}
            label={w === 'all' ? 'All-time' : <>Rolling <span className="pf-unit">{HL_WINDOW_LABEL[w].toLowerCase()}</span></>}
            value={num(v) ? fmtCompactUsd(v) : DASH}
            cls={num(v) ? undefined : 'pf-dim'}
            hint={num(v) ? `${fmtUsd(v)} — the venue's own traded volume for this window.` : undefined}
            tag={num(v) ? 'venue' : undefined}
          />
        );
      })}
    </Group>
  );
}

/** "Fees and traded volume" for Hyperliquid: per-window volume plus the loaded fills. */
export function HlActivityCard({ hl }: { hl: HlState }) {
  const f = hl.fills;
  const st = f.data ? fillStats(f.data) : null;

  return (
    <Card className="pf-card--lists">
      <HlVolumeGroup hl={hl} />
      <Group title={<>Recent fills {st ? <span className="pf-unit">{fmt(st.count, 0)}</span> : null}</>}>
        <Row
          label="Notional"
          value={st ? fmtCompactUsd(st.volume) : DASH}
          cls={st ? undefined : 'pf-dim'}
          hint={st ? `${fmtUsd(st.volume)} — price × size over the fills below.` : undefined}
          tag={st ? 'derived' : undefined}
        />
        <Row
          label="Fees paid"
          privacy="fees"
          value={st?.fees != null ? fmtUsd(st.fees) : DASH}
          cls={st?.fees != null ? undefined : 'pf-dim'}
          tag={st?.fees != null ? 'derived' : undefined}
        />
        <Row
          label="Realised PnL"
          privacy="pnl"
          value={st?.realised != null ? fmtSigned(st.realised) : DASH}
          cls={st?.realised != null ? signClass(st.realised) : 'pf-dim'}
          hint="Summed from the closedPnl each fill reports."
          tag={st?.realised != null ? 'derived' : undefined}
        />
        <Row
          label="Closing fills won"
          value={st && st.closing > 0 ? `${fmt(st.wins, 0)} / ${fmt(st.closing, 0)} · ${fmtRatioPct(st.wins / st.closing, 0)}` : DASH}
          cls={st && st.closing > 0 ? undefined : 'pf-dim'}
          hint="Fills that booked a realised PnL, and how many of those were positive. A count of fills, not of round trips."
          tag={st && st.closing > 0 ? 'derived' : undefined}
        />
        {!hl.address ? null
          : f.unavailable ? <p className="pf-note">Fills are not available yet.</p>
          : f.error ? <LoadFailed what="Fills" onRetry={f.refresh} />
          : !f.settled ? <p className="pf-note">Loading…</p>
          : st && st.count === 0 ? <p className="pf-note">No fills on record.</p>
          : st && st.count >= FILL_LIMIT ? (
            <p className="pf-fine">Latest {fmt(FILL_LIMIT, 0)} fills{st.oldest ? ` · since ${fmtDay(st.oldest)}` : ''}</p>
          ) : null}
      </Group>
    </Card>
  );
}

/** The Performance rail group: one window, every figure the contract has for it. */
export function HlPerformanceCard({ hl }: { hl: HlState }) {
  const p = hl.trader.data;
  const s = p?.summary;
  const w = hl.win;
  const label = HL_WINDOW_LABEL[w];
  const curve = p ? windowCurve(p.equity, w, 'pnl') : null;
  const pnl = s?.pnl[w] ?? curve?.change ?? null;
  const roi = s?.roi[w] ?? null;
  const vol = s?.volume[w] ?? null;
  const dd = curve?.maxDrawdown ?? null;
  /* A trade count of zero beside non-zero volume is a count the feed did not
     make, not a trader who never traded - the same "a zero nobody counted is
     not a number" rule the account band's tab labels follow. */
  const traded = Object.values(s?.volume ?? {}).some((v) => num(v) && v > 0);
  const trades = num(s?.trades) && !(s!.trades === 0 && traded) ? s!.trades! : null;
  // A recent sample of fills: "≈ from the last N closes since ..." when the server says so.
  const wr = s ? winRateView(s, { context: 'sample', fmtDate: fmtDay }) : null;

  return (
    <Card className="pf-card--lists">
      <Group title="Performance" action={<WindowSeg win={w} onWin={hl.setWin} label="Performance window" />}>
        <Row
          label="Volume"
          value={num(vol) ? fmtCompactUsd(vol) : DASH}
          cls={num(vol) ? undefined : 'pf-dim'}
          hint={num(vol) ? `${fmtUsd(vol)} traded in ${label}.` : undefined}
          tag={num(vol) ? 'venue' : undefined}
        />
        <Row
          label="P&L"
          privacy="pnl"
          value={num(pnl) ? fmtSigned(pnl) : DASH}
          cls={num(pnl) ? signClass(pnl) : 'pf-dim'}
          hint={num(pnl) ? `PnL over ${label}, as the venue reports it.` : undefined}
          tag={num(pnl) ? 'venue' : undefined}
        />
        <Row
          label="ROI"
          privacy="pnl"
          value={pct(roi)}
          cls={num(roi) ? signClass(roi) : 'pf-dim'}
          tag={num(roi) ? 'venue' : undefined}
        />
        <Row
          label="Max drawdown"
          privacy="pnl"
          value={dd === null ? DASH : fmtUsd(dd)}
          cls={dd ? 'pf-neg-text' : 'pf-dim'}
          hint={dd === null
            ? 'No PnL history in this window.'
            : `The biggest fall from a peak to a later low of the ${label} PnL curve, not its lowest point.`}
          tag={dd === null ? undefined : 'derived'}
        />
        <Row
          label="Win rate"
          value={num(s?.winRate) ? `${wr?.approx ? '≈' : ''}${fmtRatioPct(s!.winRate!, 1)}` : DASH}
          cls={num(s?.winRate) ? undefined : 'pf-dim'}
          hint={wr?.title ?? (num(s?.winRate) ? 'Share of closed trades that made money, over the tracked history.' : 'Not published for this trader.')}
          tag={num(s?.winRate) ? (wr?.approx ? 'est.' : 'derived') : undefined}
        />
        <Row
          label="Closed trades"
          value={trades === null ? DASH : fmt(trades, 0)}
          cls={trades === null ? 'pf-dim' : undefined}
          hint={trades === null
            ? 'Not counted by the venue feed.'
            : 'Orders that closed or reduced a position, in the latest fills the venue serves. The leaderboard counts every execution in its window instead.'}
          tag={trades === null ? undefined : 'derived'}
        />
        <Row
          label="Sharpe"
          value={num(s?.sharpe) ? fmt(s!.sharpe!, 2) : DASH}
          cls={num(s?.sharpe) ? undefined : 'pf-dim'}
          tag={num(s?.sharpe) ? 'derived' : undefined}
        />
      </Group>
    </Card>
  );
}

/* ---------------------------------------------------------------------------
 * THE MAIN COLUMN - the two chart cards, capital, exposure.
 * ------------------------------------------------------------------------ */

/** Account value: headline, the venue's account-value series, three live measures. */
export function HlValueCard({ hl, title = 'Account value' }: { hl: HlState; title?: ReactNode }) {
  const p = hl.trader.data;
  const av = p?.summary.accountValue ?? null;
  const flash = useFlash(num(av) ? av : null);
  const maskEquity = useMask('equity');
  const fundsHidden = usePrivacy().isHidden('funds');
  const exp = p ? exposureOf(p.positions, av) : null;
  const upnl = p ? unrealizedOf(p.positions) : null;
  const margin = p ? marginOf(p.positions, av) : null;
  const curve = p ? windowCurve(p.equity, hl.valueWin, 'accountValue') : null;
  const why = blocker(hl, 'account value');

  const ratio = margin && num(av) && av > 0 ? margin.used / av : null;
  const band = ratio === null ? '' : ratio >= 0.7 ? 'neg' : ratio >= 0.4 ? 'warn' : 'pos';

  return (
    <Card
      title={title}
      className="pf-card--chart"
      action={
        <div className="pf-cardactions">
          <WindowSeg win={hl.valueWin} onWin={hl.setValueWin} label="Equity window" />
        </div>
      }
    >
      <div className="pf-readout">
        <span className="pf-readout__label">Total equity</span>
        <span className={`pf-readout__value ${flash ? `pf-flash--${flash}` : ''}`}>
          {maskEquity(num(av) ? fmtUsd(av) : DASH)}
        </span>
      </div>

      {why ? <ChartBlocked hl={hl} text={why} />
        : curve ? <EquityCurve win={curve} tone="equity" compactAxis />
        : <ChartBlocked hl={hl} text="No account value history" />}

      <div className="pf-statstrip">
        <Stat
          label="Margin in use"
          privacy="funds"
          value={ratio === null ? DASH : fmtRatioPct(ratio)}
          cls={ratio === null ? 'pf-dim' : band}
          tag={ratio === null ? undefined : 'est.'}
          hint={ratio === null ? undefined
            : `${fmtUsd(margin!.used)} of ${fmtUsd(av)} — each position's notional ÷ its leverage. The amber and red thresholds at 40% and 70% are ours, not the venue's.`}
        >
          {ratio !== null && !fundsHidden ? (
            <Meter value={ratio} tone={band || 'pos'} label={`Margin in use is ${fmtRatioPct(ratio)} of account value`} />
          ) : null}
        </Stat>
        <Stat
          label="Unrealized PnL"
          privacy="pnl"
          value={upnl === null ? DASH : fmtSigned(upnl)}
          cls={upnl === null ? 'pf-dim' : signClass(upnl)}
          tag={upnl === null ? undefined : 'venue'}
          tagHint="Sum of the venue's own per-position figure."
        />
        <Stat
          label="Account leverage"
          privacy="funds"
          value={exp?.grossLeverage != null ? `${fmt(exp.grossLeverage, 2)}×` : DASH}
          cls={exp?.grossLeverage != null ? undefined : 'pf-dim'}
          tag={exp?.grossLeverage != null ? 'derived' : undefined}
          tagHint="Gross notional ÷ account value."
        />
      </div>
    </Card>
  );
}

/** Performance: the venue's PnL series for the window, and what it adds up to. */
export function HlPnlCard({ hl, title = 'Performance' }: { hl: HlState; title?: ReactNode }) {
  const p = hl.trader.data;
  const s = p?.summary;
  const w = hl.win;
  const label = HL_WINDOW_LABEL[w];
  const curve = p ? windowCurve(p.equity, w, 'pnl') : null;
  const change = s?.pnl[w] ?? curve?.change ?? null;
  const roi = s?.roi[w] ?? null;
  const vol = s?.volume[w] ?? null;
  const dd = curve?.maxDrawdown ?? null;
  const maskPnl = useMask('pnl');
  const why = blocker(hl, "this account's PnL");

  return (
    <Card
      title={title}
      className="pf-card--chart"
      action={
        <div className="pf-cardactions">
          <WindowSeg win={w} onWin={hl.setWin} label="Chart window" />
        </div>
      }
    >
      <div className="pf-readout">
        <span className="pf-readout__label">Total P&amp;L · {label}</span>
        <span className={`pf-readout__value ${num(change) ? signClass(change) : ''}`}>
          {maskPnl(num(change) ? fmtSigned(change) : DASH)}
        </span>
      </div>

      {why ? <ChartBlocked hl={hl} text={why} />
        : curve ? <EquityCurve win={curve} compactAxis />
        : <ChartBlocked hl={hl} text="No PnL history" />}

      <div className="pf-statstrip">
        <Stat
          label={`ROI · ${label}`}
          privacy="pnl"
          value={pct(roi)}
          cls={num(roi) ? signClass(roi) : 'pf-dim'}
          tag={num(roi) ? 'venue' : undefined}
        />
        <Stat
          label={`Max drawdown · ${label}`}
          privacy="pnl"
          value={dd === null ? DASH : fmtUsd(dd)}
          cls={dd ? 'pf-neg-text' : 'pf-dim'}
          tag={dd === null ? undefined : 'derived'}
          tagHint="Deepest peak-to-trough fall of the PnL curve inside this window."
        />
        <Stat
          label={`Volume · ${label}`}
          privacy="funds"
          value={num(vol) ? fmtCompactUsd(vol) : DASH}
          cls={num(vol) ? undefined : 'pf-dim'}
          tag={num(vol) ? 'venue' : undefined}
        />
      </div>
    </Card>
  );
}

/** Capital efficiency: where the equity is committed, estimated from leverage. */
export function HlCapitalCard({ hl }: { hl: HlState }) {
  const p = hl.trader.data;
  const why = blocker(hl, 'how the equity is committed');
  const av = p?.summary.accountValue ?? null;
  const m = p ? marginOf(p.positions, av) : null;
  if (why || !m) return <Card title="Capital efficiency"><Blocked hl={hl} text={why ?? 'Nothing to break down.'} /></Card>;

  const total = m.accountValue ?? 0;
  const f = (v: number) => (total > 0 ? Math.max(0, Math.min(1, v / total)) : 0);
  const c1 = f(m.cross);
  const c2 = c1 + f(m.isolated);
  const c3 = c2 + f(m.free ?? 0);
  const layers: Array<[string, number, string, number]> = [
    ['free', c3, 'Free', m.free ?? 0],
    ['iso', c2, 'Isolated positions', m.isolated],
    ['cross', c1, 'Cross positions', m.cross],
  ];

  return (
    <Card title="Capital efficiency">
      <Row
        label="Margin in use"
        value={total > 0 ? `${fmtUsd(m.used)} · ${fmtRatioPct(m.used / total, 1)}` : fmtUsd(m.used)}
        hint="Each position's notional ÷ its leverage, summed. Margin added to an isolated position by hand is not in the venue's feed."
        tag="est."
      />
      {total > 0 ? (
        <>
          <div className="pf-stack-bar" role="img" aria-label="Account value by what each part is committed to">
            {layers.map(([tone, cum]) => (
              <span
                key={tone}
                className={`pf-stack-bar__seg pf-stack-bar__seg--${tone}`}
                style={{ transform: `scaleX(${cum})` }}
              />
            ))}
          </div>
          <ul className="pf-legend">
            {layers.slice().reverse().map(([tone, , label, value]) => (
              <li key={tone}>
                <i className={`pf-swatch pf-swatch--${tone}`} />
                <span>{label}</span>
                <b>{fmtUsd(value)}</b>
                <span className="pf-dim">{fmtRatioPct(value / total, 1)}</span>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="pf-note">No account value to break down.</p>
      )}
      {m.skipped > 0 && (
        <p className="pf-fine">{m.skipped} position{m.skipped === 1 ? '' : 's'} without leverage not counted</p>
      )}
    </Card>
  );
}

/** Net positions exposure: ExposurePanel's markup over the venue's positions. */
export function HlExposureCard({ hl }: { hl: HlState }) {
  const p = hl.trader.data;
  const why = blocker(hl, 'long and short exposure');
  const e = p ? exposureOf(p.positions, p.summary.accountValue) : null;
  if (why || !e) {
    return (
      <Card title="Net positions exposure">
        <Blocked hl={hl} text={why ?? 'No open positions to weigh.'} />
      </Card>
    );
  }
  const skew = e.gross > 0 ? e.long / e.gross : 0;

  return (
    <Card title="Net positions exposure">
      <div className="pf-exposure__figures">
        <div>
          <span className="pf-stat__sub">Net</span>
          <span className={`pf-stat__value ${e.net > 0 ? 'pos' : e.net < 0 ? 'neg' : ''}`}>{fmtSigned(e.net, 0)}</span>
        </div>
        <div>
          <span className="pf-stat__sub">Gross</span>
          <span className="pf-stat__value">{fmtUsd(e.gross, 0)}</span>
        </div>
      </div>

      <div className="pf-split" role="img" aria-label={`${fmtRatioPct(skew)} of gross exposure is long`}>
        <span className="pf-split__fill" style={{ transform: `scaleX(${skew})` }} />
      </div>
      <div className="pf-split__labels">
        <span className="pos">Long {fmtUsd(e.long, 0)}</span>
        <span className="neg">Short {fmtUsd(e.short, 0)}</span>
      </div>

      <ul className="pf-alloc">
        {e.byMarket.map((mk) => (
          <li key={`${mk.symbol}-${mk.dir}`}>
            <span className="pf-alloc__name" title={mk.symbol}><CoinLabel coin={mk.symbol}>{marketName(mk.symbol)}</CoinLabel></span>
            <span className="pf-alloc__track">
              <span
                className={`pf-alloc__fill ${mk.dir === 'long' ? 'pos' : 'neg'}`}
                style={{ transform: `scaleX(${Math.max(0.01, mk.share)})` }}
              />
            </span>
            <span className="pf-alloc__value">{fmtUsd(mk.notional, 0)}</span>
            <span className="pf-alloc__share pf-dim">{fmtRatioPct(mk.share, 1)}</span>
          </li>
        ))}
      </ul>

      {e.unpriced > 0 && (
        <p className="pf-fine">
          {e.unpriced} unpriced position{e.unpriced === 1 ? "" : "s"} · totals are a floor
        </p>
      )}
    </Card>
  );
}

/* ---------------------------------------------------------------------------
 * THE BAND - positions and fills, in the account band's tab bar and tables.
 * ------------------------------------------------------------------------ */

const px = (v: number | null | undefined): string => (num(v) ? fmt(v, priceDp(v)) : DASH);

function HlPositionsTable({ hl }: { hl: HlState }) {
  const p = hl.trader.data;
  const why = blocker(hl, 'open positions');
  const rows: VsPosition[] = p?.positions ?? [];
  return (
    <section className="panel acct">
      {why ? (traderFailed(hl) ? <TraderFailed hl={hl} /> : <p className="acct-empty">{why}</p>)
        : rows.length === 0 ? <p className="acct-empty">No open positions.</p>
        : (
          <table className="acct-table">
            <thead>
              <tr>
                <th>Market</th>
                <th>Side</th>
                <th className="num">Size</th>
                <th className="num">Notional</th>
                <th className="num">Entry</th>
                <th className="num">Mark</th>
                <th className="num">Unreal. PnL</th>
                <th className="num">Liq.</th>
                <th className="num">Leverage</th>
                <th>Margin</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={`${r.symbol}-${r.side}-${i}`}>
                  <td><CoinLabel coin={r.symbol}>{marketName(r.symbol)}</CoinLabel></td>
                  <td className={r.side === 'long' ? 'pos' : 'neg'}>{r.side}</td>
                  <td className="num">{fmt(r.size)}</td>
                  <td className="num">{fmtUsd(Math.abs(r.notional))}</td>
                  <td className="num">{px(r.entryPx)}</td>
                  <td className="num">{px(r.markPx)}</td>
                  <td className={`num ${num(r.uPnl) ? signClass(r.uPnl) : 'muted'}`}>{num(r.uPnl) ? fmtUsd(r.uPnl) : DASH}</td>
                  <td className="num">{px(r.liqPx)}</td>
                  <td className="num">{num(r.leverage) ? `${fmt(r.leverage, 0)}×` : DASH}</td>
                  <td className="muted">{r.marginMode ?? DASH}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
    </section>
  );
}

function HlFillsTable({ hl }: { hl: HlState }) {
  const f = hl.fills;
  const rows = f.data ?? [];
  const why = !hl.address ? `Connect a wallet to see its fills.`
    : f.unavailable ? `${VENUE_LABEL[hl.venue]} fills are not available yet.`
    : f.error ? couldntLoad('Fills')
    : !f.settled ? 'Loading…'
    : rows.length === 0 ? 'No fills on record.'
    : null;
  return (
    <section className="panel acct">
      {why ? (f.error && !f.unavailable ? <LoadFailed what="Fills" onRetry={f.refresh} /> : <p className="acct-empty">{why}</p>) : (
        <table className="acct-table">
          <thead>
            <tr>
              <th>Market</th>
              <th>Side</th>
              <th>Direction</th>
              <th className="num">Price</th>
              <th className="num">Qty</th>
              <th className="num">Notional</th>
              <th className="num">Fee</th>
              <th className="num">Realised</th>
              <th className="num">Time</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td><CoinLabel coin={r.symbol}>{marketName(r.symbol)}</CoinLabel></td>
                <td className={r.side === 'buy' ? 'pos' : 'neg'}>{r.side}</td>
                <td className="muted">{r.dir ?? DASH}</td>
                <td className="num">{px(r.px)}</td>
                <td className="num">{fmt(r.sz)}</td>
                <td className="num">{fmtUsd(Math.abs(r.notional))}</td>
                <td className="num">{num(r.fee) ? fmt(r.fee, 4) : DASH}</td>
                <td className={`num ${num(r.closedPnl) && r.closedPnl !== 0 ? signClass(r.closedPnl) : 'muted'}`}>
                  {num(r.closedPnl) && r.closedPnl !== 0 ? fmtUsd(r.closedPnl) : DASH}
                </td>
                <td className="num muted">{fmtDateTime(r.time)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/**
 * The band. `.dash .pf-band` around PanelTabs is exactly how the portfolio mounts
 * AccountTabs, so the tab bar, its stub and its tables are the same element.
 */
export function HlBand({ hl }: { hl: HlState }) {
  const hideCounts = usePrivacy().isHidden('counts');
  const n = hl.trader.data?.positions.length;
  const tabs: PanelTab[] = [
    {
      key: 'positions',
      label: `Positions${n === undefined || hideCounts ? '' : ` (${n})`}`,
      content: <Private k="positions"><HlPositionsTable hl={hl} /></Private>,
    },
    {
      key: 'fills',
      label: 'Trade History',
      content: <Private k="history"><HlFillsTable hl={hl} /></Private>,
    },
  ];
  return (
    <Card className="pf-card--band">
      <div className="dash pf-band">
        <PanelTabs tabs={tabs} />
      </div>
    </Card>
  );
}

/* ---------------------------------------------------------------------------
 * The identity card's HL part, for pages that already show the chip elsewhere.
 * ------------------------------------------------------------------------ */

export function HlAccountBody({ hl, showChip }: { hl: HlState; showChip: boolean }) {
  return (
    <>
      {showChip && <AccountChip address={hl.address} unlocked={false} exists={null} />}
      <HlChips p={hl.trader.data} />
      <HlOverviewGroup hl={hl} />
    </>
  );
}
