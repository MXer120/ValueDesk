/**
 * The portfolio page: Trade and Wealth, in a fixed order.
 *
 *   Portfolio
 *   [Trade | Wealth]                       Deposit  Withdraw  Transfer  Swap
 *   Total Value and where it is            Total Value / PnL / Calendar chart
 *   Copy trading · USDC Earn · US Cash Yield · Bots
 *   Fee rates
 *   Perps or Spot summary over a range
 *   Perps · Spot · Wealth | Copy trading · Bots, each over the shared account tables
 *
 * ONE RULE GOVERNS THE LAST ROW AND THE LEFT CARD (components/portfolio/summary.ts).
 * Perps, Spot, Wealth and EVM are places money IS: they add up to Total Value. Copy trading
 * and Bots are not places. They trade from the same Perps and Spot accounts, so they sit past
 * a divider, carry an "Activity" label, and show what they did, with no balance of their own.
 */
import { ShareButton } from '../share/host';
import { portfolioCard } from '../share/shareData';
import { PortfolioMargin } from '../bots/Allocation';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AccountTabs } from '../AccountTabs';
import { ReadFailed } from '../AccountHistory';
import { CoinIcon } from '../CoinIcon';
import { EmptyState, NoWallet } from '../EmptyState';
import { FeeSchedule } from '../FeeSchedule';
import { Collapse } from '../motion';
import { requestDeposit, requestTransfer, requestWithdraw } from '../account/actions';
import { useAccountTotals } from '../account/useAccountTotals';
import { Chevron, SodexMark } from '../funds/ui';
import { SwapIcon } from '../funds/TransferModal';
import { IconCopyTrade } from '../palette/icons';
import { MyCopiesCard } from '../scan/MyCopies';
import { BotIcon } from '../bots/BotIcon';
import {
  CrossFadeCal, InfoDot, fmtSigned, pnlAt, sliceCurve, useVolume7d,
  type Period, type PortfolioContext,
} from '../Portfolio';
import { Card, EquityCurve, fmtCompactUsd, type CurveWindow } from './parts';
import { claimedCoins, shareKey, summarize, type PortfolioSummary } from './summary';
import { RangePicker, ViewSeg } from './RangePicker';
import { SwapSheet } from './SwapSheet';
import { useWealth, type WealthState } from './useWealth';
import { WealthHoldings, WealthTab } from './WealthTab';
import { PanelTabs, type PanelTab } from '../../dashboard/Panel';
import { api } from '../../api';
import { HELD_MESSAGE, activityWindow, type ActivityWindow } from '../../exchange/allTime';
import type { Cover } from '../../exchange/activityWindows';
import { useAccountResource } from '../../accountFeeds';
import { fetchChart, type ChartPoint } from '../../performance';
import { DASH, MINUS, fmt, fmtUsd, num, pick, signClass } from '../../format';
import { fmtRate, type VenueFeeRate } from '../../fees';
import { useAsync, useStored } from '../../hooks';
import { SOON_TABS, type Tab } from '../../router';
import { applyForBeta, useBotsAccess } from '../../beta/access';
import { useMask } from '../../privacy';
import { coinPrices, priceOf } from '../../trading/prices';
import type { Eip1193Provider } from '../../wallet';
import { directionOfSide } from '../accountTables/filters';
import './PortfolioPage.css';

export interface PortfolioPageLinks {
  provider: Eip1193Provider | null;
  onOpenMarket: (symbol: string, engine: 'spot' | 'perps') => void;
  onOpenTab: (tab: Tab) => void;
}

const RANGES: ReadonlyArray<readonly [Period, string]> = [['24H', '24h'], ['7D', '7d'], ['14D', '14d'], ['30D', '30d'], ['ALL', 'All time']];
const CHART_VIEWS: ReadonlyArray<readonly [ChartView, string]> = [['value', 'Total Value'], ['pnl', 'PnL'], ['calendar', 'PnL Calendar']];

// --- the numbers ------------------------------------------------------------------------

