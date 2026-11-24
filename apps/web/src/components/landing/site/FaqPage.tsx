/**
 * The FAQ as a page of its own (owner 2026-11-24): six sections of short answers and a search that runs in the page
 * (faqSearch.ts). Facts only, as site/faq.tsx: fees from the ladders, gates and limits as the engine has them
 * (copy-engine algo/bots.ts WIND_DOWN_MS, LOSS_MARGIN_MAX), the key as SoDEX allows.
 */
import { useDeferredValue, useEffect, useMemo, useState } from 'react';
import { Arrow } from '../Home';
import { bp, FEES, START_FLOOR_USD } from '../shared';
import { faqIndex, faqSearch, type FaqDoc } from './faqSearch';
import { SitePage } from './Site';

const VIP = FEES.vipCondition.replace(/^VIP:\s*/, '');
interface Section { id: string; t: string; qa: Array<Omit<FaqDoc, 'id'>> }

const SECTIONS: Section[] = [
  { id: 'start', t: 'Getting started', qa: [
    { q: 'What is ValueDesk?', a: 'Bots, copy trading and market analytics for SoDEX. You trade from your own SoDEX account; ValueDesk is the desk on top of it.', k: 'about' },
    { q: 'What do I need to start?', a: 'A wallet you use on SoDEX. The analytics need nothing at all.', k: 'account register wallet' },
    { q: 'How long does setup take?', a: 'Connect your wallet and sign three times: the terms, the fee and the trading key. One click asks for each in turn. The signatures are free; none is a transaction.', k: 'sign signature gas' },
    { q: 'What is the minimum?', a: `$${START_FLOOR_USD} is enough to start a market maker on the busiest markets. SoDEX's own minimum order on each market applies; keep room for fees and your loss limit.`, k: 'small amount capital' },
    { q: 'Where is it available?', a: 'Not in the United States, the United Kingdom, Canada or sanctioned countries. The terms list every place it is not offered.', k: 'country usa region' },
  ] },
  { id: 'funds', t: 'Your funds', qa: [
    { q: 'Do I deposit money with ValueDesk?', a: 'No. Your funds stay in your own SoDEX account. ValueDesk never holds your money.', k: 'custody safe' },
    { q: 'Can a bot send my money anywhere?', a: 'No. The trading key places orders and, as SoDEX allows, moves funds only between your own SoDEX accounts and your wallet, never to anyone else.', k: 'steal withdraw security hack' },
    { q: 'How do I take the key back?', a: 'Revoke it on SoDEX at any time. It also ends on its own after the days you choose, at most 180.', k: 'remove permission approval' },
    { q: 'Where is the key kept?', a: "For bots and hosted copies, encrypted on ValueDesk's executor in Tokyo. For browser copies, encrypted in your browser.", k: 'storage server' },
    { q: 'Can I lose money?', a: 'Yes. Trading perpetual futures carries a high risk of loss, with leverage more than you set aside. Bots and copies can lose money; past results say nothing about future ones.', k: 'risk loss' },
  ] },
  { id: 'bots', t: 'Bots', qa: [
    { q: 'Which bots are there?', a: 'A market maker that quotes both sides, a grid that buys low and sells high inside a range, and an OI hedge that holds a long and a short of the same size.', k: 'types kinds' },
    { q: 'Do bots trade spot as well?', a: 'Yes. The market maker and the grid run on SoDEX spot markets too: no leverage and no short, they sell only what they bought.', k: 'coin perps futures' },
    { q: 'Do they keep running when I close the tab?', a: "Yes. They run on ValueDesk's executor in Tokyo around the clock.", k: 'laptop offline night' },
    { q: 'What do the gates do?', a: 'The volatility gate pauses the side that adds while the price moves fast. The news gate, trading hours, flow gate and spread limit take the bot off the book. Before a planned pause it only reduces what it holds, for up to five minutes.', k: 'pause cpi news hours spread volatility' },
    { q: 'How does the loss limit work?', a: 'The bot stops a little before your limit, by what closing its position is likely to cost, at most 5% of the limit. Then it closes: first as a resting order, at the market if needed. In a very fast market the result can still end past the limit.', k: 'stop loss margin' },
    { q: 'Can I stop any time?', a: 'Yes, with one click. You choose whether it closes its position or leaves it open.', k: 'end cancel close' },
    { q: 'Who can use the OI hedge?', a: 'It is in early access: a wallet of the hedge must be on the early access list. It takes on both legs, so every open and close pays the taker fee twice, and a move faster than it can trim may still liquidate a leg.', k: 'hedge early' },
  ] },
  { id: 'copy', t: 'Copy trading', qa: [
    { q: 'Which traders can I copy?', a: 'Any wallet on Hyperliquid or SoDEX. Your copy trades on SoDEX, from your account.', k: 'leader follow' },
    { q: 'How much does a copy trade?', a: 'What you set: your size, your leverage cap and your limits. It can copy only new positions or join open ones.', k: 'size allocation' },
    { q: 'What is counter trading?', a: 'The opposite of every trade a wallet makes. Pick one that keeps losing and take the other side.', k: 'inverse against' },
    { q: 'Browser or hosted, what is the difference?', a: 'Browser copies run while their tab is open. Hosted copies run on our executor around the clock.', k: 'laptop closed' },
    { q: 'How fast is a copy?', a: 'Hosted copies are signed and sent by the executor in Tokyo the moment it sees the trade; order latency is measured in milliseconds. When it fills depends on SoDEX and the market, so your price can differ from the leader\'s.', k: 'latency speed slippage' },
    { q: 'Can I stop a copy any time?', a: 'Yes, with one click.', k: 'end close' },
  ] },
  { id: 'fees', t: 'Fees and SoPoints', qa: [
    { q: 'What do bots cost?', a: `${bp(FEES.botNew)} of each order, and ${bp(FEES.botLowest)} for VIP (${VIP}). SoDEX charges its own trading fee on top.`, k: 'price fee' },
    { q: 'What does copy trading cost?', a: `From ${bp(FEES.copyLowest)} of each copied order (${FEES.copyLowestCondition}). The rate for your wallet is shown before you approve it. SoDEX charges its own trading fee on top.`, k: 'price fee' },
    { q: 'How do I become VIP?', a: `By volume: ${VIP}. It applies by itself.`, k: 'discount lowest' },
    { q: 'Are the analytics free?', a: 'Yes, all of them, without a wallet.', k: 'cost price' },
    { q: 'What is a basis point?', a: '1 bp is 0.01% of an order: 10 cents on $1,000.', k: 'bp percent' },
    { q: 'Do bot trades earn SoPoints?', a: "Bot orders are orders of your own SoDEX account, so they count like any other trade. SoPoints are SoDEX's programme and SoDEX decides them; our estimate is a model, not a promise.", k: 'points airdrop' },
  ] },
  { id: 'data', t: 'Analytics', qa: [
    { q: 'Do I need a wallet for the analytics?', a: 'No. The liquidation map, the leaderboards, the wallet scan, the news and the calendar are open to everyone.', k: 'login free' },
    { q: 'Which venues does it read?', a: 'SoDEX, Hyperliquid, trade.xyz, Lighter and Arcus for traders and liquidations. Funding is compared between SoDEX and Hyperliquid.', k: 'exchange' },
    { q: 'What is the liquidation map?', a: 'Where open positions would be liquidated. Live shows the levels now by price; Historical shows them over time behind the candles.', k: 'heatmap liq' },
    { q: 'Can I see who traded a candle?', a: 'Yes. A sidebar beside the chart breaks a candle\'s volume down by the wallets behind it.', k: 'order flow wallet' },
    { q: 'Can I look up a wallet?', a: 'Yes. Paste any address into the wallet scan to see its trades, positions and history.', k: 'scan profile address' },
  ] },
];

