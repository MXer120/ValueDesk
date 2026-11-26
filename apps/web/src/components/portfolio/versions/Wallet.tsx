/**
 * The portfolio as a wallet (localhost only), in three arrangements (owner 2026-11-26: "give me 2 other versions of
 * 4wallet, remove 2 & 3"). Every arrangement draws the same parts:
 *
 * - the card: total value, today, how the value moved over 7 days (a line from 0, green above it and red below), where
 *   the money is, and a share button;
 * - the four keys (Deposit, Withdraw, Transfer, Swap);
 * - the accounts, each opened in place to what it holds;
 * - the value / PnL / calendar chart as today's page draws it (owner: "use the chart from original");
 * - earn and automate, trading, fees, margin;
 * - every table, by account (copies and bots as lists of their own).
 *
 *   Wallet  two columns: the card and the accounts on the left, the chart, earn and trading on the right.
 *   Stack   one column, as a wallet app on a phone, on every screen.
 *   Banner  the card and the chart side by side across the top, the accounts as four tiles under them.
 *
 * Wealth is a view of its own, opened from its account and left with Back.
 */
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { Button, Icon, Panel, Shell, ShellHeader, StatusPill } from '../../bots/kit/kit';
import { PortfolioMargin } from '../../bots/Allocation';
import { BrandMark } from '../../BrandMark';
import type { Period } from '../../Portfolio';
import { ChartCard, curveFor } from '../PortfolioPage';
import { SwapSheet } from '../SwapSheet';
import { DASH, fmtUsd } from '../../../format';
import { useStored } from '../../../hooks';
import { useTilt } from '../../../tilt';
import { Private } from '../../../privacy';
import type { VersionProps } from './DevVersions';
import { usePfData, type Bucket, type PfData } from './data';
import {
  AllocBar, AllocLegend, AllocationNote, ApyFig, Band, EngineSwitch, EvmList, Exposure, FeeRates, Fig, Identity, ManageCopies, MarginMeter,
  MoneyKeys, RangeSwitch, SectionTabs, SharePnl, SpotList, TradeSummary, CopiesPanel, BotsPanel,
  health, signedUsd, tone, useMasks, useOffers, type Section,
} from './blocks';
import { Holdings, WealthArea } from './WealthArea';
import type { PortfolioContext } from '../../Portfolio';

type View = 'home' | 'wealth';
export type WalletLayout = 'wallet' | 'stack' | 'banner';

/** What one account holds, opened in place under its row. */
function Inside({ k, d, c, onWealth, onOpenMarket, provider }: { k: Bucket; d: PfData; c: PortfolioContext; onWealth: () => void } & Pick<VersionProps, 'onOpenMarket' | 'provider'>) {
  const m = useMasks();
  const h = health(c);
  if (k === 'perps') {
    return (
      <div className="pfv3-in">
        <div className="pfv3-in__figs">
          <Fig k="Available" v={m.funds(h.available === null ? DASH : fmtUsd(h.available))} />
          <Fig k="Withdrawable" v={m.funds(h.withdrawable === null ? DASH : fmtUsd(h.withdrawable))} />
          <Fig k="Unrealized" v={m.pnl(signedUsd(h.unrealized))} cls={tone(h.unrealized)} />
        </div>
        <MarginMeter h={h} />
        <Exposure c={c} limit={4} />
      </div>
    );
  }
  if (k === 'spot') return <div className="pfv3-in"><SpotList d={d} limit={6} /></div>;
  if (k === 'evm') return <div className="pfv3-in"><EvmList d={d} /></div>;
  return (
    <div className="pfv3-in">
      <Holdings w={d.w} address={c.address} provider={provider} onOpenMarket={onOpenMarket} onDone={c.onChanged} readOnly={c.readOnly} showFunds />
      <Button variant="secondary" className="pfv3-in__more" onClick={onWealth}>Open Wealth <Icon name="arrowRight" size={14} /></Button>
    </div>
  );
}

/**
 * How the value moved over 7 days, as a line from 0 (owner 2026-11-26: "chart accurate and red/green depending on above
 * or below zero just like value, but first datapoint is 0. and value not pnl"): each point is the account value less
 * the first one, drawn as measured (straight segments, no smoothing) on a scale that always holds 0; the part above 0 is
 * green, below it red, with a faint line at 0.
 */
