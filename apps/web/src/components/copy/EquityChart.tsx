/**
 * Follower vs leader equity for the backtest.
 *
 * The portfolio's equity curve, drawn twice: same measured-pixel SVG, same
 * `.pf-chart__*` grid, labels, cursor and tooltip, so it reads as the app's
 * chart and not as a new one. What differs is only what two series need - a
 * time axis (fills are irregular, so x is time, not index) and a legend.
 *
 * Colours follow the app's rule for series with no profit/loss meaning: the
 * thing the page is ABOUT - your copy - is the accent, the comparison is muted.
 * Neither line is green or red: equity rising is not a profit on its own, and
 * the start line is what gains and losses are read against.
 *
 * `pnl` draws the same two series as PnL from the start (the copy dialog's
 * expected-result chart): the start line becomes $0, labels and tooltip sign.
 */
import { useEffect, useRef, useState } from 'react';
import { fmtUsd } from '../../format';
import { fmtSignedUsd } from './setup';
import type { EquityPoint } from '../../vsApi';
import { fmtCompactUsd } from '../portfolio/parts';

/** Axis money: whole dollars below $10k (the allocation scale), the portfolio's compact form above. */
const fmtAxis = (v: number, step: number): string =>
  Math.abs(v) >= 10_000 ? fmtCompactUsd(v) : fmtUsd(v, step < 1 ? 2 : 0);

const fmtAxisDay = (t: number) => new Date(t).toLocaleDateString('en-US', { month: 'short', day: '2-digit' });
const fmtAxisTime = (t: number) => new Date(t).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
const fmtTip = (t: number) =>
  new Date(t).toLocaleString('en-US', { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });

/** Index of the point nearest `t` in an ascending series. */
function nearest(ts: number[], t: number): number {
  let lo = 0;
  let hi = ts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ts[mid]! < t) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(ts[lo - 1]! - t) <= Math.abs(ts[lo]! - t)) return lo - 1;
  return lo;
}

