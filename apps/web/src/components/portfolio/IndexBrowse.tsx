/**
 * Every index (owner 2026-11-28: "users can check out all, and their info"): ValueDesk's, everyone's published ones and
 * this browser's drafts, searchable by name, maker or fund, sorted by what was published last, the year's return or
 * the name. Each card opens its index page.
 */
import { useMemo, useState } from 'react';
import { EmptyState, Segmented, SearchField } from '../bots/kit/kit';
import { basketHistory, changeOver, kindOf, type VdIndex } from '../../trading/vdIndexes';
import type { Eip1193Provider } from '../../wallet';
import { INDEX_PUBLISHING } from '../../trading/vdIndexApi';
import { CreateCard, IndexCard, fundNameOf, useAllIndexes, useLegCloses, useMinimums } from './indexParts';
import { IndexBuySheet } from './IndexBuy';
import { Crumbs } from './IndexPage';
import { useBuys } from './VdIndexes';
import { WEALTH_PATH } from './wealthRoute';
import type { WealthState } from './useWealth';

type Show = 'all' | 'valuedesk' | 'sosovalue' | 'published' | 'mine';
type Sort = 'new' | 'year' | 'name';

export function IndexBrowse({ w, address, provider, onDone }: { w: WealthState; address: string | null; provider: Eip1193Provider | null; onDone: () => void }) {
  const all = useAllIndexes();
  const me = address?.toLowerCase() ?? null;
  const [show, setShow] = useState<Show>('all');
  const [sort, setSort] = useState<Sort>('new');
  const [q, setQ] = useState('');
  const [buy, setBuy] = useState<VdIndex | null>(null);
  const buys = useBuys(address);
  const everything = useMemo(() => [...all.drafts, ...(all.published ?? []), ...all.valuedesk, ...all.sosovalue], [all]);
  const ids = useMemo(() => [...new Set(everything.flatMap((ix) => ix.legs.map((l) => l.fundId)))], [everything]);
  const { closes } = useLegCloses(ids, w.funds, '1Y');
  const mins = useMinimums(w.funds, ids);
  const year = useMemo(() => new Map(everything.map((ix) => {
    const h = closes ? basketHistory(ix, closes) : null;
    return [ix.id, h && !h.leftOut.length ? changeOver(h.series, 365) : null] as const;
  })), [everything, closes]);

  const list = useMemo(() => {
    const term = q.trim().toLowerCase();
    const mine = (ix: VdIndex) => kindOf(ix) === 'draft' || (!!me && ix.owner === me);
    const rows = everything.filter((ix) => {
      const k = kindOf(ix);
      if (show === 'valuedesk' && k !== 'valuedesk') return false;
      if (show === 'sosovalue' && k !== 'sosovalue') return false;
      if (show === 'published' && k !== 'published') return false;
      if (show === 'mine' && !mine(ix)) return false;
      if (!term) return true;
      const text = `${ix.name} ${ix.line} ${ix.ownerName ?? ''} ${ix.owner ?? ''} ${ix.legs.map((l) => `${l.fundId} ${fundNameOf(w.funds, l.fundId)}`).join(' ')}`.toLowerCase();
      return text.includes(term);
    });
    const by = sort === 'name' ? (a: VdIndex, b: VdIndex) => a.name.localeCompare(b.name)
      : sort === 'year' ? (a: VdIndex, b: VdIndex) => (year.get(b.id) ?? -Infinity) - (year.get(a.id) ?? -Infinity)
      : (a: VdIndex, b: VdIndex) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
    return [...rows].sort(by);
  }, [everything, show, sort, q, me, year, w.funds]);

  const counts = {
    all: everything.length,
    valuedesk: all.valuedesk.length,
    published: all.published?.length ?? 0,
    mine: everything.filter((ix) => kindOf(ix) === 'draft' || (!!me && ix.owner === me)).length,
  };
  return (
    <div className="wp-page">
      <Crumbs items={[['Wealth', WEALTH_PATH.home], ['Indexes', null]]} />
      <header className="wp-hero wp-hero--build">
        <div className="wp-hero__t">
          <h1>Indexes</h1>
          <p>{INDEX_PUBLISHING ? 'Several SoDEX Wealth funds in one buy: ValueDesk’s own, the ones people published, and yours. Each page shows the history, the funds and their weights.' : 'Several SoDEX Wealth funds in one buy: ValueDesk’s own and yours. Each page shows the history, the funds and their weights.'}</p>
        </div>
      </header>
      <div className="wp-browse__bar">
        <SearchField value={q} onChange={setQ} placeholder="Search by name or fund" label="Search indexes" className="wp-search" />
        <Segmented
          size="sm" label="Which indexes" value={show} onChange={setShow}
          options={[
            { value: 'all', label: `All ${counts.all}` },
            { value: 'valuedesk', label: `ValueDesk ${counts.valuedesk}` },
            { value: 'sosovalue', label: `SoSoValue ${all.sosovalue.length}` },
            ...(INDEX_PUBLISHING ? [{ value: 'published' as const, label: `Published ${counts.published}` }] : []),
            { value: 'mine', label: `Yours ${counts.mine}` },
          ]}
        />
        <Segmented size="sm" label="Sort" value={sort} onChange={setSort} options={[{ value: 'new', label: 'Newest' }, { value: 'year', label: '1 year' }, { value: 'name', label: 'Name' }]} />
      </div>
      {all.error && !all.published && <EmptyState compact tone="error" icon="warning" title="The published indexes did not load" description={all.error} />}
      <div className="wp-grid">
        <CreateCard />
        {list.map((ix) => (
          <IndexCard key={ix.id} ix={ix} w={w} closes={closes} mins={mins} me={me} onBuy={setBuy} yours={buys.some((b) => b.id === ix.id) ? 'You bought this' : null} />
        ))}
      </div>
      {!list.length && <EmptyState compact icon="search" title="No index matches" description={q ? 'Try another name or fund.' : 'Nothing here yet.'} />}
      <IndexBuySheet ix={buy} onClose={() => setBuy(null)} w={w} address={address} provider={provider} onDone={onDone} />
    </div>
  );
}
