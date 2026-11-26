/**
 * Version "Overview" (localhost only): one calm column on the home page's look. It reads top to bottom as the
 * questions come: how much is there and where (the total, one bar, four named parts), how did it do (the chart beside
 * it), how is the Perps account standing (margin, open risk, the leaderboard), what does trading cost and what did it
 * do (summary and fees), what can the money do next (earn, copy, bots), and the full account tables last.
 */
import { useCallback, useEffect, useState } from 'react';
import { Button, Panel, Shell, ShellHeader, StatusPill, Tabs } from '../../bots/kit/kit';
import { PortfolioMargin } from '../../bots/Allocation';
import { Collapse } from '../../motion';
import type { Period } from '../../Portfolio';
import type { ChartView } from '../PortfolioPage';
import { SwapSheet } from '../SwapSheet';
import { DASH, fmt, fmtUsd } from '../../../format';
import { localize } from '../../../numStyle';
import { useStored } from '../../../hooks';
import type { VersionProps } from './DevVersions';
import { usePfData, type Bucket } from './data';
import {
  AllocBar, AllocLegend, ApyFig, Band, BotsPanel, ChartBody, ChartFigure, CopiesPanel, EngineSwitch, EvmList, Exposure, FeeRates, Fig, Identity,
  ManageCopies, MarginMeter, MoneyActions, RangeSwitch, SectionTabs, SharePnl, TradeSummary, ViewSwitch,
  chartWin, health, signedUsd, tone, useMasks, useOffers, type Section,
} from './blocks';
import { Holdings, WealthArea } from './WealthArea';

type Page = 'overview' | 'wealth';

