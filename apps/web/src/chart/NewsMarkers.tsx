/**
 * News on the chart (Chart.tsx, toolbar's news button): SoSoValue stories and
 * the economic calendar's releases as markers along the foot of the price pane,
 * one row, each on the bar it came out in.
 *
 * A marker shows what it is (chartMarks.ts markFace): the logo of the coin a
 * story is about, X's mark for a post, the globe for macro, an icon for
 * research, an announcement, an institution, the calendar for a release... and
 * a count only where several share it. Markers that would overlap at the zoom
 * on screen are one (clusterNews), so a busy hour is one marker with a count,
 * not a row of them; a release and the stories beside it share one too. A
 * marker's edge glows with its hottest story (chartMarks.ts storyHeat: its
 * place on SoSoValue's hot list, a post's views and likes - nothing guessed).
 *
 * Hover a marker for its stories, hot ones first; click to keep them open until
 * a click elsewhere or Escape. While a marker is open - or a list points at one
 * of its stories (newsFocus.ts: the News widget, the calendar) - the bars its
 * stories came out in are lit. The card is a glass sheet like the app's
 * drawers; every story opens its article in a new tab, and can be saved to a
 * knowledge folder where the folders are there.
 *
 * A DOM layer, not canvas: logos are images, and the hover is the browser's.
 * Positions follow the chart frame by frame, re-rendering this layer alone.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Chart as KChart } from 'klinecharts';
import { CoinIcon } from '../components/CoinIcon';
import { MENU_ICONS } from '../dashboard/tabExtras';
import { NEWS_ICONS } from './chartIcons';
import {
  FED_LIVE_URL,
  NEWS_KIND_LABEL,
  clusterNews,
  fomcWindow,
  hotFirst,
  isFocused,
  isFomc,
  markFace,
  markHeat,
  nearRelease,
  newsKind,
  showsAhead,
  showsFomcWindow,
  storyHeat,
  type NewsMark,
  type NewsScope,
  type NewsStory,
  type PlacedNews,
} from './chartMarks';
import { useNewsFocus } from './newsFocus';
import { PoweredBy } from '../components/news/PoweredBy';
import { RELEASE_EVENT, fmtField, useReleaseResults, type ReleaseResult } from '../components/news/releases';
import type { CalendarEvent } from '../vsApi';
import { useLatched } from '../components/motion';
import type { TimeZoneMode } from './timeAxis';
import { fmtNum } from '../numStyle';

const PANE = 'candle_pane';
/** A marker is 24px; closer than this they are one. */
const GAP = 28;
/** From the pane's foot to the marker's top. */
const FOOT = 32;
const CARD_W = 348;
/** Between a marker's top and its card. */
const CARD_GAP = 12;

export interface NewsMarkersProps {
  chart: KChart | null;
  marks: readonly NewsMark[];
  /** The canvas's place in the pane (its offset), where the price pane starts. */
  left: number;
  top: number;
  /** The chart's bar, ms: an FOMC decision's window shows on bars under an hour. */
  barMs: number;
  /** The chart's coin as the news names it (BTC). */
  coin: string;
  /** Whose news it is: this coin's, macro, or all of crypto. */
  mode: NewsScope;
  /** News is going off: the markers fade out. */
  leaving?: boolean;
  tz: TimeZoneMode;
  /** Folders are there: each story offers "Save to folder". */
  canSave: boolean;
  onSave: (s: NewsStory) => void;
}

/** "17:20", or "Fri 23 Oct 17:20" for another day; on the chart's clock. */
function storyTime(t: number, tz: TimeZoneMode): string {
  const d = new Date(t);
  const zone = tz === 'utc' ? 'UTC' : undefined;
  const hm = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', timeZone: zone });
  const day = (x: Date) => x.toLocaleDateString(undefined, { timeZone: zone });
  if (day(d) === day(new Date())) return hm;
  return `${d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', timeZone: zone })} ${hm}`;
}

/** "in 3d 4h", "in 45m", "2h ago": from now to a release. */
function countdown(t: number, now: number): string {
  const m = Math.round((t - now) / 60_000);
  const a = Math.abs(m);
  const text = a >= 1440 ? `${Math.floor(a / 1440)}d ${Math.floor((a % 1440) / 60)}h` : a >= 60 ? `${Math.floor(a / 60)}h ${a % 60}m` : `${a}m`;
  return m >= 0 ? `in ${text}` : `${text} ago`;
}

const IMPACT: Record<'high' | 'medium' | 'low', string> = { high: 'High impact', medium: 'Medium impact', low: 'Low impact' };

