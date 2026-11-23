/**
 * Landing version 4, "Heat" (owner 2026-11-23): pricing- and calculator-led. The liquidation heatmap's ramp through
 * ribbed glass is the signature (heat.tsx); the page leads with the lowest fee WITH its condition, the small start, a
 * fee calculator on the real ladder, pricing cards, the safety facts, the live market table and the FAQ.
 *
 * Nothing on it is made up: every figure is live (shared.tsx useLiveDesk) or a constant the executor charges
 * (shared.tsx FEES), or plain arithmetic on those, labelled as such. The heat field and the whale are drawings.
 * Motion pauses off screen and follows prefers-reduced-motion. English only (data-no-i18n).
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { BrandMark } from '../../BrandMark';
import { CoinIcon } from '../../CoinIcon';
import { Slider, Switch } from '../../bots/kit/kit';
import { dropBootShell } from '../../../bootShell';
import { bp, FEES, reducedMotion, startFromText, SwimmingWhale, usdShort, usdStep, useLiveDesk, type MarketRow } from '../shared';
import { HeatGlass } from './heat';
import '../../vip.css';
import './v4.css';

const cx = (...xs: Array<string | false | null | undefined>) => xs.filter(Boolean).join(' ');

/** The VIP volume, read from the condition text the page shows beside it (so the two never disagree). */
const VIP_MIN_USD = (() => {
  const m = /\$(\d+(?:\.\d+)?)\s*([KM])/.exec(FEES.vipCondition);
  return m ? Number(m[1]) * (m[2] === 'M' ? 1e6 : 1e3) : 5e6;
})();
const VIP_WHEN = FEES.vipCondition.replace(/^VIP:\s*/, '');

/* ------------------------------------------------------------------------------------------- helpers ----- */

function useOnScreen<T extends Element>(o: { once?: boolean; margin?: string } = {}): [React.RefObject<T>, boolean] {
  const ref = useRef<T>(null);
  const [on, setOn] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver !== 'function') { setOn(true); return; }
    const io = new IntersectionObserver(([e]) => {
      if (!e) return;
      if (o.once) { if (e.isIntersecting) { setOn(true); io.disconnect(); } } else setOn(e.isIntersecting);
    }, { rootMargin: o.margin ?? '0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [o.once, o.margin]);
  return [ref, on];
}

function Reveal({ children, className, delay = 0, as: As = 'div', id }: { children: ReactNode; className?: string; delay?: number; as?: 'div' | 'section' | 'header' | 'article'; id?: string }) {
  const [ref, on] = useOnScreen<HTMLDivElement>({ once: true, margin: '-6% 0px' });
  return <As ref={ref as never} id={id} className={cx('v4-rv', on && 'is-in', className)} style={{ '--d': `${delay}ms` } as CSSProperties}>{children}</As>;
}

/** A number that glides to its new value (the calculator's results). */
export function Glide({ value, fmt }: { value: number; fmt: (v: number) => string }) {
  const [v, setV] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    if (reducedMotion()) { setV(value); from.current = value; return; }
    const a = from.current;
    const t0 = performance.now();
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / 380);
      const x = a + (value - a) * (1 - Math.pow(1 - k, 3));
      setV(x);
      from.current = x;
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <>{fmt(v)}</>;
}

