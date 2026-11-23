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
import { type CSSProperties, type ReactNode } from 'react';
import { CoinIcon } from '../../CoinIcon';
import { VenueLogo } from '../../VenueLogo';
import { GRID_VENUES, COPY_VENUES } from '../../copy/gridModel';
import { VENUE_LABEL } from '../../../vsApi';
import { Arrow, BookViz, Count, Eyebrow, FollowViz, HeatViz, Reveal, TopTraders } from '../Home';
import { Faq, Money } from '../v2/V2';
import { BotPanel, CopyPanel, HubViz, PickerViz, SleepViz, V3SignTiles } from '../v3/V3';
import { HeatGlass } from '../v4/heat';
import { bp, DESK_WINDOW_TEXT, FEES, startFromText, usdShort, usdStep, useLiveDesk, type MarketRow } from '../shared';
import { Calcs } from './Calcs';
import { qaFor } from './faq';
import { Embed, IC, Row, SiteFooter, SitePage, Ticks, PAGE_PATHS } from './Site';
import '../v2/v2.css';
import '../v3/v3.css';
import '../v4/v4.css';
import '../../vip.css';

const VIP_RULE = FEES.vipCondition.replace(/^VIP:\s*/, '');
const venueList = (vs: readonly string[]) => vs.map((v) => VENUE_LABEL[v as keyof typeof VENUE_LABEL]).join(', ');

/* --------------------------------------------------------------------------------------------- shared ----- */

