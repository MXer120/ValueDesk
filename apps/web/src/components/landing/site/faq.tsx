/**
 * The site's questions, one list (owner liked V2's FAQ; the pages pick the ones about them). Every answer is a fact of
 * the app or its terms (shared.tsx header): fees from the ladders, the key's limits, where it is offered.
 */
import type { ReactNode } from 'react';
import { bp, FEES, START_FLOOR_USD } from '../shared';

const VIP_RULE = FEES.vipCondition.replace(/^VIP:\s*/, '');
export type Qa = { q: string; a: ReactNode; tags: Array<'bots' | 'copy' | 'analytics' | 'cross' | 'pricing' | 'home'> };

export const QA: Qa[] = [
  { tags: ['home', 'bots', 'copy', 'pricing'], q: 'Do I deposit money with ValueDesk?', a: 'No. Your funds stay in your own SoDEX account. Bots and copies trade from it with a trading key you create, and ValueDesk never holds your money.' },
  { tags: ['home', 'bots', 'copy'], q: 'Can a bot send my money anywhere?', a: 'No. The trading key places orders and, as SoDEX allows, moves funds only between your own SoDEX accounts and your wallet, never to anyone else. Revoke it on SoDEX at any time; it also ends on its own after the days you choose, at most 180.' },
  { tags: ['home', 'pricing', 'bots', 'copy'], q: 'What does it cost?', a: <>Bots: {bp(FEES.botNew)} per order, and {bp(FEES.botLowest)} for VIP ({VIP_RULE}). Copy trading: from {bp(FEES.copyLowest)} ({FEES.copyLowestCondition}); your wallet's rate is shown before you approve it. The analytics are free. SoDEX charges its own trading fee on top.</> },
  { tags: ['home', 'bots'], q: 'What is the minimum?', a: `$${START_FLOOR_USD} is enough to start a market maker on the busiest markets. SoDEX's own minimum order on each market applies; keep room for fees and your loss limit.` },
  { tags: ['home', 'bots', 'copy'], q: 'How long does setup take?', a: 'Connect a wallet you use on SoDEX and sign three times: the terms, the fee and the trading key. One click asks for each in turn. The signatures are free; none is a transaction.' },
  { tags: ['bots'], q: 'Do bots trade spot as well?', a: 'Yes. The market maker and the grid run on SoDEX spot markets too: no leverage and no short, they sell only what they bought. The hedge can hold a perps short against spot you own.' },
  { tags: ['bots'], q: 'Who can use the OI hedge?', a: 'It is in early access: a wallet of the hedge must be on the early access list. It takes on both legs, so every open and close pays the taker fee twice, and a move faster than it can trim may still liquidate a leg.' },
  { tags: ['bots', 'copy'], q: 'Does it keep running when I close the tab?', a: "Bots and hosted copies do: they run on ValueDesk's executor in Tokyo around the clock. Browser copies run while their tab is open." },
  { tags: ['home', 'bots', 'copy'], q: 'Can I stop any time?', a: 'Yes. Stop a bot or a copy with one click, and revoke the trading key and the fee approval on SoDEX whenever you like.' },
  { tags: ['home', 'bots', 'pricing'], q: 'Do bot trades earn SoPoints?', a: "Bot orders are orders of your own SoDEX account, so they count toward your SoPoints like any other trade. SoPoints are SoDEX's programme and SoDEX decides them; the estimate on this site is ValueDesk's model, not a promise." },
  { tags: ['copy'], q: 'Which traders can I copy?', a: 'Any wallet on Hyperliquid or SoDEX. Your copy trades on SoDEX, from your account, at the size and leverage cap you set.' },
  { tags: ['analytics', 'cross'], q: 'Do I need a wallet for the analytics?', a: 'No. The liquidation map, the leaderboards, the wallet scan, the news and the calendar are free and open without connecting anything.' },
  { tags: ['analytics', 'cross'], q: 'Which venues does it read?', a: 'SoDEX, Hyperliquid, trade.xyz, Lighter and Arcus for the traders and the liquidation map. Funding is compared between SoDEX and Hyperliquid.' },
  { tags: ['home', 'bots', 'copy', 'pricing'], q: 'Where is it available?', a: 'Not in the United States, the United Kingdom, Canada or sanctioned countries. The terms list every place it is not offered.' },
];

export const qaFor = (tag: Qa['tags'][number]): Array<{ q: string; a: ReactNode }> => QA.filter((x) => x.tags.includes(tag));
