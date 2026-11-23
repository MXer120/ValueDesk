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
      <li><i />Up and running in 3 signatures</li>
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
    <SitePage title="ValueDesk: bots, copy trading and analytics on SoDEX" home="/home/5" whale={{ from: [1.2, 0.35, -64, 0.9], to: [-0.2, 0.78, -80, 1.15], opacity: 0.36 }}>
      <header className="h-hero vd-hh">
        <div className="vd-hh__heat" aria-hidden="true"><HeatGlass layout="right" rib={28} /></div>
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
        <ChromeV />
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

/* ------------------------------------------------------------------------------------------- version 6 ----- */

export function V6() {
  const live = useLiveDesk();
  const start = startFromText(live.startFrom);
  return (
    <SitePage title={`ValueDesk: SoDEX bots from ${bp(FEES.botLowest)}, start with ${start}`} home="/home/6" whale={{ from: [1.12, 0.3, -62, 0.9], to: [-0.2, 0.62, -80, 1.15], opacity: 0.38, color: '196, 188, 255' }}>
      <Embed scope="v4">
        <header className="v4-hero">
          <div className="v4-hero__bg" aria-hidden="true"><HeatGlass layout="right" rib={28} className="v4-hero__heat" /></div>
          <div className="v4-hero__in">
            <div className="v4-hero__t">
              <div className="v4-up"><p className="v4-kicker"><i />Bots, copy trading and analytics on SoDEX</p></div>
              <h1 className="v4-h1 v4-up" style={{ '--d': '80ms' } as CSSProperties}>
                <span className="v4-h1__a">Start with <em>{start}.</em></span>
                <span className="v4-h1__b">Bots from {bp(FEES.botLowest)}.</span>
                <span className="v4-cond"><span className="v4-vip vip-pill">VIP</span>{VIP_RULE}</span>
              </h1>
              <p className="v4-sub v4-up" style={{ '--d': '160ms' } as CSSProperties}>
                Up and running in three free signatures. Your funds stay in your SoDEX account; the bots run around the clock on our executor in Tokyo. A new wallet pays <b>{bp(FEES.botNew)}</b> per bot order.
              </p>
              <div className="v4-cta v4-up" style={{ '--d': '240ms' } as CSSProperties}>
                <a href="/bots/new" className="v4-btn is-light">Start a bot<Arrow /></a>
                <a href="/copy" className="v4-btn is-glass">Copy a trader</a>
              </div>
              <p className="v4-fine v4-up" style={{ '--d': '300ms' } as CSSProperties}>SoDEX charges its own trading fee on top.</p>
            </div>
            <div className="v4-up v4-hero__tk" style={{ '--d': '200ms' } as CSSProperties}>
              <Ticker rows={live.rows} marketCount={live.marketCount} volumeH={live.volumeH} />
            </div>
          </div>
        </header>
      </Embed>

      <div className="vd-layer"><Embed scope="v3"><V3SignTiles /></Embed></div>
      <div className="vd-layer"><Embed scope="v3"><V3Safety /></Embed></div>
      <div className="vd-layer"><Embed scope="v3"><V3Features live={live} /></Embed></div>
      <CalcSection makerBps={live.makerBps} initial="points" />
      <Embed scope="v2"><Money /></Embed>
      <Products />
      <Embed scope="v2"><Faq items={FAQ_HOME} title="Before you start." /></Embed>
    </SitePage>
  );
}

/* ------------------------------------------------------------------------------------------- version 7 ----- */

