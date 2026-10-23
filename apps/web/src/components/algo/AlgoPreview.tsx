/**
 * What an algo will do, drawn before it runs - from the engine's own plan
 * (same functions, same seed), so the bars are the children that will go out.
 *
 *   timeline  children over time (TWAP, VWAP, DCA, swarm): one bar per child,
 *             its height the size, and the cumulative fill as a line;
 *   ladder    resting levels by price (scale, iceberg at a price): one bar per
 *             level, its length the size, the mid as a dashed rule;
 *   levels    the prices it acts at, around the price now (chase, trailing,
 *             conditional, POV's limit): one rule per level.
 *
 * Shapes are SVG on a stretched viewBox (strokes do not scale); every label is
 * HTML, so text is never stretched with it.
 */
import type { AlgoPlan } from '@copy-engine';
import { fmtTime } from '../../format';

export interface Level {
  label: string;
  price: number;
  tone: 'now' | 'pos' | 'neg' | 'warn' | 'muted';
}

const W = 300;
const H = 84;

function fmtP(p: number): string {
  const a = Math.abs(p);
  const dp = a >= 1000 ? 0 : a >= 100 ? 1 : a >= 1 ? 2 : a >= 0.01 ? 4 : 6;
  return p.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: dp });
}

const pct = (p: number, ref: number | null): string => {
  if (!ref) return '';
  const d = (p / ref - 1) * 100;
  if (Math.abs(d) < 0.005) return '';
  return ` (${d > 0 ? '+' : '−'}${Math.abs(d).toFixed(Math.abs(d) < 1 ? 2 : 1)}%)`;
};

export function TimelinePreview({ plan, side }: { plan: AlgoPlan; side: 'buy' | 'sell' }) {
  const kids = plan.children.filter((c) => c.at !== null && c.qty > 0);
  if (!kids.length) return null;
  const t0 = plan.startsAt;
  const t1 = Math.max(plan.endsAt ?? kids[kids.length - 1]!.at!, kids[kids.length - 1]!.at! + 1, t0 + 1);
  const span = t1 - t0;
  const maxQ = Math.max(...kids.map((c) => c.qty));
  const total = kids.reduce((a, c) => a + c.qty, 0);
  const bw = Math.max(0.8, Math.min(14, (W / kids.length) * 0.62));
  let cum = 0;
  const pts: string[] = [`0,${H}`];
  for (const c of kids) {
    const x = ((c.at! - t0) / span) * (W - bw);
    pts.push(`${x.toFixed(2)},${(H - (cum / total) * (H - 4)).toFixed(2)}`);
    cum += c.qty;
    pts.push(`${x.toFixed(2)},${(H - (cum / total) * (H - 4)).toFixed(2)}`);
  }
  pts.push(`${W},${(H - (H - 4)).toFixed(2)}`);
  return (
    <figure className={`algo-pv algo-pv--time is-${side}`} aria-label={`${kids.length} children over the window`}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
        <line className="algo-pv__grid" x1="0" x2={W} y1={H - 0.5} y2={H - 0.5} />
        <line className="algo-pv__grid algo-pv__grid--even" x1="0" x2={W} y1={H / 2} y2={H / 2} />
        {kids.map((c, i) => {
          const h = Math.max(1.5, (c.qty / maxQ) * (H * 0.62));
          const x = ((c.at! - t0) / span) * (W - bw);
          return <rect key={i} className="algo-pv__bar" x={x} y={H - h} width={bw} height={h} rx={bw > 3 ? 1 : 0} />;
        })}
        <polyline className="algo-pv__cum" points={pts.join(' ')} />
      </svg>
      <figcaption className="algo-pv__axis">
        <span>{plan.startsAt <= Date.now() + 2_000 ? 'Now' : fmtTime(plan.startsAt)}</span>
        <span>{fmtTime(t1)}</span>
      </figcaption>
    </figure>
  );
}

