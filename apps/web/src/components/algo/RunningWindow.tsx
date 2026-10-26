/**
 * A running (or finished) algo order in its own window, in the Settings shell:
 *
 *   Live     the market's real price since it started (1-minute closes, read
 *            again every 30 s), solid; what it did on it - every fill a dot,
 *            sized by its share, every resting child a line from when it was
 *            placed - and the levels it acts at (its start price, a trailing
 *            stop, a conditional's prices, its exits, its arrival and average);
 *            then, on the darker ground right of "now", what is still to come:
 *            the children its plan still has due (the engine's own plan, from
 *            the same seed and start), and for a level it waits on a dashed
 *            line from the price now to that level with the move it needs.
 *   Orders   every child it sent, its price, size, fill and state
 *   Log      every event, as the card's log
 */
import { useMemo, useState, type ReactNode } from 'react';
import { FINAL_STATUSES, planAlgo, type AlgoView, type PlannedChild } from '@copy-engine';
import { DASH, fmtTime, fmtUsd } from '../../format';
import { useSymbols } from '../../hooks';
import { Modal } from '../Modal';
import { AlgoIcon } from './AlgoIcon';
import { fmtP, fmtQ } from './AlgoStory';
import { marketOf } from './AlgoTicket';
import { useHistory } from './liveData';
import { fmtDuration, menuName, type UiKind } from './menu';

const W = 560;
const H = 250;
const PL = 62;
const PR = 108;
const PT = 16;
const PB = 24;
const IW = W - PL - PR;
const IH = H - PT - PB;
const X1 = PL + IW;
const Y1 = PT + IH;

type Sec = 'live' | 'orders' | 'log';
const SECS: Record<Sec, { label: string; lede: string; icon: ReactNode }> = {
  live: { label: 'Live', lede: 'The real price since it started, what it did on it, and what it still waits for.', icon: <path d="M3 14l4-5 3 3 5-7" /> },
  orders: { label: 'Orders', lede: 'Every order it sent to SoDEX (or, practising, would have sent), as it stands.', icon: <path d="M4 5h12M4 10h12M4 15h8" /> },
  log: { label: 'Log', lede: 'Every order, fill, hold and change, newest first.', icon: <><circle cx="10" cy="10" r="6.5" /><path d="M10 6.5V10l2.5 1.5" /></> },
};

const SecIcon = ({ children, size = 18 }: { children: ReactNode; size?: number }) => (
  <svg viewBox="0 0 20 20" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
);

function niceTicks(lo: number, hi: number, n = 4): number[] {
  if (!(hi > lo)) return [lo];
  const raw = (hi - lo) / n;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((x) => x * mag).find((x) => x >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Number(v.toPrecision(12)));
  return out;
}

interface Rule { price: number; label: string; tone: string; dashed?: boolean }

function spread(rules: Rule[], y: (p: number) => number): Array<Rule & { y: number; ty: number }> {
  const s = rules.map((r) => ({ ...r, y: y(r.price) })).sort((a, b) => a.y - b.y);
  let last = -1e9;
  return s.map((r) => {
    const ty = Math.min(Math.max(r.y, last + 18), Y1 + 6);
    last = ty;
    return { ...r, ty };
  });
}

/** The levels a running order acts at, from its spec and what the engine reports. */
function levelsOf(v: AlgoView): Rule[] {
  const a = v.algo;
  const s = a.spec;
  const out: Rule[] = [];
  if (s.triggerPrice !== null && !a.startedAt) out.push({ price: s.triggerPrice, label: 'Starts at', tone: 'warn', dashed: true });
  if (s.limitPrice !== null) out.push({ price: s.limitPrice, label: 'Limit', tone: 'warn', dashed: true });
  if (v.triggerPrice !== null) out.push({ price: v.triggerPrice, label: s.kind === 'trailing' ? 'Stop' : 'Trigger', tone: 'warn', dashed: true });
  if (s.kind === 'conditional') {
    for (const c of s.conditions) if ((c.type === 'price' || c.type === 'cross') && c.symbol === s.symbol) out.push({ price: c.value, label: c.type === 'cross' ? `Crosses ${c.dir}` : c.op === 'above' ? 'When ≥' : 'When ≤', tone: 'warn', dashed: true });
  }
  for (const x of v.exits ?? []) out.push({ price: x.price, label: x.kind === 'tp' ? 'TP' : 'SL', tone: x.kind === 'tp' ? 'pos' : 'neg', dashed: !x.live });
  if (a.arrival) out.push({ price: a.arrival, label: 'Arrival', tone: 'now', dashed: true });
  if (v.avgPrice) out.push({ price: v.avgPrice, label: 'Avg fill', tone: 'dir' });
  return out.filter((r) => Number.isFinite(r.price) && r.price > 0);
}

