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


import { bp, FEES } from '../shared';
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

/* ---------------------------------------------------------------------------------------------------- FAQ ----- */

const FAQ: Array<{ q: string; a: ReactNode }> = [
  { q: 'Do I deposit money with ValueDesk?', a: 'No. Your funds stay in your own SoDEX account. Bots and copies trade from it with a trading key you create.' },
  { q: 'What does it cost?', a: <>Bots: {bp(FEES.botNew)} per order for a new wallet, down to {bp(FEES.botLowest)} for VIP ({VIP_RULE}). Copy trading: from {bp(FEES.copyLowest)} ({FEES.copyLowestCondition}). Analytics are free. SoDEX charges its own trading fee on top.</> },
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
