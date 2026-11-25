/**
 * A grid of days or weeks, one row per kind (owner's reference 2026-11-25: rounded cells, hatched while low, solid when
 * high): how good each was within its row. A cell says its figure on hover, focus or tap.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { IconButton } from '../bots/kit/kit';
import type { Grid } from './calendar';
import { credit, whole } from './parts';

const LEGEND = ['Low', 'Medium', 'High', 'Best'] as const;

export function HeatGrid({ grid, caption, step }: { grid: (cols: number, offset: number) => Grid; caption: string; step: 'day' | 'week' }) {
  const ref = useRef<HTMLDivElement>(null);
  const [cols, setCols] = useState(11);
  const [offset, setOffset] = useState(0);
  const [on, setOn] = useState<{ r: number; c: number } | null>(null);
  // As many columns as keep a cell near 34 px.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => setCols(Math.min(21, Math.max(6, Math.floor((el.clientWidth - 54) / 39))));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const g = grid(cols, offset);
  useEffect(() => setOn(null), [offset, cols, caption]);
  const row = on ? g.rows[on.r] : undefined;
  const col = on ? g.cols[on.c] : undefined;
  const cell = on ? row?.cells[on.c] : undefined;
  const text = (v: number) => (g.unit === 'points' ? whole(v) : credit(v));
  return (
    <div className="rf-cal" ref={ref} onPointerLeave={() => setOn(null)}>
      <div className="rf-cal__top">
        <ul aria-hidden="true">{LEGEND.map((l, i) => <li key={l}><i className={`rf-cell is-${i + 1}`} />{l}</li>)}</ul>
        <div>
          <IconButton icon="arrowLeft" label={`Earlier ${step}s`} disabled={!g.more} onClick={() => setOffset(offset + cols)} />
          <IconButton icon="arrowRight" label={`Later ${step}s`} disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - cols))} />
        </div>
      </div>
      <table>
        <caption className="tf-sr">{caption}</caption>
        <tbody>
          {g.rows.map((r, ri) => (
            <tr key={r.key} className={`is-${r.tone}`}>
              <th scope="row">{r.label}</th>
              {r.cells.map((c, ci) => (
                <td key={g.cols[ci]!.key}>
                  <button
                    type="button" tabIndex={c.level ? 0 : -1} className={`rf-cell is-${c.level}${on?.r === ri && on.c === ci ? ' is-on' : ''}`}
                    aria-label={`${r.name}, ${g.cols[ci]!.title}: ${text(c.v)}`}
                    onPointerEnter={() => setOn({ r: ri, c: ci })} onFocus={() => setOn({ r: ri, c: ci })} onBlur={() => setOn(null)} onClick={() => setOn({ r: ri, c: ci })}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        <tfoot><tr><td />{g.cols.map((c, i) => <td key={c.key} className={on?.c === i ? 'is-on' : undefined}>{c.label}</td>)}</tr></tfoot>
      </table>
      <p className="rf-cal__say" aria-live="polite">
        {row && col && cell ? <><span>{col.title}</span><span>{row.name}</span><b className={cell.v > 0 && row.tone !== 'spent' ? `is-${row.tone}` : undefined}>{cell.v > 0 ? (row.tone === 'spent' ? '−' : '+') : ''}{text(cell.v)}</b></>
          : g.cols.length ? <span>{g.cols[0]!.title} to {offset === 0 && step === 'day' ? 'today' : g.cols[g.cols.length - 1]!.title}</span> : null}
      </p>
    </div>
  );
}