function PageHero({ crumb, kicker, title, sub, cta, stage, stageHeat = 'card' }: { crumb: string; kicker: string; title: ReactNode; sub: ReactNode; cta: ReactNode; stage: ReactNode; stageHeat?: 'card' | 'wide' | 'right' | null }) {
  return (
    <header className="vd-phero">
      <div>
        <p className="vd-crumb h-up"><a href="/home">ValueDesk</a><span>/</span><span>{crumb}</span></p>
        <div className="h-up" style={{ '--d': '60ms' } as CSSProperties}><Eyebrow>{kicker}</Eyebrow></div>
        <h1 className="h-h1 h-up" style={{ '--d': '120ms' } as CSSProperties}>{title}</h1>
        <p className="h-sub h-up" style={{ '--d': '180ms' } as CSSProperties}>{sub}</p>
        <div className="h-cta h-up" style={{ '--d': '240ms' } as CSSProperties}>{cta}</div>
      </div>
      <div className="vd-stage h-up" style={{ '--d': '200ms' } as CSSProperties}>
        {stageHeat && <div className="vd-stage__bg" aria-hidden="true"><HeatGlass layout={stageHeat} rib={22} /></div>}
        {stage}
      </div>
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

/** The busiest SoDEX markets with the cheapest bot on each (V4's table). */
function MarketTable({ rows, error }: { rows: MarketRow[]; error: string | null }) {
  const table = rows.slice(0, 10);
  return (
    <Embed scope="v4">
      <div className="v4-table">
        <div className="v4-tr is-h" role="row"><span>Market</span><span>Volume / h</span><span className="v4-hide-s">Cheapest bot</span><span>Per $1M</span><span aria-hidden="true" /></div>
        {table.length ? table.map(({ m, bp: b, recipe }) => (
          <a key={m.symbol} href={`/bots/new?market=${encodeURIComponent(m.symbol)}&kind=market`} className="v4-tr">
            <span className="v4-tr__m"><CoinIcon coin={m.base} size={24} /><b>{m.base}</b><small className="v4-dim">{m.symbol}</small></span>
            <span className="v4-num">{usdShort(m.volumeUsdH)}</span>
            <span className="v4-hide-s v4-dim2">{recipe ?? '—'}</span>
            <span className="v4-num"><PerMillion b={b} /></span>
            <span className="v4-tr__go"><span className="v4-hide-s">Start</span><Arrow /></span>
          </a>
        )) : [0, 1, 2, 3, 4].map((i) => <div key={i} className="v4-tr is-skel"><span /><span /><span /><span /><span /></div>)}
        {error && !table.length && <p className="v4-dim" style={{ padding: 16 }}>The live markets could not be read just now.</p>}
      </div>
      <p className="v4-note">Estimated over {DESK_WINDOW_TEXT} at a new wallet's fee, all fees included; green with a + is earned. <a href="/bots/explore" className="v4-link">Every market<Arrow /></a></p>
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

export function BotsPage() {
  const live = useLiveDesk();
  const start = startFromText(live.startFrom);
  return (
    <SitePage title={`Trading bots on SoDEX · start with ${start} · ValueDesk`} current="bots" footer={<SiteFooter title={<>Your first bot,<br /><span>with {start}.</span></>} />}>
      <PageHero
        crumb="Bots" kicker="Market maker and grid bots on SoDEX"
        title={<>Bots that trade<br /><span>while you sleep.</span></>}
        sub={<>A market maker or a grid on any of {live.marketCount ?? 'the'} SoDEX markets a bot can run on, perps and spot. It runs on our executor in Tokyo around the clock, from your own SoDEX account, and stops at your limits.</>}
        cta={<><a href="/bots/new" className="h-btn is-light">Start a bot with {start}<Arrow /></a><a href="/bots/explore" className="h-btn is-glass">See every market</a></>}
        stage={<Embed scope="v3"><BotPanel rows={live.rows} loading={live.loading} error={live.error} /></Embed>}
      />
      <Facts items={[
        { v: <Count to={live.marketCount} fmt={(x) => String(Math.round(x))} />, l: 'SoDEX markets a bot can run on' },
        { v: <Count to={live.volumeH} fmt={usdShort} />, l: 'traded on them in the last hour' },
        { v: start, l: 'enough to start a market maker' },
        { v: <span className="vip-text">{bp(FEES.botLowest)}</span>, l: <>lowest bot fee · <span className="vip-pill">VIP</span> {VIP_RULE}</> },
      ]} />

      <section className="vd-sec">
        <Head k="Two kinds" title={<>Pick a bot.<br /><span>Pick a market.</span></>} />
        <div className="vd-rows">
          <Row k="Market maker" title="Quotes on both sides of the book." vis={<BookViz />}>
            <p>The bot rests a bid and an ask around the price and earns the spread when both fill, within the size and the holding you allow.</p>
            <Ticks items={['Steady, Balanced or Active presets', 'The maximum holding and the loss limit are yours', 'Live cost per $1M on every market before you start']} />
          </Row>
          <Row k="Grid" title="Buys low, sells high, step by step." vis={<GridViz />} flip>
            <p>Orders at set steps across a price range: as the price moves through them, each step buys or sells, and the bot keeps the range.</p>
            <Ticks items={['Your range and your number of steps', 'Perps and spot markets']} />
          </Row>
          <Row k="Always on" title="Close the laptop. It keeps going." vis={<Embed scope="v3"><SleepViz /></Embed>}>
            <p>Bots run on ValueDesk's executor in Tokyo, not in your browser. Stop one with a click, or let it stop at your limits.</p>
          </Row>
          <Row k="Your market" title="Every market, with its numbers." vis={<Embed scope="v3"><PickerViz rows={live.rows} /></Embed>} flip>
            <p>Each market shows its volume and what a market maker costs or earned there per $1M, read live from SoDEX.</p>
          </Row>
        </div>
      </section>

      <section className="vd-sec">
        <Head k="Live from SoDEX" title={<>Where the volume is.<br /><span>Start there.</span></>} />
        <MarketTable rows={live.rows} error={live.error} />
      </section>

      <section className="vd-sec">
        <Head k="Calculators" title={<>Fees and SoPoints,<br /><span>before you start.</span></>} center />
        <Embed scope="v4"><Calcs makerBps={live.makerBps} /></Embed>
      </section>

      <div className="vd-layer"><Embed scope="v3"><V3SignTiles /></Embed></div>
      <Embed scope="v2"><Faq items={qaFor('bots')} title="About bots." /></Embed>
    </SitePage>
  );
}

/* ------------------------------------------------------------------------------------------------ copy ----- */

export function CopyPage() {
  const copyNames = venueList(COPY_VENUES);
  return (
    <SitePage title="Copy trading on SoDEX · follow Hyperliquid and SoDEX wallets · ValueDesk" current="copy" footer={<SiteFooter title={<>Follow a trader<br /><span>you trust.</span></>} />}>
      <PageHero
        crumb="Copy trading" kicker={`Follow ${copyNames} wallets`}
        title={<>Follow any wallet.<br /><span>Trade for trade.</span></>}
        sub="Pick a trader on Hyperliquid or SoDEX. Every trade they open, change or close is copied to your SoDEX account at your size and under your leverage cap."
        cta={<><a href="/copy" className="h-btn is-light">Copy a trader<Arrow /></a><a href="/leaderboard" className="h-btn is-glass">See the leaderboard</a></>}
        stage={<Embed scope="v3"><CopyPanel /></Embed>}
      />
      <Facts items={[
        { v: COPY_VENUES.length, l: `venues to copy from: ${copyNames}` },
        { v: bp(FEES.copyNew), l: 'per copied order, new wallet' },
        { v: bp(FEES.copyLowest), l: FEES.copyLowestCondition },
        { v: '24/7', l: 'hosted copies, on our executor' },
      ]} />

      <section className="vd-sec">
        <Head k="How it copies" title={<>Their trades.<br /><span>Your rules.</span></>} />
        <div className="vd-rows">
          <Row k="Pick a leader" title="Start from the best copy scores." vis={<div style={{ width: '88%' }}><p className="h-card__sub" style={{ marginBottom: 10 }}>Top copy scores, last 30 days <span className="h-live">Live</span></p><TopTraders on /></div>}>
            <p>The leaderboards rank traders on every venue ValueDesk reads. Pick one from Hyperliquid or SoDEX, or paste any address.</p>
          </Row>
          <Row k="Your size" title="Same trade, at your size." vis={<FollowViz />} flip>
            <p>Your copy scales the leader's trades to your size and never goes above your leverage cap.</p>
            <Ticks items={['Size and leverage cap you set', 'Copy only new positions, or join open ones', 'Stop with one click']} />
          </Row>
          <Row k="Browser or hosted" title="In your tab, or around the clock." vis={<Embed scope="v3"><SleepViz /></Embed>}>
            <p>A browser copy runs while its tab is open. A hosted copy runs on ValueDesk's executor in Tokyo, also with the laptop closed.</p>
          </Row>
        </div>
      </section>

      <section className="vd-sec">
        <Head k="Fees" title={<>{bp(FEES.copyNew)} per copied order,<br /><span>less as you copy more.</span></>} lead={`Volume counts over ${FEES.windowDays} days. SoDEX charges its own trading fee on top.`} />
        <Embed scope="v2">
          <div className="v2-price" style={{ maxWidth: 560 }}>
            <span className="v2-price__k">Copy trading</span>
            <div className="v2-price__big"><small>from</small> {bp(FEES.copyLowest)}</div>
            <ul className="v2-ladder">{FEES.copyLadder.map((s) => <li key={s.fromUsd}><span>{s.fromUsd === 0 ? 'New wallet' : `From ${usdStep(s.fromUsd)}`}</span><b>{bp(s.fee)}</b></li>)}</ul>
            <a href="/copy" className="v2-btn is-light is-block">Copy a trader</a>
          </div>
        </Embed>
      </section>

      <Embed scope="v2"><Money /></Embed>
      <Embed scope="v2"><Faq items={qaFor('copy')} title="About copy trading." /></Embed>
    </SitePage>
  );
}

/* ------------------------------------------------------------------------------------------- analytics ----- */

export function AnalyticsPage() {
  return (
    <SitePage title="Crypto liquidation map, order flow and macro calendar · free · ValueDesk" current="analytics" footer={<SiteFooter title={<>Read the market.<br /><span>Free.</span></>} />}>
      <PageHero
        crumb="Analytics" kicker="Free, no wallet needed"
        title={<>See where the<br /><span>liquidations sit.</span></>}
        sub={`The liquidation map across ${venueList(GRID_VENUES)}, who traded each candle, the leaderboards, a wallet scan, news, the macro calendar and ETF flows. All in the terminal, all free.`}
        cta={<><a href="/trade" className="h-btn is-light">Open the terminal<Arrow /></a><a href="/leaderboard" className="h-btn is-glass">Leaderboard</a></>}
        stage={<HeatViz />}
        stageHeat={null}
      />
      <Facts items={[
        { v: 'Free', l: 'every analytics view' },
        { v: GRID_VENUES.length, l: 'venues in the liquidation map' },
        { v: 'Live', l: 'and history, on the same map' },
        { v: 'None', l: 'wallet or sign-up needed' },
      ]} />

      <section className="vd-sec">
        <Head k="What you can read" title={<>Everything around<br /><span>the price.</span></>} />
        <div className="vd-rows">
          <Row k="Liquidation map" title="Where positions get liquidated." vis={<HeatViz />} visClass="is-heat">
            <p>Every open position's liquidation price, summed into a heat map over the chart, live and as history.</p>
            <Ticks items={[`${venueList(GRID_VENUES)}, together or each alone`, 'Filter by side, leverage or wallet', 'Click a level to see the wallets behind it']} />
          </Row>
          <Row k="Order flow" title="Who traded each candle." vis={<CandleViz />} flip>
            <p>A sidebar beside the chart breaks each candle's volume down by the wallets that traded it.</p>
          </Row>
          <Row k="Traders" title="Leaderboards and wallet scan." vis={<div style={{ width: '88%' }}><TopTraders on /></div>}>
            <p>Rank traders across every venue by result, then open any wallet for its trades, positions and history.</p>
          </Row>
          <Row k="Macro" title="News, calendar, ETF flows." vis={<CalendarViz />} flip>
            <p>The release calendar with the figures as they come out, FOMC odds and the press conference live, Bitcoin ETF flows and the headlines that move coins.</p>
          </Row>
        </div>
      </section>

      <section className="vd-sec">
        <Head k="Venues" title={<>Five venues.<br /><span>One map.</span></>} lead={<>The analytics read {venueList(GRID_VENUES)}. <a href={PAGE_PATHS.cross}>Cross-venue</a> shows what each adds.</>} />
        <div className="vd-venues">{GRID_VENUES.map((v) => <span key={v}><VenueLogo venue={v} size={18} />{VENUE_LABEL[v]}</span>)}</div>
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

export function CrossVenuePage() {
  return (
    <SitePage title="Cross-venue: traders, liquidations and funding across five venues · ValueDesk" current="cross" footer={<SiteFooter title={<>Every venue,<br /><span>one desk.</span></>} />}>
      <PageHero
        crumb="Cross-venue" kicker={venueList(GRID_VENUES)}
        title={<>Five venues.<br /><span>One view.</span></>}
        sub="Traders, liquidations and positioning from five perp venues side by side; copy a Hyperliquid trader onto SoDEX; compare funding between SoDEX and Hyperliquid."
        cta={<><a href="/explore" className="h-btn is-light">Open Explore<Arrow /></a><a href="/leaderboard" className="h-btn is-glass">Leaderboard</a></>}
        stage={<Embed scope="v3"><HubViz /></Embed>}
        stageHeat="wide"
      />
      <Facts items={[
        { v: GRID_VENUES.length, l: 'venues read' },
        { v: COPY_VENUES.length, l: 'venues to copy from' },
        { v: 2, l: 'venues in the funding scanner' },
        { v: 'Free', l: 'to read, no wallet needed' },
      ]} />

      <section className="vd-sec">
        <Head k="What each venue adds" title={<>Read everywhere.<br /><span>Trade on SoDEX.</span></>} />
        <Reveal className="vd-tablebox">
          <table className="vd-matrix">
            <thead><tr><th />{GRID_VENUES.map((v) => <th key={v}><span><VenueLogo venue={v} size={16} />{VENUE_LABEL[v]}</span></th>)}</tr></thead>
            <tbody>
              {MATRIX.map((r) => (
                <tr key={r.t}><td>{r.t}</td>{GRID_VENUES.map((v) => <td key={v} className={r.on.includes(v) ? 'y' : 'n'} aria-label={r.on.includes(v) ? 'yes' : r.off ?? 'no'}>{r.on.includes(v) ? '●' : r.off ? <small>{r.off}</small> : '–'}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </Reveal>
      </section>

      <section className="vd-sec">
        <div className="vd-rows">
          <Row k="Traders" title="Every venue's traders, one leaderboard." vis={<div style={{ width: '88%' }}><TopTraders on /></div>}>
            <p>Traders from all five venues in one list, or filtered to one venue: a strong Hyperliquid trader and a strong SoDEX trader side by side.</p>
          </Row>
          <Row k="Copy across" title="Hyperliquid trader, SoDEX trades." vis={<Embed scope="v3"><div className="v3-viz v3-follow" style={{ width: '100%' }}><div className="v3-follow__card is-lead"><VenueLogo venue="hyperliquid" size={18} /><b>Leader</b><span className="v3-chip is-sm">Hyperliquid</span></div><div className="v3-follow__wire"><i /></div><div className="v3-follow__card is-mine"><VenueLogo venue="sodex" size={18} /><b>You</b><span className="v3-chip is-sm is-g">SoDEX, your size</span></div></div></Embed>} flip>
            <p>Follow a wallet on Hyperliquid; your copy trades the same market on SoDEX from your own account.</p>
          </Row>
          <Row k="Funding" title="The funding gap between two venues." vis={<ArbViz />}>
            <p>The funding scanner lines up each coin on SoDEX and Hyperliquid, scales both rates to 8 hours and shows the live spread, annualised. It is the live rate, not a settled total.</p>
          </Row>
          <Row k="Liquidations" title="All venues' liquidations on one map." vis={<HeatViz />} visClass="is-heat" flip>
            <p>Positions from every venue summed by liquidation price, or one venue alone.</p>
          </Row>
        </div>
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
    <SitePage title={`Fees · bots from ${bp(FEES.botLowest)} (VIP) · ValueDesk`} current="fees">
      <header className="vd-sec" style={{ paddingTop: 56 }}>
        <p className="vd-crumb h-up"><a href="/home">ValueDesk</a><span>/</span><span>Fees</span></p>
        <div className="h-head is-center h-up">
          <Eyebrow>Fees</Eyebrow>
          <h1 className="h-h1">Pay on what runs.<br /><span>Nothing else.</span></h1>
          <p className="h-lead">No subscription, no deposit. A fee in basis points on the orders a bot or a copy places, lower as your {FEES.windowDays}-day volume grows. 1 bp = 0.01% of the order's value.</p>
        </div>
      </header>
      <section className="vd-sec" style={{ paddingTop: 20 }}>
        <div className="h-fees">
          <Reveal className="h-fee">
            <p className="h-fee__k">Analytics</p>
            <b className="h-fee__v">Free</b>
            <ul><li>Liquidation map, live and history</li><li>Who traded each candle</li><li>Leaderboards and wallet scan</li><li>News, calendar, ETF flows</li></ul>
            <a href={PAGE_PATHS.analytics} className="h-btn is-glass is-block">About the analytics</a>
          </Reveal>
          <Reveal className="h-fee is-hot" delay={90}>
            <p className="h-fee__k">Bots</p>
            <b className="h-fee__v"><small>from </small>{bp(FEES.botLowest)}<small> per order</small></b>
            <p className="h-fee__c"><span className="h-vip">VIP</span> {FEES.vipCondition}</p>
            <ul>
              {FEES.botLadder.map((s) => <li key={s.fromUsd}>{bp(s.fee)} {s.fromUsd === 0 ? 'for a new wallet' : `from ${usdStep(s.fromUsd)} in ${FEES.windowDays} days`}</li>)}
              <li>Start with {start}</li>
            </ul>
            <a href="/bots/new" className="h-btn is-dark is-block">Start a bot<Arrow /></a>
          </Reveal>
          <Reveal className="h-fee" delay={180}>
            <p className="h-fee__k">Copy trading</p>
            <b className="h-fee__v"><small>from </small>{bp(FEES.copyLowest)}<small> per order</small></b>
            <p className="h-fee__c">{FEES.copyLowestCondition}</p>
            <ul>{FEES.copyLadder.map((s) => <li key={s.fromUsd}>{bp(s.fee)} {s.fromUsd === 0 ? 'for a new wallet' : `from ${usdStep(s.fromUsd)} copied`}</li>)}</ul>
            <a href="/copy" className="h-btn is-glass is-block">Copy a trader</a>
          </Reveal>
        </div>
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
