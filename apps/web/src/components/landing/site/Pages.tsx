/**
 * The site's product pages (owner 2026-11-23: "make some of the navbar elements actual pages ... analytics, copy
 * trading, bots and maybe the cross venue part"), plus Pricing. Paths: Site.tsx PAGE_PATHS.
 *
 * Facts only (shared.tsx header). What each page states and where it comes from:
 *   bots: live markets/volume/maker cost (useLiveDesk), fee ladders (FEES), perps and spot (spot bots live v0.2.238);
 *   copy: COPY_VENUES (Hyperliquid, SoDEX), the copy ladder, browser or hosted, the live top copy scores (Home TopTraders);
 *   analytics: SCAN_VENUES for the liquidation map and the traders, who-traded-each-candle, news/calendar/FOMC/ETF flows;
 *   cross-venue: the venue matrix is read off the code (vsPaths SCAN_VENUES, gridModel COPY_VENUES, explore fundingArb
 *   ArbVenue = sodex | hyperliquid; bots and copies trade on SoDEX only).
 * The drawings carry no figures.
 */
import { useState, type CSSProperties, type ReactNode } from 'react';
import { CoinIcon } from '../../CoinIcon';
import { VenueLogo } from '../../VenueLogo';
import { GRID_VENUES, COPY_VENUES } from '../../copy/gridModel';
import { VENUE_LABEL } from '../../../vsApi';
import { Arrow, BookViz, Count, Eyebrow, FollowViz, HeatViz, Reveal, TopTraders } from '../Home';
import { Faq, Money } from '../v2/V2';
import { FeatureFx, HubViz, SleepViz } from '../v3/V3';
import { Calculator } from '../v4/V4';
import { MarketConditions } from '../../bots/BotsRegime';
import '../../bots/botsPages.css';
import { HeatGlass } from '../v4/heat';
import { botHref, bp, DESK_WINDOW_TEXT, FEES, startFromText, usdShort, usdStep, useLiveDesk, type MarketRow } from '../shared';
import { Calcs } from './Calcs';
import { BotConsole, CopyConsole, FeatureMap, LiqMapViz } from './viz';
import './pages.css';
import { FeeCards } from './FeeCards';
import { qaFor } from './faq';
import { Embed, IC, Row, SiteFooter, SitePage, Ticks, PAGE_PATHS } from './Site';
import '../v2/v2.css';
import '../v3/v3.css';
import '../v4/v4.css';
import '../../vip.css';

const VIP_RULE = FEES.vipCondition.replace(/^VIP:\s*/, '');
const venueList = (vs: readonly string[]) => vs.map((v) => VENUE_LABEL[v as keyof typeof VENUE_LABEL]).join(', ');

/* --------------------------------------------------------------------------------------------- shared ----- */

/** A product page's hero (owner 2026-11-23: "left text is cluttered"): the title, one line, two buttons; the stage right. */
function PageHero({ title, sub, cta, stage }: { title: ReactNode; sub: ReactNode; cta: ReactNode; stage: ReactNode }) {
  return (
    <header className="vd-phero">
      <div>
        <h1 className="h-h1 h-up">{title}</h1>
        <p className="h-sub h-up" style={{ '--d': '80ms' } as CSSProperties}>{sub}</p>
        <div className="h-cta h-up" style={{ '--d': '160ms' } as CSSProperties}>{cta}</div>
      </div>
      <div className="vd-phero__stage h-up" style={{ '--d': '140ms' } as CSSProperties}>{stage}</div>
    </header>
  );
}

function Facts({ items }: { items: Array<{ v: ReactNode; l: ReactNode }> }) {
  return <div className="vd-facts">{items.map((f, i) => <div key={i}><b>{f.v}</b><span>{f.l}</span></div>)}</div>;
}

function Head({ k, title, lead, center }: { k: string; title: ReactNode; lead?: ReactNode; center?: boolean }) {
  return (
    <Reveal className={center ? 'h-head is-center' : 'h-head'}>
      <Eyebrow>{k}</Eyebrow>
      <h2 className="h-h2">{title}</h2>
      {lead && <p className="h-lead">{lead}</p>}
    </Reveal>
  );
}

