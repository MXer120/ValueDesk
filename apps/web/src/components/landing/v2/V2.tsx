/**
 * Landing version 2 (/home/2), owner 2026-11-23: "Swim with the whales" - a scroll story built to convert. The owner's
 * dotted humpback (shared.tsx SwimmingWhale) swims through the page as it scrolls, behind the content, in deep ink lit
 * from above with drifting dust.
 *
 *   1. hero: start with $5 (live startFromText), two CTAs, the trust row;
 *   2. a pinned scene: connect -> sign terms, fee, key -> bot running, lit by scroll progress;
 *   3. where your money goes: a flow drawing (no amounts) + what the trading key can and cannot do;
 *   4. live proof: markets, hourly volume, SoDEX's maker fee, the busiest markets and their maker cost per $1M;
 *   5. fees: the lowest bot fee WITH its condition, the new wallet's fee and the ladder; copy ladder; analytics free;
 *   6. FAQ; 7. final CTA, footer and the risk line.
 *
 * Every figure is live (useLiveDesk) or a constant from shared.tsx FEES. Drawings carry no numbers. Loops pause off
 * screen and stop for prefers-reduced-motion; scroll only writes a CSS variable (transforms, no layout).
 */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { BrandMark } from '../../BrandMark';
import { CoinIcon } from '../../CoinIcon';
import { dropBootShell } from '../../../bootShell';
import { bp, FEES, reducedMotion, startFromText, SwimmingWhale, usdShort, usdStep, useLiveDesk, type MarketRow } from '../shared';
import { MoneyFlow, MONEY_FACTS } from '../site/MoneyFlow';
import '../site/site.css';
import './v2.css';

/** The VIP condition without its "VIP:" lead (a gold VIP pill or the word VIP stands beside it). */
const VIP_RULE = FEES.vipCondition.replace(/^VIP:\s*/, '');
const cx = (...xs: Array<string | false | null | undefined>) => xs.filter(Boolean).join(' ');

/* ------------------------------------------------------------------------------------------------ hooks ----- */

/** On screen now (follows), or from the first time it comes near (`once`). */
function useOnScreen<T extends Element>(once = false, margin = '0px'): [React.RefObject<T>, boolean] {
  const ref = useRef<T>(null);
  const [on, setOn] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver !== 'function') { setOn(true); return; }
    const io = new IntersectionObserver(([e]) => {
      if (!e) return;
      if (once) { if (e.isIntersecting) { setOn(true); io.disconnect(); } } else setOn(e.isIntersecting);
    }, { rootMargin: margin });
    io.observe(el);
    return () => io.disconnect();
  }, [once, margin]);
  return [ref, on];
}

function Reveal({ children, className, delay = 0 }: { children: ReactNode; className?: string; delay?: number }) {
  const [ref, on] = useOnScreen<HTMLDivElement>(true, '0px 0px -10% 0px');
  return <div ref={ref} className={cx('v2-rv', on && 'is-in', className)} style={{ '--d': `${delay}ms` } as CSSProperties}>{children}</div>;
}

/** Counts up to `to` once on screen. */
function Count({ to, fmt }: { to: number | null; fmt: (v: number) => string }) {
  const [ref, on] = useOnScreen<HTMLSpanElement>(true);
  const [v, setV] = useState(0);
  useEffect(() => {
    if (!on || to === null) return;
    if (reducedMotion()) { setV(to); return; }
    const t0 = performance.now();
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / 1500);
      setV(to * (1 - Math.pow(1 - k, 4)));
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [on, to]);
  return <span ref={ref}>{to === null ? '—' : fmt(v)}</span>;
}

/* ------------------------------------------------------------------------------------------------ icons ----- */

