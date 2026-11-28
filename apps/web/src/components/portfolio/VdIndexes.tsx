/**
 * The Wealth page's indexes (owner 2026-11-28): ValueDesk's own, the ones people published, and the wallet's own (its
 * drafts in this browser and what it published), as cards with a year of their basket; "Create your own" with a big
 * plus; every card opens its own page (wealthRoute.ts), Buy opens the buy sheet (once or recurring). Underneath, what the
 * wallet bought through an index in this browser, each leg with its way out.
 */
import { useMemo, useState, useSyncExternalStore } from 'react';
import { Button, EmptyState, Segmented } from '../bots/kit/kit';
import { fmtUsd } from '../../format';
import { useMask } from '../../privacy';
import { openPath } from '../../nav';
import { fundLabel } from '../../trading/wealth';
import { keptVersion, readBuys, subscribeKept, type IndexBuy, type VdIndex } from '../../trading/vdIndexes';
import type { Eip1193Provider } from '../../wallet';
import { INDEX_PUBLISHING } from '../../trading/vdIndexApi';
import { CreateCard, IndexCard, useAllIndexes, useLegCloses, useMinimums } from './indexParts';
import { IndexBuySheet } from './IndexBuy';
import { openWealth } from './WealthHero';
import { WEALTH_PATH } from './wealthRoute';
import type { WealthState } from './useWealth';
import '../bots/kit/kit.css';
import '../sodex/wealth/wealth.css';
import './wealthPages.css';

type Tab = 'valuedesk' | 'sosovalue' | 'community' | 'mine';

/** What this wallet bought through indexes in this browser, live. */
export function useBuys(address: string | null): IndexBuy[] {
  const v = useSyncExternalStore(subscribeKept, keptVersion, keptVersion);
  return useMemo(() => (address ? readBuys(address) : []), [address, v]); // eslint-disable-line react-hooks/exhaustive-deps
}

export function VdIndexBoard({ w, address, provider, onDone, onOpenMarket }: {
  w: WealthState; address: string | null; provider: Eip1193Provider | null; onDone: () => void; onOpenMarket: (symbol: string, engine: 'spot') => void;
}) {
  const all = useAllIndexes();
  const me = address?.toLowerCase() ?? null;
  const [tab, setTab] = useState<Tab>('valuedesk');
  const mine = useMemo(() => [...all.drafts, ...(all.published ?? []).filter((x) => x.owner === me)], [all.drafts, all.published, me]);
  const community = all.published ?? [];
  const list: readonly VdIndex[] = tab === 'valuedesk' ? all.valuedesk : tab === 'sosovalue' ? all.sosovalue : tab === 'community' ? community : mine;
  // Five and the big plus fill two rows of three (and of four less one): the rest is a tap away on the indexes page.
  const shown = list.slice(0, 5);
  const ids = useMemo(() => [...new Set(shown.flatMap((ix) => ix.legs.map((l) => l.fundId)))], [shown]);
  const { closes } = useLegCloses(ids, w.funds, '1Y');
  const mins = useMinimums(w.funds, ids);
  const [buy, setBuy] = useState<VdIndex | null>(null);
  const buys = useBuys(address);
  const everything = useMemo(() => [...all.valuedesk, ...community, ...all.drafts], [all.valuedesk, community, all.drafts]);
  const counts: Record<Tab, number | null> = { valuedesk: all.valuedesk.length, sosovalue: all.sosovalue.length, community: all.published ? community.length : null, mine: mine.length };
  return (
    <section className="tf wv wp wp-board" aria-labelledby="wp-board-title">
      <header className="wp-board__head">
        <div className="wp-board__t">
          <h2 id="wp-board-title">Indexes</h2>
          <p>Several Wealth funds in one buy, once or on a schedule.</p>
        </div>
        <div className="wp-board__c">
          <Segmented
            size="sm"
            label="Which indexes"
            value={tab}
            onChange={setTab}
            options={[
              { value: 'valuedesk', label: `ValueDesk ${counts.valuedesk}` },
              { value: 'sosovalue', label: `SoSoValue ${counts.sosovalue}` },
              ...(INDEX_PUBLISHING ? [{ value: 'community' as const, label: counts.community === null ? 'Published' : `Published ${counts.community}` }] : []),
              { value: 'mine', label: `Yours ${counts.mine}` },
            ]}
          />
        </div>
      </header>
      <div className="wp-grid">
        {shown.map((ix) => (
          <IndexCard
            key={ix.id} ix={ix} w={w} closes={closes} mins={mins} me={me} onBuy={setBuy}
            yours={buys.some((b) => b.id === ix.id) ? 'You bought this' : null}
          />
        ))}
        {tab === 'community' && all.published && !community.length && (
          <EmptyState compact icon="users" title="Nothing published yet" description="Make an index and publish it: it shows here for everyone." className="wp-grid__empty" />
        )}
        {tab === 'community' && all.error && !all.published && (
          <EmptyState compact tone="error" icon="warning" title="The published indexes did not load" description={all.error} className="wp-grid__empty" />
        )}
        <CreateCard compact={tab !== 'mine' || mine.length > 0} />
      </div>
      {address && buys.length > 0 && <Yours w={w} buys={buys} all={everything} onOpenMarket={onOpenMarket} />}
      <IndexBuySheet ix={buy} onClose={() => setBuy(null)} w={w} address={address} provider={provider} onDone={onDone} />
    </section>
  );
}

/** What the wallet bought through an index on ValueDesk (kept in this browser), and each leg's way out. */
export function Yours({ w, buys, all, onOpenMarket, only }: {
  w: WealthState; buys: IndexBuy[]; all: readonly VdIndex[]; onOpenMarket: (symbol: string, engine: 'spot') => void; only?: string;
}) {
  const maskFunds = useMask('funds');
  const ids = [...new Set(buys.map((b) => b.id))].filter((id) => !only || id === only);
  return (
    <div className="wp-yours">
      <p className="wp-yours__k">Bought through an index on ValueDesk. Each leg is held as the fund itself; sell it there.</p>
      {ids.map((id) => {
        const ix = all.find((x) => x.id === id);
        const list = buys.filter((b) => b.id === id);
        const legIds = ix ? ix.legs.map((l) => l.fundId) : [...new Set(list.flatMap((b) => b.legs.map((l) => l.fundId)))];
        return (
          <div key={id} className="wp-yours__row">
            <button type="button" className="wp-yours__name" onClick={() => openPath(WEALTH_PATH.index(id))}>{ix?.name ?? 'An index no longer listed'}</button>
            <span>{`${list.length}×, ${fmtUsd(list.reduce((t, b) => t + b.usd, 0))} in`}</span>
            <span className="wp-yours__legs">
              {legIds.map((fid) => {
                const f = w.funds?.find((x) => x.fundId === fid);
                const h = w.holdings?.find((x) => x.fundId === fid);
                const sell = () => {
                  if (!f) return;
                  if (f.fundType === 'bridged_vault') openWealth({ kind: 'earn', side: 'sell' });
                  else if (f.fundType === 'clob' && f.spot) onOpenMarket(f.spot.symbol, 'spot');
                  else openWealth({ kind: 'vault', fundId: f.fundId, side: 'sell' });
                };
                return (
                  <button key={fid} type="button" className="acct-act" onClick={sell} disabled={!h}>
                    {`Sell ${f ? fundLabel(f).name : fid}`}{h?.marketValue != null ? ` · ${maskFunds(fmtUsd(h.marketValue))}` : ''}
                  </button>
                );
              })}
            </span>
          </div>
        );
      })}
    </div>
  );
}
