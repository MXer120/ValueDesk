/**
 * The top of the Wealth page. Owner 2026-11-28: the Shelves version's stage, smaller; then "Wealth element is too
 * small. And should be on the left": the wallet's Wealth comes first, as a full card (value, 24h, PnL, the change over
 * the picked range on the Portfolio's own chart, and what the Wealth is made of), and the stage with the live Stable
 * Earn rates beside it. Every action stays on ValueDesk: a rate's Invest opens the page's own sheet (WealthTab listens
 * for openWealth), never sodex.com.
 */
import { useMemo, useState } from 'react';
import { CoinIcon } from '../CoinIcon';
import { openConnectDialog } from '../account/connect';
import { ReadFailed } from '../AccountHistory';
import { useAsync } from '../../hooks';
import { DASH, MINUS, fmtUsd, num } from '../../format';
import { useMask } from '../../privacy';
import { readPnlHistory, type PnlRange } from '../../trading/wealth';
import { EARN_FUND } from '../../trading/wealthEarn';
import { Card, EquityCurve, type CurveWindow } from './parts';
import { pledgedValue } from '../sodex/wealth/parts';
import { ViewSeg } from './RangePicker';
import type { WealthState } from './useWealth';
import type { RecurringSheetTarget } from './RecurringBuys';
import './wealthHero.css';

/** What the page's sheets can be opened for, from anywhere on the page (WealthTab listens). */
export type WealthOpen =
  | { kind: 'earn'; side: 'buy' | 'sell' }
  | { kind: 'recurring'; fundId?: string }
  | { kind: 'vault'; fundId: string; side: 'buy' | 'sell' }
  /** Any of the recurring sheet's views: a plan's change, pause, resume, end or history, the balance in or out. */
  | { kind: 'recurring-sheet'; target: RecurringSheetTarget };
export const WEALTH_OPEN_EVENT = 'vs:wealth-open';
export const openWealth = (o: WealthOpen) => window.dispatchEvent(new CustomEvent<WealthOpen>(WEALTH_OPEN_EVENT, { detail: o }));

const signed = (v: number): string => `${v > 0 ? '+' : v < 0 ? MINUS : ''}${fmtUsd(Math.abs(v))}`;
const tone = (v: number | null) => (v === null || v === 0 ? '' : v > 0 ? 'pos' : 'neg');

function Rate({ coin, name, sub, apy, onInvest }: { coin: string; name: string; sub: string; apy: string | undefined; onInvest: () => void }) {
  const v = apy !== undefined && Number.isFinite(Number(apy)) ? Number(apy) : null;
  return (
    <div className="wh-rate">
      <CoinIcon coin={coin} size={30} />
      <span className="wh-rate__n"><b>{name}</b><small>{sub}</small></span>
      <b className="wh-rate__v">{v === null ? DASH : `${v.toFixed(2)}%`}</b>
      <button type="button" className="wh-btn" onClick={onInvest}>Invest</button>
    </div>
  );
}

export function WealthStage({ w, maintenance, onOpenMarket }: { w: WealthState; maintenance: boolean; onOpenMarket: (symbol: string, engine: 'spot') => void }) {
  const earn = w.quotes.get(EARN_FUND);
  const boxx = w.quotes.get('vBOXX');
  const boxxSymbol = w.funds?.find((f) => f.fundId === 'vBOXX')?.spot?.symbol ?? 'vBOXX_vUSDC';
  return (
    <section className="wh-stage" aria-label="Wealth">
      <span className="wh-stage__light" aria-hidden="true" /><span className="wh-stage__ribs" aria-hidden="true" />
      <div className="wh-stage__t">
        <p className="wh-stage__k">Wealth{maintenance && <span className="wh-pill">Maintenance</span>}</p>
        <h1>Yield on dollars.<br />Index funds on-chain.</h1>
        <p>Tokenised funds, vaults, ValueDesk indexes and on-chain yield, all in one place.</p>
      </div>
      <div className="wh-rates" aria-label="Stable Earn, live rates">
        <p className="wh-rates__k">Stable Earn · live 7-day APY</p>
        <Rate coin="USDC" name="USDC Earn" sub={earn?.yieldBasis === 'net_excluding_rewards' ? 'Morpho on Base, net' : 'Morpho on Base'} apy={earn?.apy7d} onInvest={() => openWealth({ kind: 'earn', side: 'buy' })} />
        <Rate coin="vBOXX" name="US Cash Yield" sub="T-bill box spreads, in the price" apy={boxx?.apy7d} onInvest={() => onOpenMarket(boxxSymbol, 'spot')} />
      </div>
    </section>
  );
}

const RANGES: ReadonlyArray<readonly [PnlRange, string]> = [['1W', '7d'], ['1M', '30d'], ['3M', '90d'], ['1Y', '1y'], ['All', 'All']];
/** A flat line's length per range; All with no history at all is a month. */
const RANGE_DAYS: Readonly<Record<PnlRange, number>> = { '1W': 7, '1M': 30, '3M': 90, '1Y': 365, All: 30 };
/** The allocation names this many holdings, each in its own colour; the rest share one gray. */
const ALLOC_SHOWN = 4;
const fundIcon = (coin: string): string => (/^v?soUSDC$/i.test(coin) ? 'USDC' : coin);

/**
 * The wallet's Wealth: the Wealth bucket from summary.ts (so it matches the Portfolio), SoDEX's PnL, SoDEX's value
 * series over the picked range on the Portfolio's chart, and the holdings by value.
 */
