/**
 * What an algo will do, drawn before it runs - from the engine's own plan
 * (planAlgo: the same functions and seed the runtime uses), so what is drawn
 * is what goes out. Every kind gets a chart with labelled axes, the facts
 * (size, value, children, start and end, average price, fees) and a table of
 * every child it plans:
 *
 *   time    child orders over time (TWAP, Chase TWAP, VWAP, swarm, basket,
 *           POV's pace at the last hour's volume): a bar per child, its height
 *           the size, the cumulative share as a line (right axis);
 *   ladder  resting levels by price (scale, DCA, iceberg at a price): a bar
 *           per level, its length the size, against the price now, the
 *           average fill and the exits;
 *   band    the prices it acts at (chase, trailing stop, Fill fast,
 *           conditional, bracket, a pegged iceberg): a labelled rule per
 *           price on a price axis, the band it works in shaded.
 *
 * SVG on a fixed viewBox that scales as a whole, so its text scales with it.
 */
import type { AlgoPlan, AlgoSpec, PlannedChild } from '@copy-engine';
import { fmtTime, fmtUsd } from '../../format';
import { fmtDuration } from './menu';

export interface Level {
  label: string;
  price: number;
  tone: 'now' | 'pos' | 'neg' | 'warn' | 'muted';
}

export interface PreviewProps {
  plan: AlgoPlan | null;
  spec: AlgoSpec | null;
  side: 'buy' | 'sell';
  /** The SoDEX mid now. */
  mid: number | null;
  /** Prices it acts at (addLevels in AlgoTicket, the exits), "Now" included. */
  levels: Level[];
  base: string;
  /** Fee rates (SoDEX plus the ValueDesk fee), and the ValueDesk fee in words. */
  rates: { maker: number; taker: number };
  feeNote: string | null;
  /** The plan in words. */
  words: string;
  /** Why nothing can be planned yet. */
  why: string | null;
  /** Fill fast: the reference it is priced from, live. */
  sweepRef?: { price: number | null; name: string; used: string[]; stale: string[] } | null;
}

const W = 560;
const H = 210;
const PL = 64;
const PR = 78;
const PT = 12;
const PB = 30;
const IW = W - PL - PR;
const IH = H - PT - PB;

export function fmtP(p: number): string {
  const a = Math.abs(p);
  const dp = a >= 1000 ? 1 : a >= 100 ? 2 : a >= 1 ? 4 : a >= 0.01 ? 5 : 8;
  return p.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: dp });
}

const fmtQ = (q: number): string => {
  if (!(q > 0)) return '0';
  const dp = q >= 1000 ? 0 : q >= 1 ? 4 : q >= 0.01 ? 5 : 8;
  return q.toLocaleString('en-US', { maximumFractionDigits: dp });
};

const pctFrom = (p: number, ref: number | null): string => {
  if (!ref) return '';
  const d = (p / ref - 1) * 100;
  if (Math.abs(d) < 0.005) return '';
  return `${d > 0 ? '+' : '−'}${Math.abs(d).toFixed(Math.abs(d) < 1 ? 2 : 1)}%`;
};

/** Offset from the start in short words: "+4m 30s". */
const rel = (ms: number): string => (ms <= 500 ? '0' : `+${fmtDuration(ms)}`);

function niceTicks(lo: number, hi: number, n = 4): number[] {
  if (!(hi > lo)) return [lo];
  const raw = (hi - lo) / n;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((x) => x * mag).find((x) => x >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Number(v.toPrecision(12)));
  return out;
}

type Kind = 'time' | 'ladder' | 'band';

function chartKind(spec: AlgoSpec | null, plan: AlgoPlan): Kind {
  if (!spec) return 'band';
  switch (spec.kind) {
    case 'twap':
    case 'vwap':
    case 'swarm':
    case 'dca':
      return 'time';
    case 'basket':
    case 'pov':
      return plan.schedule?.length ? 'time' : 'band';
    case 'scale':
      return 'ladder';
    case 'iceberg':
      return spec.price !== null ? 'ladder' : 'band';
    default:
      return 'band';
  }
}

/** The children a chart and the table show: the schedule where there is one, else the children. */
const rowsOf = (plan: AlgoPlan): PlannedChild[] => (plan.schedule?.length ? plan.schedule : plan.children).filter((c) => c.qty > 0 || c.price !== null);

/* ---------------------------------------------------------------- time ----- */

