/**
 * The News widget, powered by SoSoValue (server: /api/vs/news, which holds the
 * key and the budget - sosovalue/news.ts).
 *
 * Filters: the list (Latest, Hot - SoSoValue's ranking, numbered - and
 * Featured), the type (news, research, institution, insights, announcements,
 * crypto stocks; Latest and search), the coins (every coin, the chart's, or a
 * few - CoinSelect.tsx; every list) and a keyword search, which goes back
 * further than the latest list's 7 days and lists its finds newest first.
 *
 * A story shows its time (the clock, and how long ago), type and author, the
 * headline - or a post's own text - two lines of the story, and, when the
 * filter is not one coin, its coins: a coin this terminal trades opens its
 * chart. Page one refreshes every two minutes; more pages load on demand.
 */
import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useAsync, useStored } from '../../hooks';
import { vsApi, type NewsItem } from '../../vsApi';
import { CoinIcon } from '../CoinIcon';
import { EmptyState } from '../EmptyState';
import { FxSelect } from '../funds/ui';
import { CURRENT, CoinSelect, type CoinChoice } from './CoinSelect';
import './NewsFeed.css';

type Feed = 'latest' | 'hot' | 'featured';
const FEEDS: ReadonlyArray<{ id: Feed; label: string }> = [
  { id: 'latest', label: 'Latest' },
  { id: 'hot', label: 'Hot' },
  { id: 'featured', label: 'Featured' },
];
/** SoSoValue's categories (the type filter). */
export const NEWS_TYPES: ReadonlyArray<{ id: number; label: string }> = [
  { id: 1, label: 'News' },
  { id: 2, label: 'Research' },
  { id: 3, label: 'Institution' },
  { id: 4, label: 'Insights' },
  { id: 7, label: 'Announcements' },
  { id: 13, label: 'Crypto stocks' },
];
// 5 is not a documented category, and not a filter; SoSoValue files macro news (Bloomberg's) under it.
const TYPE_LABEL = new Map([...NEWS_TYPES.map((t) => [t.id, t.label] as const), [5, 'Macro'] as const]);
const MAJORS: CoinChoice[] = ['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'DOGE', 'HYPE'].map((symbol) => ({ symbol }));
const PAGE = 20;

const ago = (t: number, now: number) => {
  if (!t) return '';
  const s = Math.max(0, (now - t) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
};
/** The clock time; another day's story says its day too. */
const clock = (t: number, now: number) => {
  if (!t) return '';
  const d = new Date(t);
  const hm = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const today = new Date(now);
  if (d.toDateString() === today.toDateString()) return hm;
  const yesterday = new Date(now - 86_400_000);
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday ${hm}`;
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${hm}`;
};

/** The search's words marked in a title. */
function marked(text: string, search: string): ReactNode {
  const words = search.split(/\s+/).filter((w) => w.length >= 2).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!words.length) return text;
  const parts = text.split(new RegExp(`(${words.join('|')})`, 'gi'));
  return parts.map((p, i) => (i % 2 ? <mark key={i}>{p}</mark> : <Fragment key={i}>{p}</Fragment>));
}

export function NewsFeed({ coin, instance, markets, onCoin }: {
  /** The market on screen's coin (BTC), offered as "This market". */
  coin?: string | null;
  /** A duplicate tab's own filters (dashboard/tradeTabs.tsx): "2" for the second copy. */
  instance?: string;
  /** The coins this terminal trades: the coin filter's list, and the coins a story can open. */
  markets?: readonly CoinChoice[];
  /** Opens a coin's chart (a coin of `markets`). */
  onCoin?: (symbol: string) => void;
}) {
  const ns = instance ? `.${instance}` : '';
  const [feed, setFeed] = useStored<Feed>(`vs.news.feed${ns}`, 'latest');
  const [type, setType] = useStored<number>(`vs.news.type${ns}`, 0);
  const [picked, setPicked] = useStored<string[]>(`vs.news.coins${ns}`, []);
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const [pages, setPages] = useState(1);
  const f: Feed = FEEDS.some((x) => x.id === feed) ? feed : 'latest';
  const here = coin ? coin.toUpperCase() : null;
  const list = markets?.length ? markets : MAJORS;
  const tradeable = useMemo(() => new Set((markets ?? []).map((m) => m.symbol)), [markets]);
  // The chosen coins, "This market" read as the chart's coin.
  const chosen = useMemo(() => {
    const out: string[] = [];
    for (const v of Array.isArray(picked) ? picked : []) {
      const s = v === CURRENT ? here : v;
      if (s && !out.includes(s)) out.push(s);
    }
    return out;
  }, [picked, here]);
  const coinParam = chosen.join(',');
  const category = type && NEWS_TYPES.some((t) => t.id === type) && (f === 'latest' || search) ? type : undefined;

  // A pause in typing starts the search.
  useEffect(() => {
    const t = window.setTimeout(() => setSearch(q.trim().length >= 2 ? q.trim() : ''), 450);
    return () => window.clearTimeout(t);
  }, [q]);
  const clearSearch = () => {
    setQ('');
    setSearch('');
  };
  const queryKey = `${f}|${category ?? ''}|${coinParam}|${search}`;
  useEffect(() => setPages(1), [queryKey]);

  const ask = (page: number) => vsApi.news({ feed: f, category, coin: coinParam || undefined, q: search || undefined, page, limit: PAGE });
  const first = useAsync(() => ask(1), [queryKey], { pollMs: 2 * 60_000 });
  const more = useAsync(
    () => (pages < 2 ? Promise.resolve([] as NewsItem[][]) : Promise.all(Array.from({ length: pages - 1 }, (_, i) => ask(i + 2).then((r) => r.items)))),
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
  const ranked = f === 'hot' && !search;
  // One coin chosen: every story is about it, so its coins are not repeated under each.
  const chips = chosen.length !== 1;

  return (
    <section className="nw" aria-label="News">
      <header className="nw__bar">
        <div className="nw__feeds" role="radiogroup" aria-label="Which news">
          {FEEDS.map((x) => (
            <button
              key={x.id}
              type="button"
              role="radio"
              aria-checked={!search && f === x.id}
              className={!search && f === x.id ? 'is-on' : ''}
              onClick={() => {
                clearSearch();
                setFeed(x.id);
              }}
            >
              {x.id === 'hot' && <FlameIcon />}
              {x.label}
            </button>
          ))}
        </div>
        <span className="nw__src">SoSoValue</span>
      </header>
      <div className="nw__filters">
        {(f === 'latest' || search) && (
          <FxSelect
            label="Type"
            value={String(category ?? 0)}
            options={[{ value: '0', label: 'Every type' }, ...NEWS_TYPES.map((t) => ({ value: String(t.id), label: t.label }))]}
            onChange={(v) => setType(Number(v))}
            searchable={false}
            triggerClassName="nw__select"
            listMinWidth={180}
          />
        )}
        <CoinSelect coins={list} value={Array.isArray(picked) ? picked : []} here={here} onChange={setPicked} />
        <label className="nw__search">
          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="m10.5 10.5 3 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') setSearch(q.trim().length >= 2 ? q.trim() : '');
              if (e.key === 'Escape') clearSearch();
            }}
            placeholder="Search all news"
            aria-label="Search all news, older than 7 days too"
            spellCheck={false}
          />
          {q && (
            <button type="button" className="nw__clear" onClick={clearSearch} aria-label="Clear the search" title="Clear the search">
              <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="m4.5 4.5 7 7M11.5 4.5l-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
            </button>
          )}
        </label>
      </div>
      {search && <p className="nw__note">Every SoSoValue story for “{search}”{chosen.length ? ` about ${chosen.join(', ')}` : ''}, newest first - not only the last 7 days.</p>}
      {ranked && <p className="nw__note">SoSoValue's hottest stories right now, hottest first.</p>}

      <div className="nw__list">
        {notSetUp ? (
          <EmptyState icon="news" title="News is not set up yet" line="The SoSoValue key has not been added to the server." />
        ) : first.error && !first.data ? (
          <EmptyState icon="news" title="News did not load" line={first.error} />
        ) : !first.data ? (
          <p className="acct-empty acct-loading" role="status"><span className="acct-spin" aria-hidden="true" />Loading…</p>
        ) : items.length === 0 ? (
          <EmptyState
            icon="news"
            title="No news here"
            line={search ? 'Nothing matches that search.' : chosen.length ? `No ${FEEDS.find((x) => x.id === f)!.label.toLowerCase()} story about ${chosen.join(', ')} right now.` : 'Try another type or coin.'}
          />
        ) : (
          <ol className="nw__items">
            {items.map((n) => (
              <li key={n.id} className={`nw__row${ranked && n.rank ? ' has-rank' : ''}`}>
                {ranked && n.rank != null && <span className={`nw__rank${n.rank <= 3 ? ' is-top' : ''}`} aria-label={`Number ${n.rank}`}>{n.rank}</span>}
                <div className="nw__body">
                  <a className="nw__item" href={n.href} target="_blank" rel="noopener noreferrer">
                    <span className="nw__meta">
                      {n.time > 0 && (
                        <time dateTime={new Date(n.time).toISOString()} title={new Date(n.time).toLocaleString()}>
                          <span className="nw__clock">{clock(n.time, now)}</span>
                          <span className="nw__ago">{ago(n.time, now)}</span>
                        </time>
                      )}
                      {n.category != null && TYPE_LABEL.has(n.category) && <span className="nw__tag">{TYPE_LABEL.get(n.category)}</span>}
                      {n.author && <span className="nw__by">{n.author}</span>}
                    </span>
                    <span className={`nw__title${n.post ? ' is-post' : ''}`}>{search ? marked(n.title, search) : n.title}</span>
                    {n.summary && <span className="nw__sum">{n.summary}</span>}
                  </a>
                  {chips && n.symbols.length > 0 && (
                    <span className="nw__coins">
                      {n.symbols.map((s) => (tradeable.has(s) && onCoin ? (
                        <button key={s} type="button" className="nw__coin is-link" onClick={() => onCoin(s)} title={`Open the ${s} chart`}>
                          <CoinIcon coin={s} size={13} />{s}
                        </button>
                      ) : (
                        <span key={s} className="nw__coin"><CoinIcon coin={s} size={13} />{s}</span>
                      )))}
                    </span>
                  )}
                </div>
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

const FlameIcon = () => (
  <svg className="nw__flame" viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
    <path d="M8.3 1.5c.3 2.2-1 3.3-2 4.6C5.4 7.2 4.5 8.4 4.5 10a3.5 3.5 0 0 0 7 0c0-1.4-.6-2.4-1.3-3.3-.2 1-.8 1.6-1.4 1.8.4-2.4-.1-4.9-.5-7Z" fill="currentColor" />
  </svg>
);
