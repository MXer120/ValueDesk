/**
 * One SoDEX Wealth fund's page (owner 2026-11-28: "a full info page for every asset of existing underlying wealth
 * products, provided by sodex info"). What SoDEX publishes about the fund, its whole price history (price-history
 * range=All: an ETF's from its own launch), SoDEX's figures, how it trades right now, the wallet's position, the ways
 * in and out on ValueDesk, and the indexes that hold it.
 */
import { useMemo } from 'react';
import { Button, EmptyState, Panel, Shell, ShellHeader, Skeleton, StatusPill } from '../bots/kit/kit';
import { openPath } from '../../nav';
import { indexesWith } from '../../trading/vdIndexes';
import { useNow } from '../sodex/parts';
import { pctText, useFundViews, val } from '../sodex/wealth/data';
import { ChannelPill, FundChannel, FundFacts, FundMark, FundPerformance, FundPosition, Signed } from '../sodex/wealth/parts';
import { FundActs } from './FundDesk';
import { FundAbout } from './FundAbout';
import { EarnCharts } from './EarnCharts';
import { useRecurringTargets } from './IndexBuy';
import { Crumbs } from './IndexPage';
import { AllocBar, IndexMarks, useAllIndexes } from './indexParts';
import { WEALTH_PATH } from './wealthRoute';
import type { WealthState } from './useWealth';

export function FundPage({ id, w, onOpenMarket }: { id: string; w: WealthState; onOpenMarket: (symbol: string, engine: 'spot') => void }) {
  const views = useFundViews(w);
  const v = views?.find((x) => x.id === id || x.id.toLowerCase() === id.toLowerCase()) ?? null;
  const now = useNow(15_000);
  const targets = useRecurringTargets(w.funds);
  const recurring = useMemo(() => new Set((targets ?? []).map((t) => t.fund.fundId)), [targets]);
  const all = useAllIndexes();
  const holders = useMemo(() => (v ? indexesWith(v.id, [...all.valuedesk, ...(all.published ?? []), ...all.drafts]) : []), [v, all]);

  if (!views) {
    return (
      <div className="wp-page">
        <Crumbs items={[['Wealth', WEALTH_PATH.home], ['Reading', null]]} />
        <Skeleton className="wp-bone wp-bone--hero" />
        <Skeleton className="wp-bone wp-bone--chart" />
      </div>
    );
  }
  if (!v) {
    return (
      <div className="wp-page">
        <Crumbs items={[['Wealth', WEALTH_PATH.home], ['Not found', null]]} />
        <EmptyState icon="search" title="SoDEX lists no such fund" description="It may have been renamed or closed." actions={<Button variant="secondary" onClick={() => openPath(WEALTH_PATH.home)}>All funds</Button>} />
      </div>
    );
  }
  const price = val(v.quote?.price);
  const d24 = val(v.quote?.roi24h);
  return (
    <div className="wp-page">
      <Crumbs items={[['Wealth', WEALTH_PATH.home], [v.shelf, WEALTH_PATH.home], [v.name, null]]} />
      <header className="wp-hero wp-hero--fund">
        <div className="wp-hero__t">
          <div className="wp-hero__k">
            <FundMark v={v} size={52} />
            <span className="wp-hero__pills">
              <ChannelPill v={v} now={now} size="md" />
              {v.holding && <StatusPill tone="positive" size="md" icon="check">You hold this</StatusPill>}
              {recurring.has(v.id) && <StatusPill tone="neutral" size="md" icon="clock">Recurring Buy</StatusPill>}
            </span>
          </div>
          <h1>{v.name}</h1>
          <p>{`${v.ticker} · ${v.shelf}`}</p>
        </div>
        <dl className="wp-hero__figs">
          {price !== null && <div><dt>Price</dt><dd>{`$${price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: price < 10 ? 4 : 2 })}`}</dd>{d24 !== null && <small><Signed v={d24}>{`${pctText(d24)} 24h`}</Signed></small>}</div>}
          <div><dt>{v.head.label}</dt><dd className={v.head.kind === 'apy' ? 'pos' : (v.head.value ?? 0) >= 0 ? 'pos' : 'neg'}>{pctText(v.head.value, v.head.kind === 'roi')}</dd></div>
          {val(v.quote?.roiInception) !== null && <div><dt>Since launch</dt><dd><Signed v={val(v.quote?.roiInception)}>{pctText(val(v.quote?.roiInception))}</Signed></dd><small>SoDEX’s figure</small></div>}
        </dl>
        <div className="wp-hero__acts wp-hero__acts--fund">
          <FundActs v={v} onOpenMarket={onOpenMarket} recurring={recurring} details={false} />
        </div>
      </header>

      <div className="wp-main">
        <div className="wp-main__l">
          {v.fund.fundType === 'bridged_vault' ? <EarnCharts /> : (
            <Shell className="wp-sec">
              <ShellHeader title="Performance" subtitle="SoDEX’s daily closes; All goes back as far as SoDEX has them" />
              <Panel className="wp-sec__p"><FundPerformance v={v} height={320} /></Panel>
            </Shell>
          )}
          <FundAbout v={v} />
        </div>
        <aside className="wp-main__r">
          <Shell className="wp-sec">
            <ShellHeader title="Figures" subtitle="From SoDEX" />
            <Panel className="wp-sec__p"><FundFacts v={v} /></Panel>
          </Shell>
          <Shell className="wp-sec">
            <ShellHeader title="How it trades" subtitle="Right now, on SoDEX" />
            <Panel className="wp-sec__p"><FundChannel v={v} now={now} /></Panel>
          </Shell>
          {v.holding && (
            <Shell className="wp-sec">
              <ShellHeader title="Your position" />
              <Panel className="wp-sec__p"><FundPosition h={v.holding} ticker={v.ticker} /></Panel>
            </Shell>
          )}
          <Shell className="wp-sec">
            <ShellHeader title="In indexes" subtitle={holders.length ? `${holders.length} hold this fund` : 'None yet'} />
            <Panel className="wp-sec__p wp-holders">
              {holders.slice(0, 8).map((ix) => {
                const leg = ix.legs.find((l) => l.fundId === v.id)!;
                return (
                  <a key={ix.id} className="wp-holder" href={WEALTH_PATH.index(ix.id)} onClick={(e) => { if (e.button === 0 && !e.metaKey && !e.ctrlKey) { e.preventDefault(); openPath(WEALTH_PATH.index(ix.id)); } }}>
                    <IndexMarks ix={ix} funds={w.funds} size={20} max={4} />
                    <span className="wp-holder__t"><b>{ix.name}</b><small>{`${Math.round(leg.weight * 1000) / 10}% of it`}</small></span>
                    <AllocBar ix={ix} funds={w.funds} />
                  </a>
                );
              })}
              <Button size="sm" variant="secondary" icon="plus" onClick={() => openPath(`${WEALTH_PATH.newIndex}?with=${encodeURIComponent(v.id)}`)}>Make an index with it</Button>
            </Panel>
          </Shell>
        </aside>
      </div>
    </div>
  );
}
