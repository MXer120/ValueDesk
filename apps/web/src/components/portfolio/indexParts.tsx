/**
 * What the Wealth page's index views share (the board's cards, the browse page, an index page, the builder): every
 * index this browser can show, one index by id, its legs' closes, the funds' minimums, and the index drawn: its funds'
 * marks, its allocation as a ring and a bar, its card. Colours are by position in the index (the largest leg first in
 * ValueDesk's own), never by a coloured edge on one side.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { CoinIcon } from '../CoinIcon';
import { Button, SegmentedBar, Skeleton, StatusPill } from '../bots/kit/kit';
import { useAsync } from '../../hooks';
import { DASH, MINUS, fmtUsd, num } from '../../format';
import { openPath } from '../../nav';
import { readGateway } from '../../trading/gateway';
import { fundLabel, readFund, resumingIn, type FundAction, type WealthFund } from '../../trading/wealth';
import { useNow } from '../sodex/parts';
import { useLanguage } from '../../i18n/store';
import { readInfo } from './FundAbout';
import { pictureUrl, safeDataUrl } from '../../trading/indexPicture';
import type { RecurringTarget } from '../../trading/recurring';
import { readEarnMinIn } from '../../trading/wealthEarn';
import {
  SOSO_INDEXES, VD_INDEXES, basketApy, basketHistory, changeOver, keptVersion, kindOf, readDrafts, routeOf, subscribeKept, type Close, type VdIndex,
} from '../../trading/vdIndexes';
import { INDEX_PUBLISHING, readPublished, usePublished } from '../../trading/vdIndexApi';
import { SSI_FUNDS, readSsiQuotes } from '../../trading/ssiSpot';
import { markComingSoon, readListing } from '../../trading/listing';
import { readPriceHistory, type HistRange } from '../sodex/wealth/data';
import { WEALTH_PATH } from './wealthRoute';
import type { WealthState } from './useWealth';

/** Twelve colours for up to twelve legs (indexes/claim.ts INDEX_LEGS_MAX), defined in wealthPages.css. */
export const legColor = (i: number): string => `var(--wp-c${(i % 12) + 1})`;

export const fundIconOf = (f: WealthFund | null | undefined, id: string): string => (f?.fundType === 'bridged_vault' ? 'USDC' : f?.share.coin ?? id);
export const fundNameOf = (funds: readonly WealthFund[] | null, id: string): string => {
  const f = funds?.find((x) => x.fundId === id);
  return f ? fundLabel(f).name : id;
};
export const shortAddr = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;
/**
 * Whether every leg is a yield fund (Stable Earn: USDC Earn, US Cash Yield), the only funds whose 7-day APY reads as a
 * yield. SoDEX annualises a week of an ETF's price into an "APY" in the thousands of percent: never shown for those.
 */
export const yieldOnlyIndex = (ix: Pick<VdIndex, 'legs'>, funds: readonly WealthFund[] | null): boolean =>
  ix.legs.length > 0 && ix.legs.every((l) => { const f = funds?.find((x) => x.fundId === l.fundId); return !!f && fundLabel(f).yield; });
export const pct = (v: number | null, dp = 2): string => (v === null ? DASH : `${v > 0 ? '+' : v < 0 ? MINUS : ''}${Math.abs(v * 100).toFixed(dp)}%`);
export const tone = (v: number | null): string => (v === null || v === 0 ? '' : v > 0 ? 'pos' : 'neg');

/**
 * The Wealth state the index views use: SoDEX's Wealth funds plus the SSI tokens on SoDEX's spot book (ssiSpot.ts) with
 * their spot prices, so a fixed index can hold them. The rest of the Wealth page keeps SoDEX's own list.
 */
