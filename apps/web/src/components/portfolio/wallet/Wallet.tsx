/**
 * The Portfolio page (owner 2026-11-26: "promote portfolio page so its the new original"; it was the Wallet version
 * on the localhost switch, the one he kept). It draws:
 *
 * - the card: total value, today, how the value moved over 7 days (a line from 0, green above it and red below), where
 *   the money is, and a share button;
 * - the four keys (Deposit, Withdraw, Transfer, Swap);
 * - the accounts, each opening a drawer with what it holds: a few rows, then "View all" to the table below that has
 *   all of them (owner: "limit how many rows are visible, otherwise when clicking to view everything go to element");
 * - the value / PnL / calendar chart (ChartCard, PortfolioPage.tsx);
 * - earn and automate, trading, fees, margin;
 * - every table, by account (copies and bots as lists of their own).
 *
 * Two columns: the card and the accounts on the left, the chart, earn and trading on the right; one column on a phone.
 * Wealth is a view of its own, opened from its account and left with Back. On localhost the page before this one is
 * still a click away (DevVersions.tsx, "Previous").
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Panel, Shell, ShellHeader, StatusPill } from '../../bots/kit/kit';
import { PortfolioMargin } from '../../bots/Allocation';
import { BrandMark } from '../../BrandMark';
import type { Period } from '../../Portfolio';
import { ChartCard, curveFor, type PortfolioPageLinks } from '../PortfolioPage';
import { SwapSheet } from '../SwapSheet';
import { DASH, fmtUsd } from '../../../format';
import { useStored } from '../../../hooks';
import { useTilt } from '../../../tilt';
import { Private } from '../../../privacy';
import { usePfData, type Bucket, type PfData } from './data';
import {
  AllocBar, AllocLegend, AllocationNote, ApyFig, Band, EngineSwitch, EvmList, Exposure, FeeRates, Fig, Identity, ManageCopies, MarginMeter,
  MoneyKeys, RangeSwitch, SECTIONS, SectionTabs, SharePnl, SpotList, TradeSummary, CopiesPanel, BotsPanel,
  health, signedUsd, tone, useMasks, useOffers, type Section,
} from './blocks';
import { Holdings, WealthArea } from './WealthArea';
import { AllView } from './AllView';
import { OnchainPanel } from './Onchain';
import type { PortfolioContext } from '../../Portfolio';
import '../../bots/kit/kit.css';
import '../../bots/botsPages.css';
import '../../vip.css';
import './wallet.css';

export type WalletProps = { c: PortfolioContext } & PortfolioPageLinks;

type View = 'home' | 'wealth';
/** How many rows an account's drawer shows before "View all". */
const ROWS = 4;

