/**
 * One trader on the Copy page's grid: who, what they trade, the window's PnL
 * or return, their equity, the PnL curve, the copy score and a Copy button.
 *
 * The figures and the score come from the board row (first paint, stable sort:
 * copyScore.ts). The curve and the last trade come from the trader's own
 * profile, read from the venue IN THIS BROWSER (vsApi.trader, cached there)
 * once the card scrolls into view - four at a time, so a long grid does not
 * spend the venue's rate budget in one burst.
 */
import { useEffect, useId, useRef, useState, type CSSProperties, type MouseEvent } from 'react';
import { CoinIcon } from '../CoinIcon';
import { VENUE_BRAND } from '../venueBrand';
import { DASH, fmtUsd, shortAddr } from '../../format';
import { VENUE_LABEL, vsApi, type BoardWindow, type CardPeek, type TraderRow, type Window } from '../../vsApi';
import { explainScore, scoreBand, type CopyScore } from './copyScore';
import { fmtSignedPct, fmtSignedUsd } from './setup';
import { markOffscreen } from '../../offscreen';
import { serverCards } from '../../exchange/copyCards';
import { cardShown, PROFILE_WINDOW } from '@sign/valuedesk/cardPeek.js';

/* ------------------------------------------------------------ the peek ----- */

export interface TraderPeek {
  spark: number[] | null;
  lastActive: number | null;
}

const PEEK_CONCURRENCY = 4;
let running = 0;
let holds = 0;
const queue: Array<() => void> = [];
const peeks = new Map<string, Promise<CardPeek | null>>();

/**
 * Hold the cards' reads while something more important needs the venue's rate
 * budget - a trader's fill walk for the replay (Hyperliquid weighs a fill page
 * by the fills it returns). Reads already sent finish. Call the returned
 * function to let go; the queue runs again when nothing holds it.
 */
export function holdPeeks(): () => void {
  holds += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds -= 1;
    nextInQueue();
  };
}

function nextInQueue(): void {
  while (holds === 0 && running < PEEK_CONCURRENCY && queue.length) {
    running += 1;
    queue.shift()!();
  }
}

/** The trader's curves and last trade, at most PEEK_CONCURRENCY at once; one request per trader per page view (SoDEX: per window, as only the window shown is read). */
function peekProfile(venue: TraderRow['venue'], address: string, window: Window): Promise<CardPeek | null> {
  const key = venue === 'sodex' ? `${venue}:${address}:${window}` : `${venue}:${address}`;
  const hit = peeks.get(key);
  if (hit) return hit;
  const p = new Promise<CardPeek | null>((resolve) => {
    queue.push(() => {
      vsApi.traderPeek(venue, address, window).then(resolve, () => resolve(null)).finally(() => {
        running -= 1;
        nextInQueue();
      });
    });
    nextInQueue();
  });
  // A failed read is not remembered: the next view of the card asks again.
  p.then((v) => { if (v === null) peeks.delete(key); });
  peeks.set(key, p);
  return p;
}

/** The server's cards, read ahead for every leader of the page (exchange/copyCards.ts). */
const serverCard = serverCards();

