/**
 * The time gate (owner 2026-11-08: "quiet hours" read either way, then "too complicated"): one plain choice (skip
 * set hours, or trade only in them), one chart of how much the price moves at each hour of the day in the viewer's
 * own time (the 7-day average as a line over the 7-day range), hours picked by a click or a drag across it, one-tap
 * picks (the busiest hours, the market opens), and a sentence saying what will happen. Exact times stay one fold away.
 * Sessions run on the exchange's trading days, holidays skipped (engine bots.ts tradingDay).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { zoneTime } from '@copy-engine';
import { fetchKlineRows } from '../../chart/klines';
import { QUIET_PRESETS, type BotDraft, type QuietWindow } from '../../bots/presets';
import { quietCover } from '../../bots/estimate';
import { Button, Icon, Segmented, TextInput } from './kit/kit';

const MOST = 6;
const DAYS: Record<QuietWindow['days'], string> = { all: 'every day', weekdays: 'Monday to Friday', trading: 'on trading days' };
/** The viewer's whole-hour offset from UTC (a half-hour zone rounds). */
const localOff = (): number => Math.round(-new Date().getTimezoneOffset() / 60);
const hh = (h: number): string => `${String(((h % 24) + 24) % 24).padStart(2, '0')}:00`;
const same = (a: QuietWindow, b: QuietWindow) => a.from === b.from && a.to === b.to && a.zone === b.zone && a.days === b.days;
/** A window the chart made: UTC, every day, on the hour. */
const isHourly = (w: QuietWindow) => w.zone === 'utc' && w.days === 'all' && w.from.endsWith(':00') && (w.to.endsWith(':00') || w.to === '23:59');
const PICKS = QUIET_PRESETS.filter((p) => ['ny-open', 'ldn-open', 'ny-close', 'asia'].includes(p.id));

/** A window's times in the viewer's clock today ('15:25–15:50'). */
function localWords(w: QuietWindow): string {
  const now = Date.now();
  const utcMin = new Date(now).getUTCHours() * 60 + new Date(now).getUTCMinutes();
  let zoneOffMin = zoneTime(now, w.zone).minutes - utcMin;
  if (zoneOffMin > 720) zoneOffMin -= 1440;
  if (zoneOffMin < -720) zoneOffMin += 1440;
  const shift = -new Date().getTimezoneOffset() - zoneOffMin;
  const conv = (t: string) => {
    const m = (((Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)) + shift) % 1440) + 1440) % 1440;
    return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  };
  return `${conv(w.from)}–${conv(w.to === '23:59' ? '00:00' : w.to)}`;
}

/** The hourly move (high to low, bp of the open) for the last 7 days, by UTC hour: [day][hour], null where missing. */
function useHourlyMoves(symbol: string): { days: Array<Array<number | null>>; avg: Array<number | null> } | null {
  const [rows, setRows] = useState<Array<{ t: number; o: number; h: number; l: number }> | null>(null);
  useEffect(() => {
    let live = true;
    setRows(null);
    const ac = new AbortController();
    fetchKlineRows({ engine: 'perps', symbol, interval: '1h', limit: 168 }, { signal: ac.signal, timeoutMs: 15_000 })
      .then((raw) => {
        if (!live) return;
        setRows(raw.flatMap((r) => {
          const k = r as { t?: unknown; o?: unknown; h?: unknown; l?: unknown };
          const x = { t: Number(k.t), o: Number(k.o), h: Number(k.h), l: Number(k.l) };
          return [x.t, x.o, x.h, x.l].every(Number.isFinite) && x.o > 0 ? [x] : [];
        }));
      })
      .catch(() => live && setRows([]));
    return () => { live = false; ac.abort(); };
  }, [symbol]);
  return useMemo(() => {
    if (!rows || !rows.length) return null;
    const dayOf = (t: number) => Math.floor(t / 86_400_000);
    const last = Math.max(...rows.map((r) => dayOf(r.t)));
    const days = Array.from({ length: 7 }, () => new Array<number | null>(24).fill(null));
    for (const r of rows) {
      const k = last - dayOf(r.t);
      if (k < 0 || k > 6) continue;
      days[6 - k]![new Date(r.t).getUTCHours()] = ((r.h - r.l) / r.o) * 10_000;
    }
    const avg = Array.from({ length: 24 }, (_, h) => {
      const xs = days.map((d) => d[h]).filter((x): x is number => x !== null);
      return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
    });
    return { days, avg };
  }, [rows]);
}