function PerMillion({ b }: { b: number | null }) {
  if (b === null) return <span className="v4-dim">—</span>;
  const usd = `$${Math.round(Math.abs(b) * 100).toLocaleString('en-US')}`;
  return b <= 0 ? <b className="v4-pos">+{usd}</b> : <b>{usd}</b>;
}

/** The busiest SoDEX markets with the cheapest bot on each: six rows, a fade, and a button for the rest. */
function MarketTable({ rows, error }: { rows: MarketRow[]; error: string | null }) {
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, 6);
  return (
    <Embed scope="v4">
      <div className={all ? 'vd-mt is-all' : 'vd-mt'}>
        <div className="v4-table">
          <div className="v4-tr is-h" role="row"><span>Market</span><span>Volume / h</span><span className="v4-hide-s">Cheapest bot</span><span>Per $1M</span><span aria-hidden="true" /></div>
          {shown.length ? shown.map(({ m, bp: b, recipe, recipeId }) => (
            <a key={m.symbol} href={botHref({ m, recipeId })} className="v4-tr">
              <span className="v4-tr__m"><CoinIcon coin={m.base} venue="SODEX" size={24} /><b>{m.base}</b><small className="v4-dim">{m.symbol}</small></span>
              <span className="v4-num">{usdShort(m.volumeUsdH)}</span>
              <span className="v4-hide-s v4-dim2">{recipe ?? '—'}</span>
              <span className="v4-num"><PerMillion b={b} /></span>
              <span className="v4-tr__go"><span className="v4-hide-s">Start</span><Arrow /></span>
            </a>
          )) : [0, 1, 2, 3, 4].map((i) => <div key={i} className="v4-tr is-skel"><span /><span /><span /><span /><span /></div>)}
          {error && !rows.length && <p className="v4-dim" style={{ padding: 16 }}>The live markets could not be read just now.</p>}
        </div>
        {!all && rows.length > 6 && (
          <div className="vd-mt__more"><button type="button" className="h-btn is-glass" onClick={() => setAll(true)}>Show all {rows.length} markets</button></div>
        )}
      </div>
    </Embed>
  );
}

/** A grid bot: buy and sell levels across a range and the price walking through them. A drawing. */
function GridViz() {
  const levels = [0.12, 0.26, 0.4, 0.54, 0.68, 0.82];
  return (
    <div className="vd-grid" aria-hidden="true">
      {levels.map((y, i) => <i key={y} className={i < 3 ? 'is-sell' : 'is-buy'} style={{ top: `${y * 100}%` }}><b>{i < 3 ? 'sell' : 'buy'}</b></i>)}
      <svg viewBox="0 0 100 100" preserveAspectRatio="none">
        <path pathLength={1} d="M0 60 C8 50 12 72 20 68 S30 40 38 44 S48 70 56 66 S66 30 74 34 S86 58 100 50" vectorEffect="non-scaling-stroke" />
      </svg>
      {[[20, 68, '0.8s'], [38, 40, '1.8s'], [56, 68, '2.9s'], [74, 26, '3.9s']].map(([x, y, d]) => (
        <svg key={String(x)} viewBox="0 0 100 100" preserveAspectRatio="none" style={{ position: 'absolute', inset: 0 }}><circle cx={x as number} cy={y as number} r="1.6" style={{ '--d': d } as CSSProperties} /></svg>
      ))}
    </div>
  );
}