function TimeChart({ plan, side, base }: { plan: AlgoPlan; side: 'buy' | 'sell'; base: string }) {
  const kids = rowsOf(plan).filter((c) => c.at !== null && c.qty > 0);
  if (!kids.length) return <p className="oe-hint">Nothing is scheduled yet.</p>;
  const t0 = plan.startsAt;
  const last = Math.max(...kids.map((c) => c.at!));
  const t1 = Math.max(plan.endsAt ?? last, last, t0 + 1_000);
  const span = t1 - t0;
  const total = kids.reduce((a, c) => a + c.qty, 0);
  const x = (t: number) => PL + ((t - t0) / span) * IW;
  const bw = Math.max(1.2, Math.min(16, (IW / Math.max(kids.length, 1)) * 0.6));
  // Children due at the same moment (a swarm's wave, a basket's markets) stack.
  const stacked = new Map<number, number>();
  const bars = kids.map((c) => {
    const under = stacked.get(c.at!) ?? 0;
    stacked.set(c.at!, under + c.qty);
    return { c, under };
  });
  const tallest = Math.max(...[...stacked.values()]);
  const yS = (q: number) => PT + IH - (q / tallest) * IH * 0.9;
  let cum = 0;
  const pts: string[] = [`${PL},${PT + IH}`];
  for (const c of [...kids].sort((a, b) => a.at! - b.at!)) {
    const xx = x(c.at!) + bw / 2;
    pts.push(`${xx.toFixed(1)},${(PT + IH - (cum / total) * IH).toFixed(1)}`);
    cum += c.qty;
    pts.push(`${xx.toFixed(1)},${(PT + IH - (cum / total) * IH).toFixed(1)}`);
  }
  pts.push(`${PL + IW},${PT}`);
  const yTicks = niceTicks(0, tallest, 3);
  const tTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => t0 + f * span);
  return (
    <svg className={`algo-ch is-${side}`} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${kids.length} child orders from ${fmtTime(t0)} to ${fmtTime(t1)}`}>
      {yTicks.map((v) => (
        <g key={`y${v}`}>
          <line className="algo-ch__grid" x1={PL} x2={PL + IW} y1={yS(v)} y2={yS(v)} />
          <text className="algo-ch__tick" x={PL - 6} y={yS(v) + 3} textAnchor="end">{fmtQ(v)}</text>
        </g>
      ))}
      {[0, 0.5, 1].map((f) => (
        <text key={`c${f}`} className="algo-ch__tick algo-ch__tick--cum" x={PL + IW + 6} y={PT + IH - f * IH + 3}>{Math.round(f * 100)}%</text>
      ))}
      {bars.map(({ c, under }, i) => (
        <rect key={i} className={`algo-ch__bar${c.tag.startsWith('sell') ? ' is-sell' : c.tag.startsWith('buy') ? ' is-buy' : ''}`} x={x(c.at!)} y={yS(under + c.qty)} width={bw} height={Math.max(0.8, yS(under) - yS(under + c.qty))}>
          <title>{`${c.tag}: ${fmtQ(c.qty)} ${base} at ${fmtTime(c.at!)}`}</title>
        </rect>
      ))}
      <polyline className="algo-ch__cum" points={pts.join(' ')} />
      <line className="algo-ch__axis" x1={PL} x2={PL + IW} y1={PT + IH} y2={PT + IH} />
      {tTicks.map((t, i) => (
        <text key={`t${i}`} className="algo-ch__tick" x={x(t)} y={H - 12} textAnchor={i === 0 ? 'start' : i === tTicks.length - 1 ? 'end' : 'middle'}>
          {i === 0 ? (t0 <= Date.now() + 2_000 ? 'Now' : fmtTime(t0)) : i === tTicks.length - 1 ? fmtTime(t) : rel(t - t0)}
        </text>
      ))}
      <text className="algo-ch__label" x={PL - 6} y={H - 1} textAnchor="end">{base || 'size'}</text>
      <text className="algo-ch__label" x={PL + IW / 2} y={H - 1} textAnchor="middle">time{plan.estimated ? ' (estimated at the last hour’s volume)' : ''}</text>
      <text className="algo-ch__label" x={PL + IW + 6} y={H - 1}>filled</text>
    </svg>
  );
}

/* -------------------------------------------------------------- ladder ----- */

function LadderChart({ plan, side, mid, levels, base }: { plan: AlgoPlan; side: 'buy' | 'sell'; mid: number | null; levels: Level[]; base: string }) {
  const lv = plan.children.filter((c) => c.price !== null && c.qty > 0);
  if (!lv.length) return <p className="oe-hint">No levels yet.</p>;
  const marks = levels.filter((l) => l.price > 0);
  const all = [...lv.map((c) => c.price!), ...marks.map((m) => m.price), ...(plan.avgPrice ? [plan.avgPrice] : [])];
  let lo = Math.min(...all);
  let hi = Math.max(...all);
  if (hi === lo) {
    hi *= 1.001;
    lo *= 0.999;
  }
  const pad = (hi - lo) * 0.06;
  lo -= pad;
  hi += pad;
  const y = (p: number) => PT + ((hi - p) / (hi - lo)) * IH;
  const maxQ = Math.max(...lv.map((c) => c.qty));
  const bh = Math.max(1.5, Math.min(10, (IH / lv.length) * 0.6));
  const every = Math.max(1, Math.ceil(lv.length / 12));
  const xTicks = niceTicks(0, maxQ, 3);
  const xq = (q: number) => PL + (q / maxQ) * IW * 0.92;
  return (
    <svg className={`algo-ch is-${side}`} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${lv.length} resting levels from ${fmtP(lv[0]!.price!)} to ${fmtP(lv[lv.length - 1]!.price!)}`}>
      {xTicks.map((v) => (
        <g key={`x${v}`}>
          <line className="algo-ch__grid" x1={xq(v)} x2={xq(v)} y1={PT} y2={PT + IH} />
          <text className="algo-ch__tick" x={xq(v)} y={H - 12} textAnchor="middle">{fmtQ(v)}</text>
        </g>
      ))}
      {lv.map((c, i) => (
        <g key={i}>
          <rect className="algo-ch__bar" x={PL} y={y(c.price!) - bh / 2} width={Math.max(2, xq(c.qty) - PL)} height={bh}>
            <title>{`${c.tag}: ${fmtQ(c.qty)} ${base} at ${fmtP(c.price!)}`}</title>
          </rect>
          {(i % every === 0 || i === lv.length - 1) && (
            <text className="algo-ch__tick" x={PL - 6} y={y(c.price!) + 3} textAnchor="end">{fmtP(c.price!)}</text>
          )}
        </g>
      ))}
      {plan.avgPrice && <Rule y={y(plan.avgPrice)} label={`Avg ${fmtP(plan.avgPrice)}`} tone="dir" />}
      {marks.map((m) => (
        <Rule key={`${m.label}${m.price}`} y={y(m.price)} label={`${m.label} ${fmtP(m.price)}${m.tone === 'now' ? '' : ` ${pctFrom(m.price, mid)}`}`} tone={m.tone} />
      ))}
      <line className="algo-ch__axis" x1={PL} x2={PL} y1={PT} y2={PT + IH} />
      <text className="algo-ch__label" x={PL - 6} y={H - 1} textAnchor="end">price</text>
      <text className="algo-ch__label" x={PL + IW / 2} y={H - 1} textAnchor="middle">size per level ({base || 'base'})</text>
    </svg>
  );
}