export function V7() {
  const live = useLiveDesk();
  const start = startFromText(live.startFrom);
  return (
    <SitePage title="ValueDesk: one desk for SoDEX" home="/home/7" whale={{ from: [1.1, 0.55, -60, 0.85], to: [-0.15, 0.7, -82, 1.2], opacity: 0.4 }}>
      <header className="vd-center">
        <div className="vd-center__heat" aria-hidden="true"><HeatGlass layout="wide" rib={30} /></div>
        <ChromeV />
        <div className="h-up" style={{ '--d': '60ms' } as CSSProperties}><Eyebrow>Live on SoDEX · bots, copy trading, analytics</Eyebrow></div>
        <div className="h-up" style={{ '--d': '120ms' } as CSSProperties}><h1 className="h-h1">One desk<br /><span>for all of SoDEX.</span></h1></div>
        <p className="h-sub h-up" style={{ '--d': '180ms' } as CSSProperties}>Run a market maker, copy a trader, read where the liquidations sit. From your own SoDEX account, set up in three free signatures.</p>
        <div className="vd-start h-up" style={{ '--d': '220ms' } as CSSProperties}><small>Start with</small><b>{start}</b><em>no deposit to us</em></div>
        <div className="h-cta h-up" style={{ '--d': '260ms' } as CSSProperties}>
          <a href="/bots/new" className="h-btn is-light">Start a bot<Arrow /></a>
          <a href="/copy" className="h-btn is-glass">Copy a trader</a>
        </div>
        <div className="h-up" style={{ '--d': '320ms' } as CSSProperties}><Trust /></div>
      </header>
      <Tape rows={live.rows} />

      <Embed scope="v2"><SetupScene /></Embed>

      <section className="vd-sec" id="products">
        <Reveal className="h-head">
          <Eyebrow>What it does</Eyebrow>
          <h2 className="h-h2">Four desks.<br /><span>One SoDEX account.</span></h2>
        </Reveal>
        <div className="vd-rows">
          <Row k="01 · Bots" title="Market makers that never sleep." vis={<BookViz />}>
            <p>Pick a market, a size and a loss limit. The bot rests quotes on both sides of the book on our servers, day and night.</p>
            <Ticks items={[<>Start with {start}</>, <>{bp(FEES.botNew)} per order for a new wallet, from {bp(FEES.botLowest)} for VIP</>, 'Runs with the tab closed']} />
            <a href={PAGE_PATHS.bots} className="h-link">All about bots<Arrow /></a>
          </Row>
          <Row k="02 · Copy trading" title="Follow any wallet." vis={<FollowViz />} flip>
            <p>Hyperliquid or SoDEX, trade for trade, at your size and under your leverage cap.</p>
            <Ticks items={['In your browser or hosted', `${bp(FEES.copyNew)} per copied order for a new wallet`, 'Stop with one click']} />
            <a href={PAGE_PATHS.copy} className="h-link">All about copy trading<Arrow /></a>
          </Row>
          <Row k="03 · Analytics" title="See the liquidations first." vis={<HeatViz />} visClass="is-heat">
            <p>Where positions get liquidated, who traded each candle, ETF flows and the macro calendar. Free.</p>
            <Ticks items={['Liquidation map, live and history', 'Who traded each candle', 'News, calendar, ETF flows']} />
            <a href={PAGE_PATHS.analytics} className="h-link">All about the analytics<Arrow /></a>
          </Row>
          <Row k="04 · Cross-venue" title="Five venues, side by side." vis={<Embed scope="v3"><HubViz /></Embed>} flip>
            <p>Traders, liquidations and positioning from SoDEX, Hyperliquid, trade.xyz, Lighter and Arcus, and funding compared between SoDEX and Hyperliquid.</p>
            <a href={PAGE_PATHS.cross} className="h-link">All about cross-venue<Arrow /></a>
          </Row>
        </div>
      </section>

      <div className="vd-layer"><Embed scope="v3"><V3Features live={live} /></Embed></div>
      <Embed scope="v2"><Money /></Embed>
      <CalcSection makerBps={live.makerBps} />
      <div className="vd-layer"><Embed scope="v3"><V3SignTiles /></Embed></div>
      <Embed scope="v2"><Faq items={FAQ_HOME} title="Questions, answered." /></Embed>
    </SitePage>
  );
}
