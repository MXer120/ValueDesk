/**
 * The time gate (owner 2026-11-08: "quiet hours" read either way): pause during set hours, or trade only during them,
 * picked over a chart of how much the market moves at each hour of the day (the last 7 days as faint lines, their
 * average bold), so the hours to skip are the ones that stand out. Click an hour to add or drop it; session presets
 * (New York open, London open...) run on the exchange's trading days, holidays skipped (engine bots.ts tradingDay).
 * Exact times stay one fold away. The hours are the viewer's own clock; the windows are stored in UTC or the
 * session's zone (DST included).
 */
import { useEffect, useMemo, useState } from 'react';
import { fetchKlineRows } from '../../chart/klines';
import { QUIET_PRESETS, type BotDraft, type QuietWindow } from '../../bots/presets';
import { quietCover } from '../../bots/estimate';
import { Button, Icon, Segmented, TextInput } from './kit/kit';

const ZONE: Record<QuietWindow['zone'], string> = { utc: 'UTC', new_york: 'New York', london: 'London' };
const DAYS: Record<QuietWindow['days'], string> = { all: 'every day', weekdays: 'Mon–Fri', trading: 'trading days' };
const MOST = 6;
/** The viewer's whole-hour offset from UTC (a half-hour zone rounds). */
const localOff = (): number => Math.round(-new Date().getTimezoneOffset() / 60);
const hh = (h: number): string => `${String(((h % 24) + 24) % 24).padStart(2, '0')}:00`;
const same = (a: QuietWindow, b: QuietWindow) => a.from === b.from && a.to === b.to && a.zone === b.zone && a.days === b.days;
/** A one-hour custom window, UTC, every day. */
const hourWin = (utcH: number): QuietWindow => ({ from: hh(utcH), to: hh(utcH + 1), zone: 'utc', days: 'all' });

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