const I = {
  arrow: <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M3 8h9.5M8.5 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>,
  shield: <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><path d="M10 2.5 4 5v4.6c0 3.6 2.5 6.6 6 7.9 3.5-1.3 6-4.3 6-7.9V5l-6-2.5Z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" /><path d="m7.4 10 1.8 1.8 3.5-3.6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>,
  pen: <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><path d="M12.8 3.6 16.4 7.2 7.6 16H4v-3.6l8.8-8.8Z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" /><path d="m11 5.4 3.6 3.6" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>,
  tag: <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><path d="M3 10.2V3.5h6.7l7.3 7.3-6.7 6.7L3 10.2Z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" /><circle cx="6.8" cy="7.2" r="1.3" fill="currentColor" /></svg>,
  wallet: <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><rect x="3" y="6" width="18" height="13" rx="3.2" fill="none" stroke="currentColor" strokeWidth="1.6" /><path d="M3 9.5h14.5a3.5 3.5 0 0 1 3.5 3.5v0" fill="none" stroke="currentColor" strokeWidth="1.6" /><circle cx="16.5" cy="13.5" r="1.4" fill="currentColor" /><path d="M6 6 15 3.5 16.5 6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /></svg>,
  sign: <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><path d="M3 18c2.5 0 3.5-7 6-7s1 5 3.5 5 2.5-3 4-3 1.5 2 4.5 2" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /><path d="M3 21h18" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" opacity=".5" /></svg>,
  bot: <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><rect x="4" y="7" width="16" height="12" rx="3.5" fill="none" stroke="currentColor" strokeWidth="1.6" /><path d="M12 7V4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /><circle cx="12" cy="3.4" r="1.2" fill="currentColor" /><circle cx="9" cy="12.6" r="1.4" fill="currentColor" /><circle cx="15" cy="12.6" r="1.4" fill="currentColor" /><path d="M9.5 16h5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>,
  key: <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><circle cx="8" cy="12" r="4" fill="none" stroke="currentColor" strokeWidth="1.6" /><path d="M12 12h9M18 12v3M21 12v2" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>,
  check: <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="m3.5 8.2 2.8 2.8 6-6.2" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>,
  plus: <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>,
};

/* ------------------------------------------------------------------------------------------------ ground ----- */

// Deterministic dust: the same field every load, no Math.random in render.
const DUST = Array.from({ length: 42 }, (_, i) => {
  const r = (n: number) => { const x = Math.sin(i * 127.1 + n * 311.7) * 43758.5453; return x - Math.floor(x); };
  return { x: r(1) * 100, y: r(2) * 100, s: 1 + r(3) * 2.4, d: 14 + r(4) * 22, o: -r(5) * 30, a: 0.25 + r(6) * 0.55, b: r(7) > 0.82 };
});