function LiveChart({ v, open }: { v: AlgoView; open: boolean }) {
  const a = v.algo;
  const s = a.spec;
  const live = !FINAL_STATUSES.has(a.status);
  const start = a.startedAt ?? a.createdAt;
  const now = live ? Date.now() : a.endedAt ?? a.updatedAt;
  const hist = useHistory(s.symbol, open, 90, start - 10 * 60_000);
  const { byName } = useSymbols('perps');
  const sym = byName.get(s.symbol);
  // What it still has due: the engine's own plan from its start, seed and arrival.
  const due: PlannedChild[] = useMemo(() => {
    if (!live || !sym || !a.startedAt) return [];
    try {
      const plan = planAlgo(s, marketOf(sym), { now: a.startedAt, price: a.arrival, seed: a.seed });
      return (plan.schedule?.length ? plan.schedule : plan.children).filter((c) => c.at !== null && c.at > Date.now() && c.qty > 0);
    } catch {
      return [];
    }
  }, [live, sym, s, a.startedAt, a.arrival, a.seed]);
  const pts = (hist ?? []).filter((h) => h.t >= start - 10 * 60_000);
  if (!pts.length) return <p className="oe-hint">{hist ? 'No price history for this market yet.' : 'Reading the price since it started…'}</p>;
  const last = pts[pts.length - 1]!.p;
  const rules = levelsOf(v);
  const waits = live ? rules.filter((r) => r.tone === 'warn') : [];
  const kids = a.children;
  const end = Math.max(now + 60_000, v.endsAt && v.endsAt > now && v.endsAt - now < 3 * 86_400_000 ? v.endsAt : 0, due.length ? due[due.length - 1]!.at! : 0, waits.length ? now + Math.max(5 * 60_000, (now - pts[0]!.t) * 0.5) : 0);
  const t0 = pts[0]!.t;
  const x = (t: number) => PL + ((t - t0) / (end - t0 || 1)) * IW;
  const prices = [...pts.map((p) => p.p), ...rules.map((r) => r.price), ...kids.map((c) => c.price).filter((p) => p > 0)];
  let lo = Math.min(...prices);
  let hi = Math.max(...prices);
  if (!(hi > lo)) { hi *= 1.001; lo *= 0.999; }
  const pad = (hi - lo) * 0.1;
  lo -= pad;
  hi += pad;
  const y = (p: number) => PT + ((hi - p) / (hi - lo)) * IH;
  const ticks = niceTicks(lo, hi, 4);
  const xn = x(now);
  const tone = s.side === 'buy' ? 'pos' : 'neg';
  const maxQ = Math.max(...kids.map((c) => c.filled), 1e-12);
  const totalDue = due.reduce((q, c) => q + c.qty, 0);
  return (
    <figure className={`algo-st is-${s.side}`}>
      <svg className="algo-st__svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${s.symbol} since ${fmtTime(start)}`}>
        {end > now && <rect className="algo-st__future" x={xn} y={PT} width={X1 - xn} height={IH} />}
        {ticks.map((t) => (
          <g key={t}>
            <line className="algo-st__grid" x1={PL} x2={X1} y1={y(t)} y2={y(t)} />
            <text className="algo-st__tick" x={PL - 6} y={y(t) + 3} textAnchor="end">{fmtP(t)}</text>
          </g>
        ))}
        <line className="algo-st__axis" x1={PL} x2={PL} y1={PT} y2={Y1} />
        <line className="algo-st__axis" x1={PL} x2={X1} y1={Y1} y2={Y1} />
        {start > t0 && (
          <g className="algo-st__met">
            <line x1={x(start)} x2={x(start)} y1={PT} y2={Y1} />
            <text x={x(start) + 4} y={PT + 10}>{a.startedAt ? 'started' : 'placed'}</text>
          </g>
        )}
        <path className="algo-st__hist" d={pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.p).toFixed(1)}`).join('')} />
        {kids.map((c) =>
          c.state === 'open' || c.state === 'sending' ? (
            <line key={c.clOrdID} className={`algo-st__resting is-${c.side === 'buy' ? 'pos' : 'neg'}`} x1={x(c.placedAt)} x2={xn} y1={y(c.price)} y2={y(c.price)}>
              <title>{`${c.tag}: resting ${fmtQ(c.quantity - c.filled)} at ${fmtP(c.price)}`}</title>
            </line>
          ) : null,
        )}
        {kids.filter((c) => c.filled > 0).map((c) => (
          <circle key={`f${c.clOrdID}`} className={`algo-st__fill is-${c.side === 'buy' ? 'pos' : 'neg'}`} cx={x(c.updatedAt)} cy={y(c.value / c.filled)} r={2.5 + 4 * Math.sqrt(c.filled / maxQ)}>
            <title>{`${c.tag}: ${fmtQ(c.filled)} at ${fmtP(c.value / c.filled)} (${fmtTime(c.updatedAt)})`}</title>
          </circle>
        ))}
        {due.map((c, i) => (
          <line key={`d${i}`} className={`algo-st__due is-${tone}`} x1={x(c.at!)} x2={x(c.at!)} y1={Y1} y2={Y1 - 6 - 18 * (c.qty / Math.max(...due.map((d) => d.qty)))}>
            <title>{`${c.tag}: ${fmtQ(c.qty)} due ${fmtTime(c.at!)}`}</title>
          </line>
        ))}
        {waits.map((r) => {
          const pctMove = (r.price / last - 1) * 100;
          const xe = Math.min(X1 - 4, xn + (X1 - xn) * 0.7);
          return (
            <g key={`w${r.label}${r.price}`} className="algo-st__need">
              <path d={`M${xn},${y(last)} C${(xn + xe) / 2},${y(last)} ${(xn + xe) / 2},${y(r.price)} ${xe},${y(r.price)}`} />
              <text x={xe - 4} y={y(r.price) + (r.price > last ? -6 : 13)} textAnchor="end">{`needs ${pctMove > 0 ? '+' : '−'}${Math.abs(pctMove).toFixed(Math.abs(pctMove) < 1 ? 2 : 1)}%`}</text>
            </g>
          );
        })}
        <circle className="algo-st__nowdot" cx={xn} cy={y(last)} r={3.4} />
        {live && <line className="algo-st__nowline" x1={xn} x2={xn} y1={PT} y2={Y1} />}
        {spread(rules, y).map((r) => (
          <g key={`${r.label}${r.price}`} className={`algo-st__rule is-${r.tone}${r.dashed ? ' is-dashed' : ''}`}>
            <line x1={PL} x2={X1} y1={r.y} y2={r.y} />
            {Math.abs(r.ty - r.y) > 1 && <line className="algo-st__lead" x1={X1} x2={X1 + 4} y1={r.y} y2={r.ty} />}
            <g transform={`translate(${X1 + 4},${r.ty})`}>
              <rect x={0} y={-8} width={PR - 8} height={16} rx={4} />
              <text x={6} y={3.5}>{`${r.label} ${fmtP(r.price)}`}</text>
            </g>
          </g>
        ))}
        <text className="algo-st__tick" x={PL} y={H - 8}>{fmtTime(t0)}</text>
        <text className="algo-st__tick is-now" x={xn} y={H - 8} textAnchor="middle">{live ? 'Now' : 'Ended'}</text>
        {end > now + 30_000 && <text className="algo-st__tick" x={X1} y={H - 8} textAnchor="end">{fmtTime(end)}</text>}
      </svg>
      <ol className="algo-st__steps">
        <li className="is-on"><span className="algo-st__n" />{a.filled > 0 ? `${fmtQ(a.filled)} ${a.spec.symbol.replace(/-USD$/, '')} filled at ${fmtP(v.avgPrice ?? 0)} in ${kids.filter((c) => c.filled > 0).length} fills` : 'Nothing filled yet'}</li>
        {due.length > 0 && <li><span className="algo-st__n" />{`${due.length} more due by ${fmtTime(due[due.length - 1]!.at!)} (${fmtQ(totalDue)}), the next ${fmtDuration(Math.max(0, due[0]!.at! - Date.now()))} from now`}</li>}
        {waits.map((r) => <li key={r.label}><span className="algo-st__n" />{`Waits for ${r.label.toLowerCase()} ${fmtP(r.price)}: the price is ${fmtP(last)}`}</li>)}
      </ol>
      <figcaption className="algo-st__note">Solid: the real price, its fills (dots) and resting orders (lines). Right of now: what its plan still has due, and the move a level it waits for needs.</figcaption>
    </figure>
  );
}

function Orders({ v }: { v: AlgoView }) {
  const kids = [...v.algo.children].sort((a, b) => b.placedAt - a.placedAt);
  if (!kids.length) return <p className="oe-hint">No order sent yet.</p>;
  return (
    <div className="algo-pvw">
      <div className="algo-pvw__tablewrap">
        <table className="algo-pvw__table is-orders">
          <thead>
            <tr><th>Time</th><th>Order</th><th>Price</th><th>Size</th><th>Filled</th><th>Avg</th><th>State</th></tr>
          </thead>
          <tbody>
            {kids.map((c) => (
              <tr key={c.clOrdID}>
                <td>{fmtTime(c.placedAt)}</td>
                <td>{c.tag} · {c.side} {c.tif.toUpperCase()}</td>
                <td>{fmtP(c.price)}</td>
                <td className="is-size">{fmtQ(c.quantity)}</td>
                <td>{c.filled > 0 ? fmtQ(c.filled) : DASH}</td>
                <td>{c.filled > 0 ? fmtP(c.value / c.filled) : DASH}</td>
                <td>{c.state === 'done' ? (c.filled >= c.quantity - 1e-12 ? 'filled' : c.filled > 0 ? 'part filled' : 'cancelled') : c.state}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr><td /><td>Total</td><td /><td>{fmtQ(kids.reduce((q, c) => q + c.quantity, 0))}</td><td>{fmtQ(v.algo.filled)}</td><td>{v.avgPrice ? fmtP(v.avgPrice) : DASH}</td><td>{v.algo.filledValue > 0 ? fmtUsd(v.algo.filledValue, 2) : ''}</td></tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

export function RunningWindow({ v, kind, open, onClose, facts, log, actions }: {
  v: AlgoView; kind: UiKind; open: boolean; onClose: () => void;
  /** The card's facts and its log, as they are there. */
  facts: ReactNode; log: ReactNode;
  actions: ReactNode;
}) {
  const [sec, setSec] = useState<Sec>('live');
  const a = v.algo;
  const s = a.spec;
  const name = `${menuName(kind)} ${s.kind === 'basket' ? '' : `${s.side === 'buy' ? 'buy' : 'sell'} ${s.symbol}`}`.trim();
  const cur = SECS[sec];
  const pct = Math.round(v.progress * 100);
  return (
    <Modal open={open} onClose={onClose} title={name} size="lg" className={`stg algo-sheet${s.paper ? ' is-paper' : ''}`}>
      <div className="stg__body">
        <nav className="stg__nav" aria-label={`${name} sections`}>
          <div className="stg__brand"><AlgoIcon kind={kind} size={22} /><span>{name}</span></div>
          {s.paper && <span className="algo-practice algo-practice--nav">Practice · no real orders</span>}
          <span className="stg__rule" aria-hidden="true" />
          <div className="stg__tabs">
            {(Object.keys(SECS) as Sec[]).map((id) => (
              <button key={id} type="button" className={`stg__tab${sec === id ? ' is-on' : ''}`} aria-current={sec === id ? 'page' : undefined} onClick={() => setSec(id)}>
                <SecIcon size={17}>{SECS[id].icon}</SecIcon>
                <span>{SECS[id].label}</span>
              </button>
            ))}
          </div>
        </nav>
        <div className="stg__pane" key={sec}>
          <div className="stg__panehead"><SecIcon size={22}>{cur.icon}</SecIcon><h3>{cur.label}</h3></div>
          <p className="stg__lede">{cur.lede}</p>
          {sec === 'live' && (
            <>
              <div className="algo-st__top">
                <span className="algo-st__status">{`${pct}% · ${a.statusReason ?? v.working ?? a.status}`}</span>
                <span className="algo-st__ctl">{actions}</span>
              </div>
              <div className="algo-st__meter" aria-hidden="true"><span style={{ width: `${pct}%` }} /></div>
              <LiveChart v={v} open={open} />
              {facts}
            </>
          )}
          {sec === 'orders' && <Orders v={v} />}
          {sec === 'log' && log}
        </div>
      </div>
    </Modal>
  );
}
