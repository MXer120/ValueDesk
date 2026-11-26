/**
 * The pieces the new Scan versions share. Built from the app's own parts: the Bots kit (search field, buttons,
 * segmented switch, pills, empty states), the copy page's Avatar and Copy / Counter buttons, the portfolio's chart
 * (EquityCurve, its clean mode), the band the portfolio and the original Scan page carry, VenueLogo and CoinIcon.
 *
 * Every figure is the venue's (TraderProfile, VsPosition) or a sum or ratio of those, called derived where it shows.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, Icon, IconButton, SearchField, Segmented, StatusPill, type Tone } from '../../bots/kit/kit';
import { Avatar, CopyButton, fmtAgo } from '../../copy/TraderCard';
import { isCopyable } from '../../copy/gridModel';
import { NotCopyableNote, useNotCopyable } from '../../copy/useNotCopyable';
import { PhoneActionBar } from '../../bots/PhoneActionBar';
import { EquityCurve, type CurveWindow } from '../../portfolio/parts';
import { PORTFOLIO_PANELS } from '../../Portfolio';
import { VenueLogo } from '../../VenueLogo';
import { CoinIcon } from '../../CoinIcon';
import { DASH, MINUS, fmtDateTime, fmtPrice, fmtQty, fmtUsd, shortAddr } from '../../../format';
import { fmtNum, fmtPlain } from '../../../numStyle';
import { signedPct, signedUsd } from '../../accountTables/cells';
import { openPath } from '../../../nav';
import { useAddressMask, useMask } from '../../../privacy';
import { aliasFor, saveAlias } from '../../../dashboard/scanAliases';
import { VENUE_LABEL, type TraderProfile, type Venue, type VsPosition, type Window } from '../../../vsApi';
import { HL_WINDOWS, HL_WINDOW_LABEL, windowCurve } from '../hlModel';
import type { VenueCard } from '../addressVenues';
import { VenueBand } from '../VenueBand';
import { baseOf, liqDistance, moveOf, roeOf, standingOf, STANDING_TEXT, type Standing } from './model';
import type { VenueView } from './flow';

export const cx = (...xs: Array<string | false | null | undefined>) => xs.filter(Boolean).join(' ');
export const num = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);
export const tone = (v: number | null | undefined): '' | 'pos' | 'neg' => (!num(v) || v === 0 ? '' : v > 0 ? 'pos' : 'neg');
export const ago = (ms: number | null | undefined) => (num(ms) && ms > 0 ? fmtAgo(ms) : DASH);
/** Under half a cent a dollar figure shows as $0.00: it is neither a gain nor a loss on screen. */
const cents = (v: number) => (Math.abs(v) < 0.005 ? 0 : v);
/** Money to the cent below $10k, whole above (fmtUsd's own rule), with a sign. */
export const signed = (v: number | null | undefined) => (num(v) ? `${cents(v) > 0 ? '+' : ''}${fmtUsd(cents(v))}` : DASH);
/** `tone` for a dollar figure: one that shows as $0.00 is not coloured. */
export const toneUsd = (v: number | null | undefined): '' | 'pos' | 'neg' => tone(num(v) ? cents(v) : v);

export const STANDING_TONE: Record<Standing, Tone> = {
  loading: 'neutral', active: 'positive', inactive: 'neutral', none: 'neutral', unknown: 'warning',
};

/* ------------------------------------------------------------------ search ----- */