/** The chart: 24 hour columns in the viewer's time, the covered ones shaded; a click toggles that hour. */
function MoveChart({ moves, cover, only, toggle }: { moves: ReturnType<typeof useHourlyMoves>; cover: number[]; only: boolean; toggle: (localH: number) => void }) {
  const off = localOff();
  const [hover, setHover] = useState<number | null>(null);
  const W = 640, H = 150, P = 6, B = 18;
  const colW = (W - P * 2) / 24;
  // Local hour j shows UTC hour (j - off).
  const utcOf = (j: number) => (((j - off) % 24) + 24) % 24;
  const all = moves ? moves.days.flat().filter((x): x is number => x !== null) : [];
  const top = all.length ? Math.max(...all) * 1.08 : 1;
  const y = (v: number) => P + (H - B - P) * (1 - v / top);
  const path = (series: Array<number | null>) => {
    let s = '';
    series.forEach((_, j) => {
      const v = series[utcOf(j)];
      if (v === null || v === undefined) return;
      s += `${s ? 'L' : 'M'}${(P + colW * (j + 0.5)).toFixed(1)},${y(v).toFixed(1)}`;
    });
    return s;
  };
  const avgH = hover !== null && moves ? moves.avg[utcOf(hover)] : null;
  return (
    <div className="bots-hchart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="How much the price moves at each hour, last 7 days" onMouseLeave={() => setHover(null)}>
        {Array.from({ length: 24 }, (_, j) => {
          const c = cover[utcOf(j)] ?? 0;
          // Shaded: the hours it does not trade (paused, or outside its trading hours).
          const off = only ? 1 - c : c;
          return (
            <g key={j}>
              {off > 0.01 && <rect className="bots-hchart__off" x={P + colW * j} y={P} width={colW} height={H - B - P} style={{ opacity: 0.25 + 0.55 * Math.min(1, off) }} />}
              <rect className={`bots-hchart__hit${hover === j ? ' is-hover' : ''}`} x={P + colW * j} y={P} width={colW} height={H - P} onMouseEnter={() => setHover(j)} onClick={() => toggle(j)}>
                <title>{hh(j)}</title>
              </rect>
              {j % 3 === 0 && <text className="bots-hchart__x" x={P + colW * (j + 0.5)} y={H - 4}>{hh(j).slice(0, 2)}</text>}
            </g>
          );
        })}
        {moves?.days.map((d, k) => <path key={k} className="bots-hchart__day" d={path(d)} />)}
        {moves && <path className="bots-hchart__avg" d={path(moves.avg)} />}
      </svg>
      <div className="bots-hchart__key">
        <span className="bots-hchart__tz">Your time, UTC{off >= 0 ? '+' : '−'}{Math.abs(off)}</span>
        <span><i className="is-avg" />7-day average</span>
        <span><i className="is-day" />Each day</span>
        <span><i className="is-off" />{only ? 'Not trading' : 'Paused'}</span>
        <span className="bots-hchart__read">{hover !== null ? `${hh(hover)}–${hh(hover + 1)} your time${avgH !== null && avgH !== undefined ? ` · moves ${avgH.toFixed(0)} bp an hour` : ''}` : moves ? 'Click an hour to add or remove it' : 'Reading the last 7 days…'}</span>
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
  // A click toggles one UTC hour among the clicked ones (UTC, every day, on the hour); neighbours join into one window.
  const toggleHour = (localH: number) => {
    const u = (((localH - off) % 24) + 24) % 24;
    const isHourly = (w: QuietWindow) => w.zone === 'utc' && w.days === 'all' && w.from.endsWith(':00') && w.to.endsWith(':00');
    const hours = new Set<number>();
    for (const w of d.quiet.filter(isHourly)) {
      const a = Number(w.from.slice(0, 2));
      const b = Number(w.to.slice(0, 2));
      for (let h = a; h !== b; h = (h + 1) % 24) hours.add(h);
    }
    if (hours.has(u)) hours.delete(u);
    else hours.add(u);
    const runs: QuietWindow[] = [];
    if (hours.size === 24) runs.push({ from: '00:00', to: '23:59', zone: 'utc', days: 'all' });
    else {
      for (let h = 0; h < 24; h++) {
        if (!hours.has(h) || hours.has((h + 23) % 24)) continue;
        let e = h;
        while (hours.has((e + 1) % 24)) e = (e + 1) % 24;
        runs.push({ ...hourWin(h), to: hh(e + 1) });
      }
    }
    put([...d.quiet.filter((w) => !isHourly(w)), ...runs]);
  };
  return (
    <div className="bots-tgate">
      <Segmented
        label="How the hours work"
        value={d.quietOnly ? 'only' : 'pause'}
        onChange={(v) => set({ quietOnly: v === 'only' })}
        options={[{ value: 'pause', label: 'Pause during them' }, { value: 'only', label: 'Trade only in them' }]}
      />
      <MoveChart moves={moves} cover={cover} only={d.quietOnly} toggle={toggleHour} />
      <div className="bots-tgate__presets">
        {QUIET_PRESETS.map((p) => (
          <button key={p.id} type="button" className={`bots-chip${has(p.w) ? ' is-on' : ''}`} aria-pressed={has(p.w)} onClick={() => put(has(p.w) ? d.quiet.filter((x) => !same(x, p.w)) : [...d.quiet, p.w])}>
            {has(p.w) && <Icon name="check" size={12} />}<b>{p.label}</b><small>{p.w.from}–{p.w.to} {p.w.zone === 'utc' ? 'UTC' : p.w.zone === 'new_york' ? 'NY' : 'LDN'}</small>
          </button>
        ))}
      </div>
      <p className="bots-fine">Sessions run on that exchange's trading days: weekends and holidays (Thanksgiving, Good Friday, bank holidays) are skipped. For releases like CPI or the Fed, use the news gate.</p>
      {d.quiet.length > 0 && (
        <ul className="bots-tgate__list" aria-label="Windows">
          {d.quiet.map((w, i) => (
            <li key={`${w.from}-${w.to}-${w.zone}-${w.days}-${i}`}>
              {exact ? (
                <>
                  <TextInput aria-label="From" value={w.from} maxLength={5} onChange={(e) => put(d.quiet.map((x, j) => (j === i ? { ...x, from: e.target.value } : x)))} />
                  <span>to</span>
                  <TextInput aria-label="To" value={w.to} maxLength={5} onChange={(e) => put(d.quiet.map((x, j) => (j === i ? { ...x, to: e.target.value } : x)))} />
                  <Segmented label="Zone" value={w.zone} onChange={(z) => put(d.quiet.map((x, j) => (j === i ? { ...x, zone: z } : x)))} options={[{ value: 'new_york', label: 'NY' }, { value: 'london', label: 'LDN' }, { value: 'utc', label: 'UTC' }]} />
                  <Segmented label="Days" value={w.days} onChange={(dd) => put(d.quiet.map((x, j) => (j === i ? { ...x, days: dd } : x)))} options={[{ value: 'trading', label: 'Trading days' }, { value: 'weekdays', label: 'Mon–Fri' }, { value: 'all', label: 'Every day' }]} />
                </>
              ) : (
                <span className="bots-tgate__w"><b>{w.from}–{w.to}</b> {ZONE[w.zone]} · {DAYS[w.days]}</span>
              )}
              <button type="button" className="tf-btn is-quiet is-icon is-sm" aria-label={`Remove ${w.from}–${w.to} ${ZONE[w.zone]}`} onClick={() => put(d.quiet.filter((_, j) => j !== i))}><Icon name="x" size={12} /></button>
            </li>
          ))}
        </ul>
      )}
      <div className="bots-tgate__act">
        <Button variant="quiet" onClick={() => setExact((x) => !x)}>{exact ? 'Done' : 'Exact times'}</Button>
        {exact && d.quiet.length < MOST && <Button variant="quiet" icon="plus" onClick={() => put([...d.quiet, { from: '12:00', to: '12:30', zone: 'utc', days: 'all' }])}>Add a window</Button>}
        <span className="bots-fine">{d.quiet.length}/{MOST} windows</span>
      </div>
    </div>
  );
}