function Rule({ y, label, tone }: { y: number; label: string; tone: Level['tone'] | 'dir' }) {
  return (
    <g className={`algo-ch__rule is-${tone}`}>
      <line x1={PL} x2={PL + IW} y1={y} y2={y} />
      <text x={PL + IW + 4} y={y + 3}>{label}</text>
    </g>
  );
}

/* ---------------------------------------------------------------- band ----- */

function BandChart({ levels, mid, band }: { levels: Level[]; mid: number | null; band: { from: number; to: number; label: string } | null }) {
  const lv = levels.filter((l) => Number.isFinite(l.price) && l.price > 0);
  if (!lv.length) return <p className="oe-hint">No prices to draw yet.</p>;
  const ps = [...lv.map((l) => l.price), ...(band ? [band.from, band.to] : [])];
  let lo = Math.min(...ps);
  let hi = Math.max(...ps);
  if (hi === lo) {
    hi *= 1.002;
    lo *= 0.998;
  }
  const pad = (hi - lo) * 0.15;
  lo -= pad;
  hi += pad;
  const y = (p: number) => PT + ((hi - p) / (hi - lo)) * IH;
  const ticks = niceTicks(lo, hi, 4);
  // Labels never collide: each at least 13 units below the one above it.
  const sorted = [...lv].sort((a, b) => b.price - a.price);
  let last = -100;
  const placed = sorted.map((l) => {
    const t = Math.max(y(l.price), last + 13);
    last = t;
    return { ...l, at: y(l.price), text: Math.min(t, PT + IH) };
  });
  return (
    <svg className="algo-ch" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="The prices it acts at">
      {ticks.map((v) => (
        <g key={v}>
          <line className="algo-ch__grid" x1={PL} x2={PL + IW} y1={y(v)} y2={y(v)} />
          <text className="algo-ch__tick" x={PL - 6} y={y(v) + 3} textAnchor="end">{fmtP(v)}</text>
        </g>
      ))}
      {band && (
        <g className="algo-ch__band">
          <rect x={PL} y={Math.min(y(band.from), y(band.to))} width={IW} height={Math.max(1, Math.abs(y(band.from) - y(band.to)))} />
          <text x={PL + 6} y={Math.min(y(band.from), y(band.to)) + 12}>{band.label}</text>
        </g>
      )}
      {placed.map((l) => (
        <g key={`${l.label}${l.price}`} className={`algo-ch__rule is-${l.tone}`}>
          <line x1={PL} x2={PL + IW} y1={l.at} y2={l.at} />
          <text x={PL + IW + 4} y={l.text + 3}>
            {l.label} {fmtP(l.price)}
            {l.tone !== 'now' && mid ? ` ${pctFrom(l.price, mid)}` : ''}
          </text>
        </g>
      ))}
      <line className="algo-ch__axis" x1={PL} x2={PL} y1={PT} y2={PT + IH} />
      <text className="algo-ch__label" x={PL - 6} y={H - 1} textAnchor="end">price</text>
    </svg>
  );
}

