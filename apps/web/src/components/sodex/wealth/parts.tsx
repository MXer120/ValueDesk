/**
 * What the Wealth versions share: the fund mark, the price chart, the sparks, the channel pill, the fund's own way in
 * or out, the fund's detail and the wallet's activity. Every way in or out is the Original's: Trade opens the spot
 * order book, Invest and Redeem open portfolio/WealthSheet.tsx (the same signatures and checks), and a fund SoDEX
 * documents no route for opens sodex.com. Nothing here signs or sends anything itself.
 */
import { useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CoinIcon } from '../../CoinIcon';
import { Modal } from '../../Modal';
import { openConnectDialog } from '../../account/connect';
import { Button, EmptyState, Icon, IconTile, Segmented, Skeleton, Sparkline, StatusPill, Tabs, Tag, type ButtonVariant, type IconName } from '../../bots/kit/kit';
import { DASH, fmt, fmtUsd, signClass } from '../../../format';
import { useMask } from '../../../privacy';
import { sodexFundUrl, type JoinedHolding, type WealthEntry, type WealthPlan } from '../../../trading/wealth';
import { useLedger, type WealthState } from '../../portfolio/useWealth';
import type { WealthSheetTarget } from '../../portfolio/WealthSheet';
import { SodexMark } from '../../funds/ui';
import { pathOf, sampleLine, samplesFor, type LineShape } from '../../../chart/lineMorph';
import { useLineMorph } from '../../../chart/useLineMorph';
import {
  HIST_RANGES, KIND, channelOf, dayOnly, dayTime, expectedDelivery, hasHistory, heldIn, holding24h, holdingPnl, isMoving, leftShort,
  marketState, pctText, seriesChange, statusTone, statusWord, usdCompact, usePriceHistory, val, whenMs,
  type FundView, type HistRange, type PricePoint, type Quote,
} from './data';

export type OpenMarket = (symbol: string, engine: 'spot') => void;
export type OpenSheet = (t: WealthSheetTarget) => void;

/** What every version hands its parts. `provider` is null while a localhost test wallet is watched: nothing can sign. */
export interface WealthCtx {
  address: string | null;
  refreshToken: number;
  onOpenMarket: OpenMarket;
  onSheet: OpenSheet;
}

const signed = (v: number): string => `${v > 0 ? '+' : ''}${fmtUsd(v)}`;

export function FundMark({ v, size = 32 }: { v: Pick<FundView, 'icon'>; size?: number }) {
  return <span className="wv-mark" style={{ width: size, height: size }}><CoinIcon coin={v.icon} size={Math.round(size * 0.72)} /></span>;
}

/** A figure that reads as a gain or a loss. */
export function Signed({ v, children, className }: { v: number | null; children: ReactNode; className?: string }) {
  return <span className={`${v === null ? '' : signClass(v)} ${className ?? ''}`}>{children}</span>;
}

// --- how it trades -----------------------------------------------------------------------

export function ChannelPill({ v, now, size = 'sm' }: { v: FundView; now: number; size?: 'sm' | 'md' }) {
  const c = channelOf(v);
  const left = c.at && c.at > now ? leftShort(c.at, now) : null;
  return (
    <StatusPill tone={c.tone} size={size} dot className="wv-chan" title={c.at ? `${c.atLabel} ${dayTime(c.at)}` : undefined}>
      {c.label}{left && <span className="wv-chan__t">{c.atLabel === 'Cutoff' ? `closes in ${left}` : `opens in ${left}`}</span>}
    </StatusPill>
  );
}

/**
 * The fund's way in (side 'buy') or out ('sell'). Closed: nothing, the channel pill says why. Not read yet: nothing,
 * never a button that does not know what it does.
 */
export function FundAct({ v, side = 'buy', ctx, size = 'sm', variant = 'secondary', wide }: {
  v: Pick<FundView, 'id' | 'fund' | 'name' | 'action'>;
  side?: 'buy' | 'sell';
  ctx: WealthCtx;
  size?: 'sm' | 'md';
  variant?: ButtonVariant;
  wide?: boolean;
}) {
  const a = v.action;
  const cls = wide ? 'wv-wide' : undefined;
  if (!a) return null;
  if (a.kind === 'trade') return <Button size={size} variant={variant} className={cls} onClick={() => ctx.onOpenMarket(a.symbol, 'spot')}>Trade</Button>;
  if (a.kind === 'batch' || a.kind === 'rfq') {
    return <Button size={size} variant={variant} className={cls} onClick={() => ctx.onSheet({ fund: v.fund, name: v.name, action: a, side })}>{side === 'buy' ? 'Invest' : 'Redeem'}</Button>;
  }
  if (a.kind === 'external') {
    return (
      <a className={`tf-btn is-${variant} is-${size} ${cls ?? ''}`} href={sodexFundUrl(v.id)} target="_blank" rel="noopener noreferrer">
        On SoDEX<Icon name="up" size={12} />
      </a>
    );
  }
  return null;
}

