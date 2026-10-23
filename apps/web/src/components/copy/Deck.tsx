/**
 * The Copy page's hero: the best traders of both kinds on a wheel.
 *
 * The cards sit around a circle; the front of it shows five, the rest wait
 * behind and rise into view from the sides as the wheel turns. Drag it (mouse,
 * pen or finger) to turn it - a flick keeps it turning for a moment, then it
 * settles on the nearest card - or use the arrow keys. On its own it moves on
 * by ONE card every few seconds, gliding there, not while the pointer or the
 * focus is on it and not with reduced motion. A card that was clicked, not
 * dragged, opens its trader.
 *
 * Every frame of a turn writes the cards' transforms straight to their
 * elements: a drag is sixty updates a second, and none of them needs React.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import { shortAddr } from '../../format';
import { VENUE_BRAND } from '../venueBrand';
import { VENUE_LABEL, type BoardWindow, type TraderRow } from '../../vsApi';
import type { Scored } from './gridModel';
import { Avatar, CoinRow, ScoreMeter, Spark, WINDOW_SHORT, useTraderPeek } from './TraderCard';
import { fmtSignedPct, fmtSignedUsd } from './setup';
import { wheelOffset, wheelPlace } from './wheel';

/** How often the wheel moves on by one card, and how long that glide takes. */
const DEAL_MS = 3600;
const GLIDE_MS = 700;
/** Pixels of drag per card. */
const DRAG_PX = 170;
/** A press that moved less than this is a click. */
const CLICK_PX = 6;

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const reducedMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const keyOf = (r: Pick<TraderRow, 'venue' | 'address'>) => `${r.venue}:${r.address.toLowerCase()}`;