export default function V1Overview({ c, provider, onOpenMarket, onOpenTab }: VersionProps) {
  const d = usePfData(c);
  const m = useMasks();
  const [page, setPage] = useStored<Page>('vs.pfv1.page', 'overview');
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
    document.getElementById('pfv1-accounts')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const offers = useOffers(d, goWealth, onOpenTab, () => setCopies(true));
  // `?tab=` deep-links the account tables (AccountTabs): keep them on screen, as today's page does.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).has('tab')) setPage('overview');
  }, [setPage]);

  const overview = (
    <>
      {/* 1. How much, where, and how it did */}
      <section className="pfv1-hero" aria-label="Total value">
        <div className="pfv1-total">
          <span className="pfv1-k">Total value</span>
          <b className="pfv1-big">{m.equity(d.s.total === null ? DASH : fmtUsd(d.s.total))}</b>
          {c.address && <div className="pfv1-today">
            <StatusPill tone={d.today === null || Math.abs(d.today) < 0.005 ? 'neutral' : d.today > 0 ? 'positive' : 'negative'} icon={d.today !== null && d.today < 0 ? 'down' : 'up'}>
              {m.pnl(signedUsd(d.today))} today
            </StatusPill>
          </div>}
          <dl className="pfv1-kv">
            <div><dt>PnL, 7 days</dt><dd className={tone(d.week?.change)}>{m.pnl(signedUsd(d.week?.change ?? null))}</dd></div>
            <div><dt title="The SoDEX leaderboard's own 7-day volume.">Volume, 7 days</dt><dd>{m.funds(d.vol7d === null ? DASH : fmtUsd(d.vol7d))}</dd></div>
          </dl>
          <AllocBar parts={d.parts} size="lg" />
          <AllocLegend d={d} onPick={pick} evmOpen={evmOpen}>
            <Collapse open={evmOpen}><div className="pfv1-evm"><EvmList d={d} /></div></Collapse>
          </AllocLegend>
          <p className="pfv1-rule" title="A fund share counts under Wealth wherever it sits; copies and bots trade from Perps and Spot, so they add nothing of their own.">Each dollar is counted once.</p>
        </div>
        <div className="pfv1-chart">
          <div className="pfv1-chart__head">
            <ChartFigure view={view} range={range} win={win} big />
            <div className="pfv-ctl">
              <ViewSwitch value={view} onChange={setView} />
              {view !== 'calendar' && <RangeSwitch value={range} onChange={setRange} />}
              <SharePnl c={c} h24={d.h24} range={range} />
            </div>
          </div>
          <ChartBody c={c} view={view} range={range} win={win} />
          {view === 'value' && c.venue.accountId !== null && <p className="pfv-quiet pfv1-chart__note">SoDEX&apos;s own series: Spot, Perps and vaults, deposits and withdrawals included. Your EVM wallet is not in it.</p>}
        </div>
      </section>

      {/* 2. The Perps account and where the wallet stands */}
      {c.address && (
        <section className="pfv1-facts" aria-label="Perps account">
          <div className="pfv1-facts__acct">
            <h2 className="pfv1-h2">Perps account</h2>
            <div className="pfv1-figs">
              <Fig k="Available to trade" v={m.funds(h.available === null ? DASH : fmtUsd(h.available))} />
              <Fig k="Withdrawable" v={m.funds(h.withdrawable === null ? DASH : fmtUsd(h.withdrawable))} />
              <Fig k="Unrealized PnL" v={m.pnl(signedUsd(h.unrealized))} cls={tone(h.unrealized)} />
              <Fig k="Open" v={m.counts(`${fmt(h.positions, 0)} ${h.positions === 1 ? 'position' : 'positions'}`)} sub={h.orders ? <>{m.counts(fmt(h.orders, 0))} orders · {m.funds(fmtUsd(h.ordersUsd ?? 0, 0))}</> : 'No resting orders'} />
            </div>
            <MarginMeter h={h} />
          </div>
          <div className="pfv1-facts__expo">
            <h2 className="pfv1-h2">Open risk {h.leverage !== null && h.leverage > 0 && <StatusPill size="sm">{localize(h.leverage.toFixed(2))}x gross</StatusPill>}</h2>
            <Exposure c={c} limit={3} />
          </div>
          <div className="pfv1-facts__rank">
            <h2 className="pfv1-h2">On SoDEX&apos;s leaderboard</h2>
            <div className="pfv1-ranks">
              <Fig k="30-day PnL" v={m.pnl(signedUsd(d.month?.pnl ?? null))} cls={tone(d.month?.pnl)} sub={d.month === null ? DASH : d.month.rank ? <>Rank <b>{`#${fmt(d.month.rank, 0)}`}</b>{d.ranked ? ` of ${fmt(d.ranked, 0)}` : ''}</> : 'Not ranked'} />
              <Fig k="All-time PnL" v={m.pnl(signedUsd(d.ever?.pnl ?? null))} cls={tone(d.ever?.pnl)} sub={d.ever?.rank ? <>Rank <b>{`#${fmt(d.ever.rank, 0)}`}</b></> : d.ever ? 'Not ranked' : DASH} />
              <Fig k="All-time volume" v={m.funds(d.ever?.volume == null ? DASH : fmtUsd(d.ever.volume, 0))} sub="Spot and Perps" />
            </div>
          </div>
        </section>
      )}

      {/* 3. What trading did and what it costs */}
      <div className="pfv1-two">
        <Shell>
          <ShellHeader icon="pulse" title="Trading summary" subtitle="From your own SoDEX history" aside={<><EngineSwitch value={engine} onChange={setEngine} /><RangeSwitch value={sumRange} onChange={setSumRange} /></>} />
          <Panel className="pfv-pad"><TradeSummary c={c} engine={engine} range={sumRange} /></Panel>
        </Shell>
        <Shell>
          <ShellHeader icon="gauge" title="Fees" subtitle="Your rates on SoDEX now" />
          <Panel className="pfv-pad"><FeeRates c={c} fees={d.fees} /></Panel>
        </Shell>
      </div>

      {/* 4. What the money can do next */}
      <section className="pfv1-offers" aria-label="Earn and automate">
        <h2 className="pfv1-h2">Put it to work</h2>
        <div className="pfv1-offers__grid">
          {offers.map((o) => (
            <button key={o.key} type="button" className={`pfv1-offer is-${o.key}`} onClick={o.onClick ?? undefined} disabled={!o.onClick}>
              <span className="pfv1-offer__top">
                <span className="pfv1-offer__ic" aria-hidden="true">{o.icon}</span>
                {o.pill ?? <ApyFig apy={o.apy} />}
              </span>
              <span className="pfv1-offer__t">{o.title}</span>
              <span className="pfv1-offer__l">{o.line}</span>
              <span className="pfv1-offer__foot">
                {o.mine ? <span className="pfv1-offer__mine">You have {o.mine}</span> : <span />}
                {o.cta && <span className="pfv1-offer__cta">{o.cta} <span aria-hidden="true">&rarr;</span></span>}
              </span>
            </button>
          ))}
        </div>
      </section>

      {!c.readOnly && <PortfolioMargin address={c.address} provider={provider} />}

      {/* 5. The accounts in full */}
      <Shell className="pfv1-accounts" id="pfv1-accounts">
        <div className="pfv1-accounts__bar">
          <SectionTabs value={section} onChange={setSection} />
          {(section === 'copy' || section === 'bots') && <StatusPill size="sm">Activity: no balance of its own</StatusPill>}
        </div>
        <Panel className="pfv1-accounts__body">
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
    </>
  );

  return (
    <div className="tf bots-page pfv pfv1">
      <div className="bots-col pfv1-col">
        <header className="pfv1-head">
          <div className="pfv1-head__t">
            <h1>Portfolio</h1>
            <Identity c={c} />
          </div>
          <MoneyActions c={c} onSwap={() => setSwap(true)} size="md" />
        </header>
        <Tabs
          label="Portfolio"
          value={page}
          onChange={setPage}
          className="pfv1-pages"
          tabs={[{ value: 'overview', label: 'Overview' }, { value: 'wealth', label: 'Wealth' }]}
        />
        {page === 'overview' ? overview : (
          <WealthArea
            w={d.w}
            value={d.s.wealth}
            slp={d.s.slp}
            address={c.address}
            provider={provider}
            refreshToken={c.refreshToken}
            onOpenMarket={onOpenMarket}
            onDone={c.onChanged}
            readOnly={c.readOnly}
          />
        )}
      </div>
      <SwapSheet open={swap} onClose={() => setSwap(false)} address={c.address} unlocked={c.unlocked} onChanged={c.onChanged} />
      <ManageCopies open={copies} onClose={() => setCopies(false)} />
    </div>
  );
}