// --- charts ----------------------------------------------------------------------------

/**
 * A line over real points: green when the window ends above its start, red below ('sign'); a wallet's value is ink,
 * not green (a balance rising is not a profit: 'neutral'). Axis labels and the readout go through `mask` (privacy).
 */
export function PriceChart({ points, height = 240, tone = 'sign', fmtY = (v: number, dp?: number) => fmtUsd(v, dp), mask = (n) => n, label, pctReadout = true }: {
  points: readonly PricePoint[];
  height?: number;
  tone?: 'sign' | 'neutral';
  /** `dp`: the places the axis needs so its labels differ (a flat $7.06 to $7.07 series reads to the cent and below). */
  fmtY?: (v: number, dp?: number) => string;
  mask?: (n: ReactNode) => ReactNode;
  label: string;
  /** The readout's change since the window's start, in percent (a price), or none (a PnL near zero). */
  pctReadout?: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  const gid = useId().replace(/:/g, '');
  const [w, setW] = useState(0);
  const [at, setAt] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const read = () => setW(el.clientWidth);
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const GUT = 62;
  const TOP = 12;
  const FOOT = 26;
  const n = points.length;
  const g = useMemo(() => {
    if (w <= GUT + 20 || n < 2) return null;
    let lo = Infinity;
    let hi = -Infinity;
    for (const p of points) { lo = Math.min(lo, p.v); hi = Math.max(hi, p.v); }
    const span = hi - lo || Math.abs(hi) * 0.02 || 1;
    const y0 = lo - span * 0.1;
    const y1 = hi + span * 0.1;
    const pw = w - GUT;
    const ph = height - TOP - FOOT;
    const t0 = points[0]!.t;
    const t1 = points[n - 1]!.t;
    const X = (t: number) => (t1 > t0 ? ((t - t0) / (t1 - t0)) * pw : 0);
    const Y = (v: number) => TOP + (1 - (v - y0) / (y1 - y0)) * ph;
    const line = points.map((p, i) => `${i ? 'L' : 'M'}${X(p.t).toFixed(1)},${Y(p.v).toFixed(1)}`).join('');
    const area = `${line}L${X(t1).toFixed(1)},${(TOP + ph).toFixed(1)}L0,${(TOP + ph).toFixed(1)}Z`;
    const ticks = hi > lo ? [hi, lo + (hi - lo) * (2 / 3), lo + (hi - lo) / 3, lo] : [hi];
    const xs = [0, Math.round((n - 1) / 2), n - 1].filter((i, k, a) => a.indexOf(i) === k);
    const step = (hi - lo) / 3;
    const dp = step > 0 && step < 1 ? Math.min(6, Math.max(2, Math.ceil(-Math.log10(step)) + 1)) : undefined;
    return { X, Y, pw, ph, line, area, ticks, xs, dp };
  }, [w, n, points, height]);
  const first = points[0]?.v ?? 0;
  const last = points[n - 1]?.v ?? 0;
  const cls = tone === 'neutral' ? 'is-ink' : last >= first ? 'is-up' : 'is-down';
  // Another range, Value to PnL: the line reshapes into the new one and the labels cross-fade, as the trade chart
  // switches (chart/lineMorph.ts; owner 2026-11-26). A new point or a resize redraws at once.
  const target: LineShape | null = g ? { pts: sampleLine(points.map((q) => [g.X(q.t), g.Y(q.v)] as const), samplesFor(g.pw), false), base: g.Y(first) } : null;
  const decor = g ? (
    <>
      {g.ticks.map((v, i) => <span key={i} className="wv-chart__y" style={{ top: g.Y(v) - 9 }}>{mask(fmtY(v, g.dp))}</span>)}
      {g.xs.map((i, k) => (
        <span key={`x${i}`} className={`wv-chart__xl${k === 0 ? ' is-first' : k === g.xs.length - 1 ? ' is-last' : ''}`} style={{ left: g.X(points[i]!.t), width: 0 }}>
          <i>{dayOnly(points[i]!.t)}</i>
        </span>
      ))}
    </>
  ) : null;
  const morph = useLineMorph(target, `${points[0]?.t ?? ''}|${label}|${tone}`, decor);
  const frame = morph.frame;
  const fLine = frame ? pathOf(frame.pts) : null;
  const fEnd = frame ? frame.pts[frame.pts.length - 1]! : null;
  const move = (clientX: number) => {
    const el = box.current;
    if (!el || !g) return;
    const x = clientX - el.getBoundingClientRect().left;
    let best = 0;
    let dist = Infinity;
    for (let i = 0; i < n; i++) {
      const d = Math.abs(g.X(points[i]!.t) - x);
      if (d < dist) { dist = d; best = i; }
    }
    setAt(best);
  };
  const p = at === null || frame || at >= n ? null : points[at];
  return (
    <div
      ref={box}
      className={`wv-chart ${cls}`}
      style={{ height }}
      role="img"
      aria-label={`${label}, ${dayOnly(points[0]?.t ?? 0)} to ${dayOnly(points[n - 1]?.t ?? 0)}`}
      onPointerMove={(e) => move(e.clientX)}
      onPointerDown={(e) => move(e.clientX)}
      onPointerLeave={() => setAt(null)}
    >
      <span className="wv-chart__ground" style={{ right: GUT, top: TOP, bottom: FOOT }} aria-hidden="true" />
      {g && (
        <>
          <svg width={w} height={height} aria-hidden="true">
            <defs>
              <linearGradient id={gid} x1="0" x2="0" y1="0" y2="1">
                <stop offset="0" stopColor="currentColor" stopOpacity="0.26" />
                <stop offset="1" stopColor="currentColor" stopOpacity="0" />
              </linearGradient>
            </defs>
            <line className="wv-chart__base" x1={0} x2={g.pw} y1={frame ? frame.base : g.Y(first)} y2={frame ? frame.base : g.Y(first)} />
            <path d={fLine ? `${fLine}L${g.pw.toFixed(1)},${(TOP + g.ph).toFixed(1)}L0,${(TOP + g.ph).toFixed(1)}Z` : g.area} fill={`url(#${gid})`} />
            <path d={fLine ?? g.line} className="wv-chart__line" />
            {p && <line className="wv-chart__x" x1={g.X(p.t)} x2={g.X(p.t)} y1={TOP} y2={TOP + g.ph} />}
            <circle className="wv-chart__dot" cx={fEnd ? fEnd[0] : g.X(p ? p.t : points[n - 1]!.t)} cy={fEnd ? fEnd[1] : g.Y(p ? p.v : last)} r={3.5} />
          </svg>
          {morph.prev && <span className="wv-chart__decor" style={{ opacity: 1 - morph.e }} aria-hidden="true">{morph.prev}</span>}
          <span className="wv-chart__decor" style={morph.prev ? { opacity: morph.e } : undefined}>{decor}</span>
          {p && (
            <span className={`wv-chart__tip${g.X(p.t) > g.pw / 2 ? ' is-left' : ''}`} style={{ left: g.X(p.t) }}>
              <small>{new Date(p.t).toLocaleDateString(undefined, { dateStyle: 'medium' })}</small>
              <b>{mask(fmtY(p.v))}</b>
              {pctReadout && first > 0 && <Signed v={p.v - first}>{pctText(((p.v - first) / first) * 100)}</Signed>}
            </span>
          )}
        </>
      )}
    </div>
  );
}

/** A card-wide spark of the fund's last 30 days of closes. Nothing for a fund SoDEX keeps no closes for. */
export function WideSpark({ v, caption = true }: { v: FundView; caption?: boolean }) {
  const on = hasHistory(v.fund);
  const { points } = usePriceHistory(on ? v.id : null, '1M');
  const gid = useId().replace(/:/g, '');
  if (!on) return null;
  if (!points) return <Skeleton className="wv-wspark is-skel" />;
  if (points.length < 2) return <span className="wv-wspark" />;
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of points) { lo = Math.min(lo, p.v); hi = Math.max(hi, p.v); }
  const span = hi - lo || 1;
  const t0 = points[0]!.t;
  const t1 = points[points.length - 1]!.t || t0 + 1;
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${(((p.t - t0) / (t1 - t0 || 1)) * 100).toFixed(2)},${(30 - ((p.v - lo) / span) * 26).toFixed(2)}`).join('');
  const up = points[points.length - 1]!.v >= points[0]!.v;
  const change = seriesChange(points);
  return (
    <span className="wv-wspark__box">
      {caption && <span className="wv-wspark__cap">30 days <Signed v={change}>{pctText(change)}</Signed></span>}
    <svg className={`wv-wspark ${up ? 'is-up' : 'is-down'}`} viewBox="0 0 100 32" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id={gid} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="currentColor" stopOpacity="0.22" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${d}L100,32L0,32Z`} fill={`url(#${gid})`} />
      <path d={d} className="wv-wspark__l" />
    </svg>
    </span>
  );
}

