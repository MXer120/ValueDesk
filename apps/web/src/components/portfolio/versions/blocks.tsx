/**
 * The pieces the portfolio versions are built from (localhost only). Every control is the app's own: the Bots kit
 * (Segmented, Tabs, Button, StatusPill, SegmentedBar, ProgressBar, Skeleton, EmptyState, Sparkline), the account band
 * (AccountTabs, as on the trade page), the equity curve and PnL calendar (Portfolio.tsx), FeeSchedule, the swap and
 * Wealth sheets. Each version arranges them in its own way and gives them its own look in versions.css.
 */
import { Suspense, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Button, EmptyState, Icon, ProgressBar, Segmented, SegmentedBar, Skeleton, StatusPill, Tabs, type SegOption } from '../../bots/kit/kit';
import { AccountTabs } from '../../AccountTabs';
import { ReadFailed } from '../../AccountHistory';
import { CoinIcon } from '../../CoinIcon';
import { FeeSchedule } from '../../FeeSchedule';
import { ShareButton } from '../../share/host';
import { BotAvatar, BotIcon } from '../../bots/BotIcon';
import { StatePill } from '../../bots/BotsPage';
import { botName, botState, fmtPnl } from '../../bots/botWords';
import { IconCopyTrade } from '../../palette/icons';
import { SodexMark } from '../../funds/ui';
import { CrossFadeCal, fmtSigned, pnlAt, type Period, type PortfolioContext } from '../../Portfolio';
import { EquityCurve, fmtCompactUsd, type CurveWindow } from '../parts';
import { RANGES, atLevel, coverLine, curveFor, useActivityWindow, type ChartView } from '../PortfolioPage';
import { requestConnect, requestDeposit, requestTransfer, requestWithdraw } from '../../account/actions';
import { DepositIcon, TransferIcon, WithdrawIcon } from '../../account/moneyIcons';
import { DASH, MINUS, fmt, fmtUsd, num, signClass } from '../../../format';
import { fmtFixed } from '../../../numStyle';
import { fmtRate, type VenueFeeRate } from '../../../fees';
import { Private, useMask } from '../../../privacy';
import { SOON_TABS, type Tab } from '../../../router';
import { applyForBeta } from '../../../beta/access';
import { copyRows, getLiveCopy, readiness, subscribeLiveCopy, useLiveCopy } from '../../../copy/live';
import { useBots } from '../../../bots/useBots';
import { STRATEGY_INFO, strategyOf } from '../../../bots/presets';
import { goBots } from '../../../bots/routes';
import type { Eip1193Provider } from '../../../wallet';
import { lazyChunk } from '../../../lazyPage';
import type { ChartPoint } from '../../../performance';
import type { Bucket, PfData, Part } from './data';

const CopiesDialog = lazyChunk(() => import('../../copy/CopiesDialog'));

const cx = (...xs: Array<string | false | null | undefined>) => xs.filter(Boolean).join(' ');

// --- formatting -------------------------------------------------------------------------------------------------

