/**
 * Version "Desk" (localhost only): the portfolio as a trader's desk, in the trade page's language. Every live figure
 * sits in one strip across the top; the chart and the account tables share the main column, the way the trade page
 * stacks chart and band; a rail beside them carries what decides the next trade: where the money is, the open risk,
 * what trading did, the fee rates, and what else the money could do.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Button, Panel, ProgressBar, Shell, ShellHeader, StatusPill, Tabs } from '../../bots/kit/kit';
import { PortfolioMargin } from '../../bots/Allocation';
import { Collapse } from '../../motion';
import type { Period } from '../../Portfolio';
import type { ChartView } from '../PortfolioPage';
import { SwapSheet } from '../SwapSheet';
import { DASH, fmt, fmtUsd, num } from '../../../format';
import { fmtRate } from '../../../fees';
import { localize } from '../../../numStyle';
import { useStored } from '../../../hooks';
import type { VersionProps } from './DevVersions';
import { usePfData, type Bucket } from './data';
import {
  AllocBar, AllocLegend, ApyFig, Band, BotsPanel, ChartBody, ChartFigure, CopiesPanel, EngineSwitch, EvmList, Exposure, FeeRates, Identity,
  ManageCopies, MoneyActions, RangeSwitch, SectionTabs, SharePnl, TradeSummary, ViewSwitch,
  chartWin, health, share, signedUsd, tone, useMasks, useOffers, type Section,
} from './blocks';
import { Holdings, WealthArea } from './WealthArea';

type Page = 'desk' | 'wealth';

function Cell({ k, v, sub, cls, children }: { k: ReactNode; v: ReactNode; sub?: ReactNode; cls?: string; children?: ReactNode }) {
  return (
    <div className="pfv2-cell">
      <span className="pfv2-cell__k">{k}</span>
      <b className={`pfv2-cell__v${cls ? ` ${cls}` : ''}`}>{v}</b>
      {sub !== undefined && <span className="pfv2-cell__s">{sub}</span>}
      {children}
    </div>
  );
}

export default function V2Desk({ c, provider, onOpenMarket, onOpenTab }: VersionProps) {
  const d = usePfData(c);
  const m = useMasks();
  const [page, setPage] = useStored<Page>('vs.pfv2.page', 'desk');
  const [view, setView] = useStored<ChartView>('vs.pfv.chart.view', 'value');
  const [range, setRange] = useStored<Period>('vs.pfv.chart.range', '7D');
  const [engine, setEngine] = useStored<'perps' | 'spot'>('vs.pfv.sum.engine', 'perps');
  const [sumRange, setSumRange] = useStored<Period>('vs.pfv.sum.range', '7D');
  const [section, setSection] = useStored<Section>('vs.pfv.section', 'perps');
  const [evmOpen, setEvmOpen] = useState(false);
  const [swap, setSwap] = useState(false);
  const [copies, setCopies] = useState(false);
  const win = chartWin(c, d.h24, view, range);
  const h = health(c);
  const goWealth = useCallback(() => {
    setPage('wealth');
    document.querySelector('.appcontent')?.scrollTo({ top: 0, behavior: 'smooth' });
  }, [setPage]);
  const pick = (k: Bucket) => {
    if (k === 'evm') { setEvmOpen((v) => !v); return; }
    setSection(k);
    document.getElementById('pfv2-band')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const offers = useOffers(d, goWealth, onOpenTab, () => setCopies(true));
  const p = d.fees.perps;
  // `?tab=` deep-links the account tables (AccountTabs): keep them on screen, as today's page does.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).has('tab')) setPage('desk');
  }, [setPage]);

  const desk = (
    <>
      {/* Every live figure, one strip */}
      <section className="pfv2-strip" aria-label="Account figures">
        <Cell k="Total value" v={m.equity(d.s.total === null ? DASH : fmtUsd(d.s.total))} sub={<span className={tone(d.today)}>{m.pnl(signedUsd(d.today))} today</span>} cls="is-lead" />
        <Cell k="PnL, 7 days" v={m.pnl(signedUsd(d.week?.change ?? null))} cls={tone(d.week?.change)} sub={d.month?.pnl != null ? <>30 days <span className={tone(d.month.pnl)}>{m.pnl(signedUsd(d.month.pnl))}</span></> : undefined} />
        <Cell k="Unrealized" v={m.pnl(signedUsd(h.unrealized))} cls={tone(h.unrealized)} sub={m.counts(`${fmt(h.positions, 0)} open ${h.positions === 1 ? 'position' : 'positions'}`)} />
        <Cell k="Available to trade" v={m.funds(h.available === null ? DASH : fmtUsd(h.available))} sub={<>Withdrawable {m.funds(h.withdrawable === null ? DASH : fmtUsd(h.withdrawable))}</>} />
        <Cell k="Margin in use" v={m.funds(share(h.usedShare))} sub={h.leverage !== null && h.leverage > 0 ? `${localize(h.leverage.toFixed(2))}x gross leverage` : 'No leverage open'}>
          {h.usedShare !== null && <ProgressBar value={h.usedShare} max={1} size="sm" kind="meter" tone={h.usedShare > 0.8 ? 'negative' : h.usedShare > 0.5 ? 'warning' : 'neutral'} label="Margin in use" />}
        </Cell>
        <Cell k="Volume, 7 days" v={m.funds(d.vol7d === null ? DASH : fmtUsd(d.vol7d, 0))} sub={d.ever?.volume != null ? <>All time {m.funds(fmtUsd(d.ever.volume, 0))}</> : undefined} />
        <Cell k="Fee tier" v={m.fees(p ? String(p.feeTier) : DASH)} sub={p ? m.fees(`${fmtRate(num(p.takerFeeRate))} / ${fmtRate(num(p.makerFeeRate))}`) : undefined} />
        <Cell k="30-day rank" v={d.month?.rank ? `#${fmt(d.month.rank, 0)}` : DASH} sub={d.month?.rank && d.ranked ? `of ${fmt(d.ranked, 0)} on SoDEX` : d.month ? 'Not ranked' : undefined} />
      </section>

      <div className="pfv2-grid">
        <div className="pfv2-main">
          <Shell className="pfv2-chart">
            <div className="pfv2-chart__head">
              <ViewSwitch value={view} onChange={setView} />
              <ChartFigure view={view} range={range} win={win} />
              <div className="pfv-ctl">
                {view !== 'calendar' && <RangeSwitch value={range} onChange={setRange} />}
                <SharePnl c={c} h24={d.h24} range={range} />
              </div>
            </div>
            <Panel className="pfv2-chart__body"><ChartBody c={c} view={view} range={range} win={win} /></Panel>
          </Shell>

          <Shell className="pfv2-band" id="pfv2-band">
            <div className="pfv2-band__bar">
              <SectionTabs value={section} onChange={setSection} />
              {(section === 'copy' || section === 'bots') && <StatusPill size="sm">Activity: no balance of its own</StatusPill>}
            </div>
            <Panel className="pfv2-band__body">
              {section === 'perps' || section === 'spot' ? <Band c={c} engine={section} />
                : section === 'wealth' ? (
                  <div className="pfv-scroll">
                    <Holdings w={d.w} address={c.address} provider={provider} onOpenMarket={onOpenMarket} onDone={c.onChanged} readOnly={c.readOnly} onSeeFunds={goWealth} />
                    <div className="pfv-row-acts pfv-pad"><Button variant="quiet" icon="arrowRight" onClick={goWealth}>All of Wealth</Button></div>
                  </div>
                )
                : section === 'copy' ? <div className="pfv-scroll pfv-pad"><CopiesPanel onOpenTab={onOpenTab} /></div>
                : <div className="pfv-scroll pfv-pad"><BotsPanel botsOpen={d.botsOpen} onOpenTab={onOpenTab} /></div>}
            </Panel>
          </Shell>
          {!c.readOnly && <PortfolioMargin address={c.address} provider={provider} />}
        </div>

        <aside className="pfv2-rail" aria-label="Details">
          <Shell>
            <ShellHeader icon="wallet" title="Balances" subtitle="Each dollar counted once" />
            <Panel className="pfv-pad">
              <AllocBar parts={d.parts} size="md" />
              <AllocLegend d={d} onPick={pick} evmOpen={evmOpen}>
                <Collapse open={evmOpen}><div className="pfv2-evm"><EvmList d={d} /></div></Collapse>
              </AllocLegend>
            </Panel>
          </Shell>
          <Shell>
            <ShellHeader icon="gauge" title="Open risk" subtitle="Perps positions by market" />
            <Panel className="pfv-pad"><Exposure c={c} limit={5} /></Panel>
          </Shell>
          <Shell>
            <ShellHeader icon="pulse" title="Activity" aside={<EngineSwitch value={engine} onChange={setEngine} />} />
            <div className="pfv2-rail__range"><RangeSwitch value={sumRange} onChange={setSumRange} /></div>
            <Panel className="pfv-pad"><TradeSummary c={c} engine={engine} range={sumRange} layout="list" /></Panel>
          </Shell>
          <Shell>
            <ShellHeader icon="bolt" title="Fees" />
            <Panel className="pfv-pad"><FeeRates c={c} fees={d.fees} /></Panel>
          </Shell>
          <Shell>
            <ShellHeader icon="coins" title="Earn and automate" />
            <Panel className="pfv-pad0">
              <ul className="pfv2-offers">
                {offers.map((o) => (
                  <li key={o.key}>
                    <button type="button" onClick={o.onClick ?? undefined} disabled={!o.onClick}>
                      <span className="pfv2-offers__ic" aria-hidden="true">{o.icon}</span>
                      <span className="pfv2-offers__t"><b>{o.title}</b><small>{o.mine ? <>You have {o.mine}</> : o.cta}</small></span>
                      {o.pill ?? <ApyFig apy={o.apy} />}
                    </button>
                  </li>
                ))}
              </ul>
            </Panel>
          </Shell>
        </aside>
      </div>
    </>
  );

  return (
    <div className="tf bots-page pfv pfv2">
      <div className="bots-col pfv2-col">
        <header className="pfv2-head">
          <div className="pfv2-head__t">
            <h1>Portfolio</h1>
            <Identity c={c} />
          </div>
          <Tabs label="Portfolio" value={page} onChange={setPage} tabs={[{ value: 'desk', label: 'Trading' }, { value: 'wealth', label: 'Wealth' }]} />
          <MoneyActions c={c} onSwap={() => setSwap(true)} className="pfv2-head__acts" />
        </header>
        {page === 'desk' ? desk : (
          <WealthArea w={d.w} value={d.s.wealth} slp={d.s.slp} address={c.address} provider={provider} refreshToken={c.refreshToken} onOpenMarket={onOpenMarket} onDone={c.onChanged} readOnly={c.readOnly} />
        )}
      </div>
      <SwapSheet open={swap} onClose={() => setSwap(false)} address={c.address} unlocked={c.unlocked} onChanged={c.onChanged} />
      <ManageCopies open={copies} onClose={() => setCopies(false)} />
    </div>
  );
}
