/**
 * The Wealth tab: what the wallet holds in SoDEX Wealth, how it did, what is on offer and
 * what is on its way. Reads and routes: trading/wealth.ts. Every yield and return on the page
 * is SoDEX's own live figure, and a missing one is a dash.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Card, EquityCurve, type CurveWindow } from './parts';
import { CoinIcon } from '../CoinIcon';
import { Button, StatusPill } from '../bots/kit/kit';
import { EmptyState, NoWallet } from '../EmptyState';
import { ReadFailed } from '../AccountHistory';
import { PanelTabs, type PanelTab } from '../../dashboard/Panel';
import { useAsync } from '../../hooks';
import { DASH, MINUS, fmt, fmtUsd, num, signClass } from '../../format';
import { useMask } from '../../privacy';
import {
  fundAction, fundLabel, readPnlHistory,
  type FundAction, type FundShelf, type JoinedHolding, type PnlRange, type WealthEntry, type WealthFund,
} from '../../trading/wealth';
import { RangePicker, ViewSeg } from './RangePicker';
import { useLedger, useTradingStatuses, type WealthState } from './useWealth';
import { WealthSheet, type WealthSheetTarget } from './WealthSheet';
import { EarnSheet, type EarnSheetTarget } from './EarnSheet';
import { RecurringPanel, RecurringSheet, useRecurring, type RecurringSheetTarget, type RecurringState } from './RecurringBuys';
import { EARN_FUND } from '../../trading/wealthEarn';
import { WEALTH_OPEN_EVENT, type WealthOpen } from './WealthHero';
import { closedLine, readTradingStatus } from '../../trading/wealth';
import { claimEntry } from '../../trading/claims';
import { isUserRejection } from '../../wallet';
import { Spinner } from '../funds/ui';
import type { Eip1193Provider } from '../../wallet';

const signedUsd = (v: number): string => `${v > 0 ? '+' : v < 0 ? MINUS : ''}${fmtUsd(Math.abs(v))}`;
const pct = (raw: string | undefined): ReactNode => {
  if (raw === undefined) return DASH;
  const v = Number(raw);
  if (!Number.isFinite(v)) return DASH;
  return <span className={signClass(v)}>{v > 0 ? '+' : v < 0 ? MINUS : ''}{Math.abs(v).toFixed(2)}%</span>;
};
const dayTime = (at: string | number | undefined): string => {
  if (at === undefined) return DASH;
  const d = new Date(typeof at === 'number' && at < 1e12 ? at * 1000 : at);
  return Number.isNaN(d.getTime()) ? DASH : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
};

/** USDC Earn's share has no logo of its own here; it is USDC in a vault. */
const fundIcon = (coin: string): string => (/^v?soUSDC$/i.test(coin) ? 'USDC' : coin);


// --- the left card ----------------------------------------------------------------------

function WealthValueCard({ w, value, slp }: { w: WealthState; value: number | null; slp: number | null }) {
  const maskEquity = useMask('equity');
  const maskPnl = useMask('pnl');
  const p = w.pnl;
  const row = (label: string, v: string | undefined, signed = true) => {
    const known = v !== undefined && v !== '';
    const x = num(v);
    return (
      <div className="pfx-kv__row">
        <span>{label}</span>
        <b className={known && signed ? signClass(x) : undefined}>{known ? maskPnl(signed ? signedUsd(x) : fmtUsd(x)) : DASH}</b>
      </div>
    );
  };
  return (
    <Card className="pfx-value">
      <div className="pfx-value__top">
        <span className="pfx-value__k">Wealth value</span>
        <span className="pfx-value__v">{maskEquity(value === null ? DASH : fmtUsd(value))}</span>
        <span className="pfx-value__sub">24h change <b className={p?.totalPnl24h ? signClass(num(p.totalPnl24h)) : undefined}>{p?.totalPnl24h ? maskPnl(signedUsd(num(p.totalPnl24h))) : DASH}</b></span>
      </div>
      <div className="pfx-kv">
        {row('Total PnL', p?.totalPnl)}
        {row('Realized', p?.totalRealizedPnl)}
        {row('Unrealized', p?.totalUnrealizedPnl)}
        {row('Cost', p?.totalCost, false)}
        {row('In progress', p?.inFlightValue, false)}
        {slp !== null && <div className="pfx-kv__row" title="MAG7.ssi or sMAG7.ssi deposited into the liquidity vault. SoDEX reports no position for it, so it is SoDEX's account-value series minus what the series is known to hold."><span>SLP vault, inferred</span><b>{maskPnl(fmtUsd(slp))}</b></div>}
      </div>
      {p?.complete === false && <p className="pf-note pfx-sum__note">SoDEX could not price every fund, so the figures leave those out.</p>}
    </Card>
  );
}

