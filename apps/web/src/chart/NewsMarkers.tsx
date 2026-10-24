/**
 * News on the chart (Chart.tsx, toolbar's news button): SoSoValue stories as
 * markers along the foot of the price pane, on the bar each came out in.
 *
 * A marker shows what it is (chartMarks.ts markFace): the logo of the coin a
 * story is about, X's mark for a post, the globe for macro, an icon for
 * research, an announcement, an institution... and a count only where several
 * stories share it. Markers that would overlap at the zoom on screen are one
 * (clusterNews), so a busy hour is one marker with a count, not a row of them.
 *
 * Hover a marker for its stories; click to keep them open until a click
 * elsewhere or Escape. The card is a glass sheet like the app's drawers; every
 * story opens its article in a new tab, and can be saved to a knowledge folder
 * where the folders are there.
 *
 * A DOM layer, not canvas: logos are images, and the hover is the browser's.
 * Positions follow the chart frame by frame, re-rendering this layer alone.
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Chart as KChart } from 'klinecharts';
import { CoinIcon } from '../components/CoinIcon';
import { MENU_ICONS } from '../dashboard/tabExtras';
import { NEWS_ICONS } from './chartIcons';
import { NEWS_KIND_LABEL, clusterNews, markFace, newsKind, type NewsMark, type NewsScope, type NewsStory, type PlacedNews } from './chartMarks';
import { useLatched } from '../components/motion';
import type { TimeZoneMode } from './timeAxis';

const PANE = 'candle_pane';
/** A marker is 24px; closer than this they are one. */
const GAP = 28;
/** From the pane's foot to the marker's top. */
const FOOT = 32;
const CARD_W = 348;