/** What one account holds, in the drawer under its row: a few rows, then the way to all of them. */
function Inside({ k, d, c, onWealth, onAll, onOpenMarket, provider }: {
  k: Bucket; d: PfData; c: PortfolioContext; onWealth: () => void; onAll: (s: Section, tab?: string) => void;
} & Pick<WalletProps, 'onOpenMarket' | 'provider'>) {
  const m = useMasks();
  const h = health(c);
  if (k === 'perps') {
    return (
      <div className="pfv3-in">
        <div className="pfv3-in__stats">
          <Fig k="Available" v={m.funds(h.available === null ? DASH : fmtUsd(h.available))} />
          <Fig k="Withdrawable" v={m.funds(h.withdrawable === null ? DASH : fmtUsd(h.withdrawable))} />
          <Fig k="Unrealized" v={m.pnl(signedUsd(h.unrealized))} cls={tone(h.unrealized)} />
        </div>
        <MarginMeter h={h} />
        <Exposure c={c} limit={ROWS - 1} onAll={() => onAll('perps', 'positions')} />
      </div>
    );
  }
  if (k === 'spot') return <div className="pfv3-in"><SpotList d={d} limit={ROWS} onAll={() => onAll('spot', 'balances')} /></div>;
  if (k === 'evm') return <div className="pfv3-in"><EvmList d={d} limit={ROWS} onAll={() => onAll('onchain')} /></div>;
  return (
    <div className="pfv3-in">
      <Holdings w={d.w} address={c.address} provider={provider} onOpenMarket={onOpenMarket} onDone={c.onChanged} readOnly={c.readOnly} compact limit={ROWS - 1} picks={2} onAll={onWealth} />
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

export function PortfolioWallet({ c, provider, onOpenMarket, onOpenTab }: WalletProps) {
  const d = usePfData(c);
  const [view, setView] = useState<View>('home');
  const [open, setOpen] = useStored<Bucket | null>('vs.pfv3.open', 'perps');
  const [engine, setEngine] = useStored<'perps' | 'spot'>('vs.pfv.sum.engine', 'perps');
  const [sumRange, setSumRange] = useStored<Period>('vs.pfv.sum.period', '30D');
  // All first (owner 2026-11-27): a new key, so a pick stored before the tabs changed does not hold.
  const [storedSection, setSection] = useStored<Section>('vs.pfv.section2', 'all');
  const section: Section = SECTIONS.includes(storedSection) ? storedSection : 'all';
  // A "View all" picks the band's account and one of its tables (positions, balances), then brings the band into view.
  const [select, setSelect] = useState<{ key: string; n: number } | null>(null);
  const bandRef = useRef<HTMLElement>(null);
  const viewAll = useCallback((s: Section, tab?: string) => {
    setSection(s);
    setSelect(tab ? (p) => ({ key: tab, n: (p?.n ?? 0) + 1 }) : null);
    requestAnimationFrame(() => bandRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }, [setSection]);
  const [swap, setSwap] = useState(false);
  const [copies, setCopies] = useState(false);
  const toTop = () => document.querySelector('.appcontent')?.scrollTo({ top: 0, behavior: 'smooth' });
  const goWealth = useCallback(() => { setView('wealth'); toTop(); }, []);
  const offers = useOffers(d, goWealth, onOpenTab, () => setCopies(true));

  // `?tab=` deep-links a table of the account band (AccountTabs, e.g. the transfer drawer's "View full history"):
  // show the band on its account and bring it into view.
  useEffect(() => {
    if (!new URLSearchParams(window.location.search).has('tab')) return;
    if (section !== 'perps' && section !== 'spot') setSection('perps');
    requestAnimationFrame(() => bandRef.current?.scrollIntoView({ block: 'start' }));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (view === 'wealth') {
    return (
      <div className="tf bots-page pfv pfv3">
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
        <AllocLegend
          d={d}
          open={open}
          onPick={(k) => setOpen(open === k ? null : k)}
          drawer={(k) => <Inside k={k} d={d} c={c} onWealth={goWealth} onAll={viewAll} onOpenMarket={onOpenMarket} provider={provider} />}
        />
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
        {/* Each way in is a real button (owner 2026-11-26: "the see vault, find traders etc ... buttons arent styled good"). */}
        <ul className="pfv3-offers">
          {offers.map((o) => (
            <li key={o.key}>
              <span className="pfv3-offers__ic" aria-hidden="true">{o.icon}</span>
              <span className="pfv3-offers__t"><b>{o.title}</b><small>{o.mine ? <>You have {o.mine}</> : o.line}</small></span>
              <span className="pfv3-offers__r">
                {o.pill ?? <ApyFig apy={o.apy} />}
                {o.cta && o.onClick && <Button variant="secondary" className="pfv3-offers__cta" onClick={o.onClick}>{o.cta}</Button>}
              </span>
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
    <Shell className="pfv3-band" ref={bandRef}>
      <div className="pfv3-band__bar">
        <SectionTabs value={section} onChange={(s) => { setSelect(null); setSection(s); }} />
      </div>
      {(section === 'copy' || section === 'bots') && <div className="pfv3-band__note"><AllocationNote /></div>}
      <Panel className={`pfv3-band__body${section === 'all' || section === 'onchain' ? ' is-grow' : ''}`}>
        {section === 'all' ? <div className="pfv-pad"><AllView d={d} onSection={(s) => { setSelect(null); setSection(s); }} /></div>
          : section === 'onchain' ? <div className="pfv-pad"><OnchainPanel o={d.onchain} /></div>
          : section === 'perps' || section === 'spot' ? <Band c={c} engine={section} select={select} />
          : section === 'wealth' ? <div className="pfv-scroll pfv-pad"><Holdings w={d.w} address={c.address} provider={provider} onOpenMarket={onOpenMarket} onDone={c.onChanged} readOnly={c.readOnly} picks={4} onAll={goWealth} /></div>
          : section === 'copy' ? <div className="pfv-scroll pfv-pad"><CopiesPanel onOpenTab={onOpenTab} /></div>
          : <div className="pfv-scroll pfv-pad"><BotsPanel c={c} provider={provider} botsOpen={d.botsOpen} onOpenTab={onOpenTab} /></div>}
      </Panel>
    </Shell>
  );

  return (
    <div className="tf bots-page pfv pfv3">
      <h1 className="pfv-h1">Portfolio</h1>
      <div className="bots-col pfv3-col">
        {/* The two columns end together (the chart takes up the difference); Fees and Trading then share one row, same
            top and height (owner 2026-11-26: "a slight misalignment between fees and trading"). */}
        <div className="pfv3-split">
          <div className="pfv3-left">{card}{keys}{accounts}</div>
          <div className="pfv3-right">{chart}{earn}</div>
        </div>
        <div className="pfv3-pair">{fees}{trading}</div>
        {margin}
        {band}
      </div>
      <SwapSheet open={swap} onClose={() => setSwap(false)} address={c.address} unlocked={c.unlocked} onChanged={c.onChanged} />
      <ManageCopies open={copies} onClose={() => setCopies(false)} />
    </div>
  );
}

