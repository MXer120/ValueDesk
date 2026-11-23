/**
 * The features section in four variations (owner 2026-11-23: V3's features were "very very good" but the market picker
 * did not fit; "give me variations of the features thing" - one per version 5-8). The same six features, the whole
 * product rather than mostly bots, each with its own drawing:
 *   liquidations, copy, bots, who traded each candle, always on, cross-venue.
 *   A cards    - V3's card grid, two rows of three.
 *   B tabs     - a list that steps through by itself, one big stage cross-fading between drawings.
 *   C bento    - one large tile, one tall tile and four small ones, with the live counts.
 *   D scroll   - a sticky title on the left that follows the card in view on the right.
 * Facts as everywhere (shared.tsx): venues from gridModel, fees from FEES, counts live. Drawings carry no figures.
 */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { VenueLogo } from '../../VenueLogo';
import { COPY_VENUES, GRID_VENUES } from '../../copy/gridModel';
import { VENUE_LABEL } from '../../../vsApi';
import { BookViz, Count, Eyebrow, HeatViz, Reveal, TopTraders } from '../Home';
import { FollowViz as V3Follow, HeatField, HubViz, SleepViz } from '../v3/V3';
import { reducedMotion, usdShort, type LiveDesk } from '../shared';
import { CandleViz } from './Pages';
import { Embed, IC } from './Site';
import './features.css';