/** Who traded a candle: each candle's volume split by kind of trader. A drawing; the bars are not data. */
export function CandleViz() {
  const bars = [[30, 22, 8], [18, 30, 4], [42, 16, 12], [26, 26, 6], [50, 20, 16], [22, 36, 5], [34, 24, 10], [16, 18, 3]];
  return (
    <>
      <div className="vd-candles" aria-hidden="true">
        {bars.map(([b, s, w], i) => (
          <div key={i}>
            <span className="w" style={{ height: w! * 2.2, '--d': `${i * 70}ms` } as CSSProperties} />
            <span className="b" style={{ height: b! * 2.2, '--d': `${i * 70 + 40}ms` } as CSSProperties} />
            <span className="s" style={{ height: s! * 2.2, '--d': `${i * 70 + 80}ms` } as CSSProperties} />
          </div>
        ))}
      </div>
      <div className="vd-legend" aria-hidden="true"><span><i style={{ background: '#e3b65a' }} />largest wallet</span><span><i style={{ background: '#4fe3b3' }} />buys</span><span><i style={{ background: 'rgba(255,255,255,.55)' }} />sells</span></div>
    </>
  );
}

/** The calendar and news: event kinds as the app lists them. A drawing; no dates or figures. */
function CalendarViz() {
  const items: Array<[string, string, string, boolean]> = [['Macro', 'US inflation release', 'figures', false], ['Fed', 'FOMC rate decision', 'odds', true], ['Fed', 'Press conference', 'live', true], ['Flows', 'Bitcoin ETF flows', 'daily', false], ['News', 'Headlines that move coins', 'feed', false]];
  return (
    <div className="vd-cal" aria-hidden="true">
      {items.map(([k, t, tag, hot], i) => <div key={t} style={{ '--d': `${i * 110}ms` } as CSSProperties}><small>{k}</small><span>{t}</span><em className={hot ? 'is-hot' : undefined}>{tag}</em></div>)}
    </div>
  );
}