/** A row's spark (the kit's), 30 days of closes. */
export function RowSpark({ v, w = 72, h = 28 }: { v: Pick<FundView, 'id' | 'fund' | 'quote'>; w?: number; h?: number }) {
  const on = hasHistory(v.fund);
  const { points } = usePriceHistory(on ? v.id : null, '1M');
  if (!on) {
    // No closes for this vault: its three APY windows, as small bars from zero.
    const xs = [val(v.quote?.apy24h), val(v.quote?.apy7d), val(v.quote?.apy1M)];
    const max = Math.max(0, ...xs.map((x) => x ?? 0));
    return (
      <span className="wv-rspark is-apy" style={{ width: w, height: h }} title="APY over 24 hours, 7 days and 30 days">
        {max > 0 && xs.map((x, i) => <i key={i} className={i === 1 ? 'is-main' : undefined} style={{ height: x && x > 0 ? Math.max(2, (x / max) * (h - 4)) : 2 }} />)}
      </span>
    );
  }
  if (!points) return <Skeleton className="wv-rspark" style={{ width: w, height: h }} />;
  const up = points.length > 1 && points[points.length - 1]!.v >= points[0]!.v;
  return <span className="wv-rspark" style={{ width: w, height: h }}><Sparkline values={points.map((p) => p.v)} tone={up ? 'positive' : 'negative'} w={w} h={h} /></span>;
}