// --- the chart --------------------------------------------------------------------------

const RANGES: ReadonlyArray<readonly [PnlRange, string]> = [['1W', '7d'], ['1M', '30d'], ['3M', '90d'], ['1Y', '1y'], ['All', 'All time']];
const WEALTH_VIEWS: ReadonlyArray<readonly ['value' | 'pnl', string]> = [['value', 'Wealth value'], ['pnl', 'PnL']];
const SHELF_VIEWS: ReadonlyArray<readonly [FundShelf | 'All', string]> = [['All', 'All'], ['Stable Earn', 'Stable Earn'], ['Curated ETF', 'Curated ETF'], ['Specialty', 'Specialty']];

function WealthChart({ address }: { address: string | null }) {
  const [range, setRange] = useState<PnlRange>('1M');
  const [view, setView] = useState<'value' | 'pnl'>('value');
  const mask = useMask(view === 'value' ? 'funds' : 'pnl');
  const history = useAsync(() => readPnlHistory(address!, range), [address, range], { enabled: !!address });
  const win = useMemo((): CurveWindow | null => {
    const pts = (history.data ?? [])
      .map((p) => ({ t: typeof p.ts === 'number' ? (p.ts < 1e12 ? p.ts * 1000 : p.ts) : Date.parse(p.ts), v: num(view === 'value' ? p.totalValue : p.pnl) }))
      .filter((p) => Number.isFinite(p.t));
    if (pts.length < 2) return null;
    const first = pts[0]!.v;
    // The value chart reads the value itself; PnL is the change from the start of the range.
    const shown = view === 'value' ? pts : pts.map((p) => ({ t: p.t, v: p.v - first }));
    return { points: shown, baseline: first, change: pts[pts.length - 1]!.v - first, maxDrawdown: null };
  }, [history.data, view]);
  return (
    <Card
      className="pf-card--chart pfx-chart"
      title={(
        <RangePicker value={view} options={WEALTH_VIEWS} onChange={setView} label="Chart" align="start" />
      )}
      action={(
        <ViewSeg value={range} options={RANGES} onChange={setRange} label="Timeframe" />
      )}
    >
      {win && win.change !== null && (
        <div className="pfx-chart__head">
          <span>{view === 'value' ? 'Change in value' : 'Change in PnL'}, {(RANGES.find(([k]) => k === range)?.[1] ?? range).toLowerCase()}</span>
          <b className={view === 'pnl' ? signClass(win.change) : undefined}>{mask(signedUsd(win.change))}</b>
        </div>
      )}
      {!address ? <div className="pf-chart pf-chart--empty"><p>Connect a wallet to chart your Wealth.</p></div>
        : history.error && !history.data ? <div className="pf-chart pf-chart--empty"><ReadFailed what="Wealth history" error={history.error} onRetry={history.refresh} /></div>
        : history.loading && !history.data ? <div className="pf-chart pf-chart--empty"><p><span className="pf-spin" aria-hidden="true" />Reading</p></div>
        : win ? <EquityCurve win={win} tone={view === 'value' ? 'equity' : 'pnl'} level={view === 'value'} compactAxis clean privacy={view === 'value' ? 'funds' : 'pnl'} />
        : <div className="pf-chart pf-chart--empty"><p>Nothing to chart yet in this range.</p></div>}
    </Card>
  );
}

// --- the shelves ------------------------------------------------------------------------


/** The channel, in words the reader can use. */
function channelWords(a: FundAction | null, fundType: WealthFund['fundType']): string {
  if (!a) return fundType === 'clob' ? 'Order book' : DASH;
  switch (a.kind) {
    case 'trade': return 'Order book';
    case 'batch': return 'Batch';
    case 'rfq': return a.protocol === 'ssi' ? 'Maker quote, settled at once' : 'Maker quote';
    case 'external': return fundType === 'bridged_vault' ? 'Bridge, about a minute' : 'Not open';
    case 'closed': return a.why;
  }
}