export function useSummary(c: PortfolioContext, w: WealthState): { summary: PortfolioSummary; evmRows: Array<{ chain: string; chainLabel: string; symbol: string; usd: number }>; evmLoading: boolean } {
  const totals = useAccountTotals(c.address);
  const px = useAsync(() => coinPrices(), [], { pollMs: 60_000 });
  // The same shared feed the address menu and the Balances table read: no extra request.
  const spotState = useAccountResource(c.address ? `state:spot:${c.address}` : null, () => api.state('spot', c.address!), 20_000);
  const spot = useMemo(() => {
    if (!c.address || !spotState.data || !px.data) return null;
    return ((spotState.data.state?.B ?? []) as unknown[]).map((b) => {
      const coin = String(pick(b, 'a', 'coin') ?? '');
      const p = priceOf(px.data!, coin);
      return { coin, usd: p === undefined ? null : num(pick(b, 't', 'total')) * p };
    });
  }, [c.address, spotState.data, px.data]);
  const venueTotal = c.venue.points?.[c.venue.points.length - 1]?.accountValue ?? null;
  const summary = useMemo(() => summarize({
    perps: c.model.account ? c.model.account.accountValue : totals.perpsUsd,
    spot,
    evm: totals.evm,
    wealth: w.rows,
    venueTotal,
  }), [c.model.account, totals.perpsUsd, spot, totals.evm, w.rows, venueTotal]);
  const claimed = useMemo(() => claimedCoins(w.rows), [w.rows]);
  const evmRows = (totals.evm ?? []).filter((h) => h.usd >= 0.01 && !(h.chain === 'VALUECHAIN' && claimed.has(shareKey(h.symbol))));
  return { summary, evmRows, evmLoading: !!c.address && totals.evmLoading };
}

/** SoDEX's 24-hour window (finer than the daily spine). Today's PnL and the chart's 24H read it. */
function use24h(c: PortfolioContext): ChartPoint[] | null {
  const id = c.venue.accountId;
  const r = useAsync(() => fetchChart(id!, '24H', 'all', c.venue.network), [id, c.venue.network], { enabled: !!id, pollMs: 300_000 });
  return r.data?.points ?? null;
}

function curveFor(c: PortfolioContext, h24: ChartPoint[] | null, range: Period, value: (p: ChartPoint) => number): CurveWindow | null {
  const spine = c.venue.points;
  if (!spine) return null;
  if (range !== '24H') return sliceCurve(spine, range, value);
  if (!h24 || h24.length < 2) return null;
  const baseline = value(h24[0]!);
  const points = h24.map((p) => ({ t: p.ts, v: value(p) - baseline }));
  return { points, baseline, change: points[points.length - 1]!.v, maxDrawdown: null };
}

/** A curve is built as the change from its start; a balance chart reads the balance itself. */
const atLevel = (w: CurveWindow): CurveWindow => ({ ...w, points: w.points.map((p) => ({ t: p.t, v: p.v + w.baseline })) });

// --- the head ---------------------------------------------------------------------------

function MoneyButtons({ c, onSwap }: { c: PortfolioContext; onSwap: () => void }) {
  const noAccount = c.model.account?.exists === false;
  return (
    <div className="pfx-money">
      <button type="button" className="pf-btn pf-btn--primary" onClick={requestDeposit}>Deposit</button>
      <button type="button" className="pf-btn" disabled={noAccount} onClick={() => requestWithdraw()}>Withdraw</button>
      <button type="button" className="pf-btn" disabled={noAccount} onClick={() => requestTransfer()}>Transfer</button>
      <button type="button" className="pf-btn pfx-swapbtn" onClick={onSwap} title="Swap USDT to USDC">
        <span className="pfx-pair" aria-hidden="true"><CoinIcon coin="USDT" size={18} /><CoinIcon coin="USDC" size={18} /></span>
        Swap
      </button>
    </div>
  );
}

// --- the left card ----------------------------------------------------------------------

function Bucket({ icon, label, value, hint, onClick, open }: {
  icon: ReactNode; label: string; value: ReactNode; hint?: string; onClick?: () => void; open?: boolean;
}) {
  return (
    <button type="button" className={`pfa__part pfa__part--toggle pfx-bucket${open ? ' is-open' : ''}`} onClick={onClick} aria-expanded={open}>
      <span className="pfa__part-ic">{icon}</span>
      <span className="pfa__part-k">{label}{hint && <InfoDot title={hint} />}{open !== undefined && <Chevron />}</span>
      <span className="pfa__part-v">{value}</span>
    </button>
  );
}

