/**
 * The Wealth tab: what the wallet holds in SoDEX Wealth, how it did, what is on offer and
 * what is on its way. Reads and routes: trading/wealth.ts. Every yield and return on the page
 * is SoDEX's own live figure, and a missing one is a dash.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { Card, EquityCurve, type CurveWindow } from './parts';
import { CoinIcon } from '../CoinIcon';
import { EmptyState, NoWallet } from '../EmptyState';
import { ReadFailed } from '../AccountHistory';
import { PanelTabs, type PanelTab } from '../../dashboard/Panel';
import { useAsync } from '../../hooks';
import { DASH, MINUS, fmt, fmtUsd, num, signClass } from '../../format';
import { useMask } from '../../privacy';
import {
  fundAction, fundLabel, readPnlHistory, sodexFundUrl,
  type FundAction, type FundShelf, type JoinedHolding, type PnlRange, type WealthEntry, type WealthFund,
} from '../../trading/wealth';
import { RangePicker, ViewSeg } from './RangePicker';
import { useLedger, useTradingStatuses, type WealthState } from './useWealth';
import { WealthSheet, type WealthSheetTarget } from './WealthSheet';
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

const SodexLink = ({ href, children }: { href: string; children: ReactNode }) => (
  <a className="acct-act" href={href} target="_blank" rel="noopener noreferrer">{children}</a>
);

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
    case 'rfq': return 'Maker quote';
    case 'external': return 'On sodex.com';
    case 'closed': return a.why;
  }
}

function FundBoard({ w, address, provider, onOpenMarket, onDone }: {
  w: WealthState;
  address: string | null;
  provider: Eip1193Provider | null;
  onOpenMarket: (symbol: string, engine: 'spot') => void;
  onDone: () => void;
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
                    {action?.kind === 'external' && <SodexLink href={sodexFundUrl(f.fundId)}>On SoDEX</SodexLink>}
                    {action?.kind === 'closed' && <span className="pfx-dim" title={action.nextAt ? `Next open ${dayTime(action.nextAt)}` : undefined}>{action.why}</span>}
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

const held = (h: JoinedHolding): string[] => [
  ...(h.spotShares > 0 ? ['Spot'] : []),
  ...(h.perpShares > 0 ? ['Perps margin'] : []),
  ...(h.evmShares > 0 ? ['Wallet'] : []),
  ...(h.source === 'bridge' ? ['Bridged'] : []),
];

export function WealthHoldings({ w, address, onOpenMarket, onOpenWealth, provider, onDone }: {
  w: WealthState;
  address: string | null;
  onOpenMarket: (symbol: string, engine: 'spot') => void;
  /** The empty state's way to the fund list. Omitted on the Wealth tab, where it is right there. */
  onOpenWealth?: () => void;
  provider: Eip1193Provider | null;
  onDone: () => void;
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
    <div className="pfx-tablewrap">
      <table className="acct-table acct-t pfx-table">
        <thead>
          <tr>
            <th>Fund</th>
            <th className="pfx-hide-phone">Held in</th>
            <th className="num pfx-hide-phone">Shares</th>
            <th className="num">Value</th>
            <th className="num pfx-hide-phone">In progress</th>
            <th className="num">PnL</th>
            <th className="num pfx-hide-phone">24h</th>
            <th className="acct-actions" aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {w.holdings.map((h) => {
            const pnl = h.pnl?.priced ? num(h.pnl.unrealizedPnl) + num(h.pnl.realizedPnl) : null;
            const d = h.pnl?.pnl24h !== undefined ? num(h.pnl.pnl24h) : null;
            const action = h.fund ? fundAction(h.fund, statuses.get(h.fundId) ?? null) : null;
            return (
              <tr key={h.fundId}>
                <td>
                  <span className="acct-mkt"><CoinIcon coin={fundIcon(h.coin)} size={18} /><span className="acct-mkt__n">{h.name}</span></span>
                </td>
                <td className="pfx-hide-phone"><span className="bal-tags pfx-tags">{held(h).map((t) => <span key={t} className="bal-tag">{t}</span>)}</span></td>
                <td className="num pfx-hide-phone">{maskFunds(fmt(h.shares, 4))}</td>
                <td className="num">{maskFunds(h.marketValue === null ? DASH : fmtUsd(h.marketValue))}</td>
                <td className="num pfx-hide-phone">{maskFunds(h.inFlight > 0 ? fmtUsd(h.inFlight) : DASH)}</td>
                <td className={`num ${pnl === null ? '' : signClass(pnl)}`}>{maskPnl(pnl === null ? DASH : signedUsd(pnl))}</td>
                <td className={`num pfx-hide-phone ${d === null ? '' : signClass(d)}`}>{maskPnl(d === null ? DASH : signedUsd(d))}</td>
                <td className="acct-actions">
                  {action?.kind === 'trade' && <button type="button" className="acct-act" onClick={() => onOpenMarket(action.symbol, 'spot')}>Trade</button>}
                  {(action?.kind === 'batch' || action?.kind === 'rfq') && h.fund && (
                    <button type="button" className="acct-act" onClick={() => setTarget({ fund: h.fund!, name: h.name, action, side: 'sell' })}>Redeem</button>
                  )}
                  {action?.kind === 'external' && <SodexLink href={sodexFundUrl(h.fundId)}>On SoDEX</SodexLink>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <WealthSheet target={target} onClose={() => setTarget(null)} address={address} provider={provider} onDone={onDone} />
    </div>
  );
}

const KIND: Readonly<Record<string, string>> = {
  subscribe: 'Subscribe', airdrop: 'Airdrop', deposit: 'Deposit', redeem: 'Redeem', liquidation: 'Liquidation', transfer_in: 'Transfer in', transfer_out: 'Transfer out',
};
const STATUS_TONE: Readonly<Record<string, string>> = { completed: 'pos', failed: 'neg', rejected: 'neg' };

function LedgerTable({ entries, names }: { entries: WealthEntry[]; names: Map<string, string> }) {
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
                  {e.claimable === true && <SodexLink href={sodexFundUrl(e.fundId)}>Claim on SoDEX</SodexLink>}
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

function History({ address, refreshToken, w, onOpenMarket, provider, onDone }: {
  address: string | null;
  refreshToken: number;
  w: WealthState;
  onOpenMarket: (symbol: string, engine: 'spot') => void;
  provider: Eip1193Provider | null;
  onDone: () => void;
}) {
  const { entries, plans, error } = useLedger(address, refreshToken);
  const names = useMemo(() => new Map((w.funds ?? []).map((f) => [f.fundId, fundLabel(f).name])), [w.funds]);
  const moving = (entries ?? []).filter((e) => e.status === 'processing' || e.claimable === true || e.delayedPending === true);
  const list = (rows: WealthEntry[] | null, none: string) => (
    !address ? <NoWallet line="Connect a wallet to see your Wealth history." compact />
      : error && !rows ? <ReadFailed what="Wealth history" error={error} />
      : !rows ? <div className="pfx-bones" aria-busy="true">{[0, 1, 2].map((i) => <span key={i} className="pfx-bone" />)}</div>
      : rows.length === 0 ? <EmptyState icon="history" title={none} compact />
      : <LedgerTable entries={rows} names={names} />
  );
  const tabs: PanelTab[] = [
    { key: 'holdings', label: 'Holdings', content: <WealthHoldings w={w} address={address} onOpenMarket={onOpenMarket} provider={provider} onDone={onDone} /> },
    { key: 'moving', label: `In progress${moving.length ? ` (${moving.length})` : ''}`, content: list(entries ? moving : null, 'Nothing in progress') },
    { key: 'history', label: 'History', content: list(entries, 'No Wealth history yet') },
    {
      key: 'plans',
      label: 'Recurring buys',
      content: !address ? <NoWallet line="Connect a wallet to see your recurring buys." compact />
        : !plans ? <div className="pfx-bones" aria-busy="true"><span className="pfx-bone" /></div>
        : plans.length === 0 ? <EmptyState icon="history" title="No recurring buys" line="SoDEX lets you set these up on its Wealth pages. They show here once they exist." compact action={<a className="empty-state__cta" href="https://sodex.com/wealth" target="_blank" rel="noopener noreferrer">Open SoDEX Wealth</a>} />
        : (
          <div className="pfx-tablewrap">
            <table className="acct-table acct-t pfx-table">
              <thead><tr><th>Fund</th><th>Every</th><th className="num">Amount</th><th className="num pfx-hide-phone">Buys</th><th className="num pfx-hide-phone">Next</th><th>Status</th></tr></thead>
              <tbody>
                {plans.map((p) => (
                  <tr key={p.planIndex}>
                    <td>{names.get(p.fundId ?? '') ?? p.share?.coin ?? p.target}</td>
                    <td>{p.planType.replace('_', '-').toLowerCase()}</td>
                    <td className="num">{fmtUsd(num(p.amount))}</td>
                    <td className="num pfx-hide-phone">{p.successfulExecutionCount}</td>
                    <td className="num pfx-hide-phone">{dayTime(p.nextScheduledAt)}</td>
                    <td><span className="bal-tag">{p.status.toLowerCase()}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ),
    },
  ];
  return <div className="dash pfx-plain"><PanelTabs tabs={tabs.map((t) => ({ ...t, content: <Card className="pf-card--band pfx-band">{t.content}</Card> }))} /></div>;
}

export function WealthTab({ w, value, slp, address, provider, refreshToken, onOpenMarket, onDone }: {
  w: WealthState;
  /** The Wealth bucket from summary.ts, so the tab and the Trade tab's breakdown cannot disagree. */
  value: number | null;
  slp: number | null;
  address: string | null;
  provider: Eip1193Provider | null;
  refreshToken: number;
  onOpenMarket: (symbol: string, engine: 'spot') => void;
  onDone: () => void;
}) {
  return (
    <div className="pfx-stack">
      <div className="pfx-top">
        <WealthValueCard w={w} value={value} slp={slp} />
        <WealthChart address={address} />
      </div>
      <History address={address} refreshToken={refreshToken} w={w} onOpenMarket={onOpenMarket} provider={provider} onDone={onDone} />
      <FundBoard w={w} address={address} provider={provider} onOpenMarket={onOpenMarket} onDone={onDone} />
    </div>
  );
}
