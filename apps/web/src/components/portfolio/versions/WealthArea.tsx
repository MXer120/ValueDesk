/**
 * The Wealth part of the portfolio versions (localhost only): everything today's Wealth tab shows (WealthTab.tsx), in
 * the kit's look. What the wallet holds and how it did (SoDEX's /wealth/users/{a}/pnl), its value over time
 * (/pnl-history), requests in progress, history and recurring buys (the ledger), and every fund on offer with SoDEX's
 * own live returns. A missing figure is a dash. Invest and Redeem open the same sheet as today (WealthSheet.tsx).
 */
import { useMemo, useState, type ReactNode } from 'react';
import { Button, EmptyState, Panel, Segmented, Shell, ShellHeader, Skeleton, StatusPill, Tabs, type SegOption } from '../../bots/kit/kit';
import { ReadFailed } from '../../AccountHistory';
import { CoinIcon } from '../../CoinIcon';
import { EquityCurve, type CurveWindow } from '../parts';
import { useAsync } from '../../../hooks';
import { DASH, MINUS, fmt, fmtUsd, num } from '../../../format';
import { fmtFixed } from '../../../numStyle';
import {
  fundAction, fundLabel, readPnlHistory, sodexFundUrl,
  type FundAction, type FundShelf, type JoinedHolding, type PnlRange, type WealthEntry, type WealthFund,
} from '../../../trading/wealth';
import { useLedger, useTradingStatuses, type WealthState } from '../useWealth';
import { WealthSheet, type WealthSheetTarget } from '../WealthSheet';
import type { Eip1193Provider } from '../../../wallet';
import { requestConnect } from '../../account/actions';
import { Fig, signedUsd, tone, useMasks } from './blocks';

const cx = (...xs: Array<string | false | null | undefined>) => xs.filter(Boolean).join(' ');

const fundIcon = (coin: string): string => (/^v?soUSDC$/i.test(coin) ? 'USDC' : coin);
const pctNode = (raw: string | undefined): ReactNode => {
  if (raw === undefined || raw === '') return DASH;
  const v = Number(raw);
  if (!Number.isFinite(v)) return DASH;
  return <span className={tone(v)}>{v > 0 ? '+' : v < 0 ? MINUS : ''}{fmtFixed(Math.abs(v), 2)}%</span>;
};
const dayTime = (at: string | number | undefined): string => {
  if (at === undefined) return DASH;
  const d = new Date(typeof at === 'number' && at < 1e12 ? at * 1000 : at);
  return Number.isNaN(d.getTime()) ? DASH : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
};
const held = (h: JoinedHolding): string[] => [
  ...(h.spotShares > 0 ? ['Spot'] : []),
  ...(h.perpShares > 0 ? ['Perps margin'] : []),
  ...(h.evmShares > 0 ? ['Wallet'] : []),
  ...(h.source === 'bridge' ? ['Bridged'] : []),
];

export interface WealthProps {
  w: WealthState;
  value: number | null;
  slp: number | null;
  address: string | null;
  provider: Eip1193Provider | null;
  refreshToken: number;
  onOpenMarket: (symbol: string, engine: 'spot') => void;
  onDone: () => void;
  readOnly?: boolean;
}

// --- what the wallet holds ----------------------------------------------------------------------------------------

export function WealthFigures({ w, value, slp, layout = 'row' }: { w: WealthState; value: number | null; slp: number | null; layout?: 'row' | 'hero' }) {
  const m = useMasks();
  const p = w.pnl;
  const usd = (v: string | undefined, signed = true) => (v === undefined || v === '' ? DASH : m.pnl(signed ? signedUsd(num(v)) : fmtUsd(num(v))));
  const t = (v: string | undefined) => (v === undefined || v === '' ? undefined : tone(num(v)));
  return (
    <div className={cx('pfv-wfig', `is-${layout}`)}>
      <div className="pfv-wfig__main">
        <span className="pfv-wfig__k">Wealth value</span>
        <b className="pfv-wfig__v">{m.equity(value === null ? DASH : fmtUsd(value))}</b>
        <span className="pfv-wfig__s">24h <b className={t(p?.totalPnl24h)}>{usd(p?.totalPnl24h)}</b></span>
      </div>
      <div className="pfv-wfig__grid">
        <Fig k="Total PnL" v={usd(p?.totalPnl)} cls={t(p?.totalPnl)} />
        <Fig k="Realized" v={usd(p?.totalRealizedPnl)} cls={t(p?.totalRealizedPnl)} />
        <Fig k="Unrealized" v={usd(p?.totalUnrealizedPnl)} cls={t(p?.totalUnrealizedPnl)} />
        <Fig k="Cost" v={usd(p?.totalCost, false)} />
        <Fig k="In progress" v={usd(p?.inFlightValue, false)} />
        {slp !== null && <Fig k="SLP vault, inferred" v={m.pnl(fmtUsd(slp))} hint="MAG7.ssi or sMAG7.ssi deposited into the liquidity vault. SoDEX reports no position for it, so it is SoDEX's account-value series minus what the series is known to hold." />}
      </div>
      {p?.complete === false && <p className="pfv-quiet">SoDEX could not price every fund, so these figures leave those out.</p>}
    </div>
  );
}

