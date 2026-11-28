/**
 * USDC Earn's two charts, as sodex.com shows them on its page (owner 2026-11-28: "usdso has a chart pls make us use
 * it"): the position unit price in USDC and the instant APY, each with 1W / 1M / 3M / 1Y / All. SoDEX's price-history
 * sends nothing for this fund, so both come from the Morpho vault behind it through ValueDesk's relay (server
 * routes/wealthInfo.ts): the unit price by day, the APY by hour for the last 30 days and by day before.
 */
import { useEffect, useMemo, useState } from 'react';
import { EmptyState, Panel, Segmented, Shell, ShellHeader, Skeleton } from '../bots/kit/kit';
import { readEarnSeries, type PricePoint } from '../sodex/wealth/data';
import { PriceChart } from '../sodex/wealth/parts';
import { thin } from './indexParts';

type Range = '1W' | '1M' | '3M' | '1Y' | 'All';
const RANGES: ReadonlyArray<{ value: Range; label: string; days: number | null }> = [
  { value: '1W', label: '1W', days: 7 }, { value: '1M', label: '1M', days: 30 }, { value: '3M', label: '3M', days: 91 },
  { value: '1Y', label: '1Y', days: 365 }, { value: 'All', label: 'All', days: null },
];
const cut = (s: readonly PricePoint[], r: Range): PricePoint[] => {
  const d = RANGES.find((x) => x.value === r)!.days;
  if (d === null || !s.length) return [...s];
  const from = s[s.length - 1]!.t - d * 86_400_000;
  return s.filter((p) => p.t >= from);
};

function Chart({ title, figure, sub, series, fmtY, height = 240, tone = 'sign' }: { title: string; figure: string; sub: string; series: PricePoint[] | null; fmtY: (v: number, dp?: number) => string; height?: number; tone?: 'sign' | 'neutral' }) {
  const [range, setRange] = useState<Range>('1M');
  const shown = useMemo(() => (series ? thin(cut(series, range), 900) : null), [series, range]);
  return (
    <Shell className="wp-sec">
      <ShellHeader title={title} aside={<Segmented size="sm" label="Range" value={range} onChange={setRange} options={RANGES.map((r) => ({ value: r.value, label: r.label }))} />} />
      <Panel className="wp-sec__p">
        <div className="wp-perf__chg wp-earn__fig"><b>{figure}</b><span>{sub}</span></div>
        {!shown ? <Skeleton className="wp-bone wp-bone--chart" /> : shown.length < 2 ? <EmptyState compact icon="chart" title="Nothing in this range yet" /> : <PriceChart points={shown} height={height} label={title} tone={tone} pctReadout={false} fmtY={fmtY} />}
      </Panel>
    </Shell>
  );
}

export function EarnCharts() {
  const [s, setS] = useState<{ points: PricePoint[]; apy: PricePoint[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let off = false;
    readEarnSeries().then((x) => { if (!off) setS(x); }, (e: Error) => { if (!off) setError(e.message); });
    return () => { off = true; };
  }, []);
  if (error && !s) return <Shell className="wp-sec"><ShellHeader title="Performance" /><Panel className="wp-sec__p"><EmptyState compact tone="error" icon="warning" title="USDC Earn’s history did not load" description={error} /></Panel></Shell>;
  const price = s?.points.at(-1)?.v ?? null;
  const apy = s?.apy.at(-1)?.v ?? null;
  return (
    <>
      <Chart title="Position unit price" figure={price === null ? '—' : price.toFixed(6)} sub="USDC per share" series={s?.points ?? null} fmtY={(v, dp) => v.toFixed(Math.max(dp ?? 4, 4))} />
      <Chart title="Instant APY" figure={apy === null ? '—' : `${apy.toFixed(2)}%`} sub="The vault’s average net APY, Morpho" series={s?.apy ?? null} fmtY={(v) => `${v.toFixed(2)}%`} height={200} />
    </>
  );
}
