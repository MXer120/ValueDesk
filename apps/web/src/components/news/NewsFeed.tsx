/**
 * The News widget, powered by SoSoValue (server: /api/vs/news, which holds the
 * key and the budget - sosovalue/news.ts).
 *
 * Filters: the list (Latest, Hot, Featured), the type (news, research,
 * institution, insights, announcements, crypto stocks), the coin (every coin,
 * the market on screen, or a major) and a keyword search. The latest list
 * reaches back 7 days - SoSoValue's own limit; the search goes further back.
 * Page one refreshes every two minutes; more pages load on demand.
 */
import { useEffect, useMemo, useState } from 'react';
import { useAsync, useStored } from '../../hooks';
import { vsApi, type NewsItem } from '../../vsApi';
import { CoinIcon } from '../CoinIcon';
import { EmptyState } from '../EmptyState';
import { FxSelect } from '../funds/ui';
import './NewsFeed.css';

type Feed = 'latest' | 'hot' | 'featured';
const FEEDS: ReadonlyArray<{ id: Feed; label: string }> = [
  { id: 'latest', label: 'Latest' },
  { id: 'hot', label: 'Hot' },
  { id: 'featured', label: 'Featured' },
];
/** SoSoValue's categories. */
export const NEWS_TYPES: ReadonlyArray<{ id: number; label: string }> = [
  { id: 1, label: 'News' },
  { id: 2, label: 'Research' },
  { id: 3, label: 'Institution' },
  { id: 4, label: 'Insights' },
  { id: 7, label: 'Announcements' },
  { id: 13, label: 'Crypto stocks' },
];
const TYPE_LABEL = new Map(NEWS_TYPES.map((t) => [t.id, t.label]));
const MAJORS = ['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'DOGE', 'HYPE'];
const PAGE = 20;

const ago = (t: number, now: number) => {
  if (!t) return '';
  const s = Math.max(0, (now - t) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  if (s < 7 * 86_400) return `${Math.floor(s / 86_400)}d`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: s > 300 * 86_400 ? 'numeric' : undefined });
};