// --- the fund itself -------------------------------------------------------------------

const BASIS: Readonly<Record<string, string>> = { net_excluding_rewards: 'Net, excluding rewards' };

/** The fund's price over a range, or for a vault SoDEX keeps no closes for, its APY over three windows. */
export function FundPerformance({ v, height = 240 }: { v: FundView; height?: number }) {
  const [range, setRange] = useState<HistRange>('1M');
  const on = hasHistory(v.fund);
  const { points, error } = usePriceHistory(on ? v.id : null, range);
  const q = v.quote;
  if (!on) {
    const tiles: Array<[string, string | undefined]> = [['24-hour APY', q?.apy24h], ['7-day APY', q?.apy7d], ['30-day APY', q?.apy1M]];
    return (
      <div className="wv-apys">
        <div className="wv-apys__t">
          {tiles.map(([k, s]) => (
            <div key={k} className={k === '7-day APY' ? 'is-main' : undefined}><span>{k}</span><b>{pctText(val(s), false)}</b></div>
          ))}
        </div>
        <p className="wv-apys__n">{q?.yieldBasis ? (BASIS[q.yieldBasis] ?? q.yieldBasis.replace(/_/g, ' ')) : 'Yield as SoDEX reports it'}{q?.asOf ? ` · as of ${dayTime(q.asOf)}` : ''}</p>
      </div>
    );
  }
  const change = seriesChange(points);
  return (
    <div className="wv-perf">
      <div className="wv-perf__top">
        <div className="wv-perf__chg">
          <Signed v={change}><b>{pctText(change)}</b></Signed>
          <span>{points && points.length > 1 ? `Closes, ${dayOnly(points[0]!.t)} – ${dayOnly(points[points.length - 1]!.t)}` : 'Closes'}</span>
        </div>
        <Segmented size="sm" label="Range" value={range} onChange={setRange} options={HIST_RANGES.map((r) => ({ value: r.value, label: r.label }))} />
      </div>
      {error && !points ? <div className="wv-chart is-empty" style={{ height }}><p>SoDEX did not send this fund's prices just now.</p></div>
        : !points ? <Skeleton className="wv-chart is-skel" style={{ height }} />
        : points.length < 2 ? <div className="wv-chart is-empty" style={{ height }}><p>No closes in this range yet.</p></div>
        : <PriceChart points={points} height={height} label={`${v.name} price`} />}
    </div>
  );
}