/** The chart: 24 hours in the viewer's time; the hours it does not trade shaded; click or drag to pick hours. */
function MoveChart({ moves, cover, only, pick }: { moves: ReturnType<typeof useHourlyMoves>; cover: number[]; only: boolean; pick: (fromLocal: number, toLocal: number) => void }) {
  const off = localOff();
  const [hover, setHover] = useState<number | null>(null);
  const [drag, setDrag] = useState<{ a: number; b: number } | null>(null);
  const dragRef = useRef(drag);
  dragRef.current = drag;
  const pickRef = useRef(pick);
  pickRef.current = pick;
  useEffect(() => {
    const up = () => {
      const g = dragRef.current;
      if (g) pickRef.current(Math.min(g.a, g.b), Math.max(g.a, g.b));
      dragRef.current = null;
      setDrag(null);
    };
    window.addEventListener('pointerup', up);
    return () => window.removeEventListener('pointerup', up);
  }, []);
  const W = 640, H = 132, P = 6, B = 18;
  const colW = (W - P * 2) / 24;
  const utcOf = (j: number) => (((j - off) % 24) + 24) % 24;
  const all = moves ? moves.days.flat().filter((x): x is number => x !== null) : [];
  const top = all.length ? Math.max(...all) * 1.05 : 1;
  const y = (v: number) => P + (H - B - P) * (1 - v / top);
  const xAt = (j: number) => P + colW * (j + 0.5);
  const at = (j: number) => moves?.avg[utcOf(j)] ?? null;
  const line = Array.from({ length: 24 }, (_, j) => at(j)).map((v, j) => (v === null ? '' : `${j ? 'L' : 'M'}${xAt(j).toFixed(1)},${y(v).toFixed(1)}`)).join('');
  // The 7-day range: the calmest and the roughest day at each hour.
  const vals = (j: number) => moves?.days.map((d) => d[utcOf(j)]).filter((x): x is number => x !== null) ?? [];
  const lo = (j: number) => (vals(j).length ? Math.min(...vals(j)) : 0);
  const hi = (j: number) => (vals(j).length ? Math.max(...vals(j)) : 0);
  const band = moves ? `${Array.from({ length: 24 }, (_, j) => `${j ? 'L' : 'M'}${xAt(j).toFixed(1)},${y(hi(j)).toFixed(1)}`).join('')}${Array.from({ length: 24 }, (_, k) => `L${xAt(23 - k).toFixed(1)},${y(lo(23 - k)).toFixed(1)}`).join('')}Z` : '';
  const inDrag = (j: number) => drag !== null && j >= Math.min(drag.a, drag.b) && j <= Math.max(drag.a, drag.b);
  const v = hover !== null ? at(hover) : null;
  return (
    <div className="bots-hchart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="How much the price moves at each hour, last 7 days" onPointerLeave={() => setHover(null)}>
        {Array.from({ length: 24 }, (_, j) => {
          const c = cover[utcOf(j)] ?? 0;
          const shade = only ? 1 - c : c;
          return (
            <g key={j}>
              {shade > 0.01 && <rect className="bots-hchart__off" x={P + colW * j + 1} y={P} width={colW - 2} height={H - B - P} rx={3} style={{ opacity: 0.2 + 0.45 * Math.min(1, shade) }} />}
              {inDrag(j) && <rect className="bots-hchart__drag" x={P + colW * j + 1} y={P} width={colW - 2} height={H - B - P} rx={3} />}
              <rect
                className={`bots-hchart__hit${hover === j ? ' is-hover' : ''}`}
                x={P + colW * j} y={P} width={colW} height={H - P}
                onPointerEnter={() => { setHover(j); if (dragRef.current) setDrag({ ...dragRef.current, b: j }); }}
                onPointerDown={(e) => { e.preventDefault(); const g = { a: j, b: j }; dragRef.current = g; setDrag(g); }}
              />
              {j % 3 === 0 && <text className="bots-hchart__x" x={xAt(j)} y={H - 4}>{hh(j).slice(0, 2)}</text>}
            </g>
          );
        })}
        {band && <path className="bots-hchart__band" d={band} />}
        {line && <path className="bots-hchart__avg" d={line} />}
        {hover !== null && v !== null && <circle className="bots-hchart__dot" cx={xAt(hover)} cy={y(v)} r={3.5} />}
      </svg>
      <div className="bots-hchart__key">
        <span className="bots-hchart__tz">Your time, UTC{off >= 0 ? '+' : '−'}{Math.abs(off)}</span>
        <span><i className="is-avg" />Average move, last 7 days</span>
        <span><i className="is-band" />Range</span>
        <span className="bots-hchart__read">{hover !== null ? `${hh(hover)}–${hh(hover + 1)}${v !== null ? ` · moves ${v.toFixed(0)} bp` : ''}` : moves ? 'Click or drag across hours' : 'Reading the last 7 days…'}</span>
      </div>
    </div>
  );
}