/** Releases in date order. */
const byDate = (list: readonly NewsStory[]) => [...list].sort((a, b) => a.time - b.time);
const WEIGHT = { high: 3, medium: 2, low: 1 } as const;
/** The release a marker is named for: the next one that matters most, else the latest. */
function leadRelease(list: readonly NewsStory[], now: number): NewsStory {
  const coming = list.filter((s) => s.time >= now);
  if (coming.length) return [...coming].sort((a, b) => WEIGHT[b.event!.importance] - WEIGHT[a.event!.importance] || a.time - b.time)[0]!;
  return list[list.length - 1]!;
}

/** An all-day release's date ("Wed 28 Oct"): its time is midday UTC of that date, read in UTC. */
const releaseDay = (t: number) => new Date(t).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

const compact = { format: (n: number) => fmtNum(n, { notation: 'compact', maximumFractionDigits: 1 }) };
/** Why a story counts as hot, in a few words: its place on the hot list, or a post's reach. */
function hotNote(s: NewsStory): string | null {
  if (!storyHeat(s)) return null;
  if (s.rank && s.rank <= 50) return `Hot #${s.rank}`;
  if (s.views) return `${compact.format(s.views)} views`;
  if (s.likes) return `${compact.format(s.likes)} likes`;
  return null;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function NewsMarkers({ chart, marks, left, top, barMs, coin, mode, leaving = false, tz, canSave, onSave }: NewsMarkersProps) {
  /** The row: stories and releases, merged where they would overlap. */
  const [placed, setPlaced] = useState<PlacedNews[]>([]);
  /** FOMC decisions on screen: the statement and the press conference, x from-to in the pane. */
  const [fomc, setFomc] = useState<Array<{ key: string; x1: number; x2: number; x3: number }>>([]);
  const [pane, setPane] = useState<{ width: number; height: number; bar: number }>({ width: 0, height: 0, bar: 0 });
  const [open, setOpen] = useState<{ key: string; pinned: boolean } | null>(null);
  /** Each story's bar on screen (x in the pane), for lighting it. */
  const barX = useRef(new Map<string, number>());
  const layer = useRef<HTMLDivElement>(null);
  const closeTimer = useRef(0);
  /** The card stays a moment as it closes, to fade out. */
  const card = useLatched(open?.key ?? null, 140);
  const focus = useNewsFocus();
  const windowsShown = showsFomcWindow(barMs);
  // The official figures of the releases on the chart (releases.tsx): filled in the second
  // they land, and a release that lands while the chart is open opens its marker.
  const releaseEvents = useMemo(() => marks.flatMap((m) => m.stories)
    .filter((st) => st.event && st.event.source !== 'sosovalue')
    .map((st) => ({ id: st.id, time: st.time, source: st.event!.source }) as CalendarEvent), [marks]);
  const results = useReleaseResults(releaseEvents);
  const placedRef = useRef(placed);
  placedRef.current = placed;
  useEffect(() => {
    const landed = (e: Event) => {
      const id = (e as CustomEvent<ReleaseResult>).detail?.id;
      const mark = placedRef.current.find((pm) => pm.stories.some((st) => st.id === id));
      if (mark) setOpen({ key: mark.key, pinned: true });
    };
    window.addEventListener(RELEASE_EVENT, landed);
    return () => window.removeEventListener(RELEASE_EVENT, landed);
  }, []);

  // Where each marker is, every frame; a render only when one moved.
  useEffect(() => {
    if (!chart || marks.length === 0) {
      setPlaced([]);
      setFomc([]);
      return;
    }
    let raf = 0;
    let last = '';
    const tick = () => {
      const size = chart.getSize(PANE);
      const width = size?.width ?? 0;
      const height = size?.height ?? 0;
      const on: PlacedNews[] = [];
      const later: NewsStory[] = [];
      const windows: Array<{ key: string; x1: number; x2: number; x3: number }> = [];
      const xs = new Map<string, number>();
      const now = Date.now();
      const xOf = (timestamp: number) => (chart.convertToPixel({ timestamp, value: 0 }, { paneId: PANE }) as { x?: number }).x;
      for (const m of marks) {
        const x = xOf(m.timestamp);
        if (typeof x !== 'number' || !Number.isFinite(x)) continue;
        const events = m.stories.filter((s) => s.event);
        // An FOMC decision: its statement and press conference as a window, on bars short enough to show it.
        for (const e of windowsShown ? events.filter(isFomc) : []) {
          const w = fomcWindow(e.time);
          const [x1, x2, x3] = [xOf(w.statement[0]), xOf(w.press[0]), xOf(w.press[1])];
          if ([x1, x2, x3].every((v) => typeof v === 'number' && Number.isFinite(v)) && x3! >= 0 && x1! <= width) {
            windows.push({ key: e.id, x1: Math.round(x1!), x2: Math.round(x2!), x3: Math.round(x3!) });
          }
        }
        // Past the right edge: still to come - at the edge while it is near for this zoom.
        if (x > width - 6) {
          later.push(...events.filter((e) => showsAhead(x, width, e, now)));
          continue;
        }
        if (x < 6) continue;
        for (const s of m.stories) xs.set(s.id, Math.round(x));
        on.push({ key: m.key, x: Math.round(x), timestamp: m.timestamp, stories: m.stories });
      }
      // One row; what sits where "Next" does joins it.
      const row: PlacedNews[] = [];
      const atEdge: NewsStory[] = [];
      for (const p of clusterNews(on, GAP)) {
        if (later.length && p.x >= width - GAP * 1.5) atEdge.push(...p.stories);
        else row.push(p);
      }
      if (later.length) {
        const events = byDate([...later, ...atEdge.filter((s) => s.event)]).slice(0, 12);
        row.push({ key: 'ev:ahead', x: width - 4, timestamp: later[0]!.time, stories: [...events, ...atEdge.filter((s) => !s.event)] });
      }
      const bar = Math.round((chart.getBarSpace()?.bar ?? 0) * 10) / 10;
      const sig = `${width}x${height}:${bar}|${row.map((p) => `${p.key}@${p.x}:${p.stories.length}`).join(',')}|${windows.map((w) => `${w.x1}:${w.x3}`).join(',')}|${Math.floor(now / 60_000)}`;
      if (sig !== last) {
        last = sig;
        barX.current = xs;
        setPlaced(row);
        setFomc(windows);
        setPane({ width, height, bar });
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [chart, marks, windowsShown]);

  // A pinned card closes on a press elsewhere or Escape.
  useEffect(() => {
    if (!open?.pinned) return;
    const away = (e: Event) => {
      if (e instanceof KeyboardEvent) {
        if (e.key === 'Escape') setOpen(null);
        return;
      }
      if (e.target instanceof Element && e.target.closest('.kc-newspop, .kc-newsmark, .kc-calmark')) return;
      setOpen(null);
    };
    // The card is placed against the marker once: a scroll would leave it behind.
    const scrolled = (e: Event) => {
      if (e.target instanceof Element && e.target.closest('.kc-newspop')) return;
      setOpen(null);
    };
    document.addEventListener('pointerdown', away, true);
    document.addEventListener('keydown', away);
    window.addEventListener('scroll', scrolled, true);
    return () => {
      document.removeEventListener('pointerdown', away, true);
      document.removeEventListener('keydown', away);
      window.removeEventListener('scroll', scrolled, true);
    };
  }, [open?.pinned]);
  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  const hold = () => window.clearTimeout(closeTimer.current);
  // Leaving the marker for the card (or back) keeps it: a moment's grace.
  const letGo = () => {
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setOpen((o) => (o?.pinned ? o : null)), 220);
  };

  if (placed.length === 0 && fomc.length === 0) return null;
  const shown = card.value ? placed.find((p) => p.key === card.value) : undefined;
  const releases = shown ? byDate(shown.stories.filter((s) => s.event)) : [];
  const stories = shown ? hotFirst(shown.stories.filter((s) => !s.event)) : [];
  const box = layer.current?.getBoundingClientRect();
  const now = Date.now();
  const hover = (key: string) => ({
    onMouseEnter: () => {
      hold();
      setOpen((o) => (o?.pinned ? o : { key, pinned: false }));
    },
    onMouseLeave: letGo,
    onClick: () => {
      hold();
      setOpen((o) => (o?.key === key && o.pinned ? null : { key, pinned: true }));
    },
  });

  // The bars lit: the open marker's stories', else the one a list points at.
  const openMark = open ? placed.find((p) => p.key === open.key) : undefined;
  const litStories = openMark ? openMark.stories : focus ? placed.flatMap((p) => p.stories).filter((s) => isFocused(s, focus)) : [];
  const litX = litStories.map((s) => barX.current.get(s.id)).filter((x): x is number => x !== undefined);
  const half = Math.max(1, pane.bar / 2);
  const lit = litX.length ? { x1: Math.min(...litX) - half, x2: Math.max(...litX) + half } : null;

  const title = mode === 'macro' ? 'Macro news' : mode === 'all' ? 'Crypto news' : `${coin} news`;

  return (
    <>
      {fomc.map((w) => (
        <div
          key={w.key}
          className={`kc-fomc${leaving ? ' is-leaving' : ''}`}
          style={{ left: left + w.x1, top, height: pane.height, width: Math.max(2, w.x3 - w.x1) }}
          aria-hidden
        >
          <div className="kc-fomc__statement" style={{ width: Math.max(1, w.x2 - w.x1) }} />
          <div className="kc-fomc__press" />
          {w.x3 - w.x1 >= 44 && (
            <div className="kc-fomc__label">
              <b>FOMC</b>
              {w.x3 - w.x1 >= 90 && (
                <>
                  <span>Statement 2:00 pm ET</span>
                  <span>Press conference 2:30 pm</span>
                  <span>End ~3:30 pm (estimated)</span>
                </>
              )}
            </div>
          )}
        </div>
      ))}
      {lit && !leaving && (
        <div className="kc-newslit" style={{ left: left + lit.x1, top, height: Math.max(0, pane.height - FOOT - 4), width: Math.max(2, lit.x2 - lit.x1) }} aria-hidden />
      )}
      <div className={`kc-newsmarks${leaving ? ' is-leaving' : ''}`} ref={layer} style={{ left, top: top + pane.height - FOOT, width: pane.width }} aria-label="News and the economic calendar on the chart">
        {placed.map((p) => {
          const n = p.stories.length;
          const heat = markHeat(p.stories);
          const isOpen = open?.key === p.key;
          const state = `${heat ? ` kc-heat-${heat}` : ''}${isOpen ? ' is-open' : ''}${focus && p.stories.some((s) => isFocused(s, focus)) ? ' is-focus' : ''}`;
          const events = p.stories.filter((s) => s.event);
          if (events.length) {
            const lead = leadRelease(byDate(events), now);
            const ahead = p.key === 'ev:ahead';
            // A circle; it opens to its name and countdown on hover, or as the release comes near.
            return (
              <button
                key={p.key}
                type="button"
                className={`kc-calmark kc-calmark--${lead.event!.importance}${ahead ? ' kc-calmark--ahead' : ''}${lead.time > now ? ' is-due' : ''}${nearRelease(lead.time, now) ? ' is-near' : ''}${state}`}
                style={{ left: p.x }}
                aria-label={`${ahead ? 'Coming up: ' : ''}${lead.title}, ${countdown(lead.time, now)}${n > 1 ? `, and ${n - 1} more` : ''}`}
                aria-expanded={isOpen}
                {...hover(p.key)}
              >
                {NEWS_ICONS.event}
                <span className="kc-calmark__more">
                  {ahead && <span className="kc-calmark__dim">Next</span>}
                  <b>{lead.event!.short}</b>
                  <span className="kc-calmark__dim">{countdown(lead.time, now).replace(/^in /, '')}</span>
                </span>
                {n > 1 && <span className="kc-newsmark__n">{n > 99 ? '99+' : n}</span>}
              </button>
            );
          }
          // Among macro or all-crypto stories every coin is news; on a coin's chart, another coin is.
          const face = markFace(p, mode === 'coin' ? coin : '');
          const lead = p.stories[0]!;
          return (
            <button
              key={p.key}
              type="button"
              className={`kc-newsmark kc-newsmark--${face.kind}${state}`}
              style={{ left: p.x }}
              aria-label={`${n === 1 ? NEWS_KIND_LABEL[newsKind(lead)] : `${n} stories`}${heat ? ', hot' : ''}: ${lead.title}`}
              aria-expanded={isOpen}
              {...hover(p.key)}
            >
              {face.coin ? <CoinIcon coin={face.coin} size={16} /> : NEWS_ICONS[face.kind]}
              {n > 1 && <span className="kc-newsmark__n">{n > 99 ? '99+' : n}</span>}
            </button>
          );
        })}
      </div>
      {shown && box &&
        createPortal(
          <div
            className={`kc-newspop${open?.pinned ? ' is-pinned' : ''}${card.closing ? ' is-closing' : ''}`}
            role="dialog"
            aria-label={releases.length && !stories.length ? 'Releases on this bar' : 'News on this bar'}
            style={{
              left: Math.max(8, Math.min(window.innerWidth - CARD_W - 8, box.left + shown.x - 28)),
              // Clear above the marker (and its lift on hover), never on it.
              bottom: Math.max(8, window.innerHeight - box.top + CARD_GAP),
              width: CARD_W,
              // Never past the top of the window: what does not fit scrolls.
              maxHeight: Math.max(180, Math.min(440, box.top - CARD_GAP - 8)),
            }}
            onMouseEnter={hold}
            onMouseLeave={letGo}
          >
            <header className="kc-newspop__head">
              <span className="kc-newspop__title">{releases.length && !stories.length ? 'Economic calendar' : releases.length ? `Economic calendar · ${title}` : title}</span>
              <span className="kc-newspop__count">
                {[releases.length ? plural(releases.length, 'release', 'releases') : '', stories.length ? plural(stories.length, 'story', 'stories') : ''].filter(Boolean).join(' · ')}
              </span>
            </header>
            <ol className="kc-newspop__list">
              {releases.map((s) => (
                <li key={s.id} className="kc-newspop__row">
                  <a className="kc-newspop__item" href={s.href} target="_blank" rel="noopener noreferrer">
                    <span className="kc-newspop__meta">
                      <time dateTime={new Date(s.time).toISOString()}>{s.event!.allDay ? releaseDay(s.time) : storyTime(s.time, tz)}</time>
                      <span className={`kc-newspop__impact kc-newspop__impact--${s.event!.importance}`}>{IMPACT[s.event!.importance]}</span>
                      <span className="kc-newspop__by">{countdown(s.time, now)}</span>
                    </span>
                    <span className="kc-newspop__headline">{s.title}</span>
                    {(() => {
                      const r = results[s.id];
                      const figs = r ? r.fields.filter((f) => f.value !== null || f.prior !== null).slice(0, 4) : [];
                      if (!figs.length) return s.summary ? <span className="kc-newspop__sum">{s.summary}</span> : null;
                      return (
                        <span className={`kc-newspop__figs${r!.state === 'released' ? ' is-out' : ''}`}>
                          {figs.map((f) => (
                            <span key={f.key} className="kc-newspop__fig">
                              <small>{f.label}</small>
                              <b>{fmtField(f, f.value)}</b>
                              <i>prev {fmtField(f, f.prior)}</i>
                            </span>
                          ))}
                        </span>
                      );
                    })()}
                    <span className="kc-newspop__src">
                      {s.event!.allDay ? 'Time not published · ' : ''}
                      {s.author}
                    </span>
                  </a>
                  {isFomc(s) && (
                    <a className="kc-newspop__live" href={FED_LIVE_URL} target="_blank" rel="noopener noreferrer">
                      Watch live on the Federal Reserve's channel
                    </a>
                  )}
                </li>
              ))}
              {stories.map((s) => {
                const kind = newsKind(s);
                const coins = (s.symbols ?? []).slice(0, 4);
                const hotText = hotNote(s);
                return (
                  <li key={s.id} className="kc-newspop__row">
                    <a className="kc-newspop__item" href={s.href} target="_blank" rel="noopener noreferrer">
                      <span className="kc-newspop__meta">
                        <time dateTime={new Date(s.time).toISOString()}>{storyTime(s.time, tz)}</time>
                        <span className="kc-newspop__tag">
                          {NEWS_ICONS[kind]}
                          {NEWS_KIND_LABEL[kind]}
                        </span>
                        {hotText && (
                          <span className={`kc-newspop__hot kc-heat-${storyHeat(s)}`} title={s.rank ? "Its place on SoSoValue's hot list now" : 'Seen on X when SoSoValue read it'}>
                            {hotText}
                          </span>
                        )}
                        {s.author && <span className="kc-newspop__by">{s.author}</span>}
                      </span>
                      <span className={`kc-newspop__headline${s.post ? ' is-post' : ''}`}>{s.title}</span>
                      {s.summary && <span className="kc-newspop__sum">{s.summary}</span>}
                      {coins.length > 0 && (
                        <span className="kc-newspop__coins">
                          {coins.map((c) => (
                            <span key={c} className="kc-newspop__coin">
                              <CoinIcon coin={c} size={13} />
                              {c}
                            </span>
                          ))}
                        </span>
                      )}
                    </a>
                    {canSave && (
                      <button type="button" className="kc-newspop__save" title="Save to folder" aria-label={`Save to folder: ${s.title}`} onClick={() => onSave(s)}>
                        {MENU_ICONS.folder}
                      </button>
                    )}
                  </li>
                );
              })}
            </ol>
            <footer className="kc-newspop__foot">
              <PoweredBy more={releases.length > 0} />
            </footer>
          </div>,
          document.body,
        )}
    </>
  );
}