function ValueCard({ c, s, today, vol, evmRows, evmLoading, onSection }: {
  c: PortfolioContext;
  s: PortfolioSummary;
  today: number | null;
  vol: number | null;
  evmRows: Array<{ chain: string; chainLabel: string; symbol: string; usd: number }>;
  evmLoading: boolean;
  onSection: (s: Section) => void;
}) {
  const maskEquity = useMask('equity');
  const maskFunds = useMask('funds');
  const maskPnl = useMask('pnl');
  const [evmOpen, setEvmOpen] = useState(false);
  const usd = (v: number | null) => maskFunds(v === null ? DASH : fmtUsd(v));
  const week = c.venue.points ? sliceCurve(c.venue.points, '7D', (p) => pnlAt('pnl-total', p)) : null;
  const pledged = s.wealthInPerps > 0.01 ? ` ${fmtUsd(s.wealthInPerps)} of it is pledged as Perps margin and counted in Perps.` : '';
  return (
    <Card className="pfx-value">
      <div className="pfx-value__top">
        <span className="pfx-value__k">Total Value</span>
        <span className="pfx-value__v">{maskEquity(s.total === null ? DASH : fmtUsd(s.total))}</span>
        <span className="pfx-value__sub">
          Today&apos;s PnL <b className={today === null ? undefined : signClass(today)}>{maskPnl(today === null ? DASH : fmtSigned(today))}</b>
        </span>
      </div>

      <div className="pfx-kv">
        <div className="pfx-kv__row">
          <span>PnL (7D)</span>
          <b className={week?.change == null ? undefined : signClass(week.change)}>{maskPnl(week?.change == null ? DASH : fmtSigned(week.change))}</b>
        </div>
        <div className="pfx-kv__row">
          <span>Volume (7D) <InfoDot title="The SoDEX leaderboard's own 7-day volume." /></span>
          <b>{maskFunds(vol === null ? DASH : fmtUsd(vol))}</b>
        </div>
      </div>

      <div className="pfx-buckets">
        <Bucket icon={<CoinIcon coin="USDC" size={18} />} label="Perps" value={usd(s.perps)} hint="Copies and bots trade from this account, so their money is already counted here." onClick={() => onSection('perps')} />
        <Bucket icon={<CoinIcon coin="USDC" size={18} />} label="Spot" value={usd(s.spot)} onClick={() => onSection('spot')} />
        <Bucket
          icon={<SodexMark size={18} />}
          label="Wealth"
          value={usd(s.wealth)}
          hint={`SoDEX Wealth funds wherever the shares sit, so a fund in Spot or your wallet is counted here and not there.${pledged}`}
          onClick={() => onSection('wealth')}
        />
        <Bucket icon={<CoinIcon chain="VALUECHAIN" size={18} />} label="EVM" value={s.evm === null ? (evmLoading ? '…' : DASH) : usd(s.evm)} open={evmOpen} onClick={() => setEvmOpen((v) => !v)} />
        <Collapse open={evmOpen}>
          <ul className="pf-evm pfa__evm">
            {evmRows.length === 0 && <li className="pf-dim">{evmLoading ? 'Reading your wallet…' : 'Nothing on ValueChain or the other EVM chains.'}</li>}
            {evmRows.map((h) => (
              <li key={`${h.chain}:${h.symbol}`}>
                <span className="pf-evm__ic"><CoinIcon coin={h.symbol} size={16} /><CoinIcon chain={h.chain} size={10} className="pf-evm__chain" /></span>
                <span className="pf-evm__t">{h.symbol}<small>{h.chainLabel}</small></span>
                <span className="pf-evm__v">{maskFunds(fmtUsd(h.usd))}</span>
              </li>
            ))}
          </ul>
        </Collapse>
      </div>
    </Card>
  );
}

// --- the chart --------------------------------------------------------------------------

type ChartView = 'value' | 'pnl' | 'calendar';