export function Sky() {
  return (
    <div className="v2-sky" aria-hidden="true">
      <div className="v2-sky__light" />
      <div className="v2-sky__beam is-a" />
      <div className="v2-sky__beam is-b" />
      <div className="v2-sky__dust">
        {DUST.map((p, i) => (
          <i key={i} className={cx(p.b && 'is-blur')} style={{ left: `${p.x}%`, top: `${p.y}%`, width: p.s, height: p.s, '--dur': `${p.d}s`, '--del': `${p.o}s`, '--a': p.a } as CSSProperties} />
        ))}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------------------------------- nav ----- */

function Nav() {
  const [solid, setSolid] = useState(false);
  useEffect(() => {
    const on = () => setSolid(window.scrollY > 24);
    on();
    window.addEventListener('scroll', on, { passive: true });
    return () => window.removeEventListener('scroll', on);
  }, []);
  return (
    <header className={cx('v2-nav', solid && 'is-solid')}>
      <a href="/home/2" className="v2-logo"><BrandMark size={22} /><span>ValueDesk</span></a>
      <nav className="v2-nav__links" aria-label="Sections">
        <a href="#how">How it works</a><a href="#money">Your money</a><a href="#live">Live</a><a href="#fees">Fees</a><a href="#faq">FAQ</a>
      </nav>
      <a href="/trade" className="v2-btn is-glass is-sm">Open app</a>
    </header>
  );
}

/* ------------------------------------------------------------------------------------------------- hero ----- */

function Hero({ start }: { start: string }) {
  return (
    <section className="v2-hero">
      <Reveal><span className="v2-eyebrow"><i className="v2-dot" />Bots and copy trading on SoDEX</span></Reveal>
      <Reveal delay={80}>
        <h1 className="v2-h1">
          <span>Start with <em className="v2-amt">{start}</em>.</span>
          <span className="v2-h1__2">Swim with the whales.</span>
        </h1>
      </Reveal>
      <Reveal delay={160}>
        <p className="v2-lead">Run a market maker bot or copy a trader on SoDEX, from your own account. Set up in three free signatures, then it keeps running while you sleep.</p>
      </Reveal>
      <Reveal delay={240} className="v2-cta">
        <a href="/bots/new" className="v2-btn is-light">Start a bot{I.arrow}</a>
        <a href="/copy" className="v2-btn is-glass">Copy a trader</a>
      </Reveal>
      <Reveal delay={320}>
        <ul className="v2-trust">
          <li><span className="v2-trust__ic">{I.shield}</span>Your funds stay in your SoDEX account</li>
          <li><span className="v2-trust__ic">{I.pen}</span>3 signatures, no deposit to us</li>
          <li><span className="v2-trust__ic is-vip">{I.tag}</span>Bot fee from {bp(FEES.botLowest)} <span className="v2-vip-pill">VIP</span></li>
        </ul>
      </Reveal>
      <a href="#how" className="v2-scrollcue" aria-label="Scroll to how it works"><span /></a>
    </section>
  );
}

/* --------------------------------------------------------------------------------- pinned: three signatures ----- */

const STEPS = [
  { t: 'Connect your wallet', s: 'The wallet you use on SoDEX. Connecting moves nothing.' },
  { t: 'Sign the terms', s: 'One click asks your wallet for a signature. Free: no transaction, no gas.' },
  { t: 'Approve the fee', s: "You approve ValueDesk's fee on SoDEX, up to a maximum. SoDEX takes it on each fill; revoke it on SoDEX any time." },
  { t: 'Create the trading key', s: 'It trades for your bot and can move funds only between your own SoDEX accounts and wallet. It ends after the days you choose, at most 180.' },
  { t: 'Your bot is running', s: "On ValueDesk's executor in Tokyo, also with the tab closed. Stop it any time." },
] as const;

/** Scroll progress through a tall section, 0..1, written to --p (no re-render) and to a step index (re-renders on change). */
function useScrollScene(steps: number): [React.RefObject<HTMLElement>, number] {
  const ref = useRef<HTMLElement>(null);
  const [step, setStep] = useState(reducedMotion() ? steps - 1 : 0);
  useEffect(() => {
    const el = ref.current;
    if (!el || reducedMotion()) { el?.style.setProperty('--p', '1'); return; }
    let raf = 0;
    let last = -1;
    const read = () => {
      raf = 0;
      const r = el.getBoundingClientRect();
      const span = Math.max(1, r.height - window.innerHeight);
      const p = Math.min(1, Math.max(0, -r.top / span));
      el.style.setProperty('--p', p.toFixed(4));
      const s = Math.min(steps - 1, Math.floor(p * steps * 0.999 + 0.0001));
      if (s !== last) { last = s; setStep(s); }
    };
    const kick = () => { if (!raf) raf = requestAnimationFrame(read); };
    read();
    window.addEventListener('scroll', kick, { passive: true });
    window.addEventListener('resize', kick);
    return () => { cancelAnimationFrame(raf); window.removeEventListener('scroll', kick); window.removeEventListener('resize', kick); };
  }, [steps]);
  return [ref, step];
}

export function SetupScene() {
  const [ref, step] = useScrollScene(STEPS.length);
  const lit = (n: number) => step >= n;
  const sig = (n: number) => cx('v2-chip', lit(n) && 'is-on', step === n && 'is-now');
  return (
    <section ref={ref} id="how" className="v2-scene" data-step={step}>
      <div className="v2-scene__pin">
        <div className="v2-wrap v2-scene__grid">
          <div className="v2-scene__copy">
            <span className="v2-kicker">How it works</span>
            <h2 className="v2-h2">Up and running in three signatures.</h2>
            <ol className="v2-steps">
              {STEPS.map((x, i) => (
                <li key={i} className={cx(i === step && 'is-now', i < step && 'is-done')}>
                  <span className="v2-steps__n">{i < step ? I.check : i + 1}</span>
                  <div><b>{x.t}</b><p>{x.s}</p></div>
                </li>
              ))}
            </ol>
            <div className="v2-scene__bar" aria-hidden="true"><i /></div>
          </div>

          <div className="v2-flow" aria-hidden="true">
            <div className={cx('v2-node', lit(0) && 'is-on')}>
              <span className="v2-node__ic">{I.wallet}</span>
              <b>Connect</b><small>your wallet</small>
            </div>
            <div className="v2-link"><i /></div>
            <div className={cx('v2-node is-big', lit(1) && 'is-on')}>
              <span className="v2-node__ic">{I.sign}</span>
              <b>Sign</b><small>one click asks for each</small>
              <div className="v2-chips">
                <span className={sig(1)}>{lit(2) ? I.check : null}Terms</span>
                <span className={sig(2)}>{lit(3) ? I.check : null}Fee</span>
                <span className={sig(3)}>{lit(4) ? I.check : null}Key</span>
              </div>
            </div>
            <div className="v2-link"><i /></div>
            <div className={cx('v2-node', lit(4) && 'is-on is-live')}>
              <span className="v2-node__ic">{I.bot}</span>
              <b>Bot running</b><small><span className="v2-live"><i />{lit(4) ? 'Running' : 'Waiting'}</span></small>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------------- where your money goes ----- */

export function Money() {
  return (
    <section id="money" className="v2-sec">
      <div className="v2-wrap">
        <Reveal className="v2-head">
          <span className="v2-kicker">Where your money goes</span>
          <h2 className="v2-h2">It stays in your SoDEX account.</h2>
          <p className="v2-sub">There is no deposit to ValueDesk. Funds move only between your wallet, your SoDEX account and SoDEX's book; bots, copies and your own trades send orders, never funds.</p>
        </Reveal>
        <Reveal delay={100} className="v2-glass vd-money">
          <MoneyFlow />
          <ul className="vd-money__facts">
            {MONEY_FACTS.map((f) => <li key={f.t}><span className="vd-money__ic">{I.check}</span><div><b>{f.t}</b><p>{f.s}</p></div></li>)}
          </ul>
        </Reveal>
      </div>
    </section>
  );
}

/* --------------------------------------------------------------------------------------------- live proof ----- */

function PerMillion({ b }: { b: number | null }) {
  if (b === null) return <span className="v2-dim">—</span>;
  const usd = `$${Math.round(Math.abs(b) * 100).toLocaleString('en-US')}`;
  return b <= 0 ? <span className="v2-pos">earned {usd}</span> : <span>{usd}</span>;
}

function Live({ rows, marketCount, volumeH, makerBps, loading }: { rows: MarketRow[]; marketCount: number | null; volumeH: number | null; makerBps: number | null; loading: boolean }) {
  const top = rows.slice(0, 6);
  return (
    <section id="live" className="v2-sec">
      <div className="v2-wrap">
        <Reveal className="v2-head">
          <span className="v2-kicker"><i className="v2-dot is-pulse" />Live from SoDEX</span>
          <h2 className="v2-h2">The water is deep right now.</h2>
          <p className="v2-sub">Read live from SoDEX and the Bots page. Nothing on this strip is typed in by hand.</p>
        </Reveal>
        <div className="v2-stats">
          <Reveal className="v2-stat"><b><Count to={marketCount} fmt={(v) => String(Math.round(v))} /></b><span>markets a bot can run on</span></Reveal>
          <Reveal delay={80} className="v2-stat"><b><Count to={volumeH} fmt={usdShort} /></b><span>traded per hour on them</span></Reveal>
          <Reveal delay={160} className="v2-stat"><b>{makerBps === null ? '—' : `${+makerBps.toFixed(2)} bp`}</b><span>SoDEX maker fee now</span></Reveal>
        </div>
        <Reveal delay={120} className="v2-glass v2-mkts">
          <div className="v2-mkts__head"><span>Market</span><span>Volume</span><span>Market maker per $1M</span></div>
          {loading && !top.length
            ? Array.from({ length: 6 }, (_, i) => <div key={i} className="v2-mkt is-sk"><i /><i /><i /></div>)
            : top.map(({ m, bp: b }) => (
              <a key={m.symbol} className="v2-mkt" href={`/bots/new?market=${encodeURIComponent(m.symbol)}&kind=market`}>
                <span className="v2-mkt__c"><CoinIcon coin={m.base} size={26} /><b>{m.base}</b></span>
                <span className="v2-mkt__v">{usdShort(m.volumeUsdH)}<small>/h</small></span>
                <span className="v2-mkt__p"><PerMillion b={b} /><span className="v2-mkt__go">{I.arrow}</span></span>
              </a>
            ))}
          <p className="v2-mkts__foot">The cheapest market maker bot on each market per $1M traded, at a new wallet's bot fee, estimated as on the Bots page. <a href="/bots/explore">Every market{I.arrow}</a></p>
        </Reveal>
      </div>
    </section>
  );
}

/* --------------------------------------------------------------------------------------------------- fees ----- */

function Fees({ makerBps }: { makerBps: number | null }) {
  return (
    <section id="fees" className="v2-sec">
      <div className="v2-wrap">
        <Reveal className="v2-head">
          <span className="v2-kicker">Fees</span>
          <h2 className="v2-h2">Small fees. Paid per order, never up front.</h2>
          <p className="v2-sub">SoDEX charges its own trading fee on top{makerBps === null ? '' : ` (maker ${+makerBps.toFixed(2)} bp now)`}. Volume counts over {FEES.windowDays} days.</p>
        </Reveal>
        <div className="v2-prices">
          <Reveal className="v2-price is-hot">
            <div className="v2-price__glow" aria-hidden="true" />
            <span className="v2-price__k">Bots</span>
            <div className="v2-price__big"><small>from</small> <span className="v2-vip-text">{bp(FEES.botLowest)}</span></div>
            <p className="v2-price__cond"><span className="v2-vip-pill">VIP</span>{VIP_RULE}</p>
            <p className="v2-price__new">A new wallet pays <b>{bp(FEES.botNew)}</b> per order, less as volume grows:</p>
            <ul className="v2-ladder">
              {FEES.botLadder.map((s) => <li key={s.fromUsd}><span>{s.fromUsd === 0 ? 'New wallet' : `From ${usdStep(s.fromUsd)}`}</span><b>{bp(s.fee)}</b></li>)}
              <li className="is-vip"><span><span className="v2-vip-pill">VIP</span></span><b className="v2-vip-text">{bp(FEES.botLowest)}</b></li>
            </ul>
            <a href="/bots/new" className="v2-btn is-light is-block">Start a bot{I.arrow}</a>
          </Reveal>
          <Reveal delay={90} className="v2-price">
            <span className="v2-price__k">Copy trading</span>
            <div className="v2-price__big"><small>from</small> {bp(FEES.copyLowest)}</div>
            <p className="v2-price__cond">{FEES.copyLowestCondition.replace(/^from/, 'From')}</p>
            <p className="v2-price__new">A new wallet pays <b>{bp(FEES.copyNew)}</b> per copied order, less as volume grows:</p>
            <ul className="v2-ladder">
              {FEES.copyLadder.map((s) => <li key={s.fromUsd}><span>{s.fromUsd === 0 ? 'New wallet' : `From ${usdStep(s.fromUsd)}`}</span><b>{bp(s.fee)}</b></li>)}
            </ul>
            <a href="/copy" className="v2-btn is-glass is-block">Copy a trader</a>
          </Reveal>
          <Reveal delay={180} className="v2-price">
            <span className="v2-price__k">Analytics</span>
            <div className="v2-price__big">Free</div>
            <p className="v2-price__cond">No fee on any of it.</p>
            <ul className="v2-ladder is-list">
              <li><span>{I.check}Liquidation map</span></li>
              <li><span>{I.check}Trader leaderboards</span></li>
              <li><span>{I.check}Who traded each candle</span></li>
              <li><span>{I.check}News and calendar</span></li>
            </ul>
            <a href="/trade" className="v2-btn is-glass is-block">Open the terminal</a>
          </Reveal>
        </div>
        <p className="v2-note">1 bp = 0.01% of the order's value.</p>
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------------------------------------------- FAQ ----- */

const FAQ: Array<{ q: string; a: ReactNode }> = [
  { q: 'Do I deposit money with ValueDesk?', a: 'No. Your funds stay in your own SoDEX account. Bots and copies trade from it with a trading key you create.' },
  { q: 'What does it cost?', a: <>Bots: {bp(FEES.botNew)} per order for a new wallet, down to {bp(FEES.botLowest)} for VIP ({VIP_RULE}). Copy trading: {bp(FEES.copyNew)} down to {bp(FEES.copyLowest)} ({FEES.copyLowestCondition}). Analytics are free. SoDEX charges its own trading fee on top.</> },
  { q: 'Can I stop any time?', a: 'Yes. Stop a bot or a copy with one click, and revoke the trading key and the fee on SoDEX whenever you like. The key also ends by itself after the days you choose, at most 180.' },
  { q: 'Does it keep running when I close the tab?', a: "Bots and hosted copies do: they run on ValueDesk's executor in Tokyo." },
  { q: 'How long does setup take?', a: 'Connect your wallet and sign three times (terms, fee, key); one click asks for each. The signatures are free: no transaction.' },
  { q: 'Where is it available?', a: 'Not in the US, the UK, Canada or sanctioned countries.' },
  { q: 'What is the minimum?', a: "$5 is enough to start a market maker on the busiest markets. SoDEX's own minimum order applies." },
];

export function Faq({ items = FAQ, title = 'Before you dive in.', id = 'faq' }: { items?: Array<{ q: string; a: ReactNode }>; title?: ReactNode; id?: string }) {
  const [open, setOpen] = useState<number | null>(0);
  return (
    <section id={id} className="v2-sec">
      <div className="v2-wrap v2-faq">
        <Reveal className="v2-head is-left">
          <span className="v2-kicker">FAQ</span>
          <h2 className="v2-h2">{title}</h2>
          <p className="v2-sub">Anything else: the <a href="/copy-terms">copy and bot terms</a> and the <a href="/risk">risk disclosure</a>.</p>
        </Reveal>
        <Reveal delay={80} className="v2-faq__list">
          {items.map((f, i) => {
            const isOpen = open === i;
            return (
              <div key={i} className={cx('v2-qa', isOpen && 'is-open')}>
                <button type="button" aria-expanded={isOpen} aria-controls={`v2-qa-${i}`} onClick={() => setOpen(isOpen ? null : i)}>
                  <span>{f.q}</span><i aria-hidden="true">{I.plus}</i>
                </button>
                <div id={`v2-qa-${i}`} className="v2-qa__a" role="region"><div><p>{f.a}</p></div></div>
              </div>
            );
          })}
        </Reveal>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------------------------------------ the end ----- */

function Final({ start }: { start: string }) {
  return (
    <section className="v2-final">
      <Reveal className="v2-final__in">
        <div className="v2-final__mark" aria-hidden="true"><BrandMark size={56} /></div>
        <h2 className="v2-h2 is-xl">Your first bot, with {start}.</h2>
        <p className="v2-sub">Connect, sign three times, run. Your funds never leave your SoDEX account.</p>
        <div className="v2-cta is-center">
          <a href="/bots/new" className="v2-btn is-light">Start a bot{I.arrow}</a>
          <a href="/copy" className="v2-btn is-glass">Copy a trader</a>
        </div>
      </Reveal>
    </section>
  );
}

function Footer() {
  return (
    <footer className="v2-foot">
      <div className="v2-wrap">
        <div className="v2-foot__row">
          <a href="/home/2" className="v2-logo"><BrandMark size={20} /><span>ValueDesk</span></a>
          <nav aria-label="Legal and status">
            <a href="/terms">Terms</a><a href="/risk">Risk</a><a href="/privacy">Privacy</a><a href="/copy-terms">Copy and bot terms</a><a href="/status">Status</a>
          </nav>
        </div>
        <p className="v2-risk">Trading perpetual futures carries a high risk of loss. Bots and copies can lose money, and past results say nothing about future ones.</p>
      </div>
    </footer>
  );
}

/* ------------------------------------------------------------------------------------------------- page ----- */

// Stable whale path (new arrays each render would restart its canvas loop): enters at the hero's right, leaves low left near the footer.
const WHALE_FROM: [number, number, number, number] = [0.84, 0.46, -58, 1];
const WHALE_TO: [number, number, number, number] = [-0.08, 0.76, -84, 1.15];
// Phone: the text fills the width, so the whale starts lower right and stays fainter behind it.
const WHALE_FROM_PHONE: [number, number, number, number] = [0.92, 0.6, -58, 0.85];
const WHALE_TO_PHONE: [number, number, number, number] = [0.02, 0.8, -84, 1];

export function V2() {
  const desk = useLiveDesk();
  const start = startFromText(desk.startFrom);
  const [phone] = useState(() => typeof window !== 'undefined' && window.innerWidth < 640);
  useEffect(() => {
    dropBootShell();
    const prev = document.title;
    document.title = 'ValueDesk: trading bots and copy trading on SoDEX';
    return () => { document.title = prev; };
  }, []);
  return (
    <div className="v2" data-no-i18n="">
      <Sky />
      <SwimmingWhale from={phone ? WHALE_FROM_PHONE : WHALE_FROM} to={phone ? WHALE_TO_PHONE : WHALE_TO} height={560} opacity={phone ? 0.3 : 0.42} className="v2-whale" />
      <div className="v2-main">
        <Nav />
        <Hero start={start} />
        <SetupScene />
        <Money />
        <Live rows={desk.rows} marketCount={desk.marketCount} volumeH={desk.volumeH} makerBps={desk.makerBps} loading={desk.loading} />
        <Fees makerBps={desk.makerBps} />
        <Faq />
        <Final start={start} />
        <Footer />
      </div>
    </div>
  );
}