/** The funding scanner's idea: the same coin on two venues, long where funding is lower, short where higher. A drawing. */
function ArbViz() {
  return (
    <div className="vd-arb" aria-hidden="true">
      <div className="vd-arb__leg"><VenueLogo venue="sodex" size={22} /><b>SoDEX</b><em className="is-long">long · lower funding</em></div>
      <p className="vd-arb__mid">same coin · rates scaled to 8 h · spread annualised</p>
      <div className="vd-arb__leg"><VenueLogo venue="hyperliquid" size={22} /><b>Hyperliquid</b><em className="is-short">short · higher funding</em></div>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------ bots ----- */

/** Two bots, side by side and compact (owner 2026-11-23: the old rows mixed bot types and features and were too big). */
function BotTypes() {
  return (
    <div className="vd-two">
      <Reveal className="vd-type">
        <FeatureFx v={1} />
        <div className="vd-type__vis"><BookViz /></div>
        <p className="vd-row__k">Market maker</p>
        <h3>Quotes on both sides of the book.</h3>
        <p>Rests a bid and an ask at the best prices and earns the spread when both fill, within the size and holding you allow.</p>
      </Reveal>
      <Reveal className="vd-type" delay={90}>
        <FeatureFx v={4} />
        <div className="vd-type__vis"><GridViz /></div>
        <p className="vd-row__k">Grid</p>
        <h3>Buys low, sells high, step by step.</h3>
        <p>Orders at set steps across a price range; as the price moves through them, each step buys or sells.</p>
      </Reveal>
    </div>
  );
}

export function BotsPage() {
  const live = useLiveDesk();
  const start = startFromText(live.startFrom);
  return (
    <SitePage title={`Trading bots on SoDEX · start with ${start} · ValueDesk`} current="bots" footer={<SiteFooter title={<>Your first bot,<br /><span>with {start}.</span></>} />}>
      <PageHero
        title={<>Bots that trade<br /><span>while you sleep.</span></>}
        sub="A market maker or a grid on SoDEX, running around the clock from your own account."
        cta={<><a href="/bots/new" className="h-btn is-light vd-cta-main">Start with just {start}<Arrow /></a><a href="/bots/explore" className="h-btn is-glass">Every market</a></>}
        stage={<Embed scope="v3"><BotConsole rows={live.rows} /></Embed>}
      />
      <Facts items={[
        { v: <Count to={live.marketCount} fmt={(x) => String(Math.round(x))} />, l: 'SoDEX markets a bot can run on' },
        { v: <Count to={live.volumeH} fmt={usdShort} />, l: 'traded on them per hour' },
        { v: start, l: 'enough to start' },
        { v: <span className="vip-text">{bp(FEES.botLowest)}</span>, l: <>lowest bot fee · <span className="vip-pill">VIP</span> {VIP_RULE}</> },
      ]} />

      <section className="vd-sec">
        <Head k="Two bots" title={<>Pick one.<br /><span>Set your limits.</span></>} />
        <Embed scope="v3"><BotTypes /></Embed>
      </section>

      <section className="vd-sec">
        <Head k="Every setting" title={<>Everything a bot<br /><span>can do for you.</span></>} lead="Each one is a switch in the bot's settings. Use as many as you like." />
        <Reveal><FeatureMap /></Reveal>
      </section>

      <section className="vd-sec">
        <Head k="Live from SoDEX" title={<>Where the volume is.<br /><span>Start there.</span></>} />
        <MarketTable rows={live.rows} error={live.error} />
      </section>

      <section className="vd-sec">
        <Head k="Market conditions" title={<>Who is trading,<br /><span>and how calm it is.</span></>} lead="The same board the Bots page shows: the share of uninformed flow, informed flow and volatility on every market." />
        <Reveal className="vd-app"><MarketConditions /></Reveal>
      </section>

      <section className="vd-sec">
        <Head k="Fee calculator" title={<>What it comes to<br /><span>at your volume.</span></>} center />
        <Embed scope="v4"><Calculator makerBps={live.makerBps} actions={<a href="/bots/new" className="v4-btn is-light is-block">Start with just {start}<Arrow /></a>} /></Embed>
      </section>

      <Embed scope="v2"><Faq items={qaFor('bots')} title="About bots." /></Embed>
    </SitePage>
  );
}

/* ------------------------------------------------------------------------------------------------ copy ----- */

/** Copy or counter: the same leader line, followed on one side and mirrored on the other. */
function CopyOrCounter() {
  const lead = 'M0 70 C40 64 70 30 110 40 S170 80 210 56 S270 16 320 12';
  return (
    <div className="vd-two">
      <Reveal className="vd-type">
        <FeatureFx v={1} />
        <div className="vd-type__vis vd-cc">
          <svg viewBox="0 0 320 90" preserveAspectRatio="none"><path className="is-lead" d={lead} /><path className="is-copy" d={lead} transform="translate(0 6)" /></svg>
        </div>
        <p className="vd-row__k">Copy</p>
        <h3>The same trade, at your size.</h3>
        <p>When the leader buys, you buy. Their exits are yours too, under your leverage cap.</p>
      </Reveal>
      <Reveal className="vd-type" delay={90}>
        <FeatureFx v={5} />
        <div className="vd-type__vis vd-cc">
          <svg viewBox="0 0 320 90" preserveAspectRatio="none"><path className="is-lead" d={lead} /><path className="is-counter" d={lead} transform="matrix(1 0 0 -1 0 90)" /></svg>
        </div>
        <p className="vd-row__k">Counter</p>
        <h3>The opposite trade, on purpose.</h3>
        <p>Pick a wallet that keeps losing and take the other side of every trade it makes.</p>
      </Reveal>
    </div>
  );
}

export function CopyPage() {
  const copyNames = venueList(COPY_VENUES);
  return (
    <SitePage title="Copy trading on SoDEX · follow Hyperliquid and SoDEX wallets · ValueDesk" current="copy" footer={<SiteFooter title={<>Follow a trader<br /><span>you trust.</span></>} />}>
      <PageHero
        title={<>Follow any wallet.<br /><span>Trade for trade.</span></>}
        sub="Copy, or counter, any Hyperliquid or SoDEX trader from your own SoDEX account."
        cta={<><a href="/copy" className="h-btn is-light vd-cta-main">Copy a trader<Arrow /></a><a href="/leaderboard" className="h-btn is-glass">Leaderboard</a></>}
        stage={<Embed scope="v3"><CopyConsole /></Embed>}
      />
      <Facts items={[
        { v: COPY_VENUES.length, l: `venues to copy from: ${copyNames}` },
        { v: bp(FEES.copyNew), l: 'per copied order, new wallet' },
        { v: bp(FEES.copyLowest), l: FEES.copyLowestCondition },
        { v: '24/7', l: 'hosted copies, on our executor' },
      ]} />

      <section className="vd-sec">
        <Head k="Two directions" title={<>Copy them.<br /><span>Or bet against them.</span></>} />
        <Embed scope="v3"><CopyOrCounter /></Embed>
      </section>

      <section className="vd-sec">
        <Head k="How it copies" title={<>Their trades.<br /><span>Your rules.</span></>} />
        <Embed scope="v3">
          <div className="vd-three">
            <Reveal className="vd-type">
              <FeatureFx v={2} />
              <div className="vd-type__vis is-list"><p className="h-card__sub">Top copy scores, last 30 days <span className="h-live">Live</span></p><TopTraders on /></div>
              <p className="vd-row__k">Pick a leader</p>
              <h3>From the leaderboards</h3>
              <p>Every venue ranked, or paste any address.</p>
            </Reveal>
            <Reveal className="vd-type" delay={80}>
              <FeatureFx v={3} />
              <div className="vd-type__vis"><FollowViz /></div>
              <p className="vd-row__k">Your size</p>
              <h3>Scaled to you</h3>
              <p>Your size and leverage cap; only new positions, or join open ones.</p>
            </Reveal>
            <Reveal className="vd-type" delay={160}>
              <FeatureFx v={4} />
              <div className="vd-type__vis"><SleepViz /></div>
              <p className="vd-row__k">Browser or hosted</p>
              <h3>Around the clock</h3>
              <p>Hosted copies run on our executor in Tokyo, also with the laptop closed.</p>
            </Reveal>
          </div>
        </Embed>
      </section>

      <section className="vd-sec">
        <Head k="Fees" title={<>{bp(FEES.copyNew)} per copied order,<br /><span>less as you copy more.</span></>} lead={`Volume counts over ${FEES.windowDays} days. SoDEX charges its own trading fee on top.`} />
        <FeeCards start={startFromText(null)} only="copy" />
      </section>

      <Embed scope="v2"><Money /></Embed>
      <Embed scope="v2"><Faq items={qaFor('copy')} title="About copy trading." /></Embed>
    </SitePage>
  );
}

/* ------------------------------------------------------------------------------------------- analytics ----- */

const AN_TILES: Array<{ t: string; s: string; ic: ReactNode; href: string }> = [
  { t: 'Liquidation map', s: 'Every open position\'s liquidation price, over the chart', ic: IC.heat, href: '/trade' },
  { t: 'Liquidation history', s: 'The recorded map, back in time', ic: <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" /><path d="M12 7v5l3 2" /></svg>, href: '/trade' },
  { t: 'Who traded each candle', s: 'Each candle\'s volume by the wallets behind it', ic: <svg viewBox="0 0 24 24"><path d="M6 20V9M12 20V4M18 20v-7" /></svg>, href: '/trade' },
  { t: 'Leaderboards', s: 'Traders on every venue, ranked', ic: <svg viewBox="0 0 24 24"><path d="M5 20V10M12 20V4M19 20v-7" /></svg>, href: '/leaderboard' },
  { t: 'Wallet scan', s: 'Any wallet: trades, positions, history', ic: <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6" /><path d="m20 20-4.5-4.5" /></svg>, href: '/scan' },
  { t: 'Cohorts', s: 'How the big wallets are positioned', ic: <svg viewBox="0 0 24 24"><circle cx="8" cy="9" r="3" /><circle cx="16" cy="9" r="3" /><path d="M3 19c1-3 3-4 5-4s4 1 5 4M11 19c1-3 3-4 5-4s4 1 5 4" /></svg>, href: '/explore?view=cohorts' },
  { t: 'Market map', s: 'Every SoDEX market and sector at a glance', ic: <svg viewBox="0 0 24 24"><rect x="3" y="4" width="10" height="9" rx="1" /><rect x="15" y="4" width="6" height="5" rx="1" /><rect x="15" y="11" width="6" height="9" rx="1" /><rect x="3" y="15" width="10" height="5" rx="1" /></svg>, href: '/explore' },
  { t: 'Funding scanner', s: 'SoDEX against Hyperliquid, a panel for your dashboard', ic: <svg viewBox="0 0 24 24"><path d="M4 8h12l-3-3M20 16H8l3 3" /></svg>, href: '/trade' },
  { t: 'News', s: 'The headlines that move coins', ic: <svg viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="14" rx="2" /><path d="M8 9h8M8 13h8M8 17h5" /></svg>, href: '/trade' },
  { t: 'Macro calendar', s: 'Releases, with the figures as they land', ic: <svg viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="15" rx="2" /><path d="M4 10h16M9 3v4M15 3v4" /></svg>, href: '/trade' },
  { t: 'FOMC odds and Fed live', s: 'Rate odds, and the press conference as it happens', ic: <svg viewBox="0 0 24 24"><path d="M4 10 12 5l8 5M6 10v8M10 10v8M14 10v8M18 10v8M4 20h16" /></svg>, href: '/trade' },
  { t: 'ETF flows', s: 'Daily Bitcoin ETF flows', ic: <svg viewBox="0 0 24 24"><path d="M4 16l5-5 4 3 7-7" /><path d="M15 7h5v5" /></svg>, href: '/trade' },
];

/** The analytics hero: the liquidation map in a terminal frame, with the controls the real one has. */
function MapFrame() {
  return (
    <div className="vd-frame">
      <div className="vd-frame__bar">
        <span className="vd-frame__coin"><CoinIcon coin="BTC" venue="SODEX" size={18} />BTC</span>
        <span className="vd-frame__seg"><b>Live</b><span>History</span></span>
        <span className="vd-frame__venues">{GRID_VENUES.map((v) => <VenueLogo key={v} venue={v} size={16} />)}</span>
        <span className="vd-frame__legend"><small>fewer</small><i /><small>more liquidations</small></span>
      </div>
      <LiqMapViz className="vd-frame__map" />
    </div>
  );
}

export function AnalyticsPage() {
  return (
    <SitePage title="Crypto liquidation map, order flow and macro calendar · free · ValueDesk" current="analytics" footer={<SiteFooter title={<>Read the market.<br /><span>Free.</span></>} />}>
      <header className="vd-ahero">
        <h1 className="h-h1 h-up">See where the<br /><span>liquidations sit.</span></h1>
        <p className="h-sub h-up" style={{ '--d': '80ms' } as CSSProperties}>Five venues, one map, and everything else around the price. Free, no wallet needed.</p>
        <div className="h-cta h-up" style={{ '--d': '140ms' } as CSSProperties}><a href="/trade" className="h-btn is-light vd-cta-main">Open the terminal<Arrow /></a><a href={PAGE_PATHS.cross} className="h-btn is-glass">Cross-venue</a></div>
        <div className="h-up vd-ahero__frame" style={{ '--d': '200ms' } as CSSProperties}><MapFrame /></div>
      </header>

      <section className="vd-sec">
        <Head k="Everything around the price" title={<>Twelve views.<br /><span>All free.</span></>} />
        <div className="vd-tiles">
          {AN_TILES.map((t, i) => (
            <Reveal key={t.t} delay={(i % 4) * 60}>
              <a href={t.href} className="vd-tile2"><span className="vd-ic">{t.ic}</span><b>{t.t}</b><small>{t.s}</small></a>
            </Reveal>
          ))}
        </div>
      </section>

      <section className="vd-sec">
        <Embed scope="v3">
          <div className="vd-two">
            <Reveal className="vd-type">
              <FeatureFx v={2} />
              <div className="vd-type__vis vd-fv-candles2"><CandleViz /></div>
              <p className="vd-row__k">Order flow</p>
              <h3>Who traded each candle.</h3>
              <p>A sidebar beside the chart breaks each candle's volume down by the wallets that traded it.</p>
            </Reveal>
            <Reveal className="vd-type" delay={90}>
              <FeatureFx v={5} />
              <div className="vd-type__vis"><CalendarViz /></div>
              <p className="vd-row__k">Macro</p>
              <h3>News, calendar, Fed live.</h3>
              <p>Release figures as they land, FOMC odds, the press conference live and Bitcoin ETF flows.</p>
            </Reveal>
          </div>
        </Embed>
      </section>

      <section className="vd-sec">
        <CrossBlock />
      </section>

      <Embed scope="v2"><Faq items={qaFor('analytics')} title="About the analytics." /></Embed>
    </SitePage>
  );
}

/* ----------------------------------------------------------------------------------------- cross-venue ----- */

const MATRIX: Array<{ t: string; on: readonly string[]; off?: string }> = [
  { t: 'Traders and leaderboards', on: GRID_VENUES },
  { t: 'Liquidation map', on: GRID_VENUES },
  // Discover tags the others "View only": copying them is not supported yet (copy/Discover.tsx).
  { t: 'Copy a trader from', on: COPY_VENUES, off: 'view only' },
  { t: 'Funding compared', on: ['sodex', 'hyperliquid'] },
  { t: 'Bots and copies trade on', on: ['sodex'] },
];

function Matrix() {
  return (
    <div className="vd-tablebox">
      <table className="vd-matrix">
        <thead><tr><th />{GRID_VENUES.map((v) => <th key={v}><span><VenueLogo venue={v} size={16} />{VENUE_LABEL[v]}</span></th>)}</tr></thead>
        <tbody>
          {MATRIX.map((r) => (
            <tr key={r.t}><td>{r.t}</td>{GRID_VENUES.map((v) => <td key={v} className={r.on.includes(v) ? 'y' : 'n'} aria-label={r.on.includes(v) ? 'yes' : r.off ?? 'no'}>{r.on.includes(v) ? <span className="vd-yes">{IC.check}</span> : r.off ? <small>{r.off}</small> : '–'}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The cross-venue block the Analytics page carries: the venues, the matrix, the way to the page. */
function CrossBlock() {
  return (
    <Reveal className="vd-xblock">
      <FeatureFx v={4} />
      <div className="vd-xblock__t">
        <p className="vd-row__k">Cross-venue</p>
        <h3>Five venues, read as one.</h3>
        <p>Traders, liquidations and positioning from {venueList(GRID_VENUES)}; funding compared between SoDEX and Hyperliquid.</p>
        <a href={PAGE_PATHS.cross} className="h-link">All about cross-venue<Arrow /></a>
      </div>
      <Matrix />
    </Reveal>
  );
}

export function CrossVenuePage() {
  return (
    <SitePage title="Cross-venue: traders, liquidations and funding across five venues · ValueDesk" current="cross" footer={<SiteFooter title={<>Every venue,<br /><span>one desk.</span></>} />}>
      <PageHero
        title={<>Five venues.<br /><span>One view.</span></>}
        sub={`${venueList(GRID_VENUES)}: traders, liquidations and positioning side by side.`}
        cta={<><a href="/explore" className="h-btn is-light vd-cta-main">Open Explore<Arrow /></a><a href="/leaderboard" className="h-btn is-glass">Leaderboard</a></>}
        stage={<Embed scope="v3"><div className="vd-con is-hub"><FeatureFx v={3} /><HubViz /></div></Embed>}
      />
      <Facts items={[
        { v: GRID_VENUES.length, l: 'venues read' },
        { v: COPY_VENUES.length, l: 'venues to copy from' },
        { v: 2, l: 'venues in the funding scanner' },
        { v: 'Free', l: 'to read, no wallet needed' },
      ]} />

      <section className="vd-sec">
        <Head k="What each venue adds" title={<>Read everywhere.<br /><span>Trade on SoDEX.</span></>} />
        <Reveal><Matrix /></Reveal>
      </section>

      <section className="vd-sec">
        <Head k="Four views across venues" title={<>One screen,<br /><span>every venue.</span></>} />
        <Embed scope="v3">
          <div className="vd-two">
            <Reveal className="vd-type">
              <FeatureFx v={1} />
              <div className="vd-type__vis is-list"><p className="h-card__sub">Top copy scores, last 30 days <span className="h-live">Live</span></p><TopTraders on /></div>
              <p className="vd-row__k">Traders</p>
              <h3>Every venue's traders, one leaderboard.</h3>
              <p>All five venues in one list, or filtered to one.</p>
            </Reveal>
            <Reveal className="vd-type" delay={90}>
              <FeatureFx v={2} />
              <div className="vd-type__vis"><FollowViz /></div>
              <p className="vd-row__k">Copy across</p>
              <h3>Hyperliquid trader, SoDEX trades.</h3>
              <p>Follow a wallet on Hyperliquid; your copy trades the same market on SoDEX.</p>
            </Reveal>
            <Reveal className="vd-type">
              <FeatureFx v={3} />
              <div className="vd-type__vis"><ArbViz /></div>
              <p className="vd-row__k">Funding</p>
              <h3>The funding gap between two venues.</h3>
              <p>Each coin on SoDEX and Hyperliquid, both rates scaled to 8 hours, the live spread annualised.</p>
            </Reveal>
            <Reveal className="vd-type" delay={90}>
              <FeatureFx v={5} />
              <div className="vd-type__vis is-map"><LiqMapViz cols={48} /></div>
              <p className="vd-row__k">Liquidations</p>
              <h3>All venues' liquidations on one map.</h3>
              <p>Positions from every venue summed by liquidation price, or one venue alone.</p>
            </Reveal>
          </div>
        </Embed>
      </section>

      <Embed scope="v2"><Faq items={qaFor('cross')} title="About cross-venue." /></Embed>
    </SitePage>
  );
}

/* --------------------------------------------------------------------------------------------- pricing ----- */

export function PricingPage() {
  const live = useLiveDesk();
  const start = startFromText(live.startFrom);
  return (
    <SitePage title={`Fees · bots from ${bp(FEES.botLowest)} · ValueDesk`} current="fees">
      <header className="vd-sec" style={{ paddingTop: 56 }}>
        <p className="vd-crumb h-up"><a href="/home">ValueDesk</a><span>/</span><span>Fees</span></p>
        <div className="h-head is-center h-up">
          <Eyebrow>Fees</Eyebrow>
          <h1 className="h-h1">Pay on what runs.<br /><span>Nothing else.</span></h1>
          <p className="h-lead">No subscription, no deposit. A fee in basis points on the orders a bot or a copy places, lower as your {FEES.windowDays}-day volume grows. 1 bp = 0.01% of the order's value.</p>
        </div>
      </header>
      <section className="vd-sec" style={{ paddingTop: 20 }}>
        <FeeCards start={start} />
        <p className="h-note">SoDEX charges its own trading fee on every fill, on top{live.makerBps === null ? '' : ` (maker ${live.makerBps} bp now)`}.</p>
      </section>
      <section className="vd-sec">
        <Head k="Calculators" title={<>What it comes to<br /><span>at your volume.</span></>} center />
        <Embed scope="v4"><Calcs makerBps={live.makerBps} /></Embed>
      </section>
      <Embed scope="v2"><Faq items={qaFor('pricing')} title="About fees." /></Embed>
    </SitePage>
  );
}

export const SITE_PAGES = { bots: BotsPage, 'copy-trading': CopyPage, analytics: AnalyticsPage, 'cross-venue': CrossVenuePage, fees: PricingPage } as const;
export { IC };