function ChartCard({ c, h24 }: { c: PortfolioContext; h24: ChartPoint[] | null }) {
  const [view, setView] = useStored<ChartView>('vs.pf.chart.view', 'value');
  const [range, setRange] = useStored<Period>('vs.pf.chart.range', '7D');
  const win = view === 'calendar' ? null : curveFor(c, h24, range, view === 'value' ? (p) => p.accountValue : (p) => pnlAt('pnl-total', p));
  const empty = (body: ReactNode) => <div className="pf-chart pf-chart--empty"><p>{body}</p></div>;
  const mask = useMask(view === 'value' ? 'funds' : 'pnl');
  return (
    <Card
      className="pf-card--chart pfx-chart"
      title={<RangePicker value={view} options={CHART_VIEWS} onChange={setView} label="Chart" align="start" />}
      action={view === 'calendar' ? undefined : (
        <span className="pfx-chart__acts">
          {c.address && c.venue.points && (
            <ShareButton
              label="Share this PnL"
              make={() => {
                // The card is the PnL over the window shown, whichever chart is open (SoDEX's own series).
                const pw = curveFor(c, h24, range, (p) => pnlAt('pnl-total', p));
                if (!pw || pw.change === null) return null;
                const value = c.model.account?.accountValue;
                return portfolioCard({ range, change: pw.change, ys: pw.points.map((p) => p.v), trades: null, volume: null, value: typeof value === 'number' && Number.isFinite(value) ? value : null, wallet: c.address });
              }}
            />
          )}
          <ViewSeg value={range} options={RANGES} onChange={setRange} label="Timeframe" />
        </span>
      )}
    >
      {win && win.change !== null && (
        <div className="pfx-chart__head">
          <span>
            {view === 'value' ? 'Change in value' : 'PnL'}, {range === 'ALL' ? 'all time' : range.toLowerCase()}
            {view === 'value' && <InfoDot title="SoDEX's own series: Spot, Perps and vaults, deposits and withdrawals included. Your EVM wallet is not in it." />}
          </span>
          <b className={view === 'pnl' ? signClass(win.change) : undefined}>{mask(fmtSigned(win.change))}</b>
        </div>
      )}
      {!c.address ? empty('Connect a wallet to see your chart.')
        : c.venue.error ? <div className="pf-chart pf-chart--empty"><ReadFailed what="Account history" error={c.venue.error} /></div>
        : c.venue.progress ? empty(<><span className="pf-spin" aria-hidden="true" />Reading</>)
        : !c.venue.accountId ? empty('No SoDEX account for this wallet yet.')
        : view === 'calendar' ? <CrossFadeCal points={c.venue.points ?? []} mode="pnl-total" />
        : win ? <EquityCurve win={view === 'value' ? atLevel(win) : win} tone={view === 'value' ? 'equity' : 'pnl'} level={view === 'value'} compactAxis clean />
        : empty(`Fewer than two points in ${range === 'ALL' ? 'this history' : range.toLowerCase()}.`)}
    </Card>
  );
}

// --- the promo row ----------------------------------------------------------------------

function Promo({ tint, icon, title, cta, line, figure, soon, beta, onClick }: {
  tint: 'copy' | 'earn' | 'cash' | 'bots'; icon: ReactNode; title: string; cta?: string; line: string; figure?: string | null; soon?: boolean;
  /** In beta: a Beta pill, and the call to action applies for access. */
  beta?: boolean; onClick?: () => void;
}) {
  const body = (
    <>
      <span className="pfx-promo__top">
        <span className="pfx-promo__ic">{icon}</span>
        {beta
          ? <span className="dv-devtag dv-devtag--beta">Beta</span>
          : soon
          ? <span className="dv-devtag dv-devtag--soon">Coming soon</span>
          : figure
            ? <span className="pfx-promo__f"><b>{figure}</b><small>7-day APY</small></span>
            : null}
      </span>
      <span className="pfx-promo__t">{title}</span>
      <span className="pfx-promo__l">{line}</span>
      {cta && !soon && <span className="pfx-promo__cta">{cta} <span aria-hidden="true">&rarr;</span></span>}
    </>
  );
  return onClick
    ? <button type="button" className={`pfx-promo is-${tint}`} onClick={onClick}>{body}</button>
    : <div className={`pfx-promo is-${tint} is-off`} aria-disabled="true">{body}</div>;
}

const apy = (raw: string | undefined): string | null => {
  const v = Number(raw);
  return raw !== undefined && Number.isFinite(v) ? `${v.toFixed(2)}%` : null;
};