/** The card's curve and last trade, read once the element has been on screen. */
export function useTraderPeek(row: TraderRow, w: BoardWindow): { ref: (el: HTMLElement | null) => void; peek: TraderPeek | null; loading: boolean; age: number | null } {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [seen, setSeen] = useState(false);
  const [done, setDone] = useState(false);
  const [peek, setPeek] = useState<TraderPeek | null>(
    row.spark && row.spark.length > 1 ? { spark: row.spark, lastActive: row.lastActive ?? null } : null,
  );
  /** How old the shown curve is, when it is the server's and older than its refresh interval (null: current). */
  const [age, setAge] = useState<number | null>(null);

  useEffect(() => {
    if (!el || seen) return;
    if (typeof IntersectionObserver === 'undefined') { setSeen(true); return; }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { setSeen(true); io.disconnect(); }
    }, { rootMargin: '200px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [el, seen]);

  useEffect(() => {
    if (!seen) return;
    let dead = false;
    const venueRead = () => peekProfile(row.venue, row.address, PROFILE_WINDOW[w]).then((p) => {
      if (dead) return;
      if (p) {
        setPeek(cardShown(p, w));
        setAge(null);
      }
      setDone(true);
    });
    // The server's card first: shown at once. Within its refresh interval it is the answer; older, it is
    // shown with its age and the venue is read here as before, replacing it when it comes.
    void serverCard(row.venue, row.address, w).then((c) => {
      if (dead) return;
      if (!c) return void venueRead();
      if (!('none' in c)) setPeek({ spark: c.spark, lastActive: c.lastActive });
      if (c.fresh) return void setDone(true);
      if (!('none' in c)) setAge(c.age);
      return void venueRead();
    });
    return () => { dead = true; };
  }, [seen, row.venue, row.address, w]);

  return { ref: setEl, peek, loading: !done && !peek, age };
}

/** A curve older than its refresh interval: "2h old", in the card's small muted type. */
export function AgeHint({ age, className }: { age: number | null; className?: string }) {
  if (age === null) return null;
  const read = fmtAgo(Date.now() - age);
  return <span className={`cpy-card__age ${className ?? ''}`} title={`Curve read ${read}; updating from the venue`}>{read.replace(' ago', ' old')}</span>;
}

/* ------------------------------------------------------------ the parts ---- */

/** A gradient disc from the address: the same trader always looks the same. */
export function Avatar({ address, size = 32 }: { address: string; size?: number }) {
  const h = parseInt(address.slice(2, 8), 16) || 0;
  const a = h % 360;
  const b = (a + 40 + ((h >> 9) % 140)) % 360;
  const style: CSSProperties = {
    width: size,
    height: size,
    background: `radial-gradient(circle at 30% 30%, hsl(${a} 70% 62%), hsl(${b} 55% 34%) 72%)`,
  };
  return <span className="cpy-avatar" style={style} aria-hidden="true" />;
}

/** A filled PnL curve; the line is green above its start and red below it. `loading`: a shimmer in its place. */
export function Spark({ values, className, loading }: { values: number[] | null; className?: string; loading?: boolean }) {
  const id = `cpy-sp-${useId().replace(/:/g, '')}`;
  if (!values || values.length < 2) {
    return <div className={`cpy-spark ${loading ? 'cpy-spark--loading' : 'cpy-spark--empty'} ${className ?? ''}`} aria-hidden="true" />;
  }
  const W = 220;
  const H = 72;
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  const span = max - min || 1;
  const x = (i: number) => (i / (values.length - 1)) * W;
  const y = (v: number) => H - 3 - ((v - min) / span) * (H - 6);
  const line = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const zero = y(0);
  const up = values[values.length - 1]! >= values[0]!;
  return (
    <svg className={`cpy-spark ${className ?? ''}`} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id={`${id}-f`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={up ? 'var(--pos)' : 'var(--neg)'} stopOpacity="0.28" />
          <stop offset="1" stopColor={up ? 'var(--pos)' : 'var(--neg)'} stopOpacity="0" />
        </linearGradient>
        <clipPath id={`${id}-a`}><rect x="0" y="0" width={W} height={zero} /></clipPath>
        <clipPath id={`${id}-b`}><rect x="0" y={zero} width={W} height={H - zero} /></clipPath>
      </defs>
      <path d={`${line}L${W},${H}L0,${H}Z`} fill={`url(#${id}-f)`} />
      <line x1="0" x2={W} y1={zero} y2={zero} className="cpy-spark__zero" />
      <path d={line} className="cpy-spark__line cpy-spark__line--pos" clipPath={`url(#${id}-a)`} />
      <path d={line} className="cpy-spark__line cpy-spark__line--neg" clipPath={`url(#${id}-b)`} />
      <circle cx={x(values.length - 1)} cy={y(values[values.length - 1]!)} r="2.5" className={up ? 'cpy-spark__dot--pos' : 'cpy-spark__dot--neg'} />
    </svg>
  );
}

/** "96/100" and ten bars, lit to the score. */
export function ScoreMeter({ s }: { s: CopyScore }) {
  const lit = Math.round(s.score / 10);
  return (
    <span className={`cpy-score cpy-score--${s.kind} cpy-score--${scoreBand(s.score)}`} title={explainScore(s)}>
      <span className="cpy-score__n"><b>{s.score}</b>/100</span>
      <span className="cpy-score__bars" aria-hidden="true">
        {Array.from({ length: 10 }, (_, i) => <i key={i} className={i < lit ? 'is-on' : undefined} />)}
      </span>
    </span>
  );
}

export function fmtAgo(ms: number | null | undefined): string {
  if (!ms) return DASH;
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 129_600) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}

/** A HL xyz-dex symbol ("xyz:SP500") shows as its ticker. */
const tickerOf = (sym: string): string => sym.replace(/^[a-z]+:/, '');

export function CoinRow({ assets, max = 4 }: { assets: readonly string[] | undefined; max?: number }) {
  const list = (assets ?? []).slice(0, max);
  if (!list.length) return null;
  return (
    <span className="cpy-coins" title={(assets ?? []).map(tickerOf).join(', ')}>
      {list.map((a) => <CoinIcon key={a} coin={tickerOf(a)} size={16} />)}
      {(assets?.length ?? 0) > max && <span className="cpy-coins__more">+{assets!.length - max}</span>}
    </span>
  );
}

export const WINDOW_SHORT: Record<BoardWindow, string> = { '1d': '24H', '7d': '7D', '30d': '30D', '90d': '90D', ytd: 'YTD', all: 'All' };

/* ------------------------------------------------------- the two buttons ---- */

export const CopyGlyph = () => (
  <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
    <rect x="5.5" y="5.5" width="8" height="8" rx="2" fill="none" stroke="currentColor" strokeWidth="1.6" />
    <path d="M10.5 3.4A1.9 1.9 0 0 0 8.6 1.5H4.4a1.9 1.9 0 0 0-1.9 1.9v4.2a1.9 1.9 0 0 0 1.9 1.9" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
);
export const CounterGlyph = () => (
  <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
    <path d="M2.5 5.5H12M9.5 3 12 5.5 9.5 8M13.5 10.5H4M6.5 8 4 10.5 6.5 13" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/**
 * Copy or Counter: the two sides' buttons, ONE width whatever the word, so a
 * grid of green and red cards lines its buttons up. `label` replaces the word
 * (the trader page's larger pair, 'lg', which share a width of their own).
 */
export function CopyButton({ kind, copying, onClick, size = 'md', label, title }: {
  kind: 'copy' | 'counter';
  copying?: boolean;
  onClick: (e: MouseEvent) => void;
  size?: 'md' | 'lg';
  label?: string;
  title?: string;
}) {
  const text = label ?? (copying ? 'Copying' : kind === 'copy' ? 'Copy' : 'Counter');
  return (
    <button type="button" title={title} className={`cpy-copybtn cpy-copybtn--${kind} cpy-copybtn--${size}${copying ? ' is-copying' : ''}`} onClick={onClick}>
      {copying ? <span className="cpy-copybtn__live" aria-hidden="true" /> : kind === 'copy' ? <CopyGlyph /> : <CounterGlyph />}
      <span>{text}</span>
    </button>
  );
}

const ViewGlyph = () => (
  <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
    <path d="M1.6 8S4 3.6 8 3.6 14.4 8 14.4 8 12 12.4 8 12.4 1.6 8 1.6 8Z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    <circle cx="8" cy="8" r="2" fill="none" stroke="currentColor" strokeWidth="1.5" />
  </svg>
);

/**
 * A trader on a platform a copy cannot follow (Lighter, Arcus, trade.xyz): the
 * Copy button's place and width, opening the trader in Scan instead.
 */
export function ViewButton({ venue, onClick }: { venue: TraderRow['venue']; onClick: (e: MouseEvent) => void }) {
  return (
    <button
      type="button"
      className="cpy-copybtn cpy-copybtn--view cpy-copybtn--md"
      onClick={onClick}
      title={`Copying ${VENUE_LABEL[venue]} traders is not supported yet - this opens the trader in Scan`}
    >
      <ViewGlyph />
      <span>View</span>
    </button>
  );
}

/** Fewer closed trades than this and a win rate says little: it is shown, but not coloured. */
const THIN_CLOSES = 5;

/**
 * A win rate in the colour of its value - neutral at 50%, greener above, redder
 * below - over a small bar. From fewer than THIN_CLOSES closed trades it stays
 * grey (a 0% from one losing close is not a signal); the count is in its title.
 */
export function WinRate({ value, closes }: { value: number | null | undefined; closes?: number | null }) {
  if (value == null) return <span className="cpy-wr is-none">{DASH}</span>;
  const thin = closes != null && closes < THIN_CLOSES;
  const t = thin ? 0 : Math.max(-1, Math.min(1, (value - 0.5) / 0.2));
  const tone = t >= 0
    ? `color-mix(in srgb, var(--pos) ${Math.round(t * 100)}%, var(--muted))`
    : `color-mix(in srgb, var(--neg) ${Math.round(-t * 100)}%, var(--muted))`;
  const pct = Math.round(value * 100);
  return (
    <span className={`cpy-wr${thin ? ' is-thin' : ''}`} style={{ '--wr': tone } as CSSProperties} title={`Win rate ${pct}%${closes != null ? ` from ${closes} closed trade${closes === 1 ? '' : 's'}` : ''}`}>
      <b>{pct}%</b>
      <span className="cpy-wr__bar" aria-hidden="true"><span style={{ width: `${pct}%` }} /></span>
    </span>
  );
}

/* ------------------------------------------------------------- the card ---- */

export interface TraderCardProps {
  row: TraderRow;
  score: CopyScore;
  window: BoardWindow;
  /** The big figure: the window's PnL in dollars, or its return in percent. */
  unit: 'usd' | 'pct';
  /** 'copy': a trader to copy, glowing green. 'counter': one to trade against, glowing red (the order ticket's two sides). */
  kind?: 'copy' | 'counter';
  onOpen: (row: TraderRow) => void;
  onCopy: (row: TraderRow) => void;
  /** Already copying this trader: the button says so. */
  copying?: boolean;
  /** A copy can follow this trader's platform; when not, the button is View (onOpen opens Scan). */
  copyable?: boolean;
}

export function TraderCard({ row, score, window: w, unit, kind = 'copy', onOpen, onCopy, copying, copyable = true }: TraderCardProps) {
  const { ref, peek, loading, age } = useTraderPeek(row, w);
  const pnl = row.pnl[w] ?? null;
  const big = unit === 'usd' ? fmtSignedUsd(pnl, 0) : fmtSignedPct(score.roi, 1);
  const bigVal = unit === 'usd' ? pnl : score.roi;
  const cls = bigVal === null ? 'is-dim' : bigVal >= 0 ? 'pos' : 'neg';
  const copy = (e: MouseEvent) => { e.stopPropagation(); onCopy(row); };
  // The glare stops while the card is scrolled away (offscreen.ts, CopyHome.css).
  const glow = useRef<HTMLSpanElement>(null);
  useEffect(() => (glow.current ? markOffscreen(glow.current) : undefined), []);
  return (
    <article
      ref={ref}
      className={`cpy-card cpy-card--${kind} cpy-card--${scoreBand(score.score)}`}
      tabIndex={0}
      onClick={() => onOpen(row)}
      onKeyDown={(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) onOpen(row); }}
      aria-label={`Trader ${shortAddr(row.address)} on ${VENUE_LABEL[row.venue]}`}
    >
      {/* The order ticket's side glow (OrderEntry.css .oe-fx): a wash, a rim and a slow glare, rising from the score. */}
      <span className="cpy-glow" ref={glow} aria-hidden="true">
        <span className="cpy-glow__rim"><span className="cpy-glow__glare" /></span>
      </span>
      <header className="cpy-card__head">
        <Avatar address={row.address} />
        <div className="cpy-card__id">
          <span className="cpy-card__addr" title={row.address}>{shortAddr(row.address)}</span>
          <span className="cpy-card__meta">
            <span className="cpy-venue" style={{ '--venue': VENUE_BRAND[row.venue] } as CSSProperties}>{VENUE_LABEL[row.venue]}</span>
            <CoinRow assets={row.assets} />
          </span>
        </div>
        <span className="cpy-card__ago" title="Last trade">
          {peek?.lastActive ? fmtAgo(peek.lastActive) : row.rank ? `#${row.rank}` : ''}
        </span>
      </header>

      <div className="cpy-card__body">
        <div className="cpy-card__figs">
          <span className={`cpy-card__big ${cls}`}>{big}</span>
          <span className="cpy-card__lbl">{unit === 'usd' ? 'PnL' : 'Return'} {WINDOW_SHORT[w]}</span>
          <span className="cpy-card__eq">{row.accountValue == null ? DASH : fmtUsd(row.accountValue, 0)}</span>
          <span className="cpy-card__lbl">Equity</span>
        </div>
        <div className="cpy-card__chart">
          <Spark values={peek?.spark ?? null} loading={loading} className="cpy-card__spark" />
          <AgeHint age={age} />
        </div>
      </div>

      <footer className="cpy-card__foot">
        <ScoreMeter s={score} />
        {copyable
          ? <CopyButton kind={kind} copying={copying} onClick={copy} />
          : <ViewButton venue={row.venue} onClick={(e) => { e.stopPropagation(); onOpen(row); }} />}
      </footer>
    </article>
  );
}