export const money = (v: number): string => {
  const a = Math.abs(v);
  const s = a >= 1000 ? Math.round(a).toLocaleString('en-US') : a.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${v < 0 ? '−' : ''}$${s}`;
};

/** Cost of the cheapest bot per $1M traded (bp x $100); earned in green with a +. */
function PerMillion({ b }: { b: number | null }) {
  if (b === null) return <span className="v4-dim">—</span>;
  const usd = `$${Math.round(Math.abs(b) * 100).toLocaleString('en-US')}`;
  return b <= 0 ? <b className="v4-pos">+{usd}</b> : <b>{usd}</b>;
}

function Arrow() {
  return <svg className="v4-arrow" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8h9M8.5 4.5 12 8l-3.5 3.5" /></svg>;
}
function Check() {
  return <svg className="v4-check" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 8.4 6.8 11 12 5.4" /></svg>;
}
function Kicker({ children }: { children: ReactNode }) {
  return <p className="v4-kicker"><i />{children}</p>;
}
const marketHref = (symbol: string) => `/bots/new?market=${encodeURIComponent(symbol)}&kind=market`;

/* ------------------------------------------------------------------------------------- hero ticker ----- */

/** SoDEX markets now, rolling upward: coin, traded per hour, what the cheapest bot costs (or earns) per $1M. */
export function Ticker({ rows, marketCount, volumeH }: { rows: MarketRow[]; marketCount: number | null; volumeH: number | null }) {
  const [ref, on] = useOnScreen<HTMLDivElement>();
  const list = rows.slice(0, 12);
  const item = ({ m, bp: b }: MarketRow, dup = false) => (
    <a key={`${dup ? 'd' : ''}${m.symbol}`} href={marketHref(m.symbol)} className="v4-tk__i" tabIndex={dup ? -1 : undefined}>
      <CoinIcon coin={m.base} size={22} />
      <span className="v4-tk__c"><b>{m.base}</b><small>{usdShort(m.volumeUsdH)}/h</small></span>
      <span className="v4-tk__v"><PerMillion b={b} /><small>per $1M</small></span>
    </a>
  );
  return (
    <div ref={ref} className="v4-tk" data-off={on ? undefined : ''}>
      <div className="v4-tk__h">
        <span className="v4-live"><i />Live on SoDEX</span>
        <span className="v4-dim">{marketCount === null ? '…' : `${marketCount} markets`}{volumeH === null ? '' : ` · ${usdShort(volumeH)}/h`}</span>
      </div>
      <div className="v4-tk__win" aria-label="SoDEX markets now: hourly volume and the cheapest bot's cost per $1M traded">
        {list.length ? (
          <div className="v4-tk__run" style={{ '--n': list.length } as CSSProperties}>
            {list.map((r) => item(r))}
            <span aria-hidden="true" className="v4-tk__dup">{list.map((r) => item(r, true))}</span>
          </div>
        ) : (
          <div className="v4-tk__skel">{[0, 1, 2, 3, 4].map((i) => <span key={i} />)}</div>
        )}
      </div>
      <p className="v4-tk__f">Cheapest bot per market, estimated from the last 24 h at the new-wallet fee.</p>
    </div>
  );
}

/* ------------------------------------------------------------------------------------- calculator ----- */

const LOG_MIN = 4; // $10K
const LOG_MAX = 7; // $10M
const STEPS = 1000;
const volOf = (t: number): number => {
  const v = Math.pow(10, LOG_MIN + ((LOG_MAX - LOG_MIN) * t) / STEPS);
  const mag = Math.pow(10, Math.floor(Math.log10(v)) - 1);
  return Math.round(v / mag) * mag; // two significant figures, so the arithmetic below is easy to redo by hand
};
const tOf = (usd: number): number => Math.round(((Math.log10(usd) - LOG_MIN) / (LOG_MAX - LOG_MIN)) * STEPS);
const volText = (v: number): string => (v >= 1e6 ? `$${+(v / 1e6).toFixed(2)}M` : `$${+(v / 1e3).toFixed(1)}K`);

export function Calculator({ makerBps }: { makerBps: number | null }) {
  const [t, setT] = useState(() => tOf(500_000));
  const [vip, setVip] = useState(false);
  const vol = volOf(t);
  const ladderIx = FEES.botLadder.reduce((ix, s, i) => (vol >= s.fromUsd ? i : ix), 0);
  const fee = vip ? FEES.botLowest : FEES.botLadder[ladderIx]!.fee; // tenths of a bp
  const ours = (vol * (fee / 10)) / 10_000;
  const sodex = makerBps === null ? null : (vol * makerBps) / 10_000;
  const meetsVip = vol >= VIP_MIN_USD;
  const marks = [...FEES.botLadder.slice(1).map((s) => ({ usd: s.fromUsd, vip: false })), { usd: VIP_MIN_USD, vip: true }];

  return (
    <div className="v4-calc">
      <div className="v4-calc__in tf">
        <div className="v4-calc__row">
          <label className="v4-calc__l" htmlFor="v4-vol">Your bots' volume in {FEES.windowDays} days</label>
          <output className="v4-calc__vol" htmlFor="v4-vol">{volText(vol)}</output>
        </div>
        <div className="v4-calc__slider" style={{ '--p': `${(t / STEPS) * 100}%` } as CSSProperties}>
          <Slider value={t} min={0} max={STEPS} step={1} onChange={setT} label={`Bot volume in ${FEES.windowDays} days: ${volText(vol)}`} className="v4-slider" />
          <div className="v4-calc__marks" aria-hidden="true">
            {marks.map((m) => (
              <span key={m.usd} className={cx(m.vip && 'is-vip')} style={{ left: `${(tOf(m.usd) / STEPS) * 100}%` }}>{usdStep(m.usd)}</span>
            ))}
          </div>
          <div className="v4-calc__ends" aria-hidden="true"><span>$10K</span><span>$10M</span></div>
        </div>

        <div className="v4-calc__vip">
          <Switch checked={vip} onChange={setVip} label="VIP" description={VIP_WHEN} className={cx('v4-vipsw', vip && 'is-on')} />
          {!vip && meetsVip && <button type="button" className="v4-vipnote" onClick={() => setVip(true)}>This volume meets the VIP condition<Arrow /></button>}
          {vip && !meetsVip && <span className="v4-calc__warn">VIP needs {usdStep(VIP_MIN_USD)} of bot volume in {FEES.windowDays} days.</span>}
        </div>

        <ol className="v4-ladder" aria-label="Bot fee ladder">
          {FEES.botLadder.map((s, i) => (
            <li key={s.fromUsd} className={cx(!vip && i === ladderIx && 'is-on')}>
              <small>{s.fromUsd === 0 ? 'New wallet' : `From ${usdStep(s.fromUsd)}`}</small>
              <b>{bp(s.fee)}</b>
            </li>
          ))}
          <li className={cx('is-vipstep', vip && 'is-on')}>
            <small><span className="v4-vip vip-pill">VIP</span></small>
            <b className="vip-text">{bp(FEES.botLowest)}</b>
          </li>
        </ol>
      </div>

      <div className="v4-calc__out">
        <HeatGlass layout="card" rib={22} className="v4-calc__heat" />
        <div className="v4-calc__res">
          <p className="v4-calc__k">ValueDesk fee on {volText(vol)}</p>
          <p className="v4-calc__big"><Glide value={ours} fmt={money} /></p>
          <p className="v4-calc__eq">{volText(vol)} × <b className={cx(vip && 'vip-text')}>{bp(fee)}</b> ÷ 10,000 {vip ? <span className="v4-vip vip-pill">VIP</span> : <span className="v4-step">{ladderIx === 0 ? 'new wallet' : `from ${usdStep(FEES.botLadder[ladderIx]!.fromUsd)}`}</span>}</p>
          <div className="v4-calc__split">
            <div>
              <small>SoDEX maker fee, paid to SoDEX</small>
              <b>{sodex === null ? '—' : <Glide value={sodex} fmt={money} />}</b>
              <span className="v4-dim">{makerBps === null ? 'reading SoDEX…' : `${volText(vol)} × ${makerBps} bp now`}</span>
            </div>
            <div>
              <small>Both fees together</small>
              <b>{sodex === null ? '—' : <Glide value={ours + sodex} fmt={money} />}</b>
              <span className="v4-dim">before the bot's own result</span>
            </div>
          </div>
          <a href="/bots/new" className="v4-btn is-light is-block">Start a bot<Arrow /></a>
        </div>
      </div>
      <p className="v4-calc__note">A calculation, not a forecast: volume × fee ÷ 10,000 on the fee ladder ValueDesk charges and SoDEX's maker fee read now. A bot's profit or loss also depends on its fills and the price, and is not shown here.</p>
    </div>
  );
}

/* ----------------------------------------------------------------------------------------- setup viz ----- */

const SETUP = [
  { k: 'Connect', t: 'A wallet you use on SoDEX' },
  { k: 'Sign 1', t: 'The terms' },
  { k: 'Sign 2', t: 'The fee' },
  { k: 'Sign 3', t: 'The trading key' },
];

export function SetupSteps() {
  const [ref, on] = useOnScreen<HTMLOListElement>();
  const [at, setAt] = useState(reducedMotion() ? SETUP.length : 0);
  useEffect(() => {
    if (!on || reducedMotion()) return;
    const id = window.setInterval(() => setAt((a) => (a >= SETUP.length + 1 ? 0 : a + 1)), 900);
    return () => window.clearInterval(id);
  }, [on]);
  return (
    <ol ref={ref} className="v4-steps">
      {SETUP.map((s, i) => (
        <li key={s.k} className={cx(i < at && 'is-done', i === at && 'is-now')}>
          <span className="v4-steps__n">{i < at ? <Check /> : i === 0 ? <svg className="v4-check" viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="4" width="11" height="8.5" rx="2" /><path d="M10 8.2h1.4" /></svg> : i}</span>
          <span className="v4-steps__t"><small>{s.k}</small>{s.t}</span>
          {i > 0 && <span className="v4-free">Free</span>}
        </li>
      ))}
    </ol>
  );
}

/* ---------------------------------------------------------------------------------------------- faq ----- */

function faqItems(start: string): Array<{ q: string; a: string }> {
  const ladder = FEES.botLadder;
  return [
    { q: 'Do I deposit anything with ValueDesk?', a: 'No. Your funds stay in your own SoDEX account. Bots and copies place orders there with a trading key you register on SoDEX; that key can move funds only between your own SoDEX accounts and your wallet, never to anyone else.' },
    { q: 'What does it cost?', a: `The analytics are free. Bot orders pay ${bp(ladder[0]!.fee)} of their value for a new wallet, down to ${bp(ladder[ladder.length - 1]!.fee)} by your ${FEES.windowDays}-day volume, and ${bp(FEES.botLowest)} for VIP (${VIP_WHEN}). Copied orders pay ${bp(FEES.copyNew)} down to ${bp(FEES.copyLowest)} (${FEES.copyLowestCondition}). SoDEX charges its own trading fee on top.` },
    { q: 'Can I stop at any time?', a: 'Yes. Stop a bot or a copy in the app, and revoke the trading key and the fee approval on SoDEX whenever you like. The key also ends on its own after the days you chose, at most 180.' },
    { q: 'Do bots keep running when I close the tab?', a: 'Yes. Bots and hosted copies run on the ValueDesk executor in Tokyo around the clock. Browser copies run while their tab is open.' },
    { q: 'How long does setting up take?', a: 'Connect a wallet you use on SoDEX and sign three times: the terms, the fee and the trading key. One click asks for each in turn. Signatures are free; none is a transaction.' },
    { q: 'Where is it available?', a: 'Not in the United States, the United Kingdom, Canada or sanctioned countries. The terms list every place it is not offered.' },
    { q: 'What is the minimum?', a: `${start} is enough to start a market maker on the busiest markets; SoDEX's own minimum order applies.` },
  ];
}

