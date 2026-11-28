/**
 * Scan for a wallet on Hyperliquid, trade.xyz, Lighter or Arcus, in the Portfolio's layout (owner 2026-11-27: "Scan
 * page, i want the same layout as portfolio page, just without the earn & angepasste componenents for scan"; round 2,
 * 2026-11-28: the Portfolio's charts and switches, one chart on top with PnL first and a real height, Performance
 * redesigned, card and accounts one element, shares that show exactly what is on screen). SoDEX wallets get the
 * Portfolio page itself in its scan mode (portfolio/wallet/Wallet.tsx `scan`); these venues fill the same places from
 * the venue's profile and fills:
 *
 * - card and accounts, one element: the total (the venue account plus the address on chain), today, how the value
 *   moved over 7 days, where the money is; then the venue's account (unrealised PnL, positions, open orders, the
 *   largest positions) and On-chain;
 * - the chart (the Portfolio's: its picker, its timeframe switch, its curve): PnL or Total value, PnL first;
 * - Trading, Standing and Volume as the Portfolio's figure grids;
 * - the band: positions and history, and On-chain with its NFTs.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { Panel, Segmented, Shell, ShellHeader, Skeleton, StatusPill, Tabs } from '../bots/kit/kit';
import { CoinIcon } from '../CoinIcon';
import { VenueLogo } from '../VenueLogo';
import { DASH, fmt, fmtUsd, signClass } from '../../format';
import { Private, useMask } from '../../privacy';
import { useStored } from '../../hooks';
import { VENUE_LABEL, type Venue, type Window } from '../../vsApi';
import type { HlState } from './HlCards';
import { VenueBand } from './VenueBand';
import { windowCurve } from './hlModel';
import { fmtAgo } from '../copy/TraderCard';
import { Card, EquityCurve, fmtCompactUsd } from '../portfolio/parts';
import { RangePicker, ViewSeg } from '../portfolio/RangePicker';
import { atLevel, type ShareAs } from '../portfolio/PortfolioPage';
import { fmtSigned } from '../Portfolio';
import { ShareButton } from '../share/host';
import { AllocBar, AllocLegend, Fig, ViewAll, shortAddr, signedUsd, tone, useMasks } from '../portfolio/wallet/blocks';
import { ValueMove } from '../portfolio/wallet/Wallet';
import { OnchainPanel, TokenIcon } from '../portfolio/wallet/Onchain';
import { useOnchain } from '../portfolio/wallet/useOnchain';
import { useNftCollections } from '../portfolio/wallet/nfts';
import type { Bucket, Part } from '../portfolio/wallet/data';
import { aliasFor } from '../../dashboard/scanAliases';
import '../bots/kit/kit.css';
import '../bots/botsPages.css';
import '../portfolio/wallet/wallet.css';

type Tab = 'venue' | 'onchain';
type View = 'pnl' | 'value';
const ROWS = 4;

/** A signed figure that fits: compact past $100k (a whale's week is millions). */
const signedFit = (v: number) => (Math.abs(v) >= 100_000 ? `${v < 0 ? '−' : '+'}${fmtCompactUsd(Math.abs(v))}` : signedUsd(v));

/* The Portfolio's chart choices and timeframes, over the venue's windows. */
const VIEWS: ReadonlyArray<readonly [View, string]> = [['pnl', 'PnL'], ['value', 'Total Value']];
const WINS: ReadonlyArray<readonly [Window, string]> = [['1d', '24h'], ['7d', '7d'], ['30d', '30d'], ['all', 'All time']];
const WIN_WORDS: Record<Window, string> = { '1d': '24h', '7d': '7d', '30d': '30d', all: 'all time' };
const WIN_RANGE: Record<Window, string> = { '1d': '24H', '7d': '7D', '30d': '30D', all: 'ALL' };