export function Deck({ picks, w, total, loading, onOpen }: {
  picks: readonly Scored[];
  w: BoardWindow;
  total: number;
  loading: boolean;
  onOpen: (r: TraderRow) => void;
}) {
  const n = picks.length;
  const cards = useRef<Array<HTMLElement | null>>([]);
  const at = useRef(0);
  const anim = useRef<number | null>(null);
  const drag = useRef<{ x: number; at: number; moved: boolean; vx: number; t: number } | null>(null);
  const [front, setFront] = useState(0);
  const register = useCallback((i: number, e: HTMLElement | null) => { cards.current[i] = e; }, []);
  const [held, setHeld] = useState(false);

  /** Place every card for the wheel at `at`. */
  const paint = useCallback(() => {
    const now = at.current;
    for (let i = 0; i < n; i++) {
      const el = cards.current[i];
      if (!el) continue;
      const d = wheelOffset(i, now, n);
      const p = wheelPlace(d);
      el.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px) rotate(${p.r.toFixed(2)}deg) scale(${p.s.toFixed(3)})`;
      el.style.opacity = p.o.toFixed(3);
      el.style.zIndex = String(p.z);
      el.style.visibility = p.o < 0.01 ? 'hidden' : 'visible';
      el.tabIndex = Math.abs(d) < 0.5 ? 0 : -1;
    }
    const f = ((Math.round(now) % n) + n) % n;
    setFront((x) => (x === f ? x : f));
  }, [n]);

  useLayoutEffect(() => { paint(); }, [paint, picks]);

  const stop = () => { if (anim.current !== null) cancelAnimationFrame(anim.current); anim.current = null; };

  /** Turn to `to` (in cards), gliding unless motion is reduced. */
  const glide = useCallback((to: number, ms = GLIDE_MS) => {
    stop();
    if (reducedMotion() || ms <= 0) { at.current = to; paint(); return; }
    const from = at.current;
    const t0 = performance.now();
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / ms);
      at.current = from + (to - from) * ease(k);
      paint();
      anim.current = k < 1 ? requestAnimationFrame(step) : null;
    };
    anim.current = requestAnimationFrame(step);
  }, [paint]);

  // One card on, every few seconds.
  useEffect(() => {
    if (n < 2 || held || reducedMotion()) return;
    // Not in a hidden tab: its animation frames are paused, so a glide would only wait there.
    const t = setInterval(() => { if (!drag.current && !document.hidden) glide(Math.round(at.current) + 1); }, DEAL_MS);
    return () => clearInterval(t);
  }, [n, held, glide]);
  useEffect(() => stop, []);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || n < 2) return;
    stop();
    drag.current = { x: e.clientX, at: at.current, moved: false, vx: 0, t: performance.now() };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const g = drag.current;
    if (!g) return;
    const dx = e.clientX - g.x;
    if (Math.abs(dx) > CLICK_PX) g.moved = true;
    const now = performance.now();
    const next = g.at - dx / DRAG_PX;
    // Velocity in cards per ms, smoothed, for the fling.
    const dt = Math.max(1, now - g.t);
    g.vx = 0.8 * ((next - at.current) / dt) + 0.2 * g.vx;
    g.t = now;
    at.current = next;
    paint();
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const g = drag.current;
    if (!g) return;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (!g.moved) {
      // A click: whatever card is under the pointer opens.
      const hit = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('[data-deck-i]');
      const i = hit ? Number(hit.dataset.deckI) : -1;
      if (i >= 0 && picks[i]) onOpen(picks[i]!.row);
      return;
    }
    // A flick carries on for a moment, then settles on a card.
    const coast = Math.max(-3, Math.min(3, g.vx * 260));
    glide(Math.round(at.current + coast), 520 + Math.abs(coast) * 140);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowRight') { e.preventDefault(); glide(Math.round(at.current) + 1, 420); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); glide(Math.round(at.current) - 1, 420); }
    else if ((e.key === 'Enter' || e.key === ' ') && picks[front]) { e.preventDefault(); onOpen(picks[front]!.row); }
  };

  if (!n) {
    return (
      <div className="cpy-deck" aria-hidden="true">
        {[-1, 1, 0].map((d) => {
          const p = wheelPlace(d);
          return <span key={d} className="cpy-deck__card cpy-deck__card--ghost" style={{ transform: `translate(${p.x}px, ${p.y}px) rotate(${p.r}deg) scale(${p.s})`, zIndex: p.z }} />;
        })}
        {!loading && <span className="cpy-deck__chip cpy-deck__chip--count">No trader on the boards yet</span>}
      </div>
    );
  }
  const lead = picks[front] ?? picks[0]!;
  return (
    <div
      className="cpy-deck is-live"
      role="group"
      aria-roledescription="carousel"
      aria-label="Top picks to copy or counter. Drag, or use the arrow keys, to turn."
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={() => setHeld(false)}
    >
      <div className="cpy-deck__ring">
        {picks.map((s, i) => (
          <DeckCard key={keyOf(s.row)} s={s} w={w} i={i} register={register} />
        ))}
      </div>
      <span className={`cpy-deck__chip cpy-deck__chip--who cpy-deck__chip--${lead.score.kind}`}>
        <Avatar address={lead.row.address} size={16} />
        <span>@{shortAddr(lead.row.address)}</span>
        <b>{lead.score.kind === 'copy' ? 'to copy' : 'to counter'}</b>
      </span>
      <span className="cpy-deck__chip cpy-deck__chip--count">
        <i className="cpy-deck__dot cpy-deck__dot--copy" />
        <i className="cpy-deck__dot cpy-deck__dot--counter" />
        {total} traders to copy or counter now
      </span>
    </div>
  );
}

function DeckCard({ s, w, i, register }: { s: Scored; w: BoardWindow; i: number; register: (i: number, e: HTMLElement | null) => void }) {
  const { ref, peek, loading } = useTraderPeek(s.row, w);
  const setRef = useCallback((e: HTMLElement | null) => { ref(e); register(i, e); }, [ref, register, i]);
  const pnl = s.row.pnl[w] ?? null;
  const kind = s.score.kind;
  return (
    <button
      ref={setRef}
      type="button"
      className={`cpy-deck__card cpy-card--${kind}`}
      data-deck-i={i}
      tabIndex={-1}
      // The deck opens a card on a click it did not turn into a drag (Deck's pointer handlers).
      onClick={(e) => e.preventDefault()}
      aria-label={`${kind === 'copy' ? 'Copy' : 'Counter-trade'} pick ${shortAddr(s.row.address)} on ${VENUE_LABEL[s.row.venue]}`}
    >
      <span className="cpy-glow" aria-hidden="true">
        <span className="cpy-glow__rim"><span className="cpy-glow__glare" /></span>
      </span>
      <span className="cpy-deck__head">
        <Avatar address={s.row.address} size={26} />
        <span className="cpy-deck__who">
          <span className="cpy-deck__addr">{shortAddr(s.row.address)}</span>
          <span className="cpy-venue" style={{ '--venue': VENUE_BRAND[s.row.venue] } as CSSProperties}>{VENUE_LABEL[s.row.venue]}</span>
        </span>
        <span className={`cpy-deck__tag cpy-deck__tag--${kind}`}>{kind === 'copy' ? 'Copy' : 'Counter'}</span>
      </span>
      <span className={`cpy-deck__big ${s.score.roi !== null && s.score.roi < 0 ? 'neg' : 'pos'}`}>{fmtSignedPct(s.score.roi, 1)}</span>
      <span className="cpy-deck__lbl">Return {WINDOW_SHORT[w]} · {fmtSignedUsd(pnl, 0)}</span>
      <Spark values={peek?.spark ?? null} loading={loading} className="cpy-deck__spark" />
      <span className="cpy-deck__foot">
        <ScoreMeter s={s.score} />
        <CoinRow assets={s.row.assets} max={3} />
      </span>
    </button>
  );
}
