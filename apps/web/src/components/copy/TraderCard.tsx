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
import { useEffect, useId, useState, type CSSProperties, type MouseEvent } from 'react';
import { CoinIcon } from '../CoinIcon';
import { VENUE_BRAND } from '../venueBrand';
import { DASH, fmtUsd, shortAddr } from '../../format';
import { VENUE_LABEL, vsApi, type BoardWindow, type TraderProfile, type TraderRow, type Window } from '../../vsApi';
import { explainScore, scoreBand, type CopyScore } from './copyScore';
import { fmtSignedPct, fmtSignedUsd } from './setup';

/* ------------------------------------------------------------ the peek ----- */

export interface TraderPeek {
  spark: number[] | null;
  lastActive: number | null;
}

const PEEK_CONCURRENCY = 4;
let running = 0;
let holds = 0;
const queue: Array<() => void> = [];
const peeks = new Map<string, Promise<TraderProfile | null>>();

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

/** The trader's profile, at most PEEK_CONCURRENCY at once; one request per trader per page view. */
function peekProfile(venue: TraderRow['venue'], address: string): Promise<TraderProfile | null> {
  const key = `${venue}:${address}`;
  const hit = peeks.get(key);
  if (hit) return hit;
  const p = new Promise<TraderProfile | null>((resolve) => {
    queue.push(() => {
      vsApi.trader(venue, address).then(resolve, () => resolve(null)).finally(() => {
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

const PROFILE_WINDOW: Record<BoardWindow, Window> = { '1d': '1d', '7d': '7d', '30d': '30d', '90d': 'all', ytd: 'all', all: 'all' };

function peekOf(p: TraderProfile, w: BoardWindow): TraderPeek {
  const series = p.equity[PROFILE_WINDOW[w]] ?? p.equity['30d'] ?? [];
  const pnl = series.flatMap((pt) => (pt.pnl === null ? [] : [pt.pnl]));
  const spark = pnl.length > 1 ? pnl : p.summary.spark && p.summary.spark.length > 1 ? p.summary.spark : null;
  return { spark, lastActive: p.summary.lastActive ?? null };
}

/** The card's curve and last trade, read once the element has been on screen. */
export function useTraderPeek(row: TraderRow, w: BoardWindow): { ref: (el: HTMLElement | null) => void; peek: TraderPeek | null; loading: boolean } {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [seen, setSeen] = useState(false);
  const [done, setDone] = useState(false);
  const [peek, setPeek] = useState<TraderPeek | null>(
    row.spark && row.spark.length > 1 ? { spark: row.spark, lastActive: row.lastActive ?? null } : null,
  );

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
    void peekProfile(row.venue, row.address).then((p) => {
      if (dead) return;
      if (p) setPeek(peekOf(p, w));
      setDone(true);
    });
    return () => { dead = true; };
  }, [seen, row.venue, row.address, w]);

  return { ref: setEl, peek, loading: !done && !peek };
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
}

export function TraderCard({ row, score, window: w, unit, kind = 'copy', onOpen, onCopy, copying }: TraderCardProps) {
  const { ref, peek, loading } = useTraderPeek(row, w);
  const pnl = row.pnl[w] ?? null;
  const big = unit === 'usd' ? fmtSignedUsd(pnl, 0) : fmtSignedPct(score.roi, 1);
  const bigVal = unit === 'usd' ? pnl : score.roi;
  const cls = bigVal === null ? 'is-dim' : bigVal >= 0 ? 'pos' : 'neg';
  const copy = (e: MouseEvent) => { e.stopPropagation(); onCopy(row); };
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
      <span className="cpy-glow" aria-hidden="true">
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
        <Spark values={peek?.spark ?? null} loading={loading} className="cpy-card__spark" />
      </div>

      <footer className="cpy-card__foot">
        <ScoreMeter s={score} />
        <button type="button" className={`cpy-copybtn cpy-copybtn--${kind}${copying ? ' is-copying' : ''}`} onClick={copy}>
          {copying ? 'Copying' : kind === 'copy' ? 'Copy' : 'Counter'}
        </button>
      </footer>
    </article>
  );
}