function Promos({ w, onOpenTab, onWealth, botsOpen }: { w: WealthState; onOpenTab: (t: Tab) => void; onWealth: () => void; botsOpen: boolean }) {
  const botsSoon = SOON_TABS.has('bots');
  return (
    <div className="pfx-promos">
      <Promo
        tint="copy"
        icon={<IconCopyTrade size={24} />}
        title="Copy trading"
        cta="Find traders"
        line="Mirror a trader's positions from your own account."
        onClick={() => onOpenTab('copy')}
      />
      <Promo
        tint="earn"
        icon={<CoinIcon coin="USDC" size={28} />}
        title="USDC Earn"
        cta="See vault"
        line="Variable yield on USDC, through a Morpho vault."
        figure={apy(w.quotes.get('Morpho-Earn')?.apy7d)}
        onClick={onWealth}
      />
      <Promo
        tint="cash"
        icon={<CoinIcon coin="BOXX" size={28} />}
        title="US Cash Yield"
        cta="See fund"
        line="Treasury-bill yield, on-chain, through BOXX."
        figure={apy(w.quotes.get('vBOXX')?.apy7d)}
        onClick={onWealth}
      />
      <Promo
        tint="bots"
        icon={<BotIcon strategy="grid" size={24} />}
        title="Bots"
        soon={botsSoon}
        beta={!botsOpen}
        cta={botsOpen ? 'Open bots' : 'Get access'}
        line="Market-making and grid strategies that run around the clock."
        onClick={botsSoon ? undefined : botsOpen ? () => onOpenTab('bots') : applyForBeta}
      />
    </div>
  );
}

// --- the fee strip ----------------------------------------------------------------------

const asRate = (d: { feeRate?: unknown } | null): VenueFeeRate | null => {
  const r = (d?.feeRate ?? d) as VenueFeeRate | undefined;
  return r && r.makerFeeRate !== undefined && r.takerFeeRate !== undefined ? r : null;
};

function FeeStrip({ c }: { c: PortfolioContext }) {
  const [open, setOpen] = useState(false);
  const mask = useMask('fees');
  const perps = useAsync(() => api.feeRate('perps', c.address!), [c.address], { enabled: !!c.address });
  const spot = useAsync(() => api.feeRate('spot', c.address!), [c.address], { enabled: !!c.address });
  const p = asRate(perps.data);
  const s = asRate(spot.data);
  const rates = (r: VenueFeeRate | null) => mask(r ? `${fmtRate(num(r.takerFeeRate))} / ${fmtRate(num(r.makerFeeRate))}` : DASH);
  return (
    <Card className="pfx-fees">
      <div className="pfx-fees__tier">
        <span><b>{mask(p ? String(p.feeTier) : DASH)}</b> <span className="pfx-fees__k">Fee tier</span></span>
        <button type="button" className="pfx-link" onClick={() => setOpen(true)}>View tiers <span aria-hidden="true">&#8599;</span></button>
      </div>
      <div className="pfx-fees__cell"><span className="bal-tag">Perps</span><span><span className="pfx-fees__k">Taker fee / Maker fee</span> <b>{rates(p)}</b></span></div>
      <div className="pfx-fees__cell"><span className="bal-tag">Spot</span><span><span className="pfx-fees__k">Taker fee / Maker fee</span> <b>{rates(s)}</b></span></div>
      <FeeSchedule open={open} onClose={() => setOpen(false)} engine="perps" address={c.address} />
    </Card>
  );
}

// --- the activity summary ---------------------------------------------------------------


const signedUsd = (v: number): string => `${v > 0 ? '+' : v < 0 ? MINUS : ''}${fmtUsd(Math.abs(v))}`;
const DAYS: Partial<Record<Period, number>> = { '24H': 1, '7D': 7, '14D': 14, '30D': 30 };

/** A window of the wallet's own SoDEX history, re-read while its walk runs and now and then afterwards. */
function useActivityWindow(engine: 'perps' | 'spot', address: string | null, range: Period): { window: ActivityWindow | null; error: string | null } {
  const [window, setWindow] = useState<ActivityWindow | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setWindow(null);
    setError(null);
    if (!address) return;
    let off = false;
    let timer = 0;
    const tick = async () => {
      let next = 30_000;
      try {
        const days = DAYS[range];
        const w = await activityWindow(address, engine, days === undefined ? null : Date.now() - days * 86_400_000);
        if (off) return;
        setWindow(w);
        setError(null);
        if (w.running) next = 2_000;
      } catch (e) {
        if (off) return;
        setError((e as Error).message);
      }
      timer = globalThis.setTimeout(tick, next) as unknown as number;
    };
    void tick();
    return () => { off = true; globalThis.clearTimeout(timer); };
  }, [engine, address, range]);
  return { window, error };
}