const W_RANGES: Array<SegOption<PnlRange>> = [{ value: '1W', label: '7d' }, { value: '1M', label: '30d' }, { value: '3M', label: '90d' }, { value: '1Y', label: '1y' }, { value: 'All', label: 'All' }];
const W_VIEWS: Array<SegOption<'value' | 'pnl'>> = [{ value: 'value', label: 'Value' }, { value: 'pnl', label: 'PnL' }];

export function WealthChart({ address }: { address: string | null }) {
  const [range, setRange] = useState<PnlRange>('1M');
  const [view, setView] = useState<'value' | 'pnl'>('value');
  const m = useMasks();
  const history = useAsync(() => readPnlHistory(address!, range), [address, range], { enabled: !!address });
  const win = useMemo((): CurveWindow | null => {
    const pts = (history.data ?? [])
      .map((p) => ({ t: typeof p.ts === 'number' ? (p.ts < 1e12 ? p.ts * 1000 : p.ts) : Date.parse(p.ts), v: num(view === 'value' ? p.totalValue : p.pnl) }))
      .filter((p) => Number.isFinite(p.t));
    if (pts.length < 2) return null;
    const first = pts[0]!.v;
    const shown = view === 'value' ? pts : pts.map((p) => ({ t: p.t, v: p.v - first }));
    return { points: shown, baseline: first, change: pts[pts.length - 1]!.v - first, maxDrawdown: null };
  }, [history.data, view]);
  const mask = view === 'value' ? m.funds : m.pnl;
  return (
    <div className="pfv-wchart">
      <div className="pfv-wchart__head">
        <div className="pfv-cfig">
          <span className="pfv-cfig__k">{view === 'value' ? 'Change in value' : 'Change in PnL'}, {W_RANGES.find((r) => r.value === range)?.label}</span>
          <span className="pfv-cfig__v"><b className={view === 'pnl' && win?.change != null ? tone(win.change) : undefined}>{win?.change != null ? mask(signedUsd(win.change)) : DASH}</b></span>
        </div>
        <div className="pfv-ctl">
          <Segmented options={W_VIEWS} value={view} onChange={setView} label="Wealth chart" />
          <Segmented options={W_RANGES} value={range} onChange={setRange} label="Timeframe" />
        </div>
      </div>
      <div className="pfv-chart">
        {!address ? <div className="pfv-chart__none"><p className="pfv-quiet">Connect a wallet to chart your Wealth.</p></div>
          : history.error && !history.data ? <div className="pfv-chart__none"><ReadFailed what="Wealth history" error={history.error} onRetry={history.refresh} /></div>
          : history.loading && !history.data ? <Skeleton className="pfv-chart__skel" />
          : win ? <EquityCurve win={win} tone={view === 'value' ? 'equity' : 'pnl'} level={view === 'value'} compactAxis clean privacy={view === 'value' ? 'funds' : 'pnl'} />
          : <div className="pfv-chart__none"><p className="pfv-quiet">Nothing to chart in this range yet.</p></div>}
      </div>
    </div>
  );
}

function Act({ a, f, name, side, onOpenMarket, setTarget, readOnly }: {
  a: FundAction | null; f: WealthFund | null; name: string; side: 'buy' | 'sell'; readOnly?: boolean;
  onOpenMarket: (symbol: string, engine: 'spot') => void; setTarget: (t: WealthSheetTarget) => void;
}) {
  if (!a || !f) return null;
  if (a.kind === 'trade') return <Button variant="secondary" onClick={() => onOpenMarket(a.symbol, 'spot')}>Trade</Button>;
  if (a.kind === 'batch' || a.kind === 'rfq') return <Button variant="secondary" disabled={readOnly} onClick={() => setTarget({ fund: f, name, action: a, side })}>{side === 'buy' ? 'Invest' : 'Redeem'}</Button>;
  if (a.kind === 'external') return <a className="tf-btn is-quiet is-sm" href={sodexFundUrl(f.fundId)} target="_blank" rel="noopener noreferrer">On SoDEX</a>;
  return <StatusPill size="sm" title={a.nextAt ? `Next open ${dayTime(a.nextAt)}` : undefined}>{a.why}</StatusPill>;
}

