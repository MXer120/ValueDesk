/**
 * Bots > Explore: the market conditions board (owner 2026-11-09: "a market board made out of 1002 share and volatility,
 * per coin selectable or all"). Hour by hour over the last 7 days, from the market's own trades (server
 * flow/botMarkets.ts botRegime): the share of the traded volume uninformed flow took (cheap for makers to fill), the
 * share informed flow took (it picks off quotes, about 1 bp a fill), and how far the price moved. A maker's cost follows
 * these two more than any setting: on 2026-11-09 uninformed flow stopped and every maker on SoDEX paid ~$220+ per $1M.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { DASH, fmtUsd } from '../../format';
import { useBotRegime, type BotWindow, type RegimeHour } from '../../bots/data';
import { WINDOW_H } from './BotsMarketMap';
import { FxSelect, type FxOption } from '../funds/ui';
import { TAKER_COLORS } from './BotNewPage';
import { niceScale, smoothPath } from './LatencyChart';
import { EmptyState, Button, Panel, Segmented, Shell, ShellHeader, Skeleton, StatCard } from './kit/kit';

const ALL = 'ALL';
const pct = (x: number | null) => (x === null ? DASH : x > 0 && x < 0.005 ? "<1%" : `${Math.round(x * 100)}%`);
const shareOf = (h: RegimeHour, k: 't1002Usd' | 't23342Usd') => (h.volumeUsd && h.volumeUsd > 0 ? h[k] / h.volumeUsd : null);

/** Volume-weighted share over some hours (null when nothing traded). */
function share(hs: readonly RegimeHour[], k: 't1002Usd' | 't23342Usd'): number | null {
  let v = 0, x = 0;
  for (const h of hs) if (h.volumeUsd) { v += h.volumeUsd; x += h[k]; }
  return v > 0 ? x / v : null;
}
function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const a = [...xs].sort((p, q) => p - q);
  return a.length % 2 ? a[(a.length - 1) >> 1]! : (a[a.length / 2 - 1]! + a[a.length / 2]!) / 2;
}

/**
 * What the window means for a market maker. Good: uninformed flow took 40%+ and the volatility is at most 1.5x the
 * typical hour's (7 days); poor: under 10% uninformed or over twice the typical volatility; mixed otherwise.
 */
export function conditionOf(bs: readonly RegimeHour[], typicalBps: number | null, words = 'this window'): { label: string; tone: 'positive' | 'warning' | 'negative' | undefined; why: string } {
  const u = share(bs, 't1002Usd');
  const vol = bs.length ? bs.reduce((a, h) => a + h.volBps, 0) / bs.length : null;
  if (u === null || vol === null) return { label: DASH, tone: undefined, why: `No trades, ${words}` };
  const rel = typicalBps && typicalBps > 0 ? vol / typicalBps : 1;
  if (u >= 0.4 && rel <= 1.5) return { label: 'Good', tone: 'positive', why: 'Uninformed flow, calm price' };
  if (u < 0.1) return { label: 'Poor', tone: 'negative', why: 'Little uninformed flow' };
  if (rel > 2) return { label: 'Poor', tone: 'negative', why: `Volatility ${rel.toFixed(1)}x usual` };
  return { label: 'Mixed', tone: 'warning', why: 'Some uninformed flow' };
}

const H_FLOW = 128, H_GAP = 26, H_MOVE = 56, PAD = { l: 8, r: 44, t: 8, b: 22 };

/**
 * Two lanes over the same buckets. Top: what share of the bucket's traded volume each kind of flow took, stacked from the
 * floor (uninformed, then informed; the rest is everyone else), 0-100% on the right. Bottom: the volatility (bp/h),
 * a smooth line over a soft area, its own scale. Hours the recorder does not hold whole are hatched (as the latency
 * chart's stretches without orders). Point at or tap a bucket: a column and a card with its figures.
 */
/** Where the time axis is marked per window (minutes of the viewer's own clock) and how a mark reads. */
const TICK_MIN: Record<BotWindow, number> = { '1h': 15, '6h': 60, '24h': 360, '7d': 1440 };