function ValueMove({ values, w = 160, h = 44 }: { values: number[]; w?: number; h?: number }) {
  const geo = useMemo(() => {
    const ys = values.map((v) => v - values[0]!);
    const lo = Math.min(0, ...ys);
    const hi = Math.max(0, ...ys);
    const span = hi - lo || 1;
    const pad = 3;
    const x = (i: number) => (ys.length < 2 ? 0 : (i / (ys.length - 1)) * w);
    const y = (v: number) => pad + ((hi - v) / span) * (h - pad * 2);
    const line = ys.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(2)},${y(v).toFixed(2)}`).join('');
    const zero = y(0);
    return { line, area: `${line}L${w},${zero.toFixed(2)}L0,${zero.toFixed(2)}Z`, zero, last: ys[ys.length - 1] ?? 0, end: { x: x(ys.length - 1), y: y(ys[ys.length - 1] ?? 0) } };
  }, [values, w, h]);
  const id = useMemo(() => `vm${Math.random().toString(36).slice(2, 8)}`, []);
  return (
    <svg className="pfv3-move" viewBox={`0 0 ${w} ${h}`} width={w} height={h} role="img" aria-label="Change in account value over 7 days">
      <defs>
        <clipPath id={`${id}u`}><rect x="0" y="0" width={w} height={geo.zero} /></clipPath>
        <clipPath id={`${id}d`}><rect x="0" y={geo.zero} width={w} height={h - geo.zero} /></clipPath>
      </defs>
      <line x1="0" x2={w} y1={geo.zero} y2={geo.zero} className="pfv3-move__zero" />
      <g clipPath={`url(#${id}u)`}><path d={geo.area} className="pfv3-move__fill is-pos" /><path d={geo.line} className="pfv3-move__line is-pos" /></g>
      <g clipPath={`url(#${id}d)`}><path d={geo.area} className="pfv3-move__fill is-neg" /><path d={geo.line} className="pfv3-move__line is-neg" /></g>
      <circle cx={geo.end.x} cy={geo.end.y} r="2.6" className={`pfv3-move__dot ${geo.last >= 0 ? 'is-pos' : 'is-neg'}`} />
    </svg>
  );
}

function Card({ c, d }: { c: PortfolioContext; d: PfData }) {
  const m = useMasks();
  const up = d.today === null || Math.abs(d.today) < 0.005 ? 'neutral' : d.today > 0 ? 'positive' : 'negative';
  // The card leans a little toward the mouse (owner 2026-11-26), as the VIP pass does.
  const tilt = useTilt<HTMLElement>(6, 5, 0.5);
  // The same 7-day value series as the chart beside it (SoDEX's history and its last 24 hours), so the two agree.
  const win = useMemo(() => curveFor(c, d.h24, '7D', (p) => p.accountValue), [c, d.h24]);
  const vals = win && win.points.length > 1 ? win.points.map((p) => p.v) : null;
  const moved = win?.change ?? null;
  return (
    <section className="pfv3-card tf-tilt" aria-label="Total value" ref={tilt.ref} onPointerMove={tilt.onMove} onPointerLeave={tilt.onLeave}>
      <div className="pfv3-card__top">
        <span className="pfv3-card__brand"><BrandMark size={18} />ValueDesk</span>
        <span className="pfv3-card__tr">
          <Identity c={c} />
          <SharePnl c={c} h24={d.h24} range="7D" />
        </span>
      </div>
      <span className="pfv3-card__k">Total value</span>
      <b className="pfv3-card__v">{m.equity(d.s.total === null ? DASH : fmtUsd(d.s.total))}</b>
      <div className="pfv3-card__row">
        {c.address ? <StatusPill tone={up} icon={d.today !== null && d.today < 0 ? 'down' : 'up'}>{m.pnl(signedUsd(d.today))} today</StatusPill> : <span className="pfv3-card__k">Connect a wallet to see it</span>}
        {vals && (
          <span className="pfv3-card__spark" title="Account value over the last 7 days, from its first point (SoDEX's own series)">
            <Private k="charts"><ValueMove values={vals} /></Private>
            <span className="pfv3-card__sparkt"><b className={tone(moved)}>{m.funds(signedUsd(moved))}</b><small>7 days</small></span>
          </span>
        )}
      </div>
      <AllocBar parts={d.parts} size="sm" />
    </section>
  );
}

function Wallet({ c, provider, onOpenMarket, onOpenTab, layout }: VersionProps & { layout: WalletLayout }) {
  const d = usePfData(c);
  const [view, setView] = useState<View>('home');
  const [open, setOpen] = useStored<Bucket | null>('vs.pfv3.open', 'perps');
  const [engine, setEngine] = useStored<'perps' | 'spot'>('vs.pfv.sum.engine', 'perps');
  const [sumRange, setSumRange] = useStored<Period>('vs.pfv.sum.range', '7D');
  const [section, setSection] = useStored<Section>('vs.pfv.section', 'perps');
  const [swap, setSwap] = useState(false);
  const [copies, setCopies] = useState(false);
  const toTop = () => document.querySelector('.appcontent')?.scrollTo({ top: 0, behavior: 'smooth' });
  const goWealth = useCallback(() => { setView('wealth'); toTop(); }, []);
  const offers = useOffers(d, goWealth, onOpenTab, () => setCopies(true));

  if (view === 'wealth') {
    return (
      <div className={`tf bots-page pfv pfv3 is-${layout}`}>
        <div className="bots-col pfv3-col is-wealth">
          <header className="pfv3-back">
            <Button variant="quiet" icon="arrowLeft" onClick={() => { setView('home'); toTop(); }}>Portfolio</Button>
            <h1>Wealth</h1>
          </header>
          <WealthArea w={d.w} value={d.s.wealth} slp={d.s.slp} address={c.address} provider={provider} refreshToken={c.refreshToken} onOpenMarket={onOpenMarket} onDone={c.onChanged} readOnly={c.readOnly} />
        </div>
      </div>
    );
  }

  const card = <Card c={c} d={d} />;
  const keys = <div className="pfv3-keys"><MoneyKeys c={c} onSwap={() => setSwap(true)} /></div>;
  // In the Original page's own wrapper (`pf pfx`): its controls' styles start there (the timeframe's sliding mark).
  const chart = <div className="pf pfx pfv3-chart"><ChartCard c={c} h24={d.h24} /></div>;
  const accounts = (
    <Shell className="pfv3-accounts">
      <ShellHeader title="Accounts" subtitle="Each dollar counted once" />
      <Panel className="pfv-pad0">
        <AllocLegend d={d} open={open} layout={layout === 'banner' ? 'grid' : 'rows'} onPick={(k) => setOpen(open === k ? null : k)}>
          {open && <Inside k={open} d={d} c={c} onWealth={goWealth} onOpenMarket={onOpenMarket} provider={provider} />}
        </AllocLegend>
      </Panel>
    </Shell>
  );
  const fees = (
    <Shell className="pfv3-fees">
      <ShellHeader title="Fees" />
      <Panel className="pfv-pad"><FeeRates c={c} fees={d.fees} /></Panel>
    </Shell>
  );
  const margin = !c.readOnly ? <div className="pfv3-margin"><PortfolioMargin address={c.address} provider={provider} /></div> : null;
  const earn = (
    <Shell className="pfv3-earn">
      <ShellHeader title="Earn and automate" />
      <Panel className="pfv-pad0">
        <ul className="pfv3-offers">
          {offers.map((o) => (
            <li key={o.key}>
              <button type="button" onClick={o.onClick ?? undefined} disabled={!o.onClick}>
                <span className="pfv3-offers__ic" aria-hidden="true">{o.icon}</span>
                <span className="pfv3-offers__t"><b>{o.title}</b><small>{o.mine ? <>You have {o.mine}</> : o.line}</small></span>
                <span className="pfv3-offers__r">{o.pill ?? <ApyFig apy={o.apy} />}{o.cta && <span className="pfv3-offers__cta">{o.cta}</span>}</span>
              </button>
            </li>
          ))}
        </ul>
      </Panel>
    </Shell>
  );
  const trading = (
    <Shell className="pfv3-trading">
      <ShellHeader title="Trading" aside={<EngineSwitch value={engine} onChange={setEngine} />} />
      <div className="pfv3-range"><RangeSwitch value={sumRange} onChange={setSumRange} /></div>
      <Panel className="pfv-pad"><TradeSummary c={c} engine={engine} range={sumRange} /></Panel>
    </Shell>
  );
  const band = (
    <Shell className="pfv3-band">
      <div className="pfv3-band__bar">
        <SectionTabs value={section} onChange={setSection} />
        {(section === 'copy' || section === 'bots') && <AllocationNote />}
      </div>
      <Panel className="pfv3-band__body">
        {section === 'perps' || section === 'spot' ? <Band c={c} engine={section} />
          : section === 'wealth' ? <div className="pfv-scroll pfv-pad"><Holdings w={d.w} address={c.address} provider={provider} onOpenMarket={onOpenMarket} onDone={c.onChanged} readOnly={c.readOnly} showFunds /></div>
          : section === 'copy' ? <div className="pfv-scroll pfv-pad"><CopiesPanel onOpenTab={onOpenTab} /></div>
          : <div className="pfv-scroll pfv-pad"><BotsPanel c={c} provider={provider} botsOpen={d.botsOpen} onOpenTab={onOpenTab} /></div>}
      </Panel>
    </Shell>
  );

  let body: ReactNode;
  if (layout === 'stack') {
    body = (
      <div className="pfv3-stack">
        {card}{keys}{chart}{accounts}{earn}{trading}{band}{fees}{margin}
      </div>
    );
  } else if (layout === 'banner') {
    body = (
      <>
        <div className="pfv3-hero">
          <div className="pfv3-hero__card">{card}{keys}</div>
          {chart}
        </div>
        {accounts}
        <div className="pfv3-pair">{earn}{trading}</div>
        {band}
        <div className="pfv3-pair">{fees}{margin}</div>
      </>
    );
  } else {
    body = (
      <>
        <div className="pfv3-split">
          <div className="pfv3-left">{card}{keys}{accounts}{fees}{margin}</div>
          <div className="pfv3-right">{chart}{earn}{trading}</div>
        </div>
        {band}
      </>
    );
  }

  return (
    <div className={`tf bots-page pfv pfv3 is-${layout}`}>
      <div className="bots-col pfv3-col">{body}</div>
      <SwapSheet open={swap} onClose={() => setSwap(false)} address={c.address} unlocked={c.unlocked} onChanged={c.onChanged} />
      <ManageCopies open={copies} onClose={() => setCopies(false)} />
    </div>
  );
}

export function WalletTwoColumns(p: VersionProps) { return <Wallet {...p} layout="wallet" />; }
export function WalletStack(p: VersionProps) { return <Wallet {...p} layout="stack" />; }
export function WalletBanner(p: VersionProps) { return <Wallet {...p} layout="banner" />; }
