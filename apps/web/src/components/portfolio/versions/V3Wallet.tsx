/**
 * Version "Wallet" (localhost only): the portfolio as a wallet app. The balance card with its four keys first; under it
 * the four accounts, each opened in place to what it holds (no jump to a table further down); beside them, how it did
 * (the PnL month first, the value curve one press away), what the money can earn and what trading did. Wealth is a view
 * of its own, opened from its account and left with Back. Built for the phone first; on a desktop the two halves sit
 * side by side and the account card stays in view.
 */
import { useCallback, useState } from 'react';
import { Button, Icon, Panel, Shell, ShellHeader, Sparkline, StatusPill, type SegOption, Segmented } from '../../bots/kit/kit';
import { PortfolioMargin } from '../../bots/Allocation';
import { BrandMark } from '../../BrandMark';
import type { Period } from '../../Portfolio';
import type { ChartView } from '../PortfolioPage';
import { SwapSheet } from '../SwapSheet';
import { DASH, fmt, fmtUsd } from '../../../format';
import { useStored } from '../../../hooks';
import { useTilt } from '../../../tilt';
import type { VersionProps } from './DevVersions';
import { usePfData, type Bucket, type PfData } from './data';
import {
  AllocBar, AllocLegend, ApyFig, Band, ChartBody, ChartFigure, EngineSwitch, EvmList, Exposure, FeeRates, Fig, Identity, ManageCopies, MarginMeter,
  MoneyKeys, RangeSwitch, SectionTabs, SharePnl, SpotList, TradeSummary, CopiesPanel, BotsPanel,
  chartWin, health, signedUsd, tone, useMasks, useOffers, type Section,
} from './blocks';
import { Holdings, WealthArea } from './WealthArea';
import type { PortfolioContext } from '../../Portfolio';

type View = 'home' | 'wealth';

const PERF: Array<SegOption<ChartView>> = [{ value: 'calendar', label: 'Month' }, { value: 'pnl', label: 'PnL' }, { value: 'value', label: 'Value' }];

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
      <Holdings w={d.w} address={c.address} provider={provider} onOpenMarket={onOpenMarket} onDone={c.onChanged} readOnly={c.readOnly} onSeeFunds={onWealth} />
      <Button variant="secondary" className="pfv3-in__more" onClick={onWealth}>Open Wealth <Icon name="arrowRight" size={14} /></Button>
    </div>
  );
}