export function WealthCard({ w, value, address }: { w: WealthState; value: number | null; address: string | null }) {
  const maskEquity = useMask('equity');
  const maskPnl = useMask('pnl');
  const maskFunds = useMask('funds');
  const [range, setRange] = useState<PnlRange>('1M');
  const hist = useAsync(() => readPnlHistory(address!, range), [address, range], { enabled: !!address });
  const win = useMemo((): CurveWindow | null => {
    const pts = (hist.data ?? [])
      .map((p) => ({ t: typeof p.ts === 'number' ? (p.ts < 1e12 ? p.ts * 1000 : p.ts) : Date.parse(p.ts), v: num(p.totalValue) }))
      .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v));
    if (pts.length >= 2) return { points: pts, baseline: pts[0]!.v, change: pts[pts.length - 1]!.v - pts[0]!.v, maxDrawdown: null };
    // Nothing in this range yet (owner 2026-11-28: "if theres no data just keep it flat"): the value it has now, level
    // across the range, so the card keeps the Portfolio's chart instead of a hole.
    if (!hist.data) return null;
    const end = Date.now();
    const level = pts[0]?.v ?? value ?? 0;
    return { points: [{ t: end - RANGE_DAYS[range] * 86_400_000, v: level }, { t: end, v: level }], baseline: level, change: 0, maxDrawdown: null };
  }, [hist.data, range, value]);
  const alloc = useMemo(() => {
    const rows = (w.holdings ?? [])
      .map((h) => ({ id: h.fundId, name: h.name, coin: fundIcon(h.coin), v: h.marketValue ?? 0 }))
      .filter((r) => r.v > 0)
      .sort((a, b) => b.v - a.v);
    const total = rows.reduce((s, r) => s + r.v, 0);
    if (total <= 0) return null;
    const shown = rows.slice(0, ALLOC_SHOWN).map((r, i) => ({ ...r, c: i + 1 }));
    const rest = rows.slice(ALLOC_SHOWN);
    const restV = rest.reduce((s, r) => s + r.v, 0);
    return { total, rows: rest.length ? [...shown, { id: '_rest', name: `${rest.length} more`, coin: '', v: restV, c: 0 }] : shown };
  }, [w.holdings]);
  const p = w.pnl;
  const d24 = p?.totalPnl24h !== undefined ? num(p.totalPnl24h) : null;
  const pnl = p?.totalPnl !== undefined ? num(p.totalPnl) : null;
  const inFlight = p?.inFlightValue !== undefined ? num(p.inFlightValue) : 0;
  const change = win?.change ?? null;
  // Shares pledged as Perps margin count in Futures (each dollar once), but SoDEX's value series holds them.
  const pledged = pledgedValue(w.holdings);
  const rangeWord = RANGES.find(([k]) => k === range)?.[1] ?? range;

  if (!address) {
    return (
      <Card className="wh-card wh-card--empty" title="Your Wealth">
        <div className="wh-card__connect">
          <p>Connect a wallet to see your Wealth value, PnL and holdings here.</p>
          <button type="button" className="pf-btn" onClick={() => openConnectDialog()}>Connect wallet</button>
        </div>
      </Card>
    );
  }
  return (
    <Card className="pf-card--chart pfx-chart wh-card" title="Your Wealth" action={<ViewSeg value={range} options={RANGES} onChange={setRange} label="Timeframe" />}>
      <div className="wh-card__fig">
        <div className="wh-card__vbox">
          <b className="wh-card__v">{maskEquity(value === null ? DASH : fmtUsd(value))}</b>
          {pledged > 0 && <small className="wh-card__sub">+{maskEquity(fmtUsd(pledged))} pledged as Perps margin</small>}
        </div>
        <dl className="wh-card__kv">
          <div><dt>24h</dt><dd className={tone(d24)}>{maskPnl(d24 === null ? DASH : signed(d24))}</dd></div>
          <div><dt>{`Change, ${rangeWord}`}</dt><dd className={tone(change)}>{maskPnl(change === null ? DASH : signed(change))}</dd></div>
          <div><dt>Total PnL</dt><dd className={tone(pnl)}>{maskPnl(pnl === null ? DASH : signed(pnl))}</dd></div>
          {inFlight > 0 && <div><dt>On its way</dt><dd>{maskFunds(fmtUsd(inFlight))}</dd></div>}
        </dl>
      </div>
      {hist.error && !hist.data ? <div className="pf-chart pf-chart--empty"><ReadFailed what="Wealth history" error={hist.error} onRetry={hist.refresh} /></div>
        : hist.loading && !hist.data ? <div className="pf-chart pf-chart--empty"><p><span className="pf-spin" aria-hidden="true" />Reading</p></div>
        : win ? <EquityCurve win={win} tone="equity" level compactAxis clean privacy="funds" />
        : <div className="pf-chart pf-chart--empty"><p><span className="pf-spin" aria-hidden="true" />Reading</p></div>}
      {alloc && (
        <div className="wh-alloc" aria-label="What your Wealth holds">
          <div className="wh-alloc__bar" aria-hidden="true">
            {alloc.rows.map((r) => <span key={r.id} className={`wh-c${r.c}`} style={{ flexGrow: r.v }} />)}
          </div>
          <ul className="wh-alloc__list">
            {alloc.rows.map((r) => (
              <li key={r.id}>
                <i className={`wh-alloc__dot wh-c${r.c}`} aria-hidden="true" />
                {r.coin ? <CoinIcon coin={r.coin} size={16} /> : null}
                <span>{r.name}</span>
                <b>{maskFunds(fmtUsd(r.v))}</b>
                <em>{`${((r.v / alloc.total) * 100).toFixed(r.v / alloc.total < 0.1 ? 1 : 0)}%`}</em>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