const shortDate = (ms: number): string => new Date(ms).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });

/** What a figure says until it is final. */
const NotFinal = ({ cover }: { cover: Cover | null }) => (
  cover?.state === 'incomplete' ? <span className="pfx-sum__state is-off">Incomplete</span> : <span className="pfx-sum__state">Reading</span>
);

/** One line on what the walk is doing, or why a figure is missing. */
function coverLine(what: string, cover: Cover | null): string | null {
  if (cover?.state === 'reading') {
    const back = cover.oldest === null ? '' : `, back to ${shortDate(cover.oldest)}`;
    return cover.rows === 0 ? `Reading your ${what} from SoDEX.` : `Reading your ${what} from SoDEX: ${fmt(cover.rows, 0)} so far${back}.`;
  }
  if (cover?.state === 'incomplete' && cover.reason === HELD_MESSAGE) return `Reading your ${what} is paused. Resume it from the History notification.`;
  if (cover?.state === 'incomplete') return `Your ${what} for this timeframe cannot be shown in full. ${cover.reason}`;
  return null;
}

function SumCell({ title, value, rows, tone }: { title: ReactNode; value: ReactNode; rows: Array<[string, ReactNode, string?]>; tone?: string }) {
  return (
    <div className="pfx-sum__cell">
      <div className="pfx-sum__head"><span>{title}</span><b className={tone}>{value}</b></div>
      {rows.map(([k, v, t]) => <div key={k} className="pfx-sum__row"><span>{k}</span><b className={t}>{v}</b></div>)}
    </div>
  );
}

function SummaryPanel({ c }: { c: PortfolioContext }) {
  const [engine, setEngine] = useStored<'perps' | 'spot'>('vs.pf.sum.engine', 'perps');
  const [range, setRange] = useStored<Period>('vs.pf.sum.range', '7D');
  const { window: w, error } = useActivityWindow(engine, c.address, range);
  const mask = useMask('funds');
  const maskPnl = useMask('pnl');
  const t = w?.trades ?? null;
  const f = w?.funding ?? null;
  const tradesPending = <NotFinal cover={w?.tradesCover ?? null} />;
  const fundingPending = <NotFinal cover={w?.fundingCover ?? null} />;
  const lines = [
    coverLine(`${engine} trades`, w?.tradesCover ?? null),
    engine === 'perps' ? coverLine('funding', w?.fundingCover ?? null) : null,
  ].filter((l): l is string => l !== null);
  const reading = w?.tradesCover.state === 'reading';
  const asOf = [w?.tradesCover, w?.fundingCover].reduce<number | null>((old, x) => (x?.state === 'final' && (old === null || x.asOf < old) ? x.asOf : old), null);
  const late = asOf !== null && Date.now() - asOf > 15 * 60_000;
  const card = (
    <Card
      className="pfx-sum"
      title="Summary"
      action={<ViewSeg value={range} options={RANGES} onChange={setRange} label="Timeframe" />}
    >
      {!c.address ? <NoWallet line="Connect a wallet to see your trading summary." compact />
        : error && !w ? <p className="pf-note">Could not read your trades. {error}</p>
        : (
          <>
            <div className="pfx-sum__grid">
              <SumCell
                title="Total no. of trades"
                value={t ? mask(fmt(t.trades, 0)) : tradesPending}
                rows={[['Buys', t ? mask(fmt(t.buys, 0)) : DASH], ['Sells', t ? mask(fmt(t.sells, 0)) : DASH]]}
              />
              <SumCell
                title="Total vol. of trades"
                value={t ? mask(fmtUsd(t.volume)) : tradesPending}
                rows={[['Buys', t ? mask(fmtUsd(t.buyVolume)) : DASH], ['Sells', t ? mask(fmtUsd(t.sellVolume)) : DASH]]}
              />
              {engine === 'perps' ? (
                <SumCell
                  title={<>Total funding fee <InfoDot title="As SoDEX books it: a minus is funding you paid, a plus is funding you received." /></>}
                  value={f ? maskPnl(signedUsd(f.total)) : fundingPending}
                  tone={f ? signClass(f.total) : undefined}
                  rows={[
                    ['Received', f ? maskPnl(signedUsd(f.received)) : DASH, f && f.received > 0 ? 'pos' : undefined],
                    ['Paid', f ? maskPnl(signedUsd(f.paid)) : DASH, f && f.paid < 0 ? 'neg' : undefined],
                    ['Latest funding fee', f && f.latest !== null ? maskPnl(signedUsd(f.latest)) : DASH, f && f.latest !== null ? signClass(f.latest) : undefined],
                  ]}
                />
              ) : (
                <SumCell title="Total funding fee" value={DASH} rows={[['Spot has no funding', '']]} />
              )}
              <SumCell
                title={<>Total commission <InfoDot title="The trading fees you paid, in dollars. Where SoDEX charged a fee in the coin you bought, it is valued at that fill's price." /></>}
                value={t ? mask(fmtUsd(t.commission)) : tradesPending}
                rows={[
                  ['Latest commission', t && t.latestCommission !== null ? mask(fmtUsd(t.latestCommission)) : DASH],
                  ...(t?.otherFees ?? []).map((o): [string, ReactNode] => [`Also paid in ${o.coin ?? 'an unnamed coin'}`, mask(fmt(o.amount, 6))]),
                ]}
              />
            </div>
            {lines.map((l) => <p key={l} className="pf-note pfx-sum__note">{l}</p>)}
            {reading && <p className="pf-note pfx-sum__note">SoDEX allows two pages of trades a minute, so a long history takes a while. It carries on from here next time.</p>}
            {late && asOf !== null && <p className="pf-note pfx-sum__note">As of {new Date(asOf).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}. SoDEX has not let us read newer rows yet.</p>}
          </>
        )}
    </Card>
  );
  return (
    <div className="dash pfx-plain">
      <PanelTabs
        tabs={[{ key: 'perps', label: 'Perps Summary', content: card }, { key: 'spot', label: 'Spot Summary', content: card }]}
        active={engine}
        onChange={(k) => setEngine(k as 'perps' | 'spot')}
      />
    </div>
  );
}

