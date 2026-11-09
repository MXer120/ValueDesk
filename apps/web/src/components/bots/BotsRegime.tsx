/**
 * Bots > Explore: the market conditions board (owner 2026-11-09: "a market board made out of 1002 share and volatility,
 * per coin selectable or all"). Hour by hour over the last 7 days, from the market's own trades (server
 * flow/botMarkets.ts botRegime): the share of the traded volume uninformed flow took (cheap for makers to fill), the
 * share informed flow took (it picks off quotes, about 1 bp a fill), and how far the price moved. A maker's cost follows
 * these two more than any setting: on 2026-11-09 uninformed flow stopped and every maker on SoDEX paid ~$220+ per $1M.
 */
import { useMemo, useRef, useState } from 'react';
import { DASH, fmtUsd } from '../../format';
import { useBotRegime, type RegimeHour } from '../../bots/data';
import { FxSelect, type FxOption } from '../funds/ui';
import { TAKER_COLORS } from './BotNewPage';
import { EmptyState, Button, Panel, Shell, ShellHeader, Skeleton, StatCard } from './kit/kit';

const ALL = 'ALL';
const pct = (x: number | null) => (x === null ? DASH : `${Math.round(x * 100)}%`);
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
 * What the last 3 hours mean for a market maker. Good: uninformed flow took 40%+ and the price moved no more than 1.5x
 * its 7-day typical; poor: under 10% uninformed or more than twice the typical moves; mixed otherwise.
 */
export function conditionOf(recent: readonly RegimeHour[], typicalBps: number | null): { label: string; tone: 'positive' | 'warning' | 'negative' | undefined; why: string } {
  const u = share(recent, 't1002Usd');
  const moves = recent.length ? recent.reduce((a, h) => a + h.volBps, 0) / recent.length : null;
  if (u === null || moves === null) return { label: DASH, tone: undefined, why: 'No trades in the last 3 hours' };
  const rel = typicalBps && typicalBps > 0 ? moves / typicalBps : 1;
  if (u >= 0.4 && rel <= 1.5) return { label: 'Good', tone: 'positive', why: `Uninformed flow ${pct(u)}, calm price` };
  if (u < 0.1 || rel > 2) return { label: 'Poor', tone: 'negative', why: u < 0.1 ? `Uninformed flow ${pct(u)}: quotes mostly picked off` : `Price moves ${rel.toFixed(1)}x the usual` };
  return { label: 'Mixed', tone: 'warning', why: `Uninformed flow ${pct(u)}, moves ${rel.toFixed(1)}x the usual` };
}

const W = 6; // px per hour in the chart's own units
const TOP = 76, GAP = 10, LOW = 38, AXIS = 14;

function Chart({ hours }: { hours: readonly RegimeHour[] }) {
  const [at, setAt] = useState<number | null>(null);
  const ref = useRef<SVGSVGElement>(null);
  const n = hours.length;
  const width = Math.max(1, n * W);
  const height = TOP + GAP + LOW + AXIS;
  const maxMove = Math.max(1, ...hours.map((h) => h.volBps));
  const lowY = TOP + GAP;
  const movePath = useMemo(() => {
    if (!n) return '';
    const pts = hours.map((h, i) => `${(i * W + W / 2).toFixed(1)},${(lowY + LOW - (h.volBps / maxMove) * (LOW - 2)).toFixed(1)}`);
    return `M${(W / 2).toFixed(1)},${lowY + LOW} L${pts.join(' L')} L${((n - 1) * W + W / 2).toFixed(1)},${lowY + LOW} Z`;
  }, [hours, n, maxMove, lowY]);
  // Day marks at the viewer's own midnights.
  const days = useMemo(() => hours.map((h, i) => ({ i, d: new Date(h.t) })).filter(({ d }) => d.getHours() === 0), [hours]);
  const pick = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = ref.current?.getBoundingClientRect();
    if (!r || !n) return;
    const i = Math.floor(((e.clientX - r.left) / r.width) * n);
    setAt(Math.min(n - 1, Math.max(0, i)));
  };
  const h = at === null ? hours[n - 1] : hours[at];
  const when = (t: number) => new Date(t).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  return (
    <div className="bots-rg">
      <div className="bots-rg__read" aria-live="polite">
        {h ? (
          <>
            <b>{when(h.t)}</b>
            {h.volumeUsd === null ? <span className="dim">Not fully recorded</span> : (
              <>
                <span><i style={{ background: TAKER_COLORS.patient }} />Uninformed <b>{pct(shareOf(h, 't1002Usd'))}</b></span>
                <span><i style={{ background: TAKER_COLORS.fast }} />Informed <b>{pct(shareOf(h, 't23342Usd'))}</b></span>
                <span><i className="is-move" />Moves <b>{Math.round(h.volBps)} bp</b></span>
                <span className="dim">{fmtUsd(h.volumeUsd, 0)} traded</span>
              </>
            )}
            {at === null && <span className="dim">· latest hour, point at or tap the chart for any other</span>}
          </>
        ) : <span className="dim">No hours yet</span>}
      </div>
      <svg ref={ref} className="bots-rg__svg" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img"
        aria-label="Share of traded volume taken by uninformed and informed flow, and how far the price moved, per hour over 7 days"
        onPointerMove={pick} onPointerLeave={() => setAt(null)}>
        {hours.map((x, i) => {
          const u = shareOf(x, 't1002Usd'), f = shareOf(x, 't23342Usd');
          const xx = i * W + 0.5;
          if (u === null || f === null) return <rect key={x.t} x={xx} y={0} width={W - 1} height={TOP} className="bots-rg__gap" />;
          return (
            <g key={x.t}>
              <rect x={xx} y={0} width={W - 1} height={TOP} className="bots-rg__rest" />
              <rect x={xx} y={TOP - u * TOP} width={W - 1} height={u * TOP} fill={TAKER_COLORS.patient} />
              <rect x={xx} y={0} width={W - 1} height={f * TOP} fill={TAKER_COLORS.fast} opacity={0.85} />
            </g>
          );
        })}
        <path d={movePath} className="bots-rg__move" />
        {days.map(({ i }) => <line key={i} x1={i * W} x2={i * W} y1={0} y2={lowY + LOW} className="bots-rg__day" />)}
        {at !== null && <rect x={at * W} y={0} width={W} height={lowY + LOW} className="bots-rg__cur" />}
      </svg>
      <div className="bots-rg__axis" aria-hidden>
        {days.map(({ i, d }) => <span key={i} style={{ left: `${(i / Math.max(1, n)) * 100}%` }}>{d.toLocaleDateString([], { weekday: 'short', day: 'numeric' })}</span>)}
      </div>
      <div className="bots-rg__key">
        <span><i style={{ background: TAKER_COLORS.patient }} />Uninformed flow (from the bottom)</span>
        <span><i style={{ background: TAKER_COLORS.fast }} />Informed flow (from the top)</span>
        <span><i className="is-move" />Price moves (lower band)</span>
        <span><i className="is-gap" />Not recorded</span>
      </div>
    </div>
  );
}