export function HoursGate({ d, set }: { d: BotDraft; set: (p: Partial<BotDraft>) => void }) {
  const moves = useHourlyMoves(d.symbol);
  const [exact, setExact] = useState(false);
  const cover = useMemo(() => quietCover(d.quiet), [d.quiet]);
  const off = localOff();
  const has = (w: QuietWindow) => d.quiet.some((x) => same(x, w));
  const put = (ws: QuietWindow[]) => set({ quiet: ws.slice(0, MOST) });
  /** The chart's UTC hours with `utcHours` set on or off, back as joined windows (the other windows kept). */
  const withHours = (utcHours: number[], on: boolean) => {
    const hours = new Set<number>();
    for (const w of d.quiet.filter(isHourly)) {
      const a = Number(w.from.slice(0, 2));
      const b = w.to === '23:59' ? 24 : Number(w.to.slice(0, 2));
      const n = b > a ? b - a : b + 24 - a;
      for (let k = 0; k < n; k++) hours.add((a + k) % 24);
    }
    for (const h of utcHours) { if (on) hours.add(h); else hours.delete(h); }
    const runs: QuietWindow[] = [];
    if (hours.size === 24) runs.push({ from: '00:00', to: '23:59', zone: 'utc', days: 'all' });
    else {
      for (let h = 0; h < 24; h++) {
        if (!hours.has(h) || hours.has((h + 23) % 24)) continue;
        let e = h;
        while (hours.has((e + 1) % 24)) e = (e + 1) % 24;
        runs.push({ from: hh(h), to: hh(e + 1), zone: 'utc', days: 'all' });
      }
    }
    put([...d.quiet.filter((w) => !isHourly(w)), ...runs]);
  };
  // A click toggles an hour; a drag sets the whole stretch to the first hour's opposite.
  const pickHours = (a: number, b: number) => {
    const utc = Array.from({ length: b - a + 1 }, (_, k) => (((a + k - off) % 24) + 24) % 24);
    withHours(utc, (cover[utc[0]!] ?? 0) < 0.5);
  };
  // The three hours that moved most on average.
  const busiest = useMemo(() => (moves ? moves.avg.map((v, h) => ({ v: v ?? 0, h })).sort((x, y) => y.v - x.v).slice(0, 3).map((x) => x.h) : []), [moves]);
  const busyOn = busiest.length > 0 && busiest.every((h) => (cover[h] ?? 0) >= 0.99);
  const only = d.quietOnly;
  return (
    <div className="bots-tgate">
      <Segmented
        label="How the hours work"
        value={only ? 'only' : 'pause'}
        onChange={(v) => set({ quietOnly: v === 'only' })}
        options={[{ value: 'pause', label: 'Skip set hours' }, { value: 'only', label: 'Only trade at set hours' }]}
      />
      <MoveChart moves={moves} cover={cover} only={only} pick={pickHours} />
      <div className="bots-tgate__picks" aria-label="Quick picks">
        {!only && busiest.length > 0 && (
          <button type="button" className={`bots-chip${busyOn ? ' is-on' : ''}`} aria-pressed={busyOn} onClick={() => withHours(busiest, !busyOn)} title="The three hours that moved most on average over the last 7 days">
            <Icon name={busyOn ? 'check' : 'bolt'} size={12} /><b>3 busiest hours</b>
          </button>
        )}
        {PICKS.map((p) => (
          <button key={p.id} type="button" className={`bots-chip${has(p.w) ? ' is-on' : ''}`} aria-pressed={has(p.w)} title={`${localWords(p.w)} your time, ${DAYS[p.w.days]}`} onClick={() => put(has(p.w) ? d.quiet.filter((x) => !same(x, p.w)) : [...d.quiet, p.w])}>
            {has(p.w) && <Icon name="check" size={12} />}<b>{p.label}</b>
          </button>
        ))}
      </div>
      <div className="bots-tgate__say" aria-live="polite">
        {d.quiet.length === 0 ? (
          <span className="dim">{only ? 'Pick the hours it may trade in.' : 'Pick the hours to skip.'}</span>
        ) : (
          <>
            <span>{only ? 'Trades only' : 'Skips'}</span>
            {d.quiet.map((w, i) => {
              const p = QUIET_PRESETS.find((x) => same(x.w, w));
              return (
                <span key={`${w.from}-${w.to}-${w.zone}-${w.days}-${i}`} className="bots-tgate__w">
                  <b>{localWords(w)}</b>{p ? ` ${p.label}` : ''}{w.days !== 'all' ? ` · ${DAYS[w.days]}` : ''}
                  <button type="button" aria-label={`Remove ${localWords(w)}`} onClick={() => put(d.quiet.filter((_, j) => j !== i))}><Icon name="x" size={10} /></button>
                </span>
              );
            })}
            <span className="dim">your time.</span>
          </>
        )}
      </div>
      {exact && d.quiet.length > 0 && (
        <ul className="bots-tgate__list" aria-label="Exact times">
          {d.quiet.map((w, i) => (
            <li key={`x-${i}`}>
              <TextInput aria-label="From" value={w.from} maxLength={5} onChange={(e) => put(d.quiet.map((x, j) => (j === i ? { ...x, from: e.target.value } : x)))} />
              <span>to</span>
              <TextInput aria-label="To" value={w.to} maxLength={5} onChange={(e) => put(d.quiet.map((x, j) => (j === i ? { ...x, to: e.target.value } : x)))} />
              <Segmented label="Zone" value={w.zone} onChange={(z) => put(d.quiet.map((x, j) => (j === i ? { ...x, zone: z } : x)))} options={[{ value: 'new_york', label: 'NY' }, { value: 'london', label: 'LDN' }, { value: 'utc', label: 'UTC' }]} />
              <Segmented label="Days" value={w.days} onChange={(dd) => put(d.quiet.map((x, j) => (j === i ? { ...x, days: dd } : x)))} options={[{ value: 'trading', label: 'Trading days' }, { value: 'weekdays', label: 'Mon–Fri' }, { value: 'all', label: 'Every day' }]} />
            </li>
          ))}
        </ul>
      )}
      <div className="bots-tgate__act">
        <Button variant="quiet" onClick={() => setExact((x) => !x)}>{exact ? 'Hide exact times' : 'Exact times'}</Button>
        {exact && d.quiet.length < MOST && <Button variant="quiet" icon="plus" onClick={() => put([...d.quiet, { from: '12:00', to: '12:30', zone: 'utc', days: 'all' }])}>Add a window</Button>}
      </div>
    </div>
  );
}