/* ------------------------------------------------------------ the whole ----- */

/** The band a kind works in, where it has one. */
function bandOf(spec: AlgoSpec | null, levels: Level[], sweepRef: PreviewProps['sweepRef'], plan: AlgoPlan): { from: number; to: number; label: string } | null {
  if (!spec) return null;
  const at = (label: string) => levels.find((l) => l.label === label)?.price ?? null;
  if (spec.kind === 'sweep') {
    const ref = sweepRef?.price ?? null;
    const edge = plan.children[0]?.price ?? null;
    return ref && edge ? { from: ref, to: edge, label: `fills inside ${(spec.slippageBps / 100).toFixed(2)}% of the reference` } : null;
  }
  if (spec.kind === 'chase') {
    const a = at('Rests at');
    const b = at('Chases to');
    return a && b ? { from: a, to: b, label: 'follows the best price within this' } : null;
  }
  if (spec.kind === 'trailing') {
    const a = at('Now');
    const b = at('Stop');
    return a && b ? { from: a, to: b, label: 'the trail: it fires when the price crosses the stop' } : null;
  }
  if (spec.kind === 'bracket' && plan.exits?.tp && plan.exits?.sl) return { from: plan.exits.tp, to: plan.exits.sl, label: 'held between the take-profit and the stop-loss' };
  return null;
}