/**
 * What the wallet holds in Wealth. `showFunds`: with nothing held, the funds on offer are listed right here (owner
 * 2026-11-26: "no see your funds button, show list on portfolio too"), not behind a button.
 */
export function Holdings({ w, address, provider, onOpenMarket, onDone, readOnly, showFunds }: Omit<WealthProps, 'value' | 'slp' | 'refreshToken'> & { showFunds?: boolean }) {
  const m = useMasks();
  const statuses = useTradingStatuses(w.holdings ? w.holdings.map((h) => h.fund).filter((f): f is WealthFund => !!f) : null);
  const [target, setTarget] = useState<WealthSheetTarget | null>(null);
  if (!address) return <EmptyState compact icon="wallet" title="No wallet connected" description="Funds you hold show here." actions={<Button variant="secondary" onClick={requestConnect}>Connect</Button>} />;
  if (w.error && !w.holdings) return <ReadFailed what="Wealth holdings" error={w.error} onRetry={w.refresh} />;
  if (!w.holdings) return <div className="pfv-skels">{[0, 1, 2].map((i) => <Skeleton key={i} className="pfv-skel-row" />)}</div>;
  if (w.holdings.length === 0) {
    if (!showFunds) return <EmptyState compact icon="coins" title="No Wealth holdings" description="Funds you hold or have requested show here." />;
    return (
      <div className="pfv-hold__none">
        <p className="pfv-quiet">No Wealth holdings yet. These funds are open to you:</p>
        <FundShelfList w={w} address={address} provider={provider} onOpenMarket={onOpenMarket} onDone={onDone} readOnly={readOnly} />
      </div>
    );
  }
  return (
    <>
      <ul className="pfv-hold">
        {w.holdings.map((h) => {
          const pnl = h.pnl?.priced ? num(h.pnl.unrealizedPnl) + num(h.pnl.realizedPnl) : null;
          const d = h.pnl?.pnl24h !== undefined ? num(h.pnl.pnl24h) : null;
          const action = h.fund ? fundAction(h.fund, statuses.get(h.fundId) ?? null) : null;
          return (
            <li key={h.fundId}>
              <span className="pfv-hold__n">
                <CoinIcon coin={fundIcon(h.coin)} size={28} />
                <span><b>{h.name}</b><small>{m.funds(fmt(h.shares, 4))} {h.coin} {held(h).map((t) => <span key={t} className="tf-tag">{t}</span>)}</small></span>
              </span>
              <span className="pfv-hold__f"><small>Value</small><b>{m.funds(h.marketValue === null ? DASH : fmtUsd(h.marketValue))}</b>{h.inFlight > 0 && <small>{m.funds(fmtUsd(h.inFlight))} in progress</small>}</span>
              <span className="pfv-hold__f"><small>PnL</small><b className={tone(pnl)}>{m.pnl(pnl === null ? DASH : signedUsd(pnl))}</b></span>
              <span className="pfv-hold__f is-hide-s"><small>24h</small><b className={tone(d)}>{m.pnl(d === null ? DASH : signedUsd(d))}</b></span>
              <span className="pfv-hold__a"><Act a={action} f={h.fund} name={h.name} side="sell" onOpenMarket={onOpenMarket} setTarget={setTarget} readOnly={readOnly} /></span>
            </li>
          );
        })}
      </ul>
      <WealthSheet target={target} onClose={() => setTarget(null)} address={address} provider={provider} onDone={onDone} />
    </>
  );
}

// --- requests, history, recurring buys ---------------------------------------------------------------------------

const KIND: Readonly<Record<string, string>> = {
  subscribe: 'Subscribe', airdrop: 'Airdrop', deposit: 'Deposit', redeem: 'Redeem', liquidation: 'Liquidation', transfer_in: 'Transfer in', transfer_out: 'Transfer out',
};
const STATUS_TONE: Readonly<Record<string, 'positive' | 'negative' | 'neutral' | 'warning'>> = { completed: 'positive', failed: 'negative', rejected: 'negative', processing: 'warning' };