/** The Wealth state with SoDEX's "not offered now" marked on each fund (trading/listing.ts), for the whole page. */
export function useListedWealth(w: WealthState): WealthState {
  const l = useAsync(() => readListing(), [], { pollMs: 300_000 });
  return useMemo(() => {
    if (!w.funds || !l.data) return w;
    const funds = markComingSoon(w.funds, l.data);
    return funds === w.funds ? w : { ...w, funds };
  }, [w, l.data]);
}

export function useIndexWealth(w: WealthState): WealthState {
  const q = useAsync(() => readSsiQuotes(), [], { pollMs: 60_000 });
  const l = useAsync(() => readListing(), [], { pollMs: 300_000 });
  return useMemo(() => ({
    ...w,
    funds: w.funds ? [...w.funds, ...markComingSoon(SSI_FUNDS, l.data)] : null,
    quotes: q.data ? new Map([...w.quotes, ...q.data.map((x) => [x.fundId, x] as const)]) : w.quotes,
  }), [w, q.data, l.data]);
}

/** The drafts in this browser, live (another tab's change too). */
export function useDrafts(): VdIndex[] {
  const v = useSyncExternalStore(subscribeKept, keptVersion, keptVersion);
  return useMemo(() => readDrafts(), [v]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** Every index this browser can show: ValueDesk's, published ones (newest first) and the drafts kept here. */
export function useAllIndexes(): { valuedesk: readonly VdIndex[]; sosovalue: readonly VdIndex[]; published: VdIndex[] | null; drafts: VdIndex[]; error: string | null } {
  const pub = usePublished();
  const drafts = useDrafts();
  return { valuedesk: VD_INDEXES, sosovalue: SOSO_INDEXES, published: pub.list, drafts, error: pub.error };
}

/** One index by its id: ValueDesk's, a draft here, or a published one from the server. undefined while reading. */
export function useIndex(id: string): { ix: VdIndex | null | undefined; error: string | null } {
  const drafts = useDrafts();
  const local = VD_INDEXES.find((x) => x.id === id) ?? drafts.find((x) => x.id === id) ?? null;
  const remoteId = INDEX_PUBLISHING && !local && /^c[0-9a-z]{9}$/.test(id) ? id : null;
  const [r, setR] = useState<{ id: string; ix: VdIndex | null; error: string | null } | null>(null);
  useEffect(() => {
    if (!remoteId) return;
    let off = false;
    readPublished(remoteId)
      .then((ix) => { if (!off) setR({ id: remoteId, ix, error: null }); })
      .catch((e: Error) => { if (!off) setR({ id: remoteId, ix: null, error: e.message }); });
    return () => { off = true; };
  }, [remoteId]);
  if (local) return { ix: local, error: null };
  if (!remoteId) return { ix: null, error: null };
  return r?.id === remoteId ? { ix: r.ix, error: r.error } : { ix: undefined, error: null };
}

/**
 * Each leg's daily closes for a range (SoDEX's price-history, read once per fund and range for ten minutes and shared
 * with the fund pages). A fund SoDEX keeps no closes for (USDC Earn) is left out, not waited for.
 */
export function useLegCloses(fundIds: readonly string[], funds: readonly WealthFund[] | null, range: HistRange): { closes: Map<string, Close[]> | null; error: string | null } {
  const key = `${range}|${fundIds.join(',')}|${funds ? 1 : 0}`;
  const [s, setS] = useState<{ key: string; closes: Map<string, Close[]> | null; error: string | null }>({ key: '', closes: null, error: null });
  useEffect(() => {
    if (!funds) return;
    let off = false;
    const ids = [...fundIds];
    void Promise.allSettled(ids.map((id) => readPriceHistory(id, range))).then((rows) => {
      if (off) return;
      const m = new Map<string, Close[]>();
      let failed = 0;
      rows.forEach((r, i) => {
        if (r.status === 'fulfilled') m.set(ids[i]!, r.value.map((p) => ({ t: p.t, close: p.v })));
        else failed++;
      });
      setS({ key, closes: m, error: failed && failed === ids.length ? 'SoDEX did not send the funds’ prices just now.' : null });
    });
    return () => { off = true; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return s.key === key ? { closes: s.closes, error: s.error } : { closes: null, error: null };
}

/** The least each fund takes, in USD, live: a spot market's minimum notional, a vault's minimum deposit, USDC Earn's bridge minimum. */
const minCache = new Map<string, { at: number; v: number }>();
export function useMinimums(funds: readonly WealthFund[] | null, fundIds: readonly string[]): Map<string, number> {
  const key = `${fundIds.join(',')}|${funds?.length ?? 0}`;
  const r = useAsync(async () => {
    const out = new Map<string, number>();
    const need = fundIds.filter((id) => { const h = minCache.get(id); if (h && Date.now() - h.at < 10 * 60_000) { out.set(id, h.v); return false; } return true; });
    if (!need.length) return out;
    const spot = need.some((id) => funds?.find((f) => f.fundId === id)?.fundType === 'clob')
      ? await readGateway<Array<{ name: string; minNotional?: string }>>('/api/v1/spot/markets/symbols').catch(() => [])
      : [];
    await Promise.all(need.map(async (id) => {
      const f = funds?.find((x) => x.fundId === id);
      if (!f) return;
      let v = 0;
      if (f.fundType === 'clob') v = num(spot?.find((s) => s.name === f.spot?.symbol)?.minNotional);
      else if (f.fundType === 'bridged_vault') v = await readEarnMinIn().catch(() => 0);
      else {
        const d = await readFund(id).catch(() => null);
        v = num((d?.chainConfig as { minDeposit?: string } | null | undefined)?.minDeposit);
      }
      minCache.set(id, { at: Date.now(), v });
      out.set(id, v);
    }));
    return out;
  }, [key], { enabled: !!funds && fundIds.length > 0 });
  return r.data ?? new Map();
}

/** A series with at most `max` points for drawing (every k-th day, the last always kept); figures use the whole. */
export function thin<T>(s: readonly T[], max = 900): T[] {
  if (s.length <= max) return [...s];
  const k = Math.ceil(s.length / max);
  const out = s.filter((_, i) => i % k === 0);
  if (out[out.length - 1] !== s[s.length - 1]) out.push(s[s.length - 1]!);
  return out;
}

// --- drawn ------------------------------------------------------------------------------------------

export function IndexMarks({ ix, funds, size = 24, max = 5 }: { ix: Pick<VdIndex, 'legs'>; funds: readonly WealthFund[] | null; size?: number; max?: number }) {
  const shown = ix.legs.slice(0, max);
  const more = ix.legs.length - shown.length;
  return (
    <span className="wp-marks" aria-hidden="true">
      {shown.map((l) => <span key={l.fundId} className="wp-marks__m" style={{ width: size, height: size }}><CoinIcon coin={fundIconOf(funds?.find((f) => f.fundId === l.fundId), l.fundId)} size={Math.round(size * 0.74)} /></span>)}
      {more > 0 && <span className="wp-marks__m wp-marks__more" style={{ width: size, height: size }}>+{more}</span>}
    </span>
  );
}

/** Who an index is from: ValueDesk, a wallet's name or address, or this browser. */
export function IndexBy({ ix, me }: { ix: VdIndex; me?: string | null }) {
  const k = kindOf(ix);
  if (k === 'valuedesk') return <StatusPill tone="brand" size="sm" icon="star">ValueDesk</StatusPill>;
  if (k === 'sosovalue') return <StatusPill tone="neutral" size="sm" icon="layers">SoSoValue SSI</StatusPill>;
  if (k === 'draft') return <StatusPill tone="neutral" size="sm" icon="pen">{!INDEX_PUBLISHING ? 'Yours' : ix.publishedId ? 'Draft, published' : 'Draft'}</StatusPill>;
  const mine = !!me && ix.owner === me.toLowerCase();
  return <StatusPill tone={mine ? 'positive' : 'neutral'} size="sm" icon="users">{mine ? 'Yours, published' : ix.ownerName ? `by ${ix.ownerName}` : `by ${shortAddr(ix.owner ?? '')}`}</StatusPill>;
}

export function AllocBar({ ix, funds, size = 'sm' }: { ix: Pick<VdIndex, 'legs'>; funds: readonly WealthFund[] | null; size?: 'sm' | 'md' | 'lg' }) {
  return (
    <SegmentedBar
      size={size}
      max={1}
      label="Allocation"
      segments={ix.legs.map((l, i) => ({ id: l.fundId, value: l.weight, label: fundNameOf(funds, l.fundId), color: legColor(i) }))}
    />
  );
}

/** The allocation as a ring: each leg an arc of its weight, a hair of space between, the count in the middle. */
export function AllocRing({ ix, size = 168, focus, onFocus }: { ix: Pick<VdIndex, 'legs'>; size?: number; focus?: string | null; onFocus?: (id: string | null) => void }) {
  const r = 44, c = 2 * Math.PI * r, gap = ix.legs.length > 1 ? 1.6 : 0;
  let acc = 0;
  return (
    <svg className="wp-ring" viewBox="0 0 120 120" width={size} height={size} role="img" aria-label="Allocation">
      <circle cx="60" cy="60" r={r} className="wp-ring__ground" />
      {ix.legs.map((l, i) => {
        const len = Math.max(0, l.weight * c - gap);
        const el = (
          <circle
            key={l.fundId}
            cx="60" cy="60" r={r}
            className={`wp-ring__arc${focus && focus !== l.fundId ? ' is-dim' : ''}`}
            style={{ stroke: legColor(i) }}
            strokeDasharray={`${len} ${c - len}`}
            strokeDashoffset={-acc}
            transform="rotate(-90 60 60)"
            onPointerEnter={onFocus ? () => onFocus(l.fundId) : undefined}
            onPointerLeave={onFocus ? () => onFocus(null) : undefined}
          />
        );
        acc += l.weight * c;
        return el;
      })}
      <text x="60" y="57" className="wp-ring__n">{ix.legs.length}</text>
      <text x="60" y="73" className="wp-ring__k">funds</text>
    </svg>
  );
}

/** A small line of a series (the card's), its last point marked. */
export function MiniLine({ s, w = 220, h = 48 }: { s: ReadonlyArray<{ t: number; v: number }> | null; w?: number; h?: number }) {
  if (!s || s.length < 2) return <span className="wp-mini is-empty" style={{ height: h }} aria-hidden="true" />;
  const pts = thin(s, 160);
  let lo = Infinity, hi = -Infinity;
  for (const p of pts) { lo = Math.min(lo, p.v); hi = Math.max(hi, p.v); }
  const span = hi - lo || 1;
  const xy = pts.map((p, i) => [(i / (pts.length - 1)) * w, h - 4 - ((p.v - lo) / span) * (h - 8)] as const);
  const d = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('');
  const up = pts[pts.length - 1]!.v >= pts[0]!.v;
  return (
    <svg className={`wp-mini ${up ? 'is-up' : 'is-down'}`} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ height: h }} aria-hidden="true">
      <path className="wp-mini__fill" d={`${d}L${w},${h}L0,${h}Z`} />
      <path className="wp-mini__line" d={d} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** One index as a card: who it is from, its funds and weights, a year of its basket, and the ways on. */
export function IndexCard({ ix, w, closes, mins, me, onBuy, yours }: {
  ix: VdIndex; w: WealthState; closes: Map<string, Close[]> | null; mins: ReadonlyMap<string, number>; me: string | null;
  onBuy: (ix: VdIndex) => void; yours?: string | null;
}) {
  const hist = closes ? basketHistory(ix, closes) : null;
  const y1 = changeOver(hist?.series ?? null, 365);
  const m1 = changeOver(hist?.series ?? null, 30);
  const yieldOnly = yieldOnlyIndex(ix, w.funds);
  const apy = yieldOnly ? basketApy(ix, w.quotes) : null;
  let min = 0;
  for (const l of ix.legs) min = Math.max(min, (mins.get(l.fundId) ?? 0) / l.weight);
  // An SSI token is one fund: its page is the fund's, with its basket.
  const soso = kindOf(ix) === 'sosovalue';
  const basket = useBasketRows(soso ? ix.legs[0]!.fundId : null);
  const open = () => openPath(soso ? WEALTH_PATH.fund(ix.legs[0]!.fundId) : WEALTH_PATH.index(ix.id));
  return (
    <article className="wv-card wp-card">
      <button type="button" className="wv-card__open" aria-label={`Open ${ix.name}`} onClick={open} />
      <header className="wp-card__head">
        <IndexCover ix={ix} size={40} />
        <span className="wp-card__k"><IndexBy ix={ix} me={me} /><IndexMarks ix={ix} funds={w.funds} size={20} /></span>
      </header>
      <div className="wp-card__t">
        <b>{ix.name}</b>
        {ix.line && <p>{ix.line}</p>}
      </div>
      {soso ? (
        <>
          <SegmentedBar size="sm" max={1} label="Basket" segments={(basket ?? []).map((r, i) => ({ id: r.key, value: r.weight, label: r.name, color: legColor(i) }))} />
          <ul className="wp-card__legs">
            {basket === null ? <li><span>{ix.legs[0]!.fundId === 'vUSSI' ? 'Hedged off chain; no basket on chain' : 'Reading its basket'}</span></li>
              : basket.slice(0, 4).map((r, i) => <li key={r.key}><i style={{ background: legColor(i) }} /><span>{r.name}</span><b>{`${Math.round(r.weight * 1000) / 10}%`}</b></li>)}
            {basket && basket.length > 4 && <li className="is-more"><span>{`${basket.length - 4} more`}</span></li>}
          </ul>
        </>
      ) : (
        <>
          <AllocBar ix={ix} funds={w.funds} />
          <ul className="wp-card__legs">
            {ix.legs.slice(0, 4).map((l, i) => <li key={l.fundId}><i style={{ background: legColor(i) }} /><span>{fundNameOf(w.funds, l.fundId)}</span><b>{`${Math.round(l.weight * 1000) / 10}%`}</b></li>)}
            {ix.legs.length > 4 && <li className="is-more"><span>{`${ix.legs.length - 4} more`}</span></li>}
          </ul>
        </>
      )}
      <div className="wp-card__figs">
        {yieldOnly ? (
          <div><span>Yield now, 7-day APY</span><b className="pos">{apy === null ? '—' : `${apy.toFixed(2)}%`}</b></div>
        ) : (
          <>
            <div><span>1 month</span><b className={tone(m1)}>{closes ? pct(m1) : <Skeleton className="wp-bone" />}</b></div>
            <div><span>1 year</span><b className={tone(y1)}>{closes ? pct(y1) : <Skeleton className="wp-bone" />}</b></div>
          </>
        )}
      </div>
      {!yieldOnly && <MiniLine s={hist?.series ?? null} h={40} />}
      <footer className="wp-card__foot">
        <small>{min > 0 ? `Minimum buy ${fmtUsd(Math.ceil(min), 0)}` : ' '}{yours ? <em>{yours}</em> : null}</small>
        <span className="wp-card__acts">
          <Button size="sm" variant="secondary" onClick={open}>Details</Button>
          <Button size="sm" variant="primary" onClick={() => onBuy(ix)}>Buy</Button>
        </span>
      </footer>
    </article>
  );
}

/** An SSI token's basket (server routes/wealthInfo.ts, from its own contract), top first; null while read or when it has none. */
export function useBasketRows(fundId: string | null): Array<{ key: string; name: string; weight: number }> | null {
  const lang = useLanguage();
  const r = useAsync(() => readInfo(fundId!, lang), [fundId, lang], { enabled: !!fundId });
  const h = r.data?.holdings;
  return h && h.rows.length ? h.rows.map((x) => ({ key: x.ticker ?? x.name, name: x.ticker ?? x.name, weight: x.weight })) : null;
}

/** "Create your own": the big plus. */
export function CreateCard({ compact }: { compact?: boolean }) {
  return (
    <a className={`wp-create${compact ? ' is-compact' : ''}`} href={WEALTH_PATH.newIndex} onClick={(e) => { if (e.button === 0 && !e.metaKey && !e.ctrlKey) { e.preventDefault(); openPath(WEALTH_PATH.newIndex); } }}>
      <span className="wp-create__plus" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" /></svg></span>
      <b>Create your own</b>
      <span>{INDEX_PUBLISHING ? 'Pick any SoDEX Wealth funds and their weights. Keep it to yourself or publish it for everyone.' : 'Pick any SoDEX Wealth funds and SSI tokens and their weights.'}</span>
      <StatusPill size="sm" tone="brand" icon="star" className="wp-create__early">Early access</StatusPill>
    </a>
  );
}

// --- the index's picture ----------------------------------------------------------------------------

const STOP = new Set(['and', 'the', 'of', 'a', 'an', 'und', 'der', 'die', 'das', 'with', 'for']);
/** Two letters for the drawn default: the first letters of the first two words, else the name's first two. */
export function monogram(name: string): string {
  const words = name.replace(/^ValueDesk\s+/i, '').split(/[\s&+/,.-]+/).filter((w) => /[\p{L}\p{N}]/u.test(w) && !STOP.has(w.toLowerCase()));
  // Letters and digits only: "Balanced (copy)" is BC, not B( (owner's screenshot 2026-11-28).
  const first = (w: string) => w.match(/[\p{L}\p{N}]/u)?.[0] ?? '';
  const pick = words.length > 1 ? `${first(words[0]!)}${first(words[1]!)}` : [...(words[0] ?? name)].filter((c) => /[\p{L}\p{N}]/u.test(c)).slice(0, 2).join('');
  return pick.toUpperCase() || 'IX';
}

/**
 * The index's picture: the one its maker uploaded (published: served by hash; a draft: its own data URL, checked), or
 * a default drawn from it: its first two funds' colours, its monogram and its allocation as a thin ring. Only ever an
 * <img src> of our own making or inline SVG of our own; never markup from anyone.
 */
export function IndexCover({ ix, size = 44, className }: { ix: Pick<VdIndex, 'name' | 'legs' | 'image' | 'picture'>; size?: number; className?: string }) {
  const src = (ix.image ? pictureUrl(ix.image) : null) ?? safeDataUrl(ix.picture);
  const r = Math.round(size * 0.28);
  if (src) return <img className={`wp-cover ${className ?? ''}`} src={src} width={size} height={size} alt="" loading="lazy" decoding="async" style={{ borderRadius: r }} />;
  const c = 2 * Math.PI * 36;
  let acc = 0;
  const id = `g${Math.abs([...ix.name].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) | 0, 7))}`;
  return (
    <svg className={`wp-cover is-drawn ${className ?? ''}`} width={size} height={size} viewBox="0 0 100 100" aria-hidden="true" style={{ borderRadius: r }}>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" style={{ stopColor: legColor(0) }} />
          <stop offset="1" style={{ stopColor: legColor(ix.legs.length > 1 ? 1 : 2) }} />
        </linearGradient>
      </defs>
      <rect width="100" height="100" fill={`url(#${id})`} />
      <rect width="100" height="100" fill="rgb(0 0 0 / 0.38)" />
      {ix.legs.map((l, i) => {
        const len = Math.max(0, l.weight * c - 2);
        const el = <circle key={l.fundId} cx="50" cy="50" r="36" fill="none" strokeWidth="5" style={{ stroke: legColor(i) }} strokeDasharray={`${len} ${c - len}`} strokeDashoffset={-acc} transform="rotate(-90 50 50)" opacity="0.95" />;
        acc += l.weight * c;
        return el;
      })}
      <text x="50" y="50" dy="0.36em" textAnchor="middle" fill="#fff" style={{ font: '600 30px var(--font-display, sans-serif)', letterSpacing: '-0.02em' }}>{monogram(ix.name)}</text>
    </svg>
  );
}

// --- how it can be bought ---------------------------------------------------------------------------

function Mark({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={`wp-mark ${ok ? 'is-ok' : 'is-no'}`} role="img" aria-label={label} title={label}>
      <svg viewBox="0 0 16 16" aria-hidden="true">{ok ? <path d="M3.5 8.5l3 3 6-7" /> : <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />}</svg>
    </span>
  );
}

const CHANNEL: Readonly<Record<string, string>> = { spot: 'Order book', batch: 'Batch', rfq: 'Maker quote', earn: 'Bridge' };

/**
 * The ways this index can be bought, each with a tick or a red cross, and the same per fund (owner 2026-11-28: "list
 * supported buy methods, turn an red X if something gets added thats not supported"). One time: every SoDEX Wealth
 * fund, each through its own channel (paused ones wait). Recurring: only funds SoDEX's recurring-buy contract lists.
 */
export function BuyMethods({ ix, funds, targets, actions }: {
  ix: Pick<VdIndex, 'legs'>; funds: readonly WealthFund[] | null; targets: readonly RecurringTarget[] | null; actions: ReadonlyMap<string, FundAction | null>;
}) {
  const rows = ix.legs.map((l) => {
    const f = funds?.find((x) => x.fundId === l.fundId) ?? null;
    const r = routeOf(f, actions.get(l.fundId) ?? null);
    const channel = f?.fundType === 'bridged_vault' ? 'earn' : f?.fundType === 'clob' ? 'spot' : f?.fundType === 'ssi-v2' ? 'rfq' : f?.fundType === 'escrow_vault' ? (r.route === 'rfq' ? 'rfq' : 'batch') : null;
    return { id: l.fundId, name: fundNameOf(funds, l.fundId), once: !!f && !f.comingSoon, soon: f?.comingSoon ?? null, recurring: targets ? targets.some((t) => t.fund.fundId === l.fundId) : null, channel, paused: r.route === 'closed' && !!f, why: r.why };
  });
  const once = rows.every((r) => r.once);
  const recurring = targets ? rows.every((r) => r.recurring) : null;
  const notRec = rows.filter((r) => r.recurring === false).map((r) => r.name);
  const paused = rows.filter((r) => r.paused && !r.soon);
  return (
    <div className="wp-methods">
      <ul className="wp-methods__top">
        <li><Mark ok={once} label={once ? 'Supported' : 'Not supported'} /><span><b>One time</b><small>{once ? 'Every fund, each through its own channel' : `Coming soon on SoDEX: ${rows.filter((r) => !r.once).map((r) => r.name).join(', ')}`}</small></span></li>
        <li>
          {recurring === null ? <span className="wp-mark is-wait" aria-hidden="true" /> : <Mark ok={recurring} label={recurring ? 'Supported' : 'Not supported'} />}
          <span><b>Recurring</b><small>{recurring === null ? 'Reading SoDEX’s list' : recurring ? 'One SoDEX plan per fund, one schedule' : `Not on SoDEX’s recurring list: ${notRec.join(', ')}`}</small></span>
        </li>
      </ul>
      {rows.length > 0 && (
        <div className="wp-methods__t" role="table" aria-label="Buy methods per fund">
          <div className="wp-methods__h" role="row"><span role="columnheader">Fund</span><span role="columnheader">One time</span><span role="columnheader">Recurring</span><span role="columnheader">Channel</span></div>
          {rows.map((r) => (
            <div key={r.id} className={`wp-methods__r${r.recurring === false || !r.once ? ' is-bad' : ''}`} role="row">
              <span role="cell">{r.name}</span>
              <span role="cell"><Mark ok={r.once} label={r.once ? 'One time: yes' : 'One time: no'} /></span>
              <span role="cell">{r.recurring === null ? '…' : <Mark ok={r.recurring} label={r.recurring ? 'Recurring: yes' : 'Recurring: no'} />}</span>
              <span role="cell" title={r.soon ?? (r.paused ? r.why ?? undefined : undefined)}>{r.soon ? 'Coming soon' : r.channel ? CHANNEL[r.channel] : '—'}{r.paused && !r.soon && <em> · paused</em>}</span>
            </div>
          ))}
        </div>
      )}
      {paused.length > 0 && <PausedFunds ids={paused.map((r) => r.id)} funds={funds} actions={actions} />}
    </div>
  );
}

// --- paused funds, drawn ----------------------------------------------------------------------------

function splitLeft(ms: number): Array<[number, string]> {
  const m = Math.max(0, Math.ceil(ms / 60_000));
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  return d ? [[d, 'd'], [h, 'h'], [mm, 'min']] : h ? [[h, 'h'], [mm, 'min']] : [[mm, 'min']];
}

/**
 * The funds SoDEX does not trade right now, as a clock (owner 2026-11-28: "show this as graphics like trading times"):
 * grouped by when they resume, each group a countdown in days, hours and minutes, the reopening time, a bar of the
 * pause's last 48 hours, and the funds' marks. sodex.com's words: "Trading temporarily unavailable".
 */
export function PausedFunds({ ids, funds, actions }: { ids: readonly string[]; funds: readonly WealthFund[] | null; actions: ReadonlyMap<string, FundAction | null> }) {
  const now = useNow(30_000);
  const groups = new Map<number, string[]>();
  for (const id of ids) {
    const a = actions.get(id);
    if (a?.kind !== 'closed') continue;
    const at = a.nextAt ? a.nextAt * 1000 : 0;
    groups.set(at, [...(groups.get(at) ?? []), id]);
  }
  if (!groups.size) return null;
  return (
    <div className="wp-paused" role="status">
      {[...groups.entries()].sort((a, b) => a[0] - b[0]).map(([at, list]) => {
        const left = at ? at - now : null;
        const why = (actions.get(list[0]!) as Extract<FundAction, { kind: 'closed' }>).why;
        const share = left !== null ? Math.max(0, Math.min(1, 1 - left / (48 * 3_600_000))) : 0;
        return (
          <div key={at} className="wp-paused__g">
            <div className="wp-paused__top">
              <span className="wp-paused__ic" aria-hidden="true"><svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="7.5" /><path d="M10 6v4.2l2.6 1.6" /></svg></span>
              <span className="wp-paused__t"><b>Trading temporarily unavailable</b><small title={why}>{at ? `Resumes ${new Date(at).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : why}</small></span>
              {left !== null && (
                <span className="wp-paused__clock" aria-label={resumingIn(at / 1000, now) ?? undefined}>
                  {splitLeft(left).map(([n, u]) => <span key={u}><b>{String(n).padStart(2, '0')}</b><i>{u}</i></span>)}
                </span>
              )}
            </div>
            {left !== null && <span className="wp-paused__bar" aria-hidden="true"><i style={{ width: `${share * 100}%` }} /></span>}
            <span className="wp-paused__funds">
              {list.map((id) => (
                <span key={id} className="wp-paused__f"><CoinIcon coin={fundIconOf(funds?.find((f) => f.fundId === id), id)} size={16} />{fundNameOf(funds, id)}</span>
              ))}
            </span>
          </div>
        );
      })}
    </div>
  );
}