export default function V3Wallet({ c, provider, onOpenMarket, onOpenTab }: VersionProps) {
  const d = usePfData(c);
  const m = useMasks();
  const [view, setView] = useState<View>('home');
  const [open, setOpen] = useStored<Bucket | null>('vs.pfv3.open', 'perps');
  const [perf, setPerf] = useStored<ChartView>('vs.pfv3.perf', 'calendar');
  const [range, setRange] = useStored<Period>('vs.pfv.chart.range', '7D');
  const [engine, setEngine] = useStored<'perps' | 'spot'>('vs.pfv.sum.engine', 'perps');
  const [sumRange, setSumRange] = useStored<Period>('vs.pfv.sum.range', '7D');
  const [section, setSection] = useStored<Section>('vs.pfv.section', 'perps');
  const [swap, setSwap] = useState(false);
  const [copies, setCopies] = useState(false);
  const win = chartWin(c, d.h24, perf, range);
  const toTop = () => document.querySelector('.appcontent')?.scrollTo({ top: 0, behavior: 'smooth' });
  const goWealth = useCallback(() => { setView('wealth'); toTop(); }, []);
  const offers = useOffers(d, goWealth, onOpenTab, () => setCopies(true));
  const up = d.today === null || Math.abs(d.today) < 0.005 ? 'neutral' : d.today > 0 ? 'positive' : 'negative';
  // The card leans a little toward the mouse (owner 2026-11-26), as the VIP pass does.
  const tilt = useTilt<HTMLElement>(6, 5, 0.5);

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

  return (
    <div className="tf bots-page pfv pfv3">
      <div className="bots-col pfv3-col">
        <div className="pfv3-split">
          <div className="pfv3-left">
            {/* The card */}
            <section className="pfv3-card tf-tilt" aria-label="Total value" ref={tilt.ref} onPointerMove={tilt.onMove} onPointerLeave={tilt.onLeave}>
              <div className="pfv3-card__top">
                <span className="pfv3-card__brand"><BrandMark size={18} />ValueDesk</span>
                <Identity c={c} />
              </div>
              <span className="pfv3-card__k">Total value</span>
              <b className="pfv3-card__v">{m.equity(d.s.total === null ? DASH : fmtUsd(d.s.total))}</b>
              <div className="pfv3-card__row">
                {c.address ? <StatusPill tone={up} icon={d.today !== null && d.today < 0 ? 'down' : 'up'}>{m.pnl(signedUsd(d.today))} today</StatusPill> : <span className="pfv3-card__k">Connect a wallet to see it</span>}
                {d.weekValues && d.weekValues.length > 1 && (
                  <span className="pfv3-card__spark" title="Account value, last 7 days (SoDEX's own series)">
                    <Sparkline values={d.weekValues} tone={d.week?.change == null ? 'neutral' : d.week.change >= 0 ? 'positive' : 'negative'} w={96} h={30} />
                    <small>7 days</small>
                  </span>
                )}
              </div>
              <AllocBar parts={d.parts} size="sm" />
            </section>
            <div className="pfv3-keys"><MoneyKeys c={c} onSwap={() => setSwap(true)} /></div>

            {/* The accounts, opened in place */}
            <Shell className="pfv3-accounts">
              <ShellHeader title="Accounts" subtitle="Each dollar counted once" />
              <Panel className="pfv-pad0">
                <AllocLegend d={d} open={open} onPick={(k) => setOpen(open === k ? null : k)}>
                  {open && <Inside k={open} d={d} c={c} onWealth={goWealth} onOpenMarket={onOpenMarket} provider={provider} />}
                </AllocLegend>
              </Panel>
            </Shell>

            <Shell className="pfv3-fees">
              <ShellHeader title="Fees" />
              <Panel className="pfv-pad"><FeeRates c={c} fees={d.fees} /></Panel>
            </Shell>
            {!c.readOnly && <div className="pfv3-margin"><PortfolioMargin address={c.address} provider={provider} /></div>}
          </div>

          <div className="pfv3-right">
            {/* How it did */}
            <Shell className="pfv3-perf">
              <div className="pfv3-perf__head">
                <h2>Performance</h2>
                <Segmented options={PERF} value={perf} onChange={setPerf} label="Performance view" />
              </div>
              <Panel className="pfv-pad">
                <div className="pfv3-perf__fig">
                  <ChartFigure view={perf} range={range} win={win} big />
                  {perf !== 'calendar' && <div className="pfv-ctl"><RangeSwitch value={range} onChange={setRange} /><SharePnl c={c} h24={d.h24} range={range} /></div>}
                </div>
                <ChartBody c={c} view={perf} range={range} win={win} />
                {c.address && (
                  <div className="pfv3-perf__stand">
                    <Fig k="PnL, 7 days" v={m.pnl(signedUsd(d.week?.change ?? null))} cls={tone(d.week?.change)} />
                    <Fig k="PnL, 30 days" v={m.pnl(signedUsd(d.month?.pnl ?? null))} cls={tone(d.month?.pnl)} sub={d.month?.rank ? `#${fmt(d.month.rank, 0)} on SoDEX` : d.month ? 'Not ranked' : undefined} />
                    <Fig k="Volume, 7 days" v={m.funds(d.vol7d === null ? DASH : fmtUsd(d.vol7d, 0))} sub={d.ever?.volume != null ? <>{m.funds(fmtUsd(d.ever.volume, 0))} all time</> : undefined} />
                  </div>
                )}
              </Panel>
            </Shell>

            {/* What the money can do */}
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

            {/* What trading did */}
            <Shell className="pfv3-trading">
              <ShellHeader title="Trading" aside={<EngineSwitch value={engine} onChange={setEngine} />} />
              <div className="pfv3-range"><RangeSwitch value={sumRange} onChange={setSumRange} /></div>
              <Panel className="pfv-pad"><TradeSummary c={c} engine={engine} range={sumRange} /></Panel>
            </Shell>

          </div>
        </div>

        {/* Everything, in the trade page's tables */}
        <Shell className="pfv3-band">
          <div className="pfv3-band__bar">
            <SectionTabs value={section} onChange={setSection} />
            {(section === 'copy' || section === 'bots') && <StatusPill size="sm">Activity: no balance of its own</StatusPill>}
          </div>
          <Panel className="pfv3-band__body">
            {section === 'perps' || section === 'spot' ? <Band c={c} engine={section} />
              : section === 'wealth' ? <div className="pfv-scroll"><Holdings w={d.w} address={c.address} provider={provider} onOpenMarket={onOpenMarket} onDone={c.onChanged} readOnly={c.readOnly} onSeeFunds={goWealth} /></div>
              : section === 'copy' ? <div className="pfv-scroll pfv-pad"><CopiesPanel onOpenTab={onOpenTab} /></div>
              : <div className="pfv-scroll pfv-pad"><BotsPanel botsOpen={d.botsOpen} onOpenTab={onOpenTab} /></div>}
          </Panel>
        </Shell>
        <p className="pfv3-foot">Figures from SoDEX, read live. Copies and bots trade from Perps and Spot, so they add nothing of their own.</p>
      </div>
      <SwapSheet open={swap} onClose={() => setSwap(false)} address={c.address} unlocked={c.unlocked} onChanged={c.onChanged} />
      <ManageCopies open={copies} onClose={() => setCopies(false)} />
    </div>
  );
}
