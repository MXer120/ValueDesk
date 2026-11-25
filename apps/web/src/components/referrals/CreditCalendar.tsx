/**
 * Credits by day, one row per tier (owner's reference 2026-11-25: a grid of rounded cells, hatched while low, solid when
 * high): how good each day was within its row. A cell says its figure on hover, focus or tap.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { InviteMe } from '@sign/invites/claim';
import { IconButton } from '../bots/kit/kit';
import { ROWS, calendarDays, knownDays, type RowKey } from './calendar';
import { credit, day } from './parts';

const LEGEND = ['Low', 'Medium', 'High', 'Best'] as const;
const LABEL: Record<RowKey, string> = { All: 'All', T1: 'T1', T2: 'T2', T3: 'T3', Spent: 'Spent' };

export function CreditCalendar({ me }: { me: InviteMe | null }) {
  const ref = useRef<HTMLDivElement>(null);
  const [cols, setCols] = useState(12);
  const [offset, setOffset] = useState(0);
  const [on, setOn] = useState<{ r: RowKey; i: number } | null>(null);
  // As many days as keep a cell near 34 px.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => setCols(Math.min(21, Math.max(7, Math.floor((el.clientWidth - 48) / 38))));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const history = useMemo(() => me?.history ?? [], [me]);
  const [now] = useState(() => Date.now());
  const days = useMemo(() => calendarDays(history, now, cols, offset), [history, now, cols, offset]);
  const known = knownDays(history, now);
  useEffect(() => setOn(null), [offset, cols, me]);
  const cur = on ? days[on.i] ?? null : null;
  const cell = cur && on ? cur.cells[on.r] : null;
  return (
    <div className="rf-cal" ref={ref} onPointerLeave={() => setOn(null)}>
      <div className="rf-cal__top">
        <ul aria-hidden="true">{LEGEND.map((l, i) => <li key={l}><i className={`rf-cell is-${i + 1}`} />{l}</li>)}</ul>
        <div>
          <IconButton icon="arrowLeft" label="Earlier days" disabled={offset + cols >= known} onClick={() => setOffset(offset + cols)} />
          <IconButton icon="arrowRight" label="Later days" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - cols))} />
        </div>
      </div>
      <table style={{ '--n': cols } as React.CSSProperties}>
        <caption className="tf-sr">Credits by day and tier</caption>
        <tbody>
          {ROWS.map((r) => (
            <tr key={r} className={r === 'Spent' ? 'is-spent' : undefined}>
              <th scope="row">{LABEL[r]}</th>
              {days.map((d, i) => {
                const c = d.cells[r];
                return (
                  <td key={d.at}>
                    <button
                      type="button" tabIndex={c.level ? 0 : -1} className={`rf-cell is-${c.level}${c.out ? ' is-out' : ''}${on?.r === r && on.i === i ? ' is-on' : ''}`}
                      aria-label={`${LABEL[r]}, ${day(d.at)}: ${credit(c.usd)}`}
                      onPointerEnter={() => setOn({ r, i })} onFocus={() => setOn({ r, i })} onBlur={() => setOn(null)} onClick={() => setOn({ r, i })}
                    />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
        <tfoot><tr><td />{days.map((d, i) => <td key={d.at} className={on?.i === i ? 'is-on' : undefined}>{d.date.getDate()}</td>)}</tr></tfoot>
      </table>
      <p className="rf-cal__say" aria-live="polite">
        {cur && cell && on ? (
          <><span>{day(cur.at)}</span><span>{on.r === 'All' ? 'All tiers' : on.r === 'Spent' ? 'Spent on fees' : `Tier ${on.r.slice(1)}`}</span><b className={cell.usd > 0 && on.r !== 'Spent' ? 'pos' : undefined}>{cell.out ? 'No record' : `${cell.usd > 0 ? (on.r === 'Spent' ? '−' : '+') : ''}${credit(cell.usd)}`}</b></>
        ) : <span>{days.length ? `${day(days[0]!.at)} to ${offset === 0 ? 'today' : day(days[days.length - 1]!.at)}` : ''}</span>}
      </p>
    </div>
  );
}