export function PlanPreview(p: PreviewProps) {
  const { plan, spec } = p;
  if (!plan) return <p className="oe-hint">{p.why ?? 'Waiting for the market…'}</p>;
  const kind = chartKind(spec, plan);
  const rows = rowsOf(plan);
  const timed = rows.filter((c) => c.qty > 0);
  const notional = plan.notional;
  const taker = notional ? notional * p.rates.taker : null;
  const maker = notional ? notional * p.rates.maker : null;
  // A ladder or Fill fast is all one kind of order: resting (maker) or taking (taker).
  const allTake = spec?.kind === 'sweep' || spec?.kind === 'swarm' || (spec?.kind === 'bracket' && spec.entry === 'market');
  const allRest = spec?.kind === 'scale' && spec.postOnly;
  const fee = notional
    ? allTake
      ? `${fmtUsd(taker, 2)} (taking)`
      : allRest
        ? `${fmtUsd(maker, 2)} (resting)`
        : `${fmtUsd(maker, 2)} if all rest, ${fmtUsd(taker, 2)} if all take`
    : null;
  const facts: Array<[string, string]> = [];
  if (plan.total !== null && plan.total > 0) facts.push(['Size', `${fmtQ(plan.total)} ${p.base}`]);
  if (notional) facts.push(['Value', fmtUsd(notional, 2)]);
  if (timed.length > 1) facts.push([plan.estimated ? 'Children (est.)' : 'Child orders', String(timed.length)]);
  if (plan.avgChildQty && timed.length > 1 && !plan.schedule) facts.push(['Each, on average', `${fmtQ(plan.avgChildQty)} ${p.base}`]);
  if (plan.avgPrice) facts.push(['Average if all fill', fmtP(plan.avgPrice)]);
  facts.push(['Starts', plan.startsAt <= Date.now() + 2_000 ? 'now' : fmtTime(plan.startsAt)]);
  if (plan.endsAt) facts.push(['Ends', `${fmtTime(plan.endsAt)} (${fmtDuration(plan.endsAt - plan.startsAt)})`]);
  if (plan.intervalMs && spec?.kind !== 'sweep') facts.push(['Every', fmtDuration(plan.intervalMs)]);
  if (spec?.kind === 'sweep') {
    facts.push(['Reference', p.sweepRef ? `${p.sweepRef.name}${p.sweepRef.price ? ` ${fmtP(p.sweepRef.price)}` : ' (none fresh)'}` : 'read when it runs']);
    if (p.sweepRef?.used.length) facts.push(['From', p.sweepRef.used.join(', ')]);
    if (p.sweepRef?.stale.length) facts.push(['Stale, left out', p.sweepRef.stale.join(', ')]);
    if (plan.intervalMs) facts.push(['Rounds', `an IOC every ${fmtDuration(plan.intervalMs)} until filled`]);
  }
  if (plan.exits?.tp) facts.push(['Take-profit', fmtP(plan.exits.tp)]);
  if (plan.exits?.sl) facts.push(['Stop-loss', fmtP(plan.exits.sl)]);
  if (fee) facts.push(['Fees, estimated', `${fee}${p.feeNote ? `, incl. ${p.feeNote}` : ''}`]);
  const band = bandOf(spec, p.levels, p.sweepRef, plan);
  let cum = 0;
  const sum = timed.reduce((a, c) => a + c.qty, 0);
  return (
    <div className="algo-pvw">
      <p className="algo-pvw__words">{p.words}</p>
      <figure className={`algo-pvw__chart is-${p.side}`}>
        {kind === 'time' && <TimeChart plan={plan} side={p.side} base={p.base} />}
        {kind === 'ladder' && <LadderChart plan={plan} side={p.side} mid={p.mid} levels={p.levels} base={p.base} />}
        {kind === 'band' && <BandChart levels={p.levels} mid={p.mid} band={band} />}
      </figure>
      <dl className="algo-pvw__facts">
        {facts.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {rows.length > 0 && (
        <div className="algo-pvw__tablewrap">
          <table className="algo-pvw__table">
            <thead>
              <tr>
                <th>#</th>
                <th>Order</th>
                <th>When</th>
                <th>Price</th>
                <th>Size ({p.base || 'base'})</th>
                <th>USD</th>
                <th>Done</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c, i) => {
                cum += c.qty;
                const px = c.price ?? p.mid;
                return (
                  <tr key={i}>
                    <td>{i + 1}</td>
                    <td>{c.tag}</td>
                    <td>{c.at === null ? (kind === 'ladder' ? 'rests' : 'at once') : c.at <= Date.now() + 2_000 ? 'now' : `${fmtTime(c.at)} (${rel(c.at - plan.startsAt)})`}</td>
                    <td>{c.price !== null ? `${fmtP(c.price)}${p.mid ? ` ${pctFrom(c.price, p.mid)}` : ''}` : spec?.kind === 'sweep' ? 'band edge' : 'best price then'}</td>
                    <td>{fmtQ(c.qty)}</td>
                    <td>{c.usd !== undefined ? fmtUsd(c.usd, 2) : px ? fmtUsd(c.qty * px, 2) : '—'}</td>
                    <td>{sum > 0 ? `${Math.round((cum / sum) * 100)}%` : ''}</td>
                  </tr>
                );
              })}
            </tbody>
            {sum > 0 && (
              <tfoot>
                <tr>
                  <td />
                  <td>Total</td>
                  <td />
                  <td>{plan.avgPrice ? `avg ${fmtP(plan.avgPrice)}` : ''}</td>
                  <td>{fmtQ(sum)}</td>
                  <td>{notional ? fmtUsd(notional, 2) : ''}</td>
                  <td />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
      {plan.errors.map((e) => (
        <p key={e} className="oe-hint algo-err">{e}</p>
      ))}
      {plan.warnings.map((w) => (
        <p key={w} className="oe-hint algo-warn">{w}</p>
      ))}
    </div>
  );
}