const cx = (...xs: Array<string | false | null | undefined>) => xs.filter(Boolean).join(' ');
const names = (vs: readonly string[]) => vs.map((v) => VENUE_LABEL[v as keyof typeof VENUE_LABEL]);
const list = (xs: string[], conj = 'and') => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} ${conj} ${xs[xs.length - 1]}`);

type Key = 'liq' | 'copy' | 'bots' | 'flow' | 'always' | 'cross';
interface Feat { k: Key; tag: string; t: string; s: string; ic: ReactNode }

const FEATS: Feat[] = [
  { k: 'liq', tag: 'Analytics · free', t: 'See the liquidations first', s: `Where positions on ${GRID_VENUES.length} venues get liquidated, over the chart, live and as history.`, ic: IC.heat },
  { k: 'copy', tag: 'Copy trading', t: 'Follow any trader', s: `Copy a ${list(names(COPY_VENUES), 'or')} wallet trade for trade, at your size and under your leverage cap.`, ic: IC.copy },
  { k: 'bots', tag: 'Bots', t: 'Market makers that never sleep', s: 'Quotes on both sides of the book, or a grid across a range, within the holding and loss limit you set.', ic: IC.bot },
  { k: 'flow', tag: 'Analytics · free', t: 'Who traded each candle', s: "Each candle's volume broken down by the wallets that traded it, right beside the chart.", ic: <svg viewBox="0 0 24 24"><path d="M6 20V9M12 20V4M18 20v-7" /></svg> },
  { k: 'always', tag: 'Always on', t: 'Runs with the laptop closed', s: "Bots and hosted copies run on ValueDesk's executor in Tokyo, around the clock, until your limits or you stop them.", ic: <svg viewBox="0 0 24 24"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" /></svg> },
  { k: 'cross', tag: 'Cross-venue', t: 'Five venues, one desk', s: `Traders and liquidations from ${list(names(GRID_VENUES))}; funding compared between SoDEX and Hyperliquid.`, ic: IC.cross },
];

/** The drawing for a feature. `big` picks the canvas field for large stages. Needs the `.v3` scope around it. */
function Vis({ k, big }: { k: Key; big?: boolean }) {
  switch (k) {
    case 'liq': return big ? <HeatField className="vd-fv-heat" /> : <div className="vd-fv-pad"><HeatViz /></div>;
    case 'copy': return <V3Follow />;
    case 'bots': return <div className="vd-fv-pad"><BookViz /></div>;
    case 'flow': return <div className="vd-fv-pad vd-fv-candles"><CandleViz /></div>;
    case 'always': return <SleepViz />;
    case 'cross': return <HubViz />;
  }
}

function Head({ title }: { title: ReactNode }) {
  return (
    <Reveal className="h-head">
      <Eyebrow>Features</Eyebrow>
      <h2 className="h-h2">{title}</h2>
    </Reveal>
  );
}

/* ------------------------------------------------------------------------------------------- A: cards ----- */

export function FeaturesCards() {
  return (
    <section className="vd-sec" id="features">
      <Head title={<>Everything on one desk.<br /><span>Each part does one job.</span></>} />
      <Embed scope="v3">
        <div className="v3-grid">
          {FEATS.map((f, i) => (
            <Reveal key={f.k} className="v3-feat" delay={(i % 3) * 80}>
              <div className="v3-viz">{<Vis k={f.k} />}</div>
              <p className="vd-ftag">{f.tag}</p>
              <h3>{f.t}</h3>
              <p>{f.s}</p>
            </Reveal>
          ))}
        </div>
      </Embed>
    </section>
  );
}

/* -------------------------------------------------------------------------------------------- B: tabs ----- */

const STEP_MS = 5200;

export function FeaturesTabs() {
  const [at, setAt] = useState(0);
  const [hold, setHold] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const [on, setOn] = useState(false);
  useEffect(() => {
    const el = box.current;
    if (!el || typeof IntersectionObserver !== 'function') { setOn(true); return; }
    const io = new IntersectionObserver(([e]) => setOn(!!e?.isIntersecting), { rootMargin: '-20% 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  useEffect(() => {
    if (!on || hold || reducedMotion()) return;
    const id = window.setTimeout(() => setAt((a) => (a + 1) % FEATS.length), STEP_MS);
    return () => window.clearTimeout(id);
  }, [at, on, hold]);
  return (
    <section className="vd-sec" id="features">
      <Head title={<>Six things it does.<br /><span>One account behind them.</span></>} />
      <div ref={box} className={cx('vd-ft', !on && 'is-paused', hold && 'is-held')} onMouseEnter={() => setHold(true)} onMouseLeave={() => setHold(false)}>
        <ol className="vd-ft__list">
          {FEATS.map((f, i) => (
            <li key={f.k} className={cx(i === at && 'is-on')}>
              <button type="button" onClick={() => setAt(i)} aria-pressed={i === at}>
                <span className="vd-ic">{f.ic}</span>
                <span className="vd-ft__t"><small>{f.tag}</small><b>{f.t}</b><em>{f.s}</em></span>
                {i === at && <i className="vd-ft__bar" style={{ animationDuration: `${STEP_MS}ms` }} />}
              </button>
            </li>
          ))}
        </ol>
        <Embed scope="v3" className="vd-ft__stage">
          {FEATS.map((f, i) => (
            <div key={f.k} className={cx('vd-ft__pane', i === at && 'is-on')} aria-hidden={i !== at}>
              <div className="v3-viz">{<Vis k={f.k} big />}</div>
            </div>
          ))}
        </Embed>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------------------------------- C: bento ----- */

export function FeaturesBento({ live }: { live: LiveDesk }) {
  const by = Object.fromEntries(FEATS.map((f) => [f.k, f])) as Record<Key, Feat>;
  const tile = (k: Key, cls: string, extra?: ReactNode, big?: boolean) => (
    <Reveal className={cx('vd-bt', cls)}>
      <div className="vd-bt__vis"><Embed scope="v3"><div className="v3-viz">{<Vis k={k} big={big} />}</div></Embed></div>
      <div className="vd-bt__t">
        <p className="vd-ftag">{by[k].tag}</p>
        <h3>{by[k].t}</h3>
        <p>{by[k].s}</p>
        {extra}
      </div>
    </Reveal>
  );
  return (
    <section className="vd-sec" id="features">
      <Head title={<>The whole market.<br /><span>One SoDEX account.</span></>} />
      <div className="vd-bento">
        {tile('liq', 'is-big', <div className="vd-bt__venues">{GRID_VENUES.map((v) => <span key={v}><VenueLogo venue={v} size={16} />{VENUE_LABEL[v]}</span>)}</div>, true)}
        {tile('copy', 'is-tall', <div className="vd-bt__traders"><p className="h-card__sub">Top copy scores, last 30 days <span className="h-live">Live</span></p><TopTraders on /></div>)}
        {tile('bots', '', <p className="vd-bt__num"><b><Count to={live.marketCount} fmt={(x) => String(Math.round(x))} /></b> SoDEX markets a bot can run on</p>)}
        {tile('flow', '')}
        {tile('always', '')}
        {tile('cross', '', <p className="vd-bt__num"><b><Count to={live.volumeH} fmt={usdShort} /></b> traded per hour on SoDEX's bot markets</p>)}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------------------------------ D: scroll ----- */

export function FeaturesScroll() {
  const [at, setAt] = useState(0);
  const refs = useRef<Array<HTMLDivElement | null>>([]);
  useEffect(() => {
    if (typeof IntersectionObserver !== 'function') return;
    const io = new IntersectionObserver((es) => {
      for (const e of es) if (e.isIntersecting) setAt(Number((e.target as HTMLElement).dataset.i));
    }, { rootMargin: '-45% 0px -45% 0px' });
    refs.current.forEach((el) => el && io.observe(el));
    return () => io.disconnect();
  }, []);
  const f = FEATS[at]!;
  return (
    <section className="vd-sec" id="features">
      <div className="vd-fs">
        <div className="vd-fs__side">
          <Eyebrow>Features</Eyebrow>
          <h2 className="h-h2">One desk.<br /><span>Six jobs.</span></h2>
          <div className="vd-fs__now" key={f.k}>
            <span className="vd-ic">{f.ic}</span>
            <p className="vd-ftag">{f.tag}</p>
            <h3>{f.t}</h3>
            <p>{f.s}</p>
          </div>
          <ol className="vd-fs__dots">{FEATS.map((x, i) => <li key={x.k} className={cx(i === at && 'is-on')} style={{ '--i': i } as CSSProperties} />)}</ol>
        </div>
        <div className="vd-fs__cards">
          {FEATS.map((x, i) => (
            <div key={x.k} ref={(el) => { refs.current[i] = el; }} data-i={i} className={cx('vd-fs__card', i === at && 'is-on')}>
              <Embed scope="v3"><div className="v3-viz">{<Vis k={x.k} big />}</div></Embed>
              <p className="vd-fs__cap"><b>{x.t}</b> {x.tag}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
