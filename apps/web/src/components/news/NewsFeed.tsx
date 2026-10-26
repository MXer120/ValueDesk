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
 * A story shows its source on the left - the outlet's icon and name
 * (newsSources.tsx) - and its time on the right (the clock, and how long ago),
 * the headline - or a post's own text - two lines of the story, and, when the
 * filter is not one coin, its coins, each with its move since the story came
 * out (moves.ts): a coin this terminal trades opens its chart. Page one
 * refreshes every two minutes; more pages load on demand.
 *
 * Sources (owner, 2026-10-26): SoSoValue's feed, and the White House and
 * Watcher.Guru (server valuescan/feeds.ts) merged into Latest and a search by
 * time - each switched on or off in Settings. Their stories have no type, so a
 * type filter shows SoSoValue's alone. The "Powered by SoSoValue" pill can be
 * dismissed for good (its x on hover; Settings brings it back).
 *
 * Each story can be saved to one of the wallet's knowledge folders (its
 * bookmark button, or a right-click): folders/bridge.ts saveToFolder - shown
 * only where the folders are mounted. Or dragged onto the rail's Knowledge
 * button, or a folder on the Knowledge page.
 */
import { Fragment, useEffect, useMemo, useState, useSyncExternalStore, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { useAsync, useStored } from '../../hooks';
import { vsApi, type NewsItem } from '../../vsApi';
import { CoinIcon } from '../CoinIcon';
import { EmptyState } from '../EmptyState';
import { FxSelect } from '../funds/ui';
import { CURRENT, CoinSelect, type CoinChoice } from './CoinSelect';
import { EconCalendar } from './EconCalendar';
import { PoweredBy } from './PoweredBy';
import { FEED_IDS, SourceMark, sourceSite, useCreditHidden, useNewsSources, useOutletsOff } from './newsSources';
import { moveSince, useCoinSeries, type PriceSource } from './moves';
import { focusProps } from '../../chart/newsFocus';
import { foldersAvailable, onBridgeChange, saveToFolder } from '../../folders/bridge';
import { DRAG_NEWS } from '../../folders/drag';
import { MENU_ICONS, TabMenu, menuAt, type TabMenuItem } from '../../dashboard/tabExtras';
import './NewsFeed.css';

type Feed = 'latest' | 'hot' | 'featured' | 'calendar';
const FEEDS: ReadonlyArray<{ id: Feed; label: string }> = [
  { id: 'latest', label: 'Latest' },
  { id: 'hot', label: 'Hot' },
  { id: 'featured', label: 'Featured' },
  // The economic calendar (EconCalendar.tsx): what is scheduled, not what happened.
  { id: 'calendar', label: 'Calendar' },
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

export function NewsFeed({ coin, instance, markets, onCoin, prices }: {
  /** The market on screen's coin (BTC), offered as "This market". */
  coin?: string | null;
  /** A duplicate tab's own filters (dashboard/tradeTabs.tsx): "2" for the second copy. */
  instance?: string;
  /** The coins this terminal trades: the coin filter's list, and the coins a story can open. */
  markets?: readonly CoinChoice[];
  /** Opens a coin's chart (a coin of `markets`). */
  onCoin?: (symbol: string) => void;
  /** Where a coin's price is read, for its move since a story (moves.ts). */
  prices?: PriceSource;
}) {
  const ns = instance ? `.${instance}` : '';
  const [feed, setFeed] = useStored<Feed>(`vs.news.feed${ns}`, 'latest');
  const [type, setType] = useStored<number>(`vs.news.type${ns}`, 0);
  const [picked, setPicked] = useStored<string[]>(`vs.news.coins${ns}`, []);
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const [pages, setPages] = useState(1);
  const canSave = useSyncExternalStore(onBridgeChange, foldersAvailable, foldersAvailable);
  const [isOn] = useNewsSources();
  const [outletsOff] = useOutletsOff();
  const offKey = [...outletsOff].sort().join(',');
  const [creditHidden, setCreditHidden] = useCreditHidden();
  const [menu, setMenu] = useState<{ at: { x: number; y: number }; items: TabMenuItem[] } | null>(null);
  const storyMenu = (e: ReactMouseEvent, n: NewsItem) => {
    if (!canSave) return;
    setMenu({
      at: menuAt(e),
      items: [
        { label: 'Open story', icon: MENU_ICONS.open, onClick: () => window.open(n.href, '_blank', 'noopener,noreferrer') },
        { label: 'Save to folder', icon: MENU_ICONS.folder, onClick: () => void saveStory(n) },
      ],
    });
  };
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

  const onCalendar = f === 'calendar' && !search;
  const soso = isOn('sosovalue');
  // The other sources: in Latest and a search, not under a type (they have none).
  const extraIds = FEED_IDS.filter((id) => isOn(id));
  const extrasOn = !onCalendar && extraIds.length > 0 && (f === 'latest' || !!search) && !category;
  const ask = (page: number) => vsApi.news({ feed: f === 'calendar' ? 'latest' : f, category, coin: coinParam || undefined, q: search || undefined, page, limit: PAGE });
  // The calendar reads its own (EconCalendar.tsx): no news is asked for meanwhile.
  const first = useAsync(() => ask(1), [queryKey], { pollMs: 2 * 60_000, enabled: !onCalendar && soso });
  const more = useAsync(
    () => (pages < 2 ? Promise.resolve([] as NewsItem[][]) : Promise.all(Array.from({ length: pages - 1 }, (_, i) => ask(i + 2).then((r) => r.items)))),
    [queryKey, pages],
    { enabled: !onCalendar && soso },
  );
  const extras = useAsync(
    () => vsApi.newsSources({ ids: extraIds.join(','), coin: coinParam || undefined, q: search || undefined, limit: 60 }),
    [extraIds.join(','), coinParam, search, extrasOn],
    { pollMs: 2 * 60_000, enabled: extrasOn },
  );
  const sosoItems = useMemo(() => {
    const seen = new Set<string>();
    return [...(first.data?.items ?? []), ...(more.data ?? []).flat()].filter((n) => !seen.has(n.id) && seen.add(n.id));
  }, [first.data, more.data]);
  const total = soso ? first.data?.total ?? null : 0;
  const canMore = soso && (total !== null ? sosoItems.length < total : (first.data?.items.length ?? 0) >= PAGE && pages * PAGE <= sosoItems.length);
  // The other sources' stories, as far back as SoSoValue's pages reach (all of them once there is no more);
  // an outlet switched off in Settings > News leaves the list.
  const items = useMemo(() => {
    const kept = (list: NewsItem[]) => (outletsOff.size ? list.filter((n) => { const site = sourceSite(n); return !site || !outletsOff.has(site); }) : list);
    const more = extrasOn ? extras.data?.items ?? [] : [];
    if (!more.length) return kept(sosoItems);
    if (!soso) return kept(more);
    const reach = canMore && sosoItems.length ? Math.min(...sosoItems.map((n) => n.time || Infinity)) : 0;
    const ranked = f === 'hot' && !search;
    const merged = kept([...sosoItems, ...more.filter((n) => n.time >= reach)]);
    return ranked ? merged : merged.sort((a, b) => b.time - a.time);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- offKey stands for outletsOff (a new Set each render)
  }, [sosoItems, extras.data, extrasOn, soso, canMore, f, search, offKey]);
  const moves = useCoinSeries(items, prices);
  const now = Date.now();
  const notSetUp = soso && !!first.error && /not configured|not_available/i.test(first.error);
  const nothingOn = !soso && !extraIds.length;
  const loading = soso ? !first.data : extrasOn && !extras.data;
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
              {x.id === 'calendar' && <CalendarIcon />}
              {x.label}
            </button>
          ))}
        </div>
      </header>
      {/* The source's credit floats centred over the bottom of the feed (NewsFeed.css); its x dismisses it for good. */}
      {!creditHidden && (
        <div className="nw__credit">
          <PoweredBy more={onCalendar} />
          <button type="button" className="nw__credit-x" onClick={() => setCreditHidden(true)} aria-label="Hide this for good" title="Hide for good (Settings brings it back)">
            <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true"><path d="m4.5 4.5 7 7M11.5 4.5l-7 7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
          </button>
        </div>
      )}
      {onCalendar ? <EconCalendar instance={instance} /> : <>
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
        {nothingOn ? (
          <EmptyState icon="news" title="Every news source is off" line="Switch one on in Settings, under News." />
        ) : notSetUp && !extrasOn ? (
          <EmptyState icon="news" title="News is not set up yet" line="The SoSoValue key has not been added to the server." />
        ) : soso && first.error && !first.data && !extras.data?.items.length ? (
          <EmptyState icon="news" title="News did not load" line={first.error} />
        ) : loading && !items.length ? (
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
              <li key={n.id} className={`nw__row${ranked && n.rank ? ' has-rank' : ''}`} {...focusProps({ id: n.id, title: n.title })} onContextMenu={(e) => storyMenu(e, n)} onDragStart={(e) => e.dataTransfer.setData(DRAG_NEWS, JSON.stringify(storyData(n)))}>
                {ranked && n.rank != null && <span className={`nw__rank${n.rank <= 3 ? ' is-top' : ''}`} aria-label={`Number ${n.rank}`}>{n.rank}</span>}
                <div className="nw__body">
                  <a className="nw__item" href={n.href} target="_blank" rel="noopener noreferrer">
                    <span className="nw__meta">
                      <SourceMark n={n} />
                      {n.time > 0 && (
                        <time dateTime={new Date(n.time).toISOString()} title={new Date(n.time).toLocaleString()}>
                          <span className="nw__clock">{clock(n.time, now)}</span>
                          <span className="nw__ago">{ago(n.time, now)}</span>
                        </time>
                      )}
                    </span>
                    <span className={`nw__title${n.post ? ' is-post' : ''}`}>{search ? marked(n.title, search) : n.title}</span>
                    {n.summary && <span className="nw__sum">{n.summary}</span>}
                  </a>
                  {chips && n.symbols.length > 0 && (
                    <span className="nw__coins">
                      {n.symbols.map((s) => {
                        const mv = moveSince(moves.get(s), n.time);
                        const pct = mv == null ? null : <span className={`nw__move ${mv > 0 ? 'is-up' : mv < 0 ? 'is-down' : ''}`} title={`${s} since this story came out`}>{`${mv > 0 ? '+' : ''}${mv.toFixed(Math.abs(mv) < 10 ? 2 : 1)}%`}</span>;
                        return tradeable.has(s) && onCoin ? (
                          <button key={s} type="button" className="nw__coin is-link" onClick={() => onCoin(s)} title={`Open the ${s} chart`}>
                            <CoinIcon coin={s} size={13} />{s}{pct}
                          </button>
                        ) : (
                          <span key={s} className="nw__coin"><CoinIcon coin={s} size={13} />{s}{pct}</span>
                        );
                      })}
                    </span>
                  )}
                  {canSave && (
                    <button type="button" className="nw__save" aria-label={`Save to folder: ${n.title}`} title="Save to folder" onClick={() => void saveStory(n)}>
                      <SaveIcon />
                    </button>
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
      </>}
      {menu && <TabMenu at={menu.at} items={menu.items} onClose={() => setMenu(null)} />}
    </section>
  );
}

/** A story as a folder keeps it. */
const storyData = (n: NewsItem) => ({ id: n.id, title: n.title, href: n.href, time: n.time, author: n.author, symbols: n.symbols, summary: n.summary ?? null, ...(n.post ? { post: true } : {}) });

/** A story into a folder, as the widget shows it. Dragged (its link), it carries the same to the rail's Knowledge button (folders/QuickDrop.tsx). */
const saveStory = (n: NewsItem) =>
  saveToFolder({
    kind: 'news',
    title: n.title.length > 120 ? `${n.title.slice(0, 117)}…` : n.title,
    data: storyData(n),
  });

const SaveIcon = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M2.5 4.5c0-.6.4-1 1-1h3l1.4 1.5h4.6c.6 0 1 .4 1 1v6c0 .6-.4 1-1 1h-9c-.6 0-1-.4-1-1z" />
    <path d="M8 7.5v3.6M6.2 9.3h3.6" />
  </svg>
);

const CalendarIcon = () => (
  <svg className="nw__flame" viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
    <rect x="2.5" y="3.5" width="11" height="10" rx="1.6" />
    <path d="M2.5 6.5h11M5.5 2.3v2.4M10.5 2.3v2.4" />
  </svg>
);

const FlameIcon = () => (
  <svg className="nw__flame" viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
    <path d="M8.3 1.5c.3 2.2-1 3.3-2 4.6C5.4 7.2 4.5 8.4 4.5 10a3.5 3.5 0 0 0 7 0c0-1.4-.6-2.4-1.3-3.3-.2 1-.8 1.6-1.4 1.8.4-2.4-.1-4.9-.5-7Z" fill="currentColor" />
  </svg>
);