const DOCS: FaqDoc[] = SECTIONS.flatMap((s) => s.qa.map((x, i) => ({ ...x, id: `${s.id}-${i}` })));
const BY = new Map(DOCS.map((d) => [d.id, d]));
const TRY = ['fees', 'is my money safe', 'minimum', 'loss limit', 'close the tab'];

export function FaqPage() {
  const [q, setQ] = useState('');
  const dq = useDeferredValue(q.trim());
  const ix = useMemo(() => faqIndex(DOCS), []);
  const hits = useMemo(() => (dq ? faqSearch(ix, dq) : null), [ix, dq]);
  // A link to one answer opens it.
  useEffect(() => {
    const el = document.getElementById(window.location.hash.slice(1));
    if (el instanceof HTMLDetailsElement) { el.open = true; el.scrollIntoView({ block: 'center' }); }
  }, []);
  const item = (d: FaqDoc, open: boolean) => <details key={`${d.id}${dq}`} id={d.id} open={open || undefined}><summary>{d.q}</summary><p>{d.a}</p></details>;
  return (
    <SitePage title="Questions and answers · ValueDesk" current="faq">
      <div className="vd-fq">
        <header className="vd-fq__hero">
          <h1 className="h-h1 h-up">Questions,<br /><span>answered.</span></h1>
          <div className="vd-fq__s" role="search">
            <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.4-4.4" /></svg>
            <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask anything" aria-label="Search the questions" autoComplete="off" spellCheck={false} />
            {q && <button type="button" className="vd-fq__x" aria-label="Clear the search" onClick={() => setQ('')}>×</button>}
          </div>
          {!q && <div className="vd-fq__chips">{TRY.map((t) => <button key={t} type="button" onClick={() => setQ(t)}>{t}</button>)}</div>}
        </header>
        {hits ? (
          <section aria-live="polite">
            {hits.length ? hits.map((id, i) => item(BY.get(id)!, i === 0)) : <p className="vd-fq__none">Nothing found for “{dq}”. The <a href="/copy-terms">copy and bot terms</a> and the <a href="/risk">risk disclosure</a> hold every detail.</p>}
          </section>
        ) : (
          <div className="vd-fq__body">
            <nav className="vd-fq__nav" aria-label="Sections">{SECTIONS.map((s) => <a key={s.id} href={`#${s.id}`}>{s.t}</a>)}</nav>
            <div>{SECTIONS.map((s) => <section key={s.id} id={s.id}><h2>{s.t}</h2>{s.qa.map((_, i) => item(BY.get(`${s.id}-${i}`)!, false))}</section>)}</div>
          </div>
        )}
        <p className="vd-fq__none">Ready to look around? <a href="/trade" className="h-link">Launch app<Arrow /></a></p>
      </div>
    </SitePage>
  );
}