export const signedUsd = (v: number | null | undefined): string => (v === null || v === undefined || !Number.isFinite(v) ? DASH : fmtSigned(v));
export const share = (r: number | null | undefined, dp = 1): string => (r === null || r === undefined || !Number.isFinite(r) ? DASH : `${fmtFixed(r * 100, dp)}%`);
export const tone = (v: number | null | undefined): string | undefined => (v === null || v === undefined || Math.abs(v) < 0.005 ? undefined : signClass(v));
export const apyOf = (raw: string | undefined): number | null => {
  const v = Number(raw);
  return raw !== undefined && raw !== '' && Number.isFinite(v) ? v : null;
};
export const shortAddr = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** The masks every money figure goes through (the app's privacy menu). */
export function useMasks() {
  return { equity: useMask('equity'), funds: useMask('funds'), pnl: useMask('pnl'), fees: useMask('fees'), address: useMask('address'), counts: useMask('counts') };
}

// --- head: identity and money actions ---------------------------------------------------------------------------

export function Identity({ c }: { c: PortfolioContext }) {
  const m = useMasks();
  if (!c.address) return <span className="pfv-id is-none">No wallet connected</span>;
  return (
    <span className="pfv-id">
      <i className="pfv-id__dot" aria-hidden="true" />
      <span className="pfv-id__a">{m.address(shortAddr(c.address))}</span>
      {c.venue.accountId !== null && <span className="pfv-id__n">SoDEX #{c.venue.accountId}</span>}
      {c.readOnly && <StatusPill size="sm" tone="neutral">View only</StatusPill>}
    </span>
  );
}

/** Deposit, Withdraw, Transfer and the USDT to USDC swap: the same four as today's page, in the kit's buttons. */
export function MoneyActions({ c, onSwap, size = 'sm', className }: { c: PortfolioContext; onSwap: () => void; size?: 'sm' | 'md'; className?: string }) {
  if (c.readOnly) return null;
  if (!c.address) return <div className={cx('pfv-acts', className)}><Button variant="primary" size={size} icon="wallet" onClick={requestConnect}>Connect wallet</Button></div>;
  const noAccount = c.model.account?.exists === false;
  return (
    <div className={cx('pfv-acts', className)}>
      <Button variant="primary" size={size} onClick={requestDeposit}>Deposit</Button>
      <Button variant="secondary" size={size} disabled={noAccount} onClick={() => requestWithdraw()}>Withdraw</Button>
      <Button variant="secondary" size={size} disabled={noAccount} onClick={() => requestTransfer()}>Transfer</Button>
      <Button variant="secondary" size={size} onClick={onSwap} title="Swap USDT to USDC" className="pfv-swapbtn">
        <span className="pfv-pair" aria-hidden="true"><CoinIcon coin="USDT" size={16} /><CoinIcon coin="USDC" size={16} /></span>Swap
      </Button>
    </div>
  );
}

/** The same four as round keys with a word under each (a wallet's layout). */
export function MoneyKeys({ c, onSwap }: { c: PortfolioContext; onSwap: () => void }) {
  if (c.readOnly) return null;
  const noAccount = c.model.account?.exists === false;
  const key = (label: string, icon: ReactNode, on: () => void, off = false, main = false) => (
    <button type="button" className={cx('pfv-key', main && 'is-main')} onClick={on} disabled={off}>
      <span className="pfv-key__c" aria-hidden="true">{icon}</span>
      <span className="pfv-key__t">{label}</span>
    </button>
  );
  if (!c.address) return <Button variant="primary" size="md" icon="wallet" className="pfv-keys__connect" onClick={requestConnect}>Connect wallet</Button>;
  return (
    <div className="pfv-keys">
      {/* The wallet menu's own icons (account/moneyIcons); Swap shows the two coins its sheet swaps. */}
      {key('Deposit', <DepositIcon size={18} />, requestDeposit, false, true)}
      {key('Withdraw', <WithdrawIcon size={18} />, () => requestWithdraw(), noAccount)}
      {key('Transfer', <TransferIcon size={18} />, () => requestTransfer(), noAccount)}
      {key('Swap', <span className="pfv-pair"><CoinIcon coin="USDT" size={16} /><CoinIcon coin="USDC" size={16} /></span>, onSwap)}
    </div>
  );
}

// --- where the money is -----------------------------------------------------------------------------------------

export function BucketIcon({ k, size = 18 }: { k: Bucket; size?: number }) {
  if (k === 'wealth') return <SodexMark size={size} />;
  if (k === 'evm') return <CoinIcon chain="VALUECHAIN" size={size} />;
  return <CoinIcon coin="USDC" size={size} />;
}

/** Total value split four ways: one bar (2px gaps), every part named with its figure and share beside it. */
export function AllocBar({ parts, size = 'md' }: { parts: Part[]; size?: 'sm' | 'md' | 'lg' }) {
  const shown = parts.filter((p) => p.usd !== null && p.usd > 0);
  const sum = shown.reduce((a, p) => a + p.usd!, 0);
  if (sum <= 0) return <span className={cx('pfv-allocbar is-empty', `is-${size}`)} aria-hidden="true" />;
  return (
    <Private k="charts">
      <SegmentedBar
        className="pfv-allocbar"
        size={size}
        max={sum}
        label="Where your money is"
        segments={shown.map((p) => ({ id: p.key, value: p.usd!, label: p.label, color: `var(--pfv-${p.key})` }))}
      />
    </Private>
  );
}

/**
 * The four accounts as rows. With `drawer`, a row opens a drawer under it with what that account holds: it slides open
 * and shut (owner 2026-11-26: "smooth when expanding retracting"). A drawer's content mounts on its first opening and
 * stays, so it can slide shut with its rows still in it; a shut drawer is inert.
 */
export function AllocLegend({ d, onPick, open, drawer }: {
  d: PfData;
  onPick?: (k: Bucket) => void;
  /** The account shown open. */
  open?: Bucket | null;
  drawer?: (k: Bucket) => ReactNode;
}) {
  const m = useMasks();
  const [seen, setSeen] = useState<ReadonlySet<Bucket>>(() => new Set(open ? [open] : []));
  if (open && !seen.has(open)) setSeen(new Set([...seen, open]));
  const value = (p: Part) => (p.usd === null ? (p.key === 'evm' && d.evmLoading ? <Skeleton className="pfv-skel-num" /> : DASH) : m.funds(fmtUsd(p.usd)));
  return (
    <ul className="pfv-legend">
      {d.parts.map((p) => {
        const isOpen = open === p.key;
        const body = (
          <>
            <i className={`pfv-dot is-${p.key}`} aria-hidden="true" />
            <span className="pfv-legend__t">
              <span className="pfv-legend__k">{p.label}</span>
              <small>{p.line}</small>
            </span>
            <span className="pfv-legend__v">
              <b>{value(p)}</b>
              {p.share !== null && <small>{share(p.share)}</small>}
            </span>
            {onPick && <span className={cx('pfv-legend__chev', isOpen && 'is-open')} aria-hidden="true"><Icon name="arrowRight" size={14} /></span>}
          </>
        );
        return (
          <li key={p.key} className={cx(isOpen && 'is-open')}>
            {onPick
              ? <button type="button" className="pfv-legend__row" aria-expanded={drawer ? isOpen : undefined} aria-controls={drawer ? `pfv-drawer-${p.key}` : undefined} onClick={() => onPick(p.key)}>{body}</button>
              : <div className="pfv-legend__row">{body}</div>}
            {drawer && (
              <div id={`pfv-drawer-${p.key}`} className={cx('pfv-drawer', isOpen && 'is-open')} {...(isOpen ? {} : { inert: '' })}>
                <div className="pfv-drawer__clip">{seen.has(p.key) && drawer(p.key)}</div>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** The way to everything a short list leaves out (owner 2026-11-26: "limit how many rows are visible ... go to element"). */
export function ViewAll({ label, onClick, dir = 'right' }: { label: string; onClick: () => void; dir?: 'right' | 'down' | 'up' }) {
  return (
    <button type="button" className={cx('pfv-all', `is-${dir}`)} onClick={onClick}>
      <span>{label}</span><Icon name="arrowRight" size={14} />
    </button>
  );
}

/** The wallet's coins on the EVM chains. No table of its own below, so the rows past `limit` open in place. */
export function EvmList({ d, limit }: { d: PfData; limit?: number }) {
  const m = useMasks();
  const [all, setAll] = useState(false);
  if (d.evmRows.length === 0) return <p className="pfv-quiet">{d.evmLoading ? 'Reading your wallet…' : 'Nothing on ValueChain or the other EVM chains.'}</p>;
  const cut = limit !== undefined && d.evmRows.length > limit;
  const rows = cut && !all ? d.evmRows.slice(0, limit) : d.evmRows;
  return (
    <>
      <ul className="pfv-coins">
        {rows.map((h) => (
          <li key={`${h.chain}:${h.symbol}`}>
            <span className="pfv-coins__ic"><CoinIcon coin={h.symbol} size={24} /><CoinIcon chain={h.chain} size={12} className="pfv-coins__chain" /></span>
            <span className="pfv-coins__t">{h.symbol}<small>{h.chainLabel}</small></span>
            <b>{m.funds(fmtUsd(h.usd))}</b>
          </li>
        ))}
      </ul>
      {cut && <ViewAll label={all ? 'Show fewer' : `Show all ${d.evmRows.length}`} dir={all ? 'up' : 'down'} onClick={() => setAll(!all)} />}
    </>
  );
}

/** The coins in Spot, the largest first; past `limit`, one way to the Spot table with all of them. */
export function SpotList({ d, limit, onAll }: { d: PfData; limit?: number; onAll?: () => void }) {
  const m = useMasks();
  if (!d.c.address) return null;
  if (!d.spotCoins) return <div className="pfv-skels">{[0, 1].map((i) => <Skeleton key={i} className="pfv-skel-row" />)}</div>;
  if (d.spotCoins.length === 0) return <p className="pfv-quiet">No coins in Spot.</p>;
  const rows = limit ? d.spotCoins.slice(0, limit) : d.spotCoins;
  return (
    <>
      <ul className="pfv-coins">
        {rows.map((x) => (
          <li key={x.coin}>
            <span className="pfv-coins__ic"><CoinIcon coin={x.coin} size={24} /></span>
            <span className="pfv-coins__t">{x.coin.replace(/^v(?=[A-Z])/, '')}<small>{m.funds(fmt(x.amount, x.amount >= 1000 ? 2 : 4))}</small></span>
            <b>{m.funds(x.usd === null ? DASH : fmtUsd(x.usd))}</b>
          </li>
        ))}
      </ul>
      {onAll && limit && d.spotCoins.length > limit && <ViewAll label={`View all ${d.spotCoins.length} coins`} onClick={onAll} />}
    </>
  );
}

// --- the chart --------------------------------------------------------------------------------------------------

const VIEW_OPTS: Array<SegOption<ChartView>> = [{ value: 'value', label: 'Value' }, { value: 'pnl', label: 'PnL' }, { value: 'calendar', label: 'Calendar' }];
export const RANGE_OPTS: Array<SegOption<Period>> = RANGES.map(([value, label]) => ({ value, label: value === 'ALL' ? 'All' : label }));

export function ViewSwitch({ value, onChange, size }: { value: ChartView; onChange: (v: ChartView) => void; size?: 'sm' | 'md' }) {
  return <Segmented options={VIEW_OPTS} value={value} onChange={onChange} label="Chart" size={size} />;
}
export function RangeSwitch({ value, onChange, size }: { value: Period; onChange: (v: Period) => void; size?: 'sm' | 'md' }) {
  return <Segmented options={RANGE_OPTS} value={value} onChange={onChange} label="Timeframe" size={size} />;
}

export function chartWin(c: PortfolioContext, h24: ChartPoint[] | null, view: ChartView, range: Period): CurveWindow | null {
  if (view === 'calendar') return null;
  return curveFor(c, h24, range, view === 'value' ? (p) => p.accountValue : (p) => pnlAt('pnl-total', p));
}

const rangeWord = (r: Period) => (r === 'ALL' ? 'all time' : r === '24H' ? 'last 24 hours' : `last ${r.slice(0, -1)} days`);

/** The figure over the chart: the change in the window, said in words, with its sign colour for PnL only. */
export function ChartFigure({ view, range, win, big }: { view: ChartView; range: Period; win: CurveWindow | null; big?: boolean }) {
  const mask = useMask(view === 'value' ? 'funds' : 'pnl');
  if (view === 'calendar' || !win || win.change === null) return null;
  const from = view === 'value' && win.baseline > 0 ? win.change / win.baseline : null;
  return (
    <div className={cx('pfv-cfig', big && 'is-big')}>
      <span className="pfv-cfig__k">{view === 'value' ? 'Change in value' : 'PnL'}, {rangeWord(range)}</span>
      <span className="pfv-cfig__v">
        <b className={view === 'pnl' ? tone(win.change) : undefined}>{mask(fmtSigned(win.change))}</b>
        {from !== null && Number.isFinite(from) && <small className={tone(win.change)}>{mask(`${from > 0 ? '+' : from < 0 ? MINUS : ''}${fmtFixed(Math.abs(from) * 100, 2)}%`)}</small>}
        {win.maxDrawdown !== null && win.maxDrawdown < -0.005 && view === 'pnl' && <small className="pfv-cfig__dd">Max drawdown {mask(fmtUsd(win.maxDrawdown))}</small>}
      </span>
    </div>
  );
}

/** The chart itself, or the reason it is not there. Height comes from the version's CSS. */
export function ChartBody({ c, view, range, win }: { c: PortfolioContext; view: ChartView; range: Period; win: CurveWindow | null }) {
  const quiet = (body: ReactNode) => <div className="pfv-chart__none">{body}</div>;
  return (
    <div className={cx('pfv-chart', view === 'calendar' && 'is-cal')}>
      {!c.address ? quiet(<EmptyState icon="chart" title="Your chart starts here" description="Connect a wallet to see its value and PnL over time." actions={<Button variant="secondary" icon="wallet" onClick={requestConnect}>Connect wallet</Button>} />)
        : c.venue.error ? quiet(<ReadFailed what="Account history" error={c.venue.error} />)
        : c.venue.progress ? <Skeleton className="pfv-chart__skel" />
        : !c.venue.accountId ? quiet(<EmptyState icon="chart" title="No SoDEX account yet" description="Deposit once and SoDEX starts this wallet's history." />)
        : view === 'calendar' ? <CrossFadeCal points={c.venue.points ?? []} mode="pnl-total" />
        : win ? <EquityCurve win={view === 'value' ? atLevel(win) : win} tone={view === 'value' ? 'equity' : 'pnl'} level={view === 'value'} compactAxis clean privacy={view === 'value' ? 'funds' : 'pnl'} />
        : quiet(<p className="pfv-quiet">Fewer than two points in the {rangeWord(range)}.</p>)}
    </div>
  );
}

/** The PnL card to share for the window shown (SoDEX's own series), whichever view is open. */
export function SharePnl({ c, h24, range }: { c: PortfolioContext; h24: ChartPoint[] | null; range: Period }) {
  if (!c.address || !c.venue.points) return null;
  return (
    <ShareButton
      label="Share this PnL"
      make={(b) => {
        const pw = curveFor(c, h24, range, (p) => pnlAt('pnl-total', p));
        if (!pw || pw.change === null) return null;
        const value = c.model.account?.accountValue;
        return b.portfolioCard({ range, change: pw.change, ys: pw.points.map((p) => p.v), trades: null, volume: null, value: typeof value === 'number' && Number.isFinite(value) ? value : null, wallet: c.address });
      }}
    />
  );
}

// --- the Perps account ------------------------------------------------------------------------------------------

export interface Health {
  available: number | null;
  withdrawable: number | null;
  inUse: number | null;
  usedShare: number | null;
  ratio: number | null;
  unrealized: number | null;
  positions: number;
  orders: number;
  ordersUsd: number | null;
  leverage: number | null;
  long: number | null;
  short: number | null;
}

/** SoDEX's own account state, decoded by Portfolio.tsx; nothing is computed here but sums and one ratio. */
export function health(c: PortfolioContext): Health {
  // No wallet, nothing known (the shared feed can still hold the last wallet's read).
  const a = c.address ? c.model.account : null;
  const inUse = a ? a.crossMargin + a.isolatedMargin + a.orderMargin : null;
  return {
    available: a ? a.availableMargin : null,
    withdrawable: a ? a.withdrawable : null,
    inUse,
    usedShare: a && inUse !== null && a.accountValue > 0 ? Math.min(1, inUse / a.accountValue) : null,
    ratio: a ? a.maintenanceRatio : null,
    unrealized: a ? c.model.unrealized : null,
    positions: a ? c.model.positions.length : 0,
    orders: a ? c.model.orders?.count ?? 0 : 0,
    ordersUsd: a && c.model.orders ? c.model.orders.notional : null,
    leverage: a ? c.model.exposure?.grossLeverage ?? null : null,
    long: a ? c.model.exposure?.long ?? null : null,
    short: a ? c.model.exposure?.short ?? null : null,
  };
}

export function Fig({ k, v, sub, cls, hint }: { k: ReactNode; v: ReactNode; sub?: ReactNode; cls?: string; hint?: string }) {
  return (
    <div className="pfv-fig" title={hint}>
      <span className="pfv-fig__k">{k}</span>
      <b className={cx('pfv-fig__v', cls)}>{v}</b>
      {sub !== undefined && <span className="pfv-fig__s">{sub}</span>}
    </div>
  );
}

/** Margin used, as a bar: the share of account value held by positions and resting orders. */
export function MarginMeter({ h }: { h: Health }) {
  const m = useMasks();
  if (h.usedShare === null) return null;
  const t = h.usedShare > 0.8 ? 'negative' : h.usedShare > 0.5 ? 'warning' : 'neutral';
  return (
    <div className="pfv-meter">
      <div className="pfv-meter__row"><span>Margin in use</span><b>{m.funds(share(h.usedShare))}</b></div>
      <ProgressBar value={h.usedShare} max={1} size="sm" tone={t} kind="meter" label="Margin in use" />
    </div>
  );
}

/** Open positions by market: notional, side and share of the book (the top few). */
export function Exposure({ c, limit = 4, onAll }: { c: PortfolioContext; limit?: number; onAll?: () => void }) {
  const m = useMasks();
  const ex = c.model.exposure;
  if (!c.address) return null;
  if (c.model.loading && !ex) return <div className="pfv-skels">{[0, 1, 2].map((i) => <Skeleton key={i} className="pfv-skel-row" />)}</div>;
  if (!ex || ex.byMarket.length === 0) return <p className="pfv-quiet">No open positions.</p>;
  const longShare = ex.gross > 0 ? ex.long / ex.gross : 0;
  return (
    <div className="pfv-expo">
      <div className="pfv-expo__ls">
        <div className="pfv-expo__lsrow"><span className="pos">Long {m.funds(fmtCompactUsd(ex.long))}</span><span className="neg">Short {m.funds(fmtCompactUsd(ex.short))}</span></div>
        <Private k="positions">
          <SegmentedBar size="sm" max={1} label="Long and short" segments={[{ id: 'l', value: longShare, label: 'Long', color: 'var(--pos)' }, { id: 's', value: 1 - longShare, label: 'Short', color: 'var(--neg)' }]} />
        </Private>
      </div>
      <ul className="pfv-expo__list">
        {ex.byMarket.slice(0, limit).map((x) => (
          <li key={x.symbol}>
            <span className="pfv-expo__m"><CoinIcon coin={x.symbol} size={18} />{x.symbol.replace(/-USD$/, '')}</span>
            {x.dir && <StatusPill size="sm" tone={x.dir === 'long' ? 'positive' : 'negative'}>{x.dir === 'long' ? 'Long' : 'Short'}</StatusPill>}
            <span className="pfv-expo__bar"><i style={{ width: `${Math.max(2, x.share * 100)}%` }} /></span>
            <b>{m.funds(fmtCompactUsd(x.notional))}</b>
          </li>
        ))}
      </ul>
      {onAll && ex.byMarket.length > limit && <ViewAll label={`View all ${ex.byMarket.length} positions`} onClick={onAll} />}
    </div>
  );
}

// --- trading summary --------------------------------------------------------------------------------------------

function Split({ a, b, la, lb, show }: { a: number; b: number; la: string; lb: string; show: (v: number) => ReactNode }) {
  const sum = a + b;
  return (
    <div className="pfv-split">
      <SegmentedBar size="sm" max={1} label={`${la} and ${lb}`} segments={sum > 0 ? [{ id: 'a', value: a / sum, label: la, color: 'var(--pos)' }, { id: 'b', value: b / sum, label: lb, color: 'var(--neg)' }] : []} />
      <div className="pfv-split__t"><span><i className="is-a" />{la} <b>{show(a)}</b></span><span><i className="is-b" />{lb} <b>{show(b)}</b></span></div>
    </div>
  );
}

/** Trades, volume, funding and fees over a window, from the wallet's own SoDEX history (exchange/allTime.ts). */
export function TradeSummary({ c, engine, range, layout = 'grid' }: { c: PortfolioContext; engine: 'perps' | 'spot'; range: Period; layout?: 'grid' | 'list' }) {
  const { window: w, error } = useActivityWindow(engine, c.address, range);
  const m = useMasks();
  if (!c.address) return <EmptyState compact icon="chart" title="No wallet connected" description="Your trades, volume, funding and fees show here." />;
  if (error && !w) return <EmptyState compact tone="error" icon="warning" title="Could not read your trades" description={error} />;
  const t = w?.trades ?? null;
  const f = w?.funding ?? null;
  const wait = (state: 'reading' | 'incomplete' | 'final' | undefined) => (state === 'incomplete' ? <StatusPill size="sm" tone="warning">Incomplete</StatusPill> : <Skeleton className="pfv-skel-num" />);
  // While a walk is still reading, the figures say so themselves (a placeholder); only a window that cannot be shown in
  // full gets a line (owner 2026-11-26: no "Reading your perps trades from SoDEX." on the page).
  const note = (what: string, cover: Parameters<typeof coverLine>[1]) => (cover?.state === 'reading' ? null : coverLine(what, cover));
  const lines = [note(`${engine} trades`, w?.tradesCover ?? null), engine === 'perps' ? note('funding', w?.fundingCover ?? null) : null].filter((l): l is string => l !== null);
  return (
    <div className={cx('pfv-sum', `is-${layout}`)}>
      <div className="pfv-sum__cell">
        <span className="pfv-sum__k">Trades</span>
        <b className="pfv-sum__v">{t ? m.counts(fmt(t.trades, 0)) : wait(w?.tradesCover.state)}</b>
        {t && <Split a={t.buys} b={t.sells} la="Buys" lb="Sells" show={(v) => m.counts(fmt(v, 0))} />}
      </div>
      <div className="pfv-sum__cell">
        <span className="pfv-sum__k">Volume</span>
        <b className="pfv-sum__v">{t ? m.funds(fmtUsd(t.volume)) : wait(w?.tradesCover.state)}</b>
        {t && <Split a={t.buyVolume} b={t.sellVolume} la="Bought" lb="Sold" show={(v) => m.funds(fmtCompactUsd(v))} />}
      </div>
      <div className="pfv-sum__cell">
        <span className="pfv-sum__k" title="As SoDEX books it: a minus is funding you paid, a plus is funding you received.">Funding</span>
        {engine === 'spot'
          ? <><b className="pfv-sum__v is-dim">{DASH}</b><span className="pfv-sum__s">Spot has no funding</span></>
          : (
            <>
              <b className={cx('pfv-sum__v', f ? tone(f.total) : undefined)}>{f ? m.pnl(signedUsd(f.total)) : wait(w?.fundingCover?.state)}</b>
              {f && <span className="pfv-sum__s"><span className={tone(f.received)}>{m.pnl(signedUsd(f.received))}</span> received · <span className={tone(f.paid)}>{m.pnl(signedUsd(f.paid))}</span> paid</span>}
            </>
          )}
      </div>
      <div className="pfv-sum__cell">
        <span className="pfv-sum__k" title="The trading fees you paid, in dollars. Where SoDEX charged a fee in the coin you bought, it is valued at that fill's price.">Fees paid</span>
        <b className="pfv-sum__v">{t ? m.fees(fmtUsd(t.commission)) : wait(w?.tradesCover.state)}</b>
        {t && <span className="pfv-sum__s">Latest {m.fees(t.latestCommission === null ? DASH : fmtUsd(t.latestCommission))}{t.otherFees.map((o) => ` · ${fmt(o.amount, 6)} ${o.coin ?? '?'}`).join('')}</span>}
      </div>
      {lines.length > 0 && <p className="pfv-sum__note">{lines.join(' ')}</p>}
    </div>
  );
}

const ENGINES: Array<SegOption<'perps' | 'spot'>> = [{ value: 'perps', label: 'Perps' }, { value: 'spot', label: 'Spot' }];
export function EngineSwitch({ value, onChange }: { value: 'perps' | 'spot'; onChange: (v: 'perps' | 'spot') => void }) {
  return <Segmented options={ENGINES} value={value} onChange={onChange} label="Market" />;
}

// --- fees -------------------------------------------------------------------------------------------------------

export function FeeRates({ c, fees, layout = 'rows' }: { c: PortfolioContext; fees: { perps: VenueFeeRate | null; spot: VenueFeeRate | null }; layout?: 'rows' | 'inline' }) {
  const [open, setOpen] = useState(false);
  const m = useMasks();
  const rate = (r: VenueFeeRate | null, k: 'takerFeeRate' | 'makerFeeRate') => m.fees(r ? fmtRate(num(r[k])) : DASH);
  return (
    <div className={cx('pfv-fees', `is-${layout}`)}>
      <div className="pfv-fees__tier">
        <span className="pfv-fees__k">Fee tier</span>
        <b>{m.fees(fees.perps ? String(fees.perps.feeTier) : DASH)}</b>
        <Button variant="quiet" size="sm" onClick={() => setOpen(true)}>View tiers</Button>
      </div>
      <table className="pfv-fees__t">
        <thead><tr><th scope="col"><span className="tf-sr">Market</span></th><th scope="col">Taker</th><th scope="col">Maker</th></tr></thead>
        <tbody>
          <tr><th scope="row">Perps</th><td>{rate(fees.perps, 'takerFeeRate')}</td><td>{rate(fees.perps, 'makerFeeRate')}</td></tr>
          <tr><th scope="row">Spot</th><td>{rate(fees.spot, 'takerFeeRate')}</td><td>{rate(fees.spot, 'makerFeeRate')}</td></tr>
        </tbody>
      </table>
      <FeeSchedule open={open} onClose={() => setOpen(false)} engine="perps" address={c.address} />
    </div>
  );
}

// --- copies, earn, bots -----------------------------------------------------------------------------------------

export function useCopies() {
  const live = useSyncExternalStore(subscribeLiveCopy, getLiveCopy, getLiveCopy);
  const rows = copyRows(live);
  const running = rows.filter((r) => r.view.subscription.status !== 'stopped');
  const real = running.filter((r) => !r.view.subscription.settings.paper);
  return {
    all: rows.length,
    live: real.length,
    paper: running.length - real.length,
    allocated: real.reduce((a, r) => a + r.view.subscription.settings.allocationUsd, 0),
    pnl: real.reduce((a, r) => a + r.view.pnl, 0),
  };
}

export function ManageCopies({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return <Suspense fallback={null}><CopiesDialog open={open} onClose={onClose} /></Suspense>;
}

export interface Offer {
  key: 'earn' | 'cash' | 'copy' | 'bots';
  icon: ReactNode;
  title: string;
  line: string;
  /** SoDEX's 7-day APY, as SoDEX publishes it. */
  apy: number | null;
  /** What this wallet has in it, when the app reads that. */
  mine: ReactNode | null;
  cta: string | null;
  pill: ReactNode | null;
  onClick: (() => void) | null;
}

/** The four ways to put money to work: the same four as today's tiles, each with what this wallet has in it. */
export function useOffers(d: PfData, onWealth: () => void, onOpenTab: (t: Tab) => void, onCopies: () => void): Offer[] {
  const m = useMasks();
  const copies = useCopies();
  const held = (fund: RegExp) => d.w.holdings?.filter((h) => fund.test(h.coin) || fund.test(h.fundId)).reduce((a, h) => a + (h.marketValue ?? 0) + h.inFlight, 0) ?? 0;
  const earnHeld = held(/soUSDC|Morpho/i);
  const cashHeld = held(/BOXX/i);
  const botsSoon = SOON_TABS.has('bots');
  return [
    {
      key: 'earn', icon: <CoinIcon coin="USDC" size={22} />, title: 'USDC Earn', line: 'Variable yield on USDC, through a Morpho vault.',
      apy: apyOf(d.w.quotes.get('Morpho-Earn')?.apy7d), mine: earnHeld > 0.005 ? m.funds(fmtUsd(earnHeld)) : null, cta: 'See vault', pill: null, onClick: onWealth,
    },
    {
      key: 'cash', icon: <CoinIcon coin="BOXX" size={22} />, title: 'US Cash Yield', line: 'Treasury-bill yield, on-chain, through BOXX.',
      apy: apyOf(d.w.quotes.get('vBOXX')?.apy7d), mine: cashHeld > 0.005 ? m.funds(fmtUsd(cashHeld)) : null, cta: 'See fund', pill: null, onClick: onWealth,
    },
    {
      key: 'copy', icon: <IconCopyTrade size={20} />, title: 'Copy trading', line: "Mirror a trader's positions from your own account.",
      apy: null,
      mine: copies.live > 0 ? <>{m.counts(fmt(copies.live, 0))} live · <span className={tone(copies.pnl)}>{m.pnl(signedUsd(copies.pnl))}</span></> : null,
      cta: copies.all > 0 ? 'Manage copies' : 'Find traders', pill: null, onClick: copies.all > 0 ? onCopies : () => onOpenTab('copy'),
    },
    {
      key: 'bots', icon: <BotIcon strategy="grid" size={20} />, title: 'Bots', line: 'Market-making and grid strategies that run around the clock.',
      apy: null, mine: null,
      cta: botsSoon ? null : d.botsOpen ? 'Open bots' : 'Get access',
      pill: botsSoon ? <StatusPill size="sm">Coming soon</StatusPill> : !d.botsOpen ? <StatusPill size="sm" tone="brand">Beta</StatusPill> : null,
      onClick: botsSoon ? null : d.botsOpen ? () => onOpenTab('bots') : applyForBeta,
    },
  ];
}

export function ApyFig({ apy }: { apy: number | null }) {
  if (apy === null) return null;
  return <span className="pfv-apy"><b>{fmtFixed(apy, 2)}%</b><small>7-day APY</small></span>;
}

// --- the account band -------------------------------------------------------------------------------------------

export type Section = 'perps' | 'spot' | 'wealth' | 'copy' | 'bots';
const SECTION_TABS: Array<SegOption<Section>> = [
  { value: 'perps', label: 'Perps' }, { value: 'spot', label: 'Spot' }, { value: 'wealth', label: 'Wealth' }, { value: 'copy', label: 'Copy trading' }, { value: 'bots', label: 'Bots' },
];

/** The trade page's account tables, untouched, for one engine. `select` switches to one of its tabs (a "View all"). */
export function Band({ c, engine, select }: { c: PortfolioContext; engine: 'perps' | 'spot'; select?: { key: string; n: number } | null }) {
  return (
    <div className="dash pf-band pfv-band__tables" key={engine}>
      <AccountTabs
        select={select}
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
}

export function SectionTabs({ value, onChange }: { value: Section; onChange: (s: Section) => void }) {
  return <Tabs tabs={SECTION_TABS} value={value} onChange={onChange} label="Accounts" className="pfv-sectabs" />;
}

export function CopiesPanel({ onOpenTab }: { onOpenTab: (t: Tab) => void }) {
  const copies = useCopies();
  const m = useMasks();
  const [manage, setManage] = useState(false);
  if (copies.all === 0) {
    return (
      <div className="pfv-empty">
        <EmptyState
          icon="layers"
          title="No copies yet"
          description="Mirror a trader's positions from your own Perps account, at the size you set."
          actions={<Button variant="primary" icon="search" onClick={() => onOpenTab('copy')}>Find traders to copy</Button>}
        />
      </div>
    );
  }
  return (
    <div className="pfv-copies">
      <div className="pfv-copies__figs">
        <Fig k="Traders copied" v={copies.live ? m.counts(fmt(copies.live, 0)) : DASH} sub={copies.paper ? `${copies.paper} paper as well` : 'Live copies'} />
        <Fig k="Allocated" v={copies.live ? m.funds(fmtUsd(copies.allocated, 0)) : DASH} sub="A size limit, not money set aside" />
        <Fig k="Copy PnL" v={copies.live ? m.pnl(signedUsd(copies.pnl)) : DASH} cls={copies.live ? tone(copies.pnl) : undefined} sub="Each copy's own books" />
      </div>
      <div className="pfv-row-acts">
        <Button variant="secondary" onClick={() => setManage(true)}>Manage copies</Button>
        <Button variant="quiet" icon="search" onClick={() => onOpenTab('copy')}>Find traders to copy</Button>
      </div>
      <ManageCopies open={manage} onClose={() => setManage(false)} />
    </div>
  );
}

/**
 * The wallet's bots as a list, each with its state, volume and net PnL as the Bots page counts them (useBots, the
 * executor's own read; owner 2026-11-26: "show list on portfolio too, same for bots"). A row opens that bot. With no
 * bot, or before bots are open to this wallet, a centred empty state with the one action.
 */
export function BotsPanel({ c, provider, botsOpen, onOpenTab }: { c: PortfolioContext; provider: Eip1193Provider | null; botsOpen: boolean; onOpenTab: (t: Tab) => void }) {
  const m = useMasks();
  const owner = c.readOnly ? null : c.address;
  const live = useLiveCopy(owner, provider);
  const signedIn = owner !== null && readiness(live, 'hosted').connected;
  const { bots, loading } = useBots(owner, signedIn);
  const shown = useMemo(() => [...bots].sort((a, b) => (b.algo.startedAt ?? b.algo.createdAt) - (a.algo.startedAt ?? a.algo.createdAt)), [bots]);
  const empty = (title: string, line: string, action: ReactNode) => (
    <div className="pfv-empty"><EmptyState icon="robot" title={title} description={line} actions={action} /></div>
  );
  if (!botsOpen) return empty('Bots are in beta', 'Market-making and grid strategies that run around the clock from your own accounts.', <Button variant="primary" onClick={applyForBeta}>Get access</Button>);
  if (signedIn && loading && !bots.length) return <div className="pfv-skels">{[0, 1, 2].map((i) => <Skeleton key={i} className="pfv-skel-row" />)}</div>;
  if (!shown.length) {
    return empty(
      'No bots yet',
      signedIn || !owner ? 'Market-making and grid strategies that run around the clock from your own accounts.' : 'Sign in on the Bots page to see your bots here.',
      <Button variant="primary" icon="robot" onClick={() => onOpenTab('bots')}>Open bots</Button>,
    );
  }
  return (
    <div className="pfv-bots">
      <ul className="pfv-botlist">
        {shown.map((v) => {
          const st = strategyOf(v.algo.spec) ?? 'maker';
          const b = v.bot;
          return (
            <li key={v.algo.id}>
              <button type="button" onClick={() => goBots({ page: 'bot', id: v.algo.id })}>
                <BotAvatar symbol={v.algo.spec.symbol} strategy={st} size={30} />
                <span className="pfv-botlist__t">
                  <b>{botName(v)}</b>
                  <small>{STRATEGY_INFO[st].name} · {v.algo.spec.paper ? 'practice' : 'real orders'}</small>
                </span>
                <StatePill s={botState(v)} size="sm" />
                <span className="pfv-botlist__f"><small>Volume</small><b>{m.funds(b ? fmtUsd(b.volume, 0) : DASH)}</b></span>
                <span className="pfv-botlist__f"><small>Net PnL</small><b className={b ? tone(b.netPnl) : undefined}>{m.pnl(fmtPnl(b?.netPnl))}</b></span>
                <Icon name="arrowRight" size={14} />
              </button>
            </li>
          );
        })}
      </ul>
      <div className="pfv-row-acts"><Button variant="secondary" onClick={() => onOpenTab('bots')}>Open bots</Button></div>
    </div>
  );
}

const InfoIcon = () => (
  <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M8 7.2v3.6M8 5.1v.01" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
);

/** Copies and bots hold nothing of their own: what they trade is counted in Perps and Spot. A blue note, not a figure. */
export function AllocationNote() {
  return (
    <span className="pfv-allocnote" title="Copies and bots trade from your Perps and Spot accounts, so what they hold is counted there.">
      <InfoIcon />Allocation: No balance of its own
    </span>
  );
}

export { SECTION_TABS };