/** SoDEX's own figures for the fund, each only where SoDEX sends it. */
export function FundFacts({ v }: { v: FundView }) {
  const q: Quote | null = v.quote;
  const rows: Array<[string, ReactNode, string?]> = [];
  const r = (k: string, s: string | undefined) => { const x = val(s); if (x !== null) rows.push([k, <Signed v={x}>{pctText(x)}</Signed>]); };
  const price = val(q?.price);
  if (price !== null) rows.push(['Price', fmtUsd(price)]);
  const nav = val(v.fund.nav);
  if (nav !== null && v.fund.fundType !== 'clob') rows.push(['NAV per share', fmtUsd(nav, nav < 10 ? 4 : 2), v.fund.asOf ? `As of ${dayTime(v.fund.asOf)}` : undefined]);
  r('24 hours', q?.roi24h);
  r('1 month', q?.roi1M);
  r('Year to date', q?.roiYtd);
  r('1 year', q?.roi1Y);
  r('3 years', q?.roi3Y);
  const div = val(q?.dividendYield);
  if (div !== null) rows.push(['Dividend yield', pctText(div, false)]);
  const aum = val(v.fund.aum);
  if (aum !== null) rows.push(['Fund size', usdCompact(aum), 'Assets under management, from SoDEX']);
  const lo = val(q?.dayLow);
  const hi = val(q?.dayHigh);
  if (lo !== null && hi !== null) rows.push(['Day range', `${fmtUsd(lo)} – ${fmtUsd(hi)}`]);
  return (
    <dl className="wv-facts">
      {rows.map(([k, x, t]) => <div key={k} title={t}><dt>{k}</dt><dd>{x}</dd></div>)}
    </dl>
  );
}

/** How the fund trades now, with its times, in plain words. */
export function FundChannel({ v, now }: { v: FundView; now: number }) {
  const a = v.action;
  const rows: Array<[IconName, string, ReactNode]> = [];
  if (!a) rows.push(['clock', 'Channel', v.fund.fundType === 'clob' ? 'Spot order book' : 'Reading from SoDEX']);
  else if (a.kind === 'trade') rows.push(['chart', 'Trades on', `SoDEX spot order book${v.fund.spot ? `, ${v.fund.spot.displayName}` : ''}`]);
  else if (a.kind === 'batch') {
    rows.push(['layers', 'Channel', 'Batch: requests settle together at the next price']);
    if (a.cutoffAt) rows.push(['clock', 'Cutoff', <>{dayTime(a.cutoffAt)}{a.cutoffAt * 1000 > now && <em> · in {leftShort(a.cutoffAt * 1000, now)}</em>}</>]);
    if (a.deliveryAt) rows.push(['check', 'Expected delivery', dayTime(a.deliveryAt)]);
  } else if (a.kind === 'rfq') {
    rows.push(['bolt', 'Channel', 'A maker\'s quote, filled from your wallet']);
    if (a.deliveryAt) rows.push(['check', 'Expected delivery', dayTime(a.deliveryAt)]);
  } else if (a.kind === 'external') {
    rows.push(['compass', 'Subscribe', 'On sodex.com']);
    rows.push(['shield', 'Why', 'SoDEX documents no route for it from other sites']);
  }
  else {
    rows.push(['pause', 'Now', a.why]);
    if (a.nextAt) rows.push(['clock', 'Opens', <>{dayTime(a.nextAt)}{a.nextAt * 1000 > now && <em> · in {leftShort(a.nextAt * 1000, now)}</em>}</>]);
  }
  const m = marketState(v.quote);
  if (m) rows.push(['pulse', 'Underlying market', m.label]);
  return (
    <ul className="wv-chanlist">
      {rows.map(([ic, k, x]) => <li key={k}><Icon name={ic} size={15} /><span>{k}</span><b>{x}</b></li>)}
    </ul>
  );
}

/** The wallet's own holding in one fund. */
export function FundPosition({ h, ticker }: { h: JoinedHolding; ticker: string }) {
  const maskFunds = useMask('funds');
  const maskPnl = useMask('pnl');
  const pnl = holdingPnl(h);
  const d = holding24h(h);
  return (
    <div className="wv-pos">
      <div><span>Value</span><b>{maskFunds(h.marketValue === null ? DASH : fmtUsd(h.marketValue))}</b></div>
      <div><span>PnL</span><b><Signed v={pnl}>{maskPnl(pnl === null ? DASH : signed(pnl))}</Signed></b></div>
      <div><span>24h</span><b><Signed v={d}>{maskPnl(d === null ? DASH : signed(d))}</Signed></b></div>
      <div><span>Shares</span><b>{maskFunds(`${fmt(h.shares, 4)} ${ticker}`)}</b></div>
      {h.inFlight > 0 && <div><span>In progress</span><b>{maskFunds(fmtUsd(h.inFlight))}</b></div>}
      <p className="wv-pos__in">{heldIn(h).map((t) => <StatusPill key={t} size="sm">{t}</StatusPill>)}</p>
    </div>
  );
}