export function ScanSearch({ seed, connected, onSearch, error, size = 'sm', className, placeholder }: {
  seed?: string | null;
  connected: string | null;
  onSearch: (input: string) => void;
  error?: string | null;
  size?: 'sm' | 'md';
  className?: string;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState(seed ?? '');
  useEffect(() => { setDraft(seed ?? ''); }, [seed]);
  return (
    <form
      role="search"
      className={cx('sx-search', `is-${size}`, className)}
      onSubmit={(e) => {
        e.preventDefault();
        onSearch(draft);
      }}
    >
      <div className="sx-search__row">
        <SearchField value={draft} onChange={setDraft} placeholder={placeholder ?? '0x… address or saved alias'} label="Wallet address or saved alias" className="sx-search__f" />
        {connected && (
          <Button variant="secondary" size={size} title="Scan the connected wallet" onClick={() => { setDraft(connected); onSearch(connected); }}>Me</Button>
        )}
        <Button type="submit" variant="primary" size={size} disabled={!draft.trim()}>Search</Button>
      </div>
      {error && <p className="sx-search__err" role="alert">{error}</p>}
    </form>
  );
}

/** The aliases saved in this browser (the original page's alias box writes the same store). */
export function savedWallets(): Array<{ address: string; name: string }> {
  try {
    const m = JSON.parse(localStorage.getItem('scan-aliases') || '{}') as Record<string, string>;
    return Object.entries(m).map(([address, name]) => ({ address, name })).sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

/* ---------------------------------------------------------------- identity ----- */

const CopyGlyph = () => (
  <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="5.5" y="5.5" width="8" height="8" rx="1.8" /><path d="M10.5 3.2A1.7 1.7 0 0 0 8.9 2H4a2 2 0 0 0-2 2v4.9a1.7 1.7 0 0 0 1.2 1.6" />
  </svg>
);
const PenGlyph = () => (
  <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M10.6 2.9 13.1 5.4 5.6 12.9 2.6 13.4 3.1 10.4z" />
  </svg>
);

/** The address, its copy button and the name saved for it, which can be changed in place. */
export function WalletName({ address, className }: { address: string; className?: string }) {
  const maskAddr = useAddressMask();
  const [alias, setAlias] = useState(() => aliasFor(address));
  const [edit, setEdit] = useState(false);
  const [draft, setDraft] = useState(alias);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const a = aliasFor(address);
    setAlias(a);
    setDraft(a);
    setEdit(false);
  }, [address]);
  const copy = () => {
    void navigator.clipboard?.writeText(address).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    }, () => {});
  };
  if (edit) {
    return (
      <form
        className={cx('sx-name is-edit', className)}
        onSubmit={(e) => {
          e.preventDefault();
          saveAlias(address, draft);
          setAlias(draft.trim());
          setEdit(false);
        }}
      >
        <input className="tf-input sx-name__in" value={draft} autoFocus maxLength={40} onChange={(e) => setDraft(e.target.value)} placeholder="Name this wallet" aria-label="Name for this wallet" spellCheck={false} />
        <Button type="submit" variant="primary" size="sm">Save</Button>
        <Button variant="quiet" size="sm" onClick={() => { setDraft(alias); setEdit(false); }}>Cancel</Button>
      </form>
    );
  }
  return (
    <div className={cx('sx-name', className)}>
      <span className="sx-name__t">
        {alias ? <b className="sx-name__alias">{alias}</b> : <b className="sx-name__addr" title={maskAddr(address)}>{maskAddr(shortAddr(address))}</b>}
        {alias && <span className="sx-name__sub" title={maskAddr(address)}>{maskAddr(shortAddr(address))}</span>}
      </span>
      <button type="button" className="sx-ibtn" title={copied ? 'Copied' : 'Copy address'} aria-label="Copy address" onClick={copy}>
        {copied ? <Icon name="check" size={13} /> : <CopyGlyph />}
      </button>
      <button type="button" className="sx-ibtn" title={alias ? 'Rename' : 'Name this wallet'} aria-label={alias ? 'Rename this wallet' : 'Name this wallet'} onClick={() => setEdit(true)}>
        <PenGlyph />
      </button>
    </div>
  );
}

/** Display name, leaderboard rank and style tags, as the venue publishes them. Nothing when it publishes none. */
export function TraderTags({ p }: { p: TraderProfile | null | undefined }) {
  const s = p?.summary;
  if (!s) return null;
  const tags = s.tags ?? [];
  if (!s.label && !num(s.rank) && !tags.length) return null;
  return (
    <span className="sx-tags">
      {s.label && <StatusPill size="sm" tone="brand" title="The display name this trader set on the venue.">{s.label}</StatusPill>}
      {num(s.rank) && <StatusPill size="sm" title={`Rank on ${VENUE_LABEL[s.venue]}'s 30-day PnL leaderboard.`}>#{fmtPlain(s.rank)} on {VENUE_LABEL[s.venue]}</StatusPill>}
      {tags.map((t) => <StatusPill key={t} size="sm">{t.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase())}</StatusPill>)}
    </span>
  );
}

export { Avatar };

/* ------------------------------------------------------------ venue switch ----- */

