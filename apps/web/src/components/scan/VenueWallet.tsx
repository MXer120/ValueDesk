/**
 * Scan for a wallet on Hyperliquid, trade.xyz, Lighter or Arcus, in the Portfolio's layout (owner 2026-11-27: "Scan
 * page, i want the same layout as portfolio page, just without the earn & angepasste componenents for scan"). SoDEX
 * wallets get the Portfolio page itself in its scan mode (portfolio/wallet/Wallet.tsx `scan`); these venues have no
 * Spot, Wealth or SoDEX tables, so the same places hold what the venue's profile and fills say:
 *
 * - the card: the venue's account value, today's PnL, how the value moved over 7 days, where the money is (the venue
 *   account and the wallet on chain, each dollar once);
 * - Scan's keys (Copy, Counter, Name, Address);
 * - the accounts: the venue's (unrealised PnL, positions, open orders, the largest positions) and On-chain (the same
 *   address on every EVM chain, as the Portfolio reads it);
 * - the account-value chart, and Trading (the venue's performance card) where the Portfolio has Earn;
 * - fees and volume beside the PnL chart;
 * - the band: positions and history, and On-chain with its NFTs.
 */
import { useMemo, useState } from 'react';
import { Panel, Shell, ShellHeader, StatusPill, Tabs } from '../bots/kit/kit';
import { CoinIcon } from '../CoinIcon';
import { VenueLogo } from '../VenueLogo';
import { DASH, fmt, fmtUsd } from '../../format';
import { Private } from '../../privacy';
import { VENUE_LABEL, type Venue } from '../../vsApi';
import { HlActivityCard, HlPerformanceCard, HlPnlCard, HlValueCard, type HlState } from './HlCards';
import { VenueBand } from './VenueBand';
import { AllocBar, AllocLegend, Fig, ViewAll, shortAddr, signedUsd, tone, useMasks } from '../portfolio/wallet/blocks';
import { ValueMove } from '../portfolio/wallet/Wallet';
import { OnchainPanel, TokenIcon } from '../portfolio/wallet/Onchain';
import { useOnchain } from '../portfolio/wallet/useOnchain';
import type { Bucket, Part } from '../portfolio/wallet/data';
import { aliasFor } from '../../dashboard/scanAliases';
import { fmtCompactUsd } from '../portfolio/parts';

/** A signed figure that fits the card: compact past $100k (a whale's week is millions). */
const signedFit = (v: number) => (Math.abs(v) >= 100_000 ? `${v < 0 ? '−' : '+'}${fmtCompactUsd(Math.abs(v))}` : signedUsd(v));
import '../bots/kit/kit.css';
import '../bots/botsPages.css';
import '../portfolio/wallet/wallet.css';

type Tab = 'venue' | 'onchain';
const ROWS = 4;

export function VenueWallet({ hl, venue, address, keys }: { hl: HlState; venue: Venue; address: string; keys: React.ReactNode }) {
  const m = useMasks();
  const p = hl.trader.data;
  const s = p?.summary ?? null;
  const name = VENUE_LABEL[venue];
  const o = useOnchain({ address, readOnly: true });
  const [open, setOpen] = useState<Bucket | null>('perps');
  const [tab, setTab] = useState<Tab>('venue');
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

  const card = (
    <section className="pfv3-card" aria-label="Account value">
      <div className="pfv3-card__top">
        <span className="pfv3-card__brand"><VenueLogo venue={venue} size={18} />{name}</span>
        <span className="pfv3-card__tr">
          <span className="pfv-id">
            <i className="pfv-id__dot" aria-hidden="true" />
            <span className="pfv-id__a">{alias || s?.label || m.address(shortAddr(address))}</span>
            <StatusPill size="sm" tone="neutral">View only</StatusPill>
          </span>
        </span>
      </div>
      <span className="pfv3-card__k">Total value</span>
      <b className="pfv3-card__v">{total === null ? (loading ? '…' : DASH) : m.equity(fmtUsd(total))}</b>
      <div className="pfv3-card__row">
        <StatusPill tone={today === null || Math.abs(today) < 0.005 ? 'neutral' : today > 0 ? 'positive' : 'negative'} icon={today !== null && today < 0 ? 'down' : 'up'}>{m.pnl(today === null ? signedUsd(today) : signedFit(today))} today</StatusPill>
        {week.length > 1 && (
          <span className="pfv3-card__spark" title={`Account value over the last 7 days, from its first point (${name}'s own series)`}>
            <Private k="charts"><ValueMove values={week} /></Private>
            <span className="pfv3-card__sparkt"><b className={tone(week[week.length - 1]! - week[0]!)}>{m.funds(signedFit(week[week.length - 1]! - week[0]!))}</b><small>7 days</small></span>
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
          <Fig k="Unrealized" v={m.pnl(signedUsd(unrealized))} cls={tone(unrealized)} />
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

  const accounts = (
    <Shell className="pfv3-accounts">
      <ShellHeader title="Accounts" subtitle="Each dollar counted once" />
      <Panel className="pfv-pad0">
        <AllocLegend d={{ parts, evmLoading: o.loading && o.total === null }} open={open} onPick={(k) => setOpen(open === k ? null : k)} drawer={drawer} />
      </Panel>
    </Shell>
  );

  return (
    <div className="tf bots-page pfv pfv3 pfv-scan">
      <h1 className="pfv-h1">Scan</h1>
      <div className="bots-col pfv3-col">
        <div className="pfv3-split">
          <div className="pfv3-left">{card}<div className="pfv3-keys">{keys}</div>{accounts}</div>
          <div className="pfv3-right">
            <div className="pf pfx pfv3-chart"><HlValueCard hl={hl} /></div>
            <div className="pf pfx pfv3-hlcard pfv3-trading"><HlPerformanceCard hl={hl} /></div>
          </div>
        </div>
        <div className="pfv3-pair">
          <div className="pf pfx pfv3-hlcard"><HlActivityCard hl={hl} /></div>
          <div className="pf pfx pfv3-hlcard"><HlPnlCard hl={hl} /></div>
        </div>
        <Shell className="pfv3-band">
          <div className="pfv3-band__bar">
            <div className="pfv-sectabs2">
              <Tabs tabs={[{ value: 'venue', label: `${name}: positions and history` }, { value: 'onchain', label: 'On-chain' }]} value={tab} onChange={setTab} label="Accounts" className="pfv-sectabs" />
            </div>
          </div>
          <Panel className={`pfv3-band__body${tab === 'onchain' ? ' is-grow' : ''}`}>
            {tab === 'venue' ? <div className="pf pfx pfv3-hlband"><VenueBand hl={hl} /></div> : <div className="pfv-pad"><OnchainPanel o={o} /></div>}
          </Panel>
        </Shell>
      </div>
    </div>
  );
}