/** The fund's ways in and out, and its page on SoDEX. */
export function FundActions({ v, ctx }: { v: FundView; ctx: WealthCtx }) {
  const redeemable = !!v.holding && (v.action?.kind === 'batch' || v.action?.kind === 'rfq');
  return (
    <div className="wv-detail__acts">
      <FundAct v={v} ctx={ctx} size="md" variant="primary" wide />
      {redeemable && <FundAct v={v} side="sell" ctx={ctx} size="md" variant="secondary" wide />}
      <a className="tf-btn is-quiet is-md" href={sodexFundUrl(v.id)} target="_blank" rel="noopener noreferrer"><SodexMark size={15} />Fund page on SoDEX</a>
    </div>
  );
}

/** The whole fund: what Shelves opens in a sheet and Desk shows beside its list. */
export function FundDetail({ v, ctx, now, chartHeight = 240, head = true, actions = true }: { v: FundView; ctx: WealthCtx; now: number; chartHeight?: number; head?: boolean; actions?: boolean }) {
  const holding = v.holding;
  return (
    <div className="wv-detail">
      {head && (
        <header className="wv-detail__head">
          <FundMark v={v} size={44} />
          <div className="wv-detail__t">
            <h2>{v.name}</h2>
            <p>{v.ticker} · {v.shelf}</p>
          </div>
          <div className="wv-detail__fig">
            <Signed v={v.head.kind === 'roi' ? v.head.value : null}><b>{pctText(v.head.value, v.head.kind === 'roi')}</b></Signed>
            <small>{v.head.label}</small>
          </div>
        </header>
      )}
      <div className="wv-detail__pills">
        <ChannelPill v={v} now={now} />
        {holding && <StatusPill tone="positive" size="sm" icon="check">You hold this</StatusPill>}
      </div>
      <FundPerformance v={v} height={chartHeight} />
      <div className="wv-detail__cols">
        <section>
          <h3 className="wv-h3">Figures</h3>
          <FundFacts v={v} />
        </section>
        <section>
          <h3 className="wv-h3">How it trades</h3>
          <FundChannel v={v} now={now} />
        </section>
      </div>
      {holding && (
        <section>
          <h3 className="wv-h3">Your position</h3>
          <FundPosition h={holding} ticker={v.ticker} />
        </section>
      )}
      {actions && <FundActions v={v} ctx={ctx} />}
      {v.quote?.asOf && <p className="wv-asof">Prices from SoDEX, as of {dayTime(v.quote.asOf)}</p>}
    </div>
  );
}

/** The fund in a sheet (a phone sheet from the bottom, a dialog wider). */
export function FundSheet({ v, onClose, ctx, now }: { v: FundView | null; onClose: () => void; ctx: WealthCtx; now: number }) {
  const title = v ? <span className="wv-sheet__title"><FundMark v={v} size={28} />{v.name}</span> : '';
  return (
    <Modal open={!!v} title={title} onClose={onClose} size="lg" sheet className="tf wv-modal" footer={v ? <FundActions v={v} ctx={ctx} /> : undefined}>
      {v && <FundDetail v={v} ctx={ctx} now={now} head={false} chartHeight={220} actions={false} />}
    </Modal>
  );
}

// --- the wallet's activity -------------------------------------------------------------

export function ConnectEmpty({ line, compact = true }: { line: string; compact?: boolean }) {
  return (
    <EmptyState
      icon="wallet"
      title="No wallet connected"
      description={line}
      compact={compact}
      actions={<Button variant="primary" onClick={() => openConnectDialog()}>Connect wallet</Button>}
    />
  );
}

const ENTRY_ICON: Readonly<Record<string, IconName>> = {
  subscribe: 'plus', deposit: 'plus', redeem: 'down', airdrop: 'star', liquidation: 'warning', transfer_in: 'arrowLeft', transfer_out: 'arrowRight',
};

export function HoldingRow({ h, v, ctx }: { h: JoinedHolding; v: FundView | null; ctx: WealthCtx }) {
  const maskFunds = useMask('funds');
  const maskPnl = useMask('pnl');
  const pnl = holdingPnl(h);
  return (
    <li className="wv-row">
      <FundMark v={v ?? { icon: h.coin }} size={36} />
      <span className="wv-row__t">
        <b>{h.name}</b>
        <small>{maskFunds(fmt(h.shares, 4))} {h.coin} · {heldIn(h).join(', ') || DASH}</small>
      </span>
      <span className="wv-row__n">
        <b>{maskFunds(h.marketValue === null ? DASH : fmtUsd(h.marketValue))}</b>
        <small><Signed v={pnl}>{maskPnl(pnl === null ? DASH : signed(pnl))}</Signed>{h.inFlight > 0 && <> · {maskFunds(fmtUsd(h.inFlight))} on its way</>}</small>
      </span>
      <span className="wv-row__a">{v && <FundAct v={v} side={v.action?.kind === 'trade' ? 'buy' : 'sell'} ctx={ctx} />}</span>
    </li>
  );
}