/** The chart on top: one card, PnL first (owner 2026-11-28: "1 chart at the top with total value, pnl, .. switch"). */
function VenueChart({ hl, address, shareAs }: { hl: HlState; address: string; shareAs: ShareAs }) {
  const [view, setView] = useStored<View>('vs.scan.venue.view', 'pnl');
  const [win, setWin] = useStored<Window>('vs.scan.venue.window', '30d');
  const p = hl.trader.data;
  const curve = p ? windowCurve(p.equity, win, view === 'value' ? 'accountValue' : 'pnl') : null;
  const mask = useMask(view === 'value' ? 'funds' : 'pnl');
  const empty = (body: ReactNode) => <div className="pf-chart pf-chart--empty"><p>{body}</p></div>;
  return (
    <Card
      className="pf-card--chart pfx-chart"
      title={<RangePicker value={view} options={VIEWS} onChange={setView} label="Chart" align="start" />}
      action={(
        <span className="pfx-chart__acts">
          {curve && curve.change !== null && (
            <ShareButton
              label={view === 'value' ? 'Share this chart' : 'Share this PnL'}
              make={(b) => b.portfolioCard({
                range: WIN_RANGE[win], change: curve.change!, ys: curve.points.map((x) => x.v), trades: null, volume: null,
                value: p?.summary.accountValue ?? null, wallet: address, view, ...shareAs,
              })}
            />
          )}
          <ViewSeg value={win} options={WINS} onChange={setWin} label="Timeframe" />
        </span>
      )}
    >
      {curve && curve.change !== null && (
        <div className="pfx-chart__head">
          <span>{view === 'value' ? 'Change in value' : 'PnL'}, {WIN_WORDS[win]}</span>
          <b className={view === 'pnl' ? signClass(curve.change) : undefined}>{mask(fmtSigned(curve.change))}</b>
        </div>
      )}
      {!p ? (hl.trader.loading || !hl.trader.settled ? empty(<><span className="pf-spin" aria-hidden="true" />Reading</>) : empty(hl.trader.error ?? 'No history for this wallet.'))
        : curve && curve.points.length > 1
          ? <EquityCurve win={view === 'value' ? atLevel(curve) : curve} tone={view === 'value' ? 'equity' : 'pnl'} level={view === 'value'} compactAxis clean privacy={view === 'value' ? 'funds' : 'pnl'} />
          : empty(`No ${view === 'value' ? 'account value' : 'PnL'} history in ${win === 'all' ? 'this history' : `the last ${WIN_WORDS[win]}`}.`)}
    </Card>
  );
}

function Cell({ k, v, s, cls, title }: { k: string; v: ReactNode; s?: ReactNode; cls?: string; title?: string }) {
  return (
    <div className="pfv-sum__cell" title={title}>
      <span className="pfv-sum__k">{k}</span>
      <b className={`pfv-sum__v${cls ? ` ${cls}` : ''}`}>{v}</b>
      {s && <span className="pfv-sum__s">{s}</span>}
    </div>
  );
}