// --- the sections -----------------------------------------------------------------------

type Section = 'perps' | 'spot' | 'wealth' | 'copy' | 'bots';

function Activity({ children, line }: { children: ReactNode; line: string }) {
  return (
    <div className="pfx-activity">
      <p className="pfx-activity__line"><span className="bal-tag">Activity</span>{line}</p>
      {children}
    </div>
  );
}

function Sections({ c, w, provider, section, setSection, onOpenMarket, onOpenTab, onWealth }: {
  c: PortfolioContext;
  w: WealthState;
  provider: Eip1193Provider | null;
  section: Section;
  setSection: (s: Section) => void;
  onOpenMarket: (symbol: string, engine: 'spot' | 'perps') => void;
  onOpenTab: (t: Tab) => void;
  onWealth: () => void;
}) {
  const botsOpen = useBotsAccess(c.address);
  // The same element, with the same props, as the trade page's bottom band.
  const band = (engine: 'perps' | 'spot') => (
    <div className="dash pf-band" key={engine}>
      <AccountTabs
        engine={engine}
        address={c.address}
        unlocked={c.unlocked}
        readOnly={c.readOnly}
        byName={engine === 'perps' ? c.perpsByName : c.spotByName}
        refreshToken={c.refreshToken}
        onChanged={c.onChanged}
        symbolsFor={(e) => (e === 'perps' ? c.perpsByName : c.spotByName)}
      />
    </div>
  );
  const inCard = (body: ReactNode) => <Card className="pf-card--band pfx-band">{body}</Card>;
  const tabs: PanelTab[] = [
    { key: 'perps', label: 'Perps', content: inCard(band('perps')) },
    { key: 'spot', label: 'Spot', content: inCard(band('spot')) },
    { key: 'wealth', label: 'Wealth', content: inCard(<WealthHoldings w={w} address={c.address} onOpenMarket={onOpenMarket} onOpenWealth={onWealth} provider={provider} onDone={c.onChanged} />) },
    {
      key: 'copy',
      label: 'Copy trading',
      content: inCard(
        <Activity line="Copies trade from your Perps account. Their positions are in Perps. A copy's allocation is a size limit, not money set aside, so none of this adds to Total Value.">
          <MyCopiesCard />
        </Activity>,
      ),
    },
    {
      key: 'bots',
      label: 'Bots',
      content: inCard(
        <Activity line="Bots trade from your own Perps and Spot accounts, so what they hold is counted there.">
          <EmptyState
            icon="chart"
            title={!botsOpen ? 'Bots are in beta' : 'Your bots run from the Bots page'}
            line="Their volume, cost and PnL will show here, without a balance of their own."
            compact
            action={!botsOpen ? <button type="button" className="empty-state__cta" onClick={applyForBeta}>Get access</button> : <button type="button" className="empty-state__cta" onClick={() => onOpenTab('bots')}>Open bots</button>}
          />
        </Activity>,
      ),
    },
  ];
  return (
    <div className="dash pfx-plain pfx-sections">
      <PanelTabs tabs={tabs} active={section} onChange={(k) => setSection(k as Section)} />
    </div>
  );
}