export function EntryRow({ e, name, ticker, v }: { e: WealthEntry; name: string; ticker: string; v: FundView | null }) {
  const maskFunds = useMask('funds');
  const amount = e.cost ?? e.proceeds;
  const due = isMoving(e) ? expectedDelivery(e, v?.status ?? null) : null;
  return (
    <li className="wv-row">
      <IconTile icon={ENTRY_ICON[e.kind] ?? 'list'} />
      <span className="wv-row__t">
        <b>{name}</b>
        <small>{KIND[e.kind] ?? e.kind} · {dayTime(e.requestedAt ?? e.at)}{due && <> · expected {dayTime(due)}</>}</small>
      </span>
      <span className="wv-row__n">
        <b>{maskFunds(amount !== undefined ? `${e.costEstimated ? '≈ ' : ''}${fmtUsd(val(amount) ?? 0)}` : e.shares !== undefined ? `${fmt(val(e.shares) ?? 0, 4)} ${ticker}` : DASH)}</b>
        <small><StatusPill tone={statusTone(e.status)} size="sm" dot>{statusWord(e.status)}</StatusPill></small>
      </span>
      <span className="wv-row__a">
        {/* A claim needs the on-chain request id, which the API does not return (the Original's rule). */}
        {e.claimable === true && <a className="tf-btn is-primary is-sm" href={sodexFundUrl(e.fundId)} target="_blank" rel="noopener noreferrer">Claim on SoDEX</a>}
        {e.txHash && <a className="tf-btn is-quiet is-sm is-icon" href={`https://main-scan.valuechain.xyz/tx/${e.txHash}`} target="_blank" rel="noopener noreferrer" aria-label="Transaction" title="Transaction on ValueChain"><Icon name="up" size={14} /></a>}
      </span>
    </li>
  );
}

export function PlanRow({ p, name, icon }: { p: WealthPlan; name: string; icon: string }) {
  const next = whenMs(p.nextScheduledAt);
  return (
    <li className="wv-row">
      <FundMark v={{ icon }} size={36} />
      <span className="wv-row__t">
        <b>{name}</b>
        <small>Every {p.planType.replace('_', '-').toLowerCase()} · {p.successfulExecutionCount} bought{next ? ` · next ${dayTime(next)}` : ''}</small>
      </span>
      <span className="wv-row__n"><b>{fmtUsd(val(p.amount) ?? 0)}</b><small><Tag>{p.status.toLowerCase()}</Tag></small></span>
      <span className="wv-row__a" />
    </li>
  );
}

type ActTab = 'holdings' | 'moving' | 'history' | 'plans';