function Chart({ hours, win, stepMs }: { hours: readonly RegimeHour[]; win: BotWindow; stepMs: number }) {
  const [at, setAt] = useState<number | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(720);
  useEffect(() => {
    const el = wrap.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(260, Math.round(e!.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const n = hours.length;
  const H = PAD.t + H_FLOW + H_GAP + H_MOVE + PAD.b;
  const plotW = w - PAD.l - PAD.r;
  const step = plotW / Math.max(1, n);
  const bw = Math.max(1, step - (step > 5 ? 1.5 : step > 3 ? 1 : 0.4));
  const x0 = (i: number) => PAD.l + i * step;
  const flowY = (v: number) => PAD.t + (1 - v) * H_FLOW;
  const moveTop = PAD.t + H_FLOW + H_GAP;
  const scale = niceScale(Math.max(10, ...hours.map((h) => h.volBps)) * 1.1);
  const moveY = (v: number) => moveTop + (1 - Math.min(v, scale.top) / scale.top) * H_MOVE;
  const movePts = hours.map((h, i) => [x0(i) + step / 2, moveY(h.volBps)] as [number, number]);
  const moveLine = smoothPath(movePts);
  const moveArea = movePts.length ? `${moveLine}L${movePts[movePts.length - 1]![0].toFixed(1)} ${moveTop + H_MOVE}L${movePts[0]![0].toFixed(1)} ${moveTop + H_MOVE}Z` : '';
  // Time marks on the viewer's own clock (days for 7 d, 6 h for 24 h, hours for 6 h, quarters for 1 h); a midnight
  // reads as its day. On a narrow chart every other one is labelled.
  const days = useMemo(() => hours.map((h, i) => ({ i, d: new Date(h.t) })).filter(({ d }) => (d.getHours() * 60 + d.getMinutes()) % TICK_MIN[win] === 0), [hours, win]);
  const everyDay = plotW / Math.max(1, days.length) > 70;
  const tickWords = (d: Date) => (win === '7d' || (d.getHours() === 0 && d.getMinutes() === 0)
    ? d.toLocaleDateString([], { weekday: 'short', day: 'numeric' })
    : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }));
  const pick = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
    if (!n) return;
    const i = Math.floor((e.clientX - r.left - PAD.l) / step);
    setAt(i < 0 || i >= n ? null : i);
  };
  const h = at === null ? null : hours[at] ?? null;
  const hm = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const when = (t: number) => `${new Date(t).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}, ${hm(t)}${stepMs < 3_600_000 ? `–${hm(t + stepMs)}` : ''}`;
  const last = hours[n - 1];
  const tipLeft = h && at !== null ? Math.min(Math.max(x0(at) + step / 2, 110), w - 110) : 0;
  return (
    <div className="bots-rg" ref={wrap}>
      <div className="bots-rg__head">
        <span className="bots-rg__lane">Who took the volume</span>
        {last && last.volumeUsd !== null && (
          <span className="bots-rg__now">Latest {stepMs >= 3_600_000 ? "hour" : `${Math.round(stepMs / 60_000)} min`} <b style={{ color: TAKER_COLORS.patient }}>{pct(shareOf(last, 't1002Usd'))}</b> uninformed · <b style={{ color: TAKER_COLORS.fast }}>{pct(shareOf(last, 't23342Usd'))}</b> informed</span>
        )}
      </div>
      <div className="bots-rg__plot">
        <svg width={w} height={H} viewBox={`0 0 ${w} ${H}`} className="bots-rg__svg" role="img"
          aria-label="Share of traded volume taken by uninformed and informed flow, and how far the price moved, per hour over 7 days"
          onPointerMove={pick} onPointerDown={pick} onPointerLeave={() => setAt(null)}>
          <defs>
            <linearGradient id="bots-rg-u" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor="var(--pos)" stopOpacity="0.95" />
              <stop offset="1" stopColor="var(--pos)" stopOpacity="0.6" />
            </linearGradient>
            <linearGradient id="bots-rg-f" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor="var(--neg)" stopOpacity="0.95" />
              <stop offset="1" stopColor="var(--neg)" stopOpacity="0.65" />
            </linearGradient>
            <linearGradient id="bots-rg-m" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor="var(--warn)" stopOpacity="0.32" />
              <stop offset="1" stopColor="var(--warn)" stopOpacity="0.02" />
            </linearGradient>
            <pattern id="bots-rg-idle" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="6" height="6" fill="rgb(var(--ink) / 0.025)" />
              <line x1="0" y1="0" x2="0" y2="6" stroke="rgb(var(--ink) / 0.08)" strokeWidth="2" />
            </pattern>
          </defs>
          {[0, 0.5, 1].map((v) => (
            <g key={`f${v}`}>
              <line x1={PAD.l} x2={w - PAD.r} y1={flowY(v)} y2={flowY(v)} className={v === 0 ? 'bots-rg__base' : 'bots-rg__grid'} />
              <text x={w - PAD.r + 8} y={flowY(v) + 3.5} className="bots-rg__ax">{Math.round(v * 100)}%</text>
            </g>
          ))}
          {hours.map((x, i) => {
            const u = shareOf(x, 't1002Usd'), f = shareOf(x, 't23342Usd');
            if (u === null || f === null) return <rect key={x.t} x={x0(i)} y={PAD.t} width={step} height={H_FLOW} fill="url(#bots-rg-idle)" />;
            const rx = Math.min(1.5, bw / 3);
            return (
              <g key={x.t} opacity={at === null || at === i ? 1 : 0.55}>
                <rect x={x0(i)} y={flowY(1)} width={bw} height={H_FLOW} rx={rx} className="bots-rg__rest" />
                {u > 0 && <rect x={x0(i)} y={flowY(u)} width={bw} height={u * H_FLOW} rx={rx} fill="url(#bots-rg-u)" />}
                {f > 0 && <rect x={x0(i)} y={flowY(u + f)} width={bw} height={f * H_FLOW} rx={rx} fill="url(#bots-rg-f)" />}
              </g>
            );
          })}
          <text x={PAD.l} y={moveTop - 8} className="bots-rg__lanet">Volatility</text>
          <text x={w - PAD.r + 8} y={moveTop - 8} className="bots-rg__ax">bp/h</text>
          {[0, scale.top / 2, scale.top].map((v) => (
            <g key={`m${v}`}>
              <line x1={PAD.l} x2={w - PAD.r} y1={moveY(v)} y2={moveY(v)} className={v === 0 ? 'bots-rg__base' : 'bots-rg__grid'} />
              <text x={w - PAD.r + 8} y={moveY(v) + 3.5} className="bots-rg__ax">{Math.round(v)}</text>
            </g>
          ))}
          <path d={moveArea} fill="url(#bots-rg-m)" />
          <path d={moveLine} className="bots-rg__move" />
          {days.map(({ i, d }, k) => (
            <g key={i}>
              <line x1={x0(i)} x2={x0(i)} y1={PAD.t} y2={moveTop + H_MOVE} className="bots-rg__day" />
              {(everyDay || k % 2 === 0) && <text x={x0(i) + 4} y={H - 6} className="bots-rg__ax">{tickWords(d)}</text>}
            </g>
          ))}
          {h && at !== null && (
            <g pointerEvents="none">
              <rect x={x0(at) - 1} y={PAD.t - 2} width={step + 2} height={moveTop + H_MOVE - PAD.t + 2} rx={3} className="bots-rg__cur" />
              <circle cx={x0(at) + step / 2} cy={moveY(h.volBps)} r={3.5} className="bots-rg__dot" />
            </g>
          )}
        </svg>
        {h && (
          <div className="bots-rg__tip" style={{ left: tipLeft }}>
            <b>{when(h.t)}</b>
            {h.volumeUsd === null ? <span className="dim">Not fully recorded</span> : (
              <>
                <span><i style={{ background: TAKER_COLORS.patient }} />Uninformed<b>{pct(shareOf(h, 't1002Usd'))}</b></span>
                <span><i style={{ background: TAKER_COLORS.fast }} />Informed<b>{pct(shareOf(h, 't23342Usd'))}</b></span>
                <span><i className="is-move" />Volatility<b>{Math.round(h.volBps)} bp/h</b></span>
                <span className="dim">Traded<b>{fmtUsd(h.volumeUsd, 0)}</b></span>
              </>
            )}
          </div>
        )}
      </div>
      <div className="bots-rg__key">
        <span><i style={{ background: TAKER_COLORS.patient }} />Uninformed flow</span>
        <span><i style={{ background: TAKER_COLORS.fast }} />Informed flow</span>
        <span><i className="is-rest" />Everyone else</span>
        <span><i className="is-move" />Volatility</span>
        <span><i className="is-gap" />Not recorded</span>
      </div>
    </div>
  );
}

const WIN_WORDS: Record<BotWindow, string> = { '1h': 'last hour', '6h': 'last 6 hours', '24h': 'last 24 hours', '7d': 'last 7 days' };
const STEP_WORDS = (ms: number) => (ms >= 3_600_000 ? 'hour' : `${Math.round(ms / 60_000)} min`);

export function MarketConditions() {
  const [sym, setSym] = useState<string>(ALL);
  const [win, setWin] = useState<BotWindow>('24h');
  const r = useBotRegime(sym, win);
  const d = r.data;
  const options: FxOption[] = useMemo(() => [{ value: ALL, label: 'All markets', icon: undefined }, ...(d?.markets ?? []).map((m) => ({ value: m, label: m.replace(/-USD$/i, ''), icon: m.replace(/-USD$/i, '') }))], [d?.markets]);
  // A server from before the windows answers 7 days by the hour to every window: cut it to the window here.
  const legacy = !!d && d.window === undefined;
  const stepMs = d?.stepMs ?? 3_600_000;
  const hours = useMemo(() => {
    if (!d || d.symbol.toUpperCase() !== sym.toUpperCase() || (!legacy && d.window !== win)) return [];
    if (!legacy) return d.hours;
    const from = (d.hours[d.hours.length - 1]?.t ?? 0) - (WINDOW_H[win] - 1) * 3_600_000;
    return d.hours.filter((h) => h.t >= from);
  }, [d, sym, win, legacy]);
  const held = hours.filter((h) => h.volumeUsd !== null);
  const last = held.slice(-1);
  const vol = held.length ? held.reduce((a, h) => a + h.volBps * (h.volumeUsd ?? 0), 0) / Math.max(1, held.reduce((a, h) => a + (h.volumeUsd ?? 0), 0)) : null;
  const typical = d?.typicalVolBps ?? median(held.map((h) => h.volBps));
  const cond = conditionOf(held, typical, WIN_WORDS[win]);
  const loading = !d || d.symbol.toUpperCase() !== sym.toUpperCase() || (!legacy && d.window !== win);
  const lastWords = `Latest ${STEP_WORDS(legacy ? 3_600_000 : stepMs)}`;
  return (
    <Shell className="bots-regime">
      <ShellHeader
        icon="pulse"
        title="Market conditions"
        subtitle={`Who takes makers' quotes and how volatile the price is, ${WIN_WORDS[win]}`}
        aside={
          <div className="bots-rg__ctl">
            <FxSelect value={sym} options={options} onChange={setSym} label="Market" searchable searchPlaceholder="Search markets" triggerClassName="bots-rg__pick" listMinWidth={220} listAlign="end" />
            <Segmented value={win} label="Window" onChange={setWin} options={[{ value: '1h', label: '1h' }, { value: '6h', label: '6h' }, { value: '24h', label: '24h' }, { value: '7d', label: '7d' }]} />
          </div>
        }
      />
      <div className="bots-kpigrid is-4 bots-rg__kpis">
        <StatCard index={0} label="Uninformed flow" value={pct(share(held, 't1002Usd'))} valueTone={(share(held, 't1002Usd') ?? 0) >= 0.4 ? 'positive' : undefined} hint={`${lastWords}: ${pct(share(last, 't1002Usd'))}`} />
        <StatCard index={1} label="Informed flow" value={pct(share(held, 't23342Usd'))} valueTone={(share(held, 't23342Usd') ?? 0) >= 0.5 ? 'negative' : undefined} hint={`${lastWords}: ${pct(share(last, 't23342Usd'))}`} />
        <StatCard index={2} label="Volatility" value={vol !== null ? `${Math.round(vol)} bp/h` : DASH} hint={typical !== null ? `Typical hour: ${Math.round(typical)} bp/h` : undefined} />
        <StatCard index={3} label="For market makers" value={cond.label} valueTone={cond.tone === 'warning' ? undefined : cond.tone} hint={cond.why} />
      </div>
      <Panel className="bots-rg__panel">
        {r.error && !d ? (
          <EmptyState compact tone="error" icon="warning" title="Conditions unavailable" description={`The data service did not answer (${r.error}).`} actions={<Button onClick={r.refresh}>Retry</Button>} />
        ) : loading ? (
          <Skeleton className="bots-rg__skel" />
        ) : !hours.length ? (
          <EmptyState compact icon="search" title="No trades recorded here" description="Pick another market, another window or All markets." />
        ) : legacy && win !== '7d' && win !== '24h' ? (
          <EmptyState compact icon="clock" title={`Not by the ${win === '1h' ? 'minute' : 'quarter hour'} yet`} description="The data service still answers by the hour; this window fills in once it is updated." />
        ) : (
          <Chart hours={hours} win={win} stepMs={legacy ? 3_600_000 : stepMs} />
        )}
      </Panel>
    </Shell>
  );
}
