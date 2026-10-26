/**
 * What an algo will do, drawn before it runs - from the engine's own plan
 * (planAlgo: the same functions and seed the runtime uses), so what is drawn
 * is what goes out: the moving picture (AlgoStory), the facts (size, value,
 * children, start and end, average price, fees) and a table of every child.
 */
import type { AlgoPlan, AlgoSpec, PlannedChild } from '@copy-engine';
import { fmtTime, fmtUsd } from '../../format';
import { fmtDuration } from './menu';
import { AlgoStory, fmtP, fmtQ, type Level } from './AlgoStory';

export type { Level } from './AlgoStory';
export { fmtP } from './AlgoStory';

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
  /** Draws another random schedule (kinds with jitter). */
  onShuffle?: () => void;
  uiKind?: string;
  history?: Array<{ t: number; p: number }> | null;
  book?: { bid: number; ask: number } | null;
  profile?: number[] | null;
  dayVolume?: { from: number; v: number[] } | null;
  refs?: { mid: number | null; mark: number | null; index: number | null; oracleMid: number | null; oracleFair: number | null } | null;
  bandDepth?: number | null;
  sizeUnit?: 'coin' | 'usd';
  tickSize?: number;
  farBook?: Array<[number, number]> | null;
  tz?: 'local' | 'utc';
}

const pctFrom = (p: number, ref: number | null): string => {
  if (!ref) return '';
  const d = (p / ref - 1) * 100;
  if (Math.abs(d) < 0.005) return '';
  return `${d > 0 ? '+' : '−'}${Math.abs(d).toFixed(Math.abs(d) < 1 ? 2 : 1)}%`;
};

/** Offset from the start in short words: "+4m 30s". */
const rel = (ms: number): string => (ms <= 500 ? '0' : `+${fmtDuration(ms)}`);

/** The children the table shows: the schedule where there is one, else the children. */
const rowsOf = (plan: AlgoPlan): PlannedChild[] => (plan.schedule?.length ? plan.schedule : plan.children).filter((c) => c.qty > 0 || c.price !== null);

/* ------------------------------------------------------------ the whole ----- */

export function PlanPreview(p: PreviewProps) {
  const { plan, spec } = p;
  if (!plan) return <p className="oe-hint">{p.why ?? 'Waiting for the market…'}</p>;
  // Orders that wait on the book at their price (a ladder, an iceberg's clips); an IOC or a market order goes at once.
  const resting = spec?.kind === 'scale' || spec?.kind === 'iceberg' || spec?.kind === 'chase';
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
  let cum = 0;
  // Sizes in the order panel's unit (a basket's rows are already in USD).
  const usdSize = p.sizeUnit === 'usd' && spec?.kind !== 'basket';
  // The table's total is the sum of its rows (each at its own price), so the column adds up.
  const usdSum = rows.reduce((a, c) => a + (c.usd !== undefined ? c.usd : (c.price ?? p.mid ?? 0) * c.qty), 0);
  const sum = timed.reduce((a, c) => a + c.qty, 0);
  return (
    <div className={`algo-pvw is-${p.side}`}>
      <p className="algo-pvw__words">{p.words}</p>
      <AlgoStory plan={plan} spec={spec} side={p.side} mid={p.mid} levels={p.levels} base={p.base} sweepRef={p.sweepRef} onShuffle={p.onShuffle} uiKind={p.uiKind} history={p.history} book={p.book} profile={p.profile} dayVolume={p.dayVolume} refs={p.refs} bandDepth={p.bandDepth} sizeUnit={p.sizeUnit} tickSize={p.tickSize} farBook={p.farBook} tz={p.tz} />
      <dl className="algo-pvw__facts">
        {facts.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {rows.length > 0 && (
        <>
        <div className="algo-pvw__tabhead stg__label"><span>Every order</span><span>{rows.length} {rows.length === 1 ? 'order' : 'orders'}</span></div>
        <div className="algo-pvw__tablewrap">
          <table className="algo-pvw__table">
            <thead>
              <tr>
                <th>#</th>
                <th>Order</th>
                <th>When</th>
                <th>Price</th>
                <th>Size ({usdSize ? 'USD' : p.base || 'base'})</th>
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
                    <td>{c.at === null ? (resting ? 'rests' : 'at once') : c.at <= Date.now() + 2_000 ? 'now' : `${fmtTime(c.at)} (${rel(c.at - plan.startsAt)})`}</td>
                    <td>{c.price !== null ? <>{fmtP(c.price)}{p.mid && pctFrom(c.price, p.mid) ? <small>{pctFrom(c.price, p.mid)}</small> : null}</> : spec?.kind === 'sweep' ? 'band edge' : 'best price then'}</td>
                    <td className="is-size">{usdSize ? fmtUsd(c.qty * (c.price ?? p.mid ?? 0), 2) : fmtQ(c.qty)}</td>
                    <td>{c.usd !== undefined ? fmtUsd(c.usd, 2) : px ? fmtUsd(c.qty * px, 2) : '—'}</td>
                    <td>{sum > 0 ? <span className="algo-pvw__done"><i><b style={{ width: `${Math.round((cum / sum) * 100)}%` }} /></i>{Math.round((cum / sum) * 100)}%</span> : ''}</td>
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
                  <td>{usdSize ? fmtUsd(usdSum, 2) : fmtQ(sum)}</td>
                  <td>{usdSum > 0 ? fmtUsd(usdSum, 2) : notional ? fmtUsd(notional, 2) : ''}</td>
                  <td />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
        </>
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