/** Trading, as the Portfolio's: one window, four figures (owner 2026-11-28: "Performance element needs redesign"). */
function VenueTrading({ hl }: { hl: HlState }) {
  const m = useMasks();
  const [win, setWin] = useStored<Window>('vs.scan.venue.trading', '30d');
  const p = hl.trader.data;
  const s = p?.summary ?? null;
  const curve = p ? windowCurve(p.equity, win, 'pnl') : null;
  const pnl = s?.pnl[win] ?? curve?.change ?? null;
  const roi = s?.roi[win] ?? null;
  const vol = s?.volume[win] ?? null;
  const dd = curve?.maxDrawdown ?? null;
  const wait = <Skeleton className="pfv-skel-num" />;
  const ready = !!p;
  return (
    <Shell className="pfv3-trading">
      <ShellHeader title="Trading" />
      <div className="pfv3-range"><Segmented options={WINS.map(([value, label]) => ({ value, label: value === 'all' ? 'All' : label }))} value={win} onChange={setWin} label="Timeframe" /></div>
      <Panel className="pfv-pad">
        <div className="pfv-sum is-grid">
          <Cell k="PnL" v={ready ? m.pnl(signedFit(pnl ?? 0)) : wait} cls={tone(pnl)} s={roi !== null ? <>ROI <span className={tone(roi)}>{m.pnl(`${roi >= 0 ? '+' : '−'}${fmt(Math.abs(roi) * 100, 2)}%`)}</span></> : undefined} />
          <Cell k="Volume" v={ready ? (vol === null ? DASH : m.funds(fmtCompactUsd(vol))) : wait} s={s?.trades ? `${m.counts(fmt(s.trades, 0))} closing trades${s.tradesCapped ? '+' : ''}` : undefined} />
          <Cell k="Max drawdown" v={ready ? (dd === null ? DASH : m.pnl(signedFit(dd))) : wait} cls={dd !== null && dd < 0 ? 'neg' : undefined} s={s?.sharpe !== null && s?.sharpe !== undefined ? `Sharpe ${fmt(s.sharpe, 2)}` : undefined} title="The biggest fall from a peak to a later low of this window's PnL curve." />
          <Cell k="Win rate" v={ready ? (s?.winRate === null || s?.winRate === undefined ? DASH : `${fmt(s.winRate * 100, 1)}%`) : wait} s={s?.winRate !== null && s?.winRate !== undefined && s.winRateCloses ? `${s.winRateExact ? '' : 'about, '}from ${m.counts(fmt(s.winRateCloses, 0))} closes` : undefined} />
        </div>
      </Panel>
    </Shell>
  );
}

/** Where the wallet stands on the venue's own board, and when it last traded. */
function VenueStanding({ hl, venue }: { hl: HlState; venue: Venue }) {
  const m = useMasks();
  const s = hl.trader.data?.summary ?? null;
  const ready = !!hl.trader.data;
  const wait = <Skeleton className="pfv-skel-num" />;
  const ch = s?.rankChange ?? null;
  return (
    <Shell className="pfv3-standing">
      <ShellHeader title="Standing" subtitle={`${VENUE_LABEL[venue]}'s own leaderboard`} />
      <Panel className="pfv-pad">
        <div className="pfv-sum is-grid">
          <Cell k="Rank, 30 days" v={ready ? (s?.rank ? `#${fmt(s.rank, 0)}` : 'Not ranked') : wait} s={ch ? <span className={ch > 0 ? 'pos' : 'neg'}>{ch > 0 ? `Up ${ch}` : `Down ${-ch}`} since yesterday</span> : undefined} />
          <Cell k="PnL, 30 days" v={ready ? m.pnl(signedFit(s?.pnl['30d'] ?? 0)) : wait} cls={tone(s?.pnl['30d'])} />
          <Cell k="PnL, all time" v={ready ? (s?.pnl.all === null || s?.pnl.all === undefined ? DASH : m.pnl(signedFit(s.pnl.all))) : wait} cls={tone(s?.pnl.all)} />
          <Cell k="Last active" v={ready ? (s?.lastActive ? fmtAgo(s.lastActive) : DASH) : wait} />
        </div>
      </Panel>
    </Shell>
  );
}

function VenueVolume({ hl }: { hl: HlState }) {
  const m = useMasks();
  const s = hl.trader.data?.summary ?? null;
  const ready = !!hl.trader.data;
  const wait = <Skeleton className="pfv-skel-num" />;
  const v = (w: Window) => (ready ? (s?.volume[w] === null || s?.volume[w] === undefined ? DASH : m.funds(fmtCompactUsd(s.volume[w]))) : wait);
  return (
    <Shell className="pfv3-fees">
      <ShellHeader title="Volume" subtitle="Traded, as the venue counts it" />
      <Panel className="pfv-pad">
        <div className="pfv-sum is-grid">
          <Cell k="24 hours" v={v('1d')} />
          <Cell k="7 days" v={v('7d')} />
          <Cell k="30 days" v={v('30d')} />
          <Cell k="All time" v={v('all')} />
        </div>
      </Panel>
    </Shell>
  );
}

