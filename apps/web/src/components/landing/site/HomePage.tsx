/**
 * The home page (owner 2026-11-24: version 5): the app's pages in 3D on a stage of liquidation heat, the live tape, the
 * feature cards, where the money goes, the calculators, the products, the questions. Every figure is live or a constant
 * of the fee ladders (shared.tsx); drawings carry no figures.
 */
import { type CSSProperties } from 'react';
import { Eyebrow, Arrow, BookViz, FollowViz, HeatViz, Reveal } from '../Home';
import { Money, Faq } from '../v2/V2';
import { V3Features, HubViz } from '../v3/V3';
import { HeatGlass } from '../v4/heat';
import { startFromText, useLiveDesk } from '../shared';
import { AppDesk } from './AppDesk';
import { Calcs } from './Calcs';
import { SiteTape } from './Tape';
import { qaFor } from './faq';
import { Embed, IC, ProductCards, SitePage } from './Site';
import '../v2/v2.css';
import '../v3/v3.css';
import '../v4/v4.css';
import '../../vip.css';

function Trust() {
  return (
    <ul className="h-trust is-checks">
      <li>{IC.check}Your funds stay in your SoDEX account</li>
      <li>{IC.check}Keys can't pay anyone else</li>
    </ul>
  );
}

function CalcSection({ makerBps, initial }: { makerBps: number | null; initial?: 'fees' | 'points' }) {
  return (
    <section className="vd-sec" id="calculators">
      <Reveal className="h-head is-center">
        <Eyebrow>Calculators</Eyebrow>
        <h2 className="h-h2">Run the numbers<br /><span>before you run a bot.</span></h2>
        <p className="h-lead">What the fee comes to at your volume, and roughly how many SoPoints that volume earns on SoDEX.</p>
      </Reveal>
      <Embed scope="v4"><Calcs makerBps={makerBps} initial={initial} /></Embed>
    </section>
  );
}

function Products() {
  return (
    <section className="vd-sec" id="products">
      <Reveal className="h-head">
        <Eyebrow>Products</Eyebrow>
        <h2 className="h-h2">Four desks.<br /><span>One SoDEX account.</span></h2>
        <p className="h-lead">Each has its own page with the details.</p>
      </Reveal>
      <ProductCards art={{ bots: <BookViz />, copy: <FollowViz />, analytics: <HeatViz />, cross: <Embed scope="v3"><HubViz /></Embed> }} />
    </section>
  );
}

const FAQ_HOME = qaFor('home');

export function HomePage() {
  const live = useLiveDesk();
  const start = startFromText(live.startFrom);
  return (
    <SitePage title="ValueDesk: bots, copy trading and analytics on SoDEX" current="home">
      <header className="vd-h5">
        <div className="vd-h5__heat" aria-hidden="true"><HeatGlass layout="stage" rib={28} every={90} scale={0.75} /></div>
        <div className="vd-h5__t">
          <div className="h-up" style={{ '--d': '60ms' } as CSSProperties}><h1 className="h-h1">The market, <span>on one desk.</span></h1></div>
          <div className="h-up" style={{ '--d': '140ms' } as CSSProperties}>
            <p className="h-sub">Market makers that run around the clock, copies of any Hyperliquid or SoDEX wallet, and the liquidation map to read it all. Every order lands in your own SoDEX account.</p>
          </div>
          <div className="h-up h-cta" style={{ '--d': '220ms' } as CSSProperties}>
            <a href="/bots/new" className="h-btn is-light vd-cta-main">Start with just {start}<Arrow /></a>
            <a href="/copy" className="h-btn is-glass vd-blur">Copy a trader</a>
          </div>
          <div className="h-up" style={{ '--d': '300ms' } as CSSProperties}><Trust /></div>
        </div>
        <AppDesk />
      </header>
      <SiteTape rows={live.rows} />

      <div className="vd-layer"><Embed scope="v3"><V3Features live={live} /></Embed></div>
      <Embed scope="v2"><Money /></Embed>
      <CalcSection makerBps={live.makerBps} />
      <Products />
      <Embed scope="v2"><Faq items={FAQ_HOME} title="Questions, answered." /></Embed>
    </SitePage>
  );
}
