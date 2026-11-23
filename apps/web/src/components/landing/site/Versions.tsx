/**
 * Landing versions 5-7 (owner 2026-11-23, picking from 1-4): built from the parts the owner liked -
 *   V1: the chrome V and the footer;  V2: how it works (the pinned scene), where your money goes, the FAQ;
 *   V3: the feature cards, "your funds stay yours", "up and running";  V4: the liquidation-heat header and the fee
 *   calculator, now with a SoPoints estimate beside it.
 * Each version leads differently:
 *   5 "Chrome on heat": V1's header with the chrome V standing in V4's heat; features, how, money, calculators, products.
 *   6 "Heat, then convert": V4's header and live ticker; setup and safety first, then features, calculators, money.
 *   7 "One desk, long": the V centred and large; the scene, a row per product, features, money, calculators, setup.
 * Every figure is live or a constant of the fee ladders (shared.tsx); drawings carry no figures.
 */
import { type CSSProperties } from 'react';
import { ChromeV, Eyebrow, Arrow, Tape, BookViz, FollowViz, HeatViz, Reveal } from '../Home';
import { SetupScene, Money, Faq } from '../v2/V2';
import { V3Features, V3Safety, V3SignTiles, HubViz } from '../v3/V3';
import { Ticker } from '../v4/V4';
import { HeatGlass } from '../v4/heat';
import { bp, FEES, startFromText, useLiveDesk } from '../shared';
import { Calcs } from './Calcs';
import { HeroDeck } from './HeroDeck';
import { qaFor } from './faq';
import { Embed, ProductCards, Row, SitePage, Ticks, PAGE_PATHS } from './Site';
import '../v2/v2.css';
import '../v3/v3.css';
import '../v4/v4.css';
import '../../vip.css';

const VIP_RULE = FEES.vipCondition.replace(/^VIP:\s*/, '');

function Trust() {
  return (
    <ul className="h-trust">
      <li><i />Your funds stay in your SoDEX account</li>
      <li><i />Bot fee from {bp(FEES.botLowest)} <span className="h-dim">(VIP)</span></li>
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

/* ------------------------------------------------------------------------------------------- version 5 ----- */

export function V5() {
  const live = useLiveDesk();
  const start = startFromText(live.startFrom);
  return (
    <SitePage title="ValueDesk: bots, copy trading and analytics on SoDEX" home="/home/5">
      <header className="h-hero vd-hh">
        <div className="vd-hh__heat" aria-hidden="true"><HeatGlass layout="calm" rib={28} /></div>
        <div className="h-hero__t">
          <div className="h-up"><Eyebrow>Live on SoDEX · bots, copy trading, analytics</Eyebrow></div>
          <div className="h-up" style={{ '--d': '80ms' } as CSSProperties}><h1 className="h-h1">The market,<br /><span>on one desk.</span></h1></div>
          <div className="h-up" style={{ '--d': '160ms' } as CSSProperties}>
            <p className="h-sub">Market makers that run around the clock, copies of any Hyperliquid or SoDEX wallet, and the liquidation map to read it all. Every order lands in your own SoDEX account.</p>
          </div>
          <div className="h-up h-cta" style={{ '--d': '240ms' } as CSSProperties}>
            <a href="/bots/new" className="h-btn is-light">Start a bot with {start}<Arrow /></a>
            <a href="/copy" className="h-btn is-glass">Copy a trader</a>
          </div>
          <div className="h-up" style={{ '--d': '320ms' } as CSSProperties}><Trust /></div>
        </div>
        <Embed scope="v3" className="vd-hd"><HeroDeck live={live} /></Embed>
      </header>
      <Tape rows={live.rows} />

      <div className="vd-layer"><Embed scope="v3"><V3Features live={live} /></Embed></div>
      <Embed scope="v2"><SetupScene /></Embed>
      <Embed scope="v2"><Money /></Embed>
      <CalcSection makerBps={live.makerBps} />
      <Products />
      <Embed scope="v2"><Faq items={FAQ_HOME} title="Questions, answered." /></Embed>
    </SitePage>
  );
}