/* ---------------------------------------------------------------------------------------------- page ----- */

const WHALE_FROM: [number, number, number, number] = [1.12, 0.3, -62, 0.9];
const WHALE_TO: [number, number, number, number] = [-0.2, 0.62, -80, 1.15];

export function V4() {
  const live = useLiveDesk();
  const start = startFromText(live.startFrom);
  const faq = useMemo(() => faqItems(start), [start]);
  const [open, setOpen] = useState(0);
  const [solid, setSolid] = useState(false);

  useEffect(() => {
    dropBootShell();
    document.title = `ValueDesk: SoDEX bots from ${bp(FEES.botLowest)}, start with ${start}`;
  }, [start]);
  useEffect(() => {
    const s = () => setSolid(window.scrollY > 12);
    s();
    window.addEventListener('scroll', s, { passive: true });
    return () => window.removeEventListener('scroll', s);
  }, []);

  const table = live.rows.slice(0, 10);

  return (
    <div className="v4" data-no-i18n="">
      <SwimmingWhale from={WHALE_FROM} to={WHALE_TO} height={560} opacity={0.42} color="196, 188, 255" className="v4-whale" />

      <div className="v4-page">
        <nav className={cx('v4-nav', solid && 'is-solid')} aria-label="ValueDesk">
          <a href="/home" className="v4-logo"><BrandMark size={22} /><span>ValueDesk</span></a>
          <div className="v4-nav__links">
            <a href="#calculator">Calculator</a><a href="#pricing">Pricing</a><a href="#markets">Markets</a><a href="#faq">FAQ</a>
          </div>
          <a href="/trade" className="v4-btn is-glass is-sm">Open app</a>
        </nav>

        {/* ------------------------------------------------------------------------------------------- hero */}
        <header className="v4-hero">
          <div className="v4-hero__bg" aria-hidden="true"><HeatGlass layout="right" rib={28} className="v4-hero__heat" /></div>
          <div className="v4-hero__in">
            <div className="v4-hero__t">
              <div className="v4-up"><Kicker>Market maker and grid bots on SoDEX</Kicker></div>
              <h1 className="v4-h1 v4-up" style={{ '--d': '80ms' } as CSSProperties}>
                <span className="v4-h1__a">Bots from <em>{bp(FEES.botLowest)}.</em></span>
                <span className="v4-cond"><span className="v4-vip vip-pill">VIP</span>{VIP_WHEN}</span>
                <span className="v4-h1__b">Start with {start}.</span>
              </h1>
              <p className="v4-sub v4-up" style={{ '--d': '160ms' } as CSSProperties}>
                A new wallet pays <b>{bp(FEES.botNew)}</b> per bot order, lower as your {FEES.windowDays}-day volume grows. Your funds stay in your SoDEX account, and the bots run around the clock on our executor in Tokyo.
              </p>
              <div className="v4-cta v4-up" style={{ '--d': '240ms' } as CSSProperties}>
                <a href="/bots/new" className="v4-btn is-light">Start a bot<Arrow /></a>
                <a href="/copy" className="v4-btn is-glass">Copy a trader</a>
              </div>
              <p className="v4-fine v4-up" style={{ '--d': '300ms' } as CSSProperties}>SoDEX charges its own trading fee on top. Setup: connect and three free signatures.</p>
            </div>
            <div className="v4-up v4-hero__tk" style={{ '--d': '200ms' } as CSSProperties}>
              <Ticker rows={live.rows} marketCount={live.marketCount} volumeH={live.volumeH} />
            </div>
          </div>
        </header>

        {/* ------------------------------------------------------------------------------------ calculator */}
        <section className="v4-sec" id="calculator">
          <Reveal as="header" className="v4-head">
            <Kicker>Fee calculator</Kicker>
            <h2 className="v4-h2">Drag your volume.<br /><span>See the fee.</span></h2>
            <p className="v4-lead">The bot fee falls as your {FEES.windowDays}-day volume grows. Pick a volume and see which step applies and what it comes to in dollars.</p>
          </Reveal>
          <Reveal><Calculator makerBps={live.makerBps} /></Reveal>
        </section>

        {/* --------------------------------------------------------------------------------------- pricing */}
        <section className="v4-sec" id="pricing">
          <Reveal as="header" className="v4-head is-center">
            <Kicker>Pricing</Kicker>
            <h2 className="v4-h2">No subscription.<br /><span>A fee on what runs.</span></h2>
          </Reveal>
          <div className="v4-plans">
            <Reveal as="article" className="v4-plan">
              <p className="v4-plan__k">Analytics</p>
              <p className="v4-plan__d">Read the market</p>
              <p className="v4-plan__v">Free</p>
              <p className="v4-plan__s">In the terminal</p>
              <a href="/trade" className="v4-btn is-glass is-block">Open the terminal</a>
              <ul>
                <li><Check />Liquidation map, live and history</li>
                <li><Check />Who traded each candle</li>
                <li><Check />Leaderboards and wallet scan</li>
                <li><Check />News, calendar, ETF flows</li>
              </ul>
            </Reveal>

            <Reveal as="article" className="v4-plan is-heat" delay={90}>
              <HeatGlass layout="card" rib={20} className="v4-plan__heat" />
              <div className="v4-plan__dots" aria-hidden="true" />
              <div className="v4-plan__in">
                <p className="v4-plan__k">Bots</p>
                <p className="v4-plan__d">Market maker and grid, around the clock</p>
                <p className="v4-plan__v"><small>from </small><span className="vip-text">{bp(FEES.botLowest)}</span><small> per order</small></p>
                <p className="v4-plan__s"><span className="v4-vip vip-pill">VIP</span> {VIP_WHEN}</p>
                <a href="/bots/new" className="v4-btn is-light is-block">Start a bot<Arrow /></a>
                <ul>
                  {FEES.botLadder.map((s) => <li key={s.fromUsd}><Check /><span><b>{bp(s.fee)}</b> {s.fromUsd === 0 ? "for a new wallet" : `from ${usdStep(s.fromUsd)} in ${FEES.windowDays} days`}</span></li>)}
                  <li><Check />Start with {start}</li>
                  <li><Check />Runs with the tab closed, on the executor in Tokyo</li>
                  <li><Check />Your loss limit, your size</li>
                </ul>
              </div>
            </Reveal>

            <Reveal as="article" className="v4-plan" delay={180}>
              <p className="v4-plan__k">Copy trading</p>
              <p className="v4-plan__d">Follow a Hyperliquid or SoDEX wallet</p>
              <p className="v4-plan__v"><small>from </small>{bp(FEES.copyLowest)}<small> per copied order</small></p>
              <p className="v4-plan__s">{FEES.copyLowestCondition}</p>
              <a href="/copy" className="v4-btn is-glass is-block">Copy a trader</a>
              <ul>
                <li><Check /><span><b>{bp(FEES.copyNew)}</b> for a new wallet</span></li>
                <li><Check />Lower by {FEES.windowDays}-day copied volume</li>
                <li><Check />In your browser or hosted</li>
                <li><Check />Your size, your leverage cap</li>
              </ul>
            </Reveal>
          </div>
          <p className="v4-note">SoDEX charges its own trading fee on top of every fill.</p>
        </section>

        {/* ------------------------------------------------------------------------------------------ trust */}
        <section className="v4-sec">
          <div className="v4-two">
            <Reveal as="article" className="v4-card">
              <div className="v4-card__ic" aria-hidden="true">
                <svg viewBox="0 0 24 24"><path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.4 7.5 9.5 4.3-1.1 7.5-4.9 7.5-9.5V6L12 3Z" /><path d="m8.8 12 2.2 2.2 4.2-4.4" /></svg>
              </div>
              <h3 className="v4-h3">Your funds stay yours.</h3>
              <p className="v4-dim2">Nothing is deposited with ValueDesk. Every order lands in your own SoDEX account.</p>
              <div className="v4-flow" aria-hidden="true">
                <span className="v4-flow__n">Your wallet</span>
                <span className="v4-flow__l"><i /></span>
                <span className="v4-flow__n">Your SoDEX accounts</span>
                <span className="v4-flow__x"><s>Anyone else</s></span>
              </div>
              <ul className="v4-facts">
                <li><Check />Funds stay in your SoDEX account.</li>
                <li><Check />The trading key trades, and can move funds only between your own SoDEX accounts and your wallet. Never to anyone else.</li>
                <li><Check />Revoke it on SoDEX any time. It ends by itself after the days you choose, at most 180.</li>
              </ul>
            </Reveal>
            <Reveal as="article" className="v4-card" delay={90}>
              <div className="v4-card__ic" aria-hidden="true">
                <svg viewBox="0 0 24 24"><path d="M4 17.5c2.2-.2 3.4-2.4 4.4-4.6 1-2.2 2-4.6 3.6-4.6 2.4 0 .2 7.7 2.6 7.7 1.1 0 1.9-1.4 2.7-2.6" /><path d="M4 20.5h16" /></svg>
              </div>
              <h3 className="v4-h3">Up and running in three signatures.</h3>
              <p className="v4-dim2">Connect, then one click asks for each signature in turn. All free. None is a transaction.</p>
              <SetupSteps />
              <a href="/bots/new" className="v4-btn is-light">Set up now<Arrow /></a>
            </Reveal>
          </div>
        </section>

        {/* --------------------------------------------------------------------------------------- markets */}
        <section className="v4-sec" id="markets">
          <Reveal as="header" className="v4-head v4-head--row">
            <div>
              <Kicker>Live markets</Kicker>
              <h2 className="v4-h2">Where the volume is.<br /><span>Pick one, start there.</span></h2>
            </div>
            <p className="v4-lead">The busiest SoDEX markets now, with the cheapest bot for each and what it cost or earned per $1M traded, estimated from the last 24 h at the new-wallet fee. Green with a + is earned.</p>
          </Reveal>
          <Reveal className="v4-table" >
            <div className="v4-tr is-h" role="row">
              <span>Market</span><span>Volume / h</span><span className="v4-hide-s">Cheapest bot</span><span>Per $1M</span><span aria-hidden="true" />
            </div>
            {table.length ? table.map(({ m, bp: b, recipe }) => (
              <a key={m.symbol} href={marketHref(m.symbol)} className="v4-tr">
                <span className="v4-tr__m"><CoinIcon coin={m.base} size={24} /><b>{m.base}</b><small className="v4-dim">{m.symbol}</small></span>
                <span className="v4-num">{usdShort(m.volumeUsdH)}</span>
                <span className="v4-hide-s v4-dim2">{recipe ?? '—'}</span>
                <span className="v4-num"><PerMillion b={b} /></span>
                <span className="v4-tr__go"><span className="v4-hide-s">Start</span><Arrow /></span>
              </a>
            )) : [0, 1, 2, 3, 4, 5].map((i) => <div key={i} className="v4-tr is-skel"><span /><span /><span /><span /><span /></div>)}
            {live.error && !table.length && <p className="v4-dim" style={{ padding: 16 }}>The live markets could not be read just now.</p>}
          </Reveal>
          <p className="v4-note"><a href="/bots/explore" className="v4-link">Every market in Bots › Explore<Arrow /></a></p>
        </section>

        {/* ------------------------------------------------------------------------------------------- faq */}
        <section className="v4-sec v4-faqsec" id="faq">
          <Reveal as="header" className="v4-head">
            <Kicker>FAQ</Kicker>
            <h2 className="v4-h2">Before you<br /><span>start.</span></h2>
            <p className="v4-lead">The rest is in the <a href="/copy-terms" className="v4-u">terms</a> and the <a href="/risk" className="v4-u">risk disclosure</a>.</p>
          </Reveal>
          <div className="v4-faq">
            {faq.map((f, i) => (
              <div key={f.q} className={cx('v4-faq__i', open === i && 'is-open')}>
                <button type="button" id={`v4-q${i}`} aria-expanded={open === i} aria-controls={`v4-a${i}`} onClick={() => setOpen(open === i ? -1 : i)}>
                  {f.q}<span className="v4-faq__x" aria-hidden="true" />
                </button>
                <div className="v4-faq__a" id={`v4-a${i}`} role="region" aria-labelledby={`v4-q${i}`}><div><p>{f.a}</p></div></div>
              </div>
            ))}
          </div>
        </section>

        {/* ----------------------------------------------------------------------------------- final + foot */}
        <section className="v4-final">
          <HeatGlass layout="wide" rib={30} className="v4-final__heat" />
          <div className="v4-final__in">
            <h2 className="v4-h2">Your first bot,<br /><span>with {start}.</span></h2>
            <p className="v4-lead">A new wallet pays {bp(FEES.botNew)} per bot order; VIP pays {bp(FEES.botLowest)} ({VIP_WHEN}).</p>
            <div className="v4-cta is-center">
              <a href="/bots/new" className="v4-btn is-light">Start a bot<Arrow /></a>
              <a href="/copy" className="v4-btn is-glass">Copy a trader</a>
            </div>
          </div>
        </section>

        <footer className="v4-foot">
          <div className="v4-foot__row">
            <a href="/home" className="v4-logo"><BrandMark size={20} /><span>ValueDesk</span></a>
            <nav className="v4-foot__links" aria-label="Legal and status">
              <a href="/terms">Terms</a><a href="/risk">Risk</a><a href="/privacy">Privacy</a><a href="/copy-terms">Copy and bot terms</a><a href="/status">Status</a>
            </nav>
          </div>
          <p className="v4-risk">Trading perpetual futures carries a high risk of loss. Bots and copies can lose money, and past results say nothing about future ones.</p>
        </footer>
      </div>
    </div>
  );
}