export interface NewsMarkersProps {
  chart: KChart | null;
  marks: readonly NewsMark[];
  /** The canvas's place in the pane (its offset), where the price pane starts. */
  left: number;
  top: number;
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
/** The release a pill is named for: the next one that matters most, else the latest. */
function leadRelease(list: readonly NewsStory[], now: number): NewsStory {
  const coming = list.filter((s) => s.time >= now);
  if (coming.length) return [...coming].sort((a, b) => WEIGHT[b.event!.importance] - WEIGHT[a.event!.importance] || a.time - b.time)[0]!;
  return list[list.length - 1]!;
}

/** An all-day release's date ("Wed 28 Oct"): its time is midday UTC of that date, read in UTC. */
const releaseDay = (t: number) => new Date(t).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

export function NewsMarkers({ chart, marks, left, top, coin, mode, leaving = false, tz, canSave, onSave }: NewsMarkersProps) {
  const [placed, setPlaced] = useState<PlacedNews[]>([]);
  /** The economic calendar's releases: a row of their own, above the news. */
  const [releases, setReleases] = useState<PlacedNews[]>([]);
  const [pane, setPane] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
  const [open, setOpen] = useState<{ key: string; pinned: boolean } | null>(null);
  const layer = useRef<HTMLDivElement>(null);
  const closeTimer = useRef(0);
  /** The card stays a moment as it closes, to fade out. */
  const card = useLatched(open?.key ?? null, 140);

  // Where each marker is, every frame; a render only when one moved.
  useEffect(() => {
    if (!chart || marks.length === 0) {
      setPlaced([]);
      setReleases([]);
      return;
    }
    let raf = 0;
    let last = '';
    const tick = () => {
      const size = chart.getSize(PANE);
      const width = size?.width ?? 0;
      const height = size?.height ?? 0;
      const on: PlacedNews[] = [];
      const due: PlacedNews[] = [];
      const later: NewsStory[] = [];
      for (const m of marks) {
        const px = chart.convertToPixel({ timestamp: m.timestamp, value: 0 }, { paneId: PANE }) as { x?: number };
        const x = px.x;
        if (typeof x !== 'number' || !Number.isFinite(x)) continue;
        const events = m.stories.filter((s) => s.event);
        // Past the right edge: still to come, gathered at the edge.
        if (x > width - 6) {
          later.push(...events);
          continue;
        }
        if (x < 6) continue;
        const stories = m.stories.filter((s) => !s.event);
        if (stories.length) on.push({ key: m.key, x: Math.round(x), timestamp: m.timestamp, stories });
        if (events.length) due.push({ key: `ev:${m.key}`, x: Math.round(x), timestamp: m.timestamp, stories: events });
      }
      const next = clusterNews(on, GAP);
      // A release's pill is wider than a story's marker; one where "Next" sits joins it.
      const nextDue: PlacedNews[] = [];
      for (const p of clusterNews(due, GAP * 1.8)) {
        if (later.length && p.x >= width - 120) later.push(...p.stories);
        else nextDue.push({ ...p, stories: byDate(p.stories) });
      }
      if (later.length) nextDue.push({ key: 'ev:ahead', x: width - 4, timestamp: later[0]!.time, stories: byDate(later).slice(0, 12) });
      const sig = `${width}x${height}|${next.map((p) => `${p.key}@${p.x}:${p.stories.length}`).join(',')}|${nextDue.map((p) => `${p.key}@${p.x}:${p.stories.length}`).join(',')}`;
      if (sig !== last) {
        last = sig;
        setPlaced(next);
        setReleases(nextDue);
        setPane({ width, height });
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [chart, marks]);

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

  if (placed.length === 0 && releases.length === 0) return null;
  const shown = card.value ? placed.find((p) => p.key === card.value) ?? releases.find((p) => p.key === card.value) : undefined;
  const isRelease = !!shown?.stories[0]?.event;
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

  return (
    <>
      {releases.length > 0 && (
        <div className={`kc-calmarks${leaving ? ' is-leaving' : ''}`} style={{ left, top: top + pane.height - FOOT - 28, width: pane.width }} aria-label="Economic calendar on the chart">
          {releases.map((p) => {
            const lead = leadRelease(p.stories, now);
            const n = p.stories.length;
            const ahead = p.key === 'ev:ahead';
            const imp = lead.event!.importance;
            return (
              <button
                key={p.key}
                type="button"
                className={`kc-calmark kc-calmark--${imp}${ahead ? ' kc-calmark--ahead' : ''}${open?.key === p.key ? ' is-open' : ''}${lead.time > now ? ' is-due' : ''}`}
                style={{ left: p.x }}
                aria-label={`${ahead ? 'Coming up: ' : ''}${lead.title}, ${countdown(lead.time, now)}${n > 1 ? `, and ${n - 1} more` : ''}`}
                aria-expanded={open?.key === p.key}
                {...hover(p.key)}
              >
                {NEWS_ICONS.event}
                {ahead && <span className="kc-calmark__n">Next</span>}
                <span className="kc-calmark__t">{lead.event!.short}</span>
                {ahead ? <span className="kc-calmark__n">{countdown(lead.time, now).replace(/^in /, '')}</span> : n > 1 && <span className="kc-calmark__n">+{n - 1}</span>}
              </button>
            );
          })}
        </div>
      )}
      <div className={`kc-newsmarks${leaving ? ' is-leaving' : ''}`} ref={layer} style={{ left, top: top + pane.height - FOOT, width: pane.width }} aria-label="News on the chart">
        {placed.map((p) => {
          // Among macro or all-crypto stories every coin is news; on a coin's chart, another coin is.
          const face = markFace(p, mode === 'coin' ? coin : '');
          const n = p.stories.length;
          const lead = p.stories[0]!;
          return (
            <button
              key={p.key}
              type="button"
              className={`kc-newsmark kc-newsmark--${face.kind}${open?.key === p.key ? ' is-open' : ''}`}
              style={{ left: p.x }}
              aria-label={`${n === 1 ? NEWS_KIND_LABEL[newsKind(lead)] : `${n} stories`}: ${lead.title}`}
              aria-expanded={open?.key === p.key}
              onMouseEnter={() => {
                hold();
                setOpen((o) => (o?.pinned ? o : { key: p.key, pinned: false }));
              }}
              onMouseLeave={letGo}
              onClick={() => {
                hold();
                setOpen((o) => (o?.key === p.key && o.pinned ? null : { key: p.key, pinned: true }));
              }}
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
            aria-label="News on this bar"
            style={{
              left: Math.max(8, Math.min(window.innerWidth - CARD_W - 8, box.left + shown.x - 28)),
              bottom: Math.max(8, window.innerHeight - box.top + 8),
              width: CARD_W,
              // Never past the top of the window: what does not fit scrolls.
              maxHeight: Math.max(180, Math.min(440, box.top - 16)),
            }}
            onMouseEnter={hold}
            onMouseLeave={letGo}
          >
            <header className="kc-newspop__head">
              <span className="kc-newspop__title">{isRelease ? 'Economic calendar' : mode === 'macro' ? 'Macro news' : mode === 'all' ? 'Crypto news' : `${coin} news`}</span>
              <span className="kc-newspop__count">
                {isRelease ? (shown.stories.length === 1 ? '1 release' : `${shown.stories.length} releases`) : shown.stories.length === 1 ? '1 story' : `${shown.stories.length} stories`}
              </span>
            </header>
            <ol className="kc-newspop__list">
              {isRelease && shown.stories.map((s) => (
                <li key={s.id} className="kc-newspop__row">
                  <a className="kc-newspop__item" href={s.href} target="_blank" rel="noopener noreferrer">
                    <span className="kc-newspop__meta">
                      <time dateTime={new Date(s.time).toISOString()}>{s.event!.allDay ? releaseDay(s.time) : storyTime(s.time, tz)}</time>
                      <span className={`kc-newspop__impact kc-newspop__impact--${s.event!.importance}`}>{IMPACT[s.event!.importance]}</span>
                      <span className="kc-newspop__by">{countdown(s.time, now)}</span>
                    </span>
                    <span className="kc-newspop__headline">{s.title}</span>
                    {s.summary && <span className="kc-newspop__sum">{s.summary}</span>}
                    <span className="kc-newspop__src">
                      {s.event!.allDay ? 'Time not published · ' : ''}
                      {s.author}
                    </span>
                  </a>
                </li>
              ))}
              {!isRelease && shown.stories.map((s) => {
                const kind = newsKind(s);
                const coins = (s.symbols ?? []).slice(0, 4);
                return (
                  <li key={s.id} className="kc-newspop__row">
                    <a className="kc-newspop__item" href={s.href} target="_blank" rel="noopener noreferrer">
                      <span className="kc-newspop__meta">
                        <time dateTime={new Date(s.time).toISOString()}>{storyTime(s.time, tz)}</time>
                        <span className="kc-newspop__tag">
                          {NEWS_ICONS[kind]}
                          {NEWS_KIND_LABEL[kind]}
                        </span>
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
              {isRelease ? 'From the Federal Reserve, BLS, BEA and SoSoValue · opens the publisher’s page' : 'SoSoValue · each story opens in a new tab'}
            </footer>
          </div>,
          document.body,
        )}
    </>
  );
}