/** Holdings, what is on its way, history and recurring buys: the Original's four tabs as designed lists. */
export function Activity({ w, views, ctx, title }: { w: WealthState; views: FundView[] | null; ctx: WealthCtx; title?: ReactNode }) {
  const { entries, plans, error } = useLedger(ctx.address, ctx.refreshToken);
  const byId = useMemo(() => new Map((views ?? []).map((v) => [v.id, v])), [views]);
  const [tab, setTab] = useState<ActTab>('holdings');
  const moving = entries ? entries.filter(isMoving) : null;
  const nameOf = (id: string) => byId.get(id)?.name ?? id;
  const tickerOf = (id: string) => byId.get(id)?.ticker ?? '';
  const bones = <ul className="wv-rows" aria-busy="true">{[0, 1, 2].map((i) => <li key={i} className="wv-row"><Skeleton className="wv-bone" /></li>)}</ul>;
  const ledger = (rows: WealthEntry[] | null, none: string, line: string) => (
    !ctx.address ? <ConnectEmpty line="Connect a wallet to see your Wealth activity." />
      : error && !rows ? <EmptyState icon="warning" tone="error" title="SoDEX did not send your Wealth history" description={error} compact />
      : !rows ? bones
      : rows.length === 0 ? <EmptyState icon="clock" title={none} description={line} compact />
      : <ul className="wv-rows">{rows.map((e, i) => <EntryRow key={`${e.txHash ?? e.at}-${i}`} e={e} name={nameOf(e.fundId)} ticker={tickerOf(e.fundId)} v={byId.get(e.fundId) ?? null} />)}</ul>
  );
  const body = tab === 'holdings'
    ? (!ctx.address ? <ConnectEmpty line="Connect a wallet to see what you hold in Wealth." />
      : w.error && !w.holdings ? <EmptyState icon="warning" tone="error" title="SoDEX did not send your holdings" description={w.error} compact actions={<Button onClick={w.refresh}>Try again</Button>} />
      : !w.holdings ? bones
      : w.holdings.length === 0 ? <EmptyState icon="coins" title="No Wealth holdings yet" description="Funds you hold or have requested show here." compact />
      : <ul className="wv-rows">{w.holdings.map((h) => <HoldingRow key={h.fundId} h={h} v={byId.get(h.fundId) ?? null} ctx={ctx} />)}</ul>)
    : tab === 'moving' ? ledger(moving, 'Nothing on its way', 'Requests show here until they settle.')
    : tab === 'history' ? ledger(entries, 'No Wealth history yet', 'Deposits, redemptions and airdrops show here.')
    : (!ctx.address ? <ConnectEmpty line="Connect a wallet to see your recurring buys." />
      : !plans ? bones
      : plans.length === 0 ? <EmptyState icon="clock" title="No recurring buys" description="SoDEX sets these up on its own Wealth pages." compact actions={<a className="tf-btn is-secondary is-sm" href="https://sodex.com/wealth" target="_blank" rel="noopener noreferrer">Open SoDEX Wealth</a>} />
      : <ul className="wv-rows">{plans.map((p) => <PlanRow key={p.planIndex} p={p} name={nameOf(p.fundId ?? '') || (p.share?.coin ?? p.target)} icon={byId.get(p.fundId ?? '')?.icon ?? p.share?.coin ?? p.target} />)}</ul>);
  return (
    <section className="wv-act">
      <div className="wv-act__h">
        {title}
        <Tabs
          label="Your Wealth"
          value={tab}
          onChange={setTab}
          tabs={[
            { value: 'holdings', label: 'Holdings', count: w.holdings?.length || undefined },
            { value: 'moving', label: 'In progress', count: moving?.length || undefined },
            { value: 'history', label: 'History' },
            { value: 'plans', label: 'Recurring' },
          ]}
        />
      </div>
      {body}
    </section>
  );
}

/** SoDEX's maintenance notice (wealthMaintenance.ts): only an answer that says maintenance shows. */
export function MaintNote({ message }: { message: string | null }) {
  return (
    <div className="wv-maint" role="status">
      <StatusPill tone="warning" size="sm" dot>Maintenance</StatusPill>
      <span>{message || 'SoDEX has Wealth in maintenance. Figures may be behind.'}</span>
    </div>
  );
}

export { signed as signedUsd };

/**
 * What the wallet's fund shares pledged as Perps margin are worth. The Wealth value (summary.ts) leaves them in Perps,
 * each dollar once; the Wealth page says so beside it rather than count them twice.
 */
export function pledgedValue(holdings: readonly JoinedHolding[] | null): number {
  return (holdings ?? []).reduce((s, h) => s + (h.marketValue !== null && h.shares > 0 ? h.marketValue * (h.perpShares / h.shares) : 0), 0);
}

/** What WealthPage.tsx hands every version: the Original's reads, unchanged. */
export interface VersionProps {
  w: WealthState;
  /** The Wealth bucket from portfolio/summary.ts, so every version and the Portfolio agree. */
  value: number | null;
  slp: number | null;
  ctx: WealthCtx;
  maint: { state: 'normal' | 'maintenance' | 'unknown'; message: string | null } | null;
}

/** Three APY windows as bars, for a vault SoDEX keeps no closes for (USDC Earn). */
export function ApyBars({ q }: { q: Quote | null }) {
  const bars: Array<[string, number | null]> = [['24h', val(q?.apy24h)], ['7d', val(q?.apy7d)], ['30d', val(q?.apy1M)]];
  const max = Math.max(0, ...bars.map(([, x]) => x ?? 0));
  if (max <= 0) return null;
  // From zero, scaled to the largest: the bars compare the three windows honestly.
  return (
    <div className="wv-apybars" aria-label="APY over 24 hours, 7 days and 30 days">
      {bars.map(([k, x]) => (
        <span key={k} className={k === '7d' ? 'is-main' : undefined}>
          <i style={{ height: x === null || x <= 0 ? 2 : Math.max(3, (x / max) * 34) }} />
          <small>{k} <b>{pctText(x, false)}</b></small>
        </span>
      ))}
    </div>
  );
}