export function EquityChart({ you, leader, base: start, pnl = false }: { you: EquityPoint[]; leader: EquityPoint[]; base: number; pnl?: boolean }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const r = entry?.contentRect;
      if (r) setBox({ w: Math.round(r.width), h: Math.round(r.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const n = Math.min(you.length, leader.length);
  const ts = you.slice(0, n).map((p) => p.t);
  // PnL: every value less the start, so the start line is $0.
  const base = pnl ? 0 : start;
  const off = pnl ? start : 0;
  const ys = you.slice(0, n).map((p) => (p.accountValue ?? start) - off);
  const ls = leader.slice(0, n).map((p) => (p.accountValue ?? start) - off);
  const money = (v: number) => (pnl ? fmtSignedUsd(v, 2) : fmtUsd(v, 2));

  const W = box.w || 600;
  const H = box.h || 220;
  const PAD_R = 58;
  const PAD_B = 28;
  const PAD_T = 8;
  const PLOT_W = Math.max(1, W - PAD_R);
  const PLOT_H = Math.max(1, H - PAD_B);

  if (n < 2 || ts[n - 1]! <= ts[0]!) {
    /* Same root element as the drawn chart, so the size observer survives the swap. */
    return (
      <div className="pf-chart pf-chart--empty copy-chart" ref={boxRef}>
        <p>Too few fills in this window to draw a curve.</p>
      </div>
    );
  }

  let lo = Math.min(base, ...ys, ...ls);
  let hi = Math.max(base, ...ys, ...ls);
  if (hi === lo) {
    const pad = Math.max(1, Math.abs(hi) * 0.01);
    hi += pad;
    lo -= pad;
  }
  const span = hi - lo;
  const y = (v: number) => PAD_T + (PLOT_H - PAD_T) - ((v - lo) / span) * (PLOT_H - PAD_T);
  const t0 = ts[0]!;
  const t1 = ts[n - 1]!;
  const x = (t: number) => ((t - t0) / (t1 - t0)) * PLOT_W;

  /* Y ticks on round values, the same 1/2/5 x 10^n rule as the portfolio curve,
     plus the start line, which is what every gain or loss is read against. */
  const targetTicks = Math.max(3, Math.min(6, Math.floor((PLOT_H - PAD_T) / 30)));
  const rawStep = span / targetTicks;
  const mag = 10 ** Math.floor(Math.log10(Math.abs(rawStep) || 1));
  const norm = rawStep / mag;
  const step = (norm >= 5 ? 5 : norm >= 2 ? 2 : 1) * mag;
  const minGap = 14;
  const ticks: number[] = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi + 1e-9; t += step) ticks.push(t);
  const shownTicks = ticks.filter((t) => Math.abs(y(t) - y(base)) >= minGap);

  /* Date labels that FIT, checked in pixels (see the portfolio curve). */
  const daySpan = (t1 - t0) > 2 * 86_400_000;
  const LABEL_W = daySpan ? 48 : 40;
  const fmtX = daySpan ? fmtAxisDay : fmtAxisTime;
  let xTicks: number[] = [t0, t1];
  for (let c = 6; c >= 2; c--) {
    const cand = Array.from({ length: c }, (_, k) => t0 + ((t1 - t0) * k) / (c - 1));
    const fits = cand.every((t, j) => j === 0 || x(t) - x(cand[j - 1]!) >= LABEL_W + 12);
    if (fits) { xTicks = cand; break; }
  }

  const path = (vals: number[]) =>
    vals.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(ts[i]!).toFixed(1)},${y(v).toFixed(1)}`).join(' ');

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - r.left;
    if (px > PLOT_W || px < 0) return setHover(null);
    setHover(nearest(ts, t0 + (px / PLOT_W) * (t1 - t0)));
  };

  const h = hover;
  const last = n - 1;

  return (
    <div className="pf-chart copy-chart" ref={boxRef}>
      <svg
        className="pf-chart__svg"
        viewBox={`0 0 ${W} ${H}`}
        width={W}
        height={H}
        role="img"
        aria-label={pnl
          ? `Replayed PnL: yours ends at ${money(ys[last]!)}, the trader scaled to your start ends at ${money(ls[last]!)}.`
          : `Backtest equity: your copy ends at ${fmtUsd(ys[last]!, 2)}, the leader scaled to the same start ends at ${fmtUsd(ls[last]!, 2)}.`}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        {shownTicks.map((t) => (
          <g key={t}>
            <line x1="0" y1={y(t)} x2={PLOT_W} y2={y(t)} className="pf-chart__grid" />
            <text x={PLOT_W + 5} y={y(t) + 3} className="pf-chart__ylabel">{fmtAxis(t, step)}</text>
          </g>
        ))}
        <line x1="0" y1={y(base)} x2={PLOT_W} y2={y(base)} className="pf-chart__zero" />
        <text x={PLOT_W + 5} y={y(base) + 3} className="pf-chart__ylabel">{fmtAxis(base, step)}</text>

        <path d={path(ls)} className="copy-chart__line copy-chart__line--leader" />
        <path d={path(ys)} className="copy-chart__line copy-chart__line--you" />

        {xTicks.map((t, i) => (
          <text
            key={t}
            x={Math.min(PLOT_W, Math.max(0, x(t)))}
            y={PLOT_H + 11}
            className="pf-chart__xlabel"
            textAnchor={i === 0 ? 'start' : i === xTicks.length - 1 ? 'end' : 'middle'}
          >
            {fmtX(t)}
          </text>
        ))}

        {h !== null && (
          <g>
            <line x1={x(ts[h]!)} y1={PAD_T} x2={x(ts[h]!)} y2={PLOT_H} className="pf-chart__cursor" />
            <circle cx={x(ts[h]!)} cy={y(ls[h]!)} r="2.5" className="copy-chart__dot copy-chart__dot--leader" />
            <circle cx={x(ts[h]!)} cy={y(ys[h]!)} r="2.5" className="copy-chart__dot copy-chart__dot--you" />
          </g>
        )}
      </svg>

      {h !== null && (
        <div className="pf-chart__tip copy-chart__tip" style={{ left: `${Math.min(PLOT_W - 70, Math.max(70, x(ts[h]!)))}px` }}>
          <span className="pf-chart__tipday">{fmtTip(ts[h]!)}</span>
          <span className="copy-chart__tiprow">
            <i className="copy-swatch copy-swatch--you" aria-hidden="true" />
            <span className="pf-chart__tipval">{money(ys[h]!)}</span>
          </span>
          <span className="copy-chart__tiprow">
            <i className="copy-swatch copy-swatch--leader" aria-hidden="true" />
            <span className="pf-chart__tipval">{money(ls[h]!)}</span>
          </span>
        </div>
      )}
    </div>
  );
}