export function LadderPreview({ plan, side, mid }: { plan: AlgoPlan; side: 'buy' | 'sell'; mid: number | null }) {
  const lv = plan.children.filter((c) => c.price !== null && c.qty > 0);
  if (!lv.length) return null;
  const prices = lv.map((c) => c.price!);
  let lo = Math.min(...prices, ...(mid ? [mid] : []));
  let hi = Math.max(...prices, ...(mid ? [mid] : []));
  if (hi === lo) {
    hi *= 1.001;
    lo *= 0.999;
  }
  const pad = (hi - lo) * 0.08;
  lo -= pad;
  hi += pad;
  const y = (p: number) => ((hi - p) / (hi - lo)) * H;
  const maxQ = Math.max(...lv.map((c) => c.qty));
  const bh = Math.max(1.2, Math.min(6, (H / lv.length) * 0.6));
  const midTop = mid ? (y(mid) / H) * 100 : null;
  const avgTop = plan.avgPrice ? (y(plan.avgPrice) / H) * 100 : null;
  return (
    <figure className={`algo-pv algo-pv--ladder is-${side}`} aria-label={`${lv.length} resting levels`}>
      <div className="algo-pv__plot">
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
          {lv.map((c, i) => (
            <rect key={i} className="algo-pv__bar" x={0} y={y(c.price!) - bh / 2} width={Math.max(2, (c.qty / maxQ) * (W * 0.78))} height={bh} rx={bh > 3 ? 1 : 0} />
          ))}
          {mid && <line className="algo-pv__mid" x1="0" x2={W} y1={y(mid)} y2={y(mid)} />}
          {plan.avgPrice && <line className="algo-pv__avg" x1="0" x2={W} y1={y(plan.avgPrice)} y2={y(plan.avgPrice)} />}
        </svg>
        {midTop !== null && (
          <span className="algo-pv__tag algo-pv__tag--mid" style={{ top: `${midTop}%` }}>
            Mid {fmtP(mid!)}
          </span>
        )}
        {avgTop !== null && plan.avgPrice && Math.abs((avgTop ?? 0) - (midTop ?? -99)) > 12 && (
          <span className="algo-pv__tag algo-pv__tag--avg" style={{ top: `${avgTop}%` }}>
            Avg {fmtP(plan.avgPrice)}
          </span>
        )}
      </div>
      <figcaption className="algo-pv__axis">
        <span>{fmtP(prices[0]!)}{pct(prices[0]!, mid)}</span>
        <span>{fmtP(prices[prices.length - 1]!)}{pct(prices[prices.length - 1]!, mid)}</span>
      </figcaption>
    </figure>
  );
}

export function LevelsPreview({ levels, mid }: { levels: Level[]; mid: number | null }) {
  const lv = levels.filter((l) => Number.isFinite(l.price) && l.price > 0);
  if (!lv.length) return null;
  let lo = Math.min(...lv.map((l) => l.price));
  let hi = Math.max(...lv.map((l) => l.price));
  if (hi === lo) {
    hi *= 1.002;
    lo *= 0.998;
  }
  const pad = (hi - lo) * 0.18;
  lo -= pad;
  hi += pad;
  const top = (p: number) => ((hi - p) / (hi - lo)) * 100;
  const sorted = [...lv].sort((a, b) => b.price - a.price);
  // Labels must not collide: each sits at least 15% below the one above it.
  let last = -100;
  const placed = sorted.map((l) => {
    const t = Math.max(top(l.price), last + 15);
    last = t;
    return { ...l, line: top(l.price), textAt: Math.min(t, 92) };
  });
  return (
    <figure className="algo-pv algo-pv--levels" aria-label="The prices it acts at">
      <div className="algo-pv__plot algo-pv__plot--levels">
        {placed.map((l) => (
          <div key={`${l.label}-${l.price}`} className={`algo-lv is-${l.tone}`}>
            <i className="algo-lv__rule" style={{ top: `${l.line}%` }} aria-hidden="true" />
            <span className="algo-lv__text" style={{ top: `${l.textAt}%` }}>
              <b>{l.label}</b> {fmtP(l.price)}
              <em>{l.tone === 'now' ? '' : pct(l.price, mid)}</em>
            </span>
          </div>
        ))}
      </div>
    </figure>
  );
}