function Entries({ entries, names }: { entries: WealthEntry[]; names: Map<string, string> }) {
  const m = useMasks();
  return (
    <ul className="pfv-ledger">
      {entries.map((e, i) => {
        const amount = e.cost ?? e.proceeds;
        return (
          <li key={`${e.txHash ?? e.at}-${i}`}>
            <span className="pfv-ledger__n"><b>{KIND[e.kind] ?? e.kind}</b><small>{names.get(e.fundId) ?? e.fundId}</small></span>
            <StatusPill size="sm" dot tone={STATUS_TONE[e.status] ?? 'neutral'}>{e.status.charAt(0).toUpperCase() + e.status.slice(1)}</StatusPill>
            <span className="pfv-ledger__v"><b>{m.funds(amount === undefined ? DASH : `${e.costEstimated ? '≈ ' : ''}${fmtUsd(num(amount))}`)}</b><small>{e.shares === undefined ? '' : `${m.funds(fmt(num(e.shares), 4))} shares`}</small></span>
            <span className="pfv-ledger__t">{dayTime(e.requestedAt ?? e.at)}</span>
            <span className="pfv-ledger__a">
              {/* A claim needs the on-chain request id, which the API does not return. */}
              {e.claimable === true && <a className="tf-btn is-secondary is-sm" href={sodexFundUrl(e.fundId)} target="_blank" rel="noopener noreferrer">Claim on SoDEX</a>}
              {e.txHash && <a className="tf-btn is-quiet is-sm" href={`https://main-scan.valuechain.xyz/tx/${e.txHash}`} target="_blank" rel="noopener noreferrer">Tx</a>}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

type LedgerTab = 'moving' | 'history' | 'plans';

export function Ledger({ w, address, refreshToken }: { w: WealthState; address: string | null; refreshToken: number }) {
  const { entries, plans, error } = useLedger(address, refreshToken);
  const [tab, setTab] = useState<LedgerTab>('moving');
  const names = useMemo(() => new Map((w.funds ?? []).map((f) => [f.fundId, fundLabel(f).name])), [w.funds]);
  const moving = (entries ?? []).filter((e) => e.status === 'processing' || e.claimable === true || e.delayedPending === true);
  const list = (rows: WealthEntry[] | null, none: string) => (
    !address ? <p className="pfv-quiet">Connect a wallet to see your Wealth requests.</p>
      : error && !rows ? <ReadFailed what="Wealth history" error={error} />
      : !rows ? <div className="pfv-skels">{[0, 1].map((i) => <Skeleton key={i} className="pfv-skel-row" />)}</div>
      : rows.length === 0 ? <EmptyState compact icon="clock" title={none} />
      : <Entries entries={rows} names={names} />
  );
  return (
    <div className="pfv-ledgerbox">
      <Tabs
        label="Wealth requests"
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'moving', label: 'In progress', count: entries ? moving.length : undefined },
          { value: 'history', label: 'History' },
          { value: 'plans', label: 'Recurring buys' },
        ]}
      />
      <div className="pfv-ledgerbox__body">
        {tab === 'moving' && list(entries ? moving : null, 'Nothing in progress')}
        {tab === 'history' && list(entries, 'No Wealth history yet')}
        {tab === 'plans' && (
          !address ? <p className="pfv-quiet">Connect a wallet to see your recurring buys.</p>
            : !plans ? <Skeleton className="pfv-skel-row" />
            : plans.length === 0 ? <EmptyState compact icon="clock" title="No recurring buys" description="SoDEX sets these up on its Wealth pages. They show here once they exist." actions={<a className="tf-btn is-secondary is-sm" href="https://sodex.com/wealth" target="_blank" rel="noopener noreferrer">Open SoDEX Wealth</a>} />
            : (
              <ul className="pfv-ledger">
                {plans.map((p) => (
                  <li key={p.planIndex}>
                    <span className="pfv-ledger__n"><b>{names.get(p.fundId ?? '') ?? p.share?.coin ?? p.target}</b><small>Every {p.planType.replace('_', '-').toLowerCase()}</small></span>
                    <StatusPill size="sm">{p.status.toLowerCase()}</StatusPill>
                    <span className="pfv-ledger__v"><b>{fmtUsd(num(p.amount))}</b><small>{p.successfulExecutionCount} buys</small></span>
                    <span className="pfv-ledger__t">Next {dayTime(p.nextScheduledAt)}</span>
                    <span className="pfv-ledger__a" />
                  </li>
                ))}
              </ul>
            )
        )}
      </div>
    </div>
  );
}

// --- every fund on offer -----------------------------------------------------------------------------------------

function channelWords(a: FundAction | null, fundType: WealthFund['fundType']): string {
  if (!a) return fundType === 'clob' ? 'Order book' : DASH;
  switch (a.kind) {
    case 'trade': return 'Order book';
    case 'batch': return 'Batch';
    case 'rfq': return 'Maker quote';
    case 'external': return 'On sodex.com';
    case 'closed': return a.why;
  }
}

const SHELVES: Array<SegOption<FundShelf | 'All'>> = [{ value: 'All', label: 'All' }, { value: 'Stable Earn', label: 'Stable Earn' }, { value: 'Curated ETF', label: 'Curated ETF' }, { value: 'Specialty', label: 'Specialty' }];

export function FundShelfList({ w, address, provider, onOpenMarket, onDone, readOnly }: Omit<WealthProps, 'value' | 'slp' | 'refreshToken'>) {
  const statuses = useTradingStatuses(w.funds);
  const [shelf, setShelf] = useState<FundShelf | 'All'>('All');
  const [target, setTarget] = useState<WealthSheetTarget | null>(null);
  const rows = (w.funds ?? []).filter((f) => shelf === 'All' || fundLabel(f).shelf === shelf);
  return (
    <div className="pfv-shelf">
      <div className="pfv-shelf__bar"><Segmented options={SHELVES} value={shelf} onChange={setShelf} label="Shelf" /></div>
      {w.funds === null ? <div className="pfv-skels">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="pfv-skel-row" />)}</div> : (
        <ul className="pfv-funds">
          {rows.map((f) => {
            const label = fundLabel(f);
            const q = w.quotes.get(f.fundId);
            const action = fundAction(f, statuses.get(f.fundId) ?? null);
            return (
              <li key={f.fundId}>
                <span className="pfv-funds__n">
                  <CoinIcon coin={fundIcon(q?.symbol ?? f.share.coin)} size={28} />
                  <span><b>{label.name}</b><small><span className="tf-tag">{label.shelf}</span> {channelWords(action, f.fundType)}</small></span>
                </span>
                <span className="pfv-funds__f"><small>24h</small><b>{pctNode(q?.roi24h)}</b></span>
                <span className="pfv-funds__f is-hide-s"><small>1 month</small><b>{pctNode(q?.roi1M)}</b></span>
                <span className="pfv-funds__f is-hide-s"><small>1 year</small><b>{pctNode(q?.roi1Y)}</b></span>
                {/* An APY means something for a yield product. On an ETF a week's move annualised is noise. */}
                <span className="pfv-funds__f"><small>7-day APY</small><b>{label.yield ? pctNode(q?.apy7d) : DASH}</b></span>
                <span className="pfv-funds__a"><Act a={action} f={f} name={label.name} side="buy" onOpenMarket={onOpenMarket} setTarget={setTarget} readOnly={readOnly} /></span>
              </li>
            );
          })}
        </ul>
      )}
      <WealthSheet target={target} onClose={() => setTarget(null)} address={address} provider={provider} onDone={onDone} />
    </div>
  );
}

/** The whole Wealth area, in Shells: figures and chart, holdings, requests, every fund. */
export function WealthArea(p: WealthProps & { head?: ReactNode }) {
  return (
    <div className="pfv-wealth">
      {p.head}
      <Shell className="pfv-wealth__top">
        <Panel className="pfv-wealth__fig"><WealthFigures w={p.w} value={p.value} slp={p.slp} layout="hero" /></Panel>
        <Panel className="pfv-wealth__chart"><WealthChart address={p.address} /></Panel>
      </Shell>
      <Shell>
        <ShellHeader icon="coins" title="Your funds" subtitle="Wherever the shares sit" />
        <Panel className="pfv-pad0"><Holdings {...p} /></Panel>
      </Shell>
      <Shell>
        <ShellHeader icon="clock" title="Requests" subtitle="What SoDEX has not settled yet, and before" />
        <Panel className="pfv-pad0"><Ledger w={p.w} address={p.address} refreshToken={p.refreshToken} /></Panel>
      </Shell>
      <Shell>
        <ShellHeader icon="layers" title="All funds" subtitle="SoDEX's live returns" />
        <Panel className="pfv-pad0"><FundShelfList {...p} /></Panel>
      </Shell>
    </div>
  );
}