// --- the page ---------------------------------------------------------------------------

export function PortfolioPage({ c, provider, onOpenMarket, onOpenTab }: { c: PortfolioContext } & PortfolioPageLinks) {
  const w = useWealth(c.address, c.refreshToken);
  const botsOpen = useBotsAccess(c.address);
  const { summary, evmRows, evmLoading } = useSummary(c, w);
  const vol = useVolume7d(c.address);
  const h24 = use24h(c);
  const [tab, setTab] = useStored<'trade' | 'wealth'>('vs.pf.tab', 'trade');
  const [section, setSection] = useStored<Section>('vs.pf.section', 'perps');
  const [swapOpen, setSwapOpen] = useState(false);

  const today = useMemo(() => {
    if (!h24 || h24.length < 2) return null;
    return pnlAt('pnl-total', h24[h24.length - 1]!) - pnlAt('pnl-total', h24[0]!);
  }, [h24]);

  const goSection = useCallback((s: Section) => {
    setSection(s);
    document.getElementById('pfx-sections')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [setSection]);
  const goWealth = useCallback(() => {
    setTab('wealth');
    document.querySelector('.appcontent')?.scrollTo({ top: 0, behavior: 'smooth' });
  }, [setTab]);

  // `?tab=` on the page deep-links the account band (AccountTabs): keep that band on screen.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).has('tab')) setTab('trade');
  }, [setTab]);

  const tabs: PanelTab[] = [
    {
      key: 'trade',
      label: 'Trade',
      content: (
        <div className="pfx-stack">
          <div className="pfx-top">
            <ValueCard c={c} s={summary} today={today} vol={vol} evmRows={evmRows} evmLoading={evmLoading} onSection={goSection} />
            <ChartCard c={c} h24={h24} />
          </div>
          <Promos w={w} onOpenTab={onOpenTab} onWealth={goWealth} botsOpen={botsOpen} />
          <FeeStrip c={c} />
          {!c.readOnly && <PortfolioMargin address={c.address} provider={provider} />}
          <SummaryPanel c={c} />
          <div id="pfx-sections">
            <Sections c={c} w={w} provider={provider} section={section} setSection={setSection} onOpenMarket={onOpenMarket} onOpenTab={onOpenTab} onWealth={goWealth} />
          </div>
        </div>
      ),
    },
    {
      key: 'wealth',
      label: 'Wealth',
      content: <WealthTab w={w} value={summary.wealth} slp={summary.slp} address={c.address} provider={provider} refreshToken={c.refreshToken} onOpenMarket={onOpenMarket} onDone={c.onChanged} />,
    },
  ];

  return (
    <div className="pf bots pfx">
      <h1 className="pfx-title">Portfolio</h1>
      <div className="dash pfx-tabs">
        <PanelTabs
          tabs={tabs}
          active={tab}
          onChange={(k) => setTab(k as 'trade' | 'wealth')}
          actions={!c.readOnly ? <MoneyButtons c={c} onSwap={() => setSwapOpen(true)} /> : undefined}
        />
      </div>
      <SwapSheet open={swapOpen} onClose={() => setSwapOpen(false)} address={c.address} unlocked={c.unlocked} onChanged={c.onChanged} />
    </div>
  );
}