function FundBoard({ w, address, provider, onOpenMarket, onDone, recurring, onRecurring, onEarn }: {
  w: WealthState;
  address: string | null;
  provider: Eip1193Provider | null;
  onOpenMarket: (symbol: string, engine: 'spot') => void;
  onDone: () => void;
  /** The funds SoDEX's recurring-buy contract takes. */
  recurring: ReadonlySet<string>;
  onRecurring: (fundId: string) => void;
  onEarn: (t: EarnSheetTarget) => void;
}) {
  const statuses = useTradingStatuses(w.funds);
  const [shelf, setShelf] = useState<FundShelf | 'All'>('All');
  const [target, setTarget] = useState<WealthSheetTarget | null>(null);
  const rows = (w.funds ?? []).filter((f) => shelf === 'All' || fundLabel(f).shelf === shelf);
  return (
    <Card
      title="All funds"
      className="pfx-board"
      action={(
        <ViewSeg value={shelf} options={SHELF_VIEWS} onChange={setShelf} label="Shelf" />
      )}
    >
      <div className="pfx-tablewrap">
        <table className="acct-table acct-t pfx-table">
          <thead>
            <tr>
              <th>Fund</th>
              <th className="pfx-hide-phone">Type</th>
              <th className="num">24h</th>
              <th className="num pfx-hide-phone">1 month</th>
              <th className="num pfx-hide-phone">1 year</th>
              <th className="num">7-day APY</th>
              <th className="pfx-hide-phone">Trades through</th>
              <th className="acct-actions" aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {w.funds === null && [0, 1, 2, 3].map((i) => <tr key={i}><td colSpan={8}><span className="pfx-bone" /></td></tr>)}
            {rows.map((f) => {
              const label = fundLabel(f);
              const q = w.quotes.get(f.fundId);
              const action = fundAction(f, statuses.get(f.fundId) ?? null);
              return (
                <tr key={f.fundId}>
                  <td>
                    <span className="acct-mkt">
                      <CoinIcon coin={fundIcon(q?.symbol ?? f.share.coin)} size={18} />
                      <span className="acct-mkt__n">{label.name}</span>
                    </span>
                  </td>
                  <td className="pfx-hide-phone"><span className="bal-tag">{label.shelf}</span></td>
                  <td className="num">{pct(q?.roi24h)}</td>
                  <td className="num pfx-hide-phone">{pct(q?.roi1M)}</td>
                  <td className="num pfx-hide-phone">{pct(q?.roi1Y)}</td>
                  {/* An APY means something for a yield product. On an ETF a week's move annualised is noise. */}
                  <td className="num">{label.yield ? pct(q?.apy7d) : DASH}</td>
                  <td className="pfx-hide-phone pfx-dim">{channelWords(action, f.fundType)}</td>
                  <td className="acct-actions">
                    {action?.kind === 'trade' && <button type="button" className="acct-act" onClick={() => onOpenMarket(action.symbol, 'spot')}>Trade</button>}
                    {(action?.kind === 'batch' || action?.kind === 'rfq') && (
                      <button type="button" className="acct-act" onClick={() => setTarget({ fund: f, name: label.name, action, side: 'buy' })}>Invest</button>
                    )}
                    {action?.kind === 'external' && (f.fundId === EARN_FUND
                      ? <button type="button" className="acct-act" onClick={() => onEarn({ side: 'buy' })}>Invest</button>
                      : <span className="pfx-dim">{action.why.startsWith('In subscription') ? 'In subscription' : 'Not open'}</span>)}
                    {action?.kind === 'closed' && <span className="pfx-dim" title={action.nextAt ? `${action.why} · next open ${dayTime(action.nextAt)}` : action.why}>{closedLine(action.nextAt)}</span>}
                    {recurring.has(f.fundId) && <button type="button" className="acct-act" onClick={() => onRecurring(f.fundId)}>Recurring</button>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <WealthSheet target={target} onClose={() => setTarget(null)} address={address} provider={provider} onDone={onDone} />
    </Card>
  );
}

// --- holdings, in progress, history -----------------------------------------------------

/**
 * Where the shares sit (owner 2026-11-28: "what is bridged by held in?"). Only places, each with its shares: "Bridged"
 * was the fund's route (USDC Earn reaches its Morpho vault over a bridge), not a place, so it is no longer shown here.
 */
const PLACES: ReadonlyArray<{ key: 'spotShares' | 'perpShares' | 'evmShares'; label: string; why: string }> = [
  { key: 'spotShares', label: 'Spot', why: 'In your SoDEX spot account.' },
  { key: 'perpShares', label: 'Perps margin', why: 'Pledged as margin in your perps account. It keeps earning and counts as collateral.' },
  { key: 'evmShares', label: 'Wallet', why: 'In your own wallet on ValueChain.' },
];
const held = (h: JoinedHolding): Array<{ label: string; why: string; shares: number }> =>
  PLACES.filter((p) => h[p.key] > 0).map((p) => ({ label: p.label, why: p.why, shares: h[p.key] }));

export function WealthHoldings({ w, address, onOpenMarket, onOpenWealth, provider, onDone, onEarn }: {
  w: WealthState;
  address: string | null;
  onOpenMarket: (symbol: string, engine: 'spot') => void;
  /** The empty state's way to the fund list. Omitted on the Wealth tab, where it is right there. */
  onOpenWealth?: () => void;
  provider: Eip1193Provider | null;
  onDone: () => void;
  /** USDC Earn's sheet, where the tab has one (the Portfolio's tab without it shows no action for USDC Earn). */
  onEarn?: (t: EarnSheetTarget) => void;
}) {
  const maskFunds = useMask('funds');
  const maskPnl = useMask('pnl');
  const statuses = useTradingStatuses(w.holdings ? w.holdings.map((h) => h.fund).filter((f): f is WealthFund => !!f) : null);
  const [target, setTarget] = useState<WealthSheetTarget | null>(null);
  if (!address) return <NoWallet line="Connect a wallet to see your Wealth holdings." compact />;
  if (w.error && !w.holdings) return <ReadFailed what="Wealth holdings" error={w.error} onRetry={w.refresh} />;
  if (!w.holdings) return <div className="pfx-bones" aria-busy="true">{[0, 1, 2].map((i) => <span key={i} className="pfx-bone" />)}</div>;
  if (w.holdings.length === 0) {
    return (
      <EmptyState
        icon="coins"
        title="No Wealth holdings"
        line="Funds you hold or have requested show here."
        compact
        action={onOpenWealth && <button type="button" className="empty-state__cta" onClick={onOpenWealth}>See the funds</button>}
      />
    );
  }
  return (
    <div className="tf wo">
      <div className="wo__head" aria-hidden="true">
        <span>Fund</span><span className="wo-hide">Held in</span><span className="num">Value</span><span className="num">PnL</span><span className="num wo-hide">24h</span><span />
      </div>
      <ul className="wo__list">
        {w.holdings.map((h) => {
          const pnl = h.pnl?.priced ? num(h.pnl.unrealizedPnl) + num(h.pnl.realizedPnl) : null;
          const d = h.pnl?.pnl24h !== undefined ? num(h.pnl.pnl24h) : null;
          const action = h.fund ? fundAction(h.fund, statuses.get(h.fundId) ?? null) : null;
          const places = held(h);
          return (
            <li key={h.fundId} className="wo__r">
              <span className="wo__fund">
                <CoinIcon coin={fundIcon(h.coin)} size={28} />
                <span><b>{h.name}</b><small>{`${maskFunds(fmt(h.shares, 4))} shares`}</small></span>
              </span>
              <span className="wo__in wo-hide">
                {places.length ? places.map((p) => (
                  <StatusPill key={p.label} size="sm" title={p.why}>{p.label}<span className="wo__in-n">{maskFunds(fmt(p.shares, 2))}</span></StatusPill>
                )) : <span className="pfx-dim">{DASH}</span>}
              </span>
              <span className="wo__v num">
                <b>{maskFunds(h.marketValue === null ? DASH : fmtUsd(h.marketValue))}</b>
                {h.inFlight > 0 && <small>{`${maskFunds(fmtUsd(h.inFlight))} in progress`}</small>}
              </span>
              <span className={`wo__v num ${pnl === null ? '' : signClass(pnl)}`}><b>{maskPnl(pnl === null ? DASH : signedUsd(pnl))}</b></span>
              <span className={`wo__v num wo-hide ${d === null ? '' : signClass(d)}`}><b>{maskPnl(d === null ? DASH : signedUsd(d))}</b></span>
              <span className="wo__acts">
                {action?.kind === 'trade' && <Button size="sm" variant="secondary" onClick={() => onOpenMarket(action.symbol, 'spot')}>Trade</Button>}
                {(action?.kind === 'batch' || action?.kind === 'rfq') && h.fund && (
                  <Button size="sm" variant="secondary" onClick={() => setTarget({ fund: h.fund!, name: h.name, action, side: 'sell' })}>Redeem</Button>
                )}
                {action?.kind === 'external' && (h.fundId === EARN_FUND && onEarn
                  ? (
                    <>
                      <Button size="sm" variant="primary" onClick={() => onEarn({ side: 'buy' })}>Subscribe</Button>
                      <Button size="sm" variant="secondary" onClick={() => onEarn({ side: 'sell', away: { perps: h.perpShares, spot: h.spotShares } })}>Redeem</Button>
                    </>
                  )
                  : h.fundId === EARN_FUND ? <a className="tf-btn is-secondary is-sm" href="/wealth?open=earn-redeem">Redeem</a> : <StatusPill size="sm">Not open</StatusPill>)}
              </span>
            </li>
          );
        })}
      </ul>
      <WealthSheet target={target} onClose={() => setTarget(null)} address={address} provider={provider} onDone={onDone} />
    </div>
  );
}

const KIND: Readonly<Record<string, string>> = {
  subscribe: 'Subscribe', airdrop: 'Airdrop', deposit: 'Deposit', redeem: 'Redeem', liquidation: 'Liquidation', transfer_in: 'Transfer in', transfer_out: 'Transfer out',
};
const STATUS_TONE: Readonly<Record<string, string>> = { completed: 'pos', failed: 'neg', rejected: 'neg' };

/** Claim a result that did not arrive by itself, here: the request id from its own receipt (trading/claims.ts). */
function ClaimButton({ e, address, provider, onDone }: { e: WealthEntry; address: string | null; provider: Eip1193Provider | null; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  if (msg) return <span className="pfx-dim" title={msg}>{msg.length > 40 ? 'See note' : msg}</span>;
  return (
    <button
      type="button"
      className="acct-act"
      disabled={busy || !provider || !address}
      title={!provider ? 'Reconnect your wallet: a claim is a wallet transaction on ValueChain.' : undefined}
      onClick={() => {
        if (!provider || !address) return;
        setBusy(true);
        claimEntry({ provider, owner: address, entry: e })
          .then(() => { setMsg('Claimed'); onDone(); })
          .catch((err) => { if (!isUserRejection(err)) setMsg((err as Error).message); })
          .finally(() => setBusy(false));
      }}
    >
      {busy ? <Spinner label="Claiming" /> : 'Claim'}
    </button>
  );
}

function LedgerTable({ entries, names, address, provider, onDone }: { entries: WealthEntry[]; names: Map<string, string>; address: string | null; provider: Eip1193Provider | null; onDone: () => void }) {
  const maskFunds = useMask('funds');
  return (
    <div className="pfx-tablewrap">
      <table className="acct-table acct-t pfx-table">
        <thead>
          <tr>
            <th>Fund</th>
            <th>Type</th>
            <th>Status</th>
            <th className="num">Amount</th>
            <th className="num pfx-hide-phone">Shares</th>
            <th className="num pfx-hide-phone">Time</th>
            <th className="acct-actions" aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {entries.map((e, i) => {
            const amount = e.cost ?? e.proceeds;
            return (
              <tr key={`${e.txHash ?? e.at}-${i}`}>
                <td>{names.get(e.fundId) ?? e.fundId}</td>
                <td>{KIND[e.kind] ?? e.kind}</td>
                <td><span className={`pfx-status ${STATUS_TONE[e.status] ?? ''}`}><i aria-hidden="true" />{e.status.charAt(0).toUpperCase() + e.status.slice(1)}</span></td>
                <td className="num">{maskFunds(amount === undefined ? DASH : `${e.costEstimated ? '≈ ' : ''}${fmtUsd(num(amount))}`)}</td>
                <td className="num pfx-hide-phone">{maskFunds(e.shares === undefined ? DASH : fmt(num(e.shares), 4))}</td>
                <td className="num acct-time pfx-hide-phone">{dayTime(e.requestedAt ?? e.at)}</td>
                <td className="acct-actions">
                  {/* A claim needs the on-chain request id, which the API does not return. */}
                  {e.claimable === true && <ClaimButton e={e} address={address} provider={provider} onDone={onDone} />}
                  {e.txHash && <a className="acct-act" href={`https://main-scan.valuechain.xyz/tx/${e.txHash}`} target="_blank" rel="noopener noreferrer">Tx</a>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function History({ address, refreshToken, w, onOpenMarket, provider, onDone, rec, onRecurringSheet, endedPlans, setEndedPlans, onEarn }: {
  address: string | null;
  refreshToken: number;
  w: WealthState;
  onOpenMarket: (symbol: string, engine: 'spot') => void;
  provider: Eip1193Provider | null;
  onDone: () => void;
  rec: RecurringState;
  onRecurringSheet: (t: RecurringSheetTarget) => void;
  endedPlans: boolean;
  setEndedPlans: (v: boolean) => void;
  onEarn: (t: EarnSheetTarget) => void;
}) {
  const { entries, error } = useLedger(address, refreshToken);
  const names = useMemo(() => new Map((w.funds ?? []).map((f) => [f.fundId, fundLabel(f).name])), [w.funds]);
  const moving = (entries ?? []).filter((e) => e.status === 'processing' || e.claimable === true || e.delayedPending === true);
  const list = (rows: WealthEntry[] | null, none: string) => (
    !address ? <NoWallet line="Connect a wallet to see your Wealth history." compact />
      : error && !rows ? <ReadFailed what="Wealth history" error={error} />
      : !rows ? <div className="pfx-bones" aria-busy="true">{[0, 1, 2].map((i) => <span key={i} className="pfx-bone" />)}</div>
      : rows.length === 0 ? <EmptyState icon="history" title={none} compact />
      : <LedgerTable entries={rows} names={names} address={address} provider={provider} onDone={onDone} />
  );
  const tabs: PanelTab[] = [
    { key: 'holdings', label: 'Holdings', content: <WealthHoldings w={w} address={address} onOpenMarket={onOpenMarket} provider={provider} onDone={onDone} onEarn={onEarn} /> },
    { key: 'moving', label: `In progress${moving.length ? ` (${moving.length})` : ''}`, content: list(entries ? moving : null, 'Nothing in progress') },
    { key: 'history', label: 'History', content: list(entries, 'No Wealth history yet') },
    {
      key: 'plans',
      label: `Recurring buys${rec.active?.plans.length ? ` (${rec.active.plans.length})` : ''}`,
      content: <RecurringPanel rec={rec} funds={w.funds} address={address} onOpen={onRecurringSheet} ended={endedPlans} setEnded={setEndedPlans} />,
    },
  ];
  return <div className="dash pfx-plain"><PanelTabs tabs={tabs.map((t) => ({ ...t, content: <Card className="pf-card--band pfx-band">{t.content}</Card> }))} /></div>;
}

/**
 * The page's sheets (USDC Earn, a vault's Invest or Redeem, a recurring plan), opened from anywhere on the Wealth page
 * by openWealth (WealthHero.tsx) and by the Holdings' own buttons. Shared by the overview and the fund and index pages.
 */
function useWealthSheets({ w, address, provider, onDone, rec }: {
  w: WealthState; address: string | null; provider: Eip1193Provider | null; onDone: () => void; rec: RecurringState;
}) {
  const [rcTarget, setRcTarget] = useState<RecurringSheetTarget | null>(null);
  const [earnTarget, setEarnTarget] = useState<EarnSheetTarget | null>(null);
  const [vaultTarget, setVaultTarget] = useState<WealthSheetTarget | null>(null);
  // The SoPoints page's "Keep margin in USDC Earn" lands here as /wealth?open=earn (and ?open=recurring).
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const open = q.get('open');
    if (open !== 'earn' && open !== 'earn-redeem' && open !== 'recurring') return;
    if (open === 'earn') setEarnTarget({ side: 'buy' });
    else if (open === 'earn-redeem') setEarnTarget({ side: 'sell' });
    else setRcTarget({ kind: 'create' });
    q.delete('open');
    const rest = q.toString();
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${rest ? `?${rest}` : ''}${window.location.hash}`);
  }, []);
  // The page's other parts (the stage's Invest, an index's legs, a fund page) open the same sheets.
  useEffect(() => {
    const on = (e: Event) => {
      const o = (e as CustomEvent<WealthOpen>).detail;
      if (o?.kind === 'earn') setEarnTarget({ side: o.side });
      else if (o?.kind === 'recurring') setRcTarget({ kind: 'create', fundId: o.fundId });
      else if (o?.kind === 'recurring-sheet') setRcTarget(o.target);
      else if (o?.kind === 'vault') {
        const fund = w.funds?.find((f) => f.fundId === o.fundId);
        if (fund) {
          void readTradingStatus(fund.fundId).then((st) => {
            const a = fundAction(fund, st);
            if (a && (a.kind === 'batch' || a.kind === 'rfq')) setVaultTarget({ fund, name: fundLabel(fund).name, action: a, side: o.side });
          }).catch(() => undefined);
        }
      }
    };
    window.addEventListener(WEALTH_OPEN_EVENT, on);
    return () => window.removeEventListener(WEALTH_OPEN_EVENT, on);
  }, [w.funds]);
  const sheets = (
    <>
      <RecurringSheet target={rcTarget} onClose={() => setRcTarget(null)} rec={rec} funds={w.funds} address={address} provider={provider} onDone={onDone} />
      <WealthSheet target={vaultTarget} onClose={() => setVaultTarget(null)} address={address} provider={provider} onDone={onDone} />
      <EarnSheet target={earnTarget} onClose={() => setEarnTarget(null)} address={address} provider={provider} onDone={() => { w.refresh(); onDone(); }} apy={w.quotes.get(EARN_FUND)?.apy7d} />
    </>
  );
  return { sheets, setRcTarget, setEarnTarget };
}

/** The sheets alone, for the Wealth page's fund and index pages. */
export function WealthSheets({ w, address, provider, refreshToken, onDone }: {
  w: WealthState; address: string | null; provider: Eip1193Provider | null; refreshToken: number; onDone: () => void;
}) {
  const rec = useRecurring(address, refreshToken, w.funds, false);
  return useWealthSheets({ w, address, provider, onDone, rec }).sheets;
}

export function WealthTab({ w, value, slp, address, provider, refreshToken, onOpenMarket, onDone, lead, middle, board, tail }: {
  w: WealthState;
  /** The Wealth bucket from summary.ts, so the tab and the Trade tab's breakdown cannot disagree. */
  value: number | null;
  slp: number | null;
  address: string | null;
  provider: Eip1193Provider | null;
  refreshToken: number;
  onOpenMarket: (symbol: string, engine: 'spot') => void;
  onDone: () => void;
  /** The Wealth page's own top (stage, portfolio card, macro) in place of the tab's value card and chart. */
  lead?: ReactNode;
  /** Between the wallet's tabs and the fund board (the Wealth page's ValueDesk indexes). */
  middle?: ReactNode;
  /** The Wealth page's own fund list (the Desk version's list and preview) in place of the tab's board; given the
   *  funds SoDEX's recurring-buy contract takes. */
  board?: (recurring: ReadonlySet<string>) => ReactNode;
  /** Under the holdings, above the indexes (the Wealth page's calendar and macro row). */
  tail?: ReactNode;
}) {
  const [endedPlans, setEndedPlans] = useState(false);
  const rec = useRecurring(address, refreshToken, w.funds, endedPlans);
  const { sheets, setRcTarget, setEarnTarget } = useWealthSheets({ w, address, provider, onDone, rec });
  const eligible = useMemo(() => new Set((rec.targets ?? []).map((t) => t.fund.fundId)), [rec.targets]);
  return (
    <div className="pfx-stack">
      {lead ?? (
        <div className="pfx-top">
          <WealthValueCard w={w} value={value} slp={slp} />
          <WealthChart address={address} />
        </div>
      )}
      <History
        address={address} refreshToken={refreshToken} w={w} onOpenMarket={onOpenMarket} provider={provider} onDone={onDone}
        rec={rec} onRecurringSheet={setRcTarget} endedPlans={endedPlans} setEndedPlans={setEndedPlans} onEarn={setEarnTarget}
      />
      {/* Calendar and macro sit under the holdings, above the indexes (owner 2026-11-28). */}
      {tail}
      {middle}
      {board ? board(eligible) : (
        <FundBoard
          w={w} address={address} provider={provider} onOpenMarket={onOpenMarket} onDone={onDone}
          recurring={eligible} onRecurring={(fundId) => setRcTarget({ kind: 'create', fundId })} onEarn={setEarnTarget}
        />
      )}
      {sheets}
    </div>
  );
}