export function MarketConditions() {
  const [sym, setSym] = useState<string>(ALL);
  const r = useBotRegime(sym);
  const d = r.data;
  const options: FxOption[] = useMemo(() => [{ value: ALL, label: 'All markets' }, ...(d?.markets ?? []).map((m) => ({ value: m, label: m, icon: m.replace(/-USD$/i, '') }))], [d?.markets]);
  const hours = useMemo(() => (d && d.symbol.toUpperCase() === sym.toUpperCase() ? d.hours : []), [d, sym]);
  const held = hours.filter((h) => h.volumeUsd !== null);
  const last = held.slice(-1);
  const recent = held.slice(-3);
  const typical = median(held.map((h) => h.volBps));
  const cond = conditionOf(recent, typical);
  const loading = !d || d.symbol.toUpperCase() !== sym.toUpperCase();
  return (
    <Shell className="bots-regime">
      <ShellHeader
        icon="pulse"
        title="Market conditions"
        subtitle="Who takes makers' quotes and how much the price moves, hour by hour, last 7 days"
        aside={<FxSelect value={sym} options={options} onChange={setSym} label="Market" searchable searchPlaceholder="Search markets" triggerClassName="bots-rg__pick" listMinWidth={220} listAlign="end" />}
      />
      <div className="bots-kpigrid is-4">
        <StatCard index={0} label="Uninformed flow, last hour" value={pct(share(last, 't1002Usd'))} valueTone={(share(last, 't1002Usd') ?? 0) >= 0.4 ? 'positive' : undefined} hint={`7 days: ${pct(share(held, 't1002Usd'))}`} />
        <StatCard index={1} label="Informed flow, last hour" value={pct(share(last, 't23342Usd'))} valueTone={(share(last, 't23342Usd') ?? 0) >= 0.5 ? 'negative' : undefined} hint={`7 days: ${pct(share(held, 't23342Usd'))}`} />
        <StatCard index={2} label="Price moves, last hour" value={last[0] ? `${Math.round(last[0].volBps)} bp` : DASH} hint={typical !== null ? `Typical: ${Math.round(typical)} bp an hour` : undefined} />
        <StatCard index={3} label="For market makers" value={cond.label} valueTone={cond.tone === 'warning' ? undefined : cond.tone} hint={cond.why} />
      </div>
      <Panel className="bots-rg__panel">
        {r.error && !d ? (
          <EmptyState compact tone="error" icon="warning" title="Conditions unavailable" description={`The data service did not answer (${r.error}).`} actions={<Button onClick={r.refresh}>Retry</Button>} />
        ) : loading ? (
          <Skeleton className="bots-rg__skel" />
        ) : !hours.length ? (
          <EmptyState compact icon="search" title="No trades recorded here" description="Pick another market or All markets." />
        ) : (
          <Chart hours={hours} />
        )}
      </Panel>
    </Shell>
  );
}