export function NewsFeed({ coin }: {
  /** The market on screen's coin (BTC), offered as "This market". */
  coin?: string | null;
}) {
  const [feed, setFeed] = useStored<Feed>('vs.news.feed', 'latest');
  const [type, setType] = useStored<number>('vs.news.type', 0);
  const [asset, setAsset] = useStored<string>('vs.news.asset', 'all');
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const [pages, setPages] = useState(1);
  const f: Feed = FEEDS.some((x) => x.id === feed) ? feed : 'latest';
  const here = coin ? coin.toUpperCase() : null;
  const pickedCoin = search ? null : asset === 'current' ? here : asset !== 'all' ? asset : null;
  const coinFilter = f === 'latest' ? pickedCoin : null;
  const category = type && TYPE_LABEL.has(type) && (f === 'latest' || search) ? type : undefined;

  // A pause in typing starts the search.
  useEffect(() => {
    const t = window.setTimeout(() => setSearch(q.trim().length >= 2 ? q.trim() : ''), 450);
    return () => window.clearTimeout(t);
  }, [q]);
  const queryKey = `${f}|${category ?? ''}|${coinFilter ?? ''}|${search}`;
  useEffect(() => setPages(1), [queryKey]);

  const first = useAsync(
    () => vsApi.news({ feed: f, category, coin: coinFilter ?? undefined, q: search || undefined, page: 1, limit: PAGE }),
    [queryKey],
    { pollMs: 2 * 60_000 },
  );
  const more = useAsync(
    () => (pages < 2 ? Promise.resolve([] as NewsItem[][]) : Promise.all(
      Array.from({ length: pages - 1 }, (_, i) => vsApi.news({ feed: f, category, coin: coinFilter ?? undefined, q: search || undefined, page: i + 2, limit: PAGE }).then((r) => r.items)),
    )),
    [queryKey, pages],
  );
  const items = useMemo(() => {
    const seen = new Set<string>();
    return [...(first.data?.items ?? []), ...(more.data ?? []).flat()].filter((n) => !seen.has(n.id) && seen.add(n.id));
  }, [first.data, more.data]);
  const total = first.data?.total ?? null;
  const canMore = total !== null ? items.length < total : (first.data?.items.length ?? 0) >= PAGE && pages * PAGE <= items.length;
  const now = Date.now();
  const notSetUp = !!first.error && /not configured|not_available/i.test(first.error);

  const assetOptions = [
    { value: 'all', label: 'All coins' },
    ...(here ? [{ value: 'current', label: `This market · ${here}` }] : []),
    ...MAJORS.filter((m) => m !== here).map((m) => ({ value: m, label: m })),
  ];

  return (
    <section className="nw" aria-label="News">
      <header className="nw__bar">
        <div className="nw__feeds" role="radiogroup" aria-label="Which news">
          {FEEDS.map((x) => (
            <button key={x.id} type="button" role="radio" aria-checked={f === x.id} className={f === x.id ? 'is-on' : ''} disabled={!!search} onClick={() => setFeed(x.id)}>
              {x.label}
            </button>
          ))}
        </div>
        <span className="nw__src">SoSoValue</span>
      </header>
      <div className="nw__filters">
        <FxSelect
          label="Type"
          value={String(category ?? 0)}
          options={[{ value: '0', label: 'Every type' }, ...NEWS_TYPES.map((t) => ({ value: String(t.id), label: t.label }))]}
          onChange={(v) => setType(Number(v))}
          searchable={false}
          triggerClassName="nw__select"
          listMinWidth={180}
        />
        <FxSelect
          label="Coin"
          value={asset === 'current' && !here ? 'all' : asset}
          options={assetOptions}
          onChange={setAsset}
          searchable={false}
          triggerClassName="nw__select"
          listMinWidth={180}
        />
        <label className="nw__search">
          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="m10.5 10.5 3 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search all news" aria-label="Search all news, older than 7 days too" spellCheck={false} />
        </label>
      </div>
      {(f !== 'latest' && pickedCoin && !search) && <p className="nw__note">Hot and Featured are the whole market; the coin filter applies to Latest.</p>}
      {search && <p className="nw__note">Searching every SoSoValue story for “{search}”, not only the last 7 days.</p>}

      <div className="nw__list">
        {notSetUp ? (
          <EmptyState icon="news" title="News is not set up yet" line="The SoSoValue key has not been added to the server." />
        ) : first.error && !first.data ? (
          <EmptyState icon="news" title="News did not load" line={first.error} />
        ) : !first.data ? (
          <p className="acct-empty acct-loading" role="status"><span className="acct-spin" aria-hidden="true" />Loading…</p>
        ) : items.length === 0 ? (
          <EmptyState icon="news" title="No news here" line={search ? 'Nothing matches that search.' : 'Try another type or coin.'} />
        ) : (
          <ol className="nw__items">
            {items.map((n) => (
              <li key={n.id}>
                <a className="nw__item" href={n.href} target="_blank" rel="noopener noreferrer">
                  <span className="nw__meta">
                    <time dateTime={n.time ? new Date(n.time).toISOString() : undefined} title={n.time ? new Date(n.time).toLocaleString() : undefined}>{ago(n.time, now)}</time>
                    {n.category != null && TYPE_LABEL.has(n.category) && <span className="nw__tag">{TYPE_LABEL.get(n.category)}</span>}
                    {n.author && <span className="nw__by">{n.author}</span>}
                  </span>
                  <b className="nw__title">{n.title}</b>
                  {n.summary && <span className="nw__sum">{n.summary}</span>}
                  {n.symbols.length > 0 && (
                    <span className="nw__coins">
                      {n.symbols.map((s) => <span key={s} className="nw__coin"><CoinIcon coin={s} size={12} />{s}</span>)}
                    </span>
                  )}
                </a>
              </li>
            ))}
          </ol>
        )}
        {items.length > 0 && canMore && (
          <button type="button" className="nw__more" disabled={more.loading} onClick={() => setPages((p) => p + 1)}>
            {more.loading ? 'Loading…' : 'More'}
          </button>
        )}
      </div>
    </section>
  );
}