export function VenueWallet({ hl, venue, address, shareAs }: { hl: HlState; venue: Venue; address: string; shareAs: ShareAs }) {
  const m = useMasks();
  const p = hl.trader.data;
  const s = p?.summary ?? null;
  const name = VENUE_LABEL[venue];
  const o = useOnchain({ address, readOnly: true });
  const [open, setOpen] = useState<Bucket | null>('perps');
  const [tab, setTab] = useState<Tab>('venue');
  const nfts = useNftCollections(address, tab === 'onchain');
  const value = s?.accountValue ?? null;
  const today = s?.pnl['1d'] ?? null;
  const week = useMemo(() => (p?.equity['7d'] ?? []).map((e) => e.accountValue).filter((v): v is number => v !== null && Number.isFinite(v)), [p]);
  const positions = useMemo(() => [...(p?.positions ?? [])].sort((a, b) => Math.abs(b.notional) - Math.abs(a.notional)), [p]);
  const unrealized = positions.length ? positions.reduce((a, x) => a + (x.uPnl ?? 0), 0) : null;
  const total = value === null && o.total === null ? null : (value ?? 0) + (o.total ?? 0);
  const parts: Part[] = [
    { key: 'perps', label: name, line: 'Perps account', usd: value, share: total && value !== null ? Math.max(0, value) / total : null },
    { key: 'evm', label: 'On-chain', line: 'The same address, every chain', usd: o.total, share: total && o.total !== null ? o.total / total : null },
  ];
  const alias = aliasFor(address);
  const goBand = (t: Tab) => { setTab(t); requestAnimationFrame(() => document.querySelector('.pfv3-band')?.scrollIntoView({ behavior: 'smooth', block: 'start' })); };
  const loading = hl.trader.loading && !p;
  const moved = week.length > 1 ? week[week.length - 1]! - week[0]! : null;

  const card = (
    <section className="pfv3-card" aria-label="Total value">
      <div className="pfv3-card__top">
        <span className="pfv3-card__brand"><VenueLogo venue={venue} size={18} />{name}</span>
        <span className="pfv3-card__tr">
          <span className="pfv-id">
            <i className="pfv-id__dot" aria-hidden="true" />
            <span className="pfv-id__a">{alias || s?.label || m.address(shortAddr(address))}</span>
            <StatusPill size="sm" tone="neutral">View only</StatusPill>
          </span>
          {moved !== null && (
            <ShareButton
              label="Share this card"
              make={(b) => b.portfolioCard({ range: '7D', change: moved, ys: week.map((v) => v - week[0]!), trades: null, volume: null, value: total, wallet: address, view: 'value', ...shareAs })}
            />
          )}
        </span>
      </div>
      <span className="pfv3-card__k">Total value</span>
      <b className="pfv3-card__v">{total === null ? (loading ? '…' : DASH) : m.equity(fmtUsd(total))}</b>
      <div className="pfv3-card__row">
        <StatusPill tone={today === null || Math.abs(today) < 0.005 ? 'neutral' : today > 0 ? 'positive' : 'negative'} icon={today !== null && today < 0 ? 'down' : 'up'}>{m.pnl(today === null ? signedUsd(today) : signedFit(today))} today</StatusPill>
        {moved !== null && (
          <span className="pfv3-card__spark" title={`Account value over the last 7 days, from its first point (${name}'s own series)`}>
            <Private k="charts"><ValueMove values={week} /></Private>
            <span className="pfv3-card__sparkt"><b className={tone(moved)}>{m.funds(signedFit(moved))}</b><small>7 days</small></span>
          </span>
        )}
      </div>
      <AllocBar parts={parts} size="sm" />
    </section>
  );

  const drawer = (k: Bucket) => {
    if (k === 'evm') {
      const rows = o.counted.slice(0, ROWS);
      return (
        <div className="pfv3-in">
          {rows.length === 0 ? <p className="pfv-quiet">{o.loading ? 'Reading the chains…' : 'Nothing on chain.'}</p> : (
            <ul className="pfv-coins">
              {rows.map((h) => (
                <li key={`${h.chain}|${h.token}|${h.symbol}`}>
                  <TokenIcon symbol={h.symbol} chainIcon={h.chainIcon} size={24} />
                  <span className="pfv-coins__t">{h.symbol}<small>{h.chainLabel}</small></span>
                  <b>{m.funds(fmtUsd(h.usd))}</b>
                </li>
              ))}
            </ul>
          )}
          {o.counted.length > ROWS && <ViewAll label={`View all ${o.counted.length} on chain`} onClick={() => goBand('onchain')} />}
        </div>
      );
    }
    return (
      <div className="pfv3-in">
        <div className="pfv3-in__stats">
          <Fig k="Unrealized" v={m.pnl(unrealized === null ? signedUsd(unrealized) : signedFit(unrealized))} cls={tone(unrealized)} />
          <Fig k="Positions" v={p ? m.counts(fmt(positions.length, 0)) : DASH} />
          <Fig k="Open orders" v={p?.openOrders === null || p?.openOrders === undefined ? DASH : m.counts(fmt(p.openOrders, 0))} />
        </div>
        {positions.length > 0 && (
          <ul className="pfv-coins">
            {positions.slice(0, ROWS - 1).map((x) => (
              <li key={`${x.symbol}:${x.side}`}>
                <span className="pfv-coins__ic"><CoinIcon coin={x.symbol} venue={venue} size={24} /></span>
                <span className="pfv-coins__t">{x.symbol}<small><span className={x.side === 'long' ? 'pos' : 'neg'}>{x.side === 'long' ? 'Long' : 'Short'}</span>{x.leverage ? ` · ${fmt(x.leverage, 0)}x` : ''}</small></span>
                <b>{m.funds(fmtUsd(Math.abs(x.notional)))}</b>
              </li>
            ))}
          </ul>
        )}
        {positions.length > ROWS - 1 && <ViewAll label={`View all ${positions.length} positions`} onClick={() => goBand('venue')} />}
      </div>
    );
  };

  // Card and accounts, one element (owner 2026-11-28: "In scan the card & accounts element should be combined").
  const combo = (
    <div className="pfv3-combo">
      {card}
      <Shell className="pfv3-accounts">
        <ShellHeader title="Accounts" subtitle="Each dollar counted once" />
        <Panel className="pfv-pad0">
          <AllocLegend d={{ parts, evmLoading: o.loading && o.total === null }} open={open} onPick={(k) => setOpen(open === k ? null : k)} drawer={drawer} />
        </Panel>
      </Shell>
    </div>
  );

  return (
    <div className="tf bots-page pfv pfv3 pfv-scan">
      <h1 className="pfv-h1">Scan</h1>
      <div className="bots-col pfv3-col">
        <div className="pfv3-split">
          <div className="pfv3-left">{combo}</div>
          <div className="pfv3-right">
            <div className="pf pfx pfv3-chart"><VenueChart hl={hl} address={address} shareAs={shareAs} /></div>
            <VenueTrading hl={hl} />
          </div>
        </div>
        <div className="pfv3-pair"><VenueStanding hl={hl} venue={venue} /><VenueVolume hl={hl} /></div>
        <Shell className="pfv3-band">
          <div className="pfv3-band__bar">
            <div className="pfv-sectabs2">
              <Tabs tabs={[{ value: 'venue', label: `${name}: positions and history` }, { value: 'onchain', label: 'On-chain' }]} value={tab} onChange={setTab} label="Accounts" className="pfv-sectabs" />
            </div>
          </div>
          <Panel className={`pfv3-band__body${tab === 'onchain' ? ' is-grow' : ''}`}>
            {tab === 'venue' ? <div className="pf pfx pfv3-hlband"><VenueBand hl={hl} /></div> : <div className="pfv-pad"><OnchainPanel o={o} nfts={nfts} shareAs={shareAs} /></div>}
          </Panel>
        </Shell>
      </div>
    </div>
  );
}