/** One venue as a switch option: its logo, its name, and a dot when it is active (the title says which quiet it is). */
export function VenueOption({ card, equity }: { card: VenueCard; equity?: boolean }) {
  const st = standingOf(card);
  const mask = useMask('equity');
  return (
    <span className={cx('sx-vopt', `is-${st}`)} title={STANDING_TEXT[st]}>
      <VenueLogo venue={card.venue} size={16} />
      <span>{VENUE_LABEL[card.venue]}</span>
      {equity && st === 'active' && num(card.equity) && <span className="sx-vopt__eq">{mask(compactUsd(card.equity))}</span>}
      {st === 'active' && <i className="sx-dot" aria-label="active" />}
      {st === 'loading' && <i className="sx-dot is-wait" aria-hidden="true" />}
    </span>
  );
}

export function VenueSwitch({ cards, value, onPick, equity, size = 'md', className }: {
  cards: VenueCard[];
  value: Venue | null;
  onPick: (v: Venue) => void;
  equity?: boolean;
  size?: 'sm' | 'md';
  className?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  // A phone shows two or three venues at a time: the open one is scrolled into the strip.
  useEffect(() => {
    const strip = box.current?.querySelector<HTMLElement>('.tf-seg');
    const on = strip?.querySelector<HTMLElement>('[data-on="1"]');
    if (!strip || !on || strip.scrollWidth <= strip.clientWidth) return;
    const left = on.offsetLeft - (strip.clientWidth - on.offsetWidth) / 2;
    strip.scrollTo({ left: Math.max(0, left) });
  }, [value]);
  return (
    <div ref={box} className={cx('sx-vswitchbox', className)}>
      <Segmented<Venue>
        options={cards.map((c) => ({ value: c.venue, label: <VenueOption card={c} equity={equity} /> }))}
        value={(value ?? '') as Venue}
        onChange={onPick}
        label="Venue"
        size={size}
        className="sx-vswitch"
      />
    </div>
  );
}

/** $1.2K / $143K / $2.83M: a venue's balance at a glance (the exact figure is in the views below). */
export function compactUsd(v: number): string {
  const a = Math.abs(v);
  if (a < 1000) return fmtUsd(v, 0);
  return `${v < 0 ? MINUS : ''}$${fmtNum(a, { notation: 'compact', maximumFractionDigits: a >= 100_000 && a < 1e6 ? 0 : 1 })}`;
}

/* ------------------------------------------------------------ copy actions ----- */

export function useCopyGo(address: string | null, venue: Venue | null) {
  return (direction: 'copy' | 'counter') => {
    if (!address || !venue) return;
    openPath(`/copy?address=${encodeURIComponent(address)}&venue=${venue}&direction=${direction}`);
  };
}

/**
 * Copy and Counter-trade for the venue on screen (the copy page's own buttons, opening its setup), the line of
 * this trader's markets a copy could not follow, or, for a venue a copy cannot follow, that sentence instead.
 */
export function CopyActions({ address, venue, profile, size = 'md', note = true, className }: {
  address: string;
  venue: Venue;
  profile: TraderProfile | null | undefined;
  size?: 'md' | 'lg';
  note?: boolean;
  className?: string;
}) {
  const copyable = isCopyable(venue);
  const n = useNotCopyable({
    enabled: copyable && note,
    venue: venue === 'sodex' ? 'sodex' : 'hyperliquid',
    positions: profile?.positions ?? null,
    positionsAt: profile?.updatedAt ?? null,
    fills: null,
  });
  const go = useCopyGo(address, venue);
  if (!copyable) {
    return <StatusPill className={cx('sx-nocopy', className)} title="The copy engine follows SoDEX and Hyperliquid traders.">Copying {VENUE_LABEL[venue]} traders is not supported yet</StatusPill>;
  }
  return (
    <span className={cx('sx-copy', className)}>
      {note && <NotCopyableNote n={n} className="sx-copy__note" />}
      <CopyButton kind="counter" size={size} label="Counter-trade" title="Take the other side of every trade" onClick={() => go('counter')} />
      <CopyButton kind="copy" size={size} label="Copy trader" title={`Set up copying ${VENUE_LABEL[venue]} trades from this address`} onClick={() => go('copy')} />
    </span>
  );
}

/** The same two buttons fixed above the phone's tab bar (the Bots setup's bar), so they are always in reach. */
export function PhoneCopyBar({ address, venue, label }: { address: string; venue: Venue | null; label: string }) {
  const go = useCopyGo(address, venue);
  if (!venue || !isCopyable(venue)) return null;
  return (
    <PhoneActionBar step={label}>
      <CopyButton kind="counter" label="Counter" title="Take the other side of every trade" onClick={() => go('counter')} />
      <CopyButton kind="copy" label="Copy trader" title={`Set up copying ${VENUE_LABEL[venue]} trades from this address`} onClick={() => go('copy')} />
    </PhoneActionBar>
  );
}

/* ------------------------------------------------------------------ windows ----- */

export function WindowSwitch({ win, onWin, size = 'sm', label = 'Window' }: { win: Window; onWin: (w: Window) => void; size?: 'sm' | 'md'; label?: string }) {
  return (
    <Segmented<Window>
      options={HL_WINDOWS.map((w) => ({ value: w, label: HL_WINDOW_LABEL[w] }))}
      value={win}
      onChange={onWin}
      label={label}
      size={size}
      className="sx-wseg"
    />
  );
}

/* ------------------------------------------------------------------- chart ----- */

const atLevel = (w: CurveWindow): CurveWindow => ({ ...w, points: w.points.map((p) => ({ t: p.t, v: p.v + w.baseline })) });

/**
 * The venue's own series for one window, in the portfolio's clean chart: PnL against the window's start, or the
 * account value as a level. The reason in its place when there is nothing to draw.
 */
export function ScanCurve({ view, field, win, className }: { view: VenueView; field: 'pnl' | 'accountValue'; win: Window; className?: string }) {
  const p = view.trader.data;
  const why = blockedWhy(view, field === 'pnl' ? 'PnL history' : 'account value history');
  const curve = p && !why ? windowCurve(p.equity, win, field) : null;
  return (
    <div className={cx('sx-chart', className)}>
      {why ? <ChartNote>{why}</ChartNote>
        : curve ? (
          <EquityCurve
            win={field === 'accountValue' ? atLevel(curve) : curve}
            tone={field === 'accountValue' ? 'equity' : 'pnl'}
            level={field === 'accountValue'}
            compactAxis
            clean
            privacy={field === 'accountValue' ? 'funds' : 'pnl'}
          />
        )
        : <ChartNote>{`No ${field === 'pnl' ? 'PnL' : 'account value'} history in ${win === 'all' ? 'this history' : HL_WINDOW_LABEL[win]}.`}</ChartNote>}
    </div>
  );
}

export function ChartNote({ children }: { children: ReactNode }) {
  return <div className="sx-chart__note"><p>{children}</p></div>;
}

const listOf = (xs: string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/** The line under "No account on any venue": which venues could not answer, or that every one was checked. */
export function noAccountLine(cards: readonly VenueCard[]): string {
  const unread = cards.filter((c) => c.unknown).map((c) => VENUE_LABEL[c.venue]);
  if (unread.length) return `${listOf(unread)} could not answer. Open ${unread.length === 1 ? 'it' : 'one'} above to ask again.`;
  return `Checked ${listOf(cards.map((c) => VENUE_LABEL[c.venue]))}.`;
}

/** Why the venue view has nothing to show yet, or null. */
export function blockedWhy(view: VenueView, what: string): string | null {
  const t = view.trader;
  const name = view.venue ? VENUE_LABEL[view.venue] : 'This venue';
  if (!view.address || !view.venue) return null;
  if (view.historyNote && what !== 'positions') return view.historyNote;
  if (t.unavailable) return `${name} data is not available yet.`;
  if (t.error && !t.data) return `${name} account couldn't load. It is retried by itself.`;
  if (!t.settled) return 'Loading…';
  if (!t.data) return `No ${name} account for this address.`;
  return null;
}

/* ---------------------------------------------------------------- positions ----- */

const px = (v: number | null | undefined) => (num(v) ? fmtPrice(v) : DASH);

/** A position as a card: market, side and leverage, value and PnL, entry to mark, how far the liquidation price is. */
export function PositionCard({ p, venues, compact }: { p: VsPosition; venues?: Venue[]; compact?: boolean }) {
  const maskPnl = useMask('pnl');
  const roe = roeOf(p);
  const dist = liqDistance(p);
  const move = moveOf(p);
  const near = dist !== null && dist < 0.1;
  const coin = baseOf(p.symbol);
  return (
    <article className={cx('sx-pos', compact && 'is-compact')}>
      <header className="sx-pos__h">
        <CoinIcon coin={coin} size={compact ? 22 : 26} />
        <span className="sx-pos__m">
          <b title={p.symbol}>{p.symbol.replace(/^[a-z]+:/, '')}</b>
          <span className="sx-pos__tags">
            <StatusPill size="sm" tone={p.side === 'long' ? 'positive' : 'negative'}>{p.side === 'long' ? 'Long' : 'Short'}</StatusPill>
            {num(p.leverage) && <span className="sx-pos__lev">{fmtPlain(p.leverage)}x</span>}
            {p.marginMode && <span className="sx-pos__mode">{p.marginMode === 'isolated' ? 'Isolated' : 'Cross'}</span>}
          </span>
        </span>
        {venues && venues.length > 0 && (
          <span className="sx-pos__venues" title={venues.map((v) => VENUE_LABEL[v]).join(' · ')}>
            {venues.map((v) => <VenueLogo key={v} venue={v} size={16} />)}
          </span>
        )}
      </header>
      <div className="sx-pos__money">
        <span>
          <small>Value</small>
          <b>{fmtUsd(Math.abs(p.notional))}</b>
        </span>
        <span className="is-r">
          <small>Unrealized PnL</small>
          <b className={toneUsd(p.uPnl)}>{maskPnl(signedUsd(p.uPnl))}{roe !== null && <i className={tone(roe)}> {maskPnl(signedPct(roe, 1))}</i>}</b>
        </span>
      </div>
      <dl className="sx-pos__px">
        <div><dt>Size</dt><dd>{num(p.size) ? `${fmtQty(p.size)} ${coin}` : DASH}</dd></div>
        <div><dt>Entry</dt><dd>{px(p.entryPx)}</dd></div>
        <div><dt>Mark</dt><dd>{px(p.markPx)}{move !== null && <i className={tone(move)}> {signedPct(move, 1)}</i>}</dd></div>
        <div>
          <dt title="How far the mark can move against the position before the venue's liquidation price. Derived from the two prices.">Liq.</dt>
          <dd>
            {px(p.liqPx)}
            {dist !== null && <i className={near ? 'is-near' : undefined} title={near ? 'Under 10% from the mark (our threshold, not the venue’s).' : undefined}> {fmtPlain(Number((dist * 100).toFixed(dist < 0.1 ? 1 : 0)))}% away</i>}
          </dd>
        </div>
      </dl>
    </article>
  );
}

/* --------------------------------------------------------------------- band ----- */

const BAND = PORTFOLIO_PANELS.find((p) => p.id === 'band')!;

/**
 * Positions, orders, balances and every history: the band the original page and the portfolio carry. SoDEX's is the
 * portfolio's own (its account reads); every other venue's is VenueBand over the venue's public reads.
 */
export function HistoryBand({ view, className }: { view: VenueView; className?: string }) {
  if (!view.venue || !view.address) return null;
  return (
    <div className={cx('pf scan sx-band', className)}>
      {view.venue === 'sodex' ? BAND.render(view.sodex, 'lg') : <VenueBand hl={view.hl} />}
    </div>
  );
}

/* ----------------------------------------------------------- small figures ----- */

/** A label over a figure. `tag` says where it came from when that is not the venue's own figure. */
export function Fig({ label, value, cls, tag, title, sub, className }: {
  label: ReactNode;
  value: ReactNode;
  cls?: string;
  tag?: 'derived' | 'est.';
  title?: string;
  sub?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx('sx-fig', className)} title={title}>
      <span className="sx-fig__l">{label}{tag && <span className="sx-fig__tag">{tag}</span>}</span>
      <b className={cx('sx-fig__v', cls)}>{value}</b>
      {sub && <span className="sx-fig__s">{sub}</span>}
    </div>
  );
}

export const lastActiveText = (ms: number | null | undefined) => (num(ms) && ms > 0 ? `${ago(ms)}` : DASH);
export const lastActiveTitle = (ms: number | null | undefined) => (num(ms) && ms > 0 ? fmtDateTime(ms) : 'The venue reported no fill time.');

export function StandingPill({ card, size = 'sm' }: { card: VenueCard; size?: 'sm' | 'md' }) {
  const st = standingOf(card);
  return <StatusPill size={size} tone={STANDING_TONE[st]} dot={st === 'active'} pulse={st === 'loading'}>{STANDING_TEXT[st]}</StatusPill>;
}

export { IconButton };
